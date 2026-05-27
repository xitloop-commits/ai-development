# T50 B.3b — `targets.compute_targets` + `trend_swing_targets.compute_targets` → columnar design

## Why sub-phase B.3b

The two target-backfill functions consume **~17 % of replay runtime** on v8-schema data:

| Function | tottime (2026-05-22 profile) | Notes |
|---|---|---|
| `features.targets.compute_targets` | **31.0 s** | per-tick × per-strike × per-window lookup of option premium |
| `features.trend_swing_targets.compute_targets` | **2.7 s** | per-tick rolling forward-window max/min on spot |

Both are perfect vectorisation candidates because **they execute at chunk-flush time in replay (deferred backfill), at which point the entire future-tick stream is already on disk**. Scalar processes them per-emit-row inside Python; Polars can compute every emit-row's target columns in one batched expression chain.

## The two functions are different shapes — split into two passes

### Pass 1 — `trend_swing_targets` (simpler; this session's scaffold)

State: a sorted history of `(ts_sec, spot_price)` entries.
For each emit row at `t0`, for each of 4 horizons `w` (trend = 900s, 1800s; swing = 3600s, 7200s — confirmed against `trend_swing_targets.TREND_HORIZONS_SEC` / `SWING_HORIZONS_SEC`):

```
lookahead = entries in (t0, t0+w]
end_spot      = lookahead[-1].spot       # last sample inside the window
max_spot      = max(e.spot for e in lookahead)
min_spot      = min(e.spot for e in lookahead)
magnitude     = end_spot - spot_at_t0
max_excursion = max_spot - spot_at_t0
max_drawdown  = spot_at_t0 - min_spot
direction     = sign(magnitude) bucketed       # noise-floor aware
continues     = direction == dominant_direction_in_lookback
breakout_imminent = max_excursion > noise_floor * scale_factor
```

NaN when `t0+w > session_end_sec` or `lookahead` is empty.

**Polars approach for the batched version:**

Input is a `pl.DataFrame` of all emit rows for the date with at least `[ts_sec, spot]`. For each horizon `w`:

```python
df = df.sort("ts_sec").with_columns(
    # forward-rolling window of w seconds over the OWN spot history.
    # rolling_max / rolling_min with `closed="right"` on a time index
    # naturally gives max/min over (t0, t0+w].
    pl.col("spot").rolling_max(window_size=f"{w}s", by="ts_sec", closed="right")
        .shift(-1).alias(f"_max_spot_{w}"),
    pl.col("spot").rolling_min(window_size=f"{w}s", by="ts_sec", closed="right")
        .shift(-1).alias(f"_min_spot_{w}"),
    # end-of-window spot: last value within the window
    # implemented via a shift-and-pick approach using rolling_apply
    # OR by joining the row at ts >= t0+w-epsilon back in.
)
```

`rolling_*` operations in Polars work on the CURRENT row's window. To get the FUTURE window `(t0, t0+w]`, we shift indices: compute on the reversed series, or use a self-join with time-bucketed binning. Two equivalent strategies; design pick is "self-join on `(ts_sec_other > t0) & (ts_sec_other <= t0+w)`" because it generalises cleanly to ragged horizon sets.

NaN-guard for past-session-end: `pl.when(ts_sec + w > session_end_sec).then(None).otherwise(value)`.

The 4 horizons × 6 stats = 24 output columns per emit row. Polars handles wide outputs efficiently.

### Pass 2 — `targets` (harder; next session)

State: history of `(ts_sec, spot, strike_ltps: dict[strike, (ce_ltp, pe_ltp)])`.
For each emit row at `t0`, for each window `x ∈ {5, 10, 30, 60, 120, 180, 300}`, for each ACTIVE STRIKE at `t0`:

```
lookahead = entries in (t0, t0+x]
fut_ces = [e.strike_ltps[strike].ce for e in lookahead if strike in e.strike_ltps]
max_upside_x   = max over strikes of (max(fut_ces) - ce_at_t0)
max_drawdown_x = max over strikes of (ce_at_t0 - min(fut_ces))
premium_decay  = (ce_now + pe_now) - (ce_T+x + pe_T+x)  # uses last lookahead entry
breakout_in_x  = day high/low broken inside lookahead?
```

This is a 3-D problem (emit-row × strike × time-in-window) and the **active strike set changes per emit row** (typically 5–20 strikes around ATM). Two viable Polars patterns:

1. **Long-form explode then group**: explode each emit row over its active strikes, then self-join against the per-strike LTP history. Group by `(emit_row_id, window_w)`, aggregate max/min. Expensive memory but cleanest.
2. **Per-window separate batches**: for each window `w`, do a single self-join with the time predicate, then group. Smaller intermediate sizes but more passes.

Decision deferred to next session's B.3b-targets design.

## Scaffold scope (this session only)

- **Build:** `features/trend_swing_targets_columnar.py` with `compute_trend_swing_targets_batch(emit_df, history_df) -> pl.DataFrame`.
- **Test:** 1 synthetic equivalence case — small history, a handful of emit rows, hand-checked expected output for one horizon.
- **Out of scope:** `targets.py` columnar (separate scaffold), full edge sweep, adapter wire-in, real-data harness, end-to-end measurement.

## Equivalence test strategy

Mirrors B.3a:

- **Phase 1 (this session):** 1 synthetic test — small linear-trend spot series, 30-sec horizon, hand-computed expected magnitude/excursion/drawdown.
- **Phase 2 (B.3b execution):** edge cases — empty lookahead, session-end boundary, noise-floor / direction bucketing, continues / breakout_imminent flags.
- **Phase 3 (B.3b execution):** real-data harness — replay a full date both ways, byte-compare all 24 trend_swing target columns plus the 14 targets.py columns.

## Performance expectation

For `trend_swing_targets` alone (2.7 s scalar tottime), columnar should hit ~3–5× per-function (smaller relative win than max_pain because the per-call cost is already lower — fewer scalar Python loops). Per-date wall-time saving ~1.5–2 s.

For `targets.py` (31 s tottime) when its columnar scaffold lands next session, expect a much bigger win — the per-strike inner loops are exactly where columnar swallows scalar-Python whole. Realistic estimate: ~8–15× per-function, saving ~25 s per date.

Combined B.3b once both ship: **+12–14 % wall-time saved on top of B.3a's 1.54×**, pushing total post-B.3a+B.3b speedup to ~**1.75–1.85×** per date.

## Next-session checklist (B.3b execution)

- [ ] Productionise `trend_swing_targets_columnar` (full edge cases + real-data harness).
- [ ] Build `targets_columnar` scaffold + design.
- [ ] Productionise `targets_columnar`.
- [ ] Adapter wire-in for both via the same monkey-patch pattern as B.3a.
- [ ] End-to-end measurement on a full date.
- [ ] `TFA_LEGACY_TARGETS=1` env-var rollback.
