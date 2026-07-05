"""Tests for the Part B scalp-trend alignment SEA filter (2026-07-05).

A scalp signal that fights a confident 30-min trend is vetoed (COUNTER_TREND);
trend-aligned scalps and neutral-trend scalps pass through untouched.
"""
from __future__ import annotations

from signal_engine_agent.thresholds import (
    SignalAction,
    apply_trend_alignment,
    trend_bias,
)

_MIN = 0.55  # dir_prob_min


def _scalp(action="LONG_CE"):
    direction = "GO_CALL" if action == "LONG_CE" else "GO_PUT"
    return SignalAction(
        action=action, direction=direction,
        entry=100.0, tp=105.0, sl=97.0, rr=2.0,
        gate_passed=True, gate_reasons=[],
    )


# ── trend_bias ───────────────────────────────────────────────────────────


def test_bias_up_when_up_head_clears():
    assert trend_bias({"trend_direction_1800s": 0.60}, _MIN) == "up"


def test_bias_down_when_down_head_clears():
    p = {"trend_direction_1800s": 0.20, "trend_direction_down_1800s": 0.62}
    assert trend_bias(p, _MIN) == "down"


def test_bias_neutral_when_neither_clears():
    p = {"trend_direction_1800s": 0.50, "trend_direction_down_1800s": 0.48}
    assert trend_bias(p, _MIN) == "neutral"


def test_bias_down_wins_when_both_clear_and_down_higher():
    p = {"trend_direction_1800s": 0.56, "trend_direction_down_1800s": 0.70}
    assert trend_bias(p, _MIN) == "down"


def test_bias_neutral_when_heads_absent():
    assert trend_bias({}, _MIN) == "neutral"


# ── apply_trend_alignment ────────────────────────────────────────────────


def test_veto_put_in_uptrend():
    p = {"trend_direction_1800s": 0.62}  # up
    out = apply_trend_alignment(_scalp("LONG_PE"), p, _MIN)
    assert out.action == "WAIT"
    assert "COUNTER_TREND" in out.gate_reasons


def test_veto_call_in_downtrend():
    p = {"trend_direction_1800s": 0.20, "trend_direction_down_1800s": 0.65}  # down
    out = apply_trend_alignment(_scalp("LONG_CE"), p, _MIN)
    assert out.action == "WAIT"
    assert "COUNTER_TREND" in out.gate_reasons


def test_allow_call_in_uptrend():
    p = {"trend_direction_1800s": 0.62}
    out = apply_trend_alignment(_scalp("LONG_CE"), p, _MIN)
    assert out.action == "LONG_CE"


def test_allow_put_in_downtrend():
    p = {"trend_direction_1800s": 0.20, "trend_direction_down_1800s": 0.65}
    out = apply_trend_alignment(_scalp("LONG_PE"), p, _MIN)
    assert out.action == "LONG_PE"


def test_neutral_trend_allows_both():
    p = {"trend_direction_1800s": 0.50, "trend_direction_down_1800s": 0.50}
    assert apply_trend_alignment(_scalp("LONG_CE"), p, _MIN).action == "LONG_CE"
    assert apply_trend_alignment(_scalp("LONG_PE"), p, _MIN).action == "LONG_PE"


def test_disabled_is_passthrough():
    p = {"trend_direction_1800s": 0.62}  # up — would veto a put
    out = apply_trend_alignment(_scalp("LONG_PE"), p, _MIN, enabled=False)
    assert out.action == "LONG_PE"


def test_non_scalp_signal_untouched():
    wait = SignalAction(action="WAIT", direction="GO_PUT", entry=0, tp=0,
                        sl=0, rr=0, gate_passed=False, gate_reasons=["C1_prob"])
    p = {"trend_direction_1800s": 0.62}
    out = apply_trend_alignment(wait, p, _MIN)
    assert out.action == "WAIT"
    assert out.gate_reasons == ["C1_prob"]  # unchanged, not COUNTER_TREND


def test_absent_trend_heads_passthrough():
    # No trend model (pre-Part-B) → neutral → scalp runs unconstrained.
    out = apply_trend_alignment(_scalp("LONG_PE"), {}, _MIN)
    assert out.action == "LONG_PE"
