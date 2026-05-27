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
import sys
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
    chunk_files: list[Path], final_path: Path
) -> None:
    """Concatenate chunk parquets into one final parquet, write atomically."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    if not chunk_files:
        return
    tables = [pq.read_table(f) for f in chunk_files]
    merged = pa.concat_tables(tables) if len(tables) > 1 else tables[0]
    tmp = final_path.with_suffix(final_path.suffix + ".tmp")
    pq.write_table(merged, tmp)
    tmp.replace(final_path)


def _iter_dates(date_from: str, date_to: str):
    """Yield ISO date strings in [date_from, date_to] inclusive."""
    d = _date.fromisoformat(date_from)
    end = _date.fromisoformat(date_to)
    while d <= end:
        yield d.isoformat()
        d += timedelta(days=1)


def run_one_date(
    base_profile,
    instrument: str,
    date_str: str,
    raw_root: Path,
    features_root: Path,
    validation_root: Path,
    logger=None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> str:
    """
    Replay one date for one instrument.

    Args:
        progress_callback: When non-None, called every ~50k events with a
            dict of ``{event_idx, total_events_est, rate, elapsed_seconds,
            chunk_done, chunks_total_est}``. The legacy single-line ``\\r``
            heartbeat is suppressed in this mode so the parent's dashboard
            owns the display (T47).

    Returns:
        "skip"    — raw data folder missing; not an error
        "fail"    — processing error
        "warn"    — completed but validator returned WARN
        "pass"    — completed successfully
    """
    _has_progress_cb = progress_callback is not None
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
            if not _has_progress_cb:
                print(
                    f"  [{date_str}] {instrument} RESUMING from event "
                    f"{resume_from_idx:,} (warmup re-feeds from {warmup_boundary:,}, "
                    f"next chunk #{next_chunk_num:03d})",
                    flush=True,
                )
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
    if not _has_progress_cb:
        print(
            f"  [{date_str}] processing {instrument}  "
            f"(est. {total_events_est:,} events, ~{total_chunks_est} chunks, "
            f"{chunk_event_threshold:,} ev/chunk)",
            flush=True,
        )
    adapter = ReplayAdapter(profile, date_str, logger=logger)

    # T50 B.3a: install max_pain pre-compute + monkey-patch. No-op when
    # TFA_LEGACY_MAX_PAIN=1 or when chain stream is missing. Always
    # uninstalled in the date-level try/finally below so a crash mid-
    # replay can't leave feature_pipeline.compute_max_pain_features
    # pointing at the cached wrapper for the next date or live mode.
    _max_pain_patch = _max_pain_cache.install(date_folder, instrument)

    # Initial progress ping so the dashboard shows totals before the first
    # heartbeat at event #50,000 (long dates can take seconds to estimate).
    if _has_progress_cb:
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

    try:
        for event in merge_streams(date_folder, instrument, logger=logger):
            event_idx += 1

            # Dashboard heartbeat — fires every 50k events regardless of
            # which resume phase we're in, so a worker that's mid-warmup
            # (re-feeding events to rebuild adapter state) doesn't look
            # frozen at "0 events" on the multi-worker dashboard. The
            # legacy \\r heartbeat below only fires in Phase 3 so its
            # behaviour for single-process replays is unchanged.
            if _has_progress_cb and event_idx % 50_000 == 0:
                _now = time.monotonic()
                _elapsed = _now - t_start
                _rate = event_idx / max(_elapsed, 0.001)
                _phase = "warmup" if (
                    resume_from_idx > 0 and event_idx <= resume_from_idx
                ) else "running"
                try:
                    progress_callback({
                        "event_idx": event_idx,
                        "total_events_est": total_events_est,
                        "rate": _rate,
                        "elapsed_seconds": _elapsed,
                        "chunk_done": max(0, next_chunk_num - 1),
                        "chunks_total_est": total_chunks_est,
                        "phase": _phase,
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

            # Heartbeat every 50k events
            if event_idx % 50_000 == 0:
                now = time.monotonic()
                elapsed = now - t_start
                rate = event_idx / max(elapsed, 0.001)
                # next_chunk_num = chunk we'll write next; completed so far = next_chunk_num-1
                done_chunks = max(0, next_chunk_num - 1)

                if _has_progress_cb:
                    # Dashboard mode (T47) — refresh the "running"-phase
                    # snapshot. Phase-3 heartbeat is the authoritative one;
                    # the warmup-aware heartbeat above keeps the dashboard
                    # alive between Phase-3 events.
                    try:
                        progress_callback({
                            "event_idx": event_idx,
                            "total_events_est": total_events_est,
                            "rate": rate,
                            "elapsed_seconds": elapsed,
                            "chunk_done": done_chunks,
                            "chunks_total_est": total_chunks_est,
                            "phase": "running",
                        })
                    except Exception:
                        pass
                else:
                    # Legacy single-line \r heartbeat — preserved for
                    # single-process invocations (direct module run, tests).
                    if total_chunks_est > 0 and done_chunks <= total_chunks_est:
                        chunk_str = f"chunk {done_chunks}/{total_chunks_est}"
                    elif total_chunks_est > 0:
                        chunk_str = f"chunk {done_chunks} (est. ~{total_chunks_est})"
                    else:
                        chunk_str = f"chunk {done_chunks}"
                    if total_events_est > 0 and event_idx <= total_events_est:
                        pct = 100.0 * event_idx / total_events_est
                        remaining = max(total_events_est - event_idx, 0)
                        eta_s = remaining / max(rate, 1.0)
                        eta_min = eta_s / 60.0
                        sys.stdout.write(
                            f"\r  [{date_str}] {instrument} {event_idx:>10,} ev  "
                            f"({rate:>7,.0f}/s)  {pct:5.1f}%  ETA {eta_min:>5.1f}m  "
                            f"{chunk_str}"
                        )
                    elif total_events_est > 0:
                        sys.stdout.write(
                            f"\r  [{date_str}] {instrument} {event_idx:>10,} ev  "
                            f"({rate:>7,.0f}/s)  100%+ (est. was off)  {chunk_str}"
                        )
                    else:
                        sys.stdout.write(
                            f"\r  [{date_str}] {instrument} {event_idx:>10,} ev  "
                            f"({rate:>7,.0f}/s)  {chunk_str}"
                        )
                    sys.stdout.flush()

            # Chunk-flush check — every N events or X seconds
            if (
                events_since_chunk >= chunk_event_threshold
                or (time.monotonic() - last_chunk_time) >= CHUNK_INTERVAL_SEC
            ):
                _flush_chunk()
    except KeyboardInterrupt:
        # Graceful Ctrl+C: persist whatever's in the buffer so the next
        # invocation resumes from here, then re-raise so the outer date loop
        # and CLI can exit cleanly.
        elapsed = time.monotonic() - t_start
        if not _has_progress_cb:
            print(
                f"\n  [{date_str}] {instrument} INTERRUPTED at event "
                f"{event_idx:,} ({elapsed:.1f}s elapsed). Flushing partial chunk...",
                flush=True,
            )
        try:
            _flush_chunk(force=True)
        except Exception as exc:
            if not _has_progress_cb:
                print(
                    f"  [{date_str}] WARN: partial-flush failed: {exc} — "
                    f"some recent events may be re-processed on resume.",
                    flush=True,
                )
        done_chunks = max(0, next_chunk_num - 1)
        if not _has_progress_cb:
            print(
                f"  [{date_str}] {instrument} state saved ({done_chunks} chunk(s) "
                f"on disk). Re-run the same command to resume.",
                flush=True,
            )
        raise
    except Exception as exc:
        if logger:
            logger.error(
                "REPLAY_STREAM_ERROR",
                msg=f"Stream error on {date_str}: {exc}",
                instrument=instrument,
                date=date_str,
            )
        if _has_progress_cb:
            try:
                progress_callback({"reason": f"stream error: {exc}"})
            except Exception:
                pass
        # Note: progress.json + chunks remain on disk → resumable on next run
        return "fail"

    # Final progress line, then newline before next phase
    elapsed = time.monotonic() - t_start
    if _has_progress_cb:
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
    else:
        print(
            f"\r  [{date_str}] {instrument} {event_idx:>10,} ev in {elapsed:.1f}s. "
            f"Finalising parquet...",
            flush=True,
        )

    adapter.flush_all()

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
            _merge_chunks_to_final(chunk_files, parquet_path)
            for f in chunk_files:
                try: f.unlink()
                except OSError: pass
            try: progress_path.unlink()
            except OSError: pass
        else:
            # No chunks at all (shouldn't happen if we got here) — fall back
            # to direct write of any straggler rows.
            adapter.emitter.write_parquet(parquet_path)
    except Exception as exc:
        if logger:
            logger.error(
                "REPLAY_PARQUET_WRITE_ERROR",
                msg=f"Parquet finalise failed on {date_str}: {exc}",
                instrument=instrument,
                date=date_str,
            )
        if _has_progress_cb:
            try:
                progress_callback({"reason": f"parquet finalise failed: {exc}"})
            except Exception:
                pass
        return "fail"

    # ── Validate ──────────────────────────────────────────────────────────────
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

    if _has_progress_cb and reason_msg:
        try:
            progress_callback({"reason": reason_msg})
        except Exception:
            pass

    if logger:
        logger.info(
            "REPLAY_DATE_COMPLETE",
            msg=f"{instrument} {date_str}: {verdict.upper()} "
            f"({adapter.underlying_tick_count} ticks, "
            f"{event_idx} events)",
            instrument=instrument,
            date=date_str,
            verdict=verdict,
            underlying_ticks=adapter.underlying_tick_count,
            event_count=event_idx,
        )

    # T50 B.3a: uninstall the monkey-patch on the happy path. Early-exit
    # paths (skip/fail returns earlier in this function) intentionally
    # don't call uninstall — the next install() is self-healing and
    # restores the true scalar original before re-patching, so leaks
    # across dates within the same worker can't accumulate.
    _max_pain_cache.uninstall(_max_pain_patch)

    return verdict


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

    return run_one_date(
        base_profile=base_profile,
        instrument=instrument,
        date_str=date_str,
        raw_root=Path(raw_root),
        features_root=Path(features_root),
        validation_root=Path(validation_root),
        logger=log,
        progress_callback=progress_cb,
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

    if include_dates:
        # Explicit per-date selection bypasses the date-range walk AND the
        # checkpoint — the user has chosen exactly what to (re-)replay.
        dates_iter = sorted(set(include_dates))
    else:
        # Respect checkpoint: skip dates already completed
        resume_date = checkpoint.get_resume_date(instrument, date_from)
        dates_iter = list(_iter_dates(resume_date, date_to))

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

    # ── Serial in-process path (workers == 1) ────────────────────────────
    # Single-date replays, tests that monkeypatch `run_one_date` in the
    # parent process, and users who explicitly opt out via --workers 1 all
    # land here. No ProcessPoolExecutor, no dashboard, no spawn — bytewise
    # identical to the pre-T47 behaviour.
    if n_workers == 1:
        for date_str in dates_iter:
            try:
                verdict = run_one_date(
                    base_profile=base_profile,
                    instrument=instrument,
                    date_str=date_str,
                    raw_root=raw_root,
                    features_root=features_root,
                    validation_root=validation_root,
                    logger=logger,
                )
            except KeyboardInterrupt:
                summary["interrupted"] = True
                return summary
            summary[verdict] = summary.get(verdict, 0) + 1
            if verdict in ("pass", "warn", "fail"):
                checkpoint.mark_complete(instrument, date_str)
                if verdict == "fail" and logger:
                    logger.warn(
                        "REPLAY_DATE_FAILED",
                        msg=f"{date_str} completed with FAIL verdict — "
                        f"skipping to next date (partial data saved)",
                        instrument=instrument,
                        date=date_str,
                    )
        return summary

    # ── Parallel fan-out path (workers >= 2) ─────────────────────────────
    saved_env = _apply_blas_thread_caps()
    manager = multiprocessing.Manager()
    progress_dict = manager.dict()
    mp_ctx = multiprocessing.get_context("spawn")

    try:
        with ProgressDashboard(
            instrument=instrument,
            dates=dates_iter,
            workers=n_workers,
            progress_dict=progress_dict,
        ) as dashboard:
            with ProcessPoolExecutor(
                max_workers=n_workers, mp_context=mp_ctx,
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
                        if verdict in ("pass", "warn", "fail"):
                            # Mark all processed dates (including fail) so replay
                            # moves forward. Failed parquet files still exist and
                            # can be retrained on if desired. Filelock inside
                            # ReplayCheckpoint protects the JSON from concurrent
                            # writes (workers finish out of order).
                            checkpoint.mark_complete(instrument, date_str)
                            if verdict == "fail" and logger:
                                logger.warn(
                                    "REPLAY_DATE_FAILED",
                                    msg=f"{date_str} completed with FAIL verdict — "
                                    f"partial data saved",
                                    instrument=instrument,
                                    date=date_str,
                                )
                except KeyboardInterrupt:
                    summary["interrupted"] = True
                    # Cancel any not-yet-started futures so the pool drains
                    # quickly; in-flight workers finish their current chunk
                    # via the existing per-date KeyboardInterrupt path.
                    for f in futures:
                        if not f.done():
                            f.cancel()
                    raise
    finally:
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

    # Print summary
    if summary.get("interrupted"):
        print(f"\nReplay INTERRUPTED for {args.instrument}  "
              f"({args.date_from} → {args.date_to}) — partial state saved.")
        print(f"  PASS : {summary.get('pass', 0)}")
        print(f"  WARN : {summary.get('warn', 0)}")
        print(f"  FAIL : {summary.get('fail', 0)}")
        print(f"  SKIP : {summary.get('skip', 0)}")
        print(f"  Re-run the same command to resume the interrupted date.")
        print()
        sys.exit(130)  # 128 + SIGINT, the standard "interrupted by Ctrl+C" exit code
    print(f"\nReplay complete for {args.instrument}  " f"({args.date_from} → {args.date_to})")
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
