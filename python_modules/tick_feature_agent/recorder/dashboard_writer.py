"""
recorder/dashboard_writer.py — Overwrite the live option chain JSON for web UI.

Phase 13.4 (spec §13.4).

On each chain poll, overwrite:
    python_modules/output/option_chain_{instrument}.json

Non-blocking: write is performed in a daemon thread to avoid blocking the
chain-poller timer.  Failure is logged but never fatal.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any


class DashboardWriter:
    """
    Writes latest option chain data to a well-known JSON file for web UI use.

    Usage:

        writer = DashboardWriter(instrument="nifty50", output_dir="python_modules/output")
        writer.update(chain_data)   # called on each chain snapshot
    """

    def __init__(
        self,
        instrument: str,
        output_dir: str | Path = "python_modules/output",
        logger: Any = None,
    ) -> None:
        self.instrument  = instrument
        self._output_dir = Path(output_dir)
        self._logger     = logger
        self._lock       = threading.Lock()

    @property
    def path(self) -> Path:
        return self._output_dir / f"option_chain_{self.instrument}.json"

    def update(self, chain_data: dict[str, Any]) -> None:
        """
        Write ``chain_data`` to the dashboard JSON file in a daemon thread.
        Returns immediately (non-blocking).
        """
        t = threading.Thread(target=self._write, args=(chain_data,), daemon=True)
        t.start()

    def _write(self, chain_data: dict[str, Any]) -> None:
        with self._lock:
            try:
                self._output_dir.mkdir(parents=True, exist_ok=True)
                self.path.write_text(
                    json.dumps(chain_data, default=str, indent=None),
                    encoding="utf-8",
                )
            except Exception as exc:
                if self._logger:
                    self._logger.warn(
                        "DASHBOARD_WRITE_FAILED",
                        msg=f"Dashboard write failed: {exc}",
                        instrument=self.instrument,
                    )
