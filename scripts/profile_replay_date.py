"""
scripts/profile_replay_date.py — T50 B.1 profiling harness.

Wraps ``replay(..., workers=1)`` in cProfile to rank the top hot
functions across a real date's event stream. Output is a sorted stats
dump that locks the T50 B.3a-B.3e conversion list (which trackers
actually deserve columnar rewrites).

Usage (defaults are tuned for fast iteration — first 200k events of
2026-04-28 nifty50, writing to a throwaway features-root)::

    py -3 scripts/profile_replay_date.py
    py -3 scripts/profile_replay_date.py --date 2026-04-29 --max-events 500000
    py -3 scripts/profile_replay_date.py --no-limit          # profile the full date

A short text report is written to docs/T50_PROFILING_REPORT.md after
each run (overwrites prior). The raw .pstats file is kept in the
throwaway dir for deeper drilling with snakeviz / gprof2dot.

Risk: zero. Profile-mode replay points at a sandbox features-root and
validation-root so no production data is touched.
"""

from __future__ import annotations

import argparse
import cProfile
import io
import pstats
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent
_PY_MODULES = _REPO_ROOT / "python_modules"
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from tick_feature_agent.replay import replay_runner


def _install_event_limit(max_events: int) -> None:
    """Monkeypatch merge_streams to yield only the first N events.

    Keeps the rest of run_one_date intact (chunking, resume, validator)
    so the profile sees realistic call patterns, just truncated.
    """
    original = replay_runner.merge_streams

    def limited(folder, instrument, logger=None):
        count = 0
        for event in original(folder, instrument, logger=logger):
            count += 1
            if count > max_events:
                return
            yield event

    replay_runner.merge_streams = limited


def _write_report(stats: pstats.Stats, args: argparse.Namespace, report_path: Path) -> None:
    """Pretty-print top-30 hot functions + write a markdown report."""
    sio = io.StringIO()
    stats.stream = sio
    stats.strip_dirs()
    stats.sort_stats("cumulative")
    stats.print_stats(30)
    cumulative_block = sio.getvalue()

    sio2 = io.StringIO()
    stats.stream = sio2
    stats.sort_stats("tottime")
    stats.print_stats(30)
    tottime_block = sio2.getvalue()

    md = []
    md.append("# T50 B.1 — Replay profiling report")
    md.append("")
    md.append(f"- Profile target: `{args.date}` / `{args.instrument}`")
    md.append(f"- Event limit: {'no limit (full date)' if args.no_limit else f'{args.max_events:,} events'}")
    md.append(f"- Profile sandbox: `{args.features_root}` (separate from production)")
    md.append(f"- Profiler: cProfile, single-process serial (`workers=1`)")
    md.append("")
    md.append("## Top 30 by **cumulative** time (includes time spent in callees)")
    md.append("")
    md.append("```")
    md.append(cumulative_block.rstrip())
    md.append("```")
    md.append("")
    md.append("## Top 30 by **total** time (excludes time spent in callees — pure work in this function)")
    md.append("")
    md.append("```")
    md.append(tottime_block.rstrip())
    md.append("```")
    md.append("")
    md.append("## Interpretation guide")
    md.append("")
    md.append("- **cumulative** shows where time accrues including recursion / nested calls — useful for finding the headline hot orchestration paths.")
    md.append("- **tottime** isolates the actual per-function work — that's what columnar conversion replaces with vectorised Polars expressions.")
    md.append("- Compare the top-30 against the pre-B.1 conversion guess (`realized_vol`, `compression`, OI-weighted levels, `exhaustion`, `ofi`). Any tracker that ranks higher than these and isn't on the list is a candidate to swap in.")
    md.append("")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(md), encoding="utf-8")
    print(f"Report written to {report_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--instrument", default="nifty50")
    parser.add_argument("--date", default="2026-04-28")
    parser.add_argument("--profile-name", default="nifty50",
                        help="Instrument profile key (resolves to config/instrument_profiles/<name>_profile.json)")
    parser.add_argument("--max-events", type=int, default=200_000,
                        help="Cap event count for fast iteration. Use --no-limit for a full-date profile.")
    parser.add_argument("--no-limit", action="store_true")
    parser.add_argument("--features-root", default="data/profile_run/features")
    parser.add_argument("--validation-root", default="data/profile_run/validation")
    parser.add_argument("--raw-root", default="data/raw")
    parser.add_argument("--stats-out", default="data/profile_run/replay.pstats")
    parser.add_argument("--report-out", default="docs/T50_PROFILING_REPORT.md")
    args = parser.parse_args()

    # Resolve all data-paths against the repo root (this file's parent.parent)
    # so the script works regardless of which directory the user invokes from.
    # Previously a relative `data/raw` silently resolved against the caller's
    # cwd — invoked from outside the repo root, replay saw empty streams and
    # the profile captured nothing (T50 B.1 2026-05-25).
    def _abs(p: str) -> str:
        path = Path(p)
        return str(path if path.is_absolute() else (_REPO_ROOT / path).resolve())

    args.raw_root = _abs(args.raw_root)
    args.features_root = _abs(args.features_root)
    args.validation_root = _abs(args.validation_root)
    args.stats_out = _abs(args.stats_out)
    args.report_out = _abs(args.report_out)

    if not args.no_limit:
        _install_event_limit(args.max_events)
        print(f"Event limit: first {args.max_events:,} events of {args.date}")
    else:
        print(f"Profiling full date {args.date} (no event limit)")

    profile_path = _REPO_ROOT / f"config/instrument_profiles/{args.profile_name}_profile.json"
    print(f"Profile JSON: {profile_path}")
    print(f"Raw root:    {args.raw_root}")
    print(f"Output dirs: features={args.features_root}  validation={args.validation_root}")
    print("Starting cProfile-wrapped replay (serial, workers=1)...")
    print()

    profiler = cProfile.Profile()
    profiler.enable()
    try:
        summary = replay_runner.replay(
            profile_path=str(profile_path),
            instrument=args.instrument,
            # Use include_dates so we bypass the production checkpoint —
            # the date may already have been replayed and the date-range
            # path would return an empty dates_iter.
            date_from=args.date,
            date_to=args.date,
            include_dates=[args.date],
            raw_root=args.raw_root,
            features_root=args.features_root,
            validation_root=args.validation_root,
            workers=1,
            log_dir="logs/profile_run",
        )
    finally:
        profiler.disable()

    print(f"Replay summary: {summary}")
    print()

    stats_path = _REPO_ROOT / args.stats_out
    stats_path.parent.mkdir(parents=True, exist_ok=True)
    profiler.dump_stats(str(stats_path))
    print(f"Raw stats written to {stats_path}")

    stats = pstats.Stats(profiler)
    report_path = _REPO_ROOT / args.report_out
    _write_report(stats, args, report_path)

    # Print top-15 cumulative inline so the user sees the headline w/o opening the file
    print()
    print("=" * 76)
    print("Top 15 by cumulative time (full report at " + str(report_path) + "):")
    print("=" * 76)
    stats.strip_dirs().sort_stats("cumulative").print_stats(15)


if __name__ == "__main__":
    main()
