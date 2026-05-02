"""
signal_logger.py — Append GO_CALL / GO_PUT signals to a daily NDJSON file.

File path: logs/signals/{instrument}/YYYY-MM-DD_signals.log
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

_IST = timezone(timedelta(hours=5, minutes=30))


class SignalLogger:
    def __init__(
        self, instrument: str, root: Path = Path("logs/signals"), suffix: str = ""
    ) -> None:
        self._instrument = instrument
        self._suffix = suffix  # e.g. "_filtered" → YYYY-MM-DD_filtered.log
        self._dir = root / instrument
        self._dir.mkdir(parents=True, exist_ok=True)
        self._current_date: str | None = None
        self._fh = None

    def _rotate_if_needed(self) -> None:
        today = datetime.now(_IST).strftime("%Y-%m-%d")
        if today != self._current_date:
            if self._fh is not None:
                try:
                    self._fh.close()
                except Exception:
                    pass
            path = self._dir / f"{today}{self._suffix}_signals.log"
            self._fh = open(path, "a", encoding="utf-8")
            self._current_date = today

    def log(self, record: dict) -> None:
        """Write one JSON line for a GO_CALL or GO_PUT signal."""
        if record.get("direction") == "WAIT":
            return
        self._rotate_if_needed()
        line = json.dumps(record, default=str) + "\n"
        self._fh.write(line)
        self._fh.flush()

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            except Exception:
                pass
            self._fh = None
