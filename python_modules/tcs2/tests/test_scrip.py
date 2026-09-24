"""TCS2 - tests for contract resolution.

Spec: docs/systems/14_tcs2.md

These tests use a hand-built mini scrip master rather than the real 35 MB file,
so they run offline and assert behaviour rather than today's market.
"""
from __future__ import annotations

import datetime as dt
import io
from pathlib import Path

import pytest

from tcs2 import config as cfg
from tcs2 import scrip

HEADER = (
    "EXCH_ID,SEGMENT,SECURITY_ID,ISIN,INSTRUMENT,UNDERLYING_SECURITY_ID,"
    "UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,INSTRUMENT_TYPE,SERIES,LOT_SIZE,"
    "SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE,EXPIRY_FLAG,BRACKET_FLAG\n"
)


def _row(exch, sid, instr, und_sym, name, lot, expiry, strike, opt, flag,
         und_sid="999"):
    return (f"{exch},D,{sid},NA,{instr},{und_sid},{und_sym},{und_sym},{name},"
            f"{instr},NA,{lot},{expiry},{strike},{opt},0.05,{flag},N\n")


def _write(tmp_path: Path, rows: list[str]) -> Path:
    p = tmp_path / "master.csv"
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(HEADER)
        for r in rows:
            f.write(r)
    return p


def _nifty_master(tmp_path: Path) -> Path:
    """NIFTY with three weeklies, two monthlies, and three futures contracts.

    2026-10-27 is deliberately BOTH the month end and a Tuesday, i.e. the case
    where the weekly and the monthly are the same chain (D26).
    """
    rows = []
    for exp, flag in [("2026-10-06", "W"), ("2026-10-13", "W"),
                      ("2026-10-20", "W"), ("2026-10-27", "M"),
                      ("2026-11-24", "M")]:
        for strike in (23000, 23100, 23200):
            for opt in ("CE", "PE"):
                rows.append(_row("NSE", f"n{exp}{strike}{opt}", "OPTIDX", "NIFTY",
                                 f"NIFTY {strike} {opt}", 65, exp, strike, opt, flag))
    for exp, sid in [("2026-10-27", "F1"), ("2026-11-24", "F2"), ("2026-12-29", "F3")]:
        rows.append(_row("NSE", sid, "FUTIDX", "NIFTY", f"NIFTY FUT {exp}", 65,
                         exp, 0, "XX", "M"))
    rows.append(_row("NSE", "13", "INDEX", "NIFTY", "Nifty 50", 1, "", 0, "XX", "N"))
    rows.append(_row("NSE", "21", "INDEX", "INDIA VIX", "India VIX", 1, "", 0, "XX", "N"))
    return _write(tmp_path, rows)


def _crude_master(tmp_path: Path) -> Path:
    """Crude: monthly options only, and option expiry BEFORE its futures expiry."""
    rows = []
    for exp in ("2026-10-15", "2026-11-17", "2026-12-16"):
        for strike in (9000, 9050):
            for opt in ("CE", "PE"):
                rows.append(_row("MCX", f"c{exp}{strike}{opt}", "OPTFUT", "CRUDEOIL",
                                 f"CRUDEOIL {strike} {opt}", 100, exp, strike, opt, "M"))
    for exp, sid in [("2026-10-19", "CF1"), ("2026-11-19", "CF2")]:
        rows.append(_row("MCX", sid, "FUTCOM", "CRUDEOIL", f"CRUDEOIL FUT {exp}", 100,
                         exp, 0, "XX", "M"))
    # A BSE row with a colliding small underlying id - the exchange filter must
    # exclude it. Forgetting this once made SENSEX look like a crude option family.
    rows.append(_row("BSE", "bse1", "OPTIDX", "CRUDEOIL", "NOT CRUDE", 1,
                     "2026-10-08", 100, "CE", "W", und_sid="11"))
    return _write(tmp_path, rows)


# -- header guard --------------------------------------------------------

def test_header_change_fails_loudly(tmp_path):
    p = tmp_path / "bad.csv"
    p.write_text("A,B,C\n1,2,3\n", encoding="utf-8")
    with pytest.raises(scrip.ScripError, match="header changed"):
        scrip.load(p)


# -- nifty: three chains, weekly included -------------------------------

def test_nifty_watches_three_expiries_including_the_weekly(tmp_path):
    p = _nifty_master(tmp_path)
    r = scrip.resolve("nifty50", on=dt.date(2026, 10, 1), path=p)
    assert len(r.option_expiries) == 3
    assert "2026-10-06" in r.option_expiries          # the nearest weekly
    assert "2026-10-27" in r.option_expiries          # current month
    assert "2026-11-24" in r.option_expiries          # next month


def test_nifty_never_subscribes_the_same_chain_twice(tmp_path):
    """On the last Tuesday the weekly IS the monthly (D26).

    Resolving on that day must not list 2026-10-27 twice, and every leg must be
    unique.
    """
    p = _nifty_master(tmp_path)
    r = scrip.resolve("nifty50", on=dt.date(2026, 10, 21), path=p)
    assert len(r.option_expiries) == len(set(r.option_expiries))
    ids = [c.security_id for c in r.options]
    assert len(ids) == len(set(ids)), "a leg was subscribed twice"


def test_nifty_has_index_and_vix(tmp_path):
    p = _nifty_master(tmp_path)
    r = scrip.resolve("nifty50", on=dt.date(2026, 10, 1), path=p)
    assert r.index is not None and r.index.security_id == "13"
    assert r.vix is not None and r.vix.security_id == "21"


# -- crude: monthly only, no index, no vix ------------------------------

def test_crude_has_no_index_and_no_vix(tmp_path):
    p = _crude_master(tmp_path)
    r = scrip.resolve("crudeoil", on=dt.date(2026, 10, 1), path=p)
    assert r.index is None, "MCX has no spot index - the futures is the underlying"
    assert r.vix is None, "there is no crude VIX"


def test_crude_watches_two_expiries_only(tmp_path):
    p = _crude_master(tmp_path)
    r = scrip.resolve("crudeoil", on=dt.date(2026, 10, 1), path=p)
    assert len(r.option_expiries) == 2
    assert r.option_expiries == ("2026-10-15", "2026-11-17")


def test_crude_option_expiry_differs_from_its_futures_expiry(tmp_path):
    """The MCX trap: options 2026-10-15 belong to OCT FUT expiring 2026-10-19.

    They must never be paired by assuming equal dates.
    """
    p = _crude_master(tmp_path)
    r = scrip.resolve("crudeoil", on=dt.date(2026, 10, 1), path=p)
    assert r.option_expiries[0] == "2026-10-15"
    assert r.futures[0].expiry == "2026-10-19"
    assert r.futures[0].expiry > r.option_expiries[0]


def test_other_exchange_rows_are_excluded(tmp_path):
    """A BSE row carrying the same symbol must not leak into an MCX resolve."""
    p = _crude_master(tmp_path)
    r = scrip.resolve("crudeoil", on=dt.date(2026, 10, 1), path=p)
    assert all(c.security_id != "bse1" for c in r.options)


# -- futures: always two ------------------------------------------------

@pytest.mark.parametrize("name,path_fn", [("nifty50", _nifty_master),
                                          ("crudeoil", _crude_master)])
def test_always_two_futures_contracts(tmp_path, name, path_fn):
    """D19 - current + next, always, not only during rollover week."""
    p = path_fn(tmp_path)
    r = scrip.resolve(name, on=dt.date(2026, 10, 1), path=p)
    assert len(r.futures) == 2
    assert r.futures[0].expiry < r.futures[1].expiry


# -- connection budget ---------------------------------------------------

def test_one_connection_is_enough(tmp_path):
    """D13 - a process never needs a second connection."""
    p = _nifty_master(tmp_path)
    r = scrip.resolve("nifty50", on=dt.date(2026, 10, 1), path=p)
    assert r.total_legs <= cfg.MAX_INSTRUMENTS_PER_CONN


def test_security_ids_are_unique_and_complete(tmp_path):
    p = _nifty_master(tmp_path)
    r = scrip.resolve("nifty50", on=dt.date(2026, 10, 1), path=p)
    ids = r.security_ids()
    assert len(ids) == len(set(ids))
    assert len(ids) == r.total_legs


# -- opt-in leg dump (hand-debugging only, nothing depends on it) --------

def test_save_resolved_dumps_the_leg_list(tmp_path, monkeypatch):
    p = _crude_master(tmp_path)
    r = scrip.resolve("crudeoil", on=dt.date(2026, 10, 1), path=p)
    out = scrip.save_resolved(r, root=tmp_path / "resolved")
    assert out.exists()
    import json
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["instrument"] == "crudeoil"
    assert payload["total_legs"] == r.total_legs
    assert len(payload["options"]) == len(r.options)
    assert payload["index"] is None


# -- expired contracts ---------------------------------------------------

def test_expired_expiries_are_ignored(tmp_path):
    """Resolution happens at startup for TODAY (D26); past expiries never appear."""
    p = _nifty_master(tmp_path)
    r = scrip.resolve("nifty50", on=dt.date(2026, 10, 14), path=p)
    assert "2026-10-06" not in r.option_expiries
    assert "2026-10-13" not in r.option_expiries
    assert all(e >= "2026-10-14" for e in r.option_expiries)
