"""
features/levels_columnar.py — T50 B.3a scaffold — max_pain columnar.

Polars vectorisation of the §C10 max-pain feature triple. Currently the
single largest tottime hot function in TFA replay (34.8s of 200s on
2026-05-22 v8 profile). Design + algorithm walk-through at
``docs/T50_B3A_MAX_PAIN_DESIGN.md``.

Scaffold scope (this session):

    - One public function, ``compute_max_pain_features_batch``, that
      accepts the ``chain_snapshots`` DataFrame from
      ``ColumnarBatcher.EventChunk`` and returns one row per snapshot
      with the three §C10 features.
    - Verified equivalent to the scalar implementation on the smoke
      test in ``tests/test_max_pain_columnar.py``.

Out of scope (next session — see design doc § "Next-session checklist"):

    - Full edge-case test sweep (NaN policies, tie-break, malformed rows).
    - Adapter wiring + ``TFA_LEGACY_MAX_PAIN`` env-var fallback.
    - Real-data byte-equality harness vs scalar across 5 reference dates.
    - End-to-end speedup measurement on a full date.

The scalar baseline lives at ``levels.compute_max_pain_features`` and
is untouched; this module ships beside it until B.4 wires the
columnar path into the adapter.
"""

from __future__ import annotations

import polars as pl

# Matches scalar's _GRAVITY_BAND_PCT — must stay in sync.
_GRAVITY_BAND_PCT = 0.02


def compute_max_pain_features_batch(
    chain_snapshots: pl.DataFrame,
    *,
    snapshot_id_col: str = "snapshot_id",
    rows_col: str = "rows",
    spot_col: str = "spot_price",
) -> pl.DataFrame:
    """Compute §C10 max-pain features for every snapshot in the input DF.

    Args:
        chain_snapshots: One row per snapshot. Must contain a column
            ``rows`` of type ``List[Struct[strike, callOI, putOI, ...]]``
            (as produced by ColumnarBatcher), a column ``spot_price``,
            and a column ``snapshot_id`` (added by caller via
            ``with_row_index`` if missing).
        snapshot_id_col / rows_col / spot_col: column-name overrides for
            non-standard input layouts.

    Returns:
        DataFrame with one row per input snapshot and 4 columns:
            snapshot_id, max_pain_strike, distance_to_max_pain_pct,
            max_pain_gravity_strength.

        NaN where scalar would also return NaN — see the design doc's
        edge-case table for the full mapping.

    Note:
        This is the B.3a SCAFFOLD. Edge cases (empty chain, all-null OI,
        tie on argmin, non-finite values) are exercised in the equivalence
        sweep planned for the B.3a execution session. The happy-path test
        in ``tests/test_max_pain_columnar.py`` verifies bit-for-bit
        equivalence with the scalar function on one synthetic snapshot.
    """
    empty_schema = {
        snapshot_id_col: pl.UInt32,
        "max_pain_strike": pl.Float64,
        "distance_to_max_pain_pct": pl.Float64,
        "max_pain_gravity_strength": pl.Float64,
    }
    if len(chain_snapshots) == 0:
        return pl.DataFrame(schema=empty_schema)

    # Ensure snapshot_id column exists. If the caller didn't supply one,
    # add a row index — this is the snapshot identity for joins.
    if snapshot_id_col not in chain_snapshots.columns:
        chain_snapshots = chain_snapshots.with_row_index(snapshot_id_col)

    # Defensive: drop snapshots whose rows list is null or empty. Mirrors
    # scalar's "chain_rows is None or empty -> all NaN" by simply dropping
    # them from the result (downstream consumers treat missing snapshot
    # row the same as all-NaN output). Also dodges a Polars schema-
    # inference failure on List(Null) when the entire batch is empty.
    chain_snapshots = chain_snapshots.filter(
        pl.col(rows_col).is_not_null() & (pl.col(rows_col).list.len() > 0)
    )
    if len(chain_snapshots) == 0:
        return pl.DataFrame(schema=empty_schema)

    # Step 1 — explode rows to long form (one row per (snapshot, strike)).
    long_df = (
        chain_snapshots
        .select([snapshot_id_col, spot_col, rows_col])
        .explode(rows_col)
        .unnest(rows_col)
    )

    # Defensive cast: scalar's float() conversion + max(0, ...) clamp.
    long_df = long_df.with_columns(
        callOI=pl.col("callOI").cast(pl.Float64).fill_null(0.0).clip(lower_bound=0.0),
        putOI=pl.col("putOI").cast(pl.Float64).fill_null(0.0).clip(lower_bound=0.0),
        strike=pl.col("strike").cast(pl.Float64),
    ).filter(
        (pl.col("strike") > 0)
        & pl.col("strike").is_finite()
        & pl.col("callOI").is_finite()
        & pl.col("putOI").is_finite()
    )

    # Snapshot-level total OI for gravity_strength's denominator + the
    # "total_oi == 0" NaN guard.
    total_oi_per_snap = long_df.group_by(snapshot_id_col).agg(
        _total_oi=(pl.col("callOI") + pl.col("putOI")).sum()
    )

    # Deduplicate by (snapshot, strike) so a defensive "two rows at same
    # strike" input matches scalar behaviour (scalar's K==K_s pair
    # contributes zero, so summing OI at duplicates gives the same result
    # as treating them as separate rows). Real recorded chains never
    # contain duplicate strikes; this is purely a robustness measure.
    long_df = long_df.group_by([snapshot_id_col, "strike"]).agg([
        pl.col("callOI").sum(),
        pl.col("putOI").sum(),
    ])

    # Step 2 — O(N) prefix-sum payout per candidate.
    #
    # For candidate K_s among the sorted strikes of one snapshot:
    #   call_payout(K_s) = K_s * A_left(K_s) − B_left(K_s)
    #     where A_left  = Σ callOI[K < K_s]
    #           B_left  = Σ K · callOI[K < K_s]
    #   put_payout(K_s) = B_right(K_s) − K_s * A_right(K_s)
    #     where A_right = Σ putOI[K > K_s]
    #           B_right = Σ K · putOI[K > K_s]
    #
    # All four prefix sums are computed once per snapshot via
    # cum_sum().over(snapshot_id) on the sorted strikes, then each
    # candidate's payout is a single arithmetic expression — O(N log N)
    # per snapshot (sort cost) vs the prior cross-join's O(N²) pair
    # enumeration. On 274 strikes that's ~2.2k ops vs ~75k.
    sorted_long = long_df.sort([snapshot_id_col, "strike"]).with_columns(
        _K_callOI=pl.col("strike") * pl.col("callOI"),
        _K_putOI=pl.col("strike") * pl.col("putOI"),
    )

    sorted_long = sorted_long.with_columns(
        # _A_left at row i = sum of callOI for strikes strictly less than
        # this row's strike. shift(1) makes the cum_sum exclusive.
        _A_left=(
            pl.col("callOI").cum_sum().over(snapshot_id_col).shift(1).fill_null(0.0)
        ),
        _B_left=(
            pl.col("_K_callOI").cum_sum().over(snapshot_id_col).shift(1).fill_null(0.0)
        ),
        # _A_right at row i = sum of putOI for strikes strictly greater
        # than this row's strike = total − cum_sum_inclusive.
        _A_right=(
            pl.col("putOI").sum().over(snapshot_id_col)
            - pl.col("putOI").cum_sum().over(snapshot_id_col)
        ),
        _B_right=(
            pl.col("_K_putOI").sum().over(snapshot_id_col)
            - pl.col("_K_putOI").cum_sum().over(snapshot_id_col)
        ),
    )

    # shift(1) crosses snapshot boundaries; for the FIRST row of each
    # snapshot the .shift(1) would otherwise pull in the last row of the
    # previous snapshot. We need to null those out and refill with 0.
    # The cleanest way: detect snapshot boundary with a row-index per
    # snapshot and zero _A_left / _B_left for index==0 explicitly.
    sorted_long = sorted_long.with_columns(
        _row_idx_in_snap=pl.int_range(pl.len()).over(snapshot_id_col),
    ).with_columns(
        _A_left=pl.when(pl.col("_row_idx_in_snap") == 0).then(0.0).otherwise(pl.col("_A_left")),
        _B_left=pl.when(pl.col("_row_idx_in_snap") == 0).then(0.0).otherwise(pl.col("_B_left")),
    )

    sorted_long = sorted_long.with_columns(
        _total_payout=(
            pl.col("strike") * pl.col("_A_left") - pl.col("_B_left")
            + pl.col("_B_right") - pl.col("strike") * pl.col("_A_right")
        )
    )

    # Argmin per snapshot — tie-break to lowest strike (matches scalar's
    # "first encountered" when input is presented ascending, which is the
    # recorder's invariant).
    max_pain = (
        sorted_long.sort([snapshot_id_col, "_total_payout", "strike"])
                   .group_by(snapshot_id_col, maintain_order=True)
                   .first()
                   .select([
                       pl.col(snapshot_id_col),
                       pl.col("strike").alias("max_pain_strike"),
                   ])
    )

    # Step 5 — distance + gravity. Join spot back in for the arithmetic.
    spots = chain_snapshots.select([
        pl.col(snapshot_id_col),
        pl.col(spot_col).cast(pl.Float64).alias("_spot"),
    ])
    result = max_pain.join(spots, on=snapshot_id_col).join(
        total_oi_per_snap, on=snapshot_id_col,
    )
    result = result.with_columns(
        distance_to_max_pain_pct=(
            pl.when(pl.col("_spot") > 0)
              .then(
                  (pl.col("_spot") - pl.col("max_pain_strike"))
                  / pl.col("_spot") * 100.0
              )
              .otherwise(None)
        ),
    )

    # Gravity = sum of (callOI + putOI) within ±band of max_pain_strike,
    # divided by total_oi. Compute by joining long_df with max_pain on
    # snapshot_id then summing where |strike − max_pain_strike| ≤ band.
    nearby = (
        long_df.join(result.select([snapshot_id_col, "max_pain_strike", "_spot"]), on=snapshot_id_col)
        .with_columns(
            _band_half=(pl.col("_spot") * _GRAVITY_BAND_PCT),
        )
        .filter(
            (pl.col("_spot") > 0)
            & ((pl.col("strike") - pl.col("max_pain_strike")).abs() <= pl.col("_band_half"))
        )
        .group_by(snapshot_id_col)
        .agg(_nearby_oi=(pl.col("callOI") + pl.col("putOI")).sum())
    )

    result = result.join(nearby, on=snapshot_id_col, how="left").with_columns(
        max_pain_gravity_strength=(
            pl.when((pl.col("_spot") > 0) & (pl.col("_total_oi") > 0))
              .then(pl.col("_nearby_oi").fill_null(0.0) / pl.col("_total_oi"))
              .otherwise(None)
        ),
    )

    # Drop intermediates, keep the public 4 cols in stable order.
    return result.select([
        snapshot_id_col,
        "max_pain_strike",
        "distance_to_max_pain_pct",
        "max_pain_gravity_strength",
    ])
