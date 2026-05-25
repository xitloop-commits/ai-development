"""
tests/test_realized_vol_columnar.py — Equivalence test for the T48 spike.

Asserts that ``realized_vol_columnar.compute_realized_vol_features_batch``
produces the SAME values as the scalar per-event
``realized_vol.compute_realized_vol_features``, row-for-row, for every
tick in a deterministic synthetic sequence.

Test scope (deliberately tight — this is a spike validation):

    1. Smooth random walk (no bad prices, ample data) — must match.
    2. Bad-price guard: a few ticks with ltp == 0 trigger NaN windows.
    3. Identical-price stretches — must produce exact 0.0 stddev.
    4. Short input (< 50 ticks) — leading NaNs must align.

If any of these diverge by more than 1e-12 absolute or 1e-9 relative,
T48 cannot green-light T50 (B-full) — the bit-for-bit guarantee is the
only thing protecting live trading from silently changed feature
values.
"""

from __future__ import annotations

import math
import random
import sys
from pathlib import Path

import polars as pl

# Path bootstrap
_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from tick_feature_agent.buffers.tick_buffer import CircularBuffer, UnderlyingTick
from tick_feature_agent.features.realized_vol import compute_realized_vol_features
from tick_feature_agent.features.realized_vol_columnar import (
    compute_realized_vol_features_batch,
)

_WINDOWS = (5, 20, 50)


# ── helpers ─────────────────────────────────────────────────────────────────


def _scalar_per_tick(ltps: list[float]) -> list[dict]:
    """Run scalar implementation tick-by-tick. Returns one dict per tick."""
    buf = CircularBuffer(maxlen=50)
    rows: list[dict] = []
    for i, p in enumerate(ltps):
        buf.push(UnderlyingTick(timestamp=float(i), ltp=p, bid=p, ask=p, volume=0))
        rows.append(compute_realized_vol_features(buf))
    return rows


def _columnar(ltps: list[float]) -> pl.DataFrame:
    """Run columnar implementation on the same price series."""
    df = pl.DataFrame({"ltp": ltps})
    return compute_realized_vol_features_batch(df)


def _assert_equivalent(
    scalar_rows: list[dict],
    columnar_df: pl.DataFrame,
    *,
    abs_tol: float = 1e-12,
    rel_tol: float = 1e-9,
) -> None:
    """Compare scalar vs columnar values row-for-row across all 3 windows.

    NaN ↔ None equivalence: scalar uses ``float('nan')``, columnar uses
    Polars null. Both are treated as 'missing' here.
    """
    assert len(scalar_rows) == len(columnar_df), (
        f"row count mismatch: scalar={len(scalar_rows)} vs "
        f"columnar={len(columnar_df)}"
    )
    for w in _WINDOWS:
        col_name = f"underlying_realized_vol_{w}"
        col_values = columnar_df[col_name].to_list()
        for i, (s_row, c_val) in enumerate(zip(scalar_rows, col_values)):
            s_val = s_row[col_name]
            s_missing = isinstance(s_val, float) and math.isnan(s_val)
            c_missing = c_val is None or (
                isinstance(c_val, float) and math.isnan(c_val)
            )
            if s_missing and c_missing:
                continue
            if s_missing != c_missing:
                raise AssertionError(
                    f"row {i} window {w}: missing-state mismatch "
                    f"scalar={s_val!r} columnar={c_val!r}"
                )
            # Both present — must match within tolerance.
            diff = abs(s_val - c_val)
            allowed = abs_tol + rel_tol * abs(s_val)
            if diff > allowed:
                raise AssertionError(
                    f"row {i} window {w}: value mismatch "
                    f"scalar={s_val!r} columnar={c_val!r} "
                    f"diff={diff} allowed={allowed}"
                )


# ── tests ───────────────────────────────────────────────────────────────────


def test_smooth_random_walk_matches_scalar():
    """200 ticks of a multiplicative random walk — basic equivalence."""
    rng = random.Random(42)
    p = 25_000.0
    ltps: list[float] = []
    for _ in range(200):
        # 0.1% std multiplicative noise → realistic intraday tick scale
        p *= math.exp(rng.gauss(0.0, 0.001))
        ltps.append(p)
    scalar_rows = _scalar_per_tick(ltps)
    columnar_df = _columnar(ltps)
    _assert_equivalent(scalar_rows, columnar_df)


def test_bad_price_zeros_propagate_to_nan_windows():
    """A few ltp==0 ticks must cause NaN windows in both impls — and they
    must clear out at exactly the same row as the bad tick falls off the
    rolling window."""
    rng = random.Random(7)
    p = 100.0
    ltps: list[float] = []
    for i in range(120):
        if i in (30, 70):
            ltps.append(0.0)  # bad tick
        else:
            p *= math.exp(rng.gauss(0.0, 0.002))
            ltps.append(p)
    scalar_rows = _scalar_per_tick(ltps)
    columnar_df = _columnar(ltps)
    _assert_equivalent(scalar_rows, columnar_df)


def test_identical_prices_yield_zero_volatility():
    """All ltps == 50,000 → log_returns all zero → stddev exactly 0.0
    (NOT NaN). Both impls must agree this is a valid zero state."""
    ltps = [50_000.0] * 100
    scalar_rows = _scalar_per_tick(ltps)
    columnar_df = _columnar(ltps)
    _assert_equivalent(scalar_rows, columnar_df)
    # Spot-check: every fully-populated window must read exactly 0.0
    for w in _WINDOWS:
        col = f"underlying_realized_vol_{w}"
        # First w-1 rows are NaN; row w-1 onward should be 0.0 exactly
        valid = columnar_df[col].to_list()[w - 1:]
        for v in valid:
            assert v == 0.0, f"window {w}: expected 0.0, got {v!r}"


def test_short_sequence_leading_nans_align():
    """Sequence shorter than the largest window — leading NaNs must
    appear at the same indices in scalar and columnar outputs."""
    rng = random.Random(123)
    p = 1_000.0
    ltps: list[float] = []
    for _ in range(15):  # < 20 ticks, _50 always NaN
        p *= math.exp(rng.gauss(0.0, 0.003))
        ltps.append(p)
    scalar_rows = _scalar_per_tick(ltps)
    columnar_df = _columnar(ltps)
    _assert_equivalent(scalar_rows, columnar_df)


def test_single_tick_all_nans():
    """One tick — scalar's `n < w` guard fires for every window. Columnar's
    min_samples gate must match."""
    ltps = [42_000.0]
    scalar_rows = _scalar_per_tick(ltps)
    columnar_df = _columnar(ltps)
    _assert_equivalent(scalar_rows, columnar_df)
    # Every output must be missing (NaN scalar / null columnar)
    for w in _WINDOWS:
        col = f"underlying_realized_vol_{w}"
        v = columnar_df[col].to_list()[0]
        assert v is None or (isinstance(v, float) and math.isnan(v)), (
            f"window {w}: expected null/NaN for 1-tick input, got {v!r}"
        )
