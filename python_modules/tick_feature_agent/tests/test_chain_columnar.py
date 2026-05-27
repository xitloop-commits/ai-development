"""
tests/test_chain_columnar.py — T50 B.3e scaffold tests.

Verifies ``compute_oi_weighted_levels_batch`` + ``compute_wall_strength_batch``
match the scalar implementations from ``features/chain.py`` on synthetic
chain snapshots.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import polars as pl

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from tick_feature_agent.features.chain import (
    compute_oi_weighted_levels,
    compute_wall_strength,
)
from tick_feature_agent.features.chain_columnar import (
    compute_oi_weighted_levels_batch,
    compute_wall_strength_batch,
)


def _eq(a, b, *, abs_tol: float = 1e-9, rel_tol: float = 1e-9) -> bool:
    a_missing = a is None or (isinstance(a, float) and math.isnan(a))
    b_missing = b is None or (isinstance(b, float) and math.isnan(b))
    if a_missing and b_missing:
        return True
    if a_missing != b_missing:
        return False
    return abs(a - b) <= abs_tol + rel_tol * abs(a)


_SAMPLE_ROWS = [
    {"strike": 24_800, "callOI": 30_000, "putOI": 80_000},
    {"strike": 24_900, "callOI": 55_000, "putOI": 60_000},
    {"strike": 25_000, "callOI": 90_000, "putOI": 90_000},
    {"strike": 25_100, "callOI": 40_000, "putOI": 50_000},
    {"strike": 25_200, "callOI": 25_000, "putOI": 35_000},
]

_ZERO_CE_ROWS = [
    {"strike": 25_000, "callOI": 0, "putOI": 50_000},
    {"strike": 25_100, "callOI": 0, "putOI": 75_000},
]


# ── oi_weighted_levels ─────────────────────────────────────────────────────


def test_oi_weighted_levels_matches_scalar():
    scalar_out = compute_oi_weighted_levels(_SAMPLE_ROWS)
    columnar_df = compute_oi_weighted_levels_batch(
        pl.DataFrame({"rows": [_SAMPLE_ROWS]})
    )
    row = columnar_df.row(0, named=True)
    assert _eq(scalar_out["oi_weighted_ce_resistance_strike"], row["oi_weighted_ce_resistance_strike"])
    assert _eq(scalar_out["oi_weighted_pe_support_strike"], row["oi_weighted_pe_support_strike"])


def test_oi_weighted_levels_zero_side_returns_nan():
    """CE side has zero OI -> NaN per scalar 'denominator zero' guard."""
    scalar_out = compute_oi_weighted_levels(_ZERO_CE_ROWS)
    columnar_df = compute_oi_weighted_levels_batch(
        pl.DataFrame({"rows": [_ZERO_CE_ROWS]})
    )
    row = columnar_df.row(0, named=True)
    assert isinstance(scalar_out["oi_weighted_ce_resistance_strike"], float)
    assert math.isnan(scalar_out["oi_weighted_ce_resistance_strike"])
    assert row["oi_weighted_ce_resistance_strike"] is None or (
        isinstance(row["oi_weighted_ce_resistance_strike"], float)
        and math.isnan(row["oi_weighted_ce_resistance_strike"])
    )
    # PE side still valid
    assert _eq(scalar_out["oi_weighted_pe_support_strike"], row["oi_weighted_pe_support_strike"])


def test_oi_weighted_levels_multiple_snapshots():
    rows_a = _SAMPLE_ROWS
    rows_b = [
        {"strike": 26_000, "callOI": 10_000, "putOI": 20_000},
        {"strike": 26_100, "callOI": 90_000, "putOI": 80_000},
    ]
    columnar_df = compute_oi_weighted_levels_batch(
        pl.DataFrame({"rows": [rows_a, rows_b]})
    )
    assert len(columnar_df) == 2
    for i, rows in enumerate([rows_a, rows_b]):
        s = compute_oi_weighted_levels(rows)
        c = columnar_df.row(i, named=True)
        assert _eq(s["oi_weighted_ce_resistance_strike"], c["oi_weighted_ce_resistance_strike"])
        assert _eq(s["oi_weighted_pe_support_strike"], c["oi_weighted_pe_support_strike"])


# ── wall_strength ──────────────────────────────────────────────────────────


def test_wall_strength_matches_scalar_balanced():
    scalar_out = compute_wall_strength(_SAMPLE_ROWS)
    columnar_df = compute_wall_strength_batch(
        pl.DataFrame({"rows": [_SAMPLE_ROWS]})
    )
    row = columnar_df.row(0, named=True)
    assert _eq(scalar_out["ce_wall_strength_rel"], row["ce_wall_strength_rel"])
    assert _eq(scalar_out["pe_wall_strength_rel"], row["pe_wall_strength_rel"])


def test_wall_strength_concentrated_wall():
    """One strike with massively dominant OI -> high wall strength ratio."""
    rows = [
        {"strike": 25_000, "callOI": 1_000_000, "putOI": 100},
        {"strike": 25_100, "callOI": 5_000, "putOI": 5_000},
        {"strike": 25_200, "callOI": 3_000, "putOI": 3_000},
    ]
    scalar_out = compute_wall_strength(rows)
    columnar_df = compute_wall_strength_batch(pl.DataFrame({"rows": [rows]}))
    row = columnar_df.row(0, named=True)
    assert _eq(scalar_out["ce_wall_strength_rel"], row["ce_wall_strength_rel"])
    assert _eq(scalar_out["pe_wall_strength_rel"], row["pe_wall_strength_rel"])
    # CE ratio should be large (1M dominates)
    assert scalar_out["ce_wall_strength_rel"] > 2.0


def test_wall_strength_single_valid_strike_returns_nan():
    """< 2 valid strikes on a side -> NaN per scalar's >=2 guard."""
    rows = [
        {"strike": 25_000, "callOI": 10_000, "putOI": 5_000},
        {"strike": 25_100, "callOI": 0, "putOI": 0},  # excluded
    ]
    scalar_out = compute_wall_strength(rows)
    columnar_df = compute_wall_strength_batch(pl.DataFrame({"rows": [rows]}))
    row = columnar_df.row(0, named=True)
    assert isinstance(scalar_out["ce_wall_strength_rel"], float)
    assert math.isnan(scalar_out["ce_wall_strength_rel"])
    assert row["ce_wall_strength_rel"] is None or (
        isinstance(row["ce_wall_strength_rel"], float)
        and math.isnan(row["ce_wall_strength_rel"])
    )


def test_wall_strength_multiple_snapshots():
    rows_a = _SAMPLE_ROWS
    rows_b = [
        {"strike": 26_000, "callOI": 100_000, "putOI": 5_000},
        {"strike": 26_100, "callOI": 1_000, "putOI": 50_000},
        {"strike": 26_200, "callOI": 500, "putOI": 5_000},
    ]
    columnar_df = compute_wall_strength_batch(
        pl.DataFrame({"rows": [rows_a, rows_b]})
    )
    for i, rows in enumerate([rows_a, rows_b]):
        s = compute_wall_strength(rows)
        c = columnar_df.row(i, named=True)
        assert _eq(s["ce_wall_strength_rel"], c["ce_wall_strength_rel"])
        assert _eq(s["pe_wall_strength_rel"], c["pe_wall_strength_rel"])
