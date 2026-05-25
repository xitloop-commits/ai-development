"""
realized_vol_columnar.py — Polars vectorised port of §8.19 Realized Volatility.

Equivalent to ``realized_vol.compute_realized_vol_features`` but consumes a
full tick history as a Polars DataFrame and emits all three rolling-window
columns in one pass, rather than per-event.

Built for the T48 spike: measure per-date speedup against the scalar
implementation. If ≥3× → green-light T50 Phase B-full (tracker
columnarisation across the other hot feature classes).

Equivalence (proved by ``tests/test_realized_vol_columnar.py``):

    The scalar version, for each tick i with the last w prices in its
    circular buffer, computes (w-1) log-returns between adjacent
    prices and the sample stdev of those returns.

    The columnar version computes a single global log-return series
    (``ltp.log().diff()``) once, then for each tick i takes a rolling
    window of size (w-1) over that series, yielding the same (w-1)
    log-return values. Sample stdev (ddof=1) over the same w-1 values
    is the same number. Float-epsilon differences only.

Bad-price guard (matches scalar bit-for-bit):

    Scalar returns NaN for window w if ANY of the last w ``ltp`` values
    is ≤ 0. The columnar form flags ``ltp <= 0`` per row, rolling-sums
    that flag over a window of w rows, and masks the vol column to None
    wherever the rolling-sum is positive.

Output columns added to the input DataFrame:

    - underlying_realized_vol_5
    - underlying_realized_vol_20
    - underlying_realized_vol_50

NaN policy matches scalar:
    - NaN until w ticks accumulated.
    - 0.0 when all w prices are identical (real zero-volatility state).
    - NaN when any of the last w ltp is ≤ 0.

Threading: pure functional. No shared state, no module-level globals,
safe to call from a ProcessPool worker.
"""

from __future__ import annotations

import polars as pl

_VOL_WINDOWS: tuple[int, ...] = (5, 20, 50)


def compute_realized_vol_features_batch(
    df: pl.DataFrame,
    *,
    ltp_col: str = "ltp",
) -> pl.DataFrame:
    """Compute all §8.19 realized-vol features for every row of ``df``.

    Args:
        df:      Polars DataFrame of underlying ticks in chronological
                 order. Must contain an ``ltp`` column of Float64.
        ltp_col: Override if the price column is named differently.

    Returns:
        The same DataFrame with three new columns appended. Existing
        columns are untouched; intermediate helper columns are dropped
        before return.
    """
    if ltp_col not in df.columns:
        raise ValueError(
            f"compute_realized_vol_features_batch: missing column "
            f"{ltp_col!r} in DataFrame (have {df.columns!r})"
        )

    # 1. Per-row log-return (current/previous price). Null for row 0 and
    #    anywhere ltp or its predecessor is ≤ 0.
    df = df.with_columns(
        _rv_log_ret=(
            pl.when((pl.col(ltp_col) > 0) & (pl.col(ltp_col).shift(1) > 0))
              .then(pl.col(ltp_col).log().diff())
              .otherwise(None)
        ),
        _rv_bad_price=(pl.col(ltp_col) <= 0).cast(pl.Int32),
    )

    # 2. For each window w: rolling_std of log_returns over w-1 values
    #    (matches scalar's "w prices → w-1 log returns" count), masked
    #    to None where any of the last w prices is bad.
    rolling_exprs = []
    for w in _VOL_WINDOWS:
        bad_window = pl.col("_rv_bad_price").rolling_sum(
            window_size=w, min_samples=w
        )
        vol = pl.col("_rv_log_ret").rolling_std(
            window_size=w - 1, min_samples=w - 1, ddof=1
        )
        rolling_exprs.append(
            pl.when(bad_window > 0)
              .then(None)
              .otherwise(vol)
              .alias(f"underlying_realized_vol_{w}")
        )

    df = df.with_columns(rolling_exprs).drop(["_rv_log_ret", "_rv_bad_price"])
    return df
