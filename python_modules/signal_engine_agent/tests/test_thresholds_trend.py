"""
Tests for the trend-cohort gate (`decide_action_trend`).

Trend signals fire on 30-min horizon predictions:
  trend_direction_1800s, trend_continues_1800s,
  trend_breakout_imminent_1800s (optional),
  trend_magnitude_1800s, trend_max_drawdown_1800s (for TP/SL).

Disabled by default — the `enabled` flag must be flipped via JSON config
before any signal fires.
"""
from __future__ import annotations

import pytest

from signal_engine_agent.thresholds import (
    TrendThresholds,
    decide_action_trend,
)


def _preds(dir_prob=0.75, continues=0.70, breakout=0.55,
           mag=40.0, dd=30.0, down=None):
    p = {
        "trend_direction_1800s": dir_prob,
        "trend_continues_1800s": continues,
        "trend_breakout_imminent_1800s": breakout,
        "trend_magnitude_1800s": mag,
        "trend_max_drawdown_1800s": dd,
    }
    # Part B: include the down head only when a test opts in — absent → the
    # gate uses the legacy up-only fallback (pre-Part-B model behaviour).
    if down is not None:
        p["trend_direction_down_1800s"] = down
    return p


# ── Part B: down head → symmetric puts ──────────────────────────────────


def test_down_head_fires_put_on_down_conviction():
    # Down head confident (0.65 > up 0.30) + calls_only=false → LONG_PE priced
    # off the PE leg. This is the payoff: puts fire on genuine down-conviction.
    th = TrendThresholds(enabled=True, calls_only=False)
    sig = decide_action_trend(_preds(dir_prob=0.30, down=0.65), th, ce_ltp=100, pe_ltp=80)
    assert sig.gate_passed
    assert sig.action == "LONG_PE"
    assert sig.direction == "GO_PUT"
    # priced off pe_ltp=80: mag 40*0.5=20 → tp=100 ; dd 30*0.5=15 → sl=65
    assert sig.tp == pytest.approx(100.0)
    assert sig.sl == pytest.approx(65.0)


def test_down_head_still_suppressed_when_calls_only():
    # Even a confident down head is blocked while calls_only=True (safety /
    # pre-validation).
    th = TrendThresholds(enabled=True, calls_only=True)
    sig = decide_action_trend(_preds(dir_prob=0.30, down=0.65), th, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "TREND_CALLS_ONLY" in sig.gate_reasons


def test_up_head_wins_when_higher_than_down():
    # up 0.62 >= down 0.20 → CALL (down head present but weaker).
    th = TrendThresholds(enabled=True, calls_only=False)
    sig = decide_action_trend(_preds(dir_prob=0.62, down=0.20), th, ce_ltp=100, pe_ltp=80)
    assert sig.gate_passed
    assert sig.action == "LONG_CE"


def test_neither_head_confident_waits():
    # up 0.40, down 0.50 — both below dir_prob_min 0.60 → WAIT T1.
    th = TrendThresholds(enabled=True, calls_only=False)
    sig = decide_action_trend(_preds(dir_prob=0.40, down=0.50), th, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "T1_dir_prob" in sig.gate_reasons


# ── Disabled-by-default behaviour ────────────────────────────────────────


def test_disabled_by_default_returns_wait():
    """Default TrendThresholds.enabled is False → no trend signal fires."""
    sig = decide_action_trend(_preds(), ce_ltp=100, pe_ltp=80)
    assert sig.action == "WAIT"
    assert "TREND_DISABLED" in sig.gate_reasons
    assert not sig.gate_passed


def test_explicit_disabled_returns_wait():
    th = TrendThresholds(enabled=False)
    sig = decide_action_trend(_preds(), th, ce_ltp=100, pe_ltp=80)
    assert sig.action == "WAIT"
    assert "TREND_DISABLED" in sig.gate_reasons


# ── Happy path ──────────────────────────────────────────────────────────


def test_all_conditions_pass_emits_long_ce():
    th = TrendThresholds(enabled=True)
    sig = decide_action_trend(_preds(dir_prob=0.75), th, ce_ltp=100, pe_ltp=80)
    assert sig.gate_passed
    assert sig.action == "LONG_CE"
    assert sig.direction == "GO_CALL"
    # mag=40, scale=0.5 → tp_dist=20 → tp=120
    # dd=30, scale=0.5 → sl_dist=15 → sl=85
    assert sig.tp == pytest.approx(120.0)
    assert sig.sl == pytest.approx(85.0)


def test_low_dir_prob_suppressed_when_calls_only():
    # Default calls_only=True: the up-only direction head can't reliably call
    # downs, so a put-side signal is suppressed (Part A). Part B's down head lifts this.
    th = TrendThresholds(enabled=True)
    sig = decide_action_trend(_preds(dir_prob=0.25), th, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert sig.direction == "GO_PUT"
    assert "TREND_CALLS_ONLY" in sig.gate_reasons


def test_low_dir_prob_emits_long_pe_when_calls_only_false():
    # With calls_only disabled (Part B, real down head present), a put fires.
    th = TrendThresholds(enabled=True, calls_only=False)
    sig = decide_action_trend(_preds(dir_prob=0.25), th, ce_ltp=100, pe_ltp=80)
    assert sig.gate_passed
    assert sig.action == "LONG_PE"
    assert sig.direction == "GO_PUT"


# ── Per-condition failure ──────────────────────────────────────────────


def test_t1_direction_below_threshold():
    th = TrendThresholds(enabled=True, dir_prob_min=0.65)
    sig = decide_action_trend(_preds(dir_prob=0.55), th, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "T1_dir_prob" in sig.gate_reasons


def test_t2_continues_below_threshold():
    th = TrendThresholds(enabled=True, continues_min=0.60)
    sig = decide_action_trend(_preds(continues=0.50), th, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "T2_continues" in sig.gate_reasons


def test_t3_breakout_only_enforced_when_min_positive():
    """Default breakout_min=0 → check is a no-op."""
    th = TrendThresholds(enabled=True)  # breakout_min defaults to 0
    sig = decide_action_trend(_preds(breakout=0.10), th, ce_ltp=100, pe_ltp=80)
    assert sig.gate_passed  # low breakout doesn't fail when min=0


def test_t3_breakout_enforced_when_min_positive():
    th = TrendThresholds(enabled=True, breakout_min=0.50)
    sig = decide_action_trend(_preds(breakout=0.30), th, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "T3_breakout" in sig.gate_reasons


# ── Missing predictions ────────────────────────────────────────────────


def test_missing_direction_returns_wait():
    th = TrendThresholds(enabled=True)
    preds = _preds()
    preds["trend_direction_1800s"] = None
    sig = decide_action_trend(preds, th, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "MISSING_TREND_PREDICTION" in sig.gate_reasons


def test_missing_continues_returns_wait():
    th = TrendThresholds(enabled=True)
    preds = _preds()
    preds["trend_continues_1800s"] = float("nan")
    sig = decide_action_trend(preds, th, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "MISSING_TREND_PREDICTION" in sig.gate_reasons


def test_missing_magnitude_returns_wait():
    """Gate passes but TP/SL can't be priced → returns WAIT with
    gate_passed=True so the caller can log the near-miss."""
    th = TrendThresholds(enabled=True)
    preds = _preds()
    preds["trend_magnitude_1800s"] = None
    preds.pop("trend_magnitude_900s", None)
    sig = decide_action_trend(preds, th, ce_ltp=100, pe_ltp=80)
    assert sig.action == "WAIT"
    assert sig.gate_passed  # gate ITSELF passed, just couldn't price


# ── Magnitude scaling ──────────────────────────────────────────────────


def test_magnitude_scale_halves_tp_sl_by_default():
    th = TrendThresholds(enabled=True)
    sig = decide_action_trend(_preds(mag=40, dd=20), th, ce_ltp=100, pe_ltp=80)
    # scale=0.5 → tp_dist=20, sl_dist=10
    assert sig.tp == pytest.approx(120.0)
    assert sig.sl == pytest.approx(90.0)


def test_magnitude_scale_one_keeps_raw_predictions():
    th = TrendThresholds(enabled=True, magnitude_scale=1.0)
    sig = decide_action_trend(_preds(mag=40, dd=20), th, ce_ltp=100, pe_ltp=80)
    assert sig.tp == pytest.approx(140.0)
    assert sig.sl == pytest.approx(80.0)


def test_fallback_to_900s_magnitude_when_1800s_missing():
    th = TrendThresholds(enabled=True)
    preds = _preds()
    preds["trend_magnitude_1800s"] = None
    preds["trend_magnitude_900s"] = 30.0  # fallback target
    preds["trend_max_drawdown_1800s"] = None
    preds["trend_max_drawdown_900s"] = 20.0
    sig = decide_action_trend(preds, th, ce_ltp=100, pe_ltp=80)
    assert sig.gate_passed
    # scale=0.5 → tp_dist=15, sl_dist=10
    assert sig.tp == pytest.approx(115.0)
    assert sig.sl == pytest.approx(90.0)
