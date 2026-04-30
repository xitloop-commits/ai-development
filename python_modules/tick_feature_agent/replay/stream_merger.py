"""
replay/stream_merger.py — Chronologically merge 3 NDJSON.gz streams.

Phase 14.1 (spec §16.1).

Reads underlying_ticks, option_ticks, and chain_snapshots streams for a
given date + instrument and yields events in ``recv_ts`` order using a
heap merge.

Yielded event format:

    {"type": "underlying_tick" | "option_tick" | "chain_snapshot", "data": {...}}

Missing or empty files are skipped with a WARN log.  Malformed JSON lines
are skipped silently (logged at DEBUG if a logger is provided).
"""

from __future__ import annotations

import gzip
import heapq
import json
from pathlib import Path
from typing import Any, Generator


_EVENT_TYPES = ("underlying_tick", "option_tick", "chain_snapshot")
_FILE_SUFFIXES = (
    "underlying_ticks.ndjson.gz",
    "option_ticks.ndjson.gz",
    "chain_snapshots.ndjson.gz",
)


def _resolve_stream_path(date_folder: Path, instrument: str,
                         suffix: str) -> Path | None:
    """Resolve one stream file, **preferring `.recovered.ndjson.gz`**
    over the original (Phase E6).

    Recorder corruption (PY-13/PY-122/PY-123) leaves some `.ndjson.gz`
    files that fail mid-stream during replay. `scripts/recover_gz.py`
    salvages them by writing a `<stem>.recovered.ndjson.gz` next to the
    original — gzip-clean, truncated to the last complete newline.
    Replay must prefer that file when it exists, otherwise it'll keep
    bailing on the corrupt original and silently produce zero/partial
    parquet output for the day.

    Returns None if neither file exists; callers already log a warning
    in that case via the existing `REPLAY_STREAM_EMPTY` path.
    """
    # `suffix` is e.g. "underlying_ticks.ndjson.gz" — strip the
    # ".ndjson.gz" tail to splice in `.recovered`.
    stem = suffix[: -len(".ndjson.gz")]
    recovered = date_folder / f"{instrument}_{stem}.recovered.ndjson.gz"
    original  = date_folder / f"{instrument}_{suffix}"
    if recovered.exists():
        return recovered
    if original.exists():
        return original
    return None


def _iter_gz(path: Path, event_type: str, logger: Any = None):
    """
    Yield (recv_ts_str, event_type, record) tuples from a single NDJSON.gz file.
    Skips malformed lines.
    """
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    recv_ts = record.get("recv_ts", "")
                    yield recv_ts, event_type, record
                except json.JSONDecodeError:
                    if logger:
                        logger.debug(
                            "REPLAY_MALFORMED_LINE",
                            msg=f"Skipping malformed JSON in {path.name}",
                        )
    except FileNotFoundError:
        if logger:
            logger.warn(
                "REPLAY_FILE_MISSING",
                msg=f"Stream file not found: {path}",
            )
    except Exception as exc:
        if logger:
            logger.warn(
                "REPLAY_READ_ERROR",
                msg=f"Error reading {path}: {exc}",
            )


def merge_streams(
    date_folder: str | Path,
    instrument: str,
    logger: Any = None,
) -> Generator[dict[str, Any], None, None]:
    """
    Yield all events from the 3 streams in chronological ``recv_ts`` order.

    Args:
        date_folder:  Path to the date folder (e.g. ``data/raw/2026-04-14``).
        instrument:   Instrument key (e.g. ``"nifty50"``).
        logger:       Optional TFALogger instance.

    Yields:
        ``{"type": str, "data": dict}`` dicts in recv_ts order.
    """
    date_folder = Path(date_folder)
    iterators = []

    for suffix, event_type in zip(_FILE_SUFFIXES, _EVENT_TYPES):
        path = _resolve_stream_path(date_folder, instrument, suffix)
        if path is None:
            if logger:
                logger.warn(
                    "REPLAY_STREAM_EMPTY",
                    msg=f"Empty or missing stream: {instrument}_{suffix}",
                )
            continue
        if logger and ".recovered." in path.name:
            # Audit-trail: track which dates fell back so we can spot
            # systemic recorder issues vs one-off corruption events.
            logger.warn(
                "REPLAY_USING_RECOVERED",
                msg=f"Using recovered stream: {path.name}",
            )
        it = _iter_gz(path, event_type, logger)
        # Peek at first record to seed the heap
        try:
            first = next(it)
            iterators.append((first, it))
        except StopIteration:
            if logger:
                logger.warn(
                    "REPLAY_STREAM_EMPTY",
                    msg=f"Empty or missing stream: {path.name}",
                )

    if not iterators:
        return

    # heap entries: (recv_ts, tiebreak_index, (recv_ts, event_type, record), iterator)
    heap: list[tuple] = []
    for i, ((recv_ts, etype, record), it) in enumerate(iterators):
        heapq.heappush(heap, (recv_ts, i, etype, record, it))

    while heap:
        recv_ts, i, etype, record, it = heapq.heappop(heap)
        yield {"type": etype, "data": record}

        try:
            next_ts, next_etype, next_record = next(it)
            heapq.heappush(heap, (next_ts, i, next_etype, next_record, it))
        except StopIteration:
            pass  # this stream is exhausted
