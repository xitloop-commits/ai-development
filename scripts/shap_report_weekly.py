"""
scripts/shap_report_weekly.py — T34 §5.8 weekly feature-importance CLI.

Generates a per-instrument, per-head feature-importance report from
the live LightGBM models. Despite the spec-driven filename, the
attribution metric is gain-importance (sum of split gain), not true
SHAP. See ``_shared/feature_importance.py`` docstring for the why.

Usage:

    python scripts/shap_report_weekly.py
        [--instruments nifty50,banknifty,crudeoil,naturalgas]
        [--models-root models]
        [--output-dir data/reports]
        [--top-n 20]
        [--head-filter direction_30s,direction_60s]
        [--date 2026-05-30]

Outputs:
    data/reports/feature_importance_<date>.md
    data/reports/feature_importance_<date>.csv

The .md is human-readable: per-instrument per-head top-N tables +
cross-instrument concordance.

The .csv has one row per (instrument, head, ranked feature) — joinable
with the reliability CSV for "which features matter for the heads that
failed calibration?"-type analysis.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

import polars as pl

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
_PY_MODULES = _REPO / "python_modules"
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from _shared.feature_importance import (  # noqa: E402
    DEFAULT_TOP_N,
    flatten_to_csv_rows,
    render_markdown_summary,
    score_instrument,
)


def discover_instruments(models_root: Path) -> list[str]:
    """Find every instrument that has a LATEST_HEADS.json under
    ``<models_root>/<instrument>/``. Returns a sorted list.
    """
    if not models_root.is_dir():
        return []
    found: list[str] = []
    for child in sorted(models_root.iterdir()):
        if child.is_dir() and (child / "LATEST_HEADS.json").is_file():
            found.append(child.name)
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--instruments", type=str, default=None,
        help="Comma-separated instruments. Default: auto-discover under "
             "--models-root.",
    )
    parser.add_argument(
        "--models-root", type=Path,
        default=_REPO / "models",
        help="Root directory containing <instrument>/LATEST/.",
    )
    parser.add_argument(
        "--output-dir", type=Path,
        default=_REPO / "data" / "reports",
        help="Where to write the .md + .csv outputs.",
    )
    parser.add_argument(
        "--top-n", type=int, default=DEFAULT_TOP_N,
        help=f"Top-N features per head to surface (default {DEFAULT_TOP_N}).",
    )
    parser.add_argument(
        "--head-filter", type=str, default=None,
        help="Comma-separated head names to restrict the report to. "
             "Default: all heads in LATEST_HEADS.json.",
    )
    parser.add_argument(
        "--date", type=str, default=None,
        help="Date stamp for the output filename (YYYY-MM-DD). "
             "Default: today (host clock).",
    )
    args = parser.parse_args(argv)

    if args.instruments:
        instruments = [s.strip() for s in args.instruments.split(",") if s.strip()]
    else:
        instruments = discover_instruments(args.models_root)
        if not instruments:
            print(
                f"ERROR no instruments found under {args.models_root} "
                f"(expected <instrument>/LATEST_HEADS.json)",
                file=sys.stderr,
            )
            return 2

    head_filter: set[str] | None = None
    if args.head_filter:
        head_filter = {s.strip() for s in args.head_filter.split(",") if s.strip()}

    stamp = args.date or datetime.now().strftime("%Y-%m-%d")

    print(
        f"[shap_report_weekly] scoring {len(instruments)} instruments "
        f"({', '.join(instruments)}) "
        f"top-N={args.top_n} "
        f"head_filter={head_filter or 'ALL'}",
        file=sys.stderr,
    )

    reports_by_instrument: dict[str, list] = {}
    for instrument in instruments:
        inst_dir = args.models_root / instrument
        if not (inst_dir / "LATEST_HEADS.json").is_file():
            print(
                f"WARN  no LATEST_HEADS.json for {instrument}, skipping",
                file=sys.stderr,
            )
            continue
        try:
            reports_by_instrument[instrument] = score_instrument(
                instrument=instrument,
                instrument_dir=inst_dir,
                top_n=args.top_n,
                head_filter=head_filter,
            )
        except Exception as exc:  # noqa: BLE001
            print(
                f"WARN  scoring {instrument} failed: {exc}",
                file=sys.stderr,
            )

    if not reports_by_instrument:
        print(
            f"ERROR no instruments scored successfully under "
            f"{args.models_root}",
            file=sys.stderr,
        )
        return 2

    args.output_dir.mkdir(parents=True, exist_ok=True)
    md_path = args.output_dir / f"feature_importance_{stamp}.md"
    csv_path = args.output_dir / f"feature_importance_{stamp}.csv"

    title = (
        f"T34 §5.8 weekly feature importance · {stamp} · "
        f"{', '.join(sorted(reports_by_instrument.keys()))}"
    )
    md = render_markdown_summary(reports_by_instrument, title=title)
    md_path.write_text(md, encoding="utf-8")

    csv_rows = flatten_to_csv_rows(reports_by_instrument)
    if csv_rows:
        pl.DataFrame(csv_rows).write_csv(csv_path)
    else:
        pl.DataFrame(schema={
            "instrument": pl.Utf8,
            "head_name": pl.Utf8,
            "head_type": pl.Utf8,
            "objective": pl.Utf8,
            "rank": pl.Int32,
            "feature_name": pl.Utf8,
            "importance": pl.Float64,
            "pct_of_total": pl.Float64,
            "n_features": pl.Int64,
            "total_gain": pl.Float64,
            "missing_model": pl.Boolean,
        }).write_csv(csv_path)

    n_heads = sum(len(rs) for rs in reports_by_instrument.values())
    n_missing = sum(
        1 for rs in reports_by_instrument.values()
        for r in rs if r.missing_model
    )
    print(
        f"[shap_report_weekly] wrote {md_path.name}, {csv_path.name} "
        f"({n_heads} (instrument, head) pairs, {n_missing} missing)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
