"""
features/chain_columnar.py — T50 B.3e — chain.py cluster columnar.

Polars vectorisations of the pure-per-snapshot chain functions from
``features/chain.py``. State-dependent ones (compute_oi_change_deltas
uses a history list, compute_pcr_slope a windowed regression) are NOT
in scope — they need a different design pass.

Functions implemented this scaffold:

    compute_oi_weighted_levels_batch  — Σ(strike·callOI) / Σ(callOI),
                                        Σ(strike·putOI) / Σ(putOI)
    compute_wall_strength_batch       — max(OI) / mean(OI) per side

Both consume an exploded long-form ``(snapshot_id, strike, callOI, putOI)``
DataFrame and return ``one row per snapshot`` with the 2 features each.
Wire-in side maps these results into the per-emit-row cache by
snapshot timestamp, same pattern as max_pain_cache.

Equivalence to scalar:

    compute_oi_weighted_levels — Σ(K · callOI[K]) / Σ(callOI[K]) is a
        straight weighted-average; Polars sum() over filtered rows
        produces the same floats.
    compute_wall_strength      — max() / mean() on a filtered series.
        Filtered set must match scalar's "valid rows" definition
        (strike > 0, finite OI, OI > 0 for wall_strength's `> 0` clamp).
"""

from __future__ import annotations

import polars as pl

_NAN = float("nan")


def compute_oi_weighted_levels_batch(
    chain_snapshots: pl.DataFrame,
    *,
    snapshot_id_col: str = "snapshot_id",
    rows_col: str = "rows",
) -> pl.DataFrame:
    """Per-snapshot OI-weighted resistance + support strikes.

    Returns one row per input snapshot with columns:
        snapshot_id, oi_weighted_ce_resistance_strike, oi_weighted_pe_support_strike

    NaN where the respective side has zero total finite OI (matches
    scalar's "denominator zero -> NaN" guard).
    """
    empty_schema = {
        snapshot_id_col: pl.UInt32,
        "oi_weighted_ce_resistance_strike": pl.Float64,
        "oi_weighted_pe_support_strike": pl.Float64,
    }
    if len(chain_snapshots) == 0:
        return pl.DataFrame(schema=empty_schema)

    if snapshot_id_col not in chain_snapshots.columns:
        chain_snapshots = chain_snapshots.with_row_index(snapshot_id_col)

    chain_snapshots = chain_snapshots.filter(
        pl.col(rows_col).is_not_null() & (pl.col(rows_col).list.len() > 0)
    )
    if len(chain_snapshots) == 0:
        return pl.DataFrame(schema=empty_schema)

    long_df = (
        chain_snapshots
        .select([snapshot_id_col, rows_col])
        .explode(rows_col)
        .unnest(rows_col)
        .with_columns(
            strike=pl.col("strike").cast(pl.Float64),
            callOI=pl.col("callOI").cast(pl.Float64).fill_null(0.0).clip(lower_bound=0.0),
            putOI=pl.col("putOI").cast(pl.Float64).fill_null(0.0).clip(lower_bound=0.0),
        )
        .filter(
            (pl.col("strike") > 0)
            & pl.col("strike").is_finite()
            & pl.col("callOI").is_finite()
            & pl.col("putOI").is_finite()
        )
    )

    agg = long_df.group_by(snapshot_id_col).agg(
        _ce_num=(pl.col("strike") * pl.col("callOI")).sum(),
        _ce_den=pl.col("callOI").sum(),
        _pe_num=(pl.col("strike") * pl.col("putOI")).sum(),
        _pe_den=pl.col("putOI").sum(),
    )

    result = agg.with_columns(
        oi_weighted_ce_resistance_strike=(
            pl.when(pl.col("_ce_den") > 0)
              .then(pl.col("_ce_num") / pl.col("_ce_den"))
              .otherwise(None)
        ),
        oi_weighted_pe_support_strike=(
            pl.when(pl.col("_pe_den") > 0)
              .then(pl.col("_pe_num") / pl.col("_pe_den"))
              .otherwise(None)
        ),
    ).select([
        snapshot_id_col,
        "oi_weighted_ce_resistance_strike",
        "oi_weighted_pe_support_strike",
    ])
    return result


def compute_wall_strength_batch(
    chain_snapshots: pl.DataFrame,
    *,
    snapshot_id_col: str = "snapshot_id",
    rows_col: str = "rows",
) -> pl.DataFrame:
    """Per-snapshot wall-strength ratio = max(OI) / mean(OI) per side.

    Returns one row per snapshot with:
        snapshot_id, ce_wall_strength_rel, pe_wall_strength_rel

    NaN per side when <2 valid strikes (OI > 0) contribute on that side
    or mean is 0 — matches scalar's NaN guard.
    """
    empty_schema = {
        snapshot_id_col: pl.UInt32,
        "ce_wall_strength_rel": pl.Float64,
        "pe_wall_strength_rel": pl.Float64,
    }
    if len(chain_snapshots) == 0:
        return pl.DataFrame(schema=empty_schema)

    if snapshot_id_col not in chain_snapshots.columns:
        chain_snapshots = chain_snapshots.with_row_index(snapshot_id_col)

    chain_snapshots = chain_snapshots.filter(
        pl.col(rows_col).is_not_null() & (pl.col(rows_col).list.len() > 0)
    )
    if len(chain_snapshots) == 0:
        return pl.DataFrame(schema=empty_schema)

    long_df = (
        chain_snapshots
        .select([snapshot_id_col, rows_col])
        .explode(rows_col)
        .unnest(rows_col)
        .with_columns(
            strike=pl.col("strike").cast(pl.Float64),
            callOI=pl.col("callOI").cast(pl.Float64).fill_null(0.0),
            putOI=pl.col("putOI").cast(pl.Float64).fill_null(0.0),
        )
        .filter(
            (pl.col("strike") > 0)
            & pl.col("strike").is_finite()
            & pl.col("callOI").is_finite()
            & pl.col("putOI").is_finite()
        )
    )

    # Per scalar: strikes with OI <= 0 are excluded from BOTH numerator
    # AND denominator on that side. Separate agg for CE vs PE because the
    # exclusion mask differs per side.
    ce_agg = (
        long_df.filter(pl.col("callOI") > 0)
        .group_by(snapshot_id_col)
        .agg(
            _ce_max=pl.col("callOI").max(),
            _ce_mean=pl.col("callOI").mean(),
            _ce_count=pl.col("callOI").count(),
        )
    )
    pe_agg = (
        long_df.filter(pl.col("putOI") > 0)
        .group_by(snapshot_id_col)
        .agg(
            _pe_max=pl.col("putOI").max(),
            _pe_mean=pl.col("putOI").mean(),
            _pe_count=pl.col("putOI").count(),
        )
    )

    # Build the union of snapshot_ids that contributed on either side,
    # then merge. Snapshots with no valid CE side appear with null _ce_*.
    all_ids = (
        long_df.select(snapshot_id_col).unique()
    )
    result = (
        all_ids
        .join(ce_agg, on=snapshot_id_col, how="left")
        .join(pe_agg, on=snapshot_id_col, how="left")
        .with_columns(
            ce_wall_strength_rel=(
                pl.when((pl.col("_ce_count") >= 2) & (pl.col("_ce_mean") > 0))
                  .then(pl.col("_ce_max") / pl.col("_ce_mean"))
                  .otherwise(None)
            ),
            pe_wall_strength_rel=(
                pl.when((pl.col("_pe_count") >= 2) & (pl.col("_pe_mean") > 0))
                  .then(pl.col("_pe_max") / pl.col("_pe_mean"))
                  .otherwise(None)
            ),
        )
        .select([
            snapshot_id_col,
            "ce_wall_strength_rel",
            "pe_wall_strength_rel",
        ])
    )
    return result
