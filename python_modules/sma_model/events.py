"""Decision-event extraction + rupee grading (spec §4, §6, D14/D15 v2).

v2 entry universe — pullback entries only (D14):
  A cross at candle x (side flips) opens a watch window of PULLBACK_WINDOW
  candles. The first candle p in that window whose raw low (up-leg) / high
  (down-leg) comes back to within PULLBACK_TOL of the SMA5 line — while the
  candle still closes on the leg's side — is the entry opportunity. Entry at
  p's close. Side flips back before a pullback → no event (whipsaw filtered).

Each entry event carries TWO labels:
  net_inr        — ride p → first wrong-side close, ATM ask in / bid out,
                   minus real charges (D8)
  favorable_pts  — the leg's best run in our direction after entry (D15
                   leg-size head label)

Exit events (unchanged from v1): at the ride's first wrong-side close,
compare exit-now vs hold-to-next-wrong-side-close in net ₹.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import LOT_SIZE, MIN_DECISION_CANDLE, round_trip_charges
from .pipeline import N_CANDLES, DayData

PULLBACK_WINDOW = 5     # candles after the cross to wait for a pullback
PULLBACK_TOL = 1.0      # points from the SMA5 line that count as "touched"


@dataclass
class EntryEvent:
    date: str
    candle: int                 # pullback candle = decision candle
    cross_candle: int
    direction: int              # +1 CALL, −1 PUT
    strike: int
    exit_candle: int
    entry_ask: float
    exit_bid: float
    net_inr: float              # after charges
    gross_inr: float
    favorable_pts: float        # best run in our direction after entry


@dataclass
class ExitEvent:
    date: str
    candle: int                 # the wrong-side close being judged
    direction: int
    entry_candle: int
    strike: int
    exit_now_net: float
    hold_net: float
    hold_better: int


def _ride_exit_candle(side: np.ndarray, i: int, direction: int) -> int:
    """First candle after i that closes on the wrong side (or last candle)."""
    j = i + 1
    last = N_CANDLES - 1
    while j <= last:
        if side[j] != 0 and side[j] != direction:
            return j
        j += 1
    return last


def _trade_net(day: DayData, strike: int, opt: str, i_in: int, i_out: int):
    """Net/gross ₹ for buy-at-ask(i_in) → sell-at-bid(i_out), 1 lot."""
    q_in = day.quote(strike, opt, i_in)
    q_out = day.quote(strike, opt, i_out)
    if q_in is None or q_out is None:
        return None
    ask = q_in[1]
    bid = q_out[0]
    buy_value = ask * LOT_SIZE
    sell_value = bid * LOT_SIZE
    gross = sell_value - buy_value
    net = gross - round_trip_charges(buy_value, sell_value)
    return net, gross, ask, bid


def pullback_hit(day: DayData, i: int, direction: int) -> bool:
    """Did candle i dip back to the SMA5 line while closing on the leg side?"""
    if np.isnan(day.sma[i]):
        return False
    if direction > 0:
        return day.l[i] <= day.sma[i] + PULLBACK_TOL
    return day.h[i] >= day.sma[i] - PULLBACK_TOL


def find_pullback_entries(side: np.ndarray, day: DayData):
    """Yield (cross_candle, entry_candle, direction) per D14."""
    last = N_CANDLES - 1
    i = 1
    while i <= last:
        if side[i] != 0 and side[i - 1] != 0 and side[i] != side[i - 1]:
            d = int(side[i])
            x = i
            entered = False
            for p in range(x + 1, min(x + PULLBACK_WINDOW, last - 1) + 1):
                if side[p] != d:        # whipsawed back — no trade
                    break
                if p >= MIN_DECISION_CANDLE and pullback_hit(day, p, d):
                    yield x, p, d
                    entered = True
                    break
            # continue scanning from the cross either way; next cross found
            # naturally (an entered leg's exit-cross is the next flip)
        i += 1


def _favorable_pts(day: DayData, i_in: int, i_out: int, direction: int) -> float:
    """Best run in our direction between entry close and ride end."""
    if i_out <= i_in:
        return 0.0
    if direction > 0:
        seg = day.h[i_in + 1: i_out + 1]
        seg = seg[~np.isnan(seg)]
        return float(seg.max() - day.c[i_in]) if seg.size else 0.0
    seg = day.l[i_in + 1: i_out + 1]
    seg = seg[~np.isnan(seg)]
    return float(day.c[i_in] - seg.min()) if seg.size else 0.0


def extract_events(day: DayData):
    """All pullback entry + exit events for one day."""
    side = day.side()
    entries: list[EntryEvent] = []
    exits: list[ExitEvent] = []
    last = N_CANDLES - 1

    for x, p, d in find_pullback_entries(side, day):
        if p >= last or np.isnan(day.spot[p]):
            continue
        atm = day.atm_strike(p)
        if np.isnan(atm):
            continue
        strike = int(atm)
        opt = "CE" if d > 0 else "PE"
        j = _ride_exit_candle(side, p, d)
        trade = _trade_net(day, strike, opt, p, j)
        if trade is None:
            continue
        net, gross, ask, bid = trade
        entries.append(EntryEvent(
            date=day.date, candle=p, cross_candle=x, direction=d,
            strike=strike, exit_candle=j, entry_ask=ask, exit_bid=bid,
            net_inr=net, gross_inr=gross,
            favorable_pts=_favorable_pts(day, p, j, d),
        ))

        # Exit chain at the ride's first wrong-side close.
        if j < last:
            j2 = _ride_exit_candle(side, j, d)
            held = _trade_net(day, strike, opt, p, j2)
            if held is not None:
                exits.append(ExitEvent(
                    date=day.date, candle=j, direction=d, entry_candle=p,
                    strike=strike,
                    exit_now_net=net, hold_net=held[0],
                    hold_better=int(held[0] > net),
                ))
    return entries, exits
