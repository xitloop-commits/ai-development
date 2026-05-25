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


def test_columnar_max_pain_matches_scalar_on_sample_snapshot():
    """Single-snapshot equivalence — the B.3a scaffold gate.

    Hand-checked answer for _SAMPLE_ROWS at spot=25,010:

        For each candidate K_s, total payout (callOI on K_s>K + putOI on K>K_s):
            K_s=24800 -> heavy put side (everything above 24800 is in-the-money
                         for puts), low call payout. Big number.
            K_s=24900 -> moderate both sides.
            K_s=25000 -> close to balanced; lowest payout of the 5.
            K_s=25100 -> heavy call payout (24800/24900/25000 callOIs all
                         in-the-money), low put. Big number.
            K_s=25200 -> heaviest call side.

        argmin = 25,000 -> max_pain_strike = 25,000.
        distance = (25,010 - 25,000) / 25,010 * 100 = 0.039984...%
        gravity:
            band = 25,010 * 0.02 = 500.2 -> includes strikes within
            [24,499.8, 25,500.2] -> all 5 strikes qualify.
            nearby_oi = sum(call+put) of all 5 = 555,000.
            total_oi = 555,000.
            gravity = 1.0 (every strike inside the band).
    """
    scalar_out = _scalar(_SAMPLE_SPOT, _SAMPLE_ROWS)
    columnar_out = _columnar(_SAMPLE_SPOT, _SAMPLE_ROWS)

    for key in ("max_pain_strike", "distance_to_max_pain_pct", "max_pain_gravity_strength"):
        s = scalar_out[key]
        c = columnar_out[key]
        assert _close(s, c), f"{key}: scalar={s!r} columnar={c!r}"

    # Sanity check the hand-computed expectations so a future scalar
    # behaviour change is caught here, not in the equivalence loop above.
    assert scalar_out["max_pain_strike"] == 25_000.0
    assert math.isclose(scalar_out["max_pain_gravity_strength"], 1.0, rel_tol=1e-9)
