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
        help="Number of most recent days (after carving out the "
        "calibration fold) to hold out as validation (capped at "
        "total_days // 2). Default 3.",
    )
    p.add_argument(
        "--cal-days",
        type=int,
        default=5,
        help="Number of MOST RECENT days reserved as the calibration "
        "fold (T24a). The trainer never sees these sessions; T25 fits "
        "per-head isotonic calibration on them later. Carve-out is "
        "automatically skipped when total days < cal_days + 2, with a "
        "WARN log (dev / v0-stopgap mode). Set to 0 to disable the "
        "carve-out entirely. Default 5.",
    )
    p.add_argument(
        "--n-folds",
        type=int,
        default=5,
        help="Walk-forward CV fold count (T24b). Each fold holds out "
        "1 trading week (--fold-week-size sessions) as val; the rest "
        "trains the head, models discarded after scoring. Fold pass "
        "auto-skips with WARN when sessions < n_folds * fold_week_size "
        "after the cal carve-out (short-data dev mode). Default 5 per "
        "V2_MASTER_SPEC §6.",
    )
    p.add_argument(
        "--fold-week-size",
        type=int,
        default=5,
        help="Sessions per CV fold (T24b). Default 5 = 1 trading week.",
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
    # ── Date-hygiene pre-flight (Phase 4, 2026-06-20) ─────────────────────
    # Read each date's `data/validation/{date}/{inst}_validation.json` and
    # auto-drop FAILs before they reach the trainer. WARN dates kept by
    # default since they're usually usable. Missing JSONs kept by default
    # (absence of evidence is not evidence of badness).
    p.add_argument(
        "--validation-root",
        default="data/validation",
        help="Where to look for per-date validation JSONs.",
    )
    p.add_argument(
        "--include-fails",
        action="store_true",
        help="Keep FAIL-verdict dates in the training set. Default: drop. "
        "Use ONLY when you've reviewed each FAIL and are sure they're safe.",
    )
    p.add_argument(
        "--no-warns",
        action="store_true",
        help="Drop WARN-verdict dates from the training set. Default: keep "
        "them (most WARNs are usable, e.g. 'regime: always NEUTRAL' on a "
        "low-volatility day leaves the other 600+ features fine).",
    )
    p.add_argument(
        "--missing-policy",
        default="include",
        choices=["include", "drop"],
        help="What to do with dates that have no validation JSON. "
        "Default: include (validator absence is not evidence of badness).",
    )
    p.add_argument(
        "--quiet",
        action="store_true",
        help="Disable the rich progress dashboard; fall back to legacy "
        "per-head print output. Default: dashboard ON. Equivalent to "
        "setting TFA_LEGACY_TRAIN_UI=1 in the environment (used by cron "
        "and scripted retrains so logs stay one-line-per-event).",
    )
    p.add_argument(
        "--resume",
        action="store_true",
        help="Resume the most recent interrupted run (Phase 3, 2026-06-20). "
        "Finds the newest dir under `models/<instrument>/` that has no "
        "training_manifest.json (= interrupted) but has at least one "
        "partial-state sidecar. Walk-forward CV picks up at the next "
        "fold; the final-fit phase picks up at the next head. Schema "
        "fingerprint protects against resuming after a config change.",
    )
    args = p.parse_args()
    if args.quiet:
        import os as _os
        _os.environ["TFA_LEGACY_TRAIN_UI"] = "1"
    # Flatten: each --include-dates value may itself be a comma-separated list
    flat: list[str] = []
    for chunk in args.include_dates:
        flat.extend(d.strip() for d in chunk.split(",") if d.strip())
    include_dates = flat or None

    # ── Date hygiene pre-flight (Phase 4, 2026-06-20) ────────────────────
    # Run the validator-verdict filter ONLY when an explicit include-dates
    # list was given. For the date-range path (date_from / date_to) the
    # trainer itself walks the parquet directory; we'd need to enumerate
    # the same way here just to filter. Skip for now -- range mode users
    # can pass --include-dates instead if they want auto-filtering.
    hygiene_summary_lines: list[str] = []
    if include_dates is not None:
        from model_training_agent.date_hygiene import (
            filter_for_training,
            format_summary_lines,
        )
        kept, cls = filter_for_training(
            include_dates,
            instrument=args.instrument,
            validation_root=Path(args.validation_root),
            include_warns=not args.no_warns,
            include_fails=args.include_fails,
            missing_policy=args.missing_policy,
        )
        hygiene_summary_lines = format_summary_lines(
            cls, kept,
            include_warns=not args.no_warns,
            include_fails=args.include_fails,
            missing_policy=args.missing_policy,
        )
        if not kept:
            print()
            print("  " + "=" * 56)
            print(f"   No usable dates after hygiene filter -- nothing to train")
            print("  " + "=" * 56)
            for line in hygiene_summary_lines:
                print(line)
            print()
            return 4
        include_dates = kept

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
    # Phase-4 hygiene summary (only when --include-dates was used)
    for line in hygiene_summary_lines:
        print(line)
    print("  " + "=" * 56)

    # Phase 3 (2026-06-20): --resume looks up the most recent interrupted
    # run dir under models/<instrument>/ and threads it through so the
    # trainer picks up where the prior run left off.
    resume_dir = None
    if args.resume:
        from model_training_agent.checkpoint import find_resumable_run_dir
        resume_dir = find_resumable_run_dir(
            args.instrument, Path(args.models_root),
        )
        if resume_dir is None:
            print()
            print("  " + "=" * 56)
            print(f"   --resume: no interrupted run found for {args.instrument}")
            print("  " + "=" * 56)
            print(
                f"  Looked under {args.models_root}/{args.instrument}/ for a "
                f"timestamped dir with partial_folds.json or "
                f"partial_metrics.jsonl AND no training_manifest.json. "
                f"Falling back to a fresh run."
            )
            print()
        else:
            print(f"\n   Resuming run from: {resume_dir}\n")

    try:
        result = train_instrument(
            instrument=args.instrument,
            date_from=args.date_from,
            date_to=args.date_to,
            features_root=Path(args.features_root),
            models_root=Path(args.models_root),
            config_dir=Path(args.config_dir),
            val_days=args.val_days,
            cal_days=args.cal_days,
            n_folds=args.n_folds,
            fold_week_size=args.fold_week_size,
            n_jobs=n_jobs,
            include_dates=include_dates,
            resume_dir=resume_dir,
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
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        # Ctrl+C: prompt restart vs exit so the user can re-run with code
        # edits without manually relaunching the bat wrapper.
        from _shared.restart_prompt import prompt_restart_or_exit
        sys.exit(prompt_restart_or_exit("Training"))
