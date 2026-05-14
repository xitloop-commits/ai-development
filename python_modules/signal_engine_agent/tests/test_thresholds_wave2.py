"""Tests for decide_action_wave2 — Wave 2 model-driven gate."""

from __future__ import annotations

import pytest

from signal_engine_agent.thresholds import (
    SignalAction,
    Thresholds,
    Wave2Thresholds,
    decide_action_wave2,
)


def _passing_preds(
    prob: float = 0.80,
    rr: float = 2.0,
    pct: float = 70.0,
    persists_60: float = 0.80,
    persists_300: float = 0.70,
    exit_60: float = 0.10,
) -> dict:
    """Predictions that satisfy every gate condition."""
    return {
        # Base 3-cond gate (60s window — Wave 2)
        "direction_prob_60s": prob,
        "risk_reward_ratio_60s": rr,
        "upside_percentile_60s": pct,
        # Wave 2 model outputs
        "direction_persists_60s": persists_60,
        "direction_persists_300s": persists_300,
        "exit_signal_60s": exit_60,
        # CE-leg upside/drawdown for TP/SL
        "max_upside_300s": 10.0,
        "max_drawdown_300s": 5.0,
        # PE-leg targets (Wave 2)
        "max_upside_pe_300s": 8.0,
        "max_drawdown_pe_300s": 4.0,
    }


# ── Happy path ────────────────────────────────────────────────────────────


def test_all_conditions_pass_emits_long_ce():
    sig = decide_action_wave2(_passing_preds(prob=0.80), ce_ltp=100, pe_ltp=80)
    assert sig.gate_passed
    assert sig.action == "LONG_CE"
    assert sig.direction == "GO_CALL"
    # CE TP from max_upside_300s=10: tp = 100 + 10 = 110
    assert sig.tp == pytest.approx(110.0)
    assert sig.sl == pytest.approx(95.0)


def test_all_conditions_pass_emits_long_pe_with_pe_leg_targets():
    """LONG_PE TP/SL use Wave 2 PE-leg targets directly — no first-order swap."""
    sig = decide_action_wave2(_passing_preds(prob=0.20), ce_ltp=100, pe_ltp=80)
    assert sig.gate_passed
    assert sig.action == "LONG_PE"
    assert sig.direction == "GO_PUT"
    # PE TP from max_upside_pe_300s=8 → tp = 80 + 8 = 88
    assert sig.tp == pytest.approx(88.0)
    # PE SL from max_drawdown_pe_300s=4 → sl = 80 - 4 = 76
    assert sig.sl == pytest.approx(76.0)


# ── W1: direction_persists_60s ────────────────────────────────────────────


def test_blocks_when_persists_60s_below_threshold():
    preds = _passing_preds(persists_60=0.30)
    sig = decide_action_wave2(preds, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "W1_persists_60s" in sig.gate_reasons


def test_passes_when_persists_60s_at_threshold():
    preds = _passing_preds(persists_60=0.60)
    sig = decide_action_wave2(preds, ce_ltp=100, pe_ltp=80)
    assert sig.gate_passed


def test_passes_when_persists_60s_missing_fails_open():
    """Missing prediction fails-open (NaN tolerated)."""
    preds = _passing_preds()
    del preds["direction_persists_60s"]
    sig = decide_action_wave2(preds, ce_ltp=100, pe_ltp=80)
    assert sig.gate_passed


# ── W2: direction_persists_300s ───────────────────────────────────────────


def test_blocks_when_persists_300s_below_threshold():
    preds = _passing_preds(persists_300=0.20)
    sig = decide_action_wave2(preds, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "W2_persists_300s" in sig.gate_reasons


# ── W3: exit_signal_60s ────────────────────────────────────────────────────


def test_blocks_when_exit_signal_60s_above_max():
    preds = _passing_preds(exit_60=0.80)
    sig = decide_action_wave2(preds, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "W3_exit_signal" in sig.gate_reasons


def test_passes_when_exit_signal_60s_at_threshold():
    preds = _passing_preds(exit_60=0.40)
    sig = decide_action_wave2(preds, ce_ltp=100, pe_ltp=80)
    assert sig.gate_passed


# ── Base 3-condition gate (60s window) ────────────────────────────────────


def test_base_gate_uses_60s_window():
    """direction_prob_60s, not direction_prob_30s (30s window dropped)."""
    preds = _passing_preds(prob=0.55)  # below 0.65 threshold
    sig = decide_action_wave2(preds, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "C1_prob" in sig.gate_reasons


def test_missing_base_prediction_returns_wait():
    preds = _passing_preds()
    del preds["direction_prob_60s"]
    sig = decide_action_wave2(preds, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "MISSING_PREDICTION" in sig.gate_reasons


# ── Multiple failures stack ───────────────────────────────────────────────


def test_all_three_wave2_conditions_stack():
    preds = _passing_preds(persists_60=0.30, persists_300=0.20, exit_60=0.80)
    sig = decide_action_wave2(preds, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "W1_persists_60s" in sig.gate_reasons
    assert "W2_persists_300s" in sig.gate_reasons
    assert "W3_exit_signal" in sig.gate_reasons


# ── Per-leg TP/SL precision ──────────────────────────────────────────────


def test_long_pe_with_missing_pe_targets_returns_wait_with_passed_gate():
    """Gate passes (model conviction etc.) but PE targets missing → WAIT but gate_passed=True."""
    preds = _passing_preds(prob=0.20)
    del preds["max_upside_pe_300s"]
    del preds["max_drawdown_pe_300s"]
    sig = decide_action_wave2(preds, ce_ltp=100, pe_ltp=80)
    assert sig.gate_passed
    assert sig.action == "WAIT"
    assert sig.entry == 0.0


def test_long_ce_with_missing_ltp_returns_wait_with_passed_gate():
    preds = _passing_preds(prob=0.80)
    sig = decide_action_wave2(preds, ce_ltp=None, pe_ltp=80)
    assert sig.gate_passed
    assert sig.action == "WAIT"


# ── Wave2Thresholds tunable ───────────────────────────────────────────────


def test_custom_persists_threshold_blocks_marginal_signal():
    custom = Wave2Thresholds(persists_60s_min=0.75)
    preds = _passing_preds(persists_60=0.65)  # OK with default 0.60, fails with 0.75
    sig = decide_action_wave2(preds, wave2_thresholds=custom, ce_ltp=100, pe_ltp=80)
    assert not sig.gate_passed
    assert "W1_persists_60s" in sig.gate_reasons


# ── load_thresholds_full: 4-tuple shape + wave2 config block ─────────────


def test_load_thresholds_full_returns_4_tuple(tmp_path):
    import json
    from signal_engine_agent.thresholds import load_thresholds_full

    cfg = {"prob_min": 0.65, "rr_min": 1.5, "upside_percentile_min": 60.0}
    (tmp_path / "default.json").write_text(json.dumps(cfg))

    result = load_thresholds_full("nifty50", tmp_path)
    assert len(result) == 4
    base, v2, wave2, gate_mode = result
    assert isinstance(base, Thresholds)
    assert isinstance(wave2, Wave2Thresholds)
    assert gate_mode == "current"  # default when not set


def test_load_thresholds_full_reads_wave2_block(tmp_path):
    import json
    from signal_engine_agent.thresholds import load_thresholds_full

    cfg = {
        "prob_min": 0.65, "rr_min": 1.5, "upside_percentile_min": 60.0,
        "gate_mode": "wave2",
        "wave2": {
            "persists_60s_min": 0.70,
            "persists_300s_min": 0.55,
            "exit_signal_60s_max": 0.35,
        },
    }
    (tmp_path / "default.json").write_text(json.dumps(cfg))
    (tmp_path / "nifty50.json").write_text(json.dumps(cfg))

    _, _, wave2, gate_mode = load_thresholds_full("nifty50", tmp_path)
    assert gate_mode == "wave2"
    assert wave2.persists_60s_min == 0.70
    assert wave2.persists_300s_min == 0.55
    assert wave2.exit_signal_60s_max == 0.35


def test_load_thresholds_full_wave2_defaults_when_block_absent(tmp_path):
    """gate_mode=wave2 but no wave2 block → use Wave2Thresholds defaults."""
    import json
    from signal_engine_agent.thresholds import load_thresholds_full

    cfg = {
        "prob_min": 0.65, "rr_min": 1.5, "upside_percentile_min": 60.0,
        "gate_mode": "wave2",
    }
    (tmp_path / "default.json").write_text(json.dumps(cfg))

    _, _, wave2, gate_mode = load_thresholds_full("nifty50", tmp_path)
    assert gate_mode == "wave2"
    # Defaults from Wave2Thresholds dataclass
    assert wave2.persists_60s_min == 0.60
    assert wave2.persists_300s_min == 0.50
    assert wave2.exit_signal_60s_max == 0.40


def test_load_thresholds_full_rejects_invalid_gate_mode(tmp_path):
    import json
    from signal_engine_agent.thresholds import load_thresholds_full

    cfg = {
        "prob_min": 0.65, "rr_min": 1.5, "upside_percentile_min": 60.0,
        "gate_mode": "bogus",
    }
    (tmp_path / "default.json").write_text(json.dumps(cfg))

    with pytest.raises(ValueError, match="gate_mode"):
        load_thresholds_full("nifty50", tmp_path)


def test_load_thresholds_v2_backcompat_still_3_tuple(tmp_path):
    """Existing callers using load_thresholds_v2 must continue to get a
    (Thresholds, V2Thresholds) pair, even when a wave2 block is present."""
    import json
    from signal_engine_agent.thresholds import load_thresholds_v2

    cfg = {
        "prob_min": 0.65, "rr_min": 1.5, "upside_percentile_min": 60.0,
        "wave2": {"persists_60s_min": 0.70},
    }
    (tmp_path / "default.json").write_text(json.dumps(cfg))

    result = load_thresholds_v2("nifty50", tmp_path)
    assert len(result) == 2  # NOT the new 4-tuple
