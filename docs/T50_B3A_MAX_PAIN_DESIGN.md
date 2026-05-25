# T50 B.3a — `compute_max_pain_features` → columnar design

## Why this is sub-phase B.3a (the first conversion)

`compute_max_pain_features` is the single largest hot function in TFA replay — **34.8s of 200s total runtime (~17%)** on the 2026-05-22 v8-schema profile (3,306 calls × 11ms each). Cracking it gives the largest single wall-clock win in the whole B-full effort.

Source: [levels.py:143](../python_modules/tick_feature_agent/features/levels.py#L143).

## What the scalar version computes

Per chain snapshot, with N strikes in the chain:

1. Materialise valid `(strike, callOI, putOI)` triples. Drop strikes ≤ 0, non-finite OI, etc.
2. For each candidate settlement strike `K_s ∈ {strikes}`:
   - `call_payout(K_s) = Σ_K callOI(K) · max(K_s − K, 0)`
   - `put_payout(K_s) = Σ_K putOI(K) · max(K − K_s, 0)`
   - `total_payout(K_s) = call_payout + put_payout`
3. `max_pain_strike = argmin_{K_s} total_payout(K_s)`.
4. `distance_to_max_pain_pct = (spot − max_pain_strike) / spot × 100`.
5. `max_pain_gravity_strength = Σ_K (callOI(K) + putOI(K)) · 𝟙[|K − max_pain_strike| ≤ 0.02·spot] / total_oi`.

Outputs: `{max_pain_strike, distance_to_max_pain_pct, max_pain_gravity_strength}`.

NaN policy:
- All three NaN if `chain_rows` is None/empty or `total_oi ≤ 0`.
- `distance_*` and `gravity_*` NaN if `spot` is None / non-positive.

**Complexity per snapshot:** O(N²) ops where N ≈ 50–100 strikes → ~2.5k–10k ops × ~3,300 snapshots × Python overhead = the 34.8s we see.

## Polars columnar approach

Input shape (from `ColumnarBatcher.EventChunk.chain_snapshots`):

```
chain_snapshots: pl.DataFrame   # one row per snapshot
  recv_ts:     str
  spot_price:  f64
  rows:        List[Struct[strike, callOI, putOI, ...]]   # nested per-strike data
```

### Step 1 — explode to long form

```python
long_df = (
    chain_snapshots
    .with_row_index("snapshot_id")          # snapshot identity for joins
    .explode("rows")
    .unnest("rows")
    .select([
        "snapshot_id", "recv_ts", "spot_price",
        "strike", "callOI", "putOI",
    ])
    .filter(                                 # mirrors scalar's defensive checks
        (pl.col("strike") > 0)
        & pl.col("strike").is_finite()
        & (pl.col("callOI").fill_null(0) >= 0)
        & (pl.col("putOI").fill_null(0) >= 0)
        & pl.col("callOI").fill_null(0).is_finite()
        & pl.col("putOI").fill_null(0).is_finite()
    )
)
```

### Step 2 — payout matrix via self-join on `snapshot_id`

```python
ks_df = long_df.select([
    pl.col("snapshot_id"),
    pl.col("strike").alias("k_s"),
])
pairs = ks_df.join(long_df, on="snapshot_id", how="inner")   # cartesian within each snapshot
```

Each row of `pairs` represents the payout contribution of strike `K` toward candidate settlement `K_s` in one snapshot.

### Step 3 — per-pair payout contribution

```python
pairs = pairs.with_columns(
    contrib=(
        pl.when(pl.col("k_s") > pl.col("strike"))
          .then(pl.col("callOI") * (pl.col("k_s") - pl.col("strike")))
          .otherwise(0.0)
        + pl.when(pl.col("strike") > pl.col("k_s"))
          .then(pl.col("putOI") * (pl.col("strike") - pl.col("k_s")))
          .otherwise(0.0)
    )
)
```

### Step 4 — sum contributions, find argmin per snapshot

```python
totals = pairs.group_by(["snapshot_id", "k_s"]).agg(
    total_payout=pl.col("contrib").sum()
)
max_pain = (
    totals.sort(["snapshot_id", "total_payout"])
          .group_by("snapshot_id", maintain_order=True).first()
          .select([
              pl.col("snapshot_id"),
              pl.col("k_s").alias("max_pain_strike"),
          ])
)
```

### Step 5 — distance + gravity

`distance` is straightforward arithmetic once we join the spot back in. `gravity` requires another aggregation over the ±2 % band — handled with a windowed `filter(|strike - max_pain| <= 0.02 * spot).sum()` per snapshot.

## Edge cases we MUST match scalar bit-for-bit

| Scenario | Scalar behaviour | Columnar must do |
|---|---|---|
| `chain_rows` is None / empty | All 3 outputs NaN | snapshot doesn't appear in output OR output row has all-null values |
| `total_oi == 0` | All 3 outputs NaN | After filter+sum, if every contribution is 0 → null max_pain |
| Tie on min payout | scalar picks the FIRST tied strike encountered (insertion order) | `sort` then `first` — must use stable sort; verify with synthetic tie case |
| Single strike in chain | scalar returns that strike (trivially min) | self-join produces 1 row; trivially correct |
| `spot` is None/non-positive | distance + gravity NaN, max_pain_strike still computed | conditional on spot validity |
| Malformed row (callOI is a string, etc.) | scalar skips that row via try/except | columnar filter drops null-coerced values |

## Equivalence test strategy

- **Phase 1 (this session):** 1 synthetic snapshot, hand-computed answer, assert scalar == columnar exactly.
- **Phase 2 (B.3a execution session):** full edge-case sweep covering every row in the table above.
- **Phase 3 (B.5 harness):** replay a real chain snapshot stream (~3,300 snapshots from 2026-05-22), compare scalar vs columnar outputs row-by-row, fail on any diff > 1e-12 abs.

## Performance expectation

Pairs DataFrame size per chunk: ~100 strikes × ~100 strikes × N snapshots in the chunk. At chunk_size=10,000 events, expect ~3 chain snapshots per chunk → ~30k rows per pairs DataFrame. Polars handles 30k-row group-by + sort in microseconds. **Net expectation: 30s scalar → ~0.5s columnar (~60× per-function speedup).** Whole-replay drop: ~14% of 200s = ~28s saved.

## Decisions deferred to execution session

1. **Where to wire the batched compute into the adapter.** Two options:
   - Pre-compute all snapshots' max_pain at adapter setup time, cache in a per-snapshot lookup, scalar feature path reads cached values. Simplest. My pick.
   - True streaming columnar where the adapter consumes EventChunks. Bigger refactor — defer to B.4.
2. **Cache eviction policy** if pre-computing. Probably fine to hold all per-date in memory (3k snapshots × 24 bytes per snapshot = 72 KB negligible).
3. **Backout flag.** `TFA_LEGACY_MAX_PAIN=1` env var falls back to scalar — same pattern as the broader T50 rollback story.

## Next-session checklist

- [ ] Build the `compute_max_pain_features_batch(chain_snapshots: pl.DataFrame) -> pl.DataFrame` per the steps above.
- [ ] Expand equivalence tests to cover all 6 edge cases in the table.
- [ ] Replay 5 reference dates' chain streams; assert byte-equality vs scalar.
- [ ] Wire into adapter behind `TFA_LEGACY_MAX_PAIN` env-var fallback.
- [ ] Measure end-to-end replay speedup on a full date (expect ~14% wall-clock reduction).
- [ ] Commit + push.
