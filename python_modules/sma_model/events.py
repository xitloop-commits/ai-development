"""Decision-event extraction + rupee grading (spec §4 + §6).

Entry examples: every decidable candle close is a hypothetical entry in the
direction of its side (+1 → CALL, −1 → PUT). The ride follows the baseline
hold rule — stay while candles close on our side, exit at the first
opposite-side close (or day end). Buy 1 lot ATM at recorded ask, sell at
recorded bid, subtract real charges → net ₹ label.

Exit examples: for each leg-start entry (the crossing candle), the first
wrong-side close asks "exit now or hold?". Hold = stay until the NEXT
wrong-side close (or day end). Label = which choice nets more ₹.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import LOT_SIZE, MIN_DECISION_CANDLE, round_trip_charges
from .pipeline import N_CANDLES, DayData


@dataclass
class EntryEvent:
    date: str
    candle: int                 # decision candle index
    direction: int              # +1 CALL, −1 PUT
    is_leg_start: bool          # first candle of a fresh side streak
    strike: int
    exit_candle: int
    entry_ask: float
    exit_bid: float
    net_inr: float              # after charges
    gross_inr: float


@dataclass
class ExitEvent:
    date: str
    candle: int                 # the wrong-side close being judged
    direction: int              # direction of the open trade
    entry_candle: int
    strike: int
    exit_now_net: float         # net ₹ if we exit at this candle
    hold_net: float             # net ₹ if we hold to next wrong-side close
    hold_better: int            # 1 if holding nets more


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


def extract_events(day: DayData):
    """All entry + exit events for one day."""
    side = day.side()
    entries: list[EntryEvent] = []
    exits: list[ExitEvent] = []
    last = N_CANDLES - 1

    for i in range(MIN_DECISION_CANDLE, last):  # never enter on the last candle
        d = int(side[i])
        if d == 0 or np.isnan(day.spot[i]):
            continue
        atm = day.atm_strike(i)
        if np.isnan(atm):
            continue
        strike = int(atm)
        opt = "CE" if d > 0 else "PE"
        j = _ride_exit_candle(side, i, d)
        trade = _trade_net(day, strike, opt, i, j)
        if trade is None:
            continue
        net, gross, ask, bid = trade
        is_leg_start = side[i - 1] != 0 and side[i - 1] != d
        entries.append(EntryEvent(
            date=day.date, candle=i, direction=d, is_leg_start=is_leg_start,
            strike=strike, exit_candle=j, entry_ask=ask, exit_bid=bid,
            net_inr=net, gross_inr=gross,
        ))

        # Exit chain: judged only for the canonical leg-start ride.
        if is_leg_start and j < last:
            opt_ = opt
            j2 = _ride_exit_candle(side, j, d)
            now = _trade_net(day, strike, opt_, i, j)
            held = _trade_net(day, strike, opt_, i, j2)
            if now is not None and held is not None:
                exits.append(ExitEvent(
                    date=day.date, candle=j, direction=d, entry_candle=i,
                    strike=strike,
                    exit_now_net=now[0], hold_net=held[0],
                    hold_better=int(held[0] > now[0]),
                ))
    return entries, exits
