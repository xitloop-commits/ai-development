"""
cli.py — MTA command line interface (MVP).

Usage:
  python -m model_training_agent.cli \\
      --instrument crudeoil \\
      --date-from 2026-04-13 \\
      --date-to   2026-04-15
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Path bootstrap so this module works when run directly via python -m
_HERE = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

from model_training_agent.trainer import train_instrument
from holdout_utils import check_train_holdout_leak, resolve_holdout_dates

VALID_INSTRUMENTS = ("nifty50", "banknifty", "crudeoil", "naturalgas")


def main() -> int:
    p = argparse.ArgumentParser(
        prog="mta",
        description="Model Training Agent (MVP)",
    )
    p.add_argument("--instrument", required=True, choices=VALID_INSTRUMENTS)
    p.add_argument("--date-from", required=True, help="YYYY-MM-DD inclusive")
    p.add_argument("--date-to", required=True, help="YYYY-MM-DD inclusive")
    p.add_argument("--features-root", default="data/features")
    p.add_argument("--models-root", default="models")
    p.add_argument("--config-dir", default="config/model_feature_config")
    p.add_argument(
        "--val-days",
        type=int,
        default=3,
        help="Number of most recent days to hold out as validation "
        "(capped at total_days // 2). Default 3.",
    )
    p.add_argument(
        "--n-jobs",
        type=int,
        default=1,
        help="Per-target parallelism via joblib. 1 = serial (default, "
        "preserves log cadence and deterministic ordering). >1 "
        "fits N targets in parallel and pins LightGBM internal "
        "threads to 1 to avoid CPU oversubscription. Use 0 for "
        "auto: min(4, cpu_count() - 1).",
    )
    p.add_argument(
        "--include-dates",
        action="append",
        default=[],
        help="YYYY-MM-DD date to include. May be specified multiple times "
        "(e.g. --include-dates 2026-04-13 --include-dates 2026-04-17) or "
        "as a comma-separated list (--include-dates 2026-04-13,2026-04-17). "
        "When set, ONLY listed dates are loaded; date-from / date-to are "
        "ignored as a walk.",
    )
    p.add_argument(
        "--override-holdout",
        action="store_true",
        help="Allow training to include dates marked as reserved holdout in "
        "config/holdout_dates.json. Default: refuse with an error. Use only "
        "when you intentionally want to retrain on the holdout (e.g. for a "
        "final 'production' build after backtests have validated the model).",
    )
    args = p.parse_args()
    # Flatten: each --include-dates value may itself be a comma-separated list
    flat: list[str] = []
    for chunk in args.include_dates:
        flat.extend(d.strip() for d in chunk.split(",") if d.strip())
    include_dates = flat or None

    # ── Holdout leak guard ───────────────────────────────────────────────
    # Build the set of dates that training would actually touch and check it
    # against the reserved holdout list. Refuse early if any overlap unless
    # --override-holdout was passed.
    if include_dates is not None:
        candidate_train_dates = list(include_dates)
    else:
        # Approximate the walk-forward range as [date-from, date-to] inclusive.
        # The trainer itself only loads dates that actually have parquets, but
        # for leak-detection we just need to flag any reserved date that lies
        # within the requested window.
        candidate_train_dates = [args.date_from, args.date_to]  # endpoints suffice
        holdout = resolve_holdout_dates(features_root=Path(args.features_root))
        candidate_train_dates += [d for d in holdout
                                  if args.date_from <= d <= args.date_to]

    leaks = check_train_holdout_leak(
        candidate_train_dates,
        features_root=Path(args.features_root),
    )
    if leaks and not args.override_holdout:
        print()
        print("  " + "=" * 56)
        print(f"   HOLDOUT LEAK -- training refused")
        print("  " + "=" * 56)
        print()
        print(f"  Reserved date(s) overlap the train range:")
        for d in leaks:
            print(f"    - {d}")
        print()
        print("  These dates are reserved for out-of-sample backtest in")
        print("  config/holdout_dates.json. Training on them would invalidate")
        print("  backtest scorecards (in-sample leakage).")
        print()
        print("  Fix one of:")
        print("    1. Narrow --date-from / --date-to to exclude these dates.")
        print("    2. Remove or shrink the policy in config/holdout_dates.json.")
        print("    3. Pass --override-holdout (use only for final builds).")
        print()
        return 3
    if leaks and args.override_holdout:
        print()
        print(f"   WARNING: --override-holdout in effect. Training will INCLUDE")
        print(f"   reserved date(s): {', '.join(leaks)}")
        print()
    # ─────────────────────────────────────────────────────────────────────
    n_jobs = args.n_jobs
    if n_jobs == 0:
        from model_training_agent.trainer import _default_n_jobs

        n_jobs = _default_n_jobs()
        print(f"  --n-jobs=auto resolved to {n_jobs}")

    print()
    print("  " + "=" * 56)
    print(f"   MTA -- training {args.instrument}")
    if include_dates:
        print(f"   include-dates ({len(include_dates)}):  {', '.join(include_dates)}")
    else:
        print(f"   range:  {args.date_from}  ->  {args.date_to}")
    print("  " + "=" * 56)

    try:
        result = train_instrument(
            instrument=args.instrument,
            date_from=args.date_from,
            date_to=args.date_to,
            features_root=Path(args.features_root),
            models_root=Path(args.models_root),
            config_dir=Path(args.config_dir),
            val_days=args.val_days,
            n_jobs=n_jobs,
            include_dates=include_dates,
        )
    except RuntimeError as e:
        print(f"\n  ERROR: {e}\n")
        return 2

    print()
    print("  " + "=" * 56)
    print("   Training complete")
    print(f"   Timestamp:  {result.timestamp}")
    print(f"   Output:     {result.output_dir}")
    print(f"   Features:   {result.feature_count}")
    print(f"   Models:     {len(result.metrics)}")
    print("  " + "=" * 56)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
