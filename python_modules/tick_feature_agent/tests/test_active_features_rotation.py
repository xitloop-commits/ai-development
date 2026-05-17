"""
tests/test_active_features_rotation.py — Tests for the C7 strike-rotation
features appended to features/active_features.py.

Covers compute_strike_rotation_features():
    active_strike_shift_direction  ∈ {−1, 0, +1} or NaN
    active_strike_shift_velocity   signed (shift_pts / strike_step) or NaN
    atm_to_otm_flow_ratio          otm_oi_change / atm_oi_change or NaN

Run: py -3 -m pytest python_modules/tick_feature_agent/tests/test_active_features_rotation.py -v
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.features.active_features import (
    compute_strike_rotation_features,
)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _row(
    strike: int,
    c_oi: float,
    p_oi: float,
    c_oi_chg: float = 0.0,
    p_oi_chg: float = 0.0,
) -> dict:
    """Build a chain row in ChainSnapshot.rows shape."""
    return {
        "strike": strike,
        "callOI": c_oi,
        "putOI": p_oi,
        "callOIChange": c_oi_chg,
        "putOIChange": p_oi_chg,
    }


def _nan(v) -> bool:
    return isinstance(v, float) and math.isnan(v)


# ══════════════════════════════════════════════════════════════════════════════
# None / empty input
# ══════════════════════════════════════════════════════════════════════════════


def test_none_history_yields_all_nan():
    out = compute_strike_rotation_features(
        active_strike_history=None,
        atm_strike=24100,
        strike_step=50,
        now_ts=1_000_000.0,
    )
    assert _nan(out["active_strike_shift_direction"])
    assert _nan(out["active_strike_shift_velocity"])
    assert _nan(out["atm_to_otm_flow_ratio"])


def test_empty_history_yields_all_nan():
    out = compute_strike_rotation_features(
        active_strike_history=[],
        atm_strike=24100,
        strike_step=50,
        now_ts=1_000_000.0,
    )
    assert _nan(out["active_strike_shift_direction"])
    assert _nan(out["active_strike_shift_velocity"])
    assert _nan(out["atm_to_otm_flow_ratio"])


def test_none_now_ts_yields_all_nan():
    now = 1_000_000.0
    rows = [_row(24100, 1000, 1000, 50, 50)]
    out = compute_strike_rotation_features(
        active_strike_history=[(now - 1, rows)],
        atm_strike=24100,
        strike_step=50,
        now_ts=None,
    )
    assert _nan(out["active_strike_shift_direction"])
    assert _nan(out["active_strike_shift_velocity"])
    assert _nan(out["atm_to_otm_flow_ratio"])


def test_none_atm_strike_yields_all_nan():
    now = 1_000_000.0
    rows = [_row(24100, 1000, 1000, 50, 50)]
    out = compute_strike_rotation_features(
        active_strike_history=[(now - 1, rows)],
        atm_strike=None,
        strike_step=50,
        now_ts=now,
    )
    assert _nan(out["active_strike_shift_direction"])
    assert _nan(out["active_strike_shift_velocity"])
    assert _nan(out["atm_to_otm_flow_ratio"])


def test_bad_strike_step_none_yields_all_nan():
    now = 1_000_000.0
    rows = [_row(24100, 1000, 1000, 50, 50)]
    out = compute_strike_rotation_features(
        active_strike_history=[(now - 1, rows)],
        atm_strike=24100,
        strike_step=None,
        now_ts=now,
    )
    assert _nan(out["active_strike_shift_direction"])
    assert _nan(out["active_strike_shift_velocity"])
    assert _nan(out["atm_to_otm_flow_ratio"])


def test_bad_strike_step_zero_yields_all_nan():
    now = 1_000_000.0
    rows = [_row(24100, 1000, 1000, 50, 50)]
    out = compute_strike_rotation_features(
        active_strike_history=[(now - 1, rows)],
        atm_strike=24100,
        strike_step=0,
        now_ts=now,
    )
    assert _nan(out["active_strike_shift_direction"])
    assert _nan(out["active_strike_shift_velocity"])
    assert _nan(out["atm_to_otm_flow_ratio"])


def test_bad_strike_step_negative_yields_all_nan():
    now = 1_000_000.0
    rows = [_row(24100, 1000, 1000, 50, 50)]
    out = compute_strike_rotation_features(
        active_strike_history=[(now - 1, rows)],
        atm_strike=24100,
        strike_step=-50,
        now_ts=now,
    )
    assert _nan(out["active_strike_shift_direction"])
    assert _nan(out["active_strike_shift_velocity"])
    assert _nan(out["atm_to_otm_flow_ratio"])


# ══════════════════════════════════════════════════════════════════════════════
# Baseline behaviour
# ══════════════════════════════════════════════════════════════════════════════


def test_insufficient_baseline_history_within_5min_only():
    """History only spans the last few minutes — no 5-min baseline.

    Shift features NaN, ratio still finite from current snapshot.
    """
    now = 1_000_000.0
    rows = [
        _row(24050, 1000, 1000, 200, 200),    # ATM cluster (within ±step)
        _row(24100, 1000, 1000, 100, 100),    # ATM strike
        _row(24150, 1000, 1000, 100, 100),    # ATM cluster
        _row(24300, 1000, 1000, 500, 500),    # OTM
    ]
    out = compute_strike_rotation_features(
        active_strike_history=[
            (now - 120, rows),  # only 2 min old — no baseline available
            (now - 1, rows),
        ],
        atm_strike=24100,
        strike_step=50,
        now_ts=now,
    )
    assert _nan(out["active_strike_shift_direction"])
    assert _nan(out["active_strike_shift_velocity"])
    # Ratio still computable from current snapshot.
    # atm = |200|+|200| + |100|+|100| + |100|+|100| = 800
    # otm = |500|+|500| = 1000
    assert out["atm_to_otm_flow_ratio"] == pytest.approx(1000.0 / 800.0)


def test_baseline_too_stale_beyond_tolerance():
    """Baseline sample > 60s past target → shift features NaN; ratio still finite."""
    now = 1_000_000.0
    baseline_rows = [_row(24100, 1000, 1000)]
    current_rows = [
        _row(24050, 1000, 1000, 50, 50),
        _row(24100, 1000, 1000, 100, 100),
        _row(24150, 1000, 1000, 50, 50),
        _row(24300, 1000, 1000, 400, 400),
    ]
    out = compute_strike_rotation_features(
        active_strike_history=[
            # 200s past target (target = now - 300), beyond 60s tolerance
            (now - 500, baseline_rows),
            (now - 1, current_rows),
        ],
        atm_strike=24100,
        strike_step=50,
        now_ts=now,
    )
    assert _nan(out["active_strike_shift_direction"])
    assert _nan(out["active_strike_shift_velocity"])
    # Ratio still finite from current snapshot.
    # atm = 50+50+100+100+50+50 = 400
    # otm = 400+400 = 800
    assert out["atm_to_otm_flow_ratio"] == pytest.approx(800.0 / 400.0)


# ══════════════════════════════════════════════════════════════════════════════
# Shift direction + velocity
# ══════════════════════════════════════════════════════════════════════════════


def test_com_shift_up_direction_positive():
    """COM shifts UP over 5 min → direction +1, velocity > 0."""
    now = 1_000_000.0
    # Baseline COM ≈ 24050 (low strike has all the OI mass)
    baseline_rows = [
        _row(24050, 10_000, 10_000),
        _row(24100, 100, 100),
        _row(24150, 100, 100),
    ]
    # Current COM shifted up to ≈ 24150 (high strike now has the mass)
    current_rows = [
        _row(24050, 100, 100),
        _row(24100, 100, 100),
        _row(24150, 10_000, 10_000),
    ]
    out = compute_strike_rotation_features(
        active_strike_history=[
            (now - 300, baseline_rows),
            (now - 1, current_rows),
        ],
        atm_strike=24100,
        strike_step=50,
        now_ts=now,
    )
    assert out["active_strike_shift_direction"] == 1.0
    assert out["active_strike_shift_velocity"] > 0


def test_com_shift_down_direction_negative():
    """COM shifts DOWN over 5 min → direction −1, velocity < 0."""
    now = 1_000_000.0
    baseline_rows = [
        _row(24050, 100, 100),
        _row(24100, 100, 100),
        _row(24150, 10_000, 10_000),
    ]
    current_rows = [
        _row(24050, 10_000, 10_000),
        _row(24100, 100, 100),
        _row(24150, 100, 100),
    ]
    out = compute_strike_rotation_features(
        active_strike_history=[
            (now - 300, baseline_rows),
            (now - 1, current_rows),
        ],
        atm_strike=24100,
        strike_step=50,
        now_ts=now,
    )
    assert out["active_strike_shift_direction"] == -1.0
    assert out["active_strike_shift_velocity"] < 0


def test_no_net_shift_direction_zero_velocity_zero():
    """COM unchanged → direction 0, velocity 0."""
    now = 1_000_000.0
    rows = [
        _row(24050, 1000, 1000),
        _row(24100, 1000, 1000),
        _row(24150, 1000, 1000),
    ]
    out = compute_strike_rotation_features(
        active_strike_history=[
            (now - 300, rows),
            (now - 1, rows),
        ],
        atm_strike=24100,
        strike_step=50,
        now_ts=now,
    )
    assert out["active_strike_shift_direction"] == 0.0
    assert out["active_strike_shift_velocity"] == pytest.approx(0.0)


def test_velocity_scales_with_strike_step():
    """200-strike-points shift in step-100 instrument → velocity 2.0."""
    now = 1_000_000.0
    # Baseline COM = 24000 (single strike)
    baseline_rows = [_row(24000, 1000, 1000)]
    # Current COM = 24200 (single strike) → shift = +200 pts
    current_rows = [_row(24200, 1000, 1000, 50, 50)]
    out = compute_strike_rotation_features(
        active_strike_history=[
            (now - 300, baseline_rows),
            (now - 1, current_rows),
        ],
        atm_strike=24100,
        strike_step=100,
        now_ts=now,
    )
    assert out["active_strike_shift_direction"] == 1.0
    # 200-pt shift / 100-pt step = 2.0
    assert out["active_strike_shift_velocity"] == pytest.approx(2.0)


def test_velocity_signed_negative_with_step_scaling():
    """−150-strike-point shift in step-50 instrument → velocity −3.0."""
    now = 1_000_000.0
    baseline_rows = [_row(24200, 1000, 1000)]
    current_rows = [_row(24050, 1000, 1000)]
    out = compute_strike_rotation_features(
        active_strike_history=[
            (now - 300, baseline_rows),
            (now - 1, current_rows),
        ],
        atm_strike=24100,
        strike_step=50,
        now_ts=now,
    )
    assert out["active_strike_shift_direction"] == -1.0
    assert out["active_strike_shift_velocity"] == pytest.approx(-3.0)


# ══════════════════════════════════════════════════════════════════════════════
# ATM-to-OTM flow ratio
# ══════════════════════════════════════════════════════════════════════════════


def test_atm_heavy_flow_ratio_less_than_one():
    """All OI change concentrated at ATM cluster → ratio < 1."""
    now = 1_000_000.0
    rows = [
        _row(24050, 1000, 1000, 500, 500),   # ATM cluster (atm − step)
        _row(24100, 1000, 1000, 800, 800),   # ATM
        _row(24150, 1000, 1000, 500, 500),   # ATM cluster (atm + step)
        _row(24300, 1000, 1000, 10, 10),     # OTM (small)
        _row(24400, 1000, 1000, 10, 10),     # OTM (small)
    ]
    out = compute_strike_rotation_features(
        active_strike_history=[
            (now - 300, [_row(24100, 1000, 1000)]),  # baseline
            (now - 1, rows),
        ],
        atm_strike=24100,
        strike_step=50,
        now_ts=now,
    )
    # atm = 500+500+800+800+500+500 = 3600
    # otm = 10+10+10+10 = 40
    assert out["atm_to_otm_flow_ratio"] == pytest.approx(40.0 / 3600.0)
    assert out["atm_to_otm_flow_ratio"] < 1.0


def test_otm_heavy_flow_ratio_greater_than_one():
    """OI change concentrated at OTM strikes → ratio > 1 (conviction breakout)."""
    now = 1_000_000.0
    rows = [
        _row(24050, 1000, 1000, 10, 10),     # ATM cluster, small
        _row(24100, 1000, 1000, 20, 20),     # ATM strike, small
        _row(24150, 1000, 1000, 10, 10),     # ATM cluster, small
        _row(24300, 1000, 1000, 500, 500),   # OTM, large
        _row(24400, 1000, 1000, 500, 500),   # OTM, large
    ]
    out = compute_strike_rotation_features(
        active_strike_history=[
            (now - 300, [_row(24100, 1000, 1000)]),
            (now - 1, rows),
        ],
        atm_strike=24100,
        strike_step=50,
        now_ts=now,
    )
    # atm = 10+10+20+20+10+10 = 80
    # otm = 500+500+500+500 = 2000
    assert out["atm_to_otm_flow_ratio"] == pytest.approx(2000.0 / 80.0)
    assert out["atm_to_otm_flow_ratio"] > 1.0


def test_atm_denominator_zero_yields_nan_ratio():
    """All OI change at OTM only, ATM cluster has zero change → ratio NaN."""
    now = 1_000_000.0
    rows = [
        _row(24050, 1000, 1000, 0, 0),       # ATM cluster — no change
        _row(24100, 1000, 1000, 0, 0),       # ATM strike — no change
        _row(24150, 1000, 1000, 0, 0),       # ATM cluster — no change
        _row(24300, 1000, 1000, 500, 500),   # OTM
        _row(24400, 1000, 1000, 500, 500),   # OTM
    ]
    out = compute_strike_rotation_features(
        active_strike_history=[
            (now - 300, [_row(24100, 1000, 1000)]),
            (now - 1, rows),
        ],
        atm_strike=24100,
        strike_step=50,
        now_ts=now,
    )
    assert _nan(out["atm_to_otm_flow_ratio"])


def test_uses_absolute_value_of_oi_change():
    """Negative OI change (unwinding) still contributes positively to flow magnitude."""
    now = 1_000_000.0
    rows = [
        _row(24050, 1000, 1000, -200, -200),  # ATM cluster — unwinding
        _row(24100, 1000, 1000, 100, 100),    # ATM — building
        _row(24150, 1000, 1000, -100, -100),  # ATM cluster — unwinding
        _row(24300, 1000, 1000, -50, -50),    # OTM — unwinding
    ]
    out = compute_strike_rotation_features(
        active_strike_history=[
            (now - 300, [_row(24100, 1000, 1000)]),
            (now - 1, rows),
        ],
        atm_strike=24100,
        strike_step=50,
        now_ts=now,
    )
    # atm = |−200|+|−200|+|100|+|100|+|−100|+|−100| = 800
    # otm = |−50|+|−50| = 100
    assert out["atm_to_otm_flow_ratio"] == pytest.approx(100.0 / 800.0)


# ══════════════════════════════════════════════════════════════════════════════
# Edge cases
# ══════════════════════════════════════════════════════════════════════════════


def test_empty_current_snapshot_yields_all_nan():
    """Latest history entry has empty rows list → all three NaN."""
    now = 1_000_000.0
    out = compute_strike_rotation_features(
        active_strike_history=[(now - 1, [])],
        atm_strike=24100,
        strike_step=50,
        now_ts=now,
    )
    assert _nan(out["active_strike_shift_direction"])
    assert _nan(out["active_strike_shift_velocity"])
    assert _nan(out["atm_to_otm_flow_ratio"])
