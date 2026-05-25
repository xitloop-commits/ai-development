"""
tests/test_max_pain_columnar.py — T50 B.3a scaffold equivalence test.

Verifies that ``compute_max_pain_features_batch`` (Polars columnar) and
``compute_max_pain_features`` (scalar) return identical values on one
synthetic chain snapshot. Full edge-case sweep + real-data byte-equality
harness ship in the B.3a execution session — see
``docs/T50_B3A_MAX_PAIN_DESIGN.md`` § Next-session checklist.
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

from tick_feature_agent.features.levels import compute_max_pain_features
from tick_feature_agent.features.levels_columnar import (
    compute_max_pain_features_batch,
)


# A synthetic chain snapshot — 5 strikes around 25,000 spot with realistic
# OI skew. callOI peaks below spot, putOI peaks above — typical right
# before a strong-pin expiry session.
_SAMPLE_ROWS = [
    {"strike": 24_800, "callOI": 30_000, "putOI": 80_000},
    {"strike": 24_900, "callOI": 55_000, "putOI": 60_000},
    {"strike": 25_000, "callOI": 90_000, "putOI": 90_000},
    {"strike": 25_100, "callOI": 40_000, "putOI": 50_000},
    {"strike": 25_200, "callOI": 25_000, "putOI": 35_000},
]
_SAMPLE_SPOT = 25_010.0


def _scalar(spot: float, rows: list[dict]) -> dict:
    return compute_max_pain_features(spot, rows)


def _columnar(spot: float, rows: list[dict]) -> dict:
    """Run the batched implementation on a single-snapshot input and
    pull the single output row out as a dict for easy comparison."""
    snapshots = pl.DataFrame({
        "spot_price": [spot],
        "rows": [rows],
    })
    out_df = compute_max_pain_features_batch(snapshots)
    assert len(out_df) == 1, f"expected 1 output row, got {len(out_df)}"
    row = out_df.row(0, named=True)
    return {
        "max_pain_strike": row["max_pain_strike"],
        "distance_to_max_pain_pct": row["distance_to_max_pain_pct"],
        "max_pain_gravity_strength": row["max_pain_gravity_strength"],
    }


def _close(a: float, b: float, *, abs_tol: float = 1e-12, rel_tol: float = 1e-9) -> bool:
    """Treat NaN == NaN as a match (matches scalar's NaN-on-bad-input
    contract); otherwise require near-equality."""
    a_missing = isinstance(a, float) and math.isnan(a)
    b_missing = b is None or (isinstance(b, float) and math.isnan(b))
    if a_missing and b_missing:
        return True
    if a_missing != b_missing:
        return False
    return abs(a - b) <= abs_tol + rel_tol * abs(a)


def _assert_equivalent(scalar_out: dict, columnar_out: dict) -> None:
    for key in ("max_pain_strike", "distance_to_max_pain_pct", "max_pain_gravity_strength"):
        s = scalar_out[key]
        c = columnar_out[key]
        assert _close(s, c), f"{key}: scalar={s!r} columnar={c!r}"


def test_columnar_max_pain_matches_scalar_on_sample_snapshot():
    """Single-snapshot equivalence — the B.3a scaffold gate.

    Hand-checked: argmin payout at K_s=25,000; gravity_band covers all
    5 strikes so gravity_strength=1.0. Sanity-checks scalar against
    those expected values so a future scalar behaviour change is caught
    here, not silently mirrored by the columnar implementation.
    """
    scalar_out = _scalar(_SAMPLE_SPOT, _SAMPLE_ROWS)
    columnar_out = _columnar(_SAMPLE_SPOT, _SAMPLE_ROWS)
    _assert_equivalent(scalar_out, columnar_out)
    assert scalar_out["max_pain_strike"] == 25_000.0
    assert math.isclose(scalar_out["max_pain_gravity_strength"], 1.0, rel_tol=1e-9)


# ── Edge-case tests (per design doc's edge-case table) ─────────────────────


def test_empty_chain_rows_returns_all_nan():
    """chain_rows=[] -> scalar returns all NaN. Columnar must too —
    either an output row with null values, or no row at all (we accept
    either as long as no exception)."""
    scalar_out = _scalar(_SAMPLE_SPOT, [])
    assert all(
        isinstance(v, float) and math.isnan(v) for v in scalar_out.values()
    )
    snapshots = pl.DataFrame({"spot_price": [_SAMPLE_SPOT], "rows": [[]]})
    out_df = compute_max_pain_features_batch(snapshots)
    # Empty rows -> after explode+filter there's nothing left for this
    # snapshot, so it drops out of the result. That's the expected
    # behaviour; downstream consumers treat "missing snapshot row" the
    # same as "all-NaN output".
    assert len(out_df) == 0


def test_total_oi_zero_returns_all_nan():
    """All OI=0 -> total_oi=0 -> scalar returns all NaN. Columnar must
    match (either drop the row or null the outputs)."""
    rows = [{"strike": 25_000, "callOI": 0, "putOI": 0}]
    scalar_out = _scalar(_SAMPLE_SPOT, rows)
    assert all(
        isinstance(v, float) and math.isnan(v) for v in scalar_out.values()
    )
    snapshots = pl.DataFrame({"spot_price": [_SAMPLE_SPOT], "rows": [rows]})
    out_df = compute_max_pain_features_batch(snapshots)
    if len(out_df) == 0:
        return  # acceptable — snapshot dropped because no valid contribution
    # If a row IS emitted, gravity must be null (denominator was 0).
    row = out_df.row(0, named=True)
    assert row["max_pain_gravity_strength"] is None or (
        isinstance(row["max_pain_gravity_strength"], float)
        and math.isnan(row["max_pain_gravity_strength"])
    )


def test_single_strike_returns_that_strike():
    """One strike in chain -> max_pain trivially that strike."""
    rows = [{"strike": 25_000, "callOI": 10_000, "putOI": 10_000}]
    scalar_out = _scalar(_SAMPLE_SPOT, rows)
    columnar_out = _columnar(_SAMPLE_SPOT, rows)
    _assert_equivalent(scalar_out, columnar_out)
    assert scalar_out["max_pain_strike"] == 25_000.0


def test_spot_none_yields_only_max_pain_strike():
    """spot=None -> scalar returns max_pain_strike but distance + gravity
    are NaN. Columnar must agree."""
    scalar_out = _scalar(None, _SAMPLE_ROWS)
    assert scalar_out["max_pain_strike"] == 25_000.0
    assert isinstance(scalar_out["distance_to_max_pain_pct"], float)
    assert math.isnan(scalar_out["distance_to_max_pain_pct"])
    assert math.isnan(scalar_out["max_pain_gravity_strength"])
    # Polars equivalent — pass spot as null in the DataFrame.
    snapshots = pl.DataFrame({
        "spot_price": [None],
        "rows": [_SAMPLE_ROWS],
    }, schema={"spot_price": pl.Float64, "rows": pl.List(pl.Struct({
        "strike": pl.Int64, "callOI": pl.Int64, "putOI": pl.Int64,
    }))})
    out_df = compute_max_pain_features_batch(snapshots)
    assert len(out_df) == 1
    row = out_df.row(0, named=True)
    assert row["max_pain_strike"] == 25_000.0
    # distance + gravity must be null when spot is invalid
    assert row["distance_to_max_pain_pct"] is None or (
        isinstance(row["distance_to_max_pain_pct"], float)
        and math.isnan(row["distance_to_max_pain_pct"])
    )
    assert row["max_pain_gravity_strength"] is None or (
        isinstance(row["max_pain_gravity_strength"], float)
        and math.isnan(row["max_pain_gravity_strength"])
    )


def test_spot_zero_treated_as_invalid():
    """spot=0 (defensive scalar check via _safe_pos) -> distance + gravity
    NaN even though max_pain_strike is valid."""
    scalar_out = _scalar(0.0, _SAMPLE_ROWS)
    assert scalar_out["max_pain_strike"] == 25_000.0
    assert math.isnan(scalar_out["distance_to_max_pain_pct"])
    assert math.isnan(scalar_out["max_pain_gravity_strength"])
    snapshots = pl.DataFrame({"spot_price": [0.0], "rows": [_SAMPLE_ROWS]})
    out_df = compute_max_pain_features_batch(snapshots)
    assert len(out_df) == 1
    row = out_df.row(0, named=True)
    assert row["max_pain_strike"] == 25_000.0
    assert row["distance_to_max_pain_pct"] is None
    assert row["max_pain_gravity_strength"] is None


def test_tie_on_min_payout_picks_lowest_strike_ascending():
    """Symmetric synthetic chain -> two adjacent strikes might tie on
    payout. Scalar picks the FIRST encountered (insertion order); the
    columnar code sorts by (total_payout, k_s) so ties resolve to the
    lower strike. Verify the rule is consistent in this controlled case."""
    # Perfectly symmetric: equal OI mirrored around 25,000. Payout at
    # 24,950 == payout at 25,050 by construction; argmin is whichever
    # the sort order picks. Scalar iterates rows in input order, so
    # the first qualifying strike wins.
    rows = [
        {"strike": 24_900, "callOI": 10_000, "putOI": 10_000},
        {"strike": 24_950, "callOI": 50_000, "putOI": 50_000},
        {"strike": 25_050, "callOI": 50_000, "putOI": 50_000},
        {"strike": 25_100, "callOI": 10_000, "putOI": 10_000},
    ]
    scalar_out = _scalar(_SAMPLE_SPOT, rows)
    columnar_out = _columnar(_SAMPLE_SPOT, rows)
    # Per design doc: scalar tie-break is "first encountered". Input order
    # is ascending strikes so the first qualifying tie wins == lowest
    # strike. Our Polars sort key (k_s ascending after total_payout) also
    # picks the lowest. So they match.
    _assert_equivalent(scalar_out, columnar_out)


def test_multiple_snapshots_in_one_batch():
    """Two distinct snapshots in one input DataFrame -> each gets its
    own row out, with correct per-snapshot answers."""
    rows_a = _SAMPLE_ROWS
    rows_b = [
        {"strike": 25_000, "callOI": 10_000, "putOI": 10_000},
        {"strike": 25_100, "callOI": 100_000, "putOI": 5_000},
    ]
    snapshots = pl.DataFrame({
        "spot_price": [_SAMPLE_SPOT, 25_050.0],
        "rows": [rows_a, rows_b],
    })
    out_df = compute_max_pain_features_batch(snapshots)
    assert len(out_df) == 2
    # Compare each row vs scalar
    for i, (spot, rows) in enumerate(
        [(_SAMPLE_SPOT, rows_a), (25_050.0, rows_b)]
    ):
        scalar_out = _scalar(spot, rows)
        row = out_df.row(i, named=True)
        columnar_out = {
            "max_pain_strike": row["max_pain_strike"],
            "distance_to_max_pain_pct": row["distance_to_max_pain_pct"],
            "max_pain_gravity_strength": row["max_pain_gravity_strength"],
        }
        _assert_equivalent(scalar_out, columnar_out)


def test_malformed_row_with_string_oi_is_skipped():
    """One row has a non-numeric OI -> scalar try/except skips it, the
    other rows still compute. Columnar must end up with the same answer
    by filtering / null-coercing the bad row."""
    # Note: pl.from_dicts will reject mixed types in the same struct
    # column, so we represent the malformed-OI case by setting putOI to
    # None (the realistic recorder failure mode — broker returned no
    # OI, JSON has null). Scalar's _safe_pos / int-cast handles None
    # the same way it handles a non-numeric: the row's putOI becomes 0.
    rows = [
        {"strike": 24_900, "callOI": 10_000, "putOI": None},
        {"strike": 25_000, "callOI": 50_000, "putOI": 50_000},
        {"strike": 25_100, "callOI": 10_000, "putOI": 10_000},
    ]
    scalar_out = _scalar(_SAMPLE_SPOT, rows)
    columnar_out = _columnar(_SAMPLE_SPOT, rows)
    _assert_equivalent(scalar_out, columnar_out)
