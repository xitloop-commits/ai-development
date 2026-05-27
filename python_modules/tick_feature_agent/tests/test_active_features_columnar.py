"""
tests/test_active_features_columnar.py — T50 B.3c Polars side_strengths tests.

Verifies ``compute_side_strengths_batch`` produces values that match
``active_features.compute_side_strengths(curr, prev)`` when fed the
same time-ordered snapshot stream.
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

from tick_feature_agent.features.active_features import compute_side_strengths
from tick_feature_agent.features.active_features_columnar import (
    compute_side_strengths_batch,
)


def _eq(a, b, *, abs_tol: float = 1e-9, rel_tol: float = 1e-9) -> bool:
    a_missing = a is None or (isinstance(a, float) and math.isnan(a))
    b_missing = b is None or (isinstance(b, float) and math.isnan(b))
    if a_missing and b_missing:
        return True
    if a_missing != b_missing:
        return False
    return abs(a - b) <= abs_tol + rel_tol * abs(a)


def _build_chain_snapshots_df(snapshots: list[list[dict]]) -> pl.DataFrame:
    return pl.DataFrame({"rows": snapshots})


def _scalar_per_snapshot(snapshots: list[list[dict]]) -> list[dict[int, tuple]]:
    """Replicate the adapter's call pattern: per snapshot, pass the
    previous snapshot's rows (or None for the first)."""
    out: list[dict[int, tuple]] = []
    prev: list[dict] | None = None
    for rows in snapshots:
        out.append(compute_side_strengths(rows, prev))
        prev = rows
    return out


def _check_equivalent(snapshots: list[list[dict]]) -> None:
    scalar_per_snap = _scalar_per_snapshot(snapshots)
    columnar_df = compute_side_strengths_batch(
        _build_chain_snapshots_df(snapshots)
    )

    # Group columnar output by snapshot_id and check each entry.
    by_snap: dict[int, dict[int, tuple]] = {}
    for row in columnar_df.iter_rows(named=True):
        sid = int(row["snapshot_id"])
        by_snap.setdefault(sid, {})[int(row["strike"])] = (
            row["csv"], row["csoi"], row["strength"],
            row["psv"], row["psoi"], row["strength_pe"],
        )

    for sid, scalar_dict in enumerate(scalar_per_snap):
        columnar_dict = by_snap.get(sid, {})
        if not scalar_dict and not columnar_dict:
            continue
        assert set(scalar_dict.keys()) == set(columnar_dict.keys()), (
            f"snapshot {sid}: strike sets differ\n"
            f"  scalar:   {sorted(scalar_dict)}\n"
            f"  columnar: {sorted(columnar_dict)}"
        )
        for strike, s_tup in scalar_dict.items():
            c_tup = columnar_dict[strike]
            assert len(s_tup) == 6 and len(c_tup) == 6
            for i in range(6):
                assert _eq(s_tup[i], c_tup[i]), (
                    f"snapshot {sid} strike {strike} field {i}: "
                    f"scalar={s_tup[i]!r} columnar={c_tup[i]!r}"
                )


def _row(strike: int, *, cv: int = 0, pv: int = 0, coc: int = 0, poc: int = 0) -> dict:
    """Build a chain row stub with just the cols compute_side_strengths reads."""
    return {
        "strike": strike,
        "callVolume": cv,
        "putVolume": pv,
        "callOIChange": coc,
        "putOIChange": poc,
    }


# ── Tests ───────────────────────────────────────────────────────────────────


def test_single_snapshot_matches_scalar():
    """One snapshot, no prev. Scalar's `prev_rows is None` branch ->
    vol_diff = 0 for all strikes. Only OIChange contributes."""
    snapshot = [
        _row(24900, cv=100, pv=200, coc=10, poc=-30),
        _row(25000, cv=500, pv=300, coc=50, poc=-20),
        _row(25100, cv=200, pv=400, coc=-15, poc=40),
    ]
    _check_equivalent([snapshot])


def test_two_snapshots_vol_diff_picks_up():
    """Second snapshot has prev -> vol_diff computed from delta in
    callVolume / putVolume."""
    s1 = [_row(25000, cv=100, pv=200), _row(25100, cv=150, pv=250)]
    s2 = [_row(25000, cv=300, pv=210), _row(25100, cv=150, pv=400)]
    _check_equivalent([s1, s2])


def test_vol_diff_clips_to_zero_on_decrease():
    """vol_diff is max(0, curr - prev). A volume DECREASE -> diff=0
    (matches scalar's max(0, ...) clamp)."""
    s1 = [_row(25000, cv=500, pv=500)]
    s2 = [_row(25000, cv=100, pv=100)]  # both decreased
    _check_equivalent([s1, s2])


def test_normalize_all_zero_values_yields_zero():
    """When all values on a side are 0 -> normalize returns 0.0 per
    scalar's `if mx == 0.0: return [0.0]*len` short-circuit."""
    snapshot = [
        _row(24900, coc=0, poc=0),
        _row(25000, coc=0, poc=0),
    ]
    _check_equivalent([snapshot])


def test_normalize_all_equal_nonzero_yields_one():
    """All equal non-zero values -> normalize returns 1.0 per scalar's
    `elif mx == mn: return [1.0]*len`."""
    s1 = [_row(25000, cv=100), _row(25100, cv=100)]
    s2 = [_row(25000, cv=200), _row(25100, cv=200)]
    _check_equivalent([s1, s2])  # 2nd snapshot: vol_diff=100 for both


def test_full_realistic_chain_three_snapshots():
    """Realistic 5-strike chain across 3 snapshots — exercises shift,
    normalize, and the (csv + csoi)/2 strength aggregate together."""
    snapshots = [
        [
            _row(24800, cv=100, pv=200, coc=10, poc=-30),
            _row(24900, cv=200, pv=300, coc=20, poc=-25),
            _row(25000, cv=500, pv=400, coc=50, poc=-20),
            _row(25100, cv=300, pv=500, coc=30, poc=-15),
            _row(25200, cv=150, pv=600, coc=15, poc=-10),
        ],
        [
            _row(24800, cv=130, pv=210, coc=15, poc=-32),
            _row(24900, cv=240, pv=320, coc=25, poc=-30),
            _row(25000, cv=600, pv=420, coc=60, poc=-25),
            _row(25100, cv=320, pv=540, coc=32, poc=-18),
            _row(25200, cv=200, pv=640, coc=20, poc=-12),
        ],
        [
            _row(24800, cv=140, pv=215, coc=18, poc=-35),
            _row(24900, cv=260, pv=330, coc=28, poc=-33),
            _row(25000, cv=700, pv=440, coc=70, poc=-28),
            _row(25100, cv=350, pv=560, coc=35, poc=-20),
            _row(25200, cv=220, pv=660, coc=22, poc=-14),
        ],
    ]
    _check_equivalent(snapshots)


def test_strikes_can_change_between_snapshots():
    """Real chain: strikes drift in/out of the active window. The shift-
    over-strike pattern must handle missing prev correctly for new
    strikes (treated as "first snapshot for this strike" -> vol_diff=0)."""
    s1 = [_row(25000, cv=100), _row(25100, cv=200)]
    s2 = [_row(25100, cv=250), _row(25200, cv=300)]  # 25000 dropped, 25200 added
    _check_equivalent([s1, s2])


def test_empty_chain_yields_empty_output():
    """Empty list of snapshots -> empty output frame."""
    df = compute_side_strengths_batch(
        pl.DataFrame(schema={"rows": pl.List(pl.Struct({"strike": pl.Int64}))})
    )
    assert len(df) == 0
