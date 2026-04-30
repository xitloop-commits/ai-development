"""
tests/test_thresholds.py — Phase E5 unit tests for the SEA 3-condition gate.

Locks the canonical filter pipeline introduced in Phase D4 and shipped in
Phase E5. The plan requires the 8 corner cases (each combination of the
three conditions met/unmet) to be enumerated; we add explicit checks for
the spec's `≥` semantics, the missing-prediction fail-closed branch, and
the per-instrument JSON loader fallback.

Run: python -m pytest python_modules/signal_engine_agent/tests/test_thresholds.py -v
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent  # python_modules/
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from signal_engine_agent.thresholds import (
    DEFAULT_DIRECTION_PROB_THRESHOLD,
    DEFAULT_MIN_RISK_REWARD,
    DEFAULT_MIN_UPSIDE_PERCENTILE,
    SignalAction,
    Thresholds,
    decide_action,
    load_thresholds,
)


def _preds(prob: float, rr: float, pct: float, **extra) -> dict:
    """Builds a minimal valid predictions dict and lets tests override
    individual fields via kwargs."""
    base = {
        "direction_prob_30s":     prob,
        "risk_reward_ratio_30s":  rr,
        "upside_percentile_30s":  pct,
        # Generous defaults for TP/SL pricing; corner-case tests don't care
        "max_upside_30s":         5.0,
        "max_drawdown_30s":       -3.0,
    }
    base.update(extra)
    return base


# ── 8 corner cases (cartesian product of 3 conditions met/unmet) ──────────
#
# Naming: {C1}{C2}{C3} where each is P(ass) or F(ail).
# All cases evaluate on the BULLISH side (prob > 0.5) so the resulting
# action when the gate passes is LONG_CE / GO_CALL.

@pytest.mark.parametrize(
    "name, prob, rr, pct, expect_pass, expect_reasons",
    [
        ("PPP_all_pass",  0.70, 2.0, 70.0, True,  []),
        ("FPP_C1_only",   0.60, 2.0, 70.0, False, ["C1_prob"]),
        ("PFP_C2_only",   0.70, 1.2, 70.0, False, ["C2_rr"]),
        ("PPF_C3_only",   0.70, 2.0, 50.0, False, ["C3_pct"]),
        ("FFP_C1_C2",     0.60, 1.2, 70.0, False, ["C1_prob", "C2_rr"]),
        ("FPF_C1_C3",     0.60, 2.0, 50.0, False, ["C1_prob", "C3_pct"]),
        ("PFF_C2_C3",     0.70, 1.2, 50.0, False, ["C2_rr", "C3_pct"]),
        ("FFF_all_fail",  0.60, 1.2, 50.0, False, ["C1_prob", "C2_rr", "C3_pct"]),
    ],
)
def test_eight_corner_cases(name, prob, rr, pct, expect_pass, expect_reasons):
    sig = decide_action(_preds(prob, rr, pct), Thresholds(),
                        ce_ltp=100.0, pe_ltp=100.0)
    assert sig.gate_passed is expect_pass, f"{name}: gate_passed mismatch"
    assert sig.gate_reasons == expect_reasons, f"{name}: reasons mismatch"
    if expect_pass:
        assert sig.action == "LONG_CE"
        assert sig.direction == "GO_CALL"
        assert sig.entry > 0
    else:
        assert sig.action == "WAIT"
        assert sig.direction == "WAIT"
        assert sig.entry == 0.0


# ── Edge-of-threshold semantics (spec mandates ≥, not >) ──────────────────

def test_exactly_at_threshold_passes():
    """All three conditions exactly equal to the threshold must PASS
    (spec §3 Phase 3: 'edge cases: exactly at threshold values
    (≥ semantics, not >)')."""
    sig = decide_action(
        _preds(0.65, 1.5, 60.0),  # all three knife-edge values
        Thresholds(prob_min=0.65, rr_min=1.5, upside_percentile_min=60.0),
        ce_ltp=100.0, pe_ltp=100.0,
    )
    assert sig.gate_passed is True
    assert sig.action == "LONG_CE"


def test_just_below_threshold_fails():
    sig = decide_action(
        _preds(0.6499, 1.4999, 59.9999),
        Thresholds(prob_min=0.65, rr_min=1.5, upside_percentile_min=60.0),
        ce_ltp=100.0, pe_ltp=100.0,
    )
    assert sig.gate_passed is False
    # All three should fail — order doesn't matter for the set, but our
    # implementation appends in C1, C2, C3 order so we can assert exact list.
    assert sig.gate_reasons == ["C1_prob", "C2_rr", "C3_pct"]


# ── Direction selection ───────────────────────────────────────────────────

def test_bullish_passes_to_go_call():
    sig = decide_action(_preds(0.80, 2.0, 70.0), Thresholds(),
                        ce_ltp=100.0, pe_ltp=100.0)
    assert sig.direction == "GO_CALL"
    assert sig.action == "LONG_CE"


def test_bearish_passes_to_go_put():
    """Symmetric: dir_prob = 0.20 means strong PUT. prob = max(0.2, 0.8) = 0.8
    should pass C1; the side is then chosen by which side of 0.5
    `direction_prob_30s` sits on."""
    sig = decide_action(_preds(0.20, 2.0, 70.0), Thresholds(),
                        ce_ltp=100.0, pe_ltp=100.0)
    assert sig.direction == "GO_PUT"
    assert sig.action == "LONG_PE"


def test_dir_prob_exactly_half_routes_to_put():
    """At dir_prob == 0.5 the spec says `> 0.5 → GO_CALL`, so 0.5 falls
    to GO_PUT. (In practice prob = max(0.5, 0.5) = 0.5 < 0.65 so the gate
    fails C1 — but if someone tunes prob_min = 0.5 the side selection
    still has to be deterministic.)"""
    sig = decide_action(_preds(0.50, 2.0, 70.0),
                        Thresholds(prob_min=0.5),  # gate now passes
                        ce_ltp=100.0, pe_ltp=100.0)
    assert sig.gate_passed is True
    assert sig.direction == "GO_PUT"


# ── TP / SL pricing ───────────────────────────────────────────────────────

def test_swing_window_priority_900_over_300_over_30():
    """Per spec, `decide_action` prefers max_upside_900s > max_upside_300s
    > max_upside_30s for TP. Verify that finite-only takes the longest
    available window."""
    preds = _preds(0.80, 2.0, 70.0,
                   max_upside_30s=1.0,
                   max_upside_300s=2.0,
                   max_upside_900s=3.0,
                   max_drawdown_30s=-1.0,
                   max_drawdown_300s=-2.0,
                   max_drawdown_900s=-3.0)
    sig = decide_action(preds, Thresholds(), ce_ltp=100.0, pe_ltp=100.0)
    assert sig.tp == pytest.approx(103.0)  # 100 + 3.0 (900s)
    assert sig.sl == pytest.approx(97.0)   # 100 - 3.0 (900s)


def test_swing_window_falls_back_when_long_window_nan():
    nan = float("nan")
    preds = _preds(0.80, 2.0, 70.0,
                   max_upside_30s=1.0,
                   max_upside_300s=2.0,
                   max_upside_900s=nan,        # falls back to 300s
                   max_drawdown_30s=-1.0,
                   max_drawdown_300s=nan,      # falls back to 30s
                   max_drawdown_900s=nan)
    sig = decide_action(preds, Thresholds(), ce_ltp=100.0, pe_ltp=100.0)
    assert sig.tp == pytest.approx(102.0)  # 300s
    assert sig.sl == pytest.approx(99.0)   # 30s


def test_missing_ltp_yields_wait_with_passed_gate():
    """Gate passes but we cannot price the trade because the leg LTP is
    None. Spec-compliant behaviour: action=WAIT, gate_passed=True,
    direction populated for the diagnostic stream."""
    sig = decide_action(_preds(0.80, 2.0, 70.0), Thresholds(),
                        ce_ltp=None, pe_ltp=None)
    assert sig.gate_passed is True
    assert sig.direction == "GO_CALL"
    assert sig.action == "WAIT"
    assert sig.entry == 0.0


# ── Fail-closed: missing required predictions ─────────────────────────────

def test_missing_prob_yields_missing_prediction_reason():
    preds = _preds(0.80, 2.0, 70.0)
    del preds["direction_prob_30s"]
    sig = decide_action(preds, Thresholds(), ce_ltp=100.0, pe_ltp=100.0)
    assert sig.gate_passed is False
    assert sig.gate_reasons == ["MISSING_PREDICTION"]
    assert sig.action == "WAIT"


def test_nan_rr_yields_missing_prediction_reason():
    sig = decide_action(_preds(0.80, float("nan"), 70.0), Thresholds(),
                        ce_ltp=100.0, pe_ltp=100.0)
    assert sig.gate_passed is False
    assert sig.gate_reasons == ["MISSING_PREDICTION"]


# ── Loader: per-instrument override + default fallback ────────────────────

def test_load_thresholds_falls_back_to_default(tmp_path: Path):
    cfg_dir = tmp_path / "sea_thresholds"
    cfg_dir.mkdir()
    (cfg_dir / "default.json").write_text(json.dumps({
        "prob_min": 0.65, "rr_min": 1.5, "upside_percentile_min": 60.0,
    }), encoding="utf-8")
    th = load_thresholds("nifty50", cfg_dir)
    assert th.prob_min == 0.65
    assert th.rr_min == 1.5
    assert th.upside_percentile_min == 60.0


def test_load_thresholds_prefers_instrument_specific(tmp_path: Path):
    cfg_dir = tmp_path / "sea_thresholds"
    cfg_dir.mkdir()
    (cfg_dir / "default.json").write_text(json.dumps({
        "prob_min": 0.65, "rr_min": 1.5, "upside_percentile_min": 60.0,
    }), encoding="utf-8")
    (cfg_dir / "banknifty.json").write_text(json.dumps({
        "prob_min": 0.70, "rr_min": 1.8, "upside_percentile_min": 65.0,
    }), encoding="utf-8")
    th = load_thresholds("banknifty", cfg_dir)
    assert th.prob_min == 0.70
    assert th.rr_min == 1.8
    assert th.upside_percentile_min == 65.0


def test_load_thresholds_raises_when_neither_exists(tmp_path: Path):
    cfg_dir = tmp_path / "sea_thresholds"
    cfg_dir.mkdir()
    with pytest.raises(FileNotFoundError, match="No SEA thresholds"):
        load_thresholds("nifty50", cfg_dir)


def test_default_thresholds_match_spec_constants():
    """Belt-and-braces guard: the module-level DEFAULT_* constants are the
    knife-edge values from D4 spec. If anyone tweaks them, this fails."""
    assert DEFAULT_DIRECTION_PROB_THRESHOLD == 0.65
    assert DEFAULT_MIN_RISK_REWARD == 1.5
    assert DEFAULT_MIN_UPSIDE_PERCENTILE == 60.0


def test_shipped_default_json_matches_spec():
    """The repo ships `config/sea_thresholds/default.json`; verify it
    matches the spec's locked values so a fresh checkout boots correctly."""
    repo_root = _PKG.parent  # ai-development-ui-refactoring/
    default = repo_root / "config" / "sea_thresholds" / "default.json"
    if not default.exists():
        pytest.skip(f"shipped default.json not present at {default}")
    raw = json.loads(default.read_text(encoding="utf-8"))
    assert raw["prob_min"] == 0.65
    assert raw["rr_min"] == 1.5
    assert raw["upside_percentile_min"] == 60.0
