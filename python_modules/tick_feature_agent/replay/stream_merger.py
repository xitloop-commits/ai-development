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
from collections.abc import Generator
from pathlib import Path
from typing import Any

_EVENT_TYPES = ("underlying_tick", "option_tick", "chain_snapshot", "vix_tick")
_FILE_SUFFIXES = (
    "underlying_ticks.ndjson.gz",
    "option_ticks.ndjson.gz",
    "chain_snapshots.ndjson.gz",
    # Phase 2d-01: India VIX co-recording. Missing for pre-VIX recordings —
    # _resolve_stream_path returns None and the merger silently skips, so
    # old replays still work (VIX features simply stay NaN).
    "vix_ticks.ndjson.gz",
)


def _resolve_stream_path(date_folder: Path, instrument: str, suffix: str) -> Path | None:
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
    original = date_folder / f"{instrument}_{suffix}"
    if recovered.exists():
        return recovered
    if original.exists():
        return original
    return None


def _iter_gz(
    path: Path,
    event_type: str,
    logger: Any = None,
    *,
    progress: dict | None = None,
):
    """
    Yield (recv_ts_str, event_type, record) tuples from a single NDJSON.gz file.
    Skips malformed lines.

    If ``progress`` is given, it is populated with::

        progress["bytes_total"]  # static, size of the .gz file on disk
        progress["bytes_read"]   # incremented as the gzip decoder consumes
                                 #   compressed bytes (jumps in ~8 KB steps,
                                 #   matching the internal gzip read buffer)

    This is the source of truth for "how much of this stream is left" —
    the event-count estimate the heartbeat used pre-2026-06-19 was a
    1MB-sample extrapolation that routinely overshot by 100-300% on
    MCX dates. Compressed file size is exact.
    """
    import io
    try:
        if progress is not None:
            try:
                progress["bytes_total"] = path.stat().st_size
                progress["bytes_read"] = 0
            except OSError:
                pass
        # Open the raw binary file ourselves so we can read .tell() on
        # the compressed stream. ``gzip.open(path, "rt")`` hides the
        # underlying fileobj behind different wrappers depending on
        # Python version — wrapping by hand is portable.
        raw = path.open("rb")
        try:
            gzf = gzip.GzipFile(fileobj=raw, mode="rb")
            try:
                text = io.TextIOWrapper(gzf, encoding="utf-8")
                try:
                    for line in text:
                        line = line.strip()
                        if not line:
                            continue
                        if progress is not None:
                            try:
                                progress["bytes_read"] = raw.tell()
                            except OSError:
                                pass
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
                finally:
                    text.close()
            finally:
                gzf.close()
        finally:
            raw.close()
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
    *,
    bytes_progress: list | None = None,
) -> Generator[dict[str, Any], None, None]:
    """
    Yield all events from the 3 streams in chronological ``recv_ts`` order.

    Args:
        date_folder:    Path to the date folder (e.g. ``data/raw/2026-04-14``).
        instrument:     Instrument key (e.g. ``"nifty50"``).
        logger:         Optional TFALogger instance.
        bytes_progress: Optional mutable list. If given, it is populated
                        with one dict per active stream::

                          [
                            {"path": ..., "bytes_read": N, "bytes_total": M},
                            ...
                          ]

                        The caller reads ``sum(bytes_read) / sum(bytes_total)``
                        from these to render a real progress percentage that
                        never overshoots — replacing the pre-2026-06-19
                        event-count estimate that did (often by 100-300%
                        on MCX dates).

    Yields:
        ``{"type": str, "data": dict}`` dicts in recv_ts order.
    """
    date_folder = Path(date_folder)
    iterators = []

    for suffix, event_type in zip(_FILE_SUFFIXES, _EVENT_TYPES, strict=False):
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
        # Per-stream progress dict; appended to bytes_progress so the
        # caller sees ALL active streams' bytes-read / total.
        stream_progress: dict | None = None
        if bytes_progress is not None:
            stream_progress = {"path": str(path), "bytes_read": 0, "bytes_total": 0}
            bytes_progress.append(stream_progress)
        it = _iter_gz(path, event_type, logger, progress=stream_progress)
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
