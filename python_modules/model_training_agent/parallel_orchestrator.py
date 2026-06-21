"""
parallel_orchestrator.py — Multi-instrument concurrent training
(Phase 1b, 2026-06-20).

Until Phase 1b, training 4 instruments (nifty50, banknifty, crudeoil,
naturalgas) meant 4 serial CLI calls. With Phase 5's BLAS thread caps
landed, each instrument's training is contention-safe to run concurrently;
this orchestrator wraps that in a ProcessPoolExecutor so all instruments
fit and finish in roughly the wall-clock of a single one.

Design choices (v1 — minimal):
  * One worker process per instrument. Spawned via stdlib
    ProcessPoolExecutor (Windows-safe `spawn` start method).
  * Each worker runs with `TFA_LEGACY_TRAIN_UI=1` so the per-instrument
    rich.Live dashboard is OFF — four Live instances in one terminal
    would fight over the alt-screen. Workers fall back to plain stdout
    prints.
  * Each worker's stdout is prefixed with `[<instrument>]` so the
    parent terminal can read the interleaved logs cleanly.
  * LightGBM thread count per worker is `max(1, cpu_count // N)` so 4
    workers on an 8-core host get 2 cores each — no oversubscription.
    BLAS pools (OMP/MKL/OPENBLAS) are pinned to 1 per worker (LightGBM
    handles its own threading; BLAS oversubscription is the real risk).
  * Esc in the parent is handled by the existing esc_watcher: on
    confirmed-stop, SIGINT broadcasts to every worker PID; each
    worker's `train_instrument` already has try/except KeyboardInterrupt
    handling (Phase 2).
  * Returns a dict keyed by instrument with either a TrainResult (success)
    or an error string (failure). The orchestrator never raises; the
    operator inspects the result map.

NOT done in v1 (future Phase 1b expansion if needed):
  * Multi-row rich.Live dashboard with cross-instrument aggregation.
  * Worker-side progress events via multiprocessing.Queue.
  * Mid-run worker death recovery / restart.
"""
from __future__ import annotations

import os
import signal
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any


def _decide_threads_per_worker(n_workers: int) -> int:
    """Return `max(1, cores // n_workers)` so workers don't oversubscribe.

    Phase 5 already caps BLAS thread pools at 1; this controls
    LightGBM's OpenMP pool which is the heavier consumer.
    """
    cores = os.cpu_count() or 1
    return max(1, cores // max(1, n_workers))


def _install_stdout_prefix(instrument: str) -> None:
    """Wrap sys.stdout so every write line gets `[instrument]` prepended.

    Called once at worker entry. The parent terminal shows interleaved
    output but each line is attributable to a specific instrument's
    training so operators can follow progress.
    """
    original = sys.stdout
    prefix = f"[{instrument}] "

    class _Prefixed:
        def write(self, s: str) -> int:
            if not s:
                return 0
            # Walk line-by-line; preserve trailing chunks that don't end in \n.
            parts = s.split("\n")
            out: list[str] = []
            for i, p in enumerate(parts):
                is_last = (i == len(parts) - 1)
                if p == "" and is_last:
                    # trailing newline already added below
                    continue
                if p == "":
                    out.append("")
                else:
                    out.append(prefix + p)
            joiner = "\n"
            written = joiner.join(out)
            if s.endswith("\n"):
                written += "\n"
            return original.write(written)

        def flush(self) -> None:
            original.flush()

        def isatty(self) -> bool:
            return original.isatty()

    sys.stdout = _Prefixed()  # type: ignore[assignment]


def _train_one_instrument_worker(
    instrument: str,
    train_kwargs: dict[str, Any],
    threads_per_worker: int,
) -> dict[str, Any]:
    """Worker entry point. Runs in a spawned subprocess.

    Returns a status dict::

        {"instrument": str, "ok": bool, "timestamp": str|None,
         "output_dir": str|None, "error": str|None,
         "feature_count": int|None, "n_metrics": int|None}

    No exceptions cross the process boundary — failures are captured into
    `error` so the parent can summarise all instruments uniformly.
    """
    # Environment knobs set BEFORE LightGBM / numpy import. Pinning the
    # BLAS pools prevents preprocessing from spawning N×cores threads per
    # worker; OMP_NUM_THREADS caps LightGBM's own OpenMP pool.
    os.environ.setdefault("OMP_NUM_THREADS", str(threads_per_worker))
    os.environ.setdefault("MKL_NUM_THREADS", "1")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    # Force legacy text output — multiple rich.Live dashboards in the same
    # terminal would clobber each other's alt-screen state.
    os.environ["TFA_LEGACY_TRAIN_UI"] = "1"

    _install_stdout_prefix(instrument)

    # Path bootstrap so subprocess can find sibling modules.
    here = Path(__file__).resolve().parent
    python_modules = here.parent
    if str(python_modules) not in sys.path:
        sys.path.insert(0, str(python_modules))

    from model_training_agent.trainer import train_instrument

    # Auto-detect resumable run per instrument (2026-06-21). Each worker
    # owns its own instrument's resume state, so parallel mode mirrors
    # the single-instrument CLI behavior. `auto_resume=False` lets the
    # caller suppress (set when `--fresh` is on at the CLI level).
    auto_resume = train_kwargs.pop("_auto_resume", True)
    if auto_resume and train_kwargs.get("resume_dir") is None:
        from model_training_agent.checkpoint import find_resumable_run_dir
        from pathlib import Path as _Path
        _models_root = train_kwargs.get("models_root") or _Path("models")
        _resume = find_resumable_run_dir(instrument, _Path(_models_root))
        if _resume is not None:
            print(f"  Auto-resume: picking up at {_resume.name}")
            train_kwargs["resume_dir"] = _resume

    try:
        result = train_instrument(instrument=instrument, **train_kwargs)
        return {
            "instrument": instrument,
            "ok": True,
            "timestamp": result.timestamp,
            "output_dir": str(result.output_dir),
            "feature_count": result.feature_count,
            "n_metrics": len(result.metrics),
            "error": None,
        }
    except KeyboardInterrupt:
        return {
            "instrument": instrument,
            "ok": False,
            "error": "KeyboardInterrupt (stopped via Esc)",
            "timestamp": None, "output_dir": None,
            "feature_count": None, "n_metrics": None,
        }
    except Exception as exc:  # noqa: BLE001 — must capture for the parent
        return {
            "instrument": instrument,
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "timestamp": None, "output_dir": None,
            "feature_count": None, "n_metrics": None,
        }


def train_multiple_instruments(
    instruments: list[str],
    train_kwargs: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """Train N instruments concurrently. Returns a dict keyed by
    instrument with the per-worker status dict from
    ``_train_one_instrument_worker``.

    ``train_kwargs`` is forwarded to each worker's
    ``trainer.train_instrument()`` call verbatim. The `instrument` key
    is added by the worker — don't pass it here.

    Esc handling: the orchestrator installs the same two-press Esc
    watcher the trainer uses (no banner — there's no rich dashboard).
    On confirmed-stop, SIGINT broadcasts to every worker PID; each
    worker's existing KeyboardInterrupt handling closes cleanly and
    returns an error status.
    """
    if not instruments:
        return {}

    n_workers = len(instruments)
    threads_per_worker = _decide_threads_per_worker(n_workers)

    print()
    print("  " + "=" * 56)
    print(f"   MTA — parallel training: {n_workers} instruments")
    print(f"   instruments:  {', '.join(instruments)}")
    print(
        f"   layout:       {n_workers} workers × {threads_per_worker} "
        f"LightGBM threads each (BLAS pools pinned at 1)"
    )
    print("  " + "=" * 56)
    print()

    # Phase 2 (carry-over): start the Esc watcher in the PARENT process.
    # Confirmed-stop here triggers SIGINT in the parent, which the broadcast
    # block below propagates to every worker before re-raising.
    from model_training_agent.esc_watcher import start_esc_watcher
    esc_stop_event, _ = start_esc_watcher(set_banner=None)

    results: dict[str, dict[str, Any]] = {}
    started = time.monotonic()
    executor: ProcessPoolExecutor | None = None
    try:
        executor = ProcessPoolExecutor(max_workers=n_workers)
        futures = {
            executor.submit(
                _train_one_instrument_worker,
                instrument, train_kwargs, threads_per_worker,
            ): instrument
            for instrument in instruments
        }
        for fut in as_completed(futures):
            inst = futures[fut]
            try:
                results[inst] = fut.result()
            except Exception as exc:  # noqa: BLE001
                results[inst] = {
                    "instrument": inst,
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "timestamp": None, "output_dir": None,
                    "feature_count": None, "n_metrics": None,
                }
            r = results[inst]
            if r["ok"]:
                print(
                    f"  [{inst}] DONE  metrics={r['n_metrics']}  "
                    f"output={r['output_dir']}"
                )
            else:
                print(f"  [{inst}] FAILED  {r['error']}")
    except KeyboardInterrupt:
        # Confirmed Esc — broadcast SIGINT to every alive worker so each
        # gets a chance to write its partial checkpoint, then await them.
        print()
        print("  PARENT: Esc-stop confirmed; broadcasting SIGINT to workers...")
        if executor is not None:
            for proc in getattr(executor, "_processes", {}).values():
                try:
                    os.kill(proc.pid, signal.SIGINT)
                except (OSError, AttributeError):
                    pass
            executor.shutdown(wait=True, cancel_futures=True)
        # Collect any results that landed before the broadcast.
        raise
    finally:
        if esc_stop_event is not None:
            try:
                esc_stop_event.set()
            except Exception:
                pass
        if executor is not None:
            try:
                executor.shutdown(wait=True)
            except Exception:
                pass

    elapsed = time.monotonic() - started
    n_ok = sum(1 for r in results.values() if r["ok"])
    print()
    print("  " + "=" * 56)
    print(
        f"   Parallel training: {n_ok}/{n_workers} succeeded "
        f"in {int(elapsed)}s"
    )
    print("  " + "=" * 56)
    print()
    return results


__all__ = [
    "train_multiple_instruments",
    "_decide_threads_per_worker",
]
