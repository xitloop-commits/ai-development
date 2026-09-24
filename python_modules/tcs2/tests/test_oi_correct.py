"""TCS2 - tests for the post-session OI correction.

Spec: docs/systems/14_tcs2.md  D32, D34

The measurement that made this job necessary, from Dhan's own daily candles:

    CRUDEOIL 15 OCT 9500 CE   feed 6,678      official 5,643    -15.5%
    NIFTY 29 SEP 23500 CE     feed 10,461,425 official 10,282,090

Dhan is never called here. A fake history stands in, so the tests are about what
the job does with an answer rather than about today's market.
"""
from __future__ import annotations

import uuid

import pytest

from tcs2 import store as st
from tcs2.history import Candle, HistoryError, estimate_runtime
from tcs2.oi_correct import correct_day

pymongo = pytest.importorskip("pymongo")

DAY = "2026-09-24"
EXPIRY = "2026-10-15"


@pytest.fixture
def store():
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


class FakeHistory:
    """Stands in for Dhan. `answers` maps security id -> official OI or None."""

    min_interval_sec = 0.0

    def __init__(self, answers: dict[str, int | None],
                 raise_for: set[str] | None = None) -> None:
        self.answers = answers
        self.raise_for = raise_for or set()
        self.asked: list[str] = []

        class _Stats:
            calls = 0
            rate_limited = 0
            seconds_waiting = 0.0
        self.stats = _Stats()

    def official_oi(self, sid, segment, instrument, trade_date):
        self.asked.append(str(sid))
        self.stats.calls += 1
        if str(sid) in self.raise_for:
            raise HistoryError("HTTP 500")
        return self.answers.get(str(sid))


def seed(store, rows: list[tuple[int, int]], day: str = DAY) -> None:
    """rows are (security_id, closing OI as the feed saw it)."""
    store.write_eod("crudeoil", day, [
        {"sid": sid, "strike": 9000.0 + i * 50, "side": "CE", "exp": EXPIRY,
         "oi_open": max(0, oi - 100), "oi_close": oi, "oi_high": oi + 10,
         "oi_low": oi - 10, "oi_chg": 100, "o": 1.0, "h": 2.0, "l": 0.5,
         "c": 1.5, "vol": 500, "iv": 0.3, "delta": 0.5, "gamma": 0.001,
         "ticks": 100}
        for i, (sid, oi) in enumerate(rows)], source=st.FROM_FEED)


# -- the correction ------------------------------------------------------

def test_the_measured_crude_case(store):
    """The real numbers: 6,678 in the feed against an official 5,643."""
    seed(store, [(581885, 6678)])
    hist = FakeHistory({"581885": 5643})
    rep = correct_day("crudeoil", DAY, store, hist)

    assert rep.corrected == 1
    assert rep.largest_change_pct == pytest.approx(-15.5, abs=0.1)

    official = [r for r in store.read_eod("crudeoil")
                if r["meta"]["src"] == st.FROM_OFFICIAL]
    assert len(official) == 1
    assert official[0]["oi_close"] == 5643
    assert official[0]["oi_feed_close"] == 6678
    assert official[0]["oi_revision"] == -1035


def test_the_feed_rows_are_kept_alongside_the_official_ones(store):
    """The difference between them measures how much the exchange revised.

    Overwriting the feed version would make that unrecoverable.
    """
    seed(store, [(1, 1000)])
    correct_day("crudeoil", DAY, store, FakeHistory({"1": 900}))
    rows = store.read_eod("crudeoil")
    assert {r["meta"]["src"] for r in rows} == {st.FROM_FEED, st.FROM_OFFICIAL}
    feed_row = next(r for r in rows if r["meta"]["src"] == st.FROM_FEED)
    assert feed_row["oi_close"] == 1000


def test_an_unchanged_leg_is_counted_separately(store):
    seed(store, [(1, 1000), (2, 2000)])
    rep = correct_day("crudeoil", DAY, store,
                      FakeHistory({"1": 1000, "2": 1900}))
    assert rep.unchanged == 1
    assert rep.corrected == 1


def test_the_largest_revision_is_reported(store):
    seed(store, [(1, 1000), (2, 1000), (3, 1000)])
    rep = correct_day("crudeoil", DAY, store,
                      FakeHistory({"1": 990, "2": 500, "3": 995}))
    assert rep.largest_change_pct == pytest.approx(-50.0, abs=0.1)
    assert "9,050" in rep.largest_change_leg


# -- refusing to guess ---------------------------------------------------

def test_a_missing_answer_leaves_the_row_alone(store):
    """Dhan returns nothing for old expiries.

    Measured: a 2026-06-16 contract returned zero candles. That must never be
    read as an OI of zero - so the row stays tagged `feed` rather than being
    written wrong.
    """
    seed(store, [(1, 1000)])
    rep = correct_day("crudeoil", DAY, store, FakeHistory({"1": None}))
    assert rep.missing == 1
    assert rep.corrected == 0
    assert not [r for r in store.read_eod("crudeoil")
                if r["meta"]["src"] == st.FROM_OFFICIAL]


def test_a_failed_call_does_not_stop_the_rest(store):
    """One dead contract must not abandon the other 1,495."""
    seed(store, [(1, 1000), (2, 2000), (3, 3000)])
    rep = correct_day("crudeoil", DAY, store,
                      FakeHistory({"1": 900, "3": 2900}, raise_for={"2"}))
    assert rep.failed == 1
    assert rep.corrected == 2
    assert rep.errors


def test_legs_with_no_open_interest_are_not_fetched(store):
    """About 60% of a chain carries no OI - the difference between 88 and 35 min."""
    seed(store, [(1, 0), (2, 5000), (3, 0)])
    hist = FakeHistory({"2": 4900})
    rep = correct_day("crudeoil", DAY, store, hist)
    assert rep.skipped_no_oi == 2
    assert hist.asked == ["2"]


def test_a_day_with_no_feed_rows_says_so(store):
    rep = correct_day("crudeoil", "1999-01-01", store, FakeHistory({}))
    assert rep.errors
    assert "run the session first" in rep.errors[0]


# -- idempotency ---------------------------------------------------------

def test_re_running_replaces_rather_than_duplicating(store):
    """Time-series collections take no unique index (D24), so this is our job."""
    seed(store, [(1, 1000), (2, 2000)])
    correct_day("crudeoil", DAY, store, FakeHistory({"1": 900, "2": 1900}))
    correct_day("crudeoil", DAY, store, FakeHistory({"1": 900, "2": 1900}))
    official = [r for r in store.read_eod("crudeoil")
                if r["meta"]["src"] == st.FROM_OFFICIAL]
    assert len(official) == 2


def test_a_second_pass_can_change_its_mind(store):
    seed(store, [(1, 1000)])
    correct_day("crudeoil", DAY, store, FakeHistory({"1": 900}))
    correct_day("crudeoil", DAY, store, FakeHistory({"1": 950}))
    official = [r for r in store.read_eod("crudeoil")
                if r["meta"]["src"] == st.FROM_OFFICIAL]
    assert len(official) == 1
    assert official[0]["oi_close"] == 950


def test_dry_run_writes_nothing(store):
    seed(store, [(1, 1000)])
    rep = correct_day("crudeoil", DAY, store, FakeHistory({"1": 900}),
                      dry_run=True)
    assert rep.corrected == 1
    assert not [r for r in store.read_eod("crudeoil")
                if r["meta"]["src"] == st.FROM_OFFICIAL]


def test_only_the_requested_day_is_touched(store):
    seed(store, [(1, 1000)], day="2026-09-23")
    seed(store, [(1, 1000)], day=DAY)
    correct_day("crudeoil", DAY, store, FakeHistory({"1": 900}))
    other = [r for r in store.read_eod("crudeoil")
             if r["meta"]["d"] == "2026-09-23"]
    assert {r["meta"]["src"] for r in other} == {st.FROM_FEED}


def test_a_limit_stops_early(store):
    seed(store, [(1, 1000), (2, 2000), (3, 3000)])
    hist = FakeHistory({"1": 900, "2": 1900, "3": 2900})
    correct_day("crudeoil", DAY, store, hist, limit=2)
    assert hist.asked == ["1", "2"]


# -- the runtime estimate -----------------------------------------------

def test_the_runtime_estimate_matches_the_reasoning_in_d34():
    """4,060 legs at 1.3 s is about 88 minutes, and ~40% of that is ~35."""
    assert estimate_runtime(4060, 1.3) / 60 == pytest.approx(88.0, abs=1.0)
    assert estimate_runtime(1600, 1.3) / 60 == pytest.approx(34.7, abs=1.0)


def test_the_estimate_is_zero_for_nothing():
    assert estimate_runtime(0) == 0.0
