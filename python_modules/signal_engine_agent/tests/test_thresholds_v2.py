"""Tests for decide_action_v2 — Wave 1 deterministic gate."""

from __future__ import annotations

from pathlib import Path

import pytest

from signal_engine_agent.thresholds import (
    SignalAction,
    Thresholds,
    V2Thresholds,
    decide_action_v2,
)


def _passing_preds(prob: float = 0.80, rr: float = 2.0, pct: float = 70.0) -> dict:
    """Predictions that satisfy the existing 3-condition gate."""
    return {
        "direction_prob_30s": prob,
        "risk_reward_ratio_30s": rr,
        "upside_percentile_30s": pct,
        "max_upside_30s": 5.0,
        "max_drawdown_30s": -3.0,
    }


# ── Backward compatibility: passes when v2 inputs absent ─────────────────


def test_v2_passes_when_no_extra_inputs():
    """All v2 inputs None → behaves exactly like decide_action."""
    sig = decide_action_v2(_passing_preds(), Thresholds(), ce_ltp=100, pe_ltp=100)
    assert sig.gate_passed
    assert sig.action == "LONG_CE"


# ── C4: regime ────────────────────────────────────────────────────────────


def test_v2_blocks_when_regime_is_reversal():
    sig = decide_action_v2(
        _passing_preds(), Thresholds(), ce_ltp=100, pe_ltp=100,
        regime="REVERSAL", momentum_persistence_ticks=10,
    )
    assert not sig.gate_passed
    assert "C4_regime" in sig.gate_reasons


def test_v2_passes_when_regime_is_trend():
    sig = decide_action_v2(
        _passing_preds(), Thresholds(), ce_ltp=100, pe_ltp=100,
        regime="TREND", momentum_persistence_ticks=10,
    )
    assert sig.gate_passed


def test_v2_passes_when_regime_is_none():
    """Missing regime fails-open."""
    sig = decide_action_v2(
        _passing_preds(), Thresholds(), ce_ltp=100, pe_ltp=100,
        regime=None, momentum_persistence_ticks=10,
    )
    assert sig.gate_passed


# ── C5: momentum persistence ──────────────────────────────────────────────


def test_v2_blocks_when_momentum_below_threshold():
    sig = decide_action_v2(
        _passing_preds(), Thresholds(), ce_ltp=100, pe_ltp=100,
        regime="TREND", momentum_persistence_ticks=3,  # < 5
    )
    assert not sig.gate_passed
    assert "C5_momentum" in sig.gate_reasons


def test_v2_passes_when_momentum_at_threshold():
    sig = decide_action_v2(
        _passing_preds(), Thresholds(), ce_ltp=100, pe_ltp=100,
        regime="TREND", momentum_persistence_ticks=5,
    )
    assert sig.gate_passed


def test_v2_passes_when_momentum_is_nan():
    """Missing momentum fails-open (warm-up period)."""
    sig = decide_action_v2(
        _passing_preds(), Thresholds(), ce_ltp=100, pe_ltp=100,
        regime="TREND", momentum_persistence_ticks=float("nan"),
    )
    assert sig.gate_passed


# ── C6: S/R clearance ─────────────────────────────────────────────────────


def test_v2_blocks_long_ce_at_day_high():
    """LONG_CE within 0.05% of day high → reject."""
    sig = decide_action_v2(
        _passing_preds(prob=0.80), Thresholds(), ce_ltp=100, pe_ltp=100,
        regime="TREND", momentum_persistence_ticks=10,
        distance_to_day_high_pct=-0.02,  # 0.02% below high
    )
    assert not sig.gate_passed
    assert "C6_sr_resistance" in sig.gate_reasons


def test_v2_passes_long_ce_well_below_day_high():
    sig = decide_action_v2(
        _passing_preds(prob=0.80), Thresholds(), ce_ltp=100, pe_ltp=100,
        regime="TREND", momentum_persistence_ticks=10,
        distance_to_day_high_pct=-0.50,  # 0.5% below high — clear
    )
    assert sig.gate_passed


def test_v2_blocks_long_pe_at_day_low():
    """LONG_PE near day low → reject."""
    sig = decide_action_v2(
        _passing_preds(prob=0.20), Thresholds(), ce_ltp=100, pe_ltp=100,
        regime="TREND", momentum_persistence_ticks=10,
        distance_to_day_low_pct=0.02,  # 0.02% above low
    )
    assert not sig.gate_passed
    assert "C6_sr_support" in sig.gate_reasons


def test_v2_passes_long_pe_well_above_day_low():
    sig = decide_action_v2(
        _passing_preds(prob=0.20), Thresholds(), ce_ltp=100, pe_ltp=100,
        regime="TREND", momentum_persistence_ticks=10,
        distance_to_day_low_pct=0.50,
    )
    assert sig.gate_passed


def test_v2_passes_when_distance_is_nan():
    """Missing S/R distance fails-open."""
    sig = decide_action_v2(
        _passing_preds(prob=0.80), Thresholds(), ce_ltp=100, pe_ltp=100,
        regime="TREND", momentum_persistence_ticks=10,
        distance_to_day_high_pct=float("nan"),
    )
    assert sig.gate_passed


# ── Multiple failures stack ──────────────────────────────────────────────


def test_v2_stacks_failure_reasons():
    """All 3 v2 conditions failing → all 3 reasons reported."""
    sig = decide_action_v2(
        _passing_preds(prob=0.80), Thresholds(), ce_ltp=100, pe_ltp=100,
        regime="REVERSAL", momentum_persistence_ticks=2,
        distance_to_day_high_pct=-0.01,
    )
    assert not sig.gate_passed
    assert "C4_regime" in sig.gate_reasons
    assert "C5_momentum" in sig.gate_reasons
    assert "C6_sr_resistance" in sig.gate_reasons


def test_v2_preserves_base_failures():
    """If base gate (C1/C2/C3) fails, v2 returns base unchanged."""
    sig = decide_action_v2(
        _passing_preds(prob=0.55),  # below 0.65 — C1 fails
        Thresholds(), ce_ltp=100, pe_ltp=100,
        regime="REVERSAL",  # would also fail C4 but base failed first
    )
    assert not sig.gate_passed
    assert "C1_prob" in sig.gate_reasons
    # v2 conditions should not run when base fails
    assert "C4_regime" not in sig.gate_reasons


# ── V2Thresholds tunable ─────────────────────────────────────────────────


def test_custom_v2_thresholds_momentum():
    custom = V2Thresholds(momentum_persistence_min=10)
    sig = decide_action_v2(
        _passing_preds(), Thresholds(), v2_thresholds=custom,
        ce_ltp=100, pe_ltp=100,
        regime="TREND", momentum_persistence_ticks=8,  # OK with default 5, fails with 10
    )
    assert not sig.gate_passed
    assert "C5_momentum" in sig.gate_reasons


def test_custom_v2_thresholds_sr_clearance():
    custom = V2Thresholds(sr_clearance_pct=0.20)  # require 0.2% clearance
    sig = decide_action_v2(
        _passing_preds(prob=0.80), Thresholds(), v2_thresholds=custom,
        ce_ltp=100, pe_ltp=100,
        regime="TREND", momentum_persistence_ticks=10,
        distance_to_day_high_pct=-0.10,  # 0.1% below high — fails 0.2% clearance
    )
    assert not sig.gate_passed
    assert "C6_sr_resistance" in sig.gate_reasons


# ── Per-instrument config loader ─────────────────────────────────────────


def test_load_thresholds_v2_reads_v2_block(tmp_path):
    import json
    from signal_engine_agent.thresholds import load_thresholds_v2

    cfg = {
        "prob_min": 0.60, "rr_min": 1.4, "upside_percentile_min": 55.0,
        "v2": {
            "momentum_persistence_min": 3,
            "sr_clearance_pct": 0.02,
            "forbidden_regimes": ["REVERSAL"],
        },
    }
    (tmp_path / "default.json").write_text(json.dumps(cfg))
    (tmp_path / "nifty50.json").write_text(json.dumps(cfg))

    base, v2 = load_thresholds_v2("nifty50", tmp_path)
    assert base.prob_min == 0.60
    assert v2.momentum_persistence_min == 3
    assert v2.sr_clearance_pct == 0.02
    assert v2.forbidden_regimes == ("REVERSAL",)


def test_load_thresholds_v2_falls_back_to_defaults_when_v2_missing(tmp_path):
    import json
    from signal_engine_agent.thresholds import load_thresholds_v2

    cfg = {"prob_min": 0.65, "rr_min": 1.5, "upside_percentile_min": 60.0}
    (tmp_path / "default.json").write_text(json.dumps(cfg))

    base, v2 = load_thresholds_v2("nifty50", tmp_path)  # uses default.json
    assert v2.momentum_persistence_min == 5  # V2Thresholds default
    assert v2.sr_clearance_pct == 0.05
    assert v2.forbidden_regimes == ("REVERSAL",)


def test_load_thresholds_returns_only_base():
    """Backward-compat check: existing callers see Thresholds, not a tuple."""
    from signal_engine_agent.thresholds import Thresholds, load_thresholds
    base = load_thresholds("nifty50", Path("config/sea_thresholds"))
    assert isinstance(base, Thresholds)
