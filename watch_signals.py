"""
watch_signals.py — Live dashboard of SEA signals.

Usage:
    py watch_signals.py crudeoil
    py watch_signals.py nifty50 --interval 1

Shows today's GO_CALL / GO_PUT signals in real-time from
  logs/signals/{instrument}/YYYY-MM-DD_signals.log

Press Ctrl+C to exit.
"""

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

_IST = timezone(timedelta(hours=5, minutes=30))

instrument = sys.argv[1] if len(sys.argv) > 1 else "crudeoil"
interval = float(
    next(
        (
            sys.argv[i + 1]
            for i, a in enumerate(sys.argv)
            if a == "--interval" and i + 1 < len(sys.argv)
        ),
        1.0,
    )
)

MAX_ROWS = 25  # last N signals shown


def _clear():
    os.system("cls" if os.name == "nt" else "clear")


def _today_path():
    today = datetime.now(_IST).strftime("%Y-%m-%d")
    return Path(f"logs/signals/{instrument}/{today}_signals.log")


def _parse_lines(lines):
    rows = []
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        try:
            rows.append(json.loads(ln))
        except Exception:
            pass
    return rows


def _fmt(v, width=8, places=2):
    if v is None:
        return "-".ljust(width)
    if isinstance(v, float):
        return f"{v:>{width}.{places}f}"
    return str(v).ljust(width)


def _ago(ts_str):
    if not ts_str:
        return "-"
    try:
        dt = datetime.fromisoformat(ts_str)
        now = datetime.now(dt.tzinfo or _IST)
        sec = (now - dt).total_seconds()
        if sec < 60:
            return f"{sec:.0f}s ago"
        return f"{sec//60:.0f}m ago"
    except Exception:
        return "-"


while True:
    try:
        path = _today_path()
        rows: list[dict] = []
        if path.exists():
            with open(path, encoding="utf-8") as f:
                rows = _parse_lines(f.readlines())

        _clear()
        now = datetime.now(_IST).strftime("%H:%M:%S IST")
        print(f"  SEA Signals — {instrument.upper()}   [{now}]   file={path.name}")
        print("  " + "─" * 96)

        calls = [r for r in rows if r.get("direction") == "GO_CALL"]
        puts = [r for r in rows if r.get("direction") == "GO_PUT"]
        last_ts = rows[-1].get("timestamp_ist") if rows else None

        print(
            f"  Today so far:  {len(calls):>3} GO_CALL   {len(puts):>3} GO_PUT   "
            f"total={len(rows)}   last: {_ago(last_ts)}"
        )
        print("  " + "─" * 96)
        print(
            f"  {'TIME':<13} {'DIR':<9} {'PROB':>6}  "
            f"{'UP':>7}  {'DN':>7}  {'ATM':>7}  "
            f"{'CE_LTP':>8} {'PE_LTP':>8}  {'SPOT':>9}"
        )
        print("  " + "─" * 96)

        tail = rows[-MAX_ROWS:]
        if not tail:
            print("\n  (no signals yet)")
        else:
            for r in tail:
                ts = r.get("timestamp_ist", "")[11:19]  # HH:MM:SS
                direction = r.get("direction", "")
                prob = r.get("direction_prob_30s")
                up = r.get("max_upside_pred_30s")
                dn = r.get("max_drawdown_pred_30s")
                atm = r.get("atm_strike")
                ce = r.get("atm_ce_ltp")
                pe = r.get("atm_pe_ltp")
                spot = r.get("spot_price")

                tag = (
                    "\033[32mGO_CALL \033[0m"
                    if direction == "GO_CALL"
                    else "\033[31mGO_PUT  \033[0m"
                )
                print(
                    f"  {ts:<13} {tag} {_fmt(prob, 6, 3)}  "
                    f"{_fmt(up, 7, 2)}  {_fmt(dn, 7, 2)}  {_fmt(atm, 7, 0)}  "
                    f"{_fmt(ce, 8, 2)} {_fmt(pe, 8, 2)}  {_fmt(spot, 9, 2)}"
                )

        print()
        print("  Ctrl+C to exit.")
        time.sleep(interval)
    except KeyboardInterrupt:
        print("\n  Bye.")
        break
    except Exception as e:
        _clear()
        print(f"  watch_signals error: {e}")
        time.sleep(interval)
