"""
scripts/validate_b3a_end_to_end.py — T50 B.3a end-to-end gate.

Replays the same date twice — once with the scalar baseline
(``TFA_LEGACY_MAX_PAIN=1``) and once with the cached / columnar
max_pain path active — then byte-compares the produced parquet
outputs and reports the wall-time delta.

PASS criterion (non-negotiable for B.3a merge):
    parquet outputs are byte-identical (zero diff in any feature
    column). If anything differs, the wire-in has a bug and must NOT
    ship until resolved.

Speedup criterion (advisory):
    wall-time should drop by ~15% on a typical 2.5M-event nifty50 day
    (32s of 200s scalar max_pain compute collapses to ~0.3s).

Usage::

    py -3 scripts/validate_b3a_end_to_end.py
    py -3 scripts/validate_b3a_end_to_end.py --date 2026-05-21
    py -3 scripts/validate_b3a_end_to_end.py --max-events 500000  # quick smoke
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import polars as pl

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent
_PY_MODULES = _REPO_ROOT / "python_modules"
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))


def _run_one(
    date: str,
    instrument: str,
    sandbox_root: Path,
    use_legacy: bool,
    max_events: int | None,
) -> tuple[float, Path]:
    """Run a single replay, return (wall_time_sec, output_parquet_path)."""
    features_root = sandbox_root / ("scalar" if use_legacy else "columnar")
    if features_root.exists():
        shutil.rmtree(features_root)
    features_root.mkdir(parents=True)
    validation_root = sandbox_root / "val" / ("scalar" if use_legacy else "columnar")

    from tick_feature_agent.replay import replay_runner

    # Monkey-patch merge_streams for max-events cap, if requested.
    if max_events is not None:
        original = replay_runner.merge_streams
        def limited(folder, instrument, logger=None):
            count = 0
            for event in original(folder, instrument, logger=logger):
                count += 1
                if count > max_events:
                    return
                yield event
        replay_runner.merge_streams = limited

    # Env var controls cached path
    if use_legacy:
        os.environ["TFA_LEGACY_MAX_PAIN"] = "1"
    else:
        os.environ.pop("TFA_LEGACY_MAX_PAIN", None)

    profile_path = _REPO_ROOT / f"config/instrument_profiles/{instrument}_profile.json"
    t0 = time.perf_counter()
    summary = replay_runner.replay(
        profile_path=str(profile_path),
        instrument=instrument,
        date_from=date,
        date_to=date,
        include_dates=[date],
        raw_root=str(_REPO_ROOT / "data" / "raw"),
        features_root=str(features_root),
        validation_root=str(validation_root),
        workers=1,
        log_dir=str(_REPO_ROOT / "logs" / "b3a_e2e"),
    )
    wall = time.perf_counter() - t0

    parquet = features_root / date / f"{instrument}_features.parquet"
    return wall, parquet


def _compare_parquets(a: Path, b: Path) -> tuple[int, str]:
    """Return (mismatch_count, summary_text). 0 mismatches = pass."""
    if not a.exists():
        return 1, f"FAIL: scalar parquet missing at {a}"
    if not b.exists():
        return 1, f"FAIL: columnar parquet missing at {b}"
    df_a = pl.read_parquet(a)
    df_b = pl.read_parquet(b)
    if df_a.shape != df_b.shape:
        return 1, f"FAIL: shape mismatch scalar={df_a.shape} columnar={df_b.shape}"
    if df_a.columns != df_b.columns:
        return 1, (
            f"FAIL: column mismatch\n"
            f"  scalar:   {df_a.columns}\n"
            f"  columnar: {df_b.columns}"
        )

    # Focus on the 3 max-pain columns — those are what B.3a touched.
    max_pain_cols = [
        "max_pain_strike",
        "distance_to_max_pain_pct",
        "max_pain_gravity_strength",
    ]
    diffs = []
    total_mismatches = 0
    for c in max_pain_cols:
        if c not in df_a.columns:
            diffs.append(f"  {c}: NOT in parquet")
            continue
        # Treat NaN==NaN. Subtract -> abs -> filter > tol.
        s = (df_a[c] - df_b[c]).fill_nan(0.0).abs()
        mask = s > 1e-9
        n = int(mask.sum())
        total_mismatches += n
        max_d = float(s.max() or 0.0)
        diffs.append(f"  {c:<32} mismatches={n}  max_abs_diff={max_d:.2e}")

    # Spot-check non-max-pain columns to ensure we didn't accidentally
    # affect unrelated features.
    other_cols = [c for c in df_a.columns if c not in max_pain_cols and df_a[c].dtype.is_numeric()]
    other_mismatches = 0
    for c in other_cols[:50]:  # cap at 50 to avoid massive output
        try:
            s = (df_a[c] - df_b[c]).fill_nan(0.0).abs()
            other_mismatches += int((s > 1e-9).sum())
        except Exception:
            pass

    summary = (
        f"Max-pain columns:\n"
        + "\n".join(diffs)
        + f"\n\nOther numeric columns (top 50, sampled): "
        f"{other_mismatches} mismatches"
    )
    return total_mismatches + other_mismatches, summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--date", default="2026-05-22")
    parser.add_argument("--instrument", default="nifty50")
    parser.add_argument(
        "--max-events", type=int, default=None,
        help="Cap events for quick smoke; default = full date",
    )
    args = parser.parse_args()

    sandbox = _REPO_ROOT / "data" / "b3a_e2e_validation"
    if sandbox.exists():
        shutil.rmtree(sandbox)
    sandbox.mkdir(parents=True)

    print(f"=== T50 B.3a end-to-end validation ===")
    print(f"  date:       {args.date}")
    print(f"  instrument: {args.instrument}")
    print(f"  max_events: {args.max_events or 'no limit'}")
    print()

    print("Run 1/2: SCALAR baseline (TFA_LEGACY_MAX_PAIN=1)")
    t_scalar, parquet_scalar = _run_one(
        args.date, args.instrument, sandbox, use_legacy=True,
        max_events=args.max_events,
    )
    print(f"  wall: {t_scalar:.2f}s   output: {parquet_scalar}")
    print()

    print("Run 2/2: CACHED columnar (default)")
    t_columnar, parquet_columnar = _run_one(
        args.date, args.instrument, sandbox, use_legacy=False,
        max_events=args.max_events,
    )
    print(f"  wall: {t_columnar:.2f}s   output: {parquet_columnar}")
    print()

    speedup = t_scalar / max(t_columnar, 1e-9)
    saved_pct = (1 - t_columnar / max(t_scalar, 1e-9)) * 100
    print(f"Wall-time delta: {t_scalar - t_columnar:+.2f}s  ({speedup:.2f}x, {saved_pct:+.1f}%)")
    print()

    print("Comparing parquet outputs ...")
    mismatches, summary = _compare_parquets(parquet_scalar, parquet_columnar)
    print(summary)
    print()
    if mismatches == 0:
        print("PASS - byte-identical parquet output.")
        return 0
    print(f"FAIL - {mismatches} value mismatches detected. Do NOT merge.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
