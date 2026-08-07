"""Candle-close feature vector (spec §5 — lean set, direction-adjusted).

Directional features are multiplied by the trade direction so the model
always sees "in my favour = positive" — CALL and PUT examples share one
model. CE/PE option-flow features are swapped accordingly ("my side" =
the option we'd buy, "other side" = its opposite).
"""
from __future__ import annotations

import numpy as np

from .config import STRIKE_STEP
from .pipeline import DayData

FEATURE_NAMES = [
    # line & candle anatomy (directional where marked ×d)
    "dist_close_sma",        # ×d — HA close − SMA5
    "sma_slope1",            # ×d
    "sma_slope3",            # ×d
    "ha_body",               # ×d — signed body
    "ha_range",
    "wick_with",             # ×d — wick in trade direction
    "wick_against",          # ×d
    "streak_len",
    # leg memory
    "prev_leg_candles",
    "prev_leg_range",
    "prev2_leg_candles",
    "flips_last30",
    # indicators
    "rsi14",                 # ×d around 50
    "vwap_dist",             # ×d
    "day_range_pos",         # ×d
    # futures microstructure (last candle)
    "velocity1",             # ×d — close−close 1m
    "velocity3",             # ×d
    "tick_count",
    "vol_delta",
    "buy_sell_imb",          # ×d — Δbuy−Δsell / Δbuy+Δsell
    "depth_imb",             # ×d
    "fut_spread",
    # option flow (my side / other side)
    "my_prem_ret1",          # my option premium 1m return
    "other_prem_ret1",
    "my_prem_ret3",
    "other_prem_ret3",
    "my_rel_spread",
    # chain
    "atm_iv",
    "iv_change5",
    "oi_tilt",               # ×d — (call−put)/(call+put) OI near ATM
    "doi_tilt",              # ×d
    # context
    "vix",
    "vix_change5",
    "basis",                 # fut − spot
    "basis_change5",
    "minute_of_day",
]

ENTRY_EXTRA_NAMES = [
    "candles_since_cross",    # pullback position inside the D14 window
    "pullback_depth",         # ×d how deep the dip reached vs the SMA5 line
]

EXIT_EXTRA_NAMES = [
    "prem_ret_since_entry",   # my option premium return since entry
    "und_move_since_entry",   # ×d underlying points since entry
    "candles_held",
    "adverse_now",            # ×d how far past the line the wrong-side close is
]


def _safe(x, default=0.0):
    return default if x is None or (isinstance(x, float) and np.isnan(x)) else x


def _prem_ret(day: DayData, strike: int, opt: str, i: int, lag: int):
    a = day.opt_ltp.get((strike, opt))
    if a is None or i - lag < 0:
        return 0.0
    now, then = a[i], a[i - lag]
    if np.isnan(now) or np.isnan(then) or then <= 0:
        return 0.0
    return float(now / then - 1.0)


def entry_features(day: DayData, i: int, direction: int) -> list[float]:
    d = float(direction)
    sma, ha_c = day.sma, day.ha_c
    side = day.side()

    dist = _safe(ha_c[i] - sma[i]) * d
    slope1 = _safe(sma[i] - sma[i - 1]) * d if i >= 1 else 0.0
    slope3 = _safe(sma[i] - sma[i - 3]) * d if i >= 3 else 0.0
    body = _safe(day.ha_c[i] - day.ha_o[i]) * d
    rng = _safe(day.ha_h[i] - day.ha_l[i])
    up_wick = _safe(day.ha_h[i] - max(day.ha_o[i], day.ha_c[i]))
    dn_wick = _safe(min(day.ha_o[i], day.ha_c[i]) - day.ha_l[i])
    wick_with = up_wick if d > 0 else dn_wick
    wick_against = dn_wick if d > 0 else up_wick

    # streaks & legs from side[] history
    streak = 0
    k = i
    while k >= 0 and side[k] == side[i] and side[i] != 0:
        streak += 1
        k -= 1
    legs = []  # (len_candles, range_pts) most-recent-first, excluding current
    k_end = k
    while k_end >= 0 and len(legs) < 2:
        s = side[k_end]
        if s == 0:
            break
        k_start = k_end
        while k_start >= 0 and side[k_start] == s:
            k_start -= 1
        seg = day.c[k_start + 1: k_end + 1]
        seg = seg[~np.isnan(seg)]
        legs.append((k_end - k_start, float(seg.max() - seg.min()) if seg.size else 0.0))
        k_end = k_start
    prev_leg = legs[0] if len(legs) > 0 else (0, 0.0)
    prev2_leg = legs[1] if len(legs) > 1 else (0, 0.0)
    lo30 = max(1, i - 29)
    flips30 = int(np.sum(side[lo30: i + 1] != side[lo30 - 1: i]))

    # RSI14 on futures closes
    rsi = 50.0
    if i >= 14:
        closes = day.c[i - 14: i + 1]
        if not np.isnan(closes).any():
            diff = np.diff(closes)
            up = diff[diff > 0].sum()
            dn = -diff[diff < 0].sum()
            rsi = 100.0 if dn == 0 else 100.0 - 100.0 / (1.0 + up / dn)
    rsi_d = (rsi - 50.0) * d

    vwap_dist = _safe(day.c[i] - day.atp[i]) * d
    highs = day.h[: i + 1]
    lows = day.l[: i + 1]
    dh, dl = np.nanmax(highs), np.nanmin(lows)
    drp = ((day.c[i] - dl) / (dh - dl) - 0.5) * 2 * d if dh > dl else 0.0

    vel1 = _safe(day.c[i] - day.c[i - 1]) * d if i >= 1 else 0.0
    vel3 = _safe(day.c[i] - day.c[i - 3]) * d if i >= 3 else 0.0
    vol_delta = _safe(day.vol_cum[i] - day.vol_cum[i - 1]) if i >= 1 else 0.0
    db = _safe(day.buy_cum[i] - day.buy_cum[i - 1]) if i >= 1 else 0.0
    ds = _safe(day.sell_cum[i] - day.sell_cum[i - 1]) if i >= 1 else 0.0
    bs_imb = ((db - ds) / (db + ds) if (db + ds) > 0 else 0.0) * d
    depth_imb = _safe(day.depth_imb[i]) * d

    atm = day.atm_strike(i)
    strike = int(atm) if not np.isnan(atm) else 0
    my, other = ("CE", "PE") if d > 0 else ("PE", "CE")
    my_r1 = _prem_ret(day, strike, my, i, 1)
    ot_r1 = _prem_ret(day, strike, other, i, 1)
    my_r3 = _prem_ret(day, strike, my, i, 3)
    ot_r3 = _prem_ret(day, strike, other, i, 3)
    q = day.quote(strike, my, i) if strike else None
    rel_spread = (q[1] - q[0]) / q[1] if q and q[1] > 0 else 0.0

    iv = _safe(day.atm_iv[i])
    iv5 = _safe(day.atm_iv[i] - day.atm_iv[i - 5]) if i >= 5 else 0.0
    oc, op = _safe(day.oi_call[i]), _safe(day.oi_put[i])
    # note: call OI build-up is resistance (bearish), put OI support (bullish)
    oi_tilt = ((op - oc) / (op + oc) if (op + oc) > 0 else 0.0) * d
    dc, dp = _safe(day.doi_call[i]), _safe(day.doi_put[i])
    tot = abs(dc) + abs(dp)
    doi_tilt = ((dp - dc) / tot if tot > 0 else 0.0) * d

    vix = _safe(day.vix[i])
    vix5 = _safe(day.vix[i] - day.vix[i - 5]) if i >= 5 else 0.0
    basis = _safe(day.c[i] - day.spot[i])
    basis5 = 0.0
    if i >= 5 and not (np.isnan(day.spot[i - 5]) or np.isnan(day.c[i - 5])):
        basis5 = basis - (day.c[i - 5] - day.spot[i - 5])

    return [
        dist, slope1, slope3, body, rng, wick_with, wick_against, float(streak),
        float(prev_leg[0]), prev_leg[1], float(prev2_leg[0]), float(flips30),
        rsi_d, vwap_dist, drp,
        vel1, vel3, float(day.tick_count[i]), vol_delta, bs_imb, depth_imb,
        _safe(day.spread[i]),
        my_r1, ot_r1, my_r3, ot_r3, rel_spread,
        iv, iv5, oi_tilt, doi_tilt,
        vix, vix5, basis, basis5, float(i),
    ]


def entry_extra_features(day: DayData, i: int, direction: int,
                         cross_candle: int) -> list[float]:
    d = float(direction)
    depth = (day.sma[i] - day.l[i]) if direction > 0 else (day.h[i] - day.sma[i])
    return [float(i - cross_candle), float(_safe(depth))]


def exit_features(day: DayData, i: int, direction: int, entry_candle: int,
                  strike: int) -> list[float]:
    base = entry_features(day, i, direction)
    d = float(direction)
    my = "CE" if direction > 0 else "PE"
    a = day.opt_ltp.get((strike, my))
    prem_ret = 0.0
    if a is not None:
        p_in, p_now = a[entry_candle], a[i]
        if not (np.isnan(p_in) or np.isnan(p_now)) and p_in > 0:
            prem_ret = float(p_now / p_in - 1.0)
    und_move = _safe(day.c[i] - day.c[entry_candle]) * d
    adverse = _safe(day.sma[i] - day.ha_c[i]) * d  # how far past the line
    return base + [prem_ret, und_move, float(i - entry_candle), adverse]
