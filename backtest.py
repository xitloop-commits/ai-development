"""
backtest.py — Replay a Parquet feature file as if it were live.

Streams feature rows from data/features/<date>/<instrument>_features.parquet
into data/features/<instrument>_live.ndjson, which SEA tails in live mode.

Run in one terminal; start SEA in another, watch_signals.py in a third.

Usage:
    py backtest.py crudeoil 2026-04-15              # real-time pacing (slow)
    py backtest.py crudeoil 2026-04-15 --speed 10   # 10x faster
    py backtest.py crudeoil 2026-04-15 --speed 0    # as fast as possible
    py backtest.py crudeoil 2026-04-15 --no-truncate # append to existing live file
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Force UTF-8 on Windows so box-drawing characters print cleanly
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import pandas as pd

_IST = timezone(timedelta(hours=5, minutes=30))


def stream_parquet(
    instrument: str,
    date_str: str,
    speed: float = 1.0,  # 1.0 = real-time; 0 = no sleep
    truncate: bool = True,
    features_root: Path = Path("data/features"),
) -> None:
    parquet_path = features_root / date_str / f"{instrument}_features.parquet"
    if not parquet_path.exists():
        print(f"  ERROR: {parquet_path} not found")
        sys.exit(1)

    live_path = features_root / f"{instrument}_live.ndjson"

    print()
    print("  ═══════════════════════════════════════════════════════════")
    print(f"    BACKTEST — {instrument} {date_str}")
    print("  ═══════════════════════════════════════════════════════════")
    print(f"    Source:   {parquet_path}")
    print(f"    Target:   {live_path}")
    print(f"    Speed:    {speed}x" if speed > 0 else "    Speed:    no-sleep (max rate)")
    print(f"    Mode:     {'truncate + overwrite' if truncate else 'append'}")
    print("  ═══════════════════════════════════════════════════════════")
    print()

    df = pd.read_parquet(parquet_path)
    print(f"  Loaded {len(df):,} rows, {len(df.columns)} cols from parquet")

    # Only stream TRADING rows (SEA filters these anyway, but saves I/O)
    if "trading_state" in df.columns:
        n_before = len(df)
        df = df[df["trading_state"] == "TRADING"].reset_index(drop=True)
        print(f"  Filtered to TRADING state: {len(df):,} rows (dropped {n_before - len(df):,})")

    # Sort by timestamp so pacing matches real chronological order
    if "timestamp" in df.columns:
        df = df.sort_values("timestamp").reset_index(drop=True)

    live_path.parent.mkdir(parents=True, exist_ok=True)
    mode = "w" if truncate else "a"

    print("\n  Streaming (Ctrl+C to stop)...\n")

    prev_ts: float | None = None
    started = time.time()
    wrote = 0
    with open(live_path, mode, encoding="utf-8") as f:
        for _, row in df.iterrows():
            d = {
                k: (None if pd.isna(v) else (v.item() if hasattr(v, "item") else v))
                for k, v in row.to_dict().items()
            }
            f.write(json.dumps(d, default=str) + "\n")
            f.flush()
            wrote += 1

            # Real-time pacing based on recorded timestamps
            if speed > 0 and prev_ts is not None:
                dt = max(0.0, (d.get("timestamp") or 0) - prev_ts)
                to_sleep = dt / speed
                # Cap sleep at 5s so long gaps don't hang the backtest
                if to_sleep > 5.0:
                    to_sleep = 5.0
                if to_sleep > 0:
                    time.sleep(to_sleep)
            prev_ts = d.get("timestamp")

            if wrote % 500 == 0:
                elapsed = time.time() - started
                rate = wrote / max(elapsed, 0.001)
                now = datetime.now(_IST).strftime("%H:%M:%S")
                sys.stdout.write(
                    f"\r  [{now}]  streamed {wrote:>7,} / {len(df):,}  " f"({rate:>6.0f}/s)"
                )
                sys.stdout.flush()

    elapsed = time.time() - started
    print(
        f"\n\n  Done. {wrote:,} rows streamed in {elapsed:.1f}s "
        f"({wrote / max(elapsed, 0.001):.0f}/s)"
    )


def main() -> int:
    p = argparse.ArgumentParser(prog="backtest")
    p.add_argument("instrument", choices=("nifty50", "banknifty", "crudeoil", "naturalgas"))
    p.add_argument("date", help="YYYY-MM-DD (folder under data/features/)")
    p.add_argument(
        "--speed",
        type=float,
        default=0,
        help="Pacing multiplier vs real-time. 0 = no sleep (fastest), "
        "1 = real-time, 10 = 10x faster. Default: 0",
    )
    p.add_argument(
        "--no-truncate",
        action="store_true",
        help="Append to existing live ndjson instead of overwriting",
    )
    p.add_argument("--features-root", default="data/features")
    args = p.parse_args()

    try:
        stream_parquet(
            instrument=args.instrument,
            date_str=args.date,
            speed=args.speed,
            truncate=not args.no_truncate,
            features_root=Path(args.features_root),
        )
    except KeyboardInterrupt:
        print("\n  Stopped by user.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
