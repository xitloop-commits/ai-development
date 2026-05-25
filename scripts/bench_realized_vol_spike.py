"""
scripts/bench_realized_vol_spike.py — T48 (Phase B.0 spike) benchmark.

Measures the per-date speedup of the Polars-columnar realized_vol against
the scalar per-event implementation. The number this script prints is THE
input to the T50 go / no-go decision:

    ≥3x    -> green-light T50 Phase B-full (~5-6 weeks investment)
    1.5-2x -> reconsider scope; partial B-full (~2 wks) may still pay off
    <1.5x  -> abort B-full; bottleneck is elsewhere

Usage::

    py -3 scripts/bench_realized_vol_spike.py            # 2,000,000 synthetic ticks (default)
    py -3 scripts/bench_realized_vol_spike.py --ticks 500000
    py -3 scripts/bench_realized_vol_spike.py --seed 7

The synthetic tick stream models a multiplicative random walk at typical
intraday tick density (~25,000 base price, 0.1% std per tick). The
per-tick distribution of work matches what the real adapter sees —
push to buffer -> call compute_realized_vol_features(buffer) — so the
scalar number is representative.

Sanity check: after timing, a small sample of rows is compared between
both implementations to confirm equivalence under benchmark load.
"""

from __future__ import annotations

import argparse
import math
import random
import sys
import time
from pathlib import Path

import polars as pl

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent
_PY_MODULES = _REPO_ROOT / "python_modules"
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from tick_feature_agent.buffers.tick_buffer import CircularBuffer, UnderlyingTick
from tick_feature_agent.features.realized_vol import compute_realized_vol_features
from tick_feature_agent.features.realized_vol_columnar import (
    compute_realized_vol_features_batch,
)

_WINDOWS = (5, 20, 50)


def _gen_synthetic_ltps(n: int, seed: int) -> list[float]:
    """Multiplicative random walk; deterministic via seed."""
    rng = random.Random(seed)
    p = 25_000.0
    out: list[float] = []
    for _ in range(n):
        p *= math.exp(rng.gauss(0.0, 0.001))
        out.append(p)
    return out


def _run_scalar(ltps: list[float]) -> list[dict]:
    """Replicate the live adapter's per-tick pattern: push -> compute."""
    buf = CircularBuffer(maxlen=50)
    rows: list[dict] = []
    for i, p in enumerate(ltps):
        buf.push(UnderlyingTick(timestamp=float(i), ltp=p, bid=p, ask=p, volume=0))
        rows.append(compute_realized_vol_features(buf))
    return rows


def _run_columnar(ltps: list[float]) -> pl.DataFrame:
    df = pl.DataFrame({"ltp": ltps})
    return compute_realized_vol_features_batch(df)


def _spot_check_equivalence(
    scalar_rows: list[dict], columnar_df: pl.DataFrame, sample_size: int = 200
) -> tuple[int, float]:
    """Sample ``sample_size`` rows; return (mismatches, max_abs_diff).

    A perfect spike yields (0, ≤1e-12). Anything larger means the
    columnar logic diverged under benchmark conditions and the result
    is suspect.
    """
    n = len(scalar_rows)
    rng = random.Random(0)
    idxs = sorted(rng.sample(range(n), min(sample_size, n)))
    mismatches = 0
    max_diff = 0.0
    for w in _WINDOWS:
        col = f"underlying_realized_vol_{w}"
        col_vals = columnar_df[col].to_list()
        for i in idxs:
            s_val = scalar_rows[i][col]
            c_val = col_vals[i]
            s_missing = isinstance(s_val, float) and math.isnan(s_val)
            c_missing = c_val is None or (
                isinstance(c_val, float) and math.isnan(c_val)
            )
            if s_missing and c_missing:
                continue
            if s_missing != c_missing:
                mismatches += 1
                continue
            d = abs(s_val - c_val)
            if d > max_diff:
                max_diff = d
            if d > 1e-9 * max(abs(s_val), 1e-12) + 1e-12:
                mismatches += 1
    return mismatches, max_diff


def _fmt_dur(sec: float) -> str:
    if sec < 1.0:
        return f"{sec * 1000:.1f} ms"
    if sec < 60.0:
        return f"{sec:.2f} s"
    return f"{sec / 60:.1f} min"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--ticks", type=int, default=2_000_000,
                        help="Number of synthetic ticks (default: 2,000,000 — realistic full-day count).")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--warmup", action="store_true",
                        help="Run each impl once before timing (JIT / cache warmup).")
    args = parser.parse_args()

    print(f"T48 spike benchmark — realized_vol scalar vs Polars columnar")
    print(f"  ticks:   {args.ticks:,}")
    print(f"  seed:    {args.seed}")
    print(f"  windows: {_WINDOWS}")
    print()

    print("Generating synthetic tick stream...", flush=True)
    ltps = _gen_synthetic_ltps(args.ticks, args.seed)

    if args.warmup:
        print("Warmup pass (untimed)...", flush=True)
        _ = _run_scalar(ltps[:50_000])
        _ = _run_columnar(ltps[:50_000])

    print("Scalar (per-tick)...", flush=True)
    t0 = time.perf_counter()
    scalar_rows = _run_scalar(ltps)
    scalar_sec = time.perf_counter() - t0
    print(f"  -> {_fmt_dur(scalar_sec)}")

    print("Polars columnar (whole DF)...", flush=True)
    t0 = time.perf_counter()
    columnar_df = _run_columnar(ltps)
    columnar_sec = time.perf_counter() - t0
    print(f"  -> {_fmt_dur(columnar_sec)}")
    print()

    speedup = scalar_sec / columnar_sec if columnar_sec > 0 else float("inf")
    print(f"Speedup: {speedup:.2f}x")
    print()

    print("Equivalence spot-check (200 random rows x 3 windows)...", flush=True)
    mismatches, max_diff = _spot_check_equivalence(scalar_rows, columnar_df)
    print(f"  mismatches:  {mismatches}")
    print(f"  max_abs_diff: {max_diff:.2e}")
    if mismatches > 0:
        print("  !! Equivalence violated — speedup number is NOT actionable.")
    print()

    print("T50 (Phase B-full) decision gate:")
    if speedup >= 3.0:
        verdict = "GREEN-LIGHT — proceed with B.1-B.5 (~5-6 weeks)"
    elif speedup >= 1.5:
        verdict = "RECONSIDER — partial B-full only (~2 weeks, ~2x ceiling)"
    else:
        verdict = "ABORT — bottleneck is elsewhere (gzip / parquet / merge_streams)"
    print(f"  {speedup:.2f}x -> {verdict}")


if __name__ == "__main__":
    main()
