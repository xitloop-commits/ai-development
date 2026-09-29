"""TCS2 - tests for the plain-English option chain.

Partha 2026-09-29: key information in simple English against each strike.

The phrases ARE the feature, so they are tested directly rather than through a
window. Two things matter most:

  * a call and a put saying the same thing must mean OPPOSITE things - writers
    selling calls build a ceiling, writers selling puts build a floor
  * the screen must never claim to know who did something when it does not
"""
from __future__ import annotations

import pytest

from tcs2 import chainview as cv
from tcs2.chainview import LegView, leg_phrase


def leg(**kw) -> LegView:
    """A leg with sensible defaults; override what the test is about."""
    args = dict(is_call=True, oi=100_000, oi_open=100_000, oi_recent=0,
                biggest_oi=200_000, rank=0, buyers_aggressive=None,
                live=True, ticked=True, trail_seconds=3600.0)
    args.update(kw)
    return leg_phrase(**args)


# -- the screen never invents information -------------------------------

def test_a_leg_that_never_ticked_says_nothing_here():
    assert leg(ticked=False).phrase == "nothing here"


def test_a_stale_quote_is_named_as_one():
    """A last trade with no live book is a ghost.

    Measured on 2026-09-25: the 21,700 call printed 1,820 while its live market
    was 1,349/1,467. Dhan shows that stale print as fact.
    """
    v = leg(live=False)
    assert v.phrase == "no live market"
    assert v.tag == "dim"


def test_a_small_strike_that_has_not_moved_says_so_plainly():
    assert leg(oi=100_000, oi_open=100_000).phrase == "small, not moving"


def test_a_tiny_wobble_is_still_not_a_move():
    """Open interest jitters. A screen that calls every wobble a signal is one
    you stop reading."""
    assert leg(oi=101_000, oi_open=100_000).phrase == "small, not moving"


# -- a wall standing still is still a wall ------------------------------
#
# Partha 2026-09-29: "i see every where quiet - what does it mean to user". A
# move had to clear 3% of the strike's OWN size, so the bigger the wall the more
# likely it read "quiet" - the rows that mattered most got the word that meant
# least, and it hid the fact that they were walls at all.


def test_the_biggest_wall_holding_still_is_named_a_wall_not_quiet():
    v = leg(is_call=True, oi=16_000_000, oi_open=16_000_000, rank=1)
    assert v.phrase == "BIGGEST ceiling - holding"
    assert "quiet" not in v.phrase


def test_a_top_five_wall_holding_still_is_named_with_its_rank():
    assert leg(is_call=False, oi=5_000_000, oi_open=5_000_000,
               rank=3).phrase == "floor #3 - holding"


def test_a_wall_beyond_the_top_five_is_not_called_a_wall():
    assert leg(oi=900, oi_open=900, rank=40).phrase == "small, not moving"


def test_a_strike_holding_nothing_says_no_position_left():
    assert leg(oi=0, oi_open=0).phrase == "no position left"


def test_a_holding_wall_is_coloured_by_which_side_it_caps():
    assert leg(is_call=True, oi=9_000, oi_open=9_000, rank=1).tag == "bad"
    assert leg(is_call=False, oi=9_000, oi_open=9_000, rank=1).tag == "good"


def test_the_word_quiet_is_gone_from_every_phrase():
    """It was printed against nearly every strike, so it told the reader nothing.

    Whatever replaces it has to SAY something: how big, and whether it moved.
    """
    for kw in ({}, {"oi": 0}, {"rank": 1}, {"rank": 4}, {"rank": 99},
               {"oi": 5_000, "oi_open": 1_000},
               {"oi": 1_000, "oi_open": 5_000},
               {"oi": 5_000, "oi_open": 1_000, "buyers_aggressive": True},
               {"oi": 5_000, "oi_open": 1_000, "buyers_aggressive": False}):
        assert "quiet" not in leg(**kw).phrase


# -- at a marked level, say who is pushing ------------------------------
#
# Partha 2026-09-29: "during S/R Levels who is pushing". Open interest growing at
# a level means it is being defended; open interest leaving means it is being
# given up. That is the one thing the level on its own cannot tell you.


def test_writers_adding_at_a_level_means_it_is_defended():
    v = leg(is_call=True, oi=150_000, oi_open=100_000, level="R1",
            buyers_aggressive=False)
    assert v.phrase.startswith("DEFENDED")
    assert v.tag == "bad"                      # a defended ceiling caps price


def test_writers_leaving_a_level_means_it_is_cracking():
    v = leg(is_call=True, oi=60_000, oi_open=100_000, level="R1",
            buyers_aggressive=False)
    assert v.phrase.startswith("CRACKING")
    assert v.tag == "good"                     # a ceiling giving way frees price


def test_a_defended_floor_is_good_news_and_a_cracking_one_is_bad():
    held = leg(is_call=False, oi=150_000, oi_open=100_000, level="S1",
               buyers_aggressive=False)
    gone = leg(is_call=False, oi=60_000, oi_open=100_000, level="S1",
               buyers_aggressive=False)
    assert held.tag == "good" and gone.tag == "bad"


def test_buyers_at_a_level_are_attacking_it_not_defending_it():
    """Who is pushing is the whole point: buyers and writers at the same level,
    both adding open interest, mean opposite things."""
    v = leg(is_call=True, oi=150_000, oi_open=100_000, level="R1",
            buyers_aggressive=True)
    assert "attack" in v.phrase
    assert v.tag == "good"


def test_an_unmeasured_level_does_not_claim_who_is_pushing():
    v = leg(is_call=True, oi=150_000, oi_open=100_000, level="R1",
            buyers_aggressive=None)
    assert "writers" not in v.phrase and "buyers" not in v.phrase
    assert v.tag == "warn"


def test_a_level_phrase_does_not_repeat_the_label():
    """The label is printed in its own column, so the phrase spends its room on
    who is pushing."""
    assert "R1" not in leg(is_call=True, oi=150_000, oi_open=100_000,
                           level="R1", buyers_aggressive=False).phrase


def test_a_level_that_has_not_moved_still_reads_as_a_wall():
    assert leg(is_call=True, oi=100_000, oi_open=100_000, level="R1",
               rank=1).phrase == "BIGGEST ceiling - holding"


# -- calls and puts mean OPPOSITE things --------------------------------

def test_writers_building_calls_is_a_ceiling():
    v = leg(is_call=True, oi=150_000, oi_open=100_000, buyers_aggressive=False)
    assert "CEILING" in v.phrase
    assert v.tag == "bad"            # a ceiling blocks a call buyer


def test_writers_building_puts_is_a_floor():
    """The mirror. Same action, opposite meaning - which is the whole point."""
    v = leg(is_call=False, oi=150_000, oi_open=100_000, buyers_aggressive=False)
    assert "FLOOR" in v.phrase
    assert v.tag == "good"


def test_buyers_building_calls_is_not_a_ceiling():
    """Price up with OI up is EITHER new buyers or writers selling into demand.

    Dhan infers from price and cannot tell them apart. We measure who crossed
    the spread, so the two must not produce the same phrase.
    """
    writers = leg(is_call=True, oi=150_000, oi_open=100_000,
                  buyers_aggressive=False)
    buyers = leg(is_call=True, oi=150_000, oi_open=100_000,
                 buyers_aggressive=True)
    assert writers.phrase != buyers.phrase
    assert "buyers piling in" in buyers.phrase
    assert buyers.tag == "good"      # good for a call buyer


def test_buyers_piling_into_puts_is_bad_for_a_call_buyer():
    v = leg(is_call=False, oi=150_000, oi_open=100_000, buyers_aggressive=True)
    assert "buyers piling in" in v.phrase
    assert v.tag == "bad"


def test_a_ceiling_breaking_is_good_news():
    v = leg(is_call=True, oi=60_000, oi_open=100_000, buyers_aggressive=False)
    assert "ceiling breaking" in v.phrase
    assert v.tag == "good"


def test_a_floor_breaking_is_bad_news():
    v = leg(is_call=False, oi=60_000, oi_open=100_000, buyers_aggressive=False)
    assert "floor breaking" in v.phrase
    assert v.tag == "bad"


def test_buyers_walking_away_from_calls():
    v = leg(is_call=True, oi=60_000, oi_open=100_000, buyers_aggressive=True)
    assert "walking away" in v.phrase
    assert v.tag == "bad"


# -- when it happened ----------------------------------------------------

def test_a_build_that_is_mostly_recent_reads_fast():
    v = leg(oi=150_000, oi_open=100_000, oi_recent=45_000,
            buyers_aggressive=False)
    assert "fast (20m)" in v.phrase


def test_a_build_with_nothing_recent_reads_held_all_day():
    v = leg(oi=150_000, oi_open=100_000, oi_recent=1_000,
            buyers_aggressive=False)
    assert "all day" in v.phrase


def test_a_steady_build_reads_since_open():
    v = leg(oi=150_000, oi_open=100_000, oi_recent=20_000,
            buyers_aggressive=False)
    assert "since open" in v.phrase


def test_age_is_LEFT_OUT_when_we_have_not_watched_long_enough():
    """Twenty minutes after startup we cannot say 'held all day'.

    Saying nothing is honest; guessing is how a screen invents confidence.
    """
    v = leg(oi=150_000, oi_open=100_000, oi_recent=10_000,
            buyers_aggressive=False, trail_seconds=120.0)
    assert "all day" not in v.phrase
    assert "m)" not in v.phrase
    assert "CEILING" in v.phrase


# -- size ----------------------------------------------------------------

def test_the_largest_wall_is_named_biggest():
    v = leg(oi=200_000, oi_open=100_000, biggest_oi=200_000, rank=1,
            buyers_aggressive=False)
    assert v.phrase.startswith("BIGGEST")


def test_the_biggest_wall_is_named_even_when_it_has_not_moved():
    """A wall that has sat there all day is still the wall."""
    v = leg(oi=200_000, oi_open=200_000, biggest_oi=200_000, rank=1)
    assert "BIGGEST" in v.phrase
    assert "holding" in v.phrase


def test_the_bar_scales_with_open_interest():
    small = leg(oi=20_000, biggest_oi=200_000)
    big = leg(oi=200_000, biggest_oi=200_000)
    assert 0 < small.bar < big.bar
    assert big.bar == cv.BAR_BLOCKS


def test_a_leg_with_no_open_interest_gets_no_bar():
    assert leg(oi=0, biggest_oi=200_000).bar == 0


# -- plain language ------------------------------------------------------

@pytest.mark.parametrize("kw", [
    dict(oi=150_000, oi_open=100_000, buyers_aggressive=False),
    dict(oi=150_000, oi_open=100_000, buyers_aggressive=True),
    dict(oi=60_000, oi_open=100_000, buyers_aggressive=False),
    dict(ticked=False),
    dict(live=False),
    dict(),
])
def test_no_jargon_and_no_bare_numbers_in_any_phrase(kw):
    """Simple English, as asked. No greek letters, no ratios, no raw counts.

    Matched on whole words - a substring check fails on "live" containing "iv",
    which is the sort of false alarm that gets a test deleted rather than fixed.
    """
    import re
    text = leg(**kw).phrase.lower()
    words = set(re.findall(r"[a-z%]+", text))
    for banned in ("delta", "gamma", "theta", "vega", "iv", "pcr", "oi",
                   "sigma", "%"):
        assert banned not in words, f"{banned!r} in {text!r}"
    # The only digits allowed are a duration, as in "last 20 min".
    digits = re.findall(r"\d+", text)
    assert not digits or "min" in text, f"a bare number in {text!r}"
    assert len(text) <= cv.MAX_PHRASE,         f"too long, breaks the grid: {text!r} ({len(text)} chars)"


def test_every_phrase_carries_a_colour():
    for kw in (dict(), dict(ticked=False), dict(live=False),
               dict(oi=150_000, oi_open=100_000, buyers_aggressive=False)):
        assert leg(**kw).tag in ("good", "bad", "warn", "dim", "plain")


# -- the one-line summary ------------------------------------------------

def _row(strike, call_phrase, put_phrase, call_oi=0, put_oi=0):
    return cv.StrikeView(
        strike=strike,
        call=LegView(phrase=call_phrase, oi=call_oi),
        put=LegView(phrase=put_phrase, oi=put_oi))


def test_the_summary_names_the_ceiling_and_the_floor():
    rows = [
        _row(23000.0, "quiet", "BIGGEST FLOOR - held all day", put_oi=200_000),
        _row(23200.0, "BIGGEST CEILING - held all day", "quiet", call_oi=190_000),
    ]
    line = cv.summary_line(rows, 23_075.0)
    assert "ceiling 23,200" in line
    assert "floor 23,000" in line


def test_the_summary_flags_anything_new():
    rows = [
        _row(23000.0, "quiet", "FLOOR - held all day", put_oi=200_000),
        _row(23100.0, "CEILING - fast, last 20 min", "quiet", call_oi=100_000),
    ]
    assert "NEW" in cv.summary_line(rows, 23_075.0)


def test_the_summary_says_so_when_there_is_no_wall():
    rows = [_row(23000.0, "quiet", "quiet")]
    assert "no clear" in cv.summary_line(rows, 23_075.0)


def test_the_summary_handles_an_empty_chain():
    assert "waiting" in cv.summary_line([], 0.0)


# -- we never claim to know WHO when we do not --------------------------

def test_an_unmeasured_build_states_the_fact_and_stops():
    """The flaw found when this first ran against real ticks.

    With no flow state, every row said CEILING or FLOOR - which is precisely the
    price-inferred guess we decline to inherit from Dhan, in our own words. When
    the aggressor is unknown the phrase must report what happened, not who.
    """
    v = leg(is_call=True, oi=150_000, oi_open=100_000, buyers_aggressive=None)
    assert "more calls here" in v.phrase
    assert "CEILING" not in v.phrase.upper()
    assert v.tag == "warn"


def test_an_unmeasured_unwind_states_the_fact_too():
    v = leg(is_call=False, oi=60_000, oi_open=100_000, buyers_aggressive=None)
    assert "puts closing out" in v.phrase
    assert "FLOOR" not in v.phrase.upper()


def test_a_MEASURED_writer_build_still_says_ceiling():
    """The measured case keeps the strong word - that is what it is for."""
    v = leg(is_call=True, oi=150_000, oi_open=100_000, buyers_aggressive=False)
    assert "CEILING" in v.phrase
    assert v.tag == "bad"


def test_the_three_cases_are_all_different():
    """Measured writers, measured buyers, and unknown must never look alike."""
    args = dict(is_call=True, oi=150_000, oi_open=100_000)
    writers = leg(**args, buyers_aggressive=False).phrase
    buyers = leg(**args, buyers_aggressive=True).phrase
    unknown = leg(**args, buyers_aggressive=None).phrase
    assert len({writers, buyers, unknown}) == 3


# -- hiding strikes with nothing on them --------------------------------

class _FakeChain:
    """Enough of a chain to exercise build_rows without a feed."""

    def __init__(self, strikes, live_map, atm):
        import numpy as _np
        self.cap = type("C", (), {"strike_step": 50.0})()
        self.instrument = "nifty50"
        n = len(strikes) * 2
        self.strike = _np.array([k for k in strikes for _ in (0, 1)], dtype=float)
        self.is_call = _np.array([f for _ in strikes for f in (True, False)])
        self.expiry = _np.array(["2026-10-06"] * n, dtype="U10")
        self.security_id = _np.arange(1000, 1000 + n, dtype=_np.int64)
        self.oi = _np.full(n, 1000, dtype=_np.int64)
        self.oi_open = _np.full(n, 1000, dtype=_np.int64)
        self.oi_change = _np.zeros(n, dtype=_np.int64)
        self.ltp = _np.full(n, 10.0)
        self.day_open = _np.full(n, 10.0)
        self.prev_close = _np.full(n, 10.0)
        self._atm = atm
        self.reference = float(atm)
        self.price_source = _np.array(
            [live_map.get((k, f), True) for k in strikes for f in (True, False)])
        self.tick_count = _np.array(
            [1 if live_map.get((k, f), True) is not None else 0
             for k in strikes for f in (True, False)], dtype=_np.int64)

    def summary(self, expiry, now=None):
        return type("S", (), {"atm_strike": self._atm})()

    def oi_change_over(self, minutes, now=None):
        import numpy as _np
        return _np.zeros(len(self.strike), dtype=_np.int64)

    def oi_trail_span(self, now=None):
        return 7200.0


def test_a_strike_dead_on_both_sides_is_hidden():
    ch = _FakeChain([23000.0, 23050.0, 23100.0],
                    {(23050.0, True): False, (23050.0, False): False},
                    atm=23100.0)
    rows = cv.build_rows(ch, "2026-10-06")
    assert [r.strike for r in rows] == [23000.0, 23100.0]


def test_a_strike_with_ONE_live_side_is_kept():
    """The far wings are exactly where one side trades and the other does not.

    Hiding the row would throw away the live side.
    """
    ch = _FakeChain([23000.0, 23050.0],
                    {(23050.0, True): False},      # call dead, put live
                    atm=23000.0)
    rows = cv.build_rows(ch, "2026-10-06")
    assert 23050.0 in [r.strike for r in rows]


def test_the_at_the_money_row_is_never_hidden():
    """Losing your place on the ladder is worse than one empty line."""
    ch = _FakeChain([23000.0, 23100.0],
                    {(23100.0, True): False, (23100.0, False): False},
                    atm=23100.0)
    rows = cv.build_rows(ch, "2026-10-06")
    assert 23100.0 in [r.strike for r in rows]


def test_hiding_can_be_turned_off():
    ch = _FakeChain([23000.0, 23050.0],
                    {(23050.0, True): False, (23050.0, False): False},
                    atm=23000.0)
    assert len(cv.build_rows(ch, "2026-10-06", hide_dead=False)) == 2


def test_the_screen_can_say_how_many_were_hidden():
    """Filtering silently is the same fault as a blank that means zero -
    the reader cannot tell 'nothing there' from 'we did not show you'."""
    ch = _FakeChain([23000.0, 23050.0, 23150.0],
                    {(23050.0, True): False, (23050.0, False): False,
                     (23150.0, True): False, (23150.0, False): False},
                    atm=23000.0)
    rows = cv.build_rows(ch, "2026-10-06")
    assert cv.hidden_count(ch, "2026-10-06", rows) == 2


# -- the levels that matter ----------------------------------------------
#
# Partha 2026-09-29: "5 S/R levels to be marked".


class _LevelChain(_FakeChain):
    """A chain with open interest placed deliberately, to rank levels."""

    def __init__(self, oi_by_leg, spot, recent=None):
        strikes = sorted({k for k, _ in oi_by_leg})
        super().__init__(strikes, {}, atm=spot)
        import numpy as _np
        self.reference = float(spot)
        for i in range(len(self.strike)):
            key = (float(self.strike[i]), bool(self.is_call[i]))
            self.oi[i] = oi_by_leg.get(key, 0)
        self.oi_open = self.oi.copy()
        self._recent = recent or {}

    def oi_change_over(self, minutes, now=None):
        import numpy as _np
        out = _np.zeros(len(self.strike), dtype=_np.int64)
        for i in range(len(self.strike)):
            key = (float(self.strike[i]), bool(self.is_call[i]))
            out[i] = self._recent.get(key, 0)
        return out


def test_resistance_is_call_open_interest_above_spot():
    ch = _LevelChain({(23_200.0, True): 900, (22_800.0, False): 800}, spot=23_000.0)
    levels = cv.key_levels(ch, "2026-10-06")
    kinds = {lv.strike: lv.kind for lv in levels}
    assert kinds[23_200.0] == "R"
    assert kinds[22_800.0] == "S"


def test_a_call_wall_BELOW_price_is_not_resistance_any_more():
    """It has already been broken. Ranking by size alone gets this wrong, and it
    is exactly the sort of level a trader would act on backwards."""
    ch = _LevelChain({(22_500.0, True): 5_000, (23_200.0, True): 100},
                     spot=23_000.0)
    assert 22_500.0 not in [lv.strike for lv in cv.key_levels(ch, "2026-10-06")]


def test_levels_are_ranked_by_how_near_they_are_within_each_side():
    """R1 is the nearest strong ceiling, not whichever happened to be biggest."""
    ch = _LevelChain({(23_100.0, True): 500, (23_400.0, True): 900},
                     spot=23_000.0)
    ranks = {lv.strike: lv.label for lv in cv.key_levels(ch, "2026-10-06")}
    assert ranks[23_100.0] == "R1"
    assert ranks[23_400.0] == "R2"


def test_no_more_than_five_levels_are_marked():
    oi = {(23_000.0 + 50 * i, True): 1_000 + i for i in range(1, 12)}
    ch = _LevelChain(oi, spot=23_000.0)
    assert len(cv.key_levels(ch, "2026-10-06")) <= cv.LEVELS_SHOWN


def test_a_level_built_in_the_last_twenty_minutes_is_flagged_new():
    """A wall thrown up in fifteen minutes and one standing since the open are
    not the same thing - which is the whole reason we keep a trail."""
    ch = _LevelChain({(23_200.0, True): 1_000}, spot=23_000.0,
                     recent={(23_200.0, True): 900})
    ch.oi_open[:] = 100
    assert cv.key_levels(ch, "2026-10-06")[0].note == "new"


def test_a_level_standing_since_the_open_is_not_flagged_new():
    ch = _LevelChain({(23_200.0, True): 1_000}, spot=23_000.0,
                     recent={(23_200.0, True): 10})
    ch.oi_open[:] = 100
    assert cv.key_levels(ch, "2026-10-06")[0].note == ""


def test_a_strike_that_never_traded_is_not_a_level():
    ch = _LevelChain({(23_200.0, True): 9_000}, spot=23_000.0)
    ch.tick_count[:] = 0
    assert cv.key_levels(ch, "2026-10-06") == []


# -- who is taking control -----------------------------------------------
#
# Partha 2026-09-29: "who is taking the control, such as seller/buyer".


class _Print:
    def __init__(self, price):
        self.price = price


class _Flow:
    """Just enough flow state for control_status."""

    def __init__(self, buy_share, prices=()):
        self.prints = [_Print(p) for p in prices] or [_Print(100.0)]
        self._buy = buy_share
        self._prices = list(prices)

    def aggression(self, _seconds):
        return {"total_qty": 1_000, "buy_share": self._buy,
                "sell_share": 1.0 - self._buy}

    def _in(self, _seconds):
        return [_Print(p) for p in self._prices]


def test_control_is_not_claimed_from_nothing():
    ch = _LevelChain({(23_000.0, True): 100}, spot=23_000.0)
    c = cv.control_status(ch, "2026-10-06", flow={}, futures_ids=())
    assert c.side == "NOBODY"
    assert c.total == 0
    assert c.phrase == "nobody in control"


def test_buyers_crossing_the_spread_with_price_up_is_buyers_in_control():
    ch = _LevelChain({(23_000.0, True): 100}, spot=23_000.0)
    flow = {7: _Flow(0.72, prices=[100, 101, 102, 103, 104])}
    c = cv.control_status(ch, "2026-10-06", flow=flow, futures_ids=(7,))
    assert c.side == "BUYERS"
    assert any("crossing" in r for r in c.reasons)


def test_sellers_crossing_the_spread_with_price_down_is_sellers_in_control():
    ch = _LevelChain({(23_000.0, True): 100}, spot=23_000.0)
    flow = {7: _Flow(0.28, prices=[104, 103, 102, 101, 100])}
    c = cv.control_status(ch, "2026-10-06", flow=flow, futures_ids=(7,))
    assert c.side == "SELLERS"


def test_control_needs_a_MAJORITY_not_one_signal():
    """One out of three is noise wearing a label."""
    ch = _LevelChain({(23_000.0, True): 100}, spot=23_000.0)
    # tape says buyers; price is going nowhere; writers are even -> no majority
    flow = {7: _Flow(0.72, prices=[100, 101, 100, 101, 100])}
    c = cv.control_status(ch, "2026-10-06", flow=flow, futures_ids=(7,))
    assert c.side == "NOBODY"
    assert c.total >= 2


def test_the_reasons_are_returned_so_the_claim_can_be_checked():
    ch = _LevelChain({(23_000.0, True): 100}, spot=23_000.0)
    flow = {7: _Flow(0.72, prices=[100, 101, 102, 103, 104])}
    c = cv.control_status(ch, "2026-10-06", flow=flow, futures_ids=(7,))
    assert c.reasons
    assert all(isinstance(r, str) and r for r in c.reasons)


def test_strength_says_how_one_sided_the_evidence_was():
    ch = _LevelChain({(23_000.0, True): 100}, spot=23_000.0)
    flow = {7: _Flow(0.95, prices=[100, 102, 104, 106, 108])}
    c = cv.control_status(ch, "2026-10-06", flow=flow, futures_ids=(7,))
    assert c.strength == 100
    assert "firmly" in c.phrase
