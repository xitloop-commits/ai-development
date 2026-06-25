"""
replay/replay_runner.py — CLI entry for historical replay of TFA feature pipeline.

Phase 14.4 (spec §16.5).

Usage:
    python -m tick_feature_agent.replay.replay_runner \\
        --instrument-profile config/instrument_profiles/nifty50_profile.json \\
        --instrument nifty50 \\
        --date-from 2026-04-01 \\
        --date-to   2026-04-14

For each date in [date_from, date_to]:
  1. Check replay checkpoint — skip if already completed.
  2. Read metadata.json to get date-specific instrument metadata.
  3. Build a date-specific InstrumentProfile (override underlying_symbol / security_id).
  4. Merge streams (stream_merger) → drive ReplayAdapter → write Parquet.
  5. Run feature validator on the output Parquet.
  6. Mark checkpoint on success.

Resumable + chunked replay (added 2026-05-16):
  During each date's processing, the in-memory parquet buffer is flushed to
  numbered chunk files (`<inst>_features_part001.parquet`, `_part002.parquet`,
  ...) every chunk_event_threshold events OR CHUNK_INTERVAL_SEC seconds —
  whichever first. Alongside each chunk, `<inst>_features_progress.json` is
  written atomically with the resume index and progress estimate.

  On restart after a crash, run_one_date detects the progress file, replays
  the raw stream from the start, discards events up to a "warmup boundary"
  earlier than the last chunk index (so the adapter's pending queue is
  reconstructed correctly), discards emitter rows during warmup (they're
  already in chunks), and continues writing new chunks past the last
  saved point.

  Worst-case wasted work on restart: ~CHUNK_INTERVAL_SEC of compute time.
  Was previously: the entire date.

  At successful date completion, all chunks are merged into the single
  canonical `<inst>_features.parquet` and the chunks + progress file are
  deleted. Downstream readers (MTA, SEA, launcher) see no layout change.
"""

from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import signal
import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date as _date
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

# ── Path bootstrap ────────────────────────────────────────────────────────────
_HERE = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

from tick_feature_agent.instrument_profile import ProfileValidationError, load_profile
from tick_feature_agent.recorder.metadata_writer import read_metadata
from tick_feature_agent.replay import max_pain_cache as _max_pain_cache
from tick_feature_agent.replay.checkpoint import ReplayCheckpoint
from tick_feature_agent.replay.progress_dashboard import ProgressDashboard
from tick_feature_agent.replay.replay_adapter import ReplayAdapter
from tick_feature_agent.replay.stream_merger import merge_streams
from tick_feature_agent.validation.feature_validator import validate

# ── T47 parallelism defaults ─────────────────────────────────────────────────
# Default worker count is computed from min(num_dates, DEFAULT_WORKERS_TARGET);
# the hard cap stops a user from pinning every core (and the NVMe) at once.
# Tuned 2026-05-25 against i9-13900K (24c/32t) + NVMe PCIe 4: 16 workers
# saturates the SSD before the CPU. Beyond 20 the gain plateaus.
DEFAULT_WORKERS_TARGET: int = 16
WORKERS_HARD_CAP: int = 20

# ── Chunked-resume tuning constants ─────────────────────────────────────────
# Target ~20 chunk files per date regardless of date size — divide estimated
# total events by CHUNK_DIVISOR. Bounded by CHUNK_EVENT_FLOOR (so tiny
# replays don't flush every few events) and the time-based fallback
# CHUNK_INTERVAL_SEC (so chunks don't fall behind on dull stretches).
CHUNK_DIVISOR: int = 20
CHUNK_EVENT_FLOOR: int = 5_000        # don't flush more often than every 5k events
CHUNK_INTERVAL_SEC: float = 300.0     # 5 minutes — fallback for dull stretches

# Dashboard heartbeat cadence. Dropped from 50k → 10k (2026-06-15) because
# at typical replay rates (~1500 ev/s on heavy MCX dates) 50k means a row
# update every ~30s — long enough for the operator to think the worker
# is frozen. 10k → ~6s between visible ticks, still cheap (~one manager-
# dict write per 6s per worker).
HEARTBEAT_EVERY_EVENTS: int = 10_000

# On resume, re-feed events from (last_chunk_event_idx - WARMUP_EVENT_COUNT)
# so the adapter's pending queue is rebuilt before we start writing again.
# Must be greater than the typical event count spanning the longest target
# window (300s). At ~1000 ev/s typical, 10k events covers ~10 s — but our
# longest window is 300 s, so safer is ~10x: 100k. Set conservatively:
WARMUP_EVENT_COUNT: int = 100_000

# Estimate total events from raw file size sample for progress %. Sample
# the first SAMPLE_BYTES of each raw .ndjson.gz to get average bytes/event.
PROGRESS_SAMPLE_BYTES: int = 1_048_576  # 1 MB


def _estimate_total_events(date_folder: Path, instrument: str) -> int:
    """Rough estimate of total events for (instrument, date) based on raw
    file sizes. Used for percent + ETA display only — never for correctness.

    Method: stream a single pass through the gzip-decompressed bytes,
    tracking (compressed_in, decompressed_out, newlines_seen). After reading
    enough for a stable ratio (~PROGRESS_SAMPLE_BYTES decompressed), compute
    bytes-per-event from newlines, and project total decompressed bytes from
    the measured local compression ratio × the compressed file size.

    Result is normally within ±15%. If gzip ratio varies a lot within the
    file (rare for tick data), the live progress display will overshoot
    100% but correctness is unaffected.
    """
    import gzip
    total = 0
    for pattern in (
        f"{instrument}*underlying*ticks*.ndjson.gz",
        f"{instrument}*option*ticks*.ndjson.gz",
        f"{instrument}*chain*snapshots*.ndjson.gz",
    ):
        for f in date_folder.glob(pattern):
            try:
                compressed_size = f.stat().st_size
                if compressed_size <= 0:
                    continue
                decompressed_bytes = 0
                newlines = 0
                # Read decompressed sample up to PROGRESS_SAMPLE_BYTES,
                # then check the underlying compressed pointer to learn the
                # actual local ratio for THIS file.
                with gzip.open(f, "rb") as gz:
                    while decompressed_bytes < PROGRESS_SAMPLE_BYTES:
                        chunk = gz.read(65536)
                        if not chunk:
                            break
                        decompressed_bytes += len(chunk)
                        newlines += chunk.count(b"\n")
                    # underlying compressed-position lets us compute ratio
                    try:
                        compressed_read = gz.fileobj.tell()  # type: ignore[attr-defined]
                    except (AttributeError, OSError):
                        compressed_read = 0
                if decompressed_bytes == 0 or newlines == 0:
                    continue
                if compressed_read > 0:
                    ratio = decompressed_bytes / compressed_read
                    est_decompressed_total = int(compressed_size * ratio)
                else:
                    # Fallback if we can't read the underlying position —
                    # conservative 8x typical of JSON-over-gzip.
                    est_decompressed_total = compressed_size * 8
                bytes_per_event = max(decompressed_bytes / newlines, 1)
                total += int(est_decompressed_total / bytes_per_event)
            except (OSError, EOFError):
                continue
    return total


def _write_progress_atomic(progress_path: Path, data: dict) -> None:
    """Write progress JSON atomically (write to .tmp, rename). Survives
    a power cut mid-write — either the old file is intact or the new
    file is fully written."""
    tmp = progress_path.with_suffix(progress_path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(progress_path)


def _merge_chunks_to_final(
    chunk_files: list[Path],
    final_path: Path,
    on_progress: Callable[[int, int, str], None] | None = None,
) -> None:
    """Concatenate chunk parquets into one final parquet, write atomically.

    Optional ``on_progress(i, total, stage)`` callback fires at the
    start ("reading"), once polars completes the streaming pass
    ("concat"), and once after the atomic rename ("writing"). The
    previous per-chunk "reading" callbacks are gone — polars handles
    the whole streaming pass as one operation.

    2026-06-19: switched from pyarrow load-all + concat to polars
    ``scan_parquet([files]).sink_parquet(tmp)`` streaming. The old
    path read every chunk parquet into RAM as a pyarrow Table, then
    held BOTH the table list AND the concat result simultaneously
    while writing — peaked at 3–4 GB on crude oil's ~25-chunk days,
    on top of the worker's already-fat steady state. Combined with
    flush_all peak and the targets-cache Polars frames, the worker
    hit 100% RAM and Windows OOM-killed it, losing the operator's
    progress. The streaming path keeps merge memory at ~one row-batch
    (~50-100 MB) regardless of input size. Chunks on disk are still
    only deleted by the caller AFTER the atomic rename succeeds, so
    a mid-merge crash leaves the chunks intact for resume.
    """
    if not chunk_files:
        return
    total = len(chunk_files)
    if on_progress is not None:
        try:
            on_progress(0, total, "reading")
        except Exception:
            pass

    import polars as pl

    tmp = final_path.with_suffix(final_path.suffix + ".tmp")
    # ``scan_parquet`` accepts a list of paths and treats them as one
    # logical lazy frame. ``sink_parquet`` writes incrementally without
    # materialising the full frame.
    pl.scan_parquet([str(f) for f in chunk_files]).sink_parquet(str(tmp))

    if on_progress is not None:
        try:
            on_progress(total, total, "concat")
        except Exception:
            pass
    tmp.replace(final_path)
    if on_progress is not None:
        try:
            on_progress(total, total, "writing")
        except Exception:
            pass


def _iter_dates(date_from: str, date_to: str):
    """Yield ISO date strings in [date_from, date_to] inclusive."""
    d = _date.fromisoformat(date_from)
    end = _date.fromisoformat(date_to)
    while d <= end:
        yield d.isoformat()
        d += timedelta(days=1)


def _resolve_dates_to_process(
    *,
    instrument: str,
    date_from: str,
    date_to: str,
    include_dates: list[str] | None,
    checkpoint,
) -> list[str]:
    """Pure helper (2026-06-14): produce the ordered list of dates that
    ``replay()`` will fan out to the pool, applying all three priority
    rules in one place so the unified single+multi code path stays
    DRY:

      1. ``include_dates`` (per-date picker) wins over the range —
         dedup + sort ascending, bypass the checkpoint entirely.
      2. Otherwise, resume from ``checkpoint.get_resume_date`` so
         already-completed days don't re-run.
      3. Walk every day in ``[resume_date, date_to]`` inclusive.

    Extracted from ``replay()`` so the date-selection contract can be
    tested without spawning a ProcessPoolExecutor and without
    monkey-patching ``run_one_date``. Pre-2026-06-14 the
    ``TestReplayIncludeDates`` cases relied on a serial ``workers=1``
    path that's now gone — they assert against this helper instead.
    """
    if include_dates:
        seen: set[str] = set()
        out: list[str] = []
        for d in include_dates:
            if d not in seen:
                seen.add(d)
                out.append(d)
        out.sort()
        return out
    resume_date = checkpoint.get_resume_date(instrument, date_from)
    return list(_iter_dates(resume_date, date_to))


def _inspect_canonical_parquet(
    features_root: Path, date_str: str, instrument: str,
) -> tuple[bool, int, int | None]:
    """Inspect ``<features_root>/<date>/<inst>_features.parquet`` and
    return ``(exists, size_bytes, row_count_or_None)``.

    Row count is read cheaply from the parquet metadata (no full table
    load); ``None`` if the read fails for any reason — the summary
    falls back to showing just size in that case.
    """
    parquet_path = features_root / date_str / f"{instrument}_features.parquet"
    if not parquet_path.exists():
        return False, 0, None
    try:
        size = parquet_path.stat().st_size
    except OSError:
        return True, 0, None
    rows: int | None = None
    try:
        import pyarrow.parquet as pq
        rows = int(pq.ParquetFile(parquet_path).metadata.num_rows)
    except Exception:
        rows = None
    return True, size, rows


def _print_per_date_summary(
    instrument: str,
    date_from: str,
    date_to: str,
    *,
    features_root: Path,
    checkpoint_path: Path,
    explicit_dates: list[str] | None = None,
) -> None:
    """Print a per-date table + the post-run checkpoint state for one
    instrument. Designed to make a silent partial run obvious — a
    missing parquet shows as ``— no parquet`` so the operator can
    spot it at a glance.

    ``explicit_dates`` overrides the date_from..date_to range when
    provided (used by --include-dates so the table doesn't list
    untouched dates in between the requested ones).
    """
    from tick_feature_agent.replay.checkpoint import ReplayCheckpoint
    dates_iter = (
        sorted(explicit_dates) if explicit_dates is not None
        else list(_iter_dates(date_from, date_to))
    )
    print()
    print(f"Per-date summary for {instrument}:")
    print(f"  {'Date':<11s}  {'Verdict':<7s}  {'Parquet':<20s}  Rows")
    print(f"  {'-' * 11}  {'-' * 7}  {'-' * 20}  {'-' * 12}")
    # ASCII-safe markers — replay can run on a stdout that hasn't been
    # reconfigured to UTF-8 (e.g. start-replay.bat → cmd.exe default
    # cp1252 on Windows). Em-dashes there render as `?` / `�`.
    DASH = "--"
    for date_str in dates_iter:
        exists, size_bytes, rows = _inspect_canonical_parquet(
            features_root, date_str, instrument,
        )
        if exists:
            mb = size_bytes / 1_048_576
            size_str = f"{mb:.1f} MB"
            rows_str = f"{rows:,}" if rows is not None else DASH
            verdict = "DONE"
        else:
            size_str = f"{DASH} no parquet"
            rows_str = DASH
            verdict = "MISSING"
        print(f"  {date_str:<11s}  {verdict:<7s}  {size_str:<20s}  {rows_str}")

    # Post-run checkpoint state — confirms mark_complete actually
    # advanced the pointer. Re-opens the file rather than reusing the
    # ReplayCheckpoint that the worker pool used (which has already
    # been released).
    try:
        cp = ReplayCheckpoint(checkpoint_path)
        entry = cp.get_entry(instrument)
    except Exception as exc:  # noqa: BLE001
        print(f"  Checkpoint  : (read failed: {exc})")
        return
    if entry is None:
        print(f"  Checkpoint  : (no entry yet for {instrument})")
    else:
        last = entry.get("last_completed_date", DASH)
        sessions = entry.get("sessions_completed", DASH)
        print(
            f"  Checkpoint  : last_completed_date={last}  "
            f"sessions_completed={sessions}"
        )
    print()


def run_one_date(
    base_profile,
    instrument: str,
    date_str: str,
    raw_root: Path,
    features_root: Path,
    validation_root: Path,
    logger=None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    stop_check: Callable[[], bool] | None = None,
) -> str:
    """
    Replay one date for one instrument.

    Args:
        progress_callback: Called every ~50k events with a dict of
            ``{event_idx, total_events_est, rate, elapsed_seconds,
            chunk_done, chunks_total_est}``. The pool-worker entry point
            (``_worker_run_one_date``) always installs one that writes
            into the parent's Manager dict; direct callers may omit it
            and a no-op is substituted so the rest of the function can
            call it unconditionally.
        stop_check: Polled at the same 50k-event heartbeat cadence.
            When it returns truthy, the function raises ``KeyboardInterrupt``
            locally so the existing per-date STOPPING → flush → EXITED
            path fires. Workers ignore the parent's SIGINT (see
            ``_worker_sigint_ignore``) so this is how the pool driver
            asks them to stop in-flight. Defaults to a constant-False
            no-op.

    Returns:
        "skip"    — raw data folder missing; not an error
        "fail"    — processing error
        "warn"    — completed but validator returned WARN
        "pass"    — completed successfully
    """
    if progress_callback is None:
        def progress_callback(_payload: dict[str, Any]) -> None:
            return None
    if stop_check is None:
        def stop_check() -> bool:
            return False
    date_folder = raw_root / date_str

    # ── Read metadata ─────────────────────────────────────────────────────────
    meta = read_metadata(date_folder)
    if meta is None:
        if logger:
            logger.info(
                "REPLAY_NO_METADATA",
                msg=f"No metadata for {date_str} — skipping",
                instrument=instrument,
                date=date_str,
            )
        return "skip"

    instrument_meta = meta.get("instruments", {}).get(instrument)
    if instrument_meta is None:
        if logger:
            logger.info(
                "REPLAY_INSTRUMENT_NOT_IN_METADATA",
                msg=f"Instrument {instrument!r} not in metadata for {date_str}",
                instrument=instrument,
                date=date_str,
            )
        return "skip"

    # ── Build date-specific profile ───────────────────────────────────────────
    profile = base_profile.__class__.for_replay_date(base_profile, instrument_meta)

    # ── Chunked-resume + progress setup ──────────────────────────────────────
    out_dir = features_root / date_str
    out_dir.mkdir(parents=True, exist_ok=True)
    parquet_path = out_dir / f"{instrument}_features.parquet"
    progress_path = out_dir / f"{instrument}_features_progress.json"

    resume_from_idx = 0
    warmup_boundary = 0
    next_chunk_num = 1
    if progress_path.exists():
        try:
            prev = json.loads(progress_path.read_text(encoding="utf-8"))
            resume_from_idx = int(prev.get("last_chunk_event_idx", 0))
            next_chunk_num = int(prev.get("chunks_written", 0)) + 1
            warmup_boundary = max(0, resume_from_idx - WARMUP_EVENT_COUNT)
        except (json.JSONDecodeError, OSError, ValueError):
            # Corrupt progress file → fall back to fresh start, leave any
            # stale chunks for cleanup at end.
            resume_from_idx = 0
            warmup_boundary = 0
            next_chunk_num = 1

    total_events_est = _estimate_total_events(date_folder, instrument)
    # Aim for ~CHUNK_DIVISOR chunks per date regardless of size; floor at
    # CHUNK_EVENT_FLOOR events so tiny replays don't flush every few events.
    chunk_event_threshold = max(total_events_est // CHUNK_DIVISOR, CHUNK_EVENT_FLOOR)
    total_chunks_est = (
        max(1, (total_events_est + chunk_event_threshold - 1) // chunk_event_threshold)
        if total_events_est > 0 else 0
    )

    # ── Run replay adapter with chunked writes ──────────────────────────────
    adapter = ReplayAdapter(profile, date_str, logger=logger)

    # T50 B.3a: install max_pain pre-compute + monkey-patch. No-op when
    # TFA_LEGACY_MAX_PAIN=1 or when chain stream is missing. Always
    # uninstalled in the date-level try/finally below so a crash mid-
    # replay can't leave feature_pipeline.compute_max_pain_features
    # pointing at the cached wrapper for the next date or live mode.
    _max_pain_patch = _max_pain_cache.install(date_folder, instrument)
    # T50 B.3e: also pre-compute the cheaper chain-row-derived features
    # (oi_weighted_levels + wall_strength) in the same chain-snapshot
    # iteration. Independent env-var rollback via TFA_LEGACY_CHAIN_FEATURES=1.
    _chain_features_patch = _max_pain_cache.install_chain_features(
        date_folder, instrument,
    )
    # T50 B.3c: side_strengths cache now backed by the Polars-
    # vectorised ``compute_side_strengths_batch`` (shift-over-strike +
    # normalize-within-snapshot via group_by). Build cost dropped to
    # well under the runtime savings, so the install is back on by
    # default. Rollback via TFA_LEGACY_SIDE_STRENGTHS=1.
    _side_strengths_patch = _max_pain_cache.install_side_strengths(
        date_folder, instrument,
    )
    # T50 B.3d: dealer_hedging numpy-vectorised drop-in replacement.
    # Same input signature + output dict; the per-strike BS loop is
    # one numpy pass instead of Python iteration. No cache (per-emit
    # spot dependency makes caching uneconomic). Rollback via
    # TFA_LEGACY_DEALER_HEDGING=1.
    _dealer_hedging_patch = _max_pain_cache.install_dealer_hedging()

    # Initial progress ping so the dashboard shows totals before the first
    # heartbeat at event #50,000 (long dates can take seconds to estimate).
    try:
        progress_callback({
            "event_idx": 0,
            "total_events_est": total_events_est,
            "rate": 0.0,
            "elapsed_seconds": 0.0,
            "chunk_done": next_chunk_num - 1,
            "chunks_total_est": total_chunks_est,
        })
    except Exception:
        pass

    event_idx = 0
    events_since_chunk = 0
    last_chunk_time = time.monotonic()
    t_start = time.monotonic()

    def _flush_chunk(force: bool = False) -> None:
        """Persist current emitter buffer to next chunk file + atomic progress.json."""
        nonlocal next_chunk_num, events_since_chunk, last_chunk_time
        chunk_path = out_dir / (
            f"{instrument}_features_part{next_chunk_num:03d}.parquet"
        )
        rows = adapter.emitter.write_parquet(chunk_path)
        if rows == 0 and not force:
            # Empty buffer; remove empty file we just wrote and skip progress update
            try:
                chunk_path.unlink()
            except OSError:
                pass
            events_since_chunk = 0
            last_chunk_time = time.monotonic()
            return
        progress_data = {
            "instrument": instrument,
            "date": date_str,
            "events_processed": event_idx,
            "events_total_est": total_events_est,
            "percent_est": (
                round(100.0 * event_idx / total_events_est, 2)
                if total_events_est else None
            ),
            "rate_events_per_sec": round(
                event_idx / max(time.monotonic() - t_start, 0.001), 1
            ),
            "elapsed_seconds": round(time.monotonic() - t_start, 1),
            "last_chunk_event_idx": event_idx,
            "chunks_written": next_chunk_num,
            "chunks_total_est": total_chunks_est,
            "schema_version": 1,
            "last_update": datetime.now().isoformat(timespec="seconds"),
        }
        _write_progress_atomic(progress_path, progress_data)
        next_chunk_num += 1
        events_since_chunk = 0
        last_chunk_time = time.monotonic()

    # Bytes-progress (2026-06-19): merge_streams populates one dict per
    # active stream with `bytes_read` / `bytes_total`. The heartbeat
    # aggregates these → real progress percentage that NEVER overshoots
    # 100% — replaces the broken file-size-based event-count estimate
    # that routinely showed `+200%` on MCX dates.
    _bytes_streams: list[dict] = []
    try:
        for event in merge_streams(
            date_folder, instrument, logger=logger,
            bytes_progress=_bytes_streams,
        ):
            event_idx += 1

            # Dashboard heartbeat — fires every HEARTBEAT_EVERY_EVENTS
            # events regardless of which resume phase we're in, so a
            # worker that's mid-warmup (re-feeding events to rebuild
            # adapter state) doesn't look frozen on the multi-worker
            # dashboard.
            if event_idx % HEARTBEAT_EVERY_EVENTS == 0:
                # Pool-driven cooperative cancel: parent sets the stop
                # flag on Ctrl+C; worker raises locally so the existing
                # per-date except KeyboardInterrupt path runs (STOPPING
                # → flush → EXITED → return). Cheaper than a SIGINT
                # round-trip and avoids the queue.get traceback.
                try:
                    _should_stop = stop_check()
                except Exception:
                    _should_stop = False
                if _should_stop:
                    raise KeyboardInterrupt
                _now = time.monotonic()
                _elapsed = _now - t_start
                _rate = event_idx / max(_elapsed, 0.001)
                _phase = "warmup" if (
                    resume_from_idx > 0 and event_idx <= resume_from_idx
                ) else "running"
                _bytes_read = sum(s.get("bytes_read", 0) for s in _bytes_streams)
                _bytes_total = sum(s.get("bytes_total", 0) for s in _bytes_streams)
                try:
                    progress_callback({
                        "event_idx": event_idx,
                        "total_events_est": total_events_est,
                        "rate": _rate,
                        "elapsed_seconds": _elapsed,
                        "chunk_done": max(0, next_chunk_num - 1),
                        "chunks_total_est": total_chunks_est,
                        "phase": _phase,
                        "bytes_read": _bytes_read,
                        "bytes_total": _bytes_total,
                    })
                except Exception:
                    pass

            # Resume mode — three phases:
            #   1. event_idx <= warmup_boundary: skip entirely (already saved
            #      in earlier chunks; adapter doesn't need them to reconstruct
            #      state because they're older than the longest target window).
            #   2. warmup_boundary < event_idx <= resume_from_idx: feed adapter
            #      to rebuild its pending queue, but DISCARD anything the
            #      emitter outputs (those rows are in earlier chunks).
            #   3. event_idx > resume_from_idx: process normally.
            if event_idx <= warmup_boundary:
                continue
            if event_idx <= resume_from_idx:
                adapter.process_event(event)
                # Periodically drain duplicates emitted during warmup
                if event_idx % chunk_event_threshold == 0:
                    adapter.emitter.discard_buffer()
                continue

            # Phase 3 — real processing
            adapter.process_event(event)
            events_since_chunk += 1

            # Heartbeat every 50k events — Phase-3 authoritative refresh
            # of the dashboard "running" snapshot. The warmup-aware
            # heartbeat above keeps the dashboard alive between Phase-3
            # events.
            if event_idx % HEARTBEAT_EVERY_EVENTS == 0:
                now = time.monotonic()
                elapsed = now - t_start
                rate = event_idx / max(elapsed, 0.001)
                done_chunks = max(0, next_chunk_num - 1)
                bytes_read = sum(s.get("bytes_read", 0) for s in _bytes_streams)
                bytes_total = sum(s.get("bytes_total", 0) for s in _bytes_streams)
                try:
                    progress_callback({
                        "event_idx": event_idx,
                        "total_events_est": total_events_est,
                        "rate": rate,
                        "elapsed_seconds": elapsed,
                        "chunk_done": done_chunks,
                        "chunks_total_est": total_chunks_est,
                        "phase": "running",
                        "bytes_read": bytes_read,
                        "bytes_total": bytes_total,
                    })
                except Exception:
                    pass

            # Chunk-flush check — every N events or X seconds
            if (
                events_since_chunk >= chunk_event_threshold
                or (time.monotonic() - last_chunk_time) >= CHUNK_INTERVAL_SEC
            ):
                _flush_chunk()
    except KeyboardInterrupt:
        # Graceful Ctrl+C (2026-06-14): emit phase callbacks so the
        # dashboard shows each date walking RUNNING → STOPPING (red) →
        # EXITED (green) before tearing down. Persist whatever's in
        # the buffer so the next invocation resumes from here, then
        # re-raise so the outer date loop and CLI can exit cleanly.
        # NOTE: ``_emit_phase`` is defined further down, so use the
        # same inline callback pattern the in-loop heartbeats use.
        try:
            progress_callback({"phase": "stopping"})
        except Exception:
            pass
        try:
            _flush_chunk(force=True)
        except Exception:
            # Partial-flush failed; the buffer is lost but earlier
            # chunks are still on disk. Resume will re-feed from the
            # last successful chunk boundary.
            pass
        # Flush succeeded — emit EXITED phase so the dashboard turns the
        # row green. Re-raise after, so the outer drain in `replay()`
        # picks up the future result.
        try:
            progress_callback({"phase": "exited"})
        except Exception:
            pass
        raise
    except Exception as exc:
        if logger:
            logger.error(
                "REPLAY_STREAM_ERROR",
                msg=f"Stream error on {date_str}: {exc}",
                instrument=instrument,
                date=date_str,
            )
        try:
            progress_callback({"reason": f"stream error: {exc}"})
        except Exception:
            pass
        # Note: progress.json + chunks remain on disk → resumable on next run
        return "fail"

    # Final progress line, then newline before next phase
    elapsed = time.monotonic() - t_start
    try:
        progress_callback({
            "event_idx": event_idx,
            "total_events_est": total_events_est,
            "rate": event_idx / max(elapsed, 0.001),
            "elapsed_seconds": elapsed,
            "chunk_done": max(0, next_chunk_num - 1),
            "chunks_total_est": total_chunks_est,
        })
    except Exception:
        pass

    def _emit_phase(phase: str, **extra: Any) -> None:
        """Push a phase update to the dashboard so the post-event-loop
        tail (flush / merge / validate) shows MOVEMENT rather than
        looking frozen at the last in-loop frame. Cheap one-key write
        through the same Manager dict the parent polls.
        """
        try:
            payload = {"phase": phase}
            payload.update(extra)
            progress_callback(payload)
        except Exception:
            pass

    _emit_phase("flushing")

    def _on_flush_progress(rows_done: int, rows_total: int) -> None:
        # Surface batch progress as "flushing N/M rows" so the
        # dashboard ticks while flush_all chews through ~30k pending
        # rows in 500-row chunks. Without this, even with the chunked
        # flush the dashboard sits on a single "flushing pending
        # rows..." label for minutes.
        _emit_phase(
            "flushing",
            chunk_done=rows_done,
            chunks_total_est=rows_total,
        )

    def _on_flush_drain(_n_batches: int) -> None:
        # Defensive: write a chunk parquet mid-flush so the emitter's
        # internal row list doesn't accumulate every flushed row
        # simultaneously (would peak at ~3 GB on a 30k-row flush).
        # Default cadence: every 10 batches × 500 rows = 5000 rows
        # per chunk written here. Tunable via TFA_FLUSH_DRAIN_EVERY_N_BATCHES.
        # `_flush_chunk` returns silently when the buffer is empty so
        # this is idempotent.
        try:
            _flush_chunk()
        except Exception as exc:
            # Don't let a chunk-write failure abort the flush — just
            # log and continue; the final merge will catch up.
            if logger:
                logger.warn(
                    "REPLAY_MID_FLUSH_CHUNK_FAILED",
                    msg=f"Mid-flush chunk write failed on {date_str}: {exc}",
                    instrument=instrument,
                    date=date_str,
                )

    adapter.flush_all(
        flush_progress_callback=_on_flush_progress,
        on_batches_emitted=_on_flush_drain,
    )

    if adapter.underlying_tick_count == 0:
        if logger:
            logger.info(
                "REPLAY_NO_TICKS",
                msg=f"No underlying ticks for {date_str} — skipping",
                instrument=instrument,
                date=date_str,
            )
        # Cleanup: remove any chunks + progress for this aborted attempt
        for f in out_dir.glob(f"{instrument}_features_part*.parquet"):
            try: f.unlink()
            except OSError: pass
        try: progress_path.unlink()
        except OSError: pass
        return "skip"

    # ── Final chunk flush + merge ────────────────────────────────────────────
    try:
        _flush_chunk(force=True)  # write the trailing rows
        chunk_files = sorted(out_dir.glob(f"{instrument}_features_part*.parquet"))
        if chunk_files:
            n_total = len(chunk_files)
            _emit_phase(
                "merging",
                chunk_done=n_total,
                chunks_total_est=n_total,
            )

            def _on_merge_progress(i: int, total: int, stage: str) -> None:
                # Two flavours: reading-N-of-M during the per-file
                # read loop, and concat/writing as separate phase
                # labels. Each fire ticks the dashboard.
                if stage == "reading":
                    _emit_phase(
                        "merging",
                        chunk_done=i,
                        chunks_total_est=total,
                    )
                else:  # "concat" / "writing"
                    _emit_phase(
                        f"merging:{stage}",
                        chunk_done=total,
                        chunks_total_est=total,
                    )

            _merge_chunks_to_final(
                chunk_files, parquet_path,
                on_progress=_on_merge_progress,
            )
            n_chunks_merged = len(chunk_files)
            for f in chunk_files:
                try: f.unlink()
                except OSError: pass
            try: progress_path.unlink()
            except OSError: pass
        else:
            # No chunks at all (shouldn't happen if we got here) — fall back
            # to direct write of any straggler rows.
            adapter.emitter.write_parquet(parquet_path)
            n_chunks_merged = 0
        # Per-date completion is rendered by the parent dashboard
        # row — no print fallback is needed now that every invocation
        # runs through the pool path.
        _ = n_chunks_merged
    except Exception as exc:
        if logger:
            logger.error(
                "REPLAY_PARQUET_WRITE_ERROR",
                msg=f"Parquet finalise failed on {date_str}: {exc}",
                instrument=instrument,
                date=date_str,
            )
        try:
            progress_callback({"reason": f"parquet finalise failed: {exc}"})
        except Exception:
            pass
        return "fail"

    # ── Validate ──────────────────────────────────────────────────────────────
    _emit_phase("validating")
    val_dir = validation_root / date_str
    validation_exc: str | None = None
    try:
        result = validate(parquet_path, instrument, date_str, output_dir=val_dir)
    except Exception as exc:
        if logger:
            logger.error(
                "REPLAY_VALIDATION_ERROR",
                msg=f"Validation error on {date_str}: {exc}",
                instrument=instrument,
                date=date_str,
            )
        result = {"verdict": "fail"}
        validation_exc = f"validator crashed: {exc}"

    verdict = result.get("verdict", "fail").lower()

    # ── Extract non-PASS reasons for the dashboard (T47) ───────────────────
    reason_msg: str | None = None
    if validation_exc:
        reason_msg = validation_exc
    elif verdict in ("warn", "fail"):
        non_pass: list[str] = []
        for layer_name, layer_res in (result.get("layers") or {}).items():
            for check_name, status in (layer_res.get("checks") or {}).items():
                status_str = str(status)
                if not status_str.startswith("PASS"):
                    # Keep each item compact; full detail lives in the
                    # validation JSON on disk for deeper inspection.
                    short = status_str if len(status_str) <= 80 else status_str[:77] + "…"
                    non_pass.append(f"[{layer_name}.{check_name}] {short}")
        if non_pass:
            # First three items — enough to triage at a glance.
            reason_msg = " | ".join(non_pass[:3])
            if len(non_pass) > 3:
                reason_msg += f" (+{len(non_pass) - 3} more)"

    if reason_msg:
        try:
            progress_callback({"reason": reason_msg})
        except Exception:
            pass

    if logger:
        try:
            parquet_bytes = parquet_path.stat().st_size if parquet_path.exists() else 0
        except OSError:
            parquet_bytes = 0
        logger.info(
            "REPLAY_DATE_COMPLETE",
            msg=f"{instrument} {date_str}: {verdict.upper()} "
            f"({adapter.underlying_tick_count} ticks, "
            f"{event_idx} events, parquet {parquet_bytes / 1_048_576:.1f} MB)",
            instrument=instrument,
            date=date_str,
            verdict=verdict,
            underlying_ticks=adapter.underlying_tick_count,
            event_count=event_idx,
            parquet_bytes=parquet_bytes,
        )

    # T50 B.3a + B.3c + B.3d + B.3e: uninstall the monkey-patches on
    # the happy path. Early-exit paths intentionally don't call
    # uninstall — every install() is self-healing and restores the
    # true scalar original before re-patching, so leaks across dates
    # within the same worker can't accumulate.
    _max_pain_cache.uninstall(_max_pain_patch)
    _max_pain_cache.uninstall_chain_features(_chain_features_patch)
    _max_pain_cache.uninstall_side_strengths(_side_strengths_patch)
    _max_pain_cache.uninstall_dealer_hedging(_dealer_hedging_patch)

    # 2026-06-22: emit the terminal status from the WORKER side so the
    # dashboard's row flips to green (pass) / yellow (warn) / red (fail)
    # the instant validation finishes -- no wait for the parent's
    # as_completed → mark_terminal IPC roundtrip. Previously the row
    # could sit at "validating 99.9%" for ~hundreds of ms after the
    # worker already returned, and if the operator pressed Esc inside
    # that window the date appeared "stuck" even though it was fully
    # done on disk. The parent's mark_terminal() call remains as a
    # safety net for the worker-crashed case (where the worker never
    # reaches this line and the future raises instead of returns).
    try:
        progress_callback({"status": verdict})
    except Exception:
        pass

    return verdict


def _should_advance_checkpoint(verdict: str) -> bool:
    """PASS-only checkpoint advance (2026-06-14).

    WARN (validator flagged anomalies — e.g. all-NEUTRAL regime,
    truncated recording day) and FAIL (stream / parquet / validator
    crash) stay un-checkpointed so the next range run auto-retries
    them. Skipped dates that have no raw data don't move the pointer
    either — they were never asked to do anything.

    The operator no longer has to remember which dates need a manual
    ``--include-dates`` re-replay after a partial-failure batch.
    """
    return verdict == "pass"


def _resolve_workers(num_dates: int, requested: int | None) -> int:
    """T47 worker-count policy.

    None / 0 / negative → default ``min(num_dates, DEFAULT_WORKERS_TARGET)``.
    Positive → clamp to ``[1, WORKERS_HARD_CAP]`` AND ``num_dates`` (no point
    spinning up more workers than there are dates to process).
    """
    if num_dates <= 0:
        return 1
    if not requested or requested <= 0:
        return max(1, min(num_dates, DEFAULT_WORKERS_TARGET))
    return max(1, min(requested, WORKERS_HARD_CAP, num_dates))


def _start_esc_watcher(
    stop_event: "threading.Event",
    progress_dict=None,
) -> "threading.Thread | None":
    """Spawn a daemon thread that listens for ESC and triggers a
    graceful drain (2026-06-15, with confirmation added 2026-06-19).

    Why a thread instead of binding ESC at the dashboard layer: rich's
    ``Live`` owns the terminal and won't let us peek at keypresses
    cleanly. Polling ``msvcrt.kbhit`` from a side thread is simpler.

    **Two-press confirmation** (2026-06-19): a single Esc tap is
    surprisingly easy to hit by accident. First Esc → set a banner
    "Press Esc AGAIN within 3 seconds to stop. Any other key to
    continue." in ``progress_dict["__esc_banner__"]``. Second Esc
    within 3s → fire ``os.kill(pid, SIGINT)`` and reuse the existing
    drain path verbatim. Any other key OR 3s timeout → clear the
    banner and continue.

    Windows-only. On non-Windows hosts the function is a no-op so
    import + tests still work.

    Arrow keys send `ESC + [` + letter — we read the second char
    immediately and discard the sequence so arrows don't fake a stop.
    """
    if sys.platform != "win32":
        return None
    try:
        import msvcrt  # noqa: F401  — import at thread start so non-win imports don't fail
    except ImportError:
        return None
    import threading

    _CONFIRM_BANNER = (
        "⚠  Press Esc AGAIN within 3 seconds to STOP the replay. "
        "Any other key to continue."
    )
    _CONFIRM_STYLE = "bold yellow"
    _STOPPING_BANNER = "STOPPING — please wait..."
    _STOPPING_STYLE = "bold red"

    def _set_banner(text: str | None, style: str = "bold yellow") -> None:
        if progress_dict is None:
            return
        try:
            if text is None:
                progress_dict.pop("__esc_banner__", None)
                progress_dict.pop("__esc_banner_style__", None)
            else:
                progress_dict["__esc_banner__"] = text
                progress_dict["__esc_banner_style__"] = style
        except Exception:
            pass

    def _poll() -> None:
        import msvcrt as _mc
        _esc_pending = False
        _esc_pending_until = 0.0
        while not stop_event.is_set():
            try:
                now = time.monotonic()
                # Confirmation window expired — clear pending + banner.
                if _esc_pending and now > _esc_pending_until:
                    _esc_pending = False
                    _set_banner(None)
                if _mc.kbhit():
                    ch = _mc.getch()
                    # Arrow keys + F-keys arrive as `\xe0` or `\x00` +
                    # letter. Discard the follow-up byte for those.
                    if ch in (b"\xe0", b"\x00"):
                        # eat the next byte (the key code)
                        if _mc.kbhit():
                            _mc.getch()
                        if _esc_pending:
                            # Any non-Esc keypress aborts the pending stop.
                            _esc_pending = False
                            _set_banner(None)
                        continue
                    if ch == b"\x1b":  # ESC
                        # Drain a possible follow-up byte (terminal-encoded
                        # ESC [ X sequences for arrows).
                        time.sleep(0.005)
                        if _mc.kbhit():
                            _mc.getch()
                            continue
                        if _esc_pending and now <= _esc_pending_until:
                            # Confirmed stop.
                            _set_banner(_STOPPING_BANNER, _STOPPING_STYLE)
                            try:
                                os.kill(os.getpid(), signal.SIGINT)
                            except Exception:
                                pass
                            return
                        # First Esc — open confirmation window.
                        _esc_pending = True
                        _esc_pending_until = now + 3.0
                        _set_banner(_CONFIRM_BANNER, _CONFIRM_STYLE)
                    else:
                        # Any other key aborts pending stop.
                        if _esc_pending:
                            _esc_pending = False
                            _set_banner(None)
                stop_event.wait(0.05)
            except Exception:
                # Don't let a keyboard glitch kill the dashboard.
                return

    t = threading.Thread(target=_poll, name="replay-esc-watcher", daemon=True)
    t.start()
    return t


def _worker_sigint_ignore() -> None:
    """Initializer for ``ProcessPoolExecutor`` workers (2026-06-14).

    On Ctrl+C, Windows + POSIX consoles deliver SIGINT to EVERY child
    in the same process group, not just the parent. Workers blocked
    in ``multiprocessing.Queue.get()`` (between tasks) raise
    KeyboardInterrupt from inside Python's multiprocessing internals
    and that traceback gets printed verbatim — looks like a crash to
    the operator.

    Telling each worker to IGNORE SIGINT means only the parent receives
    Ctrl+C. The parent then cancels not-yet-started futures via
    ``cancel_futures=True``; in-flight workers continue to their
    per-date KeyboardInterrupt path via the future-cancel signalling.
    Workers idle in queue.get() exit cleanly when the parent shuts
    the pool down through normal channels.
    """
    try:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    except (ValueError, OSError):
        # ``signal.signal`` only works on the main thread of a process,
        # which is what an ``initializer`` runs on. Defensive: don't
        # crash worker startup if some host OS doesn't support it.
        pass


def _apply_blas_thread_caps() -> dict[str, str | None]:
    """Cap BLAS / OMP threads per worker BEFORE spawning the pool.

    Workers spawned with the ``spawn`` start method inherit the parent's
    environment, then re-import numpy / scikit / lightgbm in a fresh
    interpreter — so caps set here propagate cleanly.

    Returns the original values so the caller can restore them after the
    pool drains (avoids polluting the parent process for non-replay work).
    """
    caps = {
        "OPENBLAS_NUM_THREADS": "2",
        "MKL_NUM_THREADS": "2",
        "OMP_NUM_THREADS": "2",
    }
    saved: dict[str, str | None] = {}
    for k, v in caps.items():
        saved[k] = os.environ.get(k)
        os.environ[k] = v
    return saved


def _restore_env(saved: dict[str, str | None]) -> None:
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _worker_run_one_date(
    profile_path: str,
    instrument: str,
    date_str: str,
    raw_root: str,
    features_root: str,
    validation_root: str,
    log_dir: str,
    log_level: str,
    progress_dict,
) -> str:
    """ProcessPoolExecutor entry point — must be top-level / picklable.

    Re-establishes a per-worker logger (each subprocess writes its own log
    file via TFA's log rotation), loads the instrument profile, and runs
    ``run_one_date`` with a progress callback that writes to the manager
    dict that the parent's dashboard polls.
    """
    # Belt-and-braces: the parent already set these before spawning, but
    # honour them in case the spawn context didn't carry the env (e.g.,
    # a future test invocation that constructs the pool directly).
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
    os.environ.setdefault("MKL_NUM_THREADS", "2")
    os.environ.setdefault("OMP_NUM_THREADS", "2")

    from tick_feature_agent.log.tfa_logger import get_logger, setup_logging

    _LEVEL_MAP = {"DEBUG": 10, "INFO": 20, "WARN": 30, "ERROR": 40}
    setup_logging(instrument, log_dir=log_dir, level=_LEVEL_MAP.get(log_level, 20))
    log = get_logger("tfa.replay.worker", instrument=instrument)

    try:
        base_profile = load_profile(Path(profile_path))
    except (FileNotFoundError, ProfileValidationError) as exc:
        log.error(
            "REPLAY_WORKER_PROFILE_ERROR",
            msg=f"Profile load failed in worker for {date_str}: {exc}",
            profile_path=profile_path,
            date=date_str,
        )
        return "fail"

    def progress_cb(data: dict[str, Any]) -> None:
        try:
            # Merge with existing entry instead of overwriting so partial
            # updates (e.g. only `reason` near the end of run_one_date)
            # don't clobber prior heartbeat fields like event_idx / rate.
            merged = dict(progress_dict.get(date_str) or {})
            merged.update(data)
            # Worker is alive until the future resolves; parent's
            # dashboard.mark_terminal sets the final status afterwards.
            merged["status"] = "running"
            progress_dict[date_str] = merged
        except Exception:
            # Manager proxy may be torn down on parent shutdown — ignore.
            pass

    def stop_check() -> bool:
        # Parent sets __stop__ = True on Ctrl+C; worker polls at the
        # 50k-event heartbeat and raises locally so the existing
        # per-date STOPPING / flush / EXITED path runs. Manager-dict
        # read is the cross-process hop — fine at this cadence.
        try:
            return bool(progress_dict.get("__stop__"))
        except Exception:
            return False

    return run_one_date(
        base_profile=base_profile,
        instrument=instrument,
        date_str=date_str,
        raw_root=Path(raw_root),
        features_root=Path(features_root),
        validation_root=Path(validation_root),
        logger=log,
        progress_callback=progress_cb,
        stop_check=stop_check,
    )


def replay(
    profile_path: str | Path,
    instrument: str,
    date_from: str,
    date_to: str,
    raw_root: str | Path = "data/raw",
    features_root: str | Path = "data/features",
    validation_root: str | Path = "data/validation",
    checkpoint_path: str | Path | None = None,
    logger=None,
    include_dates: list[str] | None = None,
    workers: int | None = None,
    log_dir: str = "logs",
    log_level: str = "INFO",
    dashboard_mode_str: str | None = None,
) -> dict:
    """
    Replay all dates in [date_from, date_to] for the given instrument.

    T47 (2026-05-25): fans out across dates via ``ProcessPoolExecutor`` and
    drives a ``rich``-based multi-worker dashboard. Live (recorder) mode is
    untouched — this only affects the replay path.

    Args:
        profile_path:     Path to instrument profile JSON.
        instrument:       Instrument key (e.g. "nifty50").
        date_from:        Start date (inclusive).
        date_to:          End date (inclusive).
        raw_root:         Root directory for recorded raw data.
        features_root:    Root directory for output Parquet files.
        validation_root:  Root directory for validation JSON files.
        checkpoint_path:  Path for replay checkpoint JSON. Default:
                          ``{raw_root}/replay_checkpoint.json``.
        logger:           Optional TFA structured logger.
        include_dates:    When provided, ONLY these dates are replayed
                          (date_from / date_to and the checkpoint are
                          ignored). Used by the launcher's per-date picker.
        workers:          Max concurrent dates (None → auto).
        log_dir:          Per-worker log directory (each subprocess
                          re-initialises logging on startup).
        log_level:        Per-worker log level ("DEBUG"|"INFO"|"WARN"|"ERROR").

    Returns:
        Summary dict with counts of each verdict type plus ``interrupted``
        bool and ``workers`` count.
    """
    raw_root = Path(raw_root)
    features_root = Path(features_root)
    validation_root = Path(validation_root)

    if checkpoint_path is None:
        checkpoint_path = raw_root / "replay_checkpoint.json"
    checkpoint = ReplayCheckpoint(checkpoint_path)

    try:
        base_profile = load_profile(Path(profile_path))
    except (FileNotFoundError, ProfileValidationError) as exc:
        if logger:
            logger.error(
                "REPLAY_PROFILE_ERROR",
                msg=f"Profile load failed: {exc}",
                profile_path=str(profile_path),
            )
        return {"error": str(exc)}

    dates_iter = _resolve_dates_to_process(
        instrument=instrument,
        date_from=date_from,
        date_to=date_to,
        include_dates=include_dates,
        checkpoint=checkpoint,
    )

    n_workers = _resolve_workers(len(dates_iter), workers)
    summary = {
        "pass": 0, "warn": 0, "fail": 0, "skip": 0,
        "interrupted": False, "workers": n_workers,
    }

    if not dates_iter:
        if logger:
            logger.info(
                "REPLAY_NO_DATES",
                msg=f"No dates to replay for {instrument} (checkpoint up to date)",
                instrument=instrument,
            )
        return summary

    # ── Memory headroom pre-flight (2026-06-23, auto-throttle 2026-06-24) ─
    # Cap parallel workers to what fits in available RAM. Excess dates
    # queue inside ProcessPoolExecutor and process serially as workers
    # free up — same end state, no operator intervention. Prevents the
    # 30-min validation-thrash observed on 6-worker MCX crudeoil where
    # each worker ate 6-14 GB and the system swapped. Override with
    # `TFA_SKIP_REPLAY_MEMORY_GUARD=1` to skip the check entirely.
    from tick_feature_agent.replay.memory_guard import resolve_safe_workers
    n_workers = resolve_safe_workers(
        instrument=instrument,
        dates=list(dates_iter),
        n_workers=n_workers,
        raw_root=raw_root,
    )
    summary["workers"] = n_workers  # update with the throttled count

    # ── Unified pool + dashboard path ─────────────────────────────────────
    # 2026-06-14 (Partha): the pre-2026-06-14 serial ``if n_workers == 1:``
    # branch is gone. Single-date replays now go through the same
    # ProcessPoolExecutor + ProgressDashboard as multi-date — worker
    # exceptions (e.g. a corrupt ``.ndjson.gz`` raising ``zlib.error``)
    # now surface as ``mark_terminal("fail")`` on the dashboard instead
    # of a console traceback, and the graceful Ctrl+C drain
    # (STOPPING → EXITED → wait-for-key) applies uniformly. Pool spin-
    # up overhead for a 1-worker pool is ~100-300ms, acceptable given
    # the consistency win.
    saved_env = _apply_blas_thread_caps()
    manager = multiprocessing.Manager()
    progress_dict = manager.dict()
    mp_ctx = multiprocessing.get_context("spawn")

    # ESC-key watcher (2026-06-15): polls msvcrt.kbhit in a daemon
    # thread and fires SIGINT on ESC, which triggers the same graceful
    # drain that Ctrl+C does. Set stop_event before the dashboard
    # tears down so the thread exits on its own.
    _esc_stop_event = threading.Event()
    _esc_thread = _start_esc_watcher(_esc_stop_event, progress_dict)

    try:
        with ProgressDashboard(
            instrument=instrument,
            dates=dates_iter,
            workers=n_workers,
            progress_dict=progress_dict,
            mode_str=dashboard_mode_str,
        ) as dashboard:
            with ProcessPoolExecutor(
                max_workers=n_workers, mp_context=mp_ctx,
                initializer=_worker_sigint_ignore,
            ) as pool:
                futures = {
                    pool.submit(
                        _worker_run_one_date,
                        str(profile_path),
                        instrument,
                        date_str,
                        str(raw_root),
                        str(features_root),
                        str(validation_root),
                        log_dir,
                        log_level,
                        progress_dict,
                    ): date_str
                    for date_str in dates_iter
                }
                try:
                    for fut in as_completed(futures):
                        date_str = futures[fut]
                        worker_reason: str | None = None
                        try:
                            verdict = fut.result()
                        except Exception as exc:
                            if logger:
                                logger.error(
                                    "REPLAY_WORKER_FAILED",
                                    msg=f"Worker for {date_str} crashed: {exc}",
                                    instrument=instrument,
                                    date=date_str,
                                    error=str(exc),
                                )
                            verdict = "fail"
                            worker_reason = f"worker process crashed: {exc}"
                        dashboard.mark_terminal(date_str, verdict, reason=worker_reason)
                        summary[verdict] = summary.get(verdict, 0) + 1
                        if _should_advance_checkpoint(verdict):
                            # Filelock inside ReplayCheckpoint protects
                            # the JSON from concurrent writes (workers
                            # finish out of order).
                            checkpoint.mark_complete(instrument, date_str)
                        elif verdict == "fail" and logger:
                            logger.warn(
                                "REPLAY_DATE_FAILED",
                                msg=f"{date_str} completed with FAIL verdict — "
                                f"checkpoint NOT advanced; next range run will retry",
                                instrument=instrument,
                                date=date_str,
                            )
                except KeyboardInterrupt:
                    summary["interrupted"] = True
                    # 2026-06-14: graceful drain. Workers ignore SIGINT
                    # (see _worker_sigint_ignore initializer); we ask
                    # them to stop in-flight via a cooperative
                    # ``__stop__`` flag on the Manager dict — each
                    # worker's heartbeat polls it and raises its own
                    # KeyboardInterrupt, routing into the existing
                    # per-date STOPPING / flush / EXITED path.
                    progress_dict["__stop__"] = True
                    # 2026-06-15: install SIG_IGN on the PARENT for the
                    # duration of the drain so a SECOND Ctrl+C (operator
                    # getting impatient) doesn't fire — it would
                    # otherwise propagate into the executor's queue-
                    # management-thread join during interpreter
                    # shutdown, printing "Exception ignored on threading
                    # shutdown: KeyboardInterrupt". Restored in the
                    # outer finally so the CLI's R/X menu still works.
                    _prev_sigint = signal.signal(signal.SIGINT, signal.SIG_IGN)
                    if logger:
                        logger.info(
                            "REPLAY_INTERRUPTED_DRAINING",
                            msg="Ctrl+C — set worker stop flag + "
                                "cancelling pending futures + "
                                "waiting for in-flight workers to finalise",
                            instrument=instrument,
                        )
                    # Cancel pending (not-yet-started) futures so the
                    # pool's queue empties immediately.
                    pending = [f for f in futures if not f.running() and not f.done()]
                    for f in pending:
                        f.cancel()
                    in_flight = [f for f in futures if f.running()]
                    # ``wait=False`` so we don't block here; we drain
                    # ``in_flight`` via short-timeout polling below so
                    # the dashboard countdown stays alive.
                    pool.shutdown(wait=False, cancel_futures=True)
                    # 2026-06-19: graceful drain with a HARD timeout +
                    # force-kill of any worker still alive at the end.
                    # Pre-fix the drain would wait forever on a worker
                    # stuck in flush_all / merge / validate — memory
                    # stayed full until the operator closed the .bat
                    # window manually.
                    _DRAIN_TIMEOUT_SEC = 30.0
                    _drain_deadline = time.monotonic() + _DRAIN_TIMEOUT_SEC
                    _completed_futs: set = set()
                    while True:
                        _now = time.monotonic()
                        _secs_left = max(0, int(_drain_deadline - _now))
                        # Update banner with countdown so the operator
                        # can see progress.
                        try:
                            progress_dict["__esc_banner__"] = (
                                f"STOPPING — waiting up to {_secs_left}s "
                                "for workers to finish current chunk..."
                            )
                            progress_dict["__esc_banner_style__"] = "bold red"
                        except Exception:
                            pass
                        # All in-flight either completed or we're past
                        # the deadline → leave loop.
                        _live = [f for f in in_flight if f not in _completed_futs]
                        if not _live or _now >= _drain_deadline:
                            break
                        # Wait up to 1s for the next future to complete;
                        # update banner countdown every second.
                        try:
                            from concurrent.futures import wait as _futwait
                            from concurrent.futures import FIRST_COMPLETED
                            _done, _ = _futwait(
                                _live, timeout=1.0,
                                return_when=FIRST_COMPLETED,
                            )
                        except Exception:
                            _done = set()
                        for fut in _done:
                            _completed_futs.add(fut)
                            date_str = futures[fut]
                            try:
                                verdict = fut.result()
                            except KeyboardInterrupt:
                                verdict = "interrupted"
                            except Exception as exc:
                                if logger:
                                    logger.warn(
                                        "REPLAY_WORKER_DRAIN_ERROR",
                                        msg=f"Worker for {date_str} "
                                            f"errored during drain: {exc}",
                                        instrument=instrument,
                                        date=date_str,
                                    )
                                verdict = "fail"
                            dashboard.mark_terminal(date_str, verdict)
                            summary[verdict] = summary.get(verdict, 0) + 1
                    # Force-kill any worker process that didn't finish
                    # within the deadline. Without this, a hung worker
                    # holds ~3 GB+ of pending state until the OS reaps
                    # it when the parent dies — operator sees "memory
                    # still full" in task manager after Esc.
                    _still_running = [f for f in in_flight if f not in _completed_futs]
                    if _still_running:
                        try:
                            progress_dict["__esc_banner__"] = (
                                f"Force-killing {len(_still_running)} stuck workers "
                                "(memory freeing now)..."
                            )
                        except Exception:
                            pass
                        if logger:
                            logger.warn(
                                "REPLAY_WORKERS_FORCE_KILLED",
                                msg=f"{len(_still_running)} workers did not "
                                    f"finish within {int(_DRAIN_TIMEOUT_SEC)}s; "
                                    "force-killing.",
                                instrument=instrument,
                            )
                        # ProcessPoolExecutor exposes its worker processes
                        # via the private `_processes` dict (PID → Process).
                        # That's stable enough — concurrent.futures has used
                        # it since Python 3.4. Falls back to a no-op if the
                        # attribute is missing in some future version.
                        try:
                            for _proc in list(getattr(pool, "_processes", {}).values()):
                                try:
                                    _proc.terminate()
                                except Exception:
                                    pass
                            time.sleep(0.5)
                            for _proc in list(getattr(pool, "_processes", {}).values()):
                                try:
                                    if _proc.is_alive():
                                        _proc.kill()
                                except Exception:
                                    pass
                        except Exception:
                            pass
                        # Mark the still-running dates as interrupted so
                        # the per-date row turns red instead of staying
                        # forever on its last "running" frame.
                        for fut in _still_running:
                            date_str = futures[fut]
                            dashboard.mark_terminal(date_str, "interrupted")
                            summary["interrupted"] = True
                    try:
                        progress_dict["__esc_banner__"] = (
                            "STOPPED. Dashboard frame below; press any key in the cmd window to close."
                        )
                        progress_dict["__esc_banner_style__"] = "bold green"
                    except Exception:
                        pass
                    # Don't re-raise — see comment in finally below.
    finally:
        # Tell the ESC watcher to stop polling; daemon thread so it
        # would die at interpreter exit anyway, but cleaner to signal
        # explicitly.
        _esc_stop_event.set()
        # Restore SIGINT to the prior handler so the outer CLI's R/X
        # menu and the user's normal Ctrl+C semantics work again. The
        # SIG_IGN was scoped to the drain only.
        try:
            if "_prev_sigint" in locals():
                signal.signal(signal.SIGINT, _prev_sigint)
        except Exception:
            pass
        _restore_env(saved_env)
        try:
            manager.shutdown()
        except Exception:
            pass

    return summary


# ── CLI ───────────────────────────────────────────────────────────────────────


def _cli():
    parser = argparse.ArgumentParser(
        description="TFA Replay Runner — reprocess historical tick data into features"
    )
    parser.add_argument(
        "--instrument-profile",
        required=True,
        help="Path to instrument profile JSON",
    )
    parser.add_argument(
        "--instrument",
        required=True,
        help="Instrument key, e.g. nifty50",
    )
    parser.add_argument(
        "--date-from",
        required=True,
        help="Start date YYYY-MM-DD (inclusive)",
    )
    parser.add_argument(
        "--date-to",
        required=True,
        help="End date YYYY-MM-DD (inclusive)",
    )
    parser.add_argument(
        "--raw-root",
        default="data/raw",
        help="Root directory for raw recorded data (default: data/raw)",
    )
    parser.add_argument(
        "--features-root",
        default="data/features",
        help="Root directory for output Parquet files (default: data/features)",
    )
    parser.add_argument(
        "--validation-root",
        default="data/validation",
        help="Root directory for validation JSON files (default: data/validation)",
    )
    parser.add_argument(
        "--checkpoint",
        default=None,
        help="Path to replay checkpoint JSON (default: {raw-root}/replay_checkpoint.json)",
    )
    parser.add_argument(
        "--log-dir",
        default="logs",
        help="Directory for log files (default: logs/)",
    )
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARN", "ERROR"],
        default="INFO",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        help=(
            f"Max parallel date workers (default: auto = min(num_dates, "
            f"{DEFAULT_WORKERS_TARGET}); hard cap {WORKERS_HARD_CAP}). Set to "
            "1 for serial replay (legacy behaviour)."
        ),
    )
    args = parser.parse_args()

    from tick_feature_agent.log.tfa_logger import get_logger, setup_logging

    _level_map = {"DEBUG": 10, "INFO": 20, "WARN": 30, "ERROR": 40}
    setup_logging(
        args.instrument,
        log_dir=args.log_dir,
        level=_level_map.get(args.log_level, 20),
    )
    log = get_logger("tfa.replay", instrument=args.instrument)

    summary = replay(
        profile_path=args.instrument_profile,
        instrument=args.instrument,
        date_from=args.date_from,
        date_to=args.date_to,
        raw_root=args.raw_root,
        features_root=args.features_root,
        validation_root=args.validation_root,
        checkpoint_path=args.checkpoint,
        logger=log,
        workers=args.workers,
        log_dir=args.log_dir,
        log_level=args.log_level,
    )

    # Print per-date verdict table + tally + checkpoint state so the
    # operator can see at a glance which dates actually finished, which
    # files exist on disk, and where the checkpoint now sits. Without
    # this the only signal was a 4-line PASS/WARN/FAIL/SKIP tally —
    # easy to mistake a silent partial run (kill mid-merge) for full
    # completion. Reads happen AFTER the dashboard exits so prints
    # don't fight with `rich.live.Live`.
    _print_per_date_summary(
        args.instrument,
        args.date_from,
        args.date_to,
        features_root=Path(args.features_root),
        checkpoint_path=Path(args.checkpoint),
    )

    if summary.get("interrupted"):
        print(f"Replay INTERRUPTED for {args.instrument}  "
              f"({args.date_from} → {args.date_to}) — partial state saved.")
        print(f"  PASS : {summary.get('pass', 0)}")
        print(f"  WARN : {summary.get('warn', 0)}")
        print(f"  FAIL : {summary.get('fail', 0)}")
        print(f"  SKIP : {summary.get('skip', 0)}")
        print(f"  Re-run the same command to resume the interrupted date.")
        print()
        sys.exit(130)  # 128 + SIGINT, the standard "interrupted by Ctrl+C" exit code
    print(f"Replay complete for {args.instrument}  "
          f"({args.date_from} → {args.date_to})")
    print(f"  PASS : {summary.get('pass', 0)}")
    print(f"  WARN : {summary.get('warn', 0)}")
    print(f"  FAIL : {summary.get('fail', 0)}")
    print(f"  SKIP : {summary.get('skip', 0)}")
    print()

    exit_code = 0 if summary.get("fail", 0) == 0 else 1
    sys.exit(exit_code)


if __name__ == "__main__":
    try:
        _cli()
    except KeyboardInterrupt:
        # Outermost safety net — Ctrl+C lands here if it slips past the
        # in-process handlers. Offer R(estart) / X(exit) so users can pick
        # up code changes without manually relaunching the bat wrapper.
        from _shared.restart_prompt import prompt_restart_or_exit
        sys.exit(prompt_restart_or_exit("Replay"))
