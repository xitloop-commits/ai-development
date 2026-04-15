"""
tfa_logger.py — Structured logging module for TFA.

All log output is JSON lines (one entry per line) so it can be grepped or
ingested by log aggregators. Human-readable formatted output goes to stderr
for WARN and above so operators running TFA in a terminal see a clean feed.

Usage (module-level, created once):
    from tick_feature_agent.log.tfa_logger import get_logger
    log = get_logger(__name__)

    log.info("EXPIRY_ROLLOVER", msg="Rolled to next expiry", expiry="2026-04-17")
    log.warn("CLOCK_SKEW_DETECTED", msg="chain 2s ahead", skew_sec=2.1)
    log.error("CORRUPT_CHAIN_DATA", msg="strike_step = 0 — halting")  # logs then sys.exit(1)
    log.debug("atm_shift", old_atm=21850, new_atm=21900)

    log.tick_start(tick_seq=1042, tick_ts="...", feed="underlying")
    log.tick_done(tick_seq=1042, elapsed_us=487.3, phase_buffer_us=2.1, ...)
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import queue
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

# IST = UTC+5:30
_IST = timezone(timedelta(hours=5, minutes=30))

# ── Log level constants (mirrors Python logging but with TFA names) ──────────
ERROR = logging.ERROR   # 40 — FATAL: halts process after logging
WARN  = logging.WARNING # 30 — WARN: data quality / feed gaps
INFO  = logging.INFO    # 20 — INFO: lifecycle events
DEBUG = logging.DEBUG   # 10 — DEBUG: per-tick internals (off in production)

_LEVEL_NAMES = {ERROR: "ERROR", WARN: "WARN", INFO: "INFO", DEBUG: "DEBUG"}

# ── Module-level registry so get_logger() returns the same object per name ──
_registry: dict[str, "TFALogger"] = {}
_initialized = False
_operational_handler: logging.handlers.QueueListener | None = None
_perf_handler: logging.handlers.QueueListener | None = None

# ── Internal Python logger roots ─────────────────────────────────────────────
_OPER_ROOT = "tfa.operational"
_PERF_ROOT  = "tfa.perf"


def _now_ist_str() -> str:
    """Return current time as ISO 8601 string with IST offset."""
    return datetime.now(_IST).isoformat(timespec="milliseconds")


def _make_file_handler(path: Path) -> logging.FileHandler:
    path.parent.mkdir(parents=True, exist_ok=True)
    h = logging.FileHandler(path, mode="a", encoding="utf-8")
    h.setFormatter(logging.Formatter("%(message)s"))
    return h


def _make_stderr_handler() -> logging.StreamHandler:
    h = logging.StreamHandler(sys.stderr)
    h.setLevel(WARN)
    h.setFormatter(logging.Formatter("%(message)s"))
    return h


class _JsonFormatter(logging.Formatter):
    """Emit pre-serialized JSON — the log record 'msg' is already a dict."""

    def format(self, record: logging.LogRecord) -> str:
        return record.getMessage()


class _StderrFormatter(logging.Formatter):
    """Human-readable single-line format for terminal output."""

    def format(self, record: logging.LogRecord) -> str:
        # QueueHandler.prepare() sets record.args = None before queuing (for
        # pickling safety), so we must parse the JSON from the message string.
        try:
            data: dict = json.loads(record.getMessage())
        except Exception:
            data = {}
        ts = data.get("ts", "")
        time_part = ts[11:19] if len(ts) >= 19 else ts  # HH:MM:SS
        level = data.get("level", record.levelname)
        alert = data.get("alert") or data.get("event", "")
        msg = data.get("msg", "")
        separator = " — " if msg else ""
        return f"[{time_part} IST] {level:<5}  {alert}{separator}{msg}"


def setup_logging(
    instrument: str,
    log_dir: str | Path = "logs",
    level: int = INFO,
) -> None:
    """
    Initialize TFA logging for a given instrument. Call once at process start,
    before get_logger() is used by any module.

    Args:
        instrument: Instrument name (e.g. "NIFTY", "CRUDEOIL") — used in filenames.
        log_dir: Directory for log files. Default: logs/ relative to cwd.
        level: Minimum log level for the operational log. Default: INFO.
                Set to DEBUG during development.
    """
    global _initialized, _operational_handler, _perf_handler

    if _initialized:
        return

    log_dir = Path(log_dir)
    date_str = datetime.now(_IST).strftime("%Y-%m-%d")
    inst_upper = instrument.upper()

    # ── Operational log (all levels → file, WARN+ → stderr) ─────────────────
    oper_file = log_dir / f"tfa_{inst_upper}_{date_str}.log"
    oper_file_handler = _make_file_handler(oper_file)
    oper_file_handler.setFormatter(_JsonFormatter())
    oper_file_handler.setLevel(level)

    oper_stderr = _make_stderr_handler()
    oper_stderr.setFormatter(_StderrFormatter())

    oper_queue: queue.Queue = queue.Queue(maxsize=10_000)
    oper_queue_handler = logging.handlers.QueueHandler(oper_queue)
    _operational_handler = logging.handlers.QueueListener(
        oper_queue, oper_file_handler, oper_stderr, respect_handler_level=True
    )
    _operational_handler.start()

    oper_logger = logging.getLogger(_OPER_ROOT)
    oper_logger.setLevel(level)
    oper_logger.addHandler(oper_queue_handler)
    oper_logger.propagate = False

    # ── Performance log (dedicated file, no stderr noise) ────────────────────
    perf_file = log_dir / f"tfa_perf_{inst_upper}_{date_str}.log"
    perf_file_handler = _make_file_handler(perf_file)
    perf_file_handler.setFormatter(_JsonFormatter())
    perf_file_handler.setLevel(DEBUG)

    perf_queue: queue.Queue = queue.Queue(maxsize=50_000)
    perf_queue_handler = logging.handlers.QueueHandler(perf_queue)
    _perf_handler = logging.handlers.QueueListener(
        perf_queue, perf_file_handler, respect_handler_level=True
    )
    _perf_handler.start()

    perf_logger = logging.getLogger(_PERF_ROOT)
    perf_logger.setLevel(DEBUG)
    perf_logger.addHandler(perf_queue_handler)
    perf_logger.propagate = False

    _initialized = True


def shutdown_logging() -> None:
    """Flush and stop background queue listeners. Call on process exit."""
    global _initialized
    if _operational_handler:
        _operational_handler.stop()
    if _perf_handler:
        _perf_handler.stop()
    _initialized = False


def get_logger(name: str, instrument: str = "") -> "TFALogger":
    """
    Return a TFALogger for the given module name.

    Args:
        name:       Typically __name__ — used for log record source.
        instrument: Instrument name to embed in every log entry.
                    If omitted, falls back to the value set in setup_logging().
    """
    key = f"{name}::{instrument}"
    if key not in _registry:
        _registry[key] = TFALogger(name, instrument)
    return _registry[key]


# ── Rolling performance tracker ──────────────────────────────────────────────

class _PerfTracker:
    """Rolling 1000-tick average for PERFORMANCE_DEGRADED detection."""

    _WINDOW = 1000
    _CHECK_EVERY = 100

    def __init__(self) -> None:
        self._samples: list[float] = []
        self._total: float = 0.0
        self._count: int = 0
        self._budget_us: float | None = None
        self._degraded_callback: Any = None

    def configure(self, budget_us: float, on_degraded: Any) -> None:
        """Set budget threshold and callback for PERFORMANCE_DEGRADED."""
        self._budget_us = budget_us
        self._degraded_callback = on_degraded

    def record(self, elapsed_us: float) -> None:
        if len(self._samples) >= self._WINDOW:
            self._total -= self._samples.pop(0)
        self._samples.append(elapsed_us)
        self._total += elapsed_us
        self._count += 1
        if self._count % self._CHECK_EVERY == 0:
            self._check()

    def _check(self) -> None:
        if not self._budget_us or len(self._samples) < self._WINDOW:
            return
        avg = self._total / len(self._samples)
        if avg > self._budget_us and self._degraded_callback:
            self._degraded_callback(avg_us=avg, budget_us=self._budget_us)


_perf_tracker = _PerfTracker()


# ── Main TFALogger class ──────────────────────────────────────────────────────

class TFALogger:
    """
    Structured logger for one TFA module. Wraps Python logging with a clean
    keyword-argument API that serializes all fields to JSON.

    One instance per module — created via get_logger(__name__).
    """

    def __init__(self, name: str, instrument: str = "") -> None:
        self._name = name
        self._instrument = instrument
        self._oper = logging.getLogger(f"{_OPER_ROOT}.{name}")
        self._perf = logging.getLogger(f"{_PERF_ROOT}.{name}")
        # per-instance tick sequence state for tick_start/tick_done correlation
        self._active_ticks: dict[int, float] = {}  # tick_seq → perf_counter_ns start

    def _emit(self, level: int, alert: str, msg: str, **kwargs: Any) -> None:
        entry: dict[str, Any] = {
            "ts": _now_ist_str(),
            "level": _LEVEL_NAMES.get(level, "INFO"),
        }
        if alert:
            entry["alert"] = alert
        entry["msg"] = msg
        if self._instrument:
            entry["instrument"] = self._instrument
        entry.update(kwargs)
        line = json.dumps(entry, default=str)
        # Pass the dict as args so StderrFormatter can read it
        record = self._oper.makeRecord(
            self._name, level, "", 0, line, entry, None
        )
        self._oper.handle(record)

    # ── Public log methods ────────────────────────────────────────────────────

    def info(self, alert: str = "", msg: str = "", **kwargs: Any) -> None:
        self._emit(INFO, alert, msg, **kwargs)

    def warn(self, alert: str = "", msg: str = "", **kwargs: Any) -> None:
        self._emit(WARN, alert, msg, **kwargs)

    def error(self, alert: str = "", msg: str = "", **kwargs: Any) -> None:
        """Log at ERROR (FATAL) level then exit the process with code 1."""
        self._emit(ERROR, alert, msg, **kwargs)
        # Flush queues synchronously before exit so the log line is written
        if _operational_handler:
            _operational_handler.stop()
        sys.exit(1)

    def debug(self, alert: str = "", msg: str = "", **kwargs: Any) -> None:
        if self._oper.isEnabledFor(DEBUG):
            self._emit(DEBUG, alert, msg, **kwargs)

    # ── Tick timing methods ───────────────────────────────────────────────────

    def tick_start(
        self,
        tick_seq: int,
        tick_ts: str,
        feed: str,
        strike: int | None = None,
        opt_type: str | None = None,
    ) -> None:
        """
        Call immediately when a tick is dequeued from the WebSocket receive buffer,
        before any processing begins. Records wall-clock start time.
        """
        self._active_ticks[tick_seq] = time.perf_counter_ns()

        entry: dict[str, Any] = {
            "ts": _now_ist_str(),
            "level": "DEBUG",
            "event": "TICK_START",
            "tick_seq": tick_seq,
            "tick_ts": tick_ts,
            "feed": feed,
        }
        if self._instrument:
            entry["instrument"] = self._instrument
        if strike is not None:
            entry["strike"] = strike
        if opt_type is not None:
            entry["opt_type"] = opt_type

        line = json.dumps(entry, default=str)
        record = self._perf.makeRecord(
            self._name, DEBUG, "", 0, line, entry, None
        )
        self._perf.handle(record)

    def tick_done(
        self,
        tick_seq: int,
        elapsed_us: float | None = None,
        phase_buffer_us: float | None = None,
        phase_features_us: float | None = None,
        phase_assemble_us: float | None = None,
        phase_serialize_us: float | None = None,
        phase_emit_us: float | None = None,
    ) -> None:
        """
        Call after emit() completes. Computes elapsed time and writes to
        the dedicated performance log. Also feeds the rolling perf tracker.
        """
        start_ns = self._active_ticks.pop(tick_seq, None)
        if elapsed_us is None:
            if start_ns is not None:
                elapsed_us = (time.perf_counter_ns() - start_ns) / 1_000.0
            else:
                elapsed_us = 0.0

        entry: dict[str, Any] = {
            "ts": _now_ist_str(),
            "level": "INFO",
            "event": "TICK_DONE",
            "tick_seq": tick_seq,
            "elapsed_us": round(elapsed_us, 2),
        }
        if self._instrument:
            entry["instrument"] = self._instrument
        if phase_buffer_us is not None:
            entry["phase_buffer_us"] = round(phase_buffer_us, 2)
        if phase_features_us is not None:
            entry["phase_features_us"] = round(phase_features_us, 2)
        if phase_assemble_us is not None:
            entry["phase_assemble_us"] = round(phase_assemble_us, 2)
        if phase_serialize_us is not None:
            entry["phase_serialize_us"] = round(phase_serialize_us, 2)
        if phase_emit_us is not None:
            entry["phase_emit_us"] = round(phase_emit_us, 2)

        line = json.dumps(entry, default=str)
        record = self._perf.makeRecord(
            self._name, INFO, "", 0, line, entry, None
        )
        self._perf.handle(record)

        _perf_tracker.record(elapsed_us)

    # ── Convenience property to change instrument name after construction ─────

    @property
    def instrument(self) -> str:
        return self._instrument

    @instrument.setter
    def instrument(self, value: str) -> None:
        self._instrument = value


# ── Module-level shorthand (optional) ────────────────────────────────────────

def configure_perf_budget(budget_us: float, on_degraded: Any) -> None:
    """
    Configure the rolling performance budget. Call after setup_logging().

    Args:
        budget_us:    Rolling 1000-tick average threshold in microseconds.
                      Spec default: ~20 µs.
        on_degraded:  Callable(avg_us, budget_us) — typically the alert
                      emitter that fires PERFORMANCE_DEGRADED.
    """
    _perf_tracker.configure(budget_us, on_degraded)
