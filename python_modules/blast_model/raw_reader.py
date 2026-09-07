"""Readers for the raw tick recordings — the model's ONLY input.

Files per day under data/raw/<YYYY-MM-DD>/ (written by the recorder; we only
READ, never touch the recorder itself):
  nifty50_underlying_ticks.ndjson.gz  — futures ticks (ltp, ltq, bid/ask, oi…)
  nifty50_option_ticks.ndjson.gz      — per strike-leg ticks (strike, opt_type,
                                        ltp, bid/ask, depth, oi, volume…)
  nifty50_chain_snapshots.ndjson.gz   — full chain every ~22s (spotPrice, rows
                                        with callOI/putOI/callIV/putIV/LTP…)

All readers are corruption-tolerant: a power-cut can truncate a gz mid-stream,
so they yield everything that parses and stop quietly at the first bad byte.
"""
from __future__ import annotations

import gzip
import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

IST = timezone(timedelta(hours=5, minutes=30))
# Anchor to the repo root (…/python_modules/blast_model/raw_reader.py → up 2)
# so the module works from any working directory.
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW_DIR = os.environ.get("BLAST_RAW_DIR", os.path.join(_ROOT, "data", "raw"))


def day_dir(date: str) -> str:
    return os.path.join(RAW_DIR, date)


def _iter_ndjson_gz(path: str) -> Iterator[dict[str, Any]]:
    """Yield parsed lines; swallow truncation/corruption at the seam."""
    if not os.path.exists(path):
        return
    try:
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except (EOFError, OSError, gzip.BadGzipFile):
        return


def iter_underlying(date: str, instrument: str = "nifty50") -> Iterator[dict[str, Any]]:
    return _iter_ndjson_gz(os.path.join(day_dir(date), f"{instrument}_underlying_ticks.ndjson.gz"))


def iter_options(date: str, instrument: str = "nifty50") -> Iterator[dict[str, Any]]:
    return _iter_ndjson_gz(os.path.join(day_dir(date), f"{instrument}_option_ticks.ndjson.gz"))


def iter_chain(date: str, instrument: str = "nifty50") -> Iterator[dict[str, Any]]:
    return _iter_ndjson_gz(os.path.join(day_dir(date), f"{instrument}_chain_snapshots.ndjson.gz"))


def session_open_ts(date: str, hhmm: str = "09:15") -> float:
    h, m = hhmm.split(":")
    return datetime.strptime(date, "%Y-%m-%d").replace(
        hour=int(h), minute=int(m), tzinfo=IST
    ).timestamp()


def list_recorded_dates(instrument: str = "nifty50") -> list[str]:
    """Dates that have all three raw files for the instrument."""
    if not os.path.isdir(RAW_DIR):
        return []
    out = []
    for d in sorted(os.listdir(RAW_DIR)):
        if len(d) == 10 and d[4] == "-" and d[7] == "-":
            base = os.path.join(RAW_DIR, d)
            if all(
                os.path.exists(os.path.join(base, f"{instrument}_{k}.ndjson.gz"))
                for k in ("underlying_ticks", "option_ticks", "chain_snapshots")
            ):
                out.append(d)
    return out


@dataclass(frozen=True)
class DayLock:
    """The session strike lock — same rule as the platform: from the first
    chain snapshot at/after open, CE = ATM − offset strikes, PE = ATM + offset."""
    date: str
    expiry: str
    atm: float
    ce_strike: float
    pe_strike: float
    spot_at_lock: float


def compute_day_lock(date: str, offset: int, instrument: str = "nifty50",
                     open_hhmm: str = "09:15") -> DayLock | None:
    open_ts = session_open_ts(date, open_hhmm)
    last_pre = None
    for snap in iter_chain(date, instrument):
        ts = snap.get("recv_ts", 0)
        rows = snap.get("rows") or []
        spot = snap.get("spotPrice") or 0
        if not rows or spot <= 0:
            continue
        if ts < open_ts:
            last_pre = snap
            continue
        return _lock_from_snapshot(snap, date, offset)
    if last_pre is not None:  # recorder started late — best effort
        return _lock_from_snapshot(last_pre, date, offset)
    return None


def _lock_from_snapshot(snap: dict[str, Any], date: str, offset: int) -> DayLock | None:
    rows = sorted((r for r in snap.get("rows", []) if r.get("strike")), key=lambda r: r["strike"])
    spot = snap.get("spotPrice", 0)
    if not rows or spot <= 0:
        return None
    atm_i = min(range(len(rows)), key=lambda i: abs(rows[i]["strike"] - spot))
    ce = rows[max(0, atm_i - offset)]["strike"]
    pe = rows[min(len(rows) - 1, atm_i + offset)]["strike"]
    return DayLock(
        date=date, expiry=str(snap.get("expiry", "")), atm=rows[atm_i]["strike"],
        ce_strike=ce, pe_strike=pe, spot_at_lock=spot,
    )
