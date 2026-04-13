"""
recorder/writer.py — NdjsonGzWriter: thread-safe gzip NDJSON file writer.

Phase 13.1 (spec §15.7).

One NdjsonGzWriter per stream (underlying_ticks, option_ticks, chain_snapshots).
All write operations are protected by a per-instance threading.Lock so the
asyncio WebSocket callback and the chain-poller timer thread can both write
without corruption.

On write failure: logs ERROR, skips the record, continues — does not halt TFA.
"""

from __future__ import annotations

import gzip
import json
import threading
from pathlib import Path
from typing import Any


class NdjsonGzWriter:
    """
    Thread-safe writer for NDJSON.gz (newline-delimited JSON, gzip compressed).

    Usage:

        writer = NdjsonGzWriter(path="/data/raw/2026-04-14/nifty50_underlying_ticks.ndjson.gz")
        writer.write({"recv_ts": "...", "ltp": 23100.0, ...})
        writer.roll("/data/raw/2026-04-15/nifty50_underlying_ticks.ndjson.gz")
        writer.close()
    """

    def __init__(self, path: str | Path, logger: Any = None) -> None:
        self._path = Path(path)
        self._lock = threading.Lock()
        self._logger = logger
        self._fh = self._open(self._path)

    def _open(self, path: Path):
        """Open gzip file in text-append mode; create parent dirs if needed."""
        path.parent.mkdir(parents=True, exist_ok=True)
        return gzip.open(path, "at", encoding="utf-8")

    def write(self, record: dict[str, Any]) -> bool:
        """
        Serialize ``record`` to JSON and append one line to the gzip file.

        Returns True on success, False on failure (error logged, record skipped).
        """
        with self._lock:
            if self._fh is None:
                return False
            try:
                line = json.dumps(record, default=str) + "\n"
                self._fh.write(line)
                return True
            except Exception as exc:
                if self._logger:
                    self._logger.error(
                        "RECORDER_WRITE_FAILED",
                        msg=f"Failed to write record: {exc}",
                        path=str(self._path),
                    )
                return False

    def flush(self) -> None:
        """Flush the underlying gzip buffer.  No-op if already closed."""
        with self._lock:
            if self._fh is not None:
                try:
                    self._fh.flush()
                except Exception:
                    pass

    def roll(self, new_path: str | Path) -> None:
        """
        Close current file and open a new one at ``new_path``.
        Used for date rollover or expiry rollover.
        """
        new_path = Path(new_path)
        with self._lock:
            if self._fh is not None:
                try:
                    self._fh.close()
                except Exception:
                    pass
            self._path = new_path
            self._fh = self._open(new_path)

    def close(self) -> None:
        """Flush and close the writer.  Idempotent."""
        with self._lock:
            if self._fh is not None:
                try:
                    self._fh.close()
                except Exception:
                    pass
                finally:
                    self._fh = None

    @property
    def path(self) -> Path:
        return self._path

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
