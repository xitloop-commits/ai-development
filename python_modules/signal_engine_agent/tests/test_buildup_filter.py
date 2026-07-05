"""Tests for the option-buildup veto (Part B SEA rule, 2026-07-06).

Per-leg OI change × that leg's ATM premium momentum reads fresh buildup
(resolving the write-vs-buy ambiguity); a scalp that fights a strong bias is
vetoed (COUNTER_BUILDUP). Only OI-INCREASING states vote; unwinding/covering
is neutral. Off by default.
"""
from __future__ import annotations

from signal_engine_agent.thresholds import (
    SignalAction,
    Wave2Thresholds,
    apply_buildup_filter,
    buildup_bias,
)

_CFG = Wave2Thresholds(
    buildup_filter=True, buildup_min_oi_change_pct=0.5, buildup_min_premium_mom=0.0
)


def _scalp(action="LONG_CE"):
    direction = "GO_CALL" if action == "LONG_CE" else "GO_PUT"
    return SignalAction(action=action, direction=direction, entry=100.0, tp=105.0,
                        sl=97.0, rr=2.0, gate_passed=True, gate_reasons=[])


def _row(ce_oi=0.0, ce_pm=0.0, pe_oi=0.0, pe_pm=0.0):
    return {
        "ce_oi_change_5min_pct": ce_oi, "opt_0_ce_premium_momentum": ce_pm,
        "pe_oi_change_5min_pct": pe_oi, "opt_0_pe_premium_momentum": pe_pm,
    }


# ── buildup_bias: the four quadrants ──────────────────────────────────────


def test_call_long_buildup_is_bullish():
    assert buildup_bias(_row(ce_oi=2.0, ce_pm=0.5), _CFG) == "bullish"


def test_call_writing_is_bearish():
    assert buildup_bias(_row(ce_oi=2.0, ce_pm=-0.5), _CFG) == "bearish"


def test_put_long_buildup_is_bearish():
    assert buildup_bias(_row(pe_oi=2.0, pe_pm=0.5), _CFG) == "bearish"


def test_put_writing_is_bullish():
    assert buildup_bias(_row(pe_oi=2.0, pe_pm=-0.5), _CFG) == "bullish"


def test_falling_oi_does_not_vote():
    # OI DOWN (unwinding/covering) → not fresh conviction → neutral.
    assert buildup_bias(_row(ce_oi=-3.0, ce_pm=0.9), _CFG) == "neutral"


def test_below_oi_threshold_is_neutral():
    assert buildup_bias(_row(ce_oi=0.2, ce_pm=0.9), _CFG) == "neutral"  # 0.2 < 0.5


def test_opposing_legs_cancel_to_neutral():
    # call long buildup (bullish) + put long buildup (bearish) → tie → neutral.
    assert buildup_bias(_row(ce_oi=2.0, ce_pm=0.5, pe_oi=2.0, pe_pm=0.5), _CFG) == "neutral"


def test_two_bullish_legs_agree():
    # call long buildup (bullish) + put writing (bullish) → bullish.
    assert buildup_bias(_row(ce_oi=2.0, ce_pm=0.5, pe_oi=2.0, pe_pm=-0.5), _CFG) == "bullish"


def test_empty_row_is_neutral():
    assert buildup_bias({}, _CFG) == "neutral"


# ── apply_buildup_filter ──────────────────────────────────────────────────


def test_veto_call_in_bearish_buildup():
    out = apply_buildup_filter(_scalp("LONG_CE"), _row(ce_oi=2.0, ce_pm=-0.5), _CFG)
    assert out.action == "WAIT" and "COUNTER_BUILDUP" in out.gate_reasons


def test_veto_put_in_bullish_buildup():
    out = apply_buildup_filter(_scalp("LONG_PE"), _row(ce_oi=2.0, ce_pm=0.5), _CFG)
    assert out.action == "WAIT" and "COUNTER_BUILDUP" in out.gate_reasons


def test_allow_call_in_bullish_buildup():
    out = apply_buildup_filter(_scalp("LONG_CE"), _row(ce_oi=2.0, ce_pm=0.5), _CFG)
    assert out.action == "LONG_CE"


def test_allow_put_in_bearish_buildup():
    out = apply_buildup_filter(_scalp("LONG_PE"), _row(pe_oi=2.0, pe_pm=0.5), _CFG)
    assert out.action == "LONG_PE"


def test_neutral_allows_both():
    r = _row()  # no buildup
    assert apply_buildup_filter(_scalp("LONG_CE"), r, _CFG).action == "LONG_CE"
    assert apply_buildup_filter(_scalp("LONG_PE"), r, _CFG).action == "LONG_PE"


def test_disabled_is_passthrough():
    out = apply_buildup_filter(_scalp("LONG_CE"), _row(ce_oi=2.0, ce_pm=-0.5),
                               _CFG, enabled=False)
    assert out.action == "LONG_CE"


def test_non_scalp_untouched():
    wait = SignalAction(action="WAIT", direction="GO_PUT", entry=0, tp=0, sl=0,
                        rr=0, gate_passed=False, gate_reasons=["C1_prob"])
    out = apply_buildup_filter(wait, _row(ce_oi=2.0, ce_pm=-0.5), _CFG)
    assert out.action == "WAIT" and out.gate_reasons == ["C1_prob"]
