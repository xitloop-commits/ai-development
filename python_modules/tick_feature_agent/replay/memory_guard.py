"""
memory_guard.py — Pre-flight memory-headroom check for replay
(2026-06-23, mirrors the MTA Phase F guard at
``python_modules/model_training_agent/memory_guard.py``).

Refuses to spawn replay workers when the projected combined peak
working set won't fit in available RAM. The operator gets a clear
error + suggested ``--workers N`` value instead of a 30-minute
swap-thrash stall (real observation: 6 MCX workers on crudeoil ate
22.5 GB of a 32 GB box, validation took 30+ min instead of 2-10 sec
because every alloc hit the pagefile).

Estimation heuristic
--------------------
Per-worker peak is NOT raw-ndjson-decompressed-in-memory -- the worker
streams ticks through the feature pipeline, only the ADAPTER STATE
(chain snapshot cache, running calculations, output buffer pending
flush) sticks around. Empirical per-instrument ceilings from the
2026-06-23 thrash event:

    NSE 6-hr session  (nifty50, banknifty)   →  ~3-4 GB per worker
    MCX 15-hr session (crudeoil, naturalgas) →  ~6-10 GB per worker

Hardcoded constants below pick the high end (conservative) so we
refuse runs that would JUST fit but leave no margin for the OS +
file cache.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# Per-worker peak working-set ceilings (empirical, GB). Pick the
# high end of observed variation so the guard errs on the safe side.
#
# MCX values bumped 2026-07-02 from 10.0 -> 14.0 after crude oil
# 2026-06-11 (227 chunks) + 2026-06-12 (192 chunks) OOM-killed both
# workers mid-merge with 2 parallel workers at 10 GB budgeting. The
# 10 GB constant was empirical for the event-loop steady-state only;
# on 200+ chunk MCX days the merge phase adds another 3-4 GB of
# transient pressure (pyarrow ParquetWriter row-group metadata + one
# decompressed chunk table) on TOP of the still-live adapter state.
# 14 GB reflects the true peak: 10 (steady) + 4 (merge overhead) with
# a small margin. Consequence: on a 32 GB box with ~20 GB free, the
# guard now throttles to 1 crudeoil/naturalgas worker instead of 2 --
# 2x wall-clock, but zero OOM. If Q1 gets a 64 GB box we can retire
# the throttle and both dates run parallel again.
_PER_WORKER_PEAK_GB = {
    "nifty50": 4.0,
    "banknifty": 4.0,
    "crudeoil": 14.0,
    "naturalgas": 14.0,
}
_DEFAULT_PEAK_GB = 6.0  # unknown instrument → middle ground

_SAFETY_MARGIN_GB = 2.0  # keep OS + IDE breathing room


@dataclass(frozen=True)
class ReplayHeadroomCheck:
    """Per-instrument result for a planned replay run."""
    instrument: str
    n_workers: int
    n_dates: int
    max_raw_gz_bytes: int
    estimated_peak_per_worker_bytes: int
    estimated_peak_total_bytes: int
    available_bytes: int
    total_bytes: int
    headroom_ok: bool

    @property
    def peak_per_worker_gb(self) -> float:
        return self.estimated_peak_per_worker_bytes / (1024 ** 3)

    @property
    def peak_total_gb(self) -> float:
        return self.estimated_peak_total_bytes / (1024 ** 3)

    @property
    def available_gb(self) -> float:
        return self.available_bytes / (1024 ** 3)

    @property
    def total_gb(self) -> float:
        return self.total_bytes / (1024 ** 3)

    @property
    def max_safe_workers(self) -> int:
        """How many workers would JUST fit, given current free RAM."""
        if self.estimated_peak_per_worker_bytes <= 0:
            return self.n_workers
        budget = max(0, self.available_bytes
                     - int(_SAFETY_MARGIN_GB * (1024 ** 3)))
        return max(1, budget // self.estimated_peak_per_worker_bytes)


def _max_raw_gz_size(instrument: str, dates: list[str],
                     raw_root: Path) -> int:
    """Return the largest single .ndjson.gz file size across all dates
    for this instrument. Reported in the diagnostic only -- not used
    for the peak estimate (empirical per-instrument constants are
    more accurate than gz-size heuristics)."""
    max_bytes = 0
    for d in dates:
        day_dir = raw_root / d
        if not day_dir.is_dir():
            continue
        for f in day_dir.glob(f"{instrument}*.ndjson.gz"):
            try:
                sz = f.stat().st_size
                if sz > max_bytes:
                    max_bytes = sz
            except OSError:
                continue
    return max_bytes


def check_headroom(
    instrument: str,
    dates: list[str],
    n_workers: int,
    raw_root: Path,
) -> ReplayHeadroomCheck:
    """Compute the headroom check for a planned replay run.

    Falls back to ``headroom_ok=True`` when psutil isn't importable
    (rare on Windows but defensive).
    """
    max_gz = _max_raw_gz_size(instrument, dates, raw_root)
    per_worker_gb = _PER_WORKER_PEAK_GB.get(instrument, _DEFAULT_PEAK_GB)
    peak_per_worker = int(per_worker_gb * (1024 ** 3))
    peak_total = peak_per_worker * max(1, n_workers)
    try:
        import psutil
        vm = psutil.virtual_memory()
        available = int(vm.available)
        total = int(vm.total)
    except Exception:
        return ReplayHeadroomCheck(
            instrument=instrument, n_workers=n_workers, n_dates=len(dates),
            max_raw_gz_bytes=max_gz,
            estimated_peak_per_worker_bytes=peak_per_worker,
            estimated_peak_total_bytes=peak_total,
            available_bytes=2**62, total_bytes=2**62,
            headroom_ok=True,
        )
    budget = available - int(_SAFETY_MARGIN_GB * (1024 ** 3))
    return ReplayHeadroomCheck(
        instrument=instrument, n_workers=n_workers, n_dates=len(dates),
        max_raw_gz_bytes=max_gz,
        estimated_peak_per_worker_bytes=peak_per_worker,
        estimated_peak_total_bytes=peak_total,
        available_bytes=available, total_bytes=total,
        headroom_ok=peak_total <= budget,
    )


def resolve_safe_workers(
    *,
    instrument: str,
    dates: list[str],
    n_workers: int,
    raw_root: Path,
) -> int:
    """Return a worker count that fits the current free RAM, queueing
    excess dates to be processed in batches by ProcessPoolExecutor's
    built-in scheduler.

    Behaviour:
      * If requested ``n_workers`` already fits → return it unchanged.
      * If it doesn't fit → silently cap to ``max_safe_workers`` and
        print a one-block notice explaining what the operator asked for
        vs what's running. Dates beyond the first batch wait in the
        pool's queue and start as workers free up.
      * If even 1 worker won't fit (system absolutely starved) → still
        return 1 with a STRONG warning; the worker may fail mid-run
        but we refuse to silently lock up.
      * ``TFA_SKIP_REPLAY_MEMORY_GUARD=1`` env var bypasses all checks
        and returns ``n_workers`` verbatim.

    (Renamed 2026-06-24 from ``assert_headroom_or_advise`` which used
    to RAISE on insufficient headroom. Refusal was rude when the
    pool can simply queue and process serially — same end-state,
    no operator action required. The diagnostic block is preserved
    but framed as a notice, not an error.)
    """
    if os.environ.get(
            "TFA_SKIP_REPLAY_MEMORY_GUARD", "").strip() in ("1", "true", "True"):
        return n_workers

    check = check_headroom(instrument, dates, n_workers, raw_root)
    if check.headroom_ok:
        return n_workers

    safe = max(1, check.max_safe_workers)
    print()
    print("  " + "=" * 60)
    print(f"   REPLAY MEMORY: AUTO-THROTTLING worker count")
    print(f"   instrument: {instrument}   dates: {len(dates)}")
    print(f"   requested workers: {n_workers}   →   running with: {safe}")
    print(f"   remaining dates queue automatically (batched by the pool)")
    print("  " + "=" * 60)
    print(f"   biggest raw .gz on disk:  {check.max_raw_gz_bytes / (1024**2):>6.0f} MB")
    print(f"   est. peak per worker:     {check.peak_per_worker_gb:>6.1f} GB")
    print(f"   if we ran all {n_workers}:        {check.peak_total_gb:>6.1f} GB needed")
    print(f"   currently available:      {check.available_gb:>6.1f} GB")
    print(f"   running batch peak:       ~{safe * check.peak_per_worker_gb:>6.1f} GB"
          f"  (fits)")
    print()
    if safe == 1 and check.peak_per_worker_gb > check.available_gb:
        print("  WARNING: even 1 worker may exceed free RAM. Run is starting")
        print("  anyway -- close apps if you see swap thrashing or OOM kills.")
        print()
    print("  To bypass throttling (advanced, may crash):")
    print("    set TFA_SKIP_REPLAY_MEMORY_GUARD=1   (Windows)")
    print("    export TFA_SKIP_REPLAY_MEMORY_GUARD=1   (POSIX)")
    print()
    return safe


# Back-compat shim. Old callers that imported assert_headroom_or_advise
# still work; they just get the auto-throttle behaviour now. The return
# value is ignored by the old call sites (which used None-returning
# semantics). New callers should use ``resolve_safe_workers`` directly.
def assert_headroom_or_advise(
    *,
    instrument: str,
    dates: list[str],
    n_workers: int,
    raw_root: Path,
) -> int:
    """Deprecated alias for ``resolve_safe_workers`` (2026-06-24).
    Returns the safe worker count instead of raising.
    """
    return resolve_safe_workers(
        instrument=instrument, dates=dates,
        n_workers=n_workers, raw_root=raw_root,
    )


__all__ = [
    "ReplayHeadroomCheck",
    "check_headroom",
    "resolve_safe_workers",
    "assert_headroom_or_advise",
]
