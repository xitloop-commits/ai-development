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
_HERE           = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

from model_training_agent.trainer import train_instrument


VALID_INSTRUMENTS = ("nifty50", "banknifty", "crudeoil", "naturalgas")


def main() -> int:
    p = argparse.ArgumentParser(
        prog="mta",
        description="Model Training Agent (MVP)",
    )
    p.add_argument("--instrument", required=True, choices=VALID_INSTRUMENTS)
    p.add_argument("--date-from",  required=True, help="YYYY-MM-DD inclusive")
    p.add_argument("--date-to",    required=True, help="YYYY-MM-DD inclusive")
    p.add_argument("--features-root", default="data/features")
    p.add_argument("--models-root",   default="models")
    p.add_argument("--config-dir",    default="config/model_feature_config")
    args = p.parse_args()

    print()
    print("  " + "=" * 56)
    print(f"   MTA -- training {args.instrument}")
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
        )
    except RuntimeError as e:
        print(f"\n  ERROR: {e}\n")
        return 2

    print()
    print("  " + "=" * 56)
    print(f"   Training complete")
    print(f"   Timestamp:  {result.timestamp}")
    print(f"   Output:     {result.output_dir}")
    print(f"   Features:   {result.feature_count}")
    print(f"   Models:     {len(result.metrics)}")
    print("  " + "=" * 56)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
