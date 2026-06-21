"""
memory_guard.py — Pre-flight memory-headroom check for the trainer
(Phase F, 2026-06-21).

Refuses to start a training run when there's not enough free RAM to
hold the estimated peak working set, so the operator gets a clear
error (with a recommended action) instead of a deep-stack
ArrayMemoryError after an hour of CV.

Estimation heuristic
--------------------
Peak working set ≈ row_count × feature_count × 4 bytes × SAFETY_FACTOR

Why × 4 bytes: features ship as float32 once preprocessed.
Why × SAFETY_FACTOR (default 5): the trainer holds the base train
matrix + the val matrix + one per-target X_tr/X_va copy at a time
(Phase A lazy fit_jobs) + LightGBM internals + pandas / numpy
intermediate buffers + garbage that hasn't been gc'd yet. 5× is
intentionally generous; better to abort upfront than OOM at fold 4.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


_DEFAULT_SAFETY_FACTOR = 5.0
_BYTES_PER_FLOAT32 = 4


@dataclass(frozen=True)
class HeadroomCheck:
    """Result of a headroom check."""
    estimated_peak_bytes: int
    available_bytes: int
    total_bytes: int
    headroom_ok: bool
    margin_bytes: int  # negative when we're underwater

    @property
    def estimated_peak_gb(self) -> float:
        return self.estimated_peak_bytes / (1024 ** 3)

    @property
    def available_gb(self) -> float:
        return self.available_bytes / (1024 ** 3)

    @property
    def total_gb(self) -> float:
        return self.total_bytes / (1024 ** 3)


def check_headroom(
    row_count: int,
    feature_count: int,
    *,
    safety_factor: float = _DEFAULT_SAFETY_FACTOR,
) -> HeadroomCheck:
    """Return a HeadroomCheck for the given dataset shape.

    Falls back to ``headroom_ok=True`` when psutil isn't importable
    (don't block training because of a missing optional dep).
    """
    estimated = int(row_count * feature_count * _BYTES_PER_FLOAT32 * safety_factor)
    try:
        import psutil
        vm = psutil.virtual_memory()
        available = int(vm.available)
        total = int(vm.total)
    except Exception:
        # Optional dep missing or platform doesn't support psutil: pass.
        return HeadroomCheck(
            estimated_peak_bytes=estimated,
            available_bytes=2**62,  # sentinel "unknown but treat as huge"
            total_bytes=2**62,
            headroom_ok=True,
            margin_bytes=2**62,
        )
    margin = available - estimated
    return HeadroomCheck(
        estimated_peak_bytes=estimated,
        available_bytes=available,
        total_bytes=total,
        headroom_ok=margin > 0,
        margin_bytes=margin,
    )


def format_check(check: HeadroomCheck) -> list[str]:
    """Build a multi-line operator-friendly summary."""
    lines = [
        f"   est. peak working set:  {check.estimated_peak_gb:>6.1f} GB",
        f"   currently available:    {check.available_gb:>6.1f} GB",
        f"   system total:           {check.total_gb:>6.1f} GB",
    ]
    if check.headroom_ok:
        lines.append(f"   headroom:               {check.margin_bytes / (1024**3):>6.1f} GB OK")
    else:
        deficit = -check.margin_bytes / (1024 ** 3)
        lines.append(f"   deficit:                {deficit:>6.1f} GB short")
    return lines


def assert_headroom_or_advise(
    *,
    instrument: str,
    row_count: int,
    feature_count: int,
    is_parallel_mode: bool,
) -> None:
    """Refuse to start training when projected peak exceeds available
    RAM. Prints a clear diagnostic + recommends an action. Raises
    RuntimeError on insufficient headroom so the CLI / orchestrator
    can surface a clean error rather than crashing mid-run.

    Override: setting `TFA_SKIP_MEMORY_GUARD=1` in the env bypasses
    the check (escape hatch for unusual setups, debugging, etc.).
    """
    if os.environ.get("TFA_SKIP_MEMORY_GUARD", "").strip() in ("1", "true", "True"):
        return
    check = check_headroom(row_count, feature_count)
    if check.headroom_ok:
        return

    print()
    print("  " + "=" * 56)
    print(f"   MEMORY HEADROOM CHECK FAILED -- training refused")
    print(f"   instrument: {instrument}  ({row_count:,} rows × {feature_count} features)")
    print("  " + "=" * 56)
    for line in format_check(check):
        print(line)
    print()
    print("  Recommended actions (any one will let training start):")
    if is_parallel_mode:
        print("    1. Run instruments SERIALLY instead of parallel:")
        print(f"         drop --instruments, use --instrument {instrument}")
    print("    2. Close other RAM-heavy apps (browsers, IDEs, replays).")
    print("    3. Train fewer dates: pass --include-dates with a subset")
    print("       (the model will still cover those days; you can retrain")
    print("        later with more once memory frees up).")
    print("    4. Bypass the guard if you know what you're doing:")
    print("         set TFA_SKIP_MEMORY_GUARD=1   (Windows)")
    print("         export TFA_SKIP_MEMORY_GUARD=1   (POSIX)")
    print()
    raise RuntimeError(
        f"Insufficient memory headroom for {instrument} training: "
        f"need ~{check.estimated_peak_gb:.1f} GB, have "
        f"{check.available_gb:.1f} GB available"
    )


__all__ = [
    "HeadroomCheck",
    "check_headroom",
    "format_check",
    "assert_headroom_or_advise",
]
