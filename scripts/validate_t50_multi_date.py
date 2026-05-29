"""
scripts/validate_t50_multi_date.py — T50 B.5 cross-date equivalence harness.

Iterates a small reference set of recorded dates and asserts that the
A+B+C+D+E cached replay produces byte-identical parquet output to the
fully-scalar replay on every one of them. Aggregate PASS only when
every date is mismatch-free.

Use case: the regression gate before merging any future T50 sub-phase
change (the eventual Polars rewrites of _c7_center_of_mass /
strike_rotation / oi_change_deltas, or any tweak to an existing
columnar function). Single-date validation isn't enough — a bug that
only shows up on a particular schema variant (pre-v8 vs v8) or a
session-length boundary slips past a one-date harness.

Usage::

    py -3 scripts/validate_t50_multi_date.py
    py -3 scripts/validate_t50_multi_date.py --dates 2026-04-27,2026-05-22
    py -3 scripts/validate_t50_multi_date.py --max-events 200000  # quick smoke

Exit code 0 = all dates byte-identical. Exit code 1 = any divergence.

Per-date behaviour is delegated to ``validate_b3a_end_to_end.py``'s
internal helpers — we just loop over dates + aggregate.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent
_PY_MODULES = _REPO_ROOT / "python_modules"
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

# Reuse the per-date plumbing from the single-date harness.
sys.path.insert(0, str(_HERE))
from validate_b3a_end_to_end import _compare_parquets, _run_one  # type: ignore


# Reference set — v8-schema only.
# Updated 2026-05-28 after Partha pointed out that pre-v8 dates
# (April 2026) won't feed training under the current schema (V2 cutover
# 2026-05-20 + 30-session gate per V2_MASTER_SPEC D76). Validating
# regression on data the model can't actually consume isn't a useful
# gate. The pre-v8 dates remain replayable — the cached output is
# byte-identical to scalar on them too, verified 2026-05-27 — but
# they're not in the default set anymore.
#
# Picks span the available v8 trading days with size + position variety:
#   2026-05-20  v8 Day 1 — most important to validate schema cutover
#   2026-05-21  PASSed end-to-end 2026-05-27
#   2026-05-22  used by all other validate_b3a_end_to_end runs
#   2026-05-25  varied underlying tick density (~1.47 MB) for breadth
#   2026-05-27  latest full trading day in the v8 dataset
#
# 2026-05-19 (v8 Day 0) had a corrupt .ndjson.gz block discovered by
# this harness on its first run — apply scripts/recover_gz.py before
# adding it back to the reference set.
_DEFAULT_DATES = (
    "2026-05-20",
    "2026-05-21",
    "2026-05-22",
    "2026-05-25",
    "2026-05-27",
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument(
        "--dates", default=",".join(_DEFAULT_DATES),
        help="Comma-separated YYYY-MM-DD list (default: 5 reference dates).",
    )
    parser.add_argument("--instrument", default="nifty50")
    parser.add_argument(
        "--max-events", type=int, default=500_000,
        help="Per-date event cap for runtime control. Default 500k = ~3 min/run "
        "= ~30 min total for 5 dates. Use --no-limit for full dates (~hours).",
    )
    parser.add_argument("--no-limit", action="store_true")
    args = parser.parse_args()

    dates = [d.strip() for d in args.dates.split(",") if d.strip()]
    if not dates:
        print("ERROR: no dates supplied", file=sys.stderr)
        return 1

    max_events = None if args.no_limit else args.max_events

    sandbox = _REPO_ROOT / "data" / "b5_multi_date_validation"
    if sandbox.exists():
        shutil.rmtree(sandbox)
    sandbox.mkdir(parents=True)

    print(f"=== T50 B.5 cross-date equivalence harness ===")
    print(f"  dates:      {', '.join(dates)}")
    print(f"  instrument: {args.instrument}")
    print(f"  max_events: {max_events if max_events is not None else 'no limit'}")
    print(f"  sandbox:    {sandbox}")
    print()

    rows: list[tuple[str, float, float, float, int, str]] = []
    overall_pass = True

    for date_str in dates:
        per_date_dir = sandbox / date_str
        per_date_dir.mkdir()
        print(f"--- {date_str} ---")
        t_start = time.perf_counter()
        try:
            t_scalar, parquet_scalar = _run_one(
                date_str, args.instrument, per_date_dir,
                use_legacy=True, max_events=max_events,
            )
            t_cached, parquet_cached = _run_one(
                date_str, args.instrument, per_date_dir,
                use_legacy=False, max_events=max_events,
            )
        except Exception as exc:
            print(f"  ERROR running {date_str}: {exc}")
            rows.append((date_str, 0.0, 0.0, 0.0, -1, f"ERROR: {exc}"))
            overall_pass = False
            continue

        speedup = t_scalar / max(t_cached, 1e-9)
        mismatches, summary = _compare_parquets(parquet_scalar, parquet_cached)
        verdict = "PASS" if mismatches == 0 else f"FAIL ({mismatches} diffs)"
        elapsed = time.perf_counter() - t_start

        print(f"  scalar:   {t_scalar:>7.2f}s")
        print(f"  cached:   {t_cached:>7.2f}s")
        print(f"  speedup:  {speedup:.2f}x")
        print(f"  verdict:  {verdict}   (date took {elapsed:.1f}s total)")
        if mismatches != 0:
            print(summary)
            overall_pass = False
        print()

        rows.append((date_str, t_scalar, t_cached, speedup, mismatches, verdict))

    # ── Aggregate ──────────────────────────────────────────────────────────
    print("=" * 72)
    print(f"{'Date':<14}{'Scalar':>10}{'Cached':>10}{'Speedup':>10}{'Verdict':>20}")
    print("-" * 72)
    for date_str, t_s, t_c, sp, mm, vrd in rows:
        print(f"{date_str:<14}{t_s:>9.2f}s{t_c:>9.2f}s{sp:>9.2f}x{vrd:>20}")
    print("=" * 72)

    if overall_pass:
        n = len([r for r in rows if r[4] == 0])
        print(f"PASS - {n}/{len(rows)} dates byte-identical.")
        return 0
    failed = [r[0] for r in rows if r[4] != 0]
    print(f"FAIL - divergences on: {', '.join(failed)}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
