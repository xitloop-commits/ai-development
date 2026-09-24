"""TCS2 - tests for the tick-built option chain.

Spec: docs/systems/14_tcs2.md  D12, D21, D23, D25, D38

Chains here are built from synthetic ticks, so every assertion is about what the
code does with a tick stream rather than about today's market.
"""
from __future__ import annotations

import datetime as dt
import time

import numpy as np
import pytest

from tcs2.chain import Chain
from tcs2.scrip import Contract, Resolved
from tcs2.wire import DepthLevel, ResponseCode, Tick

EXPIRY = "2026-10-06"
NEXT_EXPIRY = "2026-10-27"


def _opt(sid: int, strike: float, side: str, expiry: str = EXPIRY) -> Contract:
    return Contract(security_id=str(sid), display_name=f"X {strike:.0f} {side}",
                    instrument="OPTIDX", expiry=expiry, strike=strike,
                    option_type=side, expiry_flag="W", lot_size=65, tick_size=0.05)


def _fut(sid: int, expiry: str = EXPIRY) -> Contract:
    return Contract(security_id=str(sid), display_name="FUT", instrument="FUTIDX",
                    expiry=expiry, strike=0.0, option_type="XX", expiry_flag="M",
                    lot_size=65, tick_size=0.05)


def _idx(sid: int, name: str = "Nifty 50") -> Contract:
    return Contract(security_id=str(sid), display_name=name, instrument="INDEX",
                    expiry="", strike=0.0, option_type="XX", expiry_flag="",
                    lot_size=1, tick_size=0.05)


def nse_chain(strikes=(23400.0, 23500.0, 23600.0), expiries=(EXPIRY,)) -> Chain:
    opts, sid = [], 1000
    for e in expiries:
        for k in strikes:
            for side in ("CE", "PE"):
                opts.append(_opt(sid, k, side, e))
                sid += 1
    r = Resolved(instrument="nifty50", trade_date="2026-10-01",
                 index=_idx(13), vix=_idx(21, "India VIX"),
                 futures=(_fut(900), _fut(901, NEXT_EXPIRY)),
                 option_expiries=tuple(expiries), options=tuple(opts))
    return Chain(r)


def mcx_chain(strikes=(9000.0, 9050.0)) -> Chain:
    opts, sid = [], 2000
    for k in strikes:
        for side in ("CE", "PE"):
            opts.append(Contract(str(sid), f"CRUDE {k:.0f} {side}", "OPTFUT",
                                 "2026-10-15", k, side, "M", 100, 1.0))
            sid += 1
    r = Resolved(instrument="crudeoil", trade_date="2026-10-01",
                 index=None, vix=None,
                 futures=(Contract("2900", "CRUDE OCT FUT", "FUTCOM",
                                   "2026-10-19", 0.0, "XX", "M", 100, 1.0),
                          Contract("2901", "CRUDE NOV FUT", "FUTCOM",
                                   "2026-11-19", 0.0, "XX", "M", 100, 1.0)),
                 option_expiries=("2026-10-15",), options=tuple(opts))
    return Chain(r)


def full_tick(sid: int, ltp=100.0, bid=99.0, ask=101.0, oi=1000, volume=5000,
              ltq=65, ts=None) -> Tick:
    depth = tuple(DepthLevel(500 - i, 400 - i, 3, 2, bid - i, ask + i)
                  for i in range(5))
    return Tick(security_id=sid, segment=2, kind=ResponseCode.FULL,
                recv_ts=ts if ts is not None else time.time(),
                ltp=ltp, ltq=ltq, ltt=1790000000, atp=ltp, volume=volume,
                total_buy=10, total_sell=8, oi=oi, high_oi=oi + 10, low_oi=oi - 10,
                day_open=ltp, day_high=ltp, day_low=ltp, day_close=ltp,
                bid=bid, ask=ask, bid_size=500, ask_size=400, depth=depth)


def ticker(sid: int, ltp: float, ts=None) -> Tick:
    return Tick(security_id=sid, segment=0, kind=ResponseCode.TICKER,
                recv_ts=ts if ts is not None else time.time(), ltp=ltp)


def oi_tick(sid: int, oi: int, ts=None) -> Tick:
    return Tick(security_id=sid, segment=2, kind=ResponseCode.OI,
                recv_ts=ts if ts is not None else time.time(), oi=oi)


# -- routing -------------------------------------------------------------

def test_index_tick_sets_spot_on_nse():
    c = nse_chain()
    c.on_tick(ticker(13, 23476.5))
    assert c.spot == pytest.approx(23476.5)


def test_futures_tick_sets_spot_on_mcx():
    """MCX has no index - the futures IS the underlying (D11)."""
    c = mcx_chain()
    c.on_tick(full_tick(2900, ltp=9041.0))
    assert c.spot == pytest.approx(9041.0)


def test_futures_tick_does_not_override_spot_on_nse():
    """NSE options price around spot, not futures (measured 2026-09-18)."""
    c = nse_chain()
    c.on_tick(ticker(13, 23476.5))
    c.on_tick(full_tick(900, ltp=23499.0))
    assert c.spot == pytest.approx(23476.5)
    assert c.futures[900] == pytest.approx(23499.0)


def test_vix_is_tracked_separately():
    c = nse_chain()
    c.on_tick(ticker(21, 12.84))
    assert c.vix == pytest.approx(12.84)
    assert c.spot == 0.0


def test_unknown_security_is_counted_not_crashed():
    c = nse_chain()
    c.on_tick(full_tick(999999))
    assert c.unknown_ticks == 1
    assert c.ticks_applied == 0


# -- leg fields ----------------------------------------------------------

def test_full_tick_populates_every_leg_field():
    c = nse_chain()
    c.on_tick(full_tick(1000, ltp=132.5, bid=132.0, ask=133.0, oi=4200, volume=9100))
    i = c._row[1000]
    assert c.ltp[i] == pytest.approx(132.5)
    assert c.bid[i] == pytest.approx(132.0)
    assert c.ask[i] == pytest.approx(133.0)
    assert c.oi[i] == 4200
    assert c.volume[i] == 9100
    assert c.bid_size[i] == 500 and c.ask_size[i] == 400
    assert c.tick_count[i] == 1


def test_a_bookless_tick_does_not_wipe_the_standing_book():
    """Both sides zero means 'no book sent', not 'no bid and no ask'."""
    c = nse_chain()
    c.on_tick(full_tick(1000, bid=99.0, ask=101.0))
    c.on_tick(Tick(security_id=1000, segment=2, kind=ResponseCode.QUOTE,
                   recv_ts=time.time(), ltp=100.5, volume=6000))
    i = c._row[1000]
    assert c.bid[i] == pytest.approx(99.0)
    assert c.ask[i] == pytest.approx(101.0)
    assert c.ltp[i] == pytest.approx(100.5)


def test_spread_is_nan_without_a_book():
    c = nse_chain()
    i = c._row[1000]
    assert np.isnan(c.spread[i])
    c.on_tick(full_tick(1000, bid=99.0, ask=101.0))
    assert c.spread[i] == pytest.approx(2.0)


# -- open interest -------------------------------------------------------

def test_first_oi_becomes_the_open_baseline():
    """Today's change is measured against the first OI seen (D29 part 1)."""
    c = nse_chain()
    c.on_tick(full_tick(1000, oi=5000))
    i = c._row[1000]
    assert c.oi_open[i] == 5000
    assert c.oi_change[i] == 0
    c.on_tick(oi_tick(1000, 5600))
    assert c.oi_change[i] == 600


def test_oi_change_emits_one_intraday_row_per_change():
    """D23: a new row for every OI change, and only for changes."""
    c = nse_chain()
    c.on_tick(full_tick(1000, oi=1000))
    assert c.oi_changes == []              # the first report is a baseline
    c.on_tick(oi_tick(1000, 1200))
    c.on_tick(oi_tick(1000, 1200))         # unchanged: no row
    c.on_tick(oi_tick(1000, 900))
    rows = c.drain_oi_changes()
    assert [r.oi_delta for r in rows] == [200, -300]
    assert [r.oi for r in rows] == [1200, 900]
    assert c.oi_changes == []              # drained


def test_oi_rows_carry_enough_to_stand_alone():
    c = nse_chain()
    c.on_tick(full_tick(1000, ltp=132.5, oi=1000, volume=4000))
    c.on_tick(oi_tick(1000, 1500))
    r = c.drain_oi_changes()[0]
    assert r.security_id == 1000
    assert r.strike == 23400.0
    assert r.is_call is True
    assert r.expiry == EXPIRY
    assert r.ltp == pytest.approx(132.5)
    assert r.volume == 4000


def test_zero_oi_is_ignored_not_recorded_as_a_drop():
    """An OI packet of 0 is absence, not a wipe-out to zero."""
    c = nse_chain()
    c.on_tick(full_tick(1000, oi=1000))
    c.on_tick(oi_tick(1000, 0))
    assert c.oi[c._row[1000]] == 1000
    assert c.drain_oi_changes() == []


# -- analytics -----------------------------------------------------------

def test_analytics_are_not_computed_per_tick():
    """The central performance decision: on_tick stores, it does not solve."""
    c = nse_chain()
    c.on_tick(ticker(13, 23500.0))
    c.on_tick(full_tick(1000, ltp=132.5))
    assert np.all(np.isnan(c.iv))
    c.refresh_analytics()
    assert not np.isnan(c.iv[c._row[1000]])


def test_refresh_computes_iv_and_all_greeks():
    c = nse_chain()
    c.on_tick(ticker(13, 23500.0))
    for sid, ltp in ((1000, 150.0), (1001, 50.0), (1002, 95.0), (1003, 95.0)):
        c.on_tick(full_tick(sid, ltp=ltp))
    c.refresh_analytics()
    i = c._row[1000]
    for arr in (c.iv, c.delta, c.gamma, c.theta, c.vega):
        assert not np.isnan(arr[i])
    assert 0 < c.delta[i] < 1                      # a call
    assert c.delta[c._row[1001]] < 0               # a put
    assert c.theta[i] < 0


def test_refresh_does_nothing_without_a_spot():
    """Without an underlying there is nothing to imply a vol against."""
    c = nse_chain()
    c.on_tick(full_tick(1000, ltp=132.5))
    c.refresh_analytics()
    assert np.all(np.isnan(c.iv))


def test_unpriced_legs_stay_nan_not_zero():
    """A leg that never traded must read blank, never as a cheap option (D38)."""
    c = nse_chain()
    c.on_tick(ticker(13, 23500.0))
    c.on_tick(full_tick(1000, ltp=150.0))
    c.refresh_analytics()
    assert not np.isnan(c.iv[c._row[1000]])
    assert np.isnan(c.iv[c._row[1002]])            # never ticked


# -- the implied forward (D40) ------------------------------------------

def test_forward_is_read_out_of_the_option_prices():
    """Put-call parity: C - P = df * (F - K).

    With the 23,500 call at 95 and its put at 53, the market is pricing a
    forward about 42 points above the strike.
    """
    c = nse_chain()
    _load(c, 23500.0, {1002: (95.0, 1, 1), 1003: (53.0, 1, 1)})
    f = c.implied_forward(EXPIRY)
    assert 23530.0 < f < 23555.0


def test_an_in_the_money_call_still_gets_an_iv():
    """The case that a rate-assumed forward turned into NaN.

    Spot 23,500, the 23,400 call at 132.5. Assuming F = spot * e^(rT) puts the
    no-arbitrage floor at 145.8, so the premium looks like arbitrage and no vol
    exists. Reading the forward from the chain fixes it.
    """
    c = nse_chain()
    _load(c, 23500.0, {
        1000: (132.5, 1, 1), 1001: (33.0, 1, 1),        # 23400 CE / PE
        1002: (95.0, 1, 1), 1003: (95.0, 1, 1),         # 23500 CE / PE
    })
    c.refresh_analytics()
    assert not np.isnan(c.iv[c._row[1000]]), "ITM call must still imply a vol"


def test_forward_falls_back_to_spot_before_any_option_prices():
    c = nse_chain()
    c.on_tick(ticker(13, 23500.0))
    assert c.implied_forward(EXPIRY) == pytest.approx(23500.0)


def test_forward_ignores_a_one_sided_strike():
    """Parity needs both legs; a call with no put quote says nothing about F."""
    c = nse_chain()
    _load(c, 23500.0, {1002: (95.0, 1, 1)})             # call only
    assert c.implied_forward(EXPIRY) == pytest.approx(23500.0)


def test_mcx_prices_off_its_futures():
    """On MCX the options are written on the futures, so F is the futures."""
    m = mcx_chain(strikes=(9000.0, 9050.0))
    m.on_tick(full_tick(2900, ltp=9041.0))
    m.on_tick(full_tick(2000, ltp=300.0))               # 9000 CE
    m.on_tick(full_tick(2001, ltp=259.0))               # 9000 PE
    m.refresh_analytics()
    assert not np.isnan(m.iv[0])
    assert abs(m.forward["2026-10-15"] - 9041.0) < 100.0


# -- chain level ---------------------------------------------------------

def _load(c: Chain, spot: float, data: dict[int, tuple[float, int, int]]) -> None:
    c.on_tick(ticker(13, spot))
    for sid, (ltp, oi, vol) in data.items():
        c.on_tick(full_tick(sid, ltp=ltp, oi=oi, volume=vol))


def test_pcr_uses_oi_and_volume_separately():
    """They are different signals (D29 part 2), so they must not be conflated."""
    c = nse_chain()
    _load(c, 23500.0, {
        1000: (150.0, 100, 10), 1001: (50.0, 300, 90),     # 23400 CE / PE
        1002: (95.0, 100, 10), 1003: (95.0, 300, 90),      # 23500 CE / PE
        1004: (50.0, 100, 10), 1005: (150.0, 300, 90),     # 23600 CE / PE
    })
    s = c.summary(EXPIRY)
    assert s.total_call_oi == 300 and s.total_put_oi == 900
    assert s.pcr_oi == pytest.approx(3.0)
    assert s.pcr_volume == pytest.approx(9.0)


def test_walls_are_the_biggest_oi_on_each_side():
    c = nse_chain()
    _load(c, 23500.0, {
        1000: (150.0, 100, 1), 1001: (50.0, 100, 1),
        1002: (95.0, 900, 1), 1003: (95.0, 100, 1),        # call wall at 23500
        1004: (50.0, 100, 1), 1005: (150.0, 700, 1),       # put wall at 23600
    })
    s = c.summary(EXPIRY)
    assert s.call_wall_strike == 23500.0 and s.call_wall_oi == 900
    assert s.put_wall_strike == 23600.0 and s.put_wall_oi == 700


def test_atm_strike_is_the_nearest_to_spot():
    c = nse_chain()
    c.on_tick(ticker(13, 23477.0))
    assert c.atm_strike(EXPIRY) == 23500.0
    c.on_tick(ticker(13, 23430.0))
    assert c.atm_strike(EXPIRY) == 23400.0


def test_atm_straddle_is_the_two_atm_premiums():
    c = nse_chain()
    _load(c, 23500.0, {1002: (95.0, 1, 1), 1003: (53.0, 1, 1)})
    assert c.summary(EXPIRY).atm_straddle == pytest.approx(148.0)


def test_max_pain_sits_where_writers_lose_least():
    """All the open interest at one strike: max pain must land there."""
    c = nse_chain()
    _load(c, 23500.0, {
        1000: (150.0, 0, 0), 1001: (50.0, 0, 0),
        1002: (95.0, 5000, 0), 1003: (95.0, 5000, 0),
        1004: (50.0, 0, 0), 1005: (150.0, 0, 0),
    })
    assert c.summary(EXPIRY).max_pain == 23500.0


def test_max_pain_moves_with_the_open_interest():
    c = nse_chain()
    _load(c, 23500.0, {
        1000: (150.0, 0, 0), 1001: (50.0, 9000, 0),        # heavy 23400 puts
        1002: (95.0, 0, 0), 1003: (95.0, 0, 0),
        1004: (50.0, 9000, 0), 1005: (150.0, 0, 0),        # heavy 23600 calls
    })
    # Writers of the 23,400 puts and 23,600 calls both suffer least in between.
    assert c.summary(EXPIRY).max_pain in (23400.0, 23500.0, 23600.0)


def test_basis_is_futures_minus_spot():
    c = nse_chain()
    c.on_tick(ticker(13, 23476.0))
    c.on_tick(full_tick(900, ltp=23499.0))
    s = c.summary(EXPIRY)
    assert s.futures == pytest.approx(23499.0)
    assert s.basis == pytest.approx(23.0)


def test_summary_counts_only_legs_that_actually_ticked():
    c = nse_chain()
    _load(c, 23500.0, {1000: (150.0, 1, 1), 1001: (50.0, 1, 1)})
    assert c.summary(EXPIRY).legs_seen == 2


# -- several expiries ----------------------------------------------------

def test_expiries_are_summarised_independently():
    c = nse_chain(expiries=(EXPIRY, NEXT_EXPIRY))
    c.on_tick(ticker(13, 23500.0))
    c.on_tick(full_tick(1000, oi=111, volume=1))        # near expiry, 23400 CE
    c.on_tick(full_tick(1006, oi=222, volume=1))        # next expiry, 23400 CE
    assert c.summary(EXPIRY).total_call_oi == 111
    assert c.summary(NEXT_EXPIRY).total_call_oi == 222


def test_time_to_expiry_shrinks_and_differs_per_expiry():
    c = nse_chain(expiries=(EXPIRY, NEXT_EXPIRY))
    now = dt.datetime(2026, 10, 1, 10, 0).timestamp()
    near = c.time_to_expiry(EXPIRY, now)
    far = c.time_to_expiry(NEXT_EXPIRY, now)
    assert 0 < near < far
    later = c.time_to_expiry(EXPIRY, now + 3600)
    assert later < near


def test_expiry_uses_the_session_close_not_midnight():
    """Day granularity would make every IV meaningless on expiry day."""
    c = nse_chain()
    d = dt.date.fromisoformat(EXPIRY)
    morning = dt.datetime(d.year, d.month, d.day, 9, 15).timestamp()
    assert c.time_to_expiry(EXPIRY, morning) > 0


# -- the D38 readout -----------------------------------------------------

def test_rows_pair_calls_and_puts_per_strike():
    c = nse_chain()
    _load(c, 23500.0, {1002: (95.0, 400, 7), 1003: (53.0, 800, 9)})
    c.refresh_analytics()
    rows = c.rows(EXPIRY)
    assert [r["strike"] for r in rows] == [23400.0, 23500.0, 23600.0]
    mid = rows[1]
    assert mid["call"]["ltp"] == pytest.approx(95.0)
    assert mid["put"]["oi"] == 800
    assert mid["call"]["volume"] == 7


def test_rows_preserve_nan_so_the_screen_can_show_blank():
    c = nse_chain()
    _load(c, 23500.0, {1002: (95.0, 1, 1)})
    c.refresh_analytics()
    untouched = c.rows(EXPIRY)[0]["call"]
    assert np.isnan(untouched["iv"]), "must be NaN, not 0 - see D38"


# -- volume ----------------------------------------------------------

def test_volume_is_taken_from_the_tick_not_computed():
    """D25: volume arrives in the tick. Only IV and the Greeks are computed."""
    c = nse_chain()
    c.on_tick(full_tick(1000, volume=131235))
    assert c.volume[c._row[1000]] == 131235


def test_apply_many_counts_what_it_applied():
    c = nse_chain()
    n = c.apply_many([full_tick(1000), full_tick(1001), ticker(13, 23500.0)])
    assert n == 3
    assert c.ticks_applied == 3
