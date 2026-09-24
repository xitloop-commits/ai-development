"""TCS2 - tests for the three database tiers.

Spec: docs/systems/14_tcs2.md  D23, D24, D29, D34

These need a local MongoDB. Each test gets a throwaway database that is dropped
afterwards, so nothing ever touches the live one.
"""
from __future__ import annotations

import datetime as dt
import time
import uuid

import numpy as np
import pytest

from tcs2 import store as st
from tcs2.chain import Chain, OIChange
from tcs2.scrip import Contract, Resolved
from tcs2.wire import DepthLevel, ResponseCode, Tick

pymongo = pytest.importorskip("pymongo")

EXPIRY = "2026-10-06"
DAY = "2026-10-01"


@pytest.fixture
def store():
    """A throwaway database, dropped on the way out."""
    from pymongo import MongoClient
    from pymongo.errors import ServerSelectionTimeoutError

    name = f"tcs2_test_{uuid.uuid4().hex[:10]}"
    client = MongoClient("mongodb://localhost:27017/", serverSelectionTimeoutMS=2000)
    try:
        client.admin.command("ping")
    except ServerSelectionTimeoutError:
        pytest.skip("no local MongoDB")
    s = st.Store(database=name, client=client)
    s.ensure_collections()
    try:
        yield s
    finally:
        client.drop_database(name)
        client.close()


# -- a small chain to store ---------------------------------------------

def _chain() -> Chain:
    opts, sid = [], 1000
    for k in (23400.0, 23500.0, 23600.0):
        for side in ("CE", "PE"):
            opts.append(Contract(str(sid), f"N {k:.0f} {side}", "OPTIDX",
                                 EXPIRY, k, side, "W", 65, 0.05))
            sid += 1
    r = Resolved(instrument="nifty50", trade_date=DAY,
                 index=Contract("13", "Nifty 50", "INDEX", "", 0.0, "XX", "", 1, 0.05),
                 vix=None,
                 futures=(Contract("900", "FUT", "FUTIDX", EXPIRY, 0.0, "XX",
                                   "M", 65, 0.05),),
                 option_expiries=(EXPIRY,), options=tuple(opts))
    return Chain(r)


def _tick(sid: int, ltp=100.0, oi=1000, volume=5000) -> Tick:
    depth = tuple(DepthLevel(500, 400, 3, 2, ltp - 1, ltp + 1) for _ in range(5))
    return Tick(security_id=sid, segment=2, kind=ResponseCode.FULL,
                recv_ts=time.time(), ltp=ltp, ltq=65, volume=volume, oi=oi,
                high_oi=oi + 50, low_oi=oi - 50,
                day_open=ltp - 5, day_high=ltp + 5, day_low=ltp - 8,
                bid=ltp - 1, ask=ltp + 1, bid_size=500, ask_size=400, depth=depth)


def _loaded() -> Chain:
    c = _chain()
    c.on_tick(Tick(security_id=13, segment=0, kind=ResponseCode.TICKER,
                   recv_ts=time.time(), ltp=23500.0))
    for i, sid in enumerate(range(1000, 1006)):
        c.on_tick(_tick(sid, ltp=50.0 + i * 20, oi=1000 + i * 100,
                        volume=5000 + i * 10))
    c.refresh_analytics()
    return c


# -- tier 1: Now ---------------------------------------------------------

def test_current_upserts_one_document_per_leg(store):
    c = _loaded()
    n = store.upsert_current("nifty50", st.current_rows(c))
    assert n == 6
    assert len(store.load_current("nifty50")) == 6


def test_current_is_overwritten_not_appended(store):
    """The Now tier must stay bounded - it is a photo, not a timeline (D23)."""
    c = _loaded()
    store.upsert_current("nifty50", st.current_rows(c))
    c.on_tick(_tick(1000, ltp=999.0, oi=7777, volume=9999))
    store.upsert_current("nifty50", st.current_rows(c))
    rows = store.load_current("nifty50")
    assert len(rows) == 6, "a second flush must not double the collection"
    row = next(r for r in rows if r["_id"] == 1000)
    assert row["ltp"] == pytest.approx(999.0)
    assert row["oi"] == 7777


def test_current_skips_legs_that_never_ticked(store):
    """A leg with no data has nothing to say; storing zeros would invent data."""
    c = _chain()
    c.on_tick(_tick(1000))
    assert len(st.current_rows(c)) == 1


def test_current_survives_a_restart(store):
    """What this tier is for: coming back at 11:00 without starting blind."""
    c = _loaded()
    store.upsert_current("nifty50", st.current_rows(c))
    reloaded = {r["_id"]: r for r in store.load_current("nifty50")}
    assert reloaded[1000]["oi_open"] == 1000
    assert reloaded[1000]["exp"] == EXPIRY
    assert reloaded[1000]["side"] == "CE"


def test_nan_is_stored_as_absent_never_as_zero(store):
    """D38 carried into storage: a stored 0 would later look measured."""
    c = _chain()
    c.on_tick(_tick(1000))          # priced, but no spot, so no IV
    rows = st.current_rows(c)
    assert rows[0]["iv"] is None
    store.upsert_current("nifty50", rows)
    assert store.load_current("nifty50")[0]["iv"] is None


# -- tier 2: intraday ----------------------------------------------------

def _changes(n: int = 5, sid: int = 1000) -> list[OIChange]:
    base = time.time()
    return [OIChange(ts=base + i, security_id=sid, strike=23500.0, is_call=True,
                     expiry=EXPIRY, oi=1000 + i * 100, oi_delta=100,
                     ltp=95.0 + i, volume=5000 + i * 10) for i in range(n)]


def test_intraday_writes_one_row_per_oi_change(store):
    assert store.write_intraday("nifty50", _changes(5), DAY) == 5
    assert len(store.read_intraday("nifty50", 1000, DAY)) == 5


def test_intraday_rows_come_back_in_time_order(store):
    store.write_intraday("nifty50", _changes(8), DAY)
    rows = store.read_intraday("nifty50", 1000, DAY)
    assert [r["oi"] for r in rows] == [1000 + i * 100 for i in range(8)]


def test_intraday_carries_enough_to_stand_alone(store):
    store.write_intraday("nifty50", _changes(1), DAY)
    r = store.read_intraday("nifty50", 1000, DAY)[0]
    assert r["meta"]["strike"] == 23500.0
    assert r["meta"]["side"] == "CE"
    assert r["meta"]["exp"] == EXPIRY
    assert r["doi"] == 100
    assert r["ltp"] == pytest.approx(95.0)


def test_writing_nothing_is_not_an_error(store):
    assert store.write_intraday("nifty50", [], DAY) == 0


def test_a_replay_must_clear_the_day_first(store):
    """Time-series collections take no unique index (D24).

    So idempotency cannot be enforced by the database, and a replay would
    silently double every row. `clear_intraday` is how a caller stays honest.
    """
    store.write_intraday("nifty50", _changes(5), DAY)
    store.write_intraday("nifty50", _changes(5), DAY)       # careless replay
    assert len(store.read_intraday("nifty50", 1000, DAY)) == 10, (
        "the database cannot prevent this - the caller must")

    removed = store.clear_intraday("nifty50", DAY)
    assert removed == 10
    store.write_intraday("nifty50", _changes(5), DAY)
    assert len(store.read_intraday("nifty50", 1000, DAY)) == 5


def test_clearing_one_day_leaves_the_others(store):
    store.write_intraday("nifty50", _changes(3), "2026-10-01")
    store.write_intraday("nifty50", _changes(3), "2026-10-02")
    store.clear_intraday("nifty50", "2026-10-01")
    assert len(store.read_intraday("nifty50", 1000, "2026-10-02")) == 3


def test_clearing_one_instrument_leaves_the_others(store):
    """Four processes write here; one must never delete another's rows (D14)."""
    store.write_intraday("nifty50", _changes(3), DAY)
    store.write_intraday("banknifty", _changes(3), DAY)
    store.clear_intraday("nifty50", DAY)
    assert len(store.read_intraday("banknifty", 1000, DAY)) == 3


# -- retention -----------------------------------------------------------

def test_intraday_older_than_the_window_is_pruned(store):
    today = dt.date(2026, 10, 20)
    for offset in (0, 3, 6, 8, 30):
        d = (today - dt.timedelta(days=offset)).isoformat()
        store.write_intraday("nifty50", _changes(2), d)
    removed = store.prune_intraday(keep_days=7, today=today)
    assert removed == 4                       # the 8-day and 30-day rows
    left = {r["meta"]["d"] for r in store.read_intraday("nifty50", 1000)}
    assert left == {(today - dt.timedelta(days=o)).isoformat()
                    for o in (0, 3, 6)}


def test_pruning_is_safe_because_ticks_can_rebuild_it(store):
    """The reason 7 days is enough (D23): nothing here is the only copy."""
    store.write_intraday("nifty50", _changes(4), "2020-01-01")
    assert store.prune_intraday(keep_days=7, today=dt.date(2026, 10, 20)) == 4


# -- tier 3: end of day --------------------------------------------------

def test_eod_writes_one_row_per_strike(store):
    c = _loaded()
    assert store.write_eod("nifty50", DAY, st.eod_rows(c)) == 6
    assert len(store.read_eod("nifty50")) == 6


def test_eod_keeps_where_a_strike_opened_and_ended(store):
    """`oi_open` is the value that cannot be recovered later (D29 part 1)."""
    c = _loaded()
    store.write_eod("nifty50", DAY, st.eod_rows(c))
    row = next(r for r in store.read_eod("nifty50") if r["meta"]["sid"] == 1000)
    assert row["oi_open"] == 1000
    assert row["oi_close"] == 1000
    assert "oi_high" in row and "oi_low" in row


def test_eod_rows_are_tagged_feed_or_official(store):
    """D34: the exchange revises OI after the close, by 15.5% on crude.

    A study has to know which number it is reading.
    """
    c = _loaded()
    store.write_eod("nifty50", DAY, st.eod_rows(c), source=st.FROM_FEED)
    assert all(r["meta"]["src"] == st.FROM_FEED for r in store.read_eod("nifty50"))

    store.clear_eod("nifty50", DAY, source=st.FROM_FEED)
    store.write_eod("nifty50", DAY, st.eod_rows(c), source=st.FROM_OFFICIAL)
    assert all(r["meta"]["src"] == st.FROM_OFFICIAL
               for r in store.read_eod("nifty50"))


def test_eod_builds_a_multi_day_series_for_one_strike(store):
    """The whole point of this tier: positioning across days."""
    c = _loaded()
    for i, day in enumerate(("2026-10-01", "2026-10-02", "2026-10-03")):
        rows = st.eod_rows(c)
        for r in rows:
            r["oi_close"] = 1000 + i * 500
        store.write_eod("nifty50", day, rows)
    series = store.read_eod("nifty50", security_id=1000)
    assert [r["oi_close"] for r in series] == [1000, 1500, 2000]


def test_eod_can_be_read_from_a_date(store):
    c = _loaded()
    for day in ("2026-09-28", "2026-10-01", "2026-10-02"):
        store.write_eod("nifty50", day, st.eod_rows(c))
    assert len({r["meta"]["d"]
                for r in store.read_eod("nifty50", since="2026-10-01")}) == 2


# -- the daily record ----------------------------------------------------

def _daily() -> dict:
    return {
        "instrument": "nifty50", "trade_date": DAY,
        "expiries": [{"exp": EXPIRY, "pcr_oi": 1.34, "max_pain": 23400.0}],
        "futures": [{"sid": 900, "oi_open": 100, "oi_close": 120}],
        "underlying": {"o": 23400.0, "h": 23600.0, "l": 23350.0, "c": 23500.0},
        "quality": {"complete": True, "ticks": 1_119_550, "gaps": 0},
    }


def test_daily_record_round_trips(store):
    store.write_daily(_daily())
    got = store.read_daily("nifty50", DAY)
    assert got["expiries"][0]["pcr_oi"] == 1.34
    assert got["quality"]["complete"] is True


def test_rerunning_the_end_of_day_job_replaces_rather_than_duplicates(store):
    """Two disagreeing records for one day would be worse than none."""
    store.write_daily(_daily())
    d = _daily()
    d["quality"]["complete"] = False
    store.write_daily(d)
    assert len(store.read_daily_range("nifty50", "2026-01-01")) == 1
    assert store.read_daily("nifty50", DAY)["quality"]["complete"] is False


def test_daily_records_read_back_as_a_series(store):
    for day in ("2026-09-29", "2026-09-30", "2026-10-01"):
        d = _daily()
        d["trade_date"] = day
        store.write_daily(d)
    got = store.read_daily_range("nifty50", "2026-09-30")
    assert [g["trade_date"] for g in got] == ["2026-09-30", "2026-10-01"]


def test_a_missing_day_reads_as_none(store):
    assert store.read_daily("nifty50", "1999-01-01") is None


# -- housekeeping --------------------------------------------------------

def test_sizes_reports_every_collection(store):
    store.write_intraday("nifty50", _changes(10), DAY)
    sizes = store.sizes()
    for name in (st.CURRENT, st.INTRADAY, st.EOD, st.DAILY):
        assert name in sizes
        assert "storage_mb" in sizes[name]


def test_ensure_collections_is_safe_to_call_twice(store):
    store.ensure_collections()
    store.ensure_collections()


def test_the_history_tiers_really_are_time_series(store):
    """D24 chose time-series on measurement - so it must actually be one."""
    names = {c["name"]: c for c in store.db.list_collections()}
    for name in (st.INTRADAY, st.EOD):
        assert names[name].get("type") == "timeseries", name
        opts = names[name]["options"]["timeseries"]
        assert opts["timeField"] == "t"
        assert opts["metaField"] == "meta"


def test_stats_count_what_was_written(store):
    c = _loaded()
    store.upsert_current("nifty50", st.current_rows(c))
    store.write_intraday("nifty50", _changes(3), DAY)
    store.write_eod("nifty50", DAY, st.eod_rows(c))
    assert store.stats.current_upserts == 6
    assert store.stats.intraday_rows == 3
    assert store.stats.eod_rows == 6
    assert not store.stats.errors


# -- sentinels must never reach the database ----------------------------

def test_oi_open_sentinel_is_stored_as_absent_not_minus_one(store):
    """Found in a real end-of-day row on 2026-09-25: `oi_open -1`.

    -1 means "this leg has not reported OI yet". Stored as -1 it reads as a
    measured open interest of minus one, and every later "change since open"
    would be computed against nonsense.
    """
    c = _chain()
    # A leg that ticked but whose OI never arrived: priced, no open interest.
    c.on_tick(Tick(security_id=1000, segment=2, kind=ResponseCode.QUOTE,
                   recv_ts=time.time(), ltp=95.0, volume=100))
    rows = st.current_rows(c)
    assert rows[0]["oi_open"] is None

    eod = st.eod_rows(c)
    assert eod[0]["oi_open"] is None

    store.upsert_current("nifty50", rows)
    assert store.load_current("nifty50")[0]["oi_open"] is None


def test_a_real_oi_open_is_kept(store):
    c = _chain()
    c.on_tick(_tick(1000, oi=4200))
    assert st.current_rows(c)[0]["oi_open"] == 4200
    assert st.eod_rows(c)[0]["oi_open"] == 4200
