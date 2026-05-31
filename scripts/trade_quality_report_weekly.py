"""
scripts/trade_quality_report_weekly.py — T34 §5.1 weekly reliability CLI.

Reads N days of T41 prediction parquets, scores per-head calibration
across the data, and writes a markdown summary + per-decile CSV to
``data/reports/``. Designed to be run on a schedule (weekly cron / Task
Scheduler) or ad-hoc against a specified date range.

Usage:

    python scripts/trade_quality_report_weekly.py
        [--days 7]
        [--end-date 2026-05-30]
        [--predictions-root data/predictions]
        [--output-dir data/reports]
        [--tolerance 0.05]
        [--instrument nifty50]

Behaviour:

  - Default: last 7 calendar days (Mon-Sun closed on Sunday-ish weekly
    cadence; the CLI doesn't care about weekday — it just reads what's
    on disk for the requested window).
  - One markdown summary across all instruments + cohorts.
  - One CSV with every (head, decile) row for downstream analysis.
  - Skipped heads (insufficient outcomes) listed in the summary so
    silent gaps don't hide from operators.
  - Exits non-zero only when no data was found — FAILing reliability
    heads do NOT exit non-zero (they're surfaced in the report; a
    cron-grade alert would key off the report contents, not exit
    code).
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta
from pathlib import Path

import polars as pl

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
_PY_MODULES = _REPO / "python_modules"
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from _shared.reliability import (  # noqa: E402
    DEFAULT_DECILES,
    DEFAULT_MIN_ROWS_PER_DECILE,
    DEFAULT_TOLERANCE,
    render_markdown_summary,
    score_all_heads,
)


def parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d")


def collect_predictions(
    predictions_root: Path,
    *,
    start_date: datetime,
    end_date: datetime,
    instrument: str | None,
) -> pl.DataFrame:
    """Glob+concat every prediction parquet in [start_date, end_date].

    Missing day-dirs are OK (skipped silently). One instrument filter
    short-circuits at the file-name level (``<inst>_predictions.parquet``)
    so we don't load + filter every instrument.
    """
    frames: list[pl.DataFrame] = []
    cursor = start_date
    while cursor <= end_date:
        day_dir = predictions_root / cursor.strftime("%Y-%m-%d")
        if day_dir.is_dir():
            if instrument is not None:
                pattern = f"{instrument}_predictions.parquet"
            else:
                pattern = "*_predictions.parquet"
            for parquet in sorted(day_dir.glob(pattern)):
                try:
                    frames.append(pl.read_parquet(parquet))
                except Exception as exc:  # noqa: BLE001
                    # A single corrupt file shouldn't kill the whole run;
                    # log + continue so the rest of the week is still scored.
                    print(
                        f"WARN  failed to read {parquet}: {exc}",
                        file=sys.stderr,
                    )
        cursor += timedelta(days=1)

    if not frames:
        return pl.DataFrame()
    return pl.concat(frames, how="vertical_relaxed")


def buckets_to_csv_rows(reports: list) -> list[dict]:
    """Flatten one report-per-head into one row per (head, decile)."""
    rows: list[dict] = []
    for r in reports:
        if r.skipped_reason is not None:
            rows.append({
                "head_name": r.head_name,
                "head_type": r.head_type or "",
                "decile": -1,
                "n_rows": r.n_rows_with_outcome,
                "mean_predicted_prob": float("nan"),
                "actual_positive_rate": float("nan"),
                "abs_diff": float("nan"),
                "calibration_score": float("nan"),
                "passed": False,
                "skipped_reason": r.skipped_reason,
            })
            continue
        for b in r.buckets:
            rows.append({
                "head_name": r.head_name,
                "head_type": r.head_type or "",
                "decile": b.decile,
                "n_rows": b.n_rows,
                "mean_predicted_prob": b.mean_predicted_prob,
                "actual_positive_rate": b.actual_positive_rate,
                "abs_diff": b.abs_diff,
                "calibration_score": r.calibration_score,
                "passed": r.passed,
                "skipped_reason": "",
            })
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--days", type=int, default=7,
        help="Window size in days back from --end-date (default 7).",
    )
    parser.add_argument(
        "--end-date", type=parse_date, default=None,
        help="End date (inclusive) as YYYY-MM-DD. "
             "Default: today (host clock).",
    )
    parser.add_argument(
        "--predictions-root", type=Path,
        default=_REPO / "data" / "predictions",
        help="Root directory containing <YYYY-MM-DD>/ subdirs.",
    )
    parser.add_argument(
        "--output-dir", type=Path,
        default=_REPO / "data" / "reports",
        help="Where to write the .md + .csv outputs.",
    )
    parser.add_argument(
        "--instrument", type=str, default=None,
        help="Filter to one instrument (e.g. nifty50). Default: all.",
    )
    parser.add_argument(
        "--tolerance", type=float, default=DEFAULT_TOLERANCE,
        help=f"Per-decile PASS/FAIL tolerance (default {DEFAULT_TOLERANCE}).",
    )
    parser.add_argument(
        "--n-deciles", type=int, default=DEFAULT_DECILES,
        help=f"Number of calibration buckets (default {DEFAULT_DECILES}).",
    )
    parser.add_argument(
        "--min-rows-per-decile", type=int,
        default=DEFAULT_MIN_ROWS_PER_DECILE,
        help="Minimum rows per decile; heads with fewer get SKIPPED "
             f"(default {DEFAULT_MIN_ROWS_PER_DECILE}).",
    )
    args = parser.parse_args(argv)

    # End-date defaults to today read from the system clock.
    # The CLI is allowed to use the wall clock — the unit tests pass
    # an explicit --end-date, so determinism in tests is preserved.
    end_date = args.end_date or datetime.now().replace(
        hour=0, minute=0, second=0, microsecond=0,
    )
    start_date = end_date - timedelta(days=args.days - 1)

    print(
        f"[trade_quality_report] window "
        f"{start_date.strftime('%Y-%m-%d')} → "
        f"{end_date.strftime('%Y-%m-%d')} "
        f"(instrument={args.instrument or 'ALL'}, "
        f"tol={args.tolerance})",
        file=sys.stderr,
    )

    df = collect_predictions(
        args.predictions_root,
        start_date=start_date,
        end_date=end_date,
        instrument=args.instrument,
    )
    if df.is_empty():
        print(
            f"ERROR no prediction data found under "
            f"{args.predictions_root} for the requested window.",
            file=sys.stderr,
        )
        return 2

    print(f"[trade_quality_report] loaded {len(df)} rows", file=sys.stderr)

    reports = score_all_heads(
        df,
        n_deciles=args.n_deciles,
        tolerance=args.tolerance,
        min_rows_per_decile=args.min_rows_per_decile,
    )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    stamp = end_date.strftime("%Y-%m-%d")
    suffix = f"_{args.instrument}" if args.instrument else ""
    md_path = args.output_dir / f"reliability_weekly_{stamp}{suffix}.md"
    csv_path = args.output_dir / f"reliability_weekly_{stamp}{suffix}.csv"

    title_window = (
        f"T34 §5.1 reliability · "
        f"{start_date.strftime('%Y-%m-%d')} → {end_date.strftime('%Y-%m-%d')}"
        + (f" · {args.instrument}" if args.instrument else "")
    )
    md = render_markdown_summary(reports, title=title_window)
    md_path.write_text(md, encoding="utf-8")

    csv_rows = buckets_to_csv_rows(reports)
    if csv_rows:
        pl.DataFrame(csv_rows).write_csv(csv_path)
    else:
        # Header-only CSV so a downstream task scheduler always finds
        # the file. Empty CSVs are easier to detect than missing ones.
        pl.DataFrame(schema={
            "head_name": pl.Utf8,
            "head_type": pl.Utf8,
            "decile": pl.Int32,
            "n_rows": pl.Int64,
            "mean_predicted_prob": pl.Float64,
            "actual_positive_rate": pl.Float64,
            "abs_diff": pl.Float64,
            "calibration_score": pl.Float64,
            "passed": pl.Boolean,
            "skipped_reason": pl.Utf8,
        }).write_csv(csv_path)

    n_pass = sum(1 for r in reports if r.passed)
    n_fail = sum(
        1 for r in reports
        if not r.passed and r.skipped_reason is None
    )
    n_skipped = sum(1 for r in reports if r.skipped_reason is not None)
    print(
        f"[trade_quality_report] wrote {md_path.name}, {csv_path.name} "
        f"({n_pass} PASS / {n_fail} FAIL / {n_skipped} SKIPPED)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
