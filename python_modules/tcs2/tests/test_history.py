"""TCS2 - tests for the Dhan history client.

Spec: docs/systems/14_tcs2.md  D32, D33, D34

Dhan is never called here. The transport is replaced, so these tests are about
the request we build and what we do with an answer.
"""
from __future__ import annotations

import datetime as dt

import pytest

from tcs2.history import Candle, DhanHistory, HistoryError, estimate_runtime


class Recorder(DhanHistory):
    """A history client whose transport records requests instead of sending them."""

    def __init__(self, payloads=None) -> None:
        super().__init__("token", "client", min_interval_sec=0.0)
        self.requests: list[dict] = []
        self._payloads = payloads or []

    def _post(self, url, body):
        self.requests.append({"url": url, **body})
        self.stats.calls += 1
        if not self._payloads:
            return {}
        return self._payloads.pop(0)


def _payload(dates_and_oi: list[tuple[str, int]]) -> dict:
    ts = [int(dt.datetime.fromisoformat(d + "T15:30:00").timestamp())
          for d, _ in dates_and_oi]
    return {"timestamp": ts, "open_interest": [oi for _, oi in dates_and_oi],
            "open": [1.0] * len(ts), "high": [2.0] * len(ts),
            "low": [0.5] * len(ts), "close": [1.5] * len(ts),
            "volume": [100] * len(ts)}


# -- the date window (a real API constraint) ----------------------------

def test_official_oi_asks_for_a_RANGE_not_a_single_day():
    """Measured 2026-09-25: Dhan returns HTTP 400 for fromDate == toDate.

    It was rejected for today AND for a settled day in the past, while
    2026-09-18 -> 2026-09-25 returned four candles. So a single-day request is
    not a smaller version of a working call - it simply does not work.
    """
    h = Recorder([_payload([("2026-09-23", 780)])])
    h.official_oi("51528", "NSE_FNO", "OPTIDX", "2026-09-23")
    req = h.requests[0]
    assert req["fromDate"] != req["toDate"], "a same-day range is rejected by Dhan"
    assert req["fromDate"] < "2026-09-23" < req["toDate"]


def test_official_oi_picks_the_requested_day_out_of_the_window():
    h = Recorder([_payload([("2026-09-21", 500), ("2026-09-22", 600),
                            ("2026-09-23", 780)])])
    assert h.official_oi("1", "NSE_FNO", "OPTIDX", "2026-09-22") == 600


def test_a_day_not_in_the_window_returns_none_not_zero():
    """Two different situations produce this, and neither means OI is zero:

    the day is not published yet - measured 2026-09-25, the latest daily candle
    was 2026-09-23 - or the contract is an old expiry, which returns no candles
    at all.
    """
    h = Recorder([_payload([("2026-09-21", 500)])])
    assert h.official_oi("1", "NSE_FNO", "OPTIDX", "2026-09-23") is None


def test_an_empty_answer_returns_none_and_is_counted():
    h = Recorder([{}])
    assert h.official_oi("1", "NSE_FNO", "OPTIDX", "2026-09-23") is None
    assert h.stats.empty == 1


# -- knowing what Dhan has ----------------------------------------------

def test_latest_published_day_is_the_last_candle():
    """Checked before a pass, so an 88-minute run is not spent on a missing day."""
    h = Recorder([_payload([("2026-09-21", 1), ("2026-09-22", 2),
                            ("2026-09-23", 3)])])
    assert h.latest_published_day("1", "NSE_FNO", "OPTIDX") == "2026-09-23"


def test_latest_published_day_is_none_when_there_is_nothing():
    assert Recorder([{}]).latest_published_day("1", "NSE_FNO", "OPTIDX") is None


# -- candle decoding -----------------------------------------------------

def test_candles_carry_ohlc_volume_and_oi():
    h = Recorder([_payload([("2026-09-23", 780)])])
    c = h.daily("1", "NSE_FNO", "OPTIDX", "2026-09-18", "2026-09-24")[0]
    assert isinstance(c, Candle)
    assert c.date == "2026-09-23"
    assert c.oi == 780
    assert c.close == pytest.approx(1.5)
    assert c.volume == 100


def test_a_short_series_does_not_crash_the_decoder():
    """Dhan does not always return every array at the same length."""
    h = Recorder([{"timestamp": [int(dt.datetime(2026, 9, 23, 15, 30).timestamp())],
                   "open_interest": [], "close": []}])
    c = h.daily("1", "NSE_FNO", "OPTIDX", "2026-09-18", "2026-09-24")
    assert len(c) == 1 and c[0].oi == 0


def test_the_request_carries_oi_true():
    """Without it Dhan omits open interest, and the whole job is pointless."""
    h = Recorder([_payload([("2026-09-23", 1)])])
    h.daily("1", "NSE_FNO", "OPTIDX", "2026-09-18", "2026-09-24")
    assert h.requests[0]["oi"] is True


def test_intraday_passes_the_interval():
    h = Recorder([_payload([("2026-09-23", 1)])])
    h.intraday("1", "MCX_COMM", "OPTFUT", "2026-09-23", interval="1")
    assert h.requests[0]["interval"] == "1"


# -- the runtime estimate -----------------------------------------------

def test_the_estimate_explains_why_this_is_a_post_session_job():
    """4,060 legs at 1.3 s is ~88 min, which 08:54 cannot absorb (D34)."""
    assert estimate_runtime(4060, 1.3) / 60 == pytest.approx(88.0, abs=1.0)
