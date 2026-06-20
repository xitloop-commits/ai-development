"""
Tests for parallel_orchestrator.py — Phase 1b multi-instrument training
(2026-06-20).

The end-to-end ProcessPoolExecutor path isn't unit-tested here — spawning
real subprocesses that do LightGBM fits would take 10+ min per test and
fail on CI / machines without parquet data. Instead we test the
deterministic pieces:

  - thread-budget math
  - stdout-prefix wrapper
  - worker function with `train_instrument` mocked
  - orchestrator with the executor mocked (so we exercise the parent's
    Esc handling, summary printing, and result-dict shape)
"""
from __future__ import annotations

import io
import sys
from unittest.mock import MagicMock, patch

import pytest

from model_training_agent.parallel_orchestrator import (
    _decide_threads_per_worker,
    _install_stdout_prefix,
    _train_one_instrument_worker,
    train_multiple_instruments,
)


class TestDecideThreadsPerWorker:
    def test_single_worker_gets_all_cores(self):
        with patch("os.cpu_count", return_value=8):
            assert _decide_threads_per_worker(1) == 8

    def test_four_workers_on_eight_cores_get_two_each(self):
        with patch("os.cpu_count", return_value=8):
            assert _decide_threads_per_worker(4) == 2

    def test_more_workers_than_cores_floors_at_one(self):
        with patch("os.cpu_count", return_value=4):
            assert _decide_threads_per_worker(16) == 1

    def test_unknown_cpu_count_floors_at_one(self):
        with patch("os.cpu_count", return_value=None):
            assert _decide_threads_per_worker(2) == 1

    def test_zero_workers_treated_as_one(self):
        with patch("os.cpu_count", return_value=4):
            # max(1, n) clamps the divisor so /0 can't happen
            assert _decide_threads_per_worker(0) == 4


class TestStdoutPrefix:
    def test_prefix_added_to_each_line(self, capsys):
        _install_stdout_prefix("nifty50")
        try:
            print("first line")
            print("second line")
        finally:
            sys.stdout = sys.__stdout__
        captured = capsys.readouterr()
        assert "[nifty50] first line" in captured.out
        assert "[nifty50] second line" in captured.out

    def test_multiline_string_prefixes_each_line(self, capsys):
        _install_stdout_prefix("crudeoil")
        try:
            sys.stdout.write("alpha\nbeta\ngamma\n")
        finally:
            sys.stdout = sys.__stdout__
        captured = capsys.readouterr()
        for line in ("[crudeoil] alpha", "[crudeoil] beta", "[crudeoil] gamma"):
            assert line in captured.out


class TestTrainOneInstrumentWorker:
    """Mock-driven tests that exercise the worker function without spawning
    a real subprocess. We monkey-patch the module-level import of
    `train_instrument` so the worker's import line resolves to our mock."""

    def test_success_returns_ok_dict(self, monkeypatch, tmp_path):
        mock_result = MagicMock(
            timestamp="20260620_120000",
            output_dir=tmp_path / "nifty50" / "20260620_120000",
            feature_count=470,
            metrics={"direction_60s": {"val_auc": 0.6}},
        )
        mock_train = MagicMock(return_value=mock_result)
        # The worker imports train_instrument inside its body, so patch
        # the module attribute the import will resolve to.
        import model_training_agent.trainer as _trainer
        monkeypatch.setattr(_trainer, "train_instrument", mock_train)

        out = _train_one_instrument_worker(
            instrument="nifty50",
            train_kwargs={"date_from": "2026-06-01", "date_to": "2026-06-19"},
            threads_per_worker=2,
        )
        assert out["ok"] is True
        assert out["instrument"] == "nifty50"
        assert out["timestamp"] == "20260620_120000"
        assert out["feature_count"] == 470
        assert out["n_metrics"] == 1
        assert out["error"] is None

    def test_exception_captured_as_error_string(self, monkeypatch):
        import model_training_agent.trainer as _trainer
        monkeypatch.setattr(
            _trainer, "train_instrument",
            MagicMock(side_effect=RuntimeError("no parquet data")),
        )
        out = _train_one_instrument_worker(
            instrument="banknifty",
            train_kwargs={"date_from": "2026-06-01", "date_to": "2026-06-19"},
            threads_per_worker=4,
        )
        assert out["ok"] is False
        assert out["instrument"] == "banknifty"
        assert "no parquet data" in out["error"]
        assert out["timestamp"] is None

    def test_keyboard_interrupt_returns_stopped_message(self, monkeypatch):
        import model_training_agent.trainer as _trainer
        monkeypatch.setattr(
            _trainer, "train_instrument",
            MagicMock(side_effect=KeyboardInterrupt()),
        )
        out = _train_one_instrument_worker(
            instrument="crudeoil",
            train_kwargs={"date_from": "2026-06-01", "date_to": "2026-06-19"},
            threads_per_worker=2,
        )
        assert out["ok"] is False
        assert "Esc" in out["error"]


class TestTrainMultipleInstruments:
    def test_empty_instruments_returns_empty_dict(self):
        out = train_multiple_instruments(instruments=[], train_kwargs={})
        assert out == {}

    def test_results_keyed_by_instrument_name(self, monkeypatch):
        """Mock the ProcessPoolExecutor so the orchestrator runs the
        workers inline. Each "worker" returns a canned result dict."""

        fake_results = {
            "nifty50": {
                "instrument": "nifty50", "ok": True,
                "timestamp": "20260620_120000",
                "output_dir": "/models/nifty50/20260620_120000",
                "feature_count": 470, "n_metrics": 84, "error": None,
            },
            "banknifty": {
                "instrument": "banknifty", "ok": True,
                "timestamp": "20260620_120000",
                "output_dir": "/models/banknifty/20260620_120000",
                "feature_count": 470, "n_metrics": 84, "error": None,
            },
        }

        class _FakeFuture:
            def __init__(self, value):
                self._value = value
            def result(self):
                return self._value

        class _FakeExecutor:
            def __init__(self, *a, **kw):
                self._processes = {}
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass
            def submit(self, fn, instrument, train_kwargs, threads_per_worker):
                return _FakeFuture(fake_results[instrument])
            def shutdown(self, wait=True, cancel_futures=False):
                pass

        # Patch `as_completed` to return futures in submission order so
        # the test is deterministic.
        def _fake_as_completed(fut_dict):
            return list(fut_dict.keys())

        with patch(
            "model_training_agent.parallel_orchestrator.ProcessPoolExecutor",
            _FakeExecutor,
        ), patch(
            "model_training_agent.parallel_orchestrator.as_completed",
            _fake_as_completed,
        ):
            out = train_multiple_instruments(
                instruments=["nifty50", "banknifty"],
                train_kwargs={"date_from": "2026-06-01", "date_to": "2026-06-19"},
            )
        assert set(out.keys()) == {"nifty50", "banknifty"}
        assert all(out[i]["ok"] for i in out)
        assert out["nifty50"]["feature_count"] == 470
