"""
tests/test_signal_logger.py — Phase E10 PR2 lock for the daily NDJSON
signal log writer in `signal_engine_agent.signal_logger`.

File path scheme (read from the module verbatim):
    {root}/{instrument}/YYYY-MM-DD{suffix}_signals.log

Note: the module's docstring says `.ndjson` but the actual filename uses
`.log`; we lock on the actual on-disk behaviour so future cleanup is
intentional, not accidental.

Run: python -m pytest python_modules/signal_engine_agent/tests/test_signal_logger.py -v
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent  # python_modules/
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

import signal_engine_agent.signal_logger as sl_module
from signal_engine_agent.signal_logger import SignalLogger

_IST = timezone(timedelta(hours=5, minutes=30))


def _read_lines(path: Path) -> list[dict]:
    """Read NDJSON file as list of decoded dicts."""
    return [json.loads(ln) for ln in path.read_text(encoding="utf-8").splitlines() if ln]


# ── creation ──────────────────────────────────────────────────────────────


def test_constructor_creates_instrument_directory(tmp_path):
    log_root = tmp_path / "logs" / "signals"
    SignalLogger("nifty50", root=log_root)
    assert (log_root / "nifty50").is_dir()


def test_constructor_handles_existing_directory(tmp_path):
    """Idempotent — instantiating twice on the same root must not blow up."""
    log_root = tmp_path / "logs" / "signals"
    SignalLogger("nifty50", root=log_root)
    SignalLogger("nifty50", root=log_root)  # would crash without exist_ok=True
    assert (log_root / "nifty50").is_dir()


# ── log() basic behaviour ─────────────────────────────────────────────────


def test_log_writes_one_jsonline_per_call(tmp_path):
    log_root = tmp_path / "logs" / "signals"
    logger = SignalLogger("nifty50", root=log_root)
    logger.log({"direction": "GO_CALL", "score": 5})
    logger.close()

    today = datetime.now(_IST).strftime("%Y-%m-%d")
    path = log_root / "nifty50" / f"{today}_signals.log"
    assert path.exists()
    lines = _read_lines(path)
    assert len(lines) == 1
    assert lines[0]["direction"] == "GO_CALL"
    assert lines[0]["score"] == 5


def test_log_appends_does_not_overwrite(tmp_path):
    log_root = tmp_path / "logs" / "signals"
    logger = SignalLogger("nifty50", root=log_root)
    logger.log({"direction": "GO_CALL", "i": 1})
    logger.log({"direction": "GO_PUT", "i": 2})
    logger.log({"direction": "GO_CALL", "i": 3})
    logger.close()

    today = datetime.now(_IST).strftime("%Y-%m-%d")
    path = log_root / "nifty50" / f"{today}_signals.log"
    lines = _read_lines(path)
    assert len(lines) == 3
    assert [r["i"] for r in lines] == [1, 2, 3]


def test_log_filters_out_wait(tmp_path):
    """`direction == 'WAIT'` is silently dropped by the logger."""
    log_root = tmp_path / "logs" / "signals"
    logger = SignalLogger("nifty50", root=log_root)
    logger.log({"direction": "WAIT", "score": 0})
    logger.log({"direction": "GO_CALL", "score": 5})
    logger.close()

    today = datetime.now(_IST).strftime("%Y-%m-%d")
    path = log_root / "nifty50" / f"{today}_signals.log"
    lines = _read_lines(path)
    assert len(lines) == 1
    assert lines[0]["direction"] == "GO_CALL"


def test_log_serialises_unknown_types_via_default_str(tmp_path):
    """`json.dumps(..., default=str)` lets datetime / Path / etc. through."""
    log_root = tmp_path / "logs" / "signals"
    logger = SignalLogger("nifty50", root=log_root)
    logger.log(
        {
            "direction": "GO_CALL",
            "ts": datetime(2026, 5, 1, tzinfo=_IST),
            "where": Path("/tmp/foo"),
        }
    )
    logger.close()

    today = datetime.now(_IST).strftime("%Y-%m-%d")
    path = log_root / "nifty50" / f"{today}_signals.log"
    lines = _read_lines(path)
    assert len(lines) == 1
    # Unknown types coerced to str — verify no crash & values are strings
    assert isinstance(lines[0]["ts"], str)
    assert isinstance(lines[0]["where"], str)


# ── filename scheme ───────────────────────────────────────────────────────


def test_log_filename_uses_today_in_ist(tmp_path):
    log_root = tmp_path / "logs" / "signals"
    logger = SignalLogger("nifty50", root=log_root)
    logger.log({"direction": "GO_CALL"})
    logger.close()

    today_ist = datetime.now(_IST).strftime("%Y-%m-%d")
    expected = log_root / "nifty50" / f"{today_ist}_signals.log"
    assert expected.exists()


def test_suffix_changes_filename(tmp_path):
    """`suffix='_filtered'` → YYYY-MM-DD_filtered_signals.log."""
    log_root = tmp_path / "logs" / "signals"
    logger = SignalLogger("nifty50", root=log_root, suffix="_filtered")
    logger.log({"direction": "GO_CALL"})
    logger.close()

    today = datetime.now(_IST).strftime("%Y-%m-%d")
    expected = log_root / "nifty50" / f"{today}_filtered_signals.log"
    assert expected.exists(), f"expected {expected}, got: {list((log_root/'nifty50').iterdir())}"


def test_two_loggers_different_suffix_different_files(tmp_path):
    log_root = tmp_path / "logs" / "signals"
    raw = SignalLogger("nifty50", root=log_root)
    filt = SignalLogger("nifty50", root=log_root, suffix="_filtered")
    raw.log({"direction": "GO_CALL", "kind": "raw"})
    filt.log({"direction": "GO_CALL", "kind": "filt"})
    raw.close()
    filt.close()

    today = datetime.now(_IST).strftime("%Y-%m-%d")
    raw_path = log_root / "nifty50" / f"{today}_signals.log"
    filt_path = log_root / "nifty50" / f"{today}_filtered_signals.log"
    assert raw_path.exists() and filt_path.exists()
    assert _read_lines(raw_path)[0]["kind"] == "raw"
    assert _read_lines(filt_path)[0]["kind"] == "filt"


# ── date rollover ─────────────────────────────────────────────────────────


class _FakeDateTime:
    """Datetime stub whose `now(_IST)` returns a value we can advance."""

    _current: datetime

    @classmethod
    def now(cls, tz=None):
        return cls._current.astimezone(tz) if tz else cls._current

    @classmethod
    def set(cls, dt: datetime):
        cls._current = dt


def test_log_rotates_to_new_file_on_new_day(tmp_path):
    """Patch the module-local `datetime` so we can simulate IST midnight
    crossing without sleeping or touching the real clock."""
    log_root = tmp_path / "logs" / "signals"

    day1 = datetime(2026, 5, 1, 10, 0, 0, tzinfo=_IST)
    day2 = datetime(2026, 5, 2, 10, 0, 0, tzinfo=_IST)

    with patch.object(sl_module, "datetime") as mock_dt:
        mock_dt.now.side_effect = lambda tz=None: (day1.astimezone(tz) if tz else day1)
        # Re-export for the strftime() call inside the module
        mock_dt.side_effect = datetime

        logger = SignalLogger("nifty50", root=log_root)
        logger.log({"direction": "GO_CALL", "i": 1})

        # Advance to next day
        mock_dt.now.side_effect = lambda tz=None: (day2.astimezone(tz) if tz else day2)
        logger.log({"direction": "GO_CALL", "i": 2})
        logger.close()

    p1 = log_root / "nifty50" / "2026-05-01_signals.log"
    p2 = log_root / "nifty50" / "2026-05-02_signals.log"
    assert p1.exists() and p2.exists()
    assert _read_lines(p1)[0]["i"] == 1
    assert _read_lines(p2)[0]["i"] == 2


# ── close() semantics ─────────────────────────────────────────────────────


def test_close_is_idempotent(tmp_path):
    log_root = tmp_path / "logs" / "signals"
    logger = SignalLogger("nifty50", root=log_root)
    logger.log({"direction": "GO_CALL"})
    logger.close()
    # Second close must NOT raise
    logger.close()


def test_close_before_any_log_is_safe(tmp_path):
    """Logger created but never used — close() must not raise."""
    log_root = tmp_path / "logs" / "signals"
    logger = SignalLogger("nifty50", root=log_root)
    logger.close()  # no-op


def test_log_flushes_each_line(tmp_path):
    """Each log() call must flush — the engine relies on the UI being
    able to tail the file in near-real-time."""
    log_root = tmp_path / "logs" / "signals"
    logger = SignalLogger("nifty50", root=log_root)
    logger.log({"direction": "GO_CALL", "i": 1})

    # No close() yet — file should already contain the line on disk.
    today = datetime.now(_IST).strftime("%Y-%m-%d")
    path = log_root / "nifty50" / f"{today}_signals.log"
    lines = _read_lines(path)
    assert len(lines) == 1
    logger.close()
