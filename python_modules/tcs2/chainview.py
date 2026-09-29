"""TCS2 - the option chain in plain English, one phrase per strike.

Partha 2026-09-29: show the key information in simple English against each
strike, not more numbers. Dhan already gives numbers and a price-inferred
buildup label; repeating that would not justify our own chain.

What makes a phrase here worth reading is what Dhan structurally cannot say:

  * **who** - buyers or writers, from who crossed the spread on each print,
    rather than inferred from which way the price moved. Dhan's "Long Buildup"
    is a guess from price direction, and price up with open interest up is
    equally new buyers or writers selling into demand: opposite participants,
    same label.
  * **when** - built in the last twenty minutes, or held all day. Dhan has one
    open-interest change for the whole day, so a wall thrown up in fifteen
    minutes and one standing since the open read identically.
  * **whether the quote is alive** - a leg whose last trade was 412 points from
    its live market is a ghost, and we know which ones those are.

Every phrase is a plain sentence with no jargon: ceiling, floor, buyers,
writers, quiet. A trader should not have to learn the screen.

Wording lives here, apart from the widgets, so it can be tested and argued about
without a display.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

# What counts as a real move in open interest, as a share of what is already
# there. Below this a strike is "quiet" - option OI jitters constantly and a
# screen that calls every wobble a signal is one you stop reading.
MATERIAL_OI_MOVE = 0.03

# The longest a phrase may be, so rows stay aligned in the grid.
MAX_PHRASE = 34

# A build is "fast" when most of it happened in the recent window.
FAST_WINDOW_MIN = 20.0
FAST_SHARE = 0.6

# Size language. Rank 1 on a side is "biggest"; the top few get a longer bar.
BAR_BLOCKS = 6


@dataclass
class LegView:
    """One side of one strike, ready to draw."""

    phrase: str = "quiet"
    tag: str = "dim"          # colour tag for the screen
    bar: int = 0              # 0-BAR_BLOCKS, how much open interest sits here
    oi: int = 0
    ltp: float = 0.0
    live: bool = True         # False when the price is a stale last trade


@dataclass
class StrikeView:
    strike: float
    call: LegView
    put: LegView
    is_atm: bool = False


def _bar(oi: int, biggest: int) -> int:
    if oi <= 0 or biggest <= 0:
        return 0
    return max(1, min(BAR_BLOCKS, round(BAR_BLOCKS * oi / biggest)))


def _age_words(total_change: int, recent_change: int, trail_seconds: float,
               window_min: float = FAST_WINDOW_MIN) -> str:
    """How long this has been going on, in words.

    Returns "" when there is not enough history to say - which is honest, and
    better than guessing "all day" twenty minutes after startup.
    """
    if trail_seconds < window_min * 60.0:
        return ""
    if total_change == 0:
        return ""
    share = abs(recent_change) / abs(total_change) if total_change else 0.0
    # Short forms on purpose: the phrase shares a column with the bar and the
    # meaning, and an overflowing row breaks the alignment that makes a chain
    # scannable. "fast (20m)" says as much as "fast, last 20 minutes".
    if share >= FAST_SHARE:
        return f"fast ({int(window_min)}m)"
    if share <= 0.15:
        return "all day"
    return "since open"


def leg_phrase(*, is_call: bool, oi: int, oi_open: int, oi_recent: int,
               biggest_oi: int, is_biggest: bool, buyers_aggressive: bool | None,
               live: bool, ticked: bool, trail_seconds: float) -> LegView:
    """One plain-English phrase for one leg.

    `buyers_aggressive` is None when we have no flow state for this leg - flow is
    tracked for the futures and a band around the money, not for every one of
    4,060 legs. The phrase then says what happened without claiming who did it,
    which is the honest form rather than a guess.
    """
    view = LegView(oi=oi, ltp=0.0, live=live, bar=_bar(oi, biggest_oi))

    if not ticked:
        view.phrase, view.tag = "nothing here", "dim"
        return view
    if not live:
        # A last trade with no live book behind it. Dhan prints this as fact.
        view.phrase, view.tag = "no live market", "dim"
        return view

    change = oi - oi_open if oi_open >= 0 else 0
    moved = abs(change) >= max(1.0, MATERIAL_OI_MOVE * max(oi, 1))
    if not moved:
        if oi > 0 and is_biggest:
            wall = "ceiling" if is_call else "floor"
            view.phrase = f"BIGGEST {wall}, unchanged today"
            view.tag = "bad" if is_call else "good"
            if buyers_aggressive is None:
                # The biggest open interest on a side IS the wall, whoever built
                # it - that much is not an inference. Kept, but flagged amber
                # rather than coloured as a measured fact.
                view.tag = "warn"
        else:
            view.phrase, view.tag = "quiet", "dim"
        return view

    age = _age_words(change, oi_recent, trail_seconds)
    building = change > 0

    # Writers selling calls build a ceiling; writers selling puts build a floor.
    # Buyers doing the same builds nothing of the sort - which is exactly why
    # WHO did it matters, and exactly what a price-inferred label cannot tell.
    #
    # So when we have not measured the aggressor, the phrase states the FACT and
    # stops there. Calling it a ceiling anyway would be the same guess we decline
    # to inherit, dressed in our own words.
    if building:
        if buyers_aggressive is True:
            view.phrase = "buyers piling in"
            view.tag = "good" if is_call else "bad"
        elif buyers_aggressive is False:
            wall = "CEILING" if is_call else "FLOOR"
            view.phrase = wall if not is_biggest else f"BIGGEST {wall}"
            view.tag = "bad" if is_call else "good"
        else:
            side = "calls" if is_call else "puts"
            view.phrase = f"more {side} here"
            view.tag = "warn"
    else:
        if buyers_aggressive is True:
            view.phrase = "buyers walking away"
            view.tag = "bad" if is_call else "good"
        elif buyers_aggressive is False:
            view.phrase = "ceiling breaking" if is_call else "floor breaking"
            view.tag = "good" if is_call else "bad"
        else:
            side = "calls" if is_call else "puts"
            view.phrase = f"{side} closing out"
            view.tag = "warn"

    if age:
        view.phrase = f"{view.phrase} - {age}"
    view.phrase = view.phrase[:MAX_PHRASE]
    return view


def build_rows(chain, expiry: str, flow: dict | None = None,
               now: float | None = None, around: int = 0) -> list[StrikeView]:
    """Every strike of an expiry, as phrases ready to draw."""
    m = chain.expiry == expiry
    if not m.any():
        return []
    summary = chain.summary(expiry, now)
    atm = summary.atm_strike
    step = getattr(chain.cap, "strike_step", 50.0)

    recent = chain.oi_change_over(FAST_WINDOW_MIN, now)
    trail = chain.oi_trail_span(now)

    call_oi = chain.oi[m & chain.is_call]
    put_oi = chain.oi[m & ~chain.is_call]
    biggest_call = int(call_oi.max()) if call_oi.size else 0
    biggest_put = int(put_oi.max()) if put_oi.size else 0

    out: list[StrikeView] = []
    for k in np.unique(chain.strike[m]):
        if around and atm and abs(k - atm) > around * step:
            continue
        legs: dict[bool, LegView] = {}
        for flag in (True, False):
            sel = m & (chain.strike == k) & (chain.is_call == flag)
            if not sel.any():
                legs[flag] = LegView(phrase="", tag="dim")
                continue
            i = int(np.flatnonzero(sel)[0])
            sid = int(chain.security_id[i])
            aggressive = None
            fs = (flow or {}).get(sid)
            if fs is not None and fs.prints:
                a = fs.aggression(1800)
                if a["total_qty"] > 0:
                    aggressive = a["buy_share"] > a["sell_share"]
            biggest = biggest_call if flag else biggest_put
            lv = leg_phrase(
                is_call=flag, oi=int(chain.oi[i]),
                oi_open=int(chain.oi_open[i]), oi_recent=int(recent[i]),
                biggest_oi=biggest,
                is_biggest=(biggest > 0 and int(chain.oi[i]) == biggest),
                buyers_aggressive=aggressive,
                live=bool(chain.price_source[i]),
                ticked=int(chain.tick_count[i]) > 0,
                trail_seconds=trail)
            lv.ltp = float(chain.ltp[i])
            legs[flag] = lv
        out.append(StrikeView(strike=float(k), call=legs[True], put=legs[False],
                              is_atm=(k == atm)))
    return out


def summary_line(rows: list[StrikeView], spot: float) -> str:
    """One sentence naming the ceiling, the floor and anything new."""
    if not rows:
        return "waiting for the chain to fill ..."
    ceiling = max((r for r in rows if "CEILING" in r.call.phrase.upper()),
                  key=lambda r: r.call.oi, default=None)
    floor = max((r for r in rows if "FLOOR" in r.put.phrase.upper()),
                key=lambda r: r.put.oi, default=None)
    fresh = [r for r in rows
             if "fast" in r.call.phrase or "fast" in r.put.phrase]
    bits = []
    if ceiling:
        bits.append(f"ceiling {ceiling.strike:,.0f}")
    if floor:
        bits.append(f"floor {floor.strike:,.0f}")
    if not bits:
        return "no clear ceiling or floor yet"
    line = "  ".join(bits)
    if fresh:
        line += "   NEW: " + ", ".join(f"{r.strike:,.0f}" for r in fresh[:3])
    return line
