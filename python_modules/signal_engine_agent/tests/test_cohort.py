"""
tests/test_cohort.py — T33 D56 cohort classifier tests.

Verifies the window-based head -> cohort mapping that drives:
  * T41's ``head_type`` column on every prediction row
  * The ``cohort`` field on every emitted signal JSON line
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from signal_engine_agent.cohort import (
    COHORT_MULTI_DAY_SWING,
    COHORT_SCALP,
    COHORT_SWING,
    COHORT_TREND,
    build_head_type_map,
    classify_head,
    classify_window_seconds,
)


# ── Pure-window classifier ──────────────────────────────────────────────────


def test_scalp_window_30s():
    assert classify_window_seconds(30) == COHORT_SCALP


def test_scalp_window_300s_boundary():
    """300s is the inclusive upper bound for scalp."""
    assert classify_window_seconds(300) == COHORT_SCALP


def test_trend_window_900s_boundary():
    """900s is the inclusive lower bound for trend."""
    assert classify_window_seconds(900) == COHORT_TREND


def test_trend_window_1800s_boundary():
    assert classify_window_seconds(1800) == COHORT_TREND


def test_swing_window_3600s_boundary():
    assert classify_window_seconds(3600) == COHORT_SWING


def test_swing_window_7200s_boundary():
    assert classify_window_seconds(7200) == COHORT_SWING


def test_multi_day_swing_above_7200():
    assert classify_window_seconds(10_800) == COHORT_MULTI_DAY_SWING


def test_gap_between_scalp_and_trend_returns_none():
    """600s falls between scalp (≤300) and trend (≥900) — not currently
    used by any head, but a future-schema 600s head would surface as
    None and force an explicit cohort decision rather than be
    silently mis-bucketed."""
    assert classify_window_seconds(600) is None


def test_zero_or_negative_returns_none():
    assert classify_window_seconds(0) is None
    assert classify_window_seconds(-1) is None


# ── Head-name classifier ────────────────────────────────────────────────────


def test_classify_head_scalp_30s():
    assert classify_head("direction_30s") == COHORT_SCALP
    assert classify_head("max_upside_30s") == COHORT_SCALP


def test_classify_head_scalp_60s_wave2():
    assert classify_head("direction_60s") == COHORT_SCALP
    assert classify_head("breakout_in_60s") == COHORT_SCALP


def test_classify_head_scalp_300s_boundary():
    assert classify_head("max_drawdown_300s") == COHORT_SCALP
    assert classify_head("exit_signal_300s") == COHORT_SCALP


def test_classify_head_trend_900s():
    """T3-style trend heads aren't in _HEAD_PREDS yet but the
    classifier must already produce 'trend' for them when they
    join the eval list."""
    assert classify_head("max_upside_900s") == COHORT_TREND


def test_classify_head_embedded_window():
    """direction_30s_magnitude has the window in the middle."""
    assert classify_head("direction_30s_magnitude") == COHORT_SCALP


def test_classify_head_non_target_returns_none():
    """Names with no window suffix have no cohort."""
    assert classify_head("not_a_target") is None
    assert classify_head("foo_bar_baz") is None


# ── build_head_type_map ─────────────────────────────────────────────────────


def test_build_head_type_map_omits_unclassifiable():
    """Heads whose cohort is None are omitted from the map so callers'
    .get(name) returns None cleanly."""
    m = build_head_type_map([
        "direction_30s",        # scalp
        "max_upside_900s",      # trend
        "max_upside_3600s",     # swing
        "not_a_target",         # None -> omitted
    ])
    assert m["direction_30s"] == COHORT_SCALP
    assert m["max_upside_900s"] == COHORT_TREND
    assert m["max_upside_3600s"] == COHORT_SWING
    assert "not_a_target" not in m


def test_build_head_type_map_matches_engine_head_list():
    """End-to-end smoke: the engine builds this map from _HEAD_PREDS.

    Current production heads cover BOTH scalp (≤300s windows) AND
    trend (900s windows for ``max_upside_900s`` / ``max_drawdown_900s``).
    The trend pair feeds the legacy filter's swing-target fallback at
    engine.py and the V2 gate's longer-window risk-reward checks; they
    aren't scalp signals but ARE scalp inputs.

    When T29 introduces swing or multi-day-swing heads, this assertion
    should grow to expect those cohorts too — surfaces the schema
    change loudly rather than silently.
    """
    from signal_engine_agent.engine import _HEAD_PREDS
    gate_keys = [gate_key for gate_key, _ in _HEAD_PREDS]
    m = build_head_type_map(gate_keys)
    cohorts_present = set(m.values())
    # Today: scalp + trend only.
    assert cohorts_present == {COHORT_SCALP, COHORT_TREND}, (
        f"Unexpected cohort set in engine heads: {cohorts_present}. "
        f"If T29 added a new cohort family, extend this assertion."
    )
    # Counts: the bulk are scalp; trend is just the two 900s heads.
    scalp_count = sum(1 for v in m.values() if v == COHORT_SCALP)
    trend_count = sum(1 for v in m.values() if v == COHORT_TREND)
    assert scalp_count >= 20, f"scalp head count dropped: {scalp_count}"
    assert trend_count == 2, f"trend head count moved: {trend_count}"
