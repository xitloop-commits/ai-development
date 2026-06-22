"""
signal_logger.py — Append GO_CALL / GO_PUT signals to a daily NDJSON file.

File path: logs/signals/{instrument}/YYYY-MM-DD_signals.log
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

_IST = timezone(timedelta(hours=5, minutes=30))


def _sanitise_for_strict_json(obj):
    """Walk a dict / list / scalar and convert NaN/Inf floats to None.

    Python's `json.dumps` writes `NaN` / `Infinity` as literal tokens.
    Python's `json.loads` accepts them, but they are INVALID JSON per
    RFC 8259 and every strict parser (Node `JSON.parse`, browser fetch
    `response.json()`, `jq -e`, most language stdlibs other than
    Python's) rejects the entire line. Replacing with `null` keeps the
    log readable by every consumer.
    """
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {k: _sanitise_for_strict_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitise_for_strict_json(v) for v in obj]
    return obj


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
        """Write one JSON line for a GO_CALL or GO_PUT signal.

        Sanitises NaN / Inf floats to None before serialisation: Python's
        json.dumps writes `NaN` / `Infinity` as literal tokens (accepted
        by Python's json.loads but INVALID per RFC 8259), so any
        downstream consumer using a strict parser (Node JSON.parse,
        most browsers, jq with -e) silently rejects the entire line.
        That bug live-fired on 2026-06-22: the new model only emits
        `direction_*_60s` predictions but the legacy log schema still
        carries `direction_prob_30s` etc. -- all NaN now -- and every
        line on disk became unparseable by the Node SignalsFeed reader.
        """
        if record.get("direction") == "WAIT":
            return
        self._rotate_if_needed()
        line = json.dumps(
            _sanitise_for_strict_json(record),
            default=str,
        ) + "\n"
        self._fh.write(line)
        self._fh.flush()

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            except Exception:
                pass
            self._fh = None
