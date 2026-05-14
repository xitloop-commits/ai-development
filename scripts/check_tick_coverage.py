"""Audit per-day, per-instrument tick coverage vs expected session windows.

Reads underlying_ticks.ndjson.gz first/last timestamp + line count.
Compares to expected session: NSE 09:15-15:30, MCX 09:00-23:30 IST.
Reports gaps and partial coverage.
"""
from __future__ import annotations
import gzip, json, os, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_IST = timezone(timedelta(hours=5, minutes=30))
ROOT = Path("/c/Users/Admin/ai-development/ai-development")
if not ROOT.exists():
    ROOT = Path(r"c:\Users\Admin\ai-development\ai-development")
os.chdir(ROOT)

INSTRUMENTS = ["nifty50", "banknifty", "crudeoil", "naturalgas"]
SESSION = {
    "nifty50":    ((9, 15), (15, 30)),
    "banknifty":  ((9, 15), (15, 30)),
    "crudeoil":   ((9, 0),  (23, 30)),
    "naturalgas": ((9, 0),  (23, 30)),
}


def session_secs(inst):
    (sh, sm), (eh, em) = SESSION[inst]
    return (eh * 3600 + em * 60) - (sh * 3600 + sm * 60)


def scan_ticks(path: Path, date_str: str | None = None) -> tuple[int, float | None, float | None, int]:
    """Return (line_count, first_ts, last_ts, parse_errors). Filters timestamps to file's date window."""
    n = 0; first = None; last = None; errs = 0
    truncated = False
    # Allowed window: 24h centred on the file's date (covers MCX overnight to 23:59 IST + next-day rollover)
    lo = hi = None
    if date_str:
        d0 = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        lo = d0.timestamp()
        hi = lo + 86400 + 3 * 3600  # allow up to next-day 03:00 IST (MCX runs to 23:30)
    if not path.exists(): return 0, None, None, 0
    try:
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
            while True:
                try:
                    line = f.readline()
                except (OSError, EOFError):
                    truncated = True
                    break
                if not line: break
                line = line.strip()
                if not line: continue
                n += 1
                try:
                    d = json.loads(line)
                    ts = d.get("ltt") or d.get("timestamp") or d.get("ts") or d.get("t")
                    if ts is None: continue
                    ts = float(ts)
                    if lo is not None and not (lo <= ts <= hi): continue
                    if first is None: first = ts
                    last = ts
                except Exception:
                    errs += 1
    except Exception:
        pass
    return n, first, last, (errs + (1 if truncated else 0))


def fmt_time(ts: float | None) -> str:
    # Dhan ltt is IST-anchored epoch — treat as UTC to get IST clock display
    if ts is None: return "    —   "
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%H:%M:%S")


def coverage_pct(first_ts: float, last_ts: float, inst: str) -> float:
    if first_ts is None or last_ts is None: return 0.0
    return (last_ts - first_ts) / session_secs(inst) * 100.0


dates = sorted([d.name for d in (ROOT / "data" / "raw").iterdir() if d.is_dir()])
print(f"{'date':12} {'instrument':11} {'lines':>9}  {'first':9} {'last':9}  {'span':>6}m  {'coverage':>8}  {'expected':>8}")
print("-" * 90)

for date in dates:
    for inst in INSTRUMENTS:
        # Primary file only; fall back to recovered if primary missing or empty
        p_main = ROOT / "data" / "raw" / date / f"{inst}_underlying_ticks.ndjson.gz"
        p_rec = ROOT / "data" / "raw" / date / f"{inst}_underlying_ticks.recovered.ndjson.gz"
        n, first, last, errs = scan_ticks(p_main, date) if p_main.exists() else (0, None, None, 0)
        if first is None and p_rec.exists():
            n, first, last, errs = scan_ticks(p_rec, date)
        if n == 0: continue
        total_lines = n
        any_truncated = bool(errs)
        seen_ts = [first, last]
        first = min(seen_ts); last = max(seen_ts)
        span_min = (last - first) / 60.0
        cov = coverage_pct(first, last, inst)
        sess_min = session_secs(inst) / 60.0
        flag = " *trunc" if any_truncated else ""
        print(f"{date:12} {inst:11} {total_lines:>9}  {fmt_time(first)} {fmt_time(last)}  {span_min:>6.0f}m  {cov:>7.1f}%  {sess_min:>6.0f}m{flag}")
