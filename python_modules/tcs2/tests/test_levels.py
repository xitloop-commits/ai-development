"""TCS2 - tests for touch and rejection counting.

Partha 2026-09-29: "how many time S/R level reached / rejected".

The whole value of the count is that it separates a level price has tested from
one it has never gone near. So the tests are mostly about NOT counting: jitter on
a level is one touch, not forty, and a level price never approached has none.
"""
from __future__ import annotations

from tcs2.levels import LevelTracker


def feed(prices, step=100.0):
    t = LevelTracker(step)
    for n, px in enumerate(prices):
        t.on_price(px, float(n))
    return t


# -- counting a touch ---------------------------------------------------

def test_a_level_never_approached_has_no_count():
    t = feed([23_450.0, 23_460.0, 23_455.0])
    assert t.at(23_500.0).touches == 0
    assert t.at(23_500.0).rejections == 0


def test_reaching_a_level_counts_one_touch():
    t = feed([23_450.0, 23_500.0])
    assert t.at(23_500.0).touches == 1


def test_sitting_on_a_level_and_jittering_is_still_ONE_touch():
    """If leaving used the same threshold as arriving, a price resting on a level
    and moving one tick would register dozens of touches - the count would measure
    the jitter, not the market."""
    prices = [23_450.0] + [23_500.0 + (1 if i % 2 else -1) for i in range(40)]
    assert feed(prices).at(23_500.0).touches == 1


def test_coming_back_a_second_time_counts_a_second_touch():
    t = feed([23_450.0, 23_500.0, 23_400.0, 23_500.0])
    assert t.at(23_500.0).touches == 2


# -- rejection or break -------------------------------------------------

def test_leaving_on_the_side_it_came_from_is_a_rejection():
    """Approached from below and pushed back down: the level held."""
    t = feed([23_400.0, 23_500.0, 23_400.0])
    st = t.at(23_500.0)
    assert (st.touches, st.rejections, st.breaks) == (1, 1, 0)


def test_going_through_is_a_break_not_a_rejection():
    t = feed([23_400.0, 23_500.0, 23_600.0])
    st = t.at(23_500.0)
    assert (st.touches, st.rejections, st.breaks) == (1, 0, 1)


def test_a_level_approached_from_above_and_pushed_back_up_also_held():
    """Support works the same way, mirrored - the tracker knows nothing about
    which side of spot a strike is on, and does not need to."""
    t = feed([23_600.0, 23_500.0, 23_600.0])
    st = t.at(23_500.0)
    assert (st.touches, st.rejections, st.breaks) == (1, 1, 0)


def test_three_rejections_and_one_break_are_all_counted():
    t = feed([23_400, 23_500, 23_400, 23_500, 23_400, 23_500,
              23_400, 23_500, 23_600])
    st = t.at(23_500.0)
    assert st.touches == 4
    assert st.rejections == 3
    assert st.breaks == 1


def test_a_level_still_being_tested_is_not_yet_counted_either_way():
    """While price is still sitting on the level, the outcome is unknown - and
    guessing it would be the one thing worse than not knowing."""
    t = feed([23_400.0, 23_500.0])
    st = t.at(23_500.0)
    assert st.touches == 1
    assert (st.rejections, st.breaks) == (0, 0)


# -- the words ----------------------------------------------------------

def test_an_untested_level_says_so_rather_than_showing_a_zero():
    t = feed([23_400.0])
    assert t.at(23_500.0).held == ""


def test_the_words_report_what_happened():
    t = feed([23_400, 23_500, 23_400, 23_500, 23_600])
    words = t.at(23_500.0).held
    assert "2x hit" in words
    assert "1 held" in words
    assert "1 broke" in words


def test_a_level_being_tested_right_now_says_so():
    assert "now" in feed([23_400.0, 23_500.0]).at(23_500.0).held


# -- the grid -----------------------------------------------------------

def test_the_step_decides_which_strikes_exist():
    """A 50-point grid and a 100-point grid do not have the same levels."""
    t = feed([23_400.0, 23_450.0], step=50.0)
    assert t.at(23_450.0).touches == 1
    assert feed([23_400.0, 23_450.0], step=100.0).at(23_450.0).touches == 0


def test_a_missing_step_does_not_crash_the_tracker():
    t = LevelTracker(0.0)
    t.on_price(23_500.0, 1.0)
    assert t.tested()


def test_a_zero_price_is_ignored():
    t = LevelTracker(100.0)
    t.on_price(0.0, 1.0)
    t.on_price(-5.0, 2.0)
    assert t.tested() == {}


def test_only_strikes_that_were_visited_are_reported():
    t = feed([23_400.0, 23_500.0])
    assert set(t.tested()) == {23_400.0, 23_500.0}
