"""Unit tests for the sma-model pipeline (T154).

Run: py -m pytest python_modules/sma_model/tests -q
"""
from __future__ import annotations

import numpy as np
import pytest

from python_modules.sma_model.config import (
    LOT_SIZE,
    round_trip_charges,
)
from python_modules.sma_model.events import (
    PULLBACK_WINDOW,
    _ride_exit_candle,
    _trade_net,
    extract_events,
    find_pullback_entries,
    pullback_hit,
)
from python_modules.sma_model.features import (
    ENTRY_EXTRA_NAMES,
    EXIT_EXTRA_NAMES,
    FEATURE_NAMES,
    entry_extra_features,
    entry_features,
    exit_features,
)
from python_modules.sma_model.pipeline import (
    N_CANDLES,
    DayData,
    _ffill_limited,
    _heikin_ashi,
    _sma,
)


# ── helpers ───────────────────────────────────────────────────────────────

def make_day(closes: np.ndarray) -> DayData:
    """Synthetic DayData whose futures closes follow `closes` (len ≤ 375)."""
    n = N_CANDLES
    nan = lambda: np.full(n, np.nan)
    day = DayData(
        date="2026-01-01",
        o=nan(), h=nan(), l=nan(), c=nan(),
        ha_o=nan(), ha_c=nan(), ha_h=nan(), ha_l=nan(),
        sma=nan(), candle_end_ts=nan(),
        atp=nan(), vol_cum=nan(), buy_cum=nan(), sell_cum=nan(),
        depth_imb=nan(), spread=nan(), tick_count=np.zeros(n),
        spot=nan(), atm_iv=nan(),
        oi_call=nan(), oi_put=nan(), doi_call=nan(), doi_put=nan(),
        vix=nan(),
    )
    m = len(closes)
    day.o[:m] = closes
    day.c[:m] = closes
    day.h[:m] = closes + 1.0
    day.l[:m] = closes - 1.0
    day.candle_end_ts[:m] = 1_786_000_000 + 60 * np.arange(m)
    day.spot[:m] = closes - 88.0          # futures basis
    day.atp[:m] = closes.mean()
    day.vol_cum[:m] = np.cumsum(np.full(m, 100.0))
    day.buy_cum[:m] = np.cumsum(np.full(m, 60.0))
    day.sell_cum[:m] = np.cumsum(np.full(m, 40.0))
    day.depth_imb[:m] = 0.1
    day.spread[:m] = 0.5
    day.vix[:m] = 12.0
    _heikin_ashi(day)
    _sma(day)
    return day


def add_flat_quotes(day: DayData, strikes, bid=100.0, ask=101.0):
    for k in strikes:
        for t in ("CE", "PE"):
            day.opt_bid[(k, t)] = np.full(N_CANDLES, bid)
            day.opt_ask[(k, t)] = np.full(N_CANDLES, ask)
            day.opt_ltp[(k, t)] = np.full(N_CANDLES, (bid + ask) / 2)


# ── charges ───────────────────────────────────────────────────────────────

def test_charges_match_production_formula():
    # 1 lot @ ₹100 in, ₹110 out → values 6500 / 7150.
    buy_v, sell_v = 100.0 * LOT_SIZE, 110.0 * LOT_SIZE
    total = round_trip_charges(buy_v, sell_v)
    brokerage = 40.0
    exch = round((buy_v + sell_v) * 0.03553 / 100, 2)      # 4.85
    stt = round(sell_v * 0.15 / 100)                        # 11
    gst = round((brokerage + exch) * 0.18, 2)               # 8.07
    sebi = round((buy_v + sell_v) * 0.0001 / 100, 2)        # 0.01
    stamp = round(buy_v * 0.003 / 100)                      # 0
    assert total == pytest.approx(brokerage + exch + stt + gst + sebi + stamp)
    # order of magnitude sanity: ~₹64 for this round trip
    assert 55 < total < 75


def test_charges_stt_stamp_rounded_to_rupee():
    # tiny premium: STT on ₹650 sell = ₹0.975 → rounds to ₹1; stamp → 0
    t_small = round_trip_charges(10.0 * LOT_SIZE, 10.0 * LOT_SIZE)
    assert t_small == pytest.approx(40 + 0.46 + 1 + 7.28 + 0.0, abs=0.2)


# ── Heikin-Ashi + SMA ────────────────────────────────────────────────────

def test_heikin_ashi_and_sma_math():
    closes = np.linspace(100.0, 120.0, 30)
    day = make_day(closes)
    # HA close = (o+h+l+c)/4 with h=c+1, l=c−1, o=c → equals c
    assert day.ha_c[10] == pytest.approx(closes[10])
    # HA open = midpoint of previous HA candle
    assert day.ha_o[10] == pytest.approx((day.ha_o[9] + day.ha_c[9]) / 2)
    # SMA5 of a linear ramp = close 2 candles back
    assert day.sma[10] == pytest.approx(day.ha_c[8], abs=1e-6)
    assert np.isnan(day.sma[3])  # needs 5 candles


def test_side_up_down():
    closes = np.concatenate([np.linspace(100, 120, 20),   # rising
                             np.linspace(120, 100, 20)])  # falling
    day = make_day(closes)
    side = day.side()
    assert side[15] == 1     # uptrend: close above SMA
    assert side[35] == -1    # downtrend: close below SMA


# ── ride / events ────────────────────────────────────────────────────────

def test_ride_exit_at_first_wrong_side_close():
    side = np.zeros(N_CANDLES, dtype=np.int8)
    side[10:20] = 1
    side[20:25] = -1
    assert _ride_exit_candle(side, 10, 1) == 20
    # never flips → rides to last candle
    side2 = np.zeros(N_CANDLES, dtype=np.int8)
    side2[10:] = 1
    assert _ride_exit_candle(side2, 10, 1) == N_CANDLES - 1


def test_trade_net_uses_ask_in_bid_out_and_charges():
    closes = np.linspace(100.0, 120.0, 40)
    day = make_day(closes)
    add_flat_quotes(day, [round((closes[20] - 88) / 50) * 50], bid=100.0, ask=101.0)
    strike = round((closes[20] - 88) / 50) * 50
    res = _trade_net(day, strike, "CE", 20, 25)
    assert res is not None
    net, gross, ask, bid = res
    assert ask == 101.0 and bid == 100.0
    assert gross == pytest.approx((100.0 - 101.0) * LOT_SIZE)   # −65 spread cost
    assert net < gross                                          # charges on top


def _zigzag_day():
    """Down-leg → up-cross → pullback low pinned to the line → up-leg →
    down-leg. The pullback candle's raw low is set onto the SMA5 by hand so
    the geometry is under test control (SMA lag makes natural dips flip
    sides in tiny synthetic data)."""
    seg_down = 24720 - 1.5 * np.arange(30)          # establish side = −1
    up1 = seg_down[-1] + 4 * np.arange(1, 4)        # sharp rise → cross up
    up2 = up1[-1] + 4 * np.arange(1, 21)            # leg continues
    seg_down2 = up2[-1] - 6 * np.arange(1, 16)      # reversal → exit cross
    day = make_day(np.concatenate([seg_down, up1, up2, seg_down2]))
    side = day.side()
    # find the up-cross, then pin the low of cross+1 onto the line
    x = next(i for i in range(1, 120)
             if side[i] == 1 and side[i - 1] == -1)
    day.l[x + 1] = day.sma[x + 1] - 0.2
    return day, x


def test_pullback_entry_found_and_valid():
    day, x = _zigzag_day()
    side = day.side()
    found = list(find_pullback_entries(side, day))
    assert (x, x + 1, 1) in found
    for xc, p, d in found:
        assert side[xc] == d and side[xc - 1] == -d    # real cross at xc
        assert 0 < p - xc <= PULLBACK_WINDOW           # inside the window
        assert side[p] == d                            # leg still intact
        assert pullback_hit(day, p, d)                 # touched the line


def test_whipsaw_produces_no_entry():
    # one-candle fake cross up, then a hard fall: no long entry allowed.
    seg_down = 24720 - 2 * np.arange(40)
    spike = np.array([seg_down[-1] + 8])               # fake cross
    seg_down2 = spike[-1] - 8 * np.arange(1, 25)       # snaps straight back
    day = make_day(np.concatenate([seg_down, spike, seg_down2]))
    side = day.side()
    ups = [e for e in find_pullback_entries(side, day) if e[2] == 1]
    assert ups == []


def test_extract_events_labels_in_rupees():
    day, x = _zigzag_day()
    closes = day.c[~np.isnan(day.c)]
    strikes = sorted({int(round((c - 88) / 50) * 50) for c in closes})
    add_flat_quotes(day, strikes)
    entries, exits = extract_events(day)
    assert len(entries) >= 1
    assert all(e.exit_candle > e.candle for e in entries)
    assert all(e.candle - e.cross_candle <= PULLBACK_WINDOW for e in entries)
    # flat premium (bid 100/ask 101) → every trade loses spread + charges
    assert all(e.net_inr < 0 for e in entries)
    # the up-leg entry rides a rising segment → positive favourable run
    up = [e for e in entries if e.direction == 1]
    assert up and all(e.favorable_pts > 0 for e in up)


# ── features ─────────────────────────────────────────────────────────────

def test_feature_vector_shape_and_direction_symmetry():
    closes = np.linspace(24700, 24760, 40)
    day = make_day(closes)
    strikes = sorted({int(round((c - 88) / 50) * 50) for c in closes})
    add_flat_quotes(day, strikes)
    up = entry_features(day, 30, +1)
    dn = entry_features(day, 30, -1)
    assert len(up) == len(FEATURE_NAMES)
    names = dict(zip(FEATURE_NAMES, range(len(FEATURE_NAMES))))
    # directional features flip sign between CALL and PUT view
    for f in ("dist_close_sma", "sma_slope3", "vel_?", "vwap_dist"):
        if f in names:
            assert up[names[f]] == pytest.approx(-dn[names[f]])
    # non-directional features identical
    for f in ("ha_range", "tick_count", "vix", "minute_of_day"):
        assert up[names[f]] == pytest.approx(dn[names[f]])


def test_entry_extra_features():
    closes = np.linspace(24700, 24760, 40)
    day = make_day(closes)
    extras = entry_extra_features(day, 30, +1, 27)
    assert len(extras) == len(ENTRY_EXTRA_NAMES)
    assert extras[0] == 3.0                      # candles since cross
    # up-leg depth = sma − low; low = close−1, sma ≈ close−3 → ≈ −2 (no touch)
    assert extras[1] == pytest.approx(day.sma[30] - day.l[30])


def test_exit_features_extend_entry_features():
    closes = np.linspace(24700, 24760, 40)
    day = make_day(closes)
    strikes = sorted({int(round((c - 88) / 50) * 50) for c in closes})
    add_flat_quotes(day, strikes)
    feats = exit_features(day, 30, +1, 20, strikes[0])
    assert len(feats) == len(FEATURE_NAMES) + len(EXIT_EXTRA_NAMES)
    # candles_held is the 3rd extra
    assert feats[len(FEATURE_NAMES) + 2] == 10.0


# ── ffill helper ─────────────────────────────────────────────────────────

def test_ffill_limited_respects_gap():
    a = np.array([1.0, np.nan, np.nan, np.nan, 5.0])
    _ffill_limited(a, 2)
    assert a[1] == 1.0 and a[2] == 1.0
    assert np.isnan(a[3])  # beyond max_gap
    assert a[4] == 5.0
