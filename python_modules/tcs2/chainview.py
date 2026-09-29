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
MAX_PHRASE = 30

# A build is "fast" when most of it happened in the recent window.
FAST_WINDOW_MIN = 20.0
FAST_SHARE = 0.6

# What counts as a real move in a leg's own price, for the buildup reading: one
# per cent of where it opened, and never less than a tick's worth.
MATERIAL_PRICE_MOVE = 0.01

# Size language. Rank 1 on a side is "biggest"; the top few get a longer bar.
BAR_BLOCKS = 6

# How many strikes on a side are named as walls. Rank 1 is the biggest; 2-5 are
# still levels a trader watches. Below that a strike really is small, and saying
# so plainly is the whole point of the column.
WALL_RANKS = 5

# How many support and resistance levels to mark.
LEVELS_SHOWN = 5

# How close to even the aggressor split has to be before we call it a fight
# rather than a side. Partha 2026-09-29: "thug war need to be identified" - and a
# 52/48 split is not one side winning, it is two sides pushing.
TUG_BAND = 0.06

# A tug of war is a BAND of strikes being fought over, not one strike. This is
# how far from the money we look for it, in strike steps.
TUG_REACH = 6


@dataclass
class LegView:
    """One side of one strike, ready to draw."""

    phrase: str = "quiet"
    tag: str = "dim"          # colour tag for the screen
    bar: int = 0              # 0-BAR_BLOCKS, how much open interest sits here
    oi: int = 0
    ltp: float = 0.0
    live: bool = True         # False when the price is a stale last trade
    level: str = ""           # "R1".."S5" when this leg is a marked level
    rank: int = 0             # 1 = most open interest on this side
    who: str = ""             # "B 74%" / "S 61%" / "TUG" - who is crossing here
    who_tag: str = "dim"
    buildup: str = ""         # what today's position change amounts to, in words
    buildup_tag: str = "dim"

    @property
    def dead(self) -> bool:
        """Nothing real to read here.

        Partha 2026-09-29: a strike with no position left is as empty as one that
        never traded, so it goes too. A row that says nothing costs the reader the
        same attention as a row that says something.
        """
        return self.phrase in ("no live market", "nothing here",
                               "no position left", "")


@dataclass
class StrikeView:
    strike: float
    call: LegView
    put: LegView
    is_atm: bool = False

    @property
    def dead(self) -> bool:
        """Both sides unreadable. One live side is still worth a row."""
        return self.call.dead and self.put.dead


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
               biggest_oi: int, rank: int = 0, level: str = "",
               buyers_aggressive: bool | None, buy_share: float | None = None,
               ltp: float = 0.0, price_open: float = 0.0,
               live: bool, ticked: bool, trail_seconds: float) -> LegView:
    """One plain-English phrase for one leg.

    `rank` is 1 for the strike holding the most open interest on its side, 2 for
    the next, and 0 when it is outside the top few. `level` is set ("R1", "S2")
    when this leg is one of the marked support or resistance levels.

    `buyers_aggressive` is None when we have no flow state for this leg - flow is
    tracked for the futures and a band around the money, not for every one of
    4,060 legs. The phrase then says what happened without claiming who did it,
    which is the honest form rather than a guess.

    `buy_share` is the same measurement as `buyers_aggressive`, unrounded, for the
    WHO column. They come from one call in `build_rows` so they cannot disagree:
    the bool is the decision, the share is what the decision was made on.
    """
    view = LegView(oi=oi, ltp=ltp, live=live, bar=_bar(oi, biggest_oi),
                   level=level, rank=rank)
    view.who, view.who_tag = _who(buy_share, is_call)
    view.buildup, view.buildup_tag = buildup_words(
        is_call=is_call, price=ltp, price_open=price_open, oi=oi, oi_open=oi_open)

    if not ticked:
        view.phrase, view.tag = "nothing here", "dim"
        return view
    if not live:
        # A last trade with no live book behind it. Dhan prints this as fact.
        view.phrase, view.tag = "no live market", "dim"
        return view

    wall = "ceiling" if is_call else "floor"
    held = "bad" if is_call else "good"      # a wall holding caps price
    gone = "good" if is_call else "bad"      # a wall breaking frees it

    change = oi - oi_open if oi_open >= 0 else 0
    moved = abs(change) >= max(1.0, MATERIAL_OI_MOVE * max(oi, 1))

    if not moved:
        # Partha 2026-09-29: "quiet" was printed against nearly every strike,
        # including the biggest walls on the board. A move had to clear 3% of the
        # strike's OWN size, so a strike holding 160 lakh needed 4.8 lakh of
        # change to register - the bigger the wall, the more likely it read
        # "quiet". The rows that mattered most got the word that meant least, and
        # it hid the fact that they were walls at all.
        #
        # Size now speaks first. A wall standing still is still a wall, and only
        # a genuinely small strike is called small.
        if oi <= 0:
            view.phrase, view.tag = "no position left", "dim"
        elif rank == 1:
            view.phrase, view.tag = f"BIGGEST {wall} - holding", held
        elif 0 < rank <= WALL_RANKS:
            view.phrase, view.tag = f"{wall} #{rank} - holding", held
        else:
            view.phrase, view.tag = "small, not moving", "dim"
        view.phrase = view.phrase[:MAX_PHRASE]
        return view

    building = change > 0

    if level:
        # Partha 2026-09-29: at a marked level, say who is pushing. Open interest
        # growing at a level means it is being defended; open interest leaving
        # means it is being given up. Whether a level is holding or cracking is
        # the one thing the level on its own cannot tell you, and it is the
        # reason the level is worth marking.
        now = " now" if _age_words(change, oi_recent, trail_seconds).startswith("fast") else ""
        # The level's name is printed in its own column, so the phrase spends all
        # of its room on who is pushing rather than repeating the label.
        if building:
            if buyers_aggressive is False:
                view.phrase, view.tag = "DEFENDED - writers adding", held
            elif buyers_aggressive is True:
                view.phrase, view.tag = "under attack - buyers in", gone
            else:
                view.phrase, view.tag = "defended - more OI here", "warn"
        else:
            if buyers_aggressive is False:
                view.phrase, view.tag = "CRACKING - writers gone", gone
            elif buyers_aggressive is True:
                view.phrase, view.tag = "losing - buyers leaving", held
            else:
                view.phrase, view.tag = "weakening - OI leaving", "warn"
        view.phrase = (view.phrase + now)[:MAX_PHRASE]
        return view

    age = _age_words(change, oi_recent, trail_seconds)

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
            big = "CEILING" if is_call else "FLOOR"
            view.phrase = big if rank != 1 else f"BIGGEST {big}"
            view.tag = held
        else:
            side = "calls" if is_call else "puts"
            view.phrase = f"more {side} here"
            view.tag = "warn"
    else:
        if buyers_aggressive is True:
            view.phrase = "buyers walking away"
            view.tag = "bad" if is_call else "good"
        elif buyers_aggressive is False:
            view.phrase = f"{wall} breaking"
            view.tag = gone
        else:
            side = "calls" if is_call else "puts"
            view.phrase = f"{side} closing out"
            view.tag = "warn"

    if age:
        view.phrase = f"{view.phrase} - {age}"
    view.phrase = view.phrase[:MAX_PHRASE]
    return view


def buildup_words(*, is_call: bool, price: float, price_open: float,
                  oi: int, oi_open: int) -> tuple[str, str]:
    """Today's position change in a leg, in plain English (Partha 2026-09-29).

    This is the reading every chain calls "buildup", and every chain prints it in
    the trade's own jargon - Long Buildup, Short Covering. The four cases are
    simple facts about two numbers, so they are said as facts:

        price up,   open interest up   -> new buyers are coming in
        price down, open interest up   -> new sellers are coming in
        price down, open interest down -> buyers are closing out
        price up,   open interest down -> sellers are buying back

    Note what this is NOT. It says nothing about who crossed the spread; it is
    inferred from price direction, which is the guess we decline elsewhere. It
    earns its place because it answers a different question - what happened to the
    positions - and because the WHO column beside it is measured, so the reader can
    see when the two disagree. Where they disagree, the measured one is the one to
    believe.

    Blank when either number has not really moved. A buildup label on a leg that
    has not moved is the screen inventing a story out of rounding.
    """
    if price <= 0 or price_open <= 0 or oi_open < 0:
        return "", "dim"
    price_change = price - price_open
    if abs(price_change) < max(0.05, MATERIAL_PRICE_MOVE * price_open):
        return "", "dim"
    oi_change = oi - oi_open
    if abs(oi_change) < max(1.0, MATERIAL_OI_MOVE * max(oi, 1)):
        return "", "dim"

    up = price_change > 0
    if oi_change > 0:
        word = "new buyers in" if up else "new sellers in"
    else:
        word = "sellers cover" if up else "buyers closing"

    # A call gaining is bullish and a put gaining is bearish, whichever of the
    # four cases produced it - so the colour follows the leg's own price.
    good = up if is_call else not up
    return word, ("good" if good else "bad")


def _who(buy_share: float | None, is_call: bool) -> tuple[str, str]:
    """Who is crossing the spread on this leg, and how one-sidedly.

    Partha 2026-09-29: "i need to see where more buyers are there, sellers are
    others". Not inferred from price - measured from which side crossed, which is
    the one reading Dhan's chain structurally cannot give.

    Buying a call and buying a put are both BUYING, so "B" means the same act on
    both sides of the ladder. What it implies for price is opposite, and that is
    what the colour says.
    """
    if buy_share is None:
        return "", "dim"
    if abs(buy_share - 0.5) < TUG_BAND:
        return "TUG", "warn"
    if buy_share > 0.5:
        return f"B {buy_share * 100:.0f}%", "good" if is_call else "bad"
    return f"S {(1 - buy_share) * 100:.0f}%", "bad" if is_call else "good"


@dataclass
class Tug:
    """A band of strikes both sides are fighting over."""

    low: float = 0.0
    high: float = 0.0
    strikes: int = 0
    reason: str = ""

    @property
    def phrase(self) -> str:
        if not self.strikes:
            return ""
        if self.low == self.high:
            return f"TUG OF WAR at {self.low:,.0f}"
        return f"TUG OF WAR {self.low:,.0f} - {self.high:,.0f}"


def tug_zone(chain, expiry: str, now: float | None = None) -> Tug | None:
    """Where buyers and sellers are both committing, near the money.

    A strike is contested when BOTH its call and its put took on open interest
    today. That is the signature of a fight: one side is selling calls to cap
    price while the other sells puts to hold it up, at the same strike, at the
    same time. A one-sided build is not a fight, however large.

    Only strikes near the money count. Both legs of a far strike can grow all day
    without anyone contesting anything - they are two unrelated yield trades.
    """
    m = chain.expiry == expiry
    if not m.any():
        return None
    spot = chain.reference
    if spot <= 0:
        return None
    step = getattr(chain.cap, "strike_step", 50.0) or 50.0
    reach = step * TUG_REACH

    contested: list[float] = []
    for k in np.unique(chain.strike[m]):
        if abs(float(k) - spot) > reach:
            continue
        grew = {}
        for flag in (True, False):
            sel = m & (chain.strike == k) & (chain.is_call == flag)
            idx = np.flatnonzero(sel)
            if idx.size == 0:
                break
            i = int(idx[0])
            if int(chain.tick_count[i]) == 0 or int(chain.oi_open[i]) < 0:
                break
            change = int(chain.oi[i]) - int(chain.oi_open[i])
            grew[flag] = change >= max(1.0, MATERIAL_OI_MOVE * max(int(chain.oi[i]), 1))
        if len(grew) == 2 and all(grew.values()):
            contested.append(float(k))

    if not contested:
        return None
    return Tug(low=min(contested), high=max(contested), strikes=len(contested),
               reason="calls and puts both being written here")


def side_ranks(chain, m, is_call: bool) -> dict[float, int]:
    """strike -> 1-based rank by open interest, for one side of one expiry.

    Rank is what lets the screen call a wall a wall. Ties keep their order, which
    is arbitrary but stable, and nothing downstream depends on which of two equal
    strikes is called the bigger.
    """
    sel = m & (chain.is_call == is_call) & (chain.oi > 0)
    idx = np.flatnonzero(sel)
    if idx.size == 0:
        return {}
    order = idx[np.argsort(-chain.oi[idx], kind="stable")]
    return {float(chain.strike[i]): n for n, i in enumerate(order, 1)}


def build_rows(chain, expiry: str, flow: dict | None = None,
               now: float | None = None, around: int = 0,
               hide_dead: bool = True) -> list[StrikeView]:
    """Every strike of an expiry, as phrases ready to draw.

    `hide_dead` drops strikes with nothing real on EITHER side (Partha
    2026-09-29). A chain carries hundreds of strikes that have never traded and
    have no live market; they are rows of noise between the ones that matter.

    A strike is only dropped when BOTH sides are unreadable. A dead call beside a
    live put is still worth a row - hiding it would lose the live side, and the
    far wings are exactly where one side trades and the other does not.
    """
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

    ranks = {True: side_ranks(chain, m, True), False: side_ranks(chain, m, False)}

    # The marked levels, so each level's row can say whether it is being defended
    # or given up rather than just how much sits there.
    marked: dict[tuple[float, bool], str] = {}
    for lv in key_levels(chain, expiry, now=now):
        marked[(lv.strike, lv.kind == "R")] = lv.label

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
            share = None
            fs = (flow or {}).get(sid)
            if fs is not None and fs.prints:
                a = fs.aggression(1800)
                if a["total_qty"] > 0:
                    share = float(a["buy_share"])
                    aggressive = a["buy_share"] > a["sell_share"]
            biggest = biggest_call if flag else biggest_put
            lv = leg_phrase(
                is_call=flag, oi=int(chain.oi[i]),
                oi_open=int(chain.oi_open[i]), oi_recent=int(recent[i]),
                biggest_oi=biggest,
                rank=ranks[flag].get(float(k), 0),
                level=marked.get((float(k), flag), ""),
                buyers_aggressive=aggressive, buy_share=share,
                ltp=float(chain.ltp[i]),
                price_open=float(chain.day_open[i] or chain.prev_close[i]),
                live=bool(chain.price_source[i]),
                ticked=int(chain.tick_count[i]) > 0,
                trail_seconds=trail)
            lv.ltp = float(chain.ltp[i])
            legs[flag] = lv
        view = StrikeView(strike=float(k), call=legs[True], put=legs[False],
                          is_atm=(k == atm))
        # The at-the-money row always stays, even if quiet - losing your place on
        # the ladder is worse than one empty line.
        if hide_dead and view.dead and not view.is_atm:
            continue
        out.append(view)
    return out


def hidden_count(chain, expiry: str, shown: list[StrikeView]) -> int:
    """How many strikes were dropped, so the screen can say so.

    Filtering silently would be the same fault as a blank cell that means zero:
    the reader cannot tell "nothing there" from "we did not show you".
    """
    m = chain.expiry == expiry
    if not m.any():
        return 0
    total = int(np.unique(chain.strike[m]).size)
    return max(0, total - len(shown))


@dataclass
class Level:
    """A support or resistance level worth marking."""

    strike: float
    kind: str            # "R" above spot, "S" below
    rank: int            # 1 is the strongest
    oi: int = 0
    distance: float = 0.0
    note: str = ""
    touches: int = 0
    rejections: int = 0
    breaks: int = 0

    @property
    def label(self) -> str:
        return f"{self.kind}{self.rank}"

    @property
    def tested(self) -> str:
        """How the level has behaved when price actually reached it.

        Open interest says how much is standing there; this says whether the
        standing has ever been tested. A wall price has never gone near may be a
        yield trade rather than a line anyone is defending.
        """
        if not self.touches:
            return "untested"
        bits = [f"{self.touches}x hit"]
        if self.rejections:
            bits.append(f"{self.rejections} held")
        if self.breaks:
            bits.append(f"{self.breaks} broke")
        return ", ".join(bits)


def key_levels(chain, expiry: str, n: int = LEVELS_SHOWN,
               now: float | None = None, tracker=None) -> list[Level]:
    """The strongest support and resistance levels, ranked.

    Resistance is where CALL open interest sits above spot; support is where PUT
    open interest sits below. Ranked by how much is there, because that is what
    makes a level hold - a strike with twice the open interest takes twice the
    buying to push through.

    Levels on the wrong side of spot are dropped: a call wall BELOW price has
    already been broken and is not resistance any more. That sounds obvious and
    is exactly the sort of thing a ranking by size alone gets wrong.
    """
    m = chain.expiry == expiry
    if not m.any():
        return []
    spot = chain.reference
    if spot <= 0:
        return []

    candidates: list[Level] = []
    for i in np.flatnonzero(m):
        oi = int(chain.oi[i])
        if oi <= 0 or int(chain.tick_count[i]) == 0:
            continue
        k = float(chain.strike[i])
        is_call = bool(chain.is_call[i])
        if is_call and k > spot:
            candidates.append(Level(strike=k, kind="R", rank=0, oi=oi,
                                    distance=k - spot))
        elif not is_call and k < spot:
            candidates.append(Level(strike=k, kind="S", rank=0, oi=oi,
                                    distance=spot - k))

    if not candidates:
        return []
    candidates.sort(key=lambda lv: -lv.oi)
    top = candidates[:n]

    # Rank within each side, so R1 is the nearest strong ceiling rather than
    # whichever happened to be biggest overall.
    for kind in ("R", "S"):
        side = sorted((lv for lv in top if lv.kind == kind),
                      key=lambda lv: lv.distance)
        for j, lv in enumerate(side, 1):
            lv.rank = j

    # A level thrown up in the last twenty minutes is not the same thing as one
    # that has stood since the open, so say which it is.
    recent = chain.oi_change_over(FAST_WINDOW_MIN, now)
    for lv in top:
        sel = m & (chain.strike == lv.strike) & (chain.is_call == (lv.kind == "R"))
        idx = np.flatnonzero(sel)
        if idx.size:
            i = int(idx[0])
            total = int(chain.oi[i]) - int(chain.oi_open[i])                 if int(chain.oi_open[i]) >= 0 else 0
            if total > 0 and int(recent[i]) >= FAST_SHARE * total:
                lv.note = "new"
        if tracker is not None:
            t = tracker.at(lv.strike)
            lv.touches, lv.rejections, lv.breaks = (t.touches, t.rejections,
                                                    t.breaks)
    return sorted(top, key=lambda lv: -lv.strike)


@dataclass
class Control:
    """Who is running the market right now, and how clearly."""

    side: str = "NOBODY"         # BUYERS | SELLERS | NOBODY
    strength: int = 0            # 0-100, how one-sided the evidence is
    agree: int = 0               # how many pieces of evidence point the same way
    total: int = 0               # how many we could read at all
    reasons: list[str] = None    # plain words, one per piece of evidence

    def __post_init__(self):
        if self.reasons is None:
            self.reasons = []

    @property
    def phrase(self) -> str:
        if self.side == "NOBODY":
            return "nobody in control"
        strong = ("firmly" if self.strength >= 75 else
                  "" if self.strength >= 50 else "narrowly ")
        return f"{self.side.lower()} in control {strong}".strip()


def control_status(chain, expiry: str, flow: dict | None = None,
                   futures_ids: tuple = (), now: float | None = None) -> Control:
    """Who is taking control - buyers or sellers - from what we measured.

    Three independent readings, each of which can be absent:

      1. **the tape** - who is crossing the spread on the futures
      2. **the option writers** - building calls caps price, building puts
         supports it
      3. **price itself** - where it has actually gone

    Control is only claimed when a MAJORITY of the readings we could take agree.
    Two out of two is control; one out of three is noise wearing a label. The
    reasons are returned in plain words so the claim can be checked rather than
    trusted.
    """
    c = Control()
    votes: list[int] = []            # +1 buyers, -1 sellers

    # 1. the tape
    fut = None
    for sid in (futures_ids or ()):
        fs = (flow or {}).get(int(sid))
        if fs is not None and fs.prints:
            fut = fs
            break
    if fut is not None:
        a = fut.aggression(900)
        if a["total_qty"] > 0:
            buy, sell = a["buy_share"], a["sell_share"]
            if abs(buy - sell) >= 0.10:
                votes.append(1 if buy > sell else -1)
                who = "buyers" if buy > sell else "sellers"
                c.reasons.append(f"{who} are crossing the spread "
                                 f"({max(buy, sell) * 100:.0f}%)")
            else:
                c.reasons.append("tape is balanced")
                votes.append(0)

    # 2. the option writers
    m = chain.expiry == expiry
    if m.any():
        call_built = int(np.clip(chain.oi_change[m & chain.is_call], 0, None).sum())
        put_built = int(np.clip(chain.oi_change[m & ~chain.is_call], 0, None).sum())
        total_built = call_built + put_built
        if total_built > 0:
            share = abs(call_built - put_built) / total_built
            if share >= 0.10:
                # Calls being written caps price; puts being written supports it.
                votes.append(-1 if call_built > put_built else 1)
                c.reasons.append("more calls being written - capping price"
                                 if call_built > put_built
                                 else "more puts being written - supporting price")
            else:
                c.reasons.append("writers are even on both sides")
                votes.append(0)

    # 3. price
    if fut is not None:
        px = [p.price for p in fut._in(900)]
        if len(px) >= 5:
            move = px[-1] - px[0]
            span = max(px) - min(px)
            if span > 0 and abs(move) / span >= 0.3:
                votes.append(1 if move > 0 else -1)
                c.reasons.append("price is going up" if move > 0
                                 else "price is going down")
            else:
                c.reasons.append("price is going nowhere")
                votes.append(0)

    c.total = len(votes)
    if not votes:
        return c
    up = sum(1 for v in votes if v > 0)
    down = sum(1 for v in votes if v < 0)
    if up > down and up > c.total / 2:
        c.side, c.agree = "BUYERS", up
    elif down > up and down > c.total / 2:
        c.side, c.agree = "SELLERS", down
    else:
        c.side, c.agree = "NOBODY", max(up, down)
    c.strength = int(round(100 * c.agree / max(c.total, 1)))
    return c


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
