"""
check_chain.py — Peek at recorded chain snapshots for a given instrument/date.

Usage:
    py check_chain.py crudeoil 2026-04-13
    py check_chain.py nifty 2026-04-14
"""

import gzip
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

instrument = sys.argv[1] if len(sys.argv) > 1 else "crudeoil"
date       = sys.argv[2] if len(sys.argv) > 2 else "2026-04-13"

path = Path(f"data/raw/{date}/{instrument}_chain_snapshots.ndjson.gz")

if not path.exists():
    print(f"File not found: {path}")
    sys.exit(1)

_IST = timezone(timedelta(hours=5, minutes=30))

def fmt_ts(recv_ts):
    try:
        return datetime.fromtimestamp(recv_ts, tz=_IST).strftime("%H:%M:%S")
    except Exception:
        return str(recv_ts)

print(f"Reading: {path}\n")
print(f"{'Time (IST)':<12} {'Spot':>10} {'Strikes':>8}  {'Expiry'}")
print("-" * 50)

count = 0
try:
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            row     = json.loads(line)
            ts      = fmt_ts(row.get("recv_ts", 0))
            spot    = row.get("spotPrice", "?")
            strikes = len(row.get("rows", []))
            expiry  = row.get("expiry", "?")
            print(f"{ts:<12} {spot:>10} {strikes:>8}  {expiry}")
            count += 1
except Exception:
    pass  # file still open by TFA — truncated gzip at end is expected

print(f"\nTotal snapshots: {count}")