"""
replay/checkpoint.py — Persist replay progress per instrument.

Phase 14.3 (spec §16.3).

Checkpoint file: ``data/checkpoints/replay_progress.json``

Format:

    {
      "nifty50":  { "last_completed_date": "2026-04-11", "sessions_completed": 10 },
      "banknifty": { "last_completed_date": "2026-04-11", "sessions_completed": 10 }
    }

Checkpoint granularity = full session (calendar day).  A session is only
marked complete after its Parquet file is flushed and closed.  Each instrument
is tracked independently.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any


_DEFAULT_PATH = Path("data/checkpoints/replay_progress.json")


def _load(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


class ReplayCheckpoint:
    """
    Thread-safe (single-process) read/write wrapper for replay_progress.json.

    Usage:

        cp = ReplayCheckpoint("data/checkpoints/replay_progress.json")
        resume_date = cp.get_resume_date("nifty50", date_from="2026-04-01")
        # ... replay ...
        cp.mark_complete("nifty50", "2026-04-01")
    """

    def __init__(self, path: str | Path = _DEFAULT_PATH) -> None:
        self._path = Path(path)

    def mark_complete(self, instrument: str, date_str: str) -> None:
        """
        Mark a session as fully replayed.  Updates last_completed_date and
        increments sessions_completed.

        Args:
            instrument:  Instrument key (e.g. ``"nifty50"``).
            date_str:    ISO date string ``YYYY-MM-DD``.
        """
        data = _load(self._path)
        entry = data.get(instrument, {"last_completed_date": None, "sessions_completed": 0})
        # Only advance if date_str is after last_completed_date
        if (
            entry["last_completed_date"] is None
            or date_str > entry["last_completed_date"]
        ):
            entry["last_completed_date"] = date_str
        entry["sessions_completed"] = entry.get("sessions_completed", 0) + 1
        data[instrument] = entry
        _save(self._path, data)

    def get_resume_date(
        self,
        instrument: str,
        date_from: str,
    ) -> str:
        """
        Return the first date to replay for this instrument.

        If ``--resume`` is active: returns the day after ``last_completed_date``
        (or ``date_from`` if no checkpoint exists).
        Always returns ``date_from`` if no checkpoint for this instrument.

        Args:
            instrument:  Instrument key.
            date_from:   Start date of the requested replay range ``YYYY-MM-DD``.

        Returns:
            ISO date string of the first date to process.
        """
        data = _load(self._path)
        entry = data.get(instrument)
        if not entry or not entry.get("last_completed_date"):
            return date_from
        last_done = entry["last_completed_date"]
        # Next date after last_completed
        next_date = (
            date.fromisoformat(last_done) + timedelta(days=1)
        ).isoformat()
        return max(next_date, date_from)

    def get_entry(self, instrument: str) -> dict[str, Any] | None:
        """Return the raw checkpoint entry for an instrument, or None."""
        return _load(self._path).get(instrument)

    def reset(self, instrument: str | None = None) -> None:
        """
        Clear checkpoint for one instrument or all instruments.

        Args:
            instrument: If given, clear only this instrument's entry.
                        If None, clear everything.
        """
        if instrument is None:
            _save(self._path, {})
        else:
            data = _load(self._path)
            data.pop(instrument, None)
            _save(self._path, data)
