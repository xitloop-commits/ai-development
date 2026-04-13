"""
test_logging.py — Unit tests for tfa_logger.py.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_logging.py -v
"""

from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path

import pytest

# Reset module state between tests
import tick_feature_agent.log.tfa_logger as _mod


def _reset():
    _mod._registry.clear()
    _mod._initialized = False
    if _mod._operational_handler:
        try:
            _mod._operational_handler.stop()
        except Exception:
            pass
        _mod._operational_handler = None
    if _mod._perf_handler:
        try:
            _mod._perf_handler.stop()
        except Exception:
            pass
        _mod._perf_handler = None
    # Remove all handlers from internal loggers
    for logger_name in [_mod._OPER_ROOT, _mod._PERF_ROOT]:
        lg = logging.getLogger(logger_name)
        lg.handlers.clear()


@pytest.fixture(autouse=True)
def reset_state():
    _reset()
    yield
    _reset()


# ── setup_logging / idempotency ───────────────────────────────────────────────

def test_setup_creates_log_files(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path), level=_mod.INFO)
    assert _mod._initialized is True
    time.sleep(0.05)
    log = _mod.get_logger("test.setup", instrument="NIFTY")
    log.info("EXPIRY_ROLLOVER", msg="test event")
    _mod.shutdown_logging()
    log_files = list(tmp_path.glob("tfa_NIFTY_*.log"))
    assert len(log_files) >= 1


def test_setup_idempotent(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path))
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path))  # second call is a no-op
    assert _mod._initialized is True
    _mod.shutdown_logging()


# ── get_logger registry ───────────────────────────────────────────────────────

def test_get_logger_returns_same_instance(tmp_path):
    _mod.setup_logging("BANKNIFTY", log_dir=str(tmp_path))
    a = _mod.get_logger("mod.a", instrument="BANKNIFTY")
    b = _mod.get_logger("mod.a", instrument="BANKNIFTY")
    assert a is b
    _mod.shutdown_logging()


def test_get_logger_different_names_are_different(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path))
    a = _mod.get_logger("mod.a", instrument="NIFTY")
    b = _mod.get_logger("mod.b", instrument="NIFTY")
    assert a is not b
    _mod.shutdown_logging()


# ── JSON output format ────────────────────────────────────────────────────────

def test_info_emits_valid_json(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path), level=_mod.DEBUG)
    log = _mod.get_logger("test.json", instrument="NIFTY")
    log.info("EXPIRY_ROLLOVER", msg="Rolled to next expiry", expiry="2026-04-17")
    _mod.shutdown_logging()

    log_files = list(tmp_path.glob("tfa_NIFTY_*.log"))
    assert log_files, "No log file created"
    lines = log_files[0].read_text().strip().splitlines()
    assert lines, "Log file is empty"
    entry = json.loads(lines[0])

    assert entry["level"] == "INFO"
    assert entry["alert"] == "EXPIRY_ROLLOVER"
    assert entry["msg"] == "Rolled to next expiry"
    assert entry["instrument"] == "NIFTY"
    assert entry["expiry"] == "2026-04-17"
    assert "ts" in entry


def test_warn_emits_valid_json(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path))
    log = _mod.get_logger("test.warn", instrument="NIFTY")
    log.warn("CLOCK_SKEW_DETECTED", msg="2s ahead", skew_sec=2.1)
    _mod.shutdown_logging()

    log_files = list(tmp_path.glob("tfa_NIFTY_*.log"))
    entry = json.loads(log_files[0].read_text().strip().splitlines()[0])
    assert entry["level"] == "WARN"
    assert entry["alert"] == "CLOCK_SKEW_DETECTED"
    assert entry["skew_sec"] == 2.1


def test_debug_not_in_file_at_info_level(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path), level=_mod.INFO)
    log = _mod.get_logger("test.debug", instrument="NIFTY")
    log.debug("atm_shift", msg="ATM moved", old_atm=21850, new_atm=21900)
    log.info("SOME_INFO", msg="should appear")
    _mod.shutdown_logging()

    log_files = list(tmp_path.glob("tfa_NIFTY_*.log"))
    content = log_files[0].read_text()
    assert "atm_shift" not in content
    assert "SOME_INFO" in content


def test_debug_appears_at_debug_level(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path), level=_mod.DEBUG)
    log = _mod.get_logger("test.debug2", instrument="NIFTY")
    log.debug("atm_shift", msg="ATM moved", old_atm=21850, new_atm=21900)
    _mod.shutdown_logging()

    log_files = list(tmp_path.glob("tfa_NIFTY_*.log"))
    content = log_files[0].read_text()
    assert "atm_shift" in content


# ── error() calls sys.exit(1) ─────────────────────────────────────────────────

def test_error_exits(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path))
    log = _mod.get_logger("test.fatal", instrument="NIFTY")
    with pytest.raises(SystemExit) as exc_info:
        log.error("CORRUPT_CHAIN_DATA", msg="strike_step = 0 — halting")
    assert exc_info.value.code == 1


# ── tick timing ───────────────────────────────────────────────────────────────

def test_tick_start_done_go_to_perf_log(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path), level=_mod.DEBUG)
    log = _mod.get_logger("test.tick", instrument="NIFTY")
    log.tick_start(tick_seq=42, tick_ts="2026-04-11T09:15:01.234+05:30", feed="underlying")
    time.sleep(0.001)
    log.tick_done(tick_seq=42, phase_buffer_us=2.1, phase_features_us=84.5)
    _mod.shutdown_logging()

    perf_files = list(tmp_path.glob("tfa_perf_NIFTY_*.log"))
    assert perf_files, "No perf log file created"
    lines = perf_files[0].read_text().strip().splitlines()
    events = [json.loads(l) for l in lines]
    event_names = [e.get("event") for e in events]
    assert "TICK_START" in event_names
    assert "TICK_DONE" in event_names


def test_tick_done_elapsed_computed_automatically(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path), level=_mod.DEBUG)
    log = _mod.get_logger("test.elapsed", instrument="NIFTY")
    log.tick_start(tick_seq=99, tick_ts="2026-04-11T09:15:01.234+05:30", feed="underlying")
    time.sleep(0.002)  # ~2ms
    log.tick_done(tick_seq=99)
    _mod.shutdown_logging()

    perf_files = list(tmp_path.glob("tfa_perf_NIFTY_*.log"))
    lines = perf_files[0].read_text().strip().splitlines()
    events = {e["event"]: e for e in (json.loads(l) for l in lines)}
    done = events["TICK_DONE"]
    # elapsed should be at least 1µs (we slept 2ms)
    assert done["elapsed_us"] > 1.0


def test_tick_done_with_explicit_elapsed(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path), level=_mod.DEBUG)
    log = _mod.get_logger("test.explicit", instrument="NIFTY")
    log.tick_start(tick_seq=7, tick_ts="2026-04-11T09:15:01.000+05:30", feed="option",
                   strike=21800, opt_type="CE")
    log.tick_done(tick_seq=7, elapsed_us=487.3, phase_buffer_us=2.1,
                  phase_features_us=84.5, phase_assemble_us=98.2,
                  phase_serialize_us=291.4, phase_emit_us=11.1)
    _mod.shutdown_logging()

    perf_files = list(tmp_path.glob("tfa_perf_NIFTY_*.log"))
    lines = perf_files[0].read_text().strip().splitlines()
    events = {e["event"]: e for e in (json.loads(l) for l in lines)}
    done = events["TICK_DONE"]
    assert done["elapsed_us"] == 487.3
    assert done["phase_buffer_us"] == 2.1
    assert done["phase_serialize_us"] == 291.4

    start = events["TICK_START"]
    assert start["strike"] == 21800
    assert start["opt_type"] == "CE"


# ── perf tracker ─────────────────────────────────────────────────────────────

def test_perf_tracker_fires_callback_on_budget_exceeded(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path), level=_mod.DEBUG)
    fired: list[dict] = []

    def on_degraded(**kwargs):
        fired.append(kwargs)

    _mod.configure_perf_budget(budget_us=10.0, on_degraded=on_degraded)
    tracker = _mod._perf_tracker
    # Push 1000 samples of 50µs (above 10µs budget)
    for i in range(1100):
        tracker.record(50.0)

    _mod.shutdown_logging()
    assert len(fired) > 0
    assert fired[0]["avg_us"] > 10.0


def test_perf_tracker_no_callback_below_budget(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path))
    fired: list[dict] = []

    def on_degraded(**kwargs):
        fired.append(kwargs)

    _mod.configure_perf_budget(budget_us=1000.0, on_degraded=on_degraded)
    tracker = _mod._perf_tracker
    for i in range(1100):
        tracker.record(5.0)

    _mod.shutdown_logging()
    assert len(fired) == 0


# ── instrument setter ─────────────────────────────────────────────────────────

def test_instrument_setter(tmp_path):
    _mod.setup_logging("NIFTY", log_dir=str(tmp_path))
    log = _mod.get_logger("test.setter")
    assert log.instrument == ""
    log.instrument = "CRUDEOIL"
    assert log.instrument == "CRUDEOIL"
    _mod.shutdown_logging()
