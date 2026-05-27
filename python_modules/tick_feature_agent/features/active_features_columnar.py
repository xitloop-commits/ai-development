"""
features/active_features_columnar.py — T50 B.3c Polars vectorisation.

Polars batched port of ``active_features.compute_side_strengths``.

The scalar version is called per emit row, looks up the chain cache's
``prev_snapshot.rows`` to compute call/put ``vol_diff`` (max(0, curr -
prev)), then normalises the 4 per-strike values
(``call_vol_diff``, ``|callOIChange|``, ``put_vol_diff``, ``|putOIChange|``)
across the strikes in the current snapshot via a min-max scaling.

The batched form runs all snapshots for the date in one Polars chain.
Cross-snapshot state for the per-strike prev-volume lookup is handled
via ``shift(1).over("strike")`` after sorting on ``snapshot_id``;
first-row-per-strike values get a 0 fallback to match scalar's
"no prev_rows -> diff=0" branch.

Caller maps the long-form output back to scalar's
``dict[strike, (csv, csoi, strength, psv, psoi, strength_pe)]`` shape
for cache lookup at runtime.
"""

from __future__ import annotations

import polars as pl


def _normalize_expr(val_col: str, min_col: str, max_col: str) -> pl.Expr:
    """Match scalar ``_normalize``:
    - ``if mx == 0: return [0.0] * len`` (when all values are 0)
    - ``elif mx == mn: return [1.0] * len`` (all equal, non-zero)
    - ``else: (v - mn) / (mx - mn)``
    """
    return (
        pl.when(pl.col(max_col) == 0)
          .then(0.0)
          .when(pl.col(max_col) == pl.col(min_col))
          .then(1.0)
          .otherwise(
              (pl.col(val_col) - pl.col(min_col))
              / (pl.col(max_col) - pl.col(min_col))
          )
    )


def compute_side_strengths_batch(
    chain_snapshots: pl.DataFrame,
    *,
    snapshot_id_col: str = "snapshot_id",
    rows_col: str = "rows",
) -> pl.DataFrame:
    """Compute side-strengths for every (snapshot, strike) in one batch.

    Returns long-form DataFrame with 8 columns:
        snapshot_id, strike, csv, csoi, strength, psv, psoi, strength_pe

    Where:
        csv          = normalize(call_vol_diff) within snapshot
        csoi         = normalize(|callOIChange|) within snapshot
        strength     = (csv + csoi) / 2
        psv, psoi, strength_pe — same on the put side

    Mirrors ``active_features.compute_side_strengths(rows, prev_rows)``
    bit-for-bit modulo float epsilon. ``prev_rows`` is reconstructed
    inside Polars via shift-over-strike on the time-sorted snapshot
    series.
    """
    empty_schema = {
        snapshot_id_col: pl.UInt32,
        "strike": pl.Int64,
        "csv": pl.Float64,
        "csoi": pl.Float64,
        "strength": pl.Float64,
        "psv": pl.Float64,
        "psoi": pl.Float64,
        "strength_pe": pl.Float64,
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
            strike=pl.col("strike").cast(pl.Int64),
            callVolume=pl.col("callVolume").cast(pl.Float64).fill_null(0.0),
            putVolume=pl.col("putVolume").cast(pl.Float64).fill_null(0.0),
            callOIChange=pl.col("callOIChange").cast(pl.Float64).fill_null(0.0),
            putOIChange=pl.col("putOIChange").cast(pl.Float64).fill_null(0.0),
        )
    )

    # Per-strike prev volume via shift(1) within each strike group
    # (snapshot_id ordered ascending so shift = previous snapshot).
    long_df = long_df.sort(["strike", snapshot_id_col]).with_columns(
        _prev_call_vol=pl.col("callVolume").shift(1).over("strike"),
        _prev_put_vol=pl.col("putVolume").shift(1).over("strike"),
    )

    # vol_diff matches scalar's two-branch logic exactly:
    #   - snapshot_id == 0 (the FIRST snapshot in chronological order;
    #     scalar's `prev_rows is None` branch): vol_diff = 0.0 for ALL
    #     strikes in this snapshot.
    #   - snapshot_id > 0: prev_rows exists. For each strike, if that
    #     strike wasn't present in the prev snapshot, scalar reads
    #     ``prev.get("callVolume", 0)`` = 0 and computes
    #     vol_diff = max(0, curr - 0) = curr. We mirror via
    #     ``fill_null(0)`` on the shift-over-strike result.
    long_df = long_df.with_columns(
        call_vol_diff=(
            pl.when(pl.col(snapshot_id_col) == 0)
              .then(0.0)
              .otherwise(
                  (pl.col("callVolume") - pl.col("_prev_call_vol").fill_null(0.0))
                  .clip(lower_bound=0.0)
              )
        ),
        put_vol_diff=(
            pl.when(pl.col(snapshot_id_col) == 0)
              .then(0.0)
              .otherwise(
                  (pl.col("putVolume") - pl.col("_prev_put_vol").fill_null(0.0))
                  .clip(lower_bound=0.0)
              )
        ),
        call_oi_change_abs=pl.col("callOIChange").abs(),
        put_oi_change_abs=pl.col("putOIChange").abs(),
    )

    # Per-snapshot min/max for the normalize step.
    long_df = long_df.with_columns(
        _csv_min=pl.col("call_vol_diff").min().over(snapshot_id_col),
        _csv_max=pl.col("call_vol_diff").max().over(snapshot_id_col),
        _csoi_min=pl.col("call_oi_change_abs").min().over(snapshot_id_col),
        _csoi_max=pl.col("call_oi_change_abs").max().over(snapshot_id_col),
        _psv_min=pl.col("put_vol_diff").min().over(snapshot_id_col),
        _psv_max=pl.col("put_vol_diff").max().over(snapshot_id_col),
        _psoi_min=pl.col("put_oi_change_abs").min().over(snapshot_id_col),
        _psoi_max=pl.col("put_oi_change_abs").max().over(snapshot_id_col),
    )

    long_df = long_df.with_columns(
        csv=_normalize_expr("call_vol_diff", "_csv_min", "_csv_max"),
        csoi=_normalize_expr("call_oi_change_abs", "_csoi_min", "_csoi_max"),
        psv=_normalize_expr("put_vol_diff", "_psv_min", "_psv_max"),
        psoi=_normalize_expr("put_oi_change_abs", "_psoi_min", "_psoi_max"),
    ).with_columns(
        strength=(pl.col("csv") + pl.col("csoi")) / 2.0,
        strength_pe=(pl.col("psv") + pl.col("psoi")) / 2.0,
    )

    return long_df.select([
        snapshot_id_col, "strike",
        "csv", "csoi", "strength",
        "psv", "psoi", "strength_pe",
    ]).sort([snapshot_id_col, "strike"])
