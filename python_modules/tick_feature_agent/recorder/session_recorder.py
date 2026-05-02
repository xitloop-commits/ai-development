"""
recorder/session_recorder.py — Manages 3 NDJSON.gz writers for one instrument.

Phase 13.2 (spec §15.5).

One SessionRecorder per TFA process (single instrument).  Coordinates:
  - underlying_ticks writer
  - option_ticks writer
  - chain_snapshots writer

Lifecycle:

    rec = SessionRecorder(
        instrument="nifty50",
        data_root="data/raw",
        underlying_symbol="NIFTY25MAYFUT",
        underlying_security_id="13",
        expiry="2026-04-17",
    )

    rec.on_session_open("2026-04-14")
    rec.record_underlying_tick({...})
    rec.record_option_tick({...})
    rec.record_chain_snapshot({...})
    rec.on_expiry_rollover(new_expiry="2026-04-24", new_underlying_symbol="NIFTY25MAYFUT")
    rec.on_session_close()

Restart-append behaviour:
    If today's date folder already exists (mid-session restart), the writers
    open in append mode automatically (``gzip.open("at")`` always appends to
    an existing file if it exists, or creates a new one if not).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from tick_feature_agent.recorder.metadata_writer import write_metadata
from tick_feature_agent.recorder.writer import NdjsonGzWriter

_IST = timezone(timedelta(hours=5, minutes=30))


def _now_ist_str() -> str:
    return datetime.now(_IST).isoformat(timespec="milliseconds")


class SessionRecorder:
    """
    Manages recording of all 3 input streams for one TFA instrument.

    Thread-safety: individual writers are thread-safe via their own locks.
    ``on_session_open`` / ``on_session_close`` / ``on_expiry_rollover`` should
    be called from the main event loop only.
    """

    def __init__(
        self,
        instrument: str,
        data_root: str | Path = "data/raw",
        underlying_symbol: str = "",
        underlying_security_id: str = "",
        expiry: str = "",
        logger: Any = None,
    ) -> None:
        self.instrument = instrument
        self._data_root = Path(data_root)
        self._underlying_symbol = underlying_symbol
        self._underlying_sec_id = underlying_security_id
        self._expiry = expiry
        self._logger = logger

        self._date: str | None = None
        self._underlying_writer: NdjsonGzWriter | None = None
        self._option_writer: NdjsonGzWriter | None = None
        self._chain_writer: NdjsonGzWriter | None = None

        self._underlying_count = 0
        self._option_count = 0
        self._chain_count = 0

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def on_session_open(self, date_ist: str) -> None:
        """
        Create date folder, open 3 writers, write metadata.json.
        If folder already exists (restart), writers append to existing files.

        Args:
            date_ist: ISO date string ``YYYY-MM-DD``.
        """
        self._date = date_ist
        date_folder = self._data_root / date_ist
        inst = self.instrument

        self._underlying_writer = NdjsonGzWriter(
            date_folder / f"{inst}_underlying_ticks.ndjson.gz",
            logger=self._logger,
        )
        self._option_writer = NdjsonGzWriter(
            date_folder / f"{inst}_option_ticks.ndjson.gz",
            logger=self._logger,
        )
        self._chain_writer = NdjsonGzWriter(
            date_folder / f"{inst}_chain_snapshots.ndjson.gz",
            logger=self._logger,
        )

        # Reset counters for this session
        self._underlying_count = 0
        self._option_count = 0
        self._chain_count = 0

        write_metadata(
            date_folder=date_folder,
            date=date_ist,
            instruments={
                inst: {
                    "underlying_symbol": self._underlying_symbol,
                    "underlying_security_id": self._underlying_sec_id,
                    "expiry": self._expiry,
                }
            },
        )

        if self._logger:
            self._logger.info(
                "SESSION_RECORDING_OPEN",
                msg=f"Recording opened for {inst} on {date_ist}",
                instrument=inst,
                date=date_ist,
            )

    def on_session_close(self) -> None:
        """Flush and close all 3 writers; log final counts."""
        for writer in (self._underlying_writer, self._option_writer, self._chain_writer):
            if writer is not None:
                writer.close()

        if self._logger:
            self._logger.info(
                "SESSION_RECORDING_CLOSE",
                msg=f"Recording closed for {self.instrument}",
                instrument=self.instrument,
                date=self._date,
                underlying_ticks=self._underlying_count,
                option_ticks=self._option_count,
                chain_snapshots=self._chain_count,
            )

        self._underlying_writer = None
        self._option_writer = None
        self._chain_writer = None

    def on_expiry_rollover(
        self,
        new_expiry: str,
        new_underlying_symbol: str | None = None,
    ) -> None:
        """
        Update stored expiry; overwrite metadata.json with new expiry.

        Does NOT roll the writer files — expiry rollover happens mid-session
        so ticks before and after rollover are in the same NDJSON.gz file.
        The ``expiry`` field on each option tick record identifies the expiry
        at the time of recording.
        """
        self._expiry = new_expiry
        if new_underlying_symbol:
            self._underlying_symbol = new_underlying_symbol

        if self._date:
            write_metadata(
                date_folder=self._data_root / self._date,
                date=self._date,
                instruments={
                    self.instrument: {
                        "underlying_symbol": self._underlying_symbol,
                        "underlying_security_id": self._underlying_sec_id,
                        "expiry": self._expiry,
                    }
                },
            )

        if self._logger:
            self._logger.info(
                "EXPIRY_ROLLOVER_RECORDED",
                msg=f"{self.instrument} expiry updated → {new_expiry}",
                instrument=self.instrument,
                new_expiry=new_expiry,
            )

    # ── Record methods ─────────────────────────────────────────────────────────

    def record_underlying_tick(self, record: dict[str, Any]) -> None:
        """
        Write one underlying tick record.

        The caller should include all fields from spec §15.4.1.
        ``recv_ts`` is added if not already present.
        """
        if self._underlying_writer is None:
            return
        if "recv_ts" not in record:
            record = {"recv_ts": _now_ist_str(), **record}
        if self._underlying_writer.write(record):
            self._underlying_count += 1

    def record_option_tick(self, record: dict[str, Any]) -> None:
        """
        Write one option tick record (spec §15.4.2).
        ``expiry`` should already be set by the caller from SecurityMap lookup.
        """
        if self._option_writer is None:
            return
        if "recv_ts" not in record:
            record = {"recv_ts": _now_ist_str(), **record}
        if self._option_writer.write(record):
            self._option_count += 1

    def record_chain_snapshot(self, record: dict[str, Any]) -> None:
        """
        Write one chain snapshot record (spec §15.4.3).
        """
        if self._chain_writer is None:
            return
        if "recv_ts" not in record:
            record = {"recv_ts": _now_ist_str(), **record}
        if self._chain_writer.write(record):
            self._chain_count += 1

    def flush(self) -> None:
        """Flush all open writers to disk (call periodically during live recording)."""
        for writer in (self._underlying_writer, self._option_writer, self._chain_writer):
            if writer is not None:
                writer.flush()

    # ── Stats ─────────────────────────────────────────────────────────────────

    @property
    def counts(self) -> dict[str, int]:
        return {
            "underlying_ticks": self._underlying_count,
            "option_ticks": self._option_count,
            "chain_snapshots": self._chain_count,
        }
