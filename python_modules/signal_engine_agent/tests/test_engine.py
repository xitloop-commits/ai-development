"""
tests/test_engine.py — Phase E10 PR2 lock for the SEA engine helper
functions plus a single happy-path tail() smoke test.

Scope: only the pure helpers that decide trades:
    * `_pred(models, X, name)`       — single-model wrapper, NaN on miss
    * `_gather_predictions(models, X)` — batch wrapper for the gate
    * `_decide_via_gate(...)`        — thin forward to thresholds.decide_action

Plus one minimal `_tail()` happy-path test (write 3 lines → consume 3,
append 2 more → consume 2). We deliberately do NOT test file rotation,
truncation, or `run()`'s infinite loop:

    File-tail is generic plumbing borrowed from `tail -f`; integration-
    testing it brings little value vs the helpers which decide trades.
    `run()` is an infinite loop with heavy I/O — not unit-testable
    without elaborate mocking that would obscure the helpers under test.
    Mode dispatch (gate vs legacy) is not directly testable without
    `run()`; we instead lock the helpers it dispatches to.

Run: python -m pytest python_modules/signal_engine_agent/tests/test_engine.py -v
"""
from __future__ import annotations

import math
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent  # python_modules/
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import numpy as np
import pytest

from signal_engine_agent import engine as sea_engine
from signal_engine_agent.engine import (
    _decide_via_gate,
    _gather_predictions,
    _pred,
    _tail,
)
from signal_engine_agent.thresholds import SignalAction, Thresholds


# ── helpers ───────────────────────────────────────────────────────────────

def _stub_models(predictions: dict) -> MagicMock:
    """Build a fake `LoadedModels` whose `.models[name].predict(X)` returns
    a 1-element ndarray with the right scalar. Missing names → not in dict."""
    fake = MagicMock()
    fake.models = {}
    for name, val in predictions.items():
        booster = MagicMock()
        booster.predict.return_value = np.array([val])
        fake.models[name] = booster
    return fake


# ── _pred ─────────────────────────────────────────────────────────────────

def test_pred_returns_float_when_model_exists():
    models = _stub_models({"direction_30s": 0.72})
    X = np.zeros((1, 3))
    out = _pred(models, X, "direction_30s")
    assert isinstance(out, float)
    assert out == pytest.approx(0.72)


def test_pred_returns_nan_when_model_missing():
    models = _stub_models({})  # empty
    X = np.zeros((1, 3))
    out = _pred(models, X, "direction_30s")
    assert math.isnan(out)


def test_pred_calls_predict_once_with_X():
    models = _stub_models({"direction_30s": 0.5})
    X = np.array([[1.0, 2.0, 3.0]])
    _pred(models, X, "direction_30s")
    booster = models.models["direction_30s"]
    booster.predict.assert_called_once()
    # First call's first positional arg must be X
    np.testing.assert_array_equal(booster.predict.call_args.args[0], X)


def test_pred_coerces_numpy_to_float():
    """Even if predict returns numpy float, _pred must hand back a Python
    float (engine downstream code calls round())."""
    models = _stub_models({"direction_30s": np.float64(0.42)})
    X = np.zeros((1, 3))
    out = _pred(models, X, "direction_30s")
    assert type(out) is float


# ── _gather_predictions ───────────────────────────────────────────────────

_GATHER_KEYS = {
    "direction_prob_30s",
    "risk_reward_ratio_30s",
    "max_upside_30s",
    "max_drawdown_30s",
    "max_upside_300s",
    "max_drawdown_300s",
    "max_upside_900s",
    "max_drawdown_900s",
    "direction_30s_magnitude",
}


def test_gather_predictions_returns_all_expected_keys():
    models = _stub_models({})  # nothing loaded
    X = np.zeros((1, 3))
    out = _gather_predictions(models, X)
    assert set(out.keys()) == _GATHER_KEYS


def test_gather_predictions_all_nan_when_no_models():
    models = _stub_models({})
    X = np.zeros((1, 3))
    out = _gather_predictions(models, X)
    for k, v in out.items():
        assert math.isnan(v), f"{k} should be NaN, got {v!r}"


def test_gather_predictions_uses_models_for_present_targets():
    models = _stub_models({
        "direction_30s":         0.72,
        "risk_reward_ratio_30s": 2.5,
        "max_upside_30s":        4.0,
    })
    X = np.zeros((1, 3))
    out = _gather_predictions(models, X)
    assert out["direction_prob_30s"]    == pytest.approx(0.72)
    assert out["risk_reward_ratio_30s"] == pytest.approx(2.5)
    assert out["max_upside_30s"]        == pytest.approx(4.0)
    # Others remain NaN
    assert math.isnan(out["max_drawdown_30s"])
    assert math.isnan(out["max_upside_900s"])


def test_gather_predictions_remaps_direction_to_direction_prob_30s():
    """Lock the wire-name remap: model 'direction_30s' maps to
    output key 'direction_prob_30s' for the gate."""
    models = _stub_models({"direction_30s": 0.85})
    X = np.zeros((1, 3))
    out = _gather_predictions(models, X)
    assert out["direction_prob_30s"] == pytest.approx(0.85)
    assert "direction_30s" not in out


# ── _decide_via_gate ──────────────────────────────────────────────────────

def test_decide_via_gate_delegates_to_decide_action():
    """Wrapper must forward predictions, thresholds, and LTPs verbatim."""
    fake_sig = SignalAction(
        action="LONG_CE", direction="GO_CALL",
        entry=100.0, tp=105.0, sl=98.0, rr=2.0,
        gate_passed=True, gate_reasons=[],
    )
    preds = {"direction_prob_30s": 0.8, "risk_reward_ratio_30s": 2.0,
             "upside_percentile_30s": 70.0}
    th = Thresholds()

    with patch.object(sea_engine, "decide_action", return_value=fake_sig) as mock_da:
        out = _decide_via_gate(preds, th, ce_ltp=100.0, pe_ltp=99.0)

    assert out is fake_sig
    mock_da.assert_called_once_with(preds, th, ce_ltp=100.0, pe_ltp=99.0)


def test_decide_via_gate_passes_through_none_ltps():
    """LTPs may be None when the leg is missing — wrapper must not coerce."""
    fake_sig = SignalAction(
        action="WAIT", direction="GO_CALL",
        entry=0.0, tp=0.0, sl=0.0, rr=0.0,
        gate_passed=True, gate_reasons=[],
    )
    with patch.object(sea_engine, "decide_action", return_value=fake_sig) as mock_da:
        _decide_via_gate({"direction_prob_30s": 0.8,
                          "risk_reward_ratio_30s": 2.0,
                          "upside_percentile_30s": 70.0},
                         Thresholds(), ce_ltp=None, pe_ltp=None)
    mock_da.assert_called_once()
    kwargs = mock_da.call_args.kwargs
    assert kwargs["ce_ltp"] is None
    assert kwargs["pe_ltp"] is None


def test_decide_via_gate_returns_decide_action_result_unmodified():
    """Wrapper is a thin pass-through — nothing fancy should happen to
    the SignalAction on its way back."""
    expected = SignalAction(
        action="LONG_PE", direction="GO_PUT",
        entry=50.0, tp=55.0, sl=48.0, rr=2.5,
        gate_passed=True, gate_reasons=[],
    )
    with patch.object(sea_engine, "decide_action", return_value=expected):
        out = _decide_via_gate({}, Thresholds(), ce_ltp=None, pe_ltp=None)
    assert out is expected
    assert out.action == "LONG_PE"
    assert out.rr == 2.5


# ── mode dispatch sanity (delegate fns are mockable) ──────────────────────
#
# `run()` is not unit-testable (infinite loop). We instead verify that
# the functions it dispatches to (_decide_via_gate and
# legacy_filter.legacy_decide) are independently mockable and have the
# right shape. This is the closest the test suite can get without
# refactoring run() itself.

def test_decide_via_gate_is_a_module_attribute():
    """Both dispatch entry points must exist as module attrs so run()
    (and tests) can patch them."""
    assert hasattr(sea_engine, "_decide_via_gate")
    assert hasattr(sea_engine, "legacy_filter")
    assert hasattr(sea_engine.legacy_filter, "legacy_decide")


def test_engine_imports_thresholds_and_legacy_filter():
    """Both filter paths must be importable from the engine — guards
    against accidental dead-code removal of the legacy switch before
    Phase E11 cleanup."""
    assert sea_engine.legacy_filter is not None
    assert callable(sea_engine.decide_action)
    assert callable(sea_engine.legacy_filter.legacy_decide)


# ── _tail happy path (single-thread, no rotation, no truncation) ──────────

def test_tail_consumes_initial_lines_then_appended_lines(tmp_path):
    """Write 3 lines, consume 3 via next(); append 2 more, consume 2.
    No rotation, no truncation. We use next(it) 5 times rather than
    draining the infinite generator."""
    p = tmp_path / "stream.ndjson"
    p.write_text("a\nb\nc\n", encoding="utf-8")

    it = _tail(p, poll_sec=0.01)
    assert next(it) == "a"
    assert next(it) == "b"
    assert next(it) == "c"

    # In the same process, append two more lines.
    with open(p, "a", encoding="utf-8") as f:
        f.write("d\ne\n")

    # The generator polls every 10 ms; the next two next() calls will
    # discover the appended lines on the next poll cycle.
    assert next(it) == "d"
    assert next(it) == "e"
