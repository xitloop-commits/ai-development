"""TCS2 - Dhan detailed scrip master: download, cache, resolve contracts.

Spec: docs/systems/14_tcs2.md  (D7, D12, D18, D19, D22, D26)

This module answers one question per instrument: *exactly which security ids does
this process subscribe today?* Nothing else in TCS2 decides that.

Deliberate properties:
  * Stands alone (D7) - no API server, no Mongo, no other TCS2 module.
  * Uses the DETAILED master, for UNDERLYING_SECURITY_ID and EXPIRY_FLAG (D12),
    so weekly-vs-monthly comes from Dhan rather than from our assumption.
  * Resolves at startup only, never mid-session (D26).
  * Writes what it resolved to disk, because D22 makes our own records
    provisional: six months from now "which legs did we watch that day?" must be
    answerable from the record, not reconstructed from a master that has changed.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import json
import time
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path

from . import config as cfg

# Column positions in api-scrip-master-detailed.csv, verified 2026-09-23 against
# the live header. Parsed by index rather than by name so a reordered header
# fails loudly in _check_header() instead of silently mapping wrong fields.
COL = {
    "exch": 0, "segment": 1, "security_id": 2, "isin": 3, "instrument": 4,
    "underlying_security_id": 5, "underlying_symbol": 6, "symbol_name": 7,
    "display_name": 8, "instrument_type": 9, "series": 10, "lot_size": 11,
    "expiry_date": 12, "strike_price": 13, "option_type": 14, "tick_size": 15,
    "expiry_flag": 16,
}
_EXPECTED_HEADER = [
    "EXCH_ID", "SEGMENT", "SECURITY_ID", "ISIN", "INSTRUMENT",
    "UNDERLYING_SECURITY_ID", "UNDERLYING_SYMBOL", "SYMBOL_NAME", "DISPLAY_NAME",
    "INSTRUMENT_TYPE", "SERIES", "LOT_SIZE", "SM_EXPIRY_DATE", "STRIKE_PRICE",
    "OPTION_TYPE", "TICK_SIZE", "EXPIRY_FLAG",
]

WEEKLY = "W"
MONTHLY = "M"


class ScripError(RuntimeError):
    pass


@dataclass(frozen=True)
class Contract:
    security_id: str
    display_name: str
    instrument: str          # OPTIDX | OPTFUT | FUTIDX | FUTCOM | INDEX
    expiry: str              # YYYY-MM-DD, "" for an index
    strike: float            # 0.0 for futures and indices
    option_type: str         # CE | PE | XX
    expiry_flag: str         # W | M | ""
    lot_size: float
    tick_size: float

    @property
    def is_option(self) -> bool:
        return self.option_type in ("CE", "PE")


@dataclass(frozen=True)
class Resolved:
    """Everything one process subscribes on one day."""

    instrument: str
    trade_date: str
    index: Contract | None
    vix: Contract | None
    futures: tuple[Contract, ...]          # current + next (D19)
    option_expiries: tuple[str, ...]       # nearest first
    options: tuple[Contract, ...]          # every leg of every watched expiry

    @property
    def total_legs(self) -> int:
        n = len(self.options) + len(self.futures)
        return n + (1 if self.index else 0) + (1 if self.vix else 0)

    def security_ids(self) -> list[str]:
        ids = [c.security_id for c in self.options]
        ids += [c.security_id for c in self.futures]
        if self.index:
            ids.append(self.index.security_id)
        if self.vix:
            ids.append(self.vix.security_id)
        return ids


# -- Download / cache ----------------------------------------------------

def cache_age_hours(path: Path = cfg.SCRIP_CSV) -> float | None:
    if not path.exists():
        return None
    return (time.time() - path.stat().st_mtime) / 3600.0


def ensure_master(path: Path = cfg.SCRIP_CSV, max_age_hours: float | None = None,
                  force: bool = False) -> Path:
    """Download the detailed master only if the cache is stale.

    One shared file for all four processes (D18): four simultaneous 35 MB
    downloads at 08:54 is waste, and the file is identical for each. Reading a
    shared read-only file is not a D14 violation.
    """
    max_age = cfg.SCRIP_MAX_AGE_HOURS if max_age_hours is None else max_age_hours
    age = cache_age_hours(path)
    if not force and age is not None and age < max_age:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".csv.part")
    with urllib.request.urlopen(cfg.SCRIP_MASTER_URL, timeout=180) as r:
        data = r.read()
    if len(data) < 5_000_000:
        raise ScripError(f"scrip master looks truncated: {len(data)} bytes")
    tmp.write_bytes(data)
    tmp.replace(path)            # atomic: a reader never sees a half file
    return path


def _check_header(row: list[str]) -> None:
    got = [c.strip() for c in row[: len(_EXPECTED_HEADER)]]
    if got != _EXPECTED_HEADER:
        raise ScripError(
            "detailed scrip master header changed - column indices in COL are no "
            f"longer safe.\n  expected {_EXPECTED_HEADER}\n  got      {got}"
        )


def load(path: Path = cfg.SCRIP_CSV, exchange: str | None = None,
         underlying_symbol: str | None = None) -> list[list[str]]:
    """Read the master, optionally filtered. Returns raw rows.

    The exchange filter matters: MCX and NSE reuse the same small integers for
    different things, and omitting it is what once made BSE SENSEX rows look like
    a second CRUDEOIL option family.
    """
    rows: list[list[str]] = []
    with io.open(path, newline="", encoding="utf-8", errors="ignore") as f:
        rd = csv.reader(f)
        first = True
        for row in rd:
            if first:
                _check_header(row)
                first = False
                continue
            if len(row) <= COL["expiry_flag"]:
                continue
            if exchange and row[COL["exch"]] != exchange:
                continue
            if underlying_symbol and row[COL["underlying_symbol"]] != underlying_symbol:
                continue
            rows.append(row)
    return rows


def _contract(row: list[str]) -> Contract:
    def f(name: str, default: float = 0.0) -> float:
        try:
            return float(row[COL[name]])
        except (ValueError, IndexError):
            return default
    return Contract(
        security_id=row[COL["security_id"]].strip(),
        display_name=row[COL["display_name"]].strip(),
        instrument=row[COL["instrument"]].strip(),
        expiry=row[COL["expiry_date"]].strip()[:10],
        strike=f("strike_price"),
        option_type=(row[COL["option_type"]].strip() or "XX"),
        expiry_flag=row[COL["expiry_flag"]].strip(),
        lot_size=f("lot_size", 1.0),
        tick_size=f("tick_size", 0.05),
    )


# -- Resolution ----------------------------------------------------------

def _live_expiries(rows: list[list[str]], instrument: str, on: dt.date) -> list[str]:
    """Distinct expiry dates for this instrument type that have not passed."""
    out = {
        row[COL["expiry_date"]].strip()[:10]
        for row in rows
        if row[COL["instrument"]] == instrument
        and row[COL["expiry_date"]].strip()[:10] >= on.isoformat()
    }
    return sorted(e for e in out if e)


def pick_option_expiries(rows: list[list[str]], cap: cfg.Capability,
                         on: dt.date) -> list[str]:
    """Which option expiries this process watches today.

    NIFTY: current week, current month, next month.
    Everything else: current month, next month - no weekly exists (D11/D19).

    NIFTY's last-Tuesday weekly IS the monthly and carries flag M, so the same
    chain must not be counted twice (D26). De-duplicating by expiry DATE, rather
    than by flag, is what makes that safe.
    """
    live = _live_expiries(rows, cap.option_instrument, on)
    if not live:
        raise ScripError(f"{cap.name}: no live {cap.option_instrument} expiries on {on}")

    monthly_dates = {
        row[COL["expiry_date"]].strip()[:10]
        for row in rows
        if row[COL["instrument"]] == cap.option_instrument
        and row[COL["expiry_flag"]] == MONTHLY
    }
    monthlies = [e for e in live if e in monthly_dates]

    picked: list[str] = []
    if cap.has_weekly:
        picked.append(live[0])                    # nearest expiry, weekly or not
    for e in monthlies:
        if len(picked) >= cap.option_expiries:
            break
        if e not in picked:
            picked.append(e)
    # Fall back to plain nearest expiries if the master lacks monthly flags.
    for e in live:
        if len(picked) >= cap.option_expiries:
            break
        if e not in picked:
            picked.append(e)
    return sorted(set(picked))[: cap.option_expiries]


def pick_futures(rows: list[list[str]], cap: cfg.Capability,
                 on: dt.date) -> list[Contract]:
    """Current + next futures, always (D19).

    On MCX the options are written on a futures contract and the option expiry
    falls DAYS BEFORE its futures expiry - crude options 2026-10-15 belong to
    OCT FUT expiring 2026-10-19 - so the two must never be matched by assuming
    equal dates.
    """
    live = _live_expiries(rows, cap.futures_instrument, on)
    out: list[Contract] = []
    for e in live[: cap.futures_contracts]:
        for row in rows:
            if (row[COL["instrument"]] == cap.futures_instrument
                    and row[COL["expiry_date"]].strip()[:10] == e):
                out.append(_contract(row))
                break
    if not out:
        raise ScripError(f"{cap.name}: no live {cap.futures_instrument} on {on}")
    return out


def _find_index(path: Path, cap: cfg.Capability) -> Contract | None:
    if not cap.has_index:
        return None                      # MCX: the futures IS the underlying
    want = cap.underlying_symbol
    for row in load(path, exchange=cap.exchange):
        if row[COL["instrument"]] == "INDEX" and row[COL["underlying_symbol"]] == want:
            return _contract(row)
    return None


def _find_vix(path: Path, cap: cfg.Capability) -> Contract | None:
    if not cap.has_vix:
        return None                      # no crude/gas equivalent exists
    for row in load(path, exchange="NSE"):
        if (row[COL["instrument"]] == "INDEX"
                and "VIX" in row[COL["underlying_symbol"]].upper()):
            return _contract(row)
    return None


def resolve(instrument: str, on: dt.date | None = None,
            path: Path = cfg.SCRIP_CSV) -> Resolved:
    """Everything this process subscribes today. Startup only (D26)."""
    cap = cfg.CAPABILITIES[instrument]
    on = on or dt.date.today()
    rows = load(path, exchange=cap.exchange, underlying_symbol=cap.underlying_symbol)
    if not rows:
        raise ScripError(f"{instrument}: no {cap.exchange} rows for {cap.underlying_symbol}")

    expiries = pick_option_expiries(rows, cap, on)
    options = tuple(
        _contract(row) for row in rows
        if row[COL["instrument"]] == cap.option_instrument
        and row[COL["expiry_date"]].strip()[:10] in expiries
        and row[COL["option_type"]].strip() in ("CE", "PE")
    )
    return Resolved(
        instrument=instrument,
        trade_date=on.isoformat(),
        index=_find_index(path, cap),
        vix=_find_vix(path, cap),
        futures=tuple(pick_futures(rows, cap, on)),
        option_expiries=tuple(expiries),
        options=options,
    )


def save_resolved(r: Resolved, root: Path = cfg.RESOLVED_DIR) -> Path:
    """Persist the leg list. Required by D22 - the audit trail of what we watched."""
    root.mkdir(parents=True, exist_ok=True)
    out = root / f"{r.trade_date}_{r.instrument}.json"
    mtime = None
    if cfg.SCRIP_CSV.exists():
        mtime = dt.datetime.fromtimestamp(
            cfg.SCRIP_CSV.stat().st_mtime).isoformat(timespec="seconds")
    payload = {
        "instrument": r.instrument,
        "trade_date": r.trade_date,
        "resolved_at": dt.datetime.now().isoformat(timespec="seconds"),
        "scrip_master_mtime": mtime,
        "total_legs": r.total_legs,
        "option_expiries": list(r.option_expiries),
        "index": asdict(r.index) if r.index else None,
        "vix": asdict(r.vix) if r.vix else None,
        "futures": [asdict(c) for c in r.futures],
        "options": [asdict(c) for c in r.options],
    }
    out.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    return out
