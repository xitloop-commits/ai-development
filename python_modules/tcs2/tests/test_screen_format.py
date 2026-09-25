"""TCS2 - tests for the screen's formatters.

Spec: docs/systems/14_tcs2.md  D17, D38

Formatters are module-level functions precisely so they can be tested without a
display. The rule they exist to enforce is D38's: a value we decline to compute
must render as BLANK, never as 0, because a printed 0 for an unanswerable implied
vol reads as a cheap option rather than an unanswerable one.
"""
from __future__ import annotations

import pytest

from tcs2.screen import STATUS_COLOUR, fmt_age, fmt_num, fmt_oi, fmt_signed
from tcs2.health import DEAD, IDLE, LATE, OK


# -- the D38 rule --------------------------------------------------------

def test_nan_renders_blank_not_zero():
    """195 of 1,484 legs on a test chain carry no volatility information."""
    assert fmt_num(float("nan")) == ""


def test_zero_renders_blank_by_default():
    """An untraded leg has no price; 0.00 would imply it is worth nothing."""
    assert fmt_num(0.0) == ""


def test_zero_can_be_shown_when_it_is_a_real_measurement():
    assert fmt_num(0.0, blank_zero=False) == "0.00"


def test_none_renders_blank():
    assert fmt_num(None) == ""


def test_a_real_number_renders_with_thousands_separators():
    assert fmt_num(23476.25) == "23,476.25"
    assert fmt_num(12.2626) == "12.26"
    assert fmt_num(0.4973, 3) == "0.497"


def test_a_non_numeric_value_does_not_crash_the_repaint():
    """A repaint must never be the thing that takes the process down."""
    assert fmt_num("oops") == ""            # type: ignore[arg-type]


# -- open interest -------------------------------------------------------

def test_large_oi_uses_lakhs():
    assert fmt_oi(19_970_000) == "199.7L"
    assert fmt_oi(1_241_000) == "12.4L"


def test_small_oi_stays_exact():
    assert fmt_oi(96_265) == "96,265"


def test_zero_oi_is_blank():
    assert fmt_oi(0) == ""
    assert fmt_oi(None) == ""


def test_oi_change_carries_its_sign():
    assert fmt_signed(120_000) == "+1.2L"
    assert fmt_signed(-73_645) == "-73,645"
    assert fmt_signed(0) == ""


# -- ages ----------------------------------------------------------------

def test_a_thread_that_never_beat_says_never_not_zero():
    """Zero seconds would read as 'just beaten' - the opposite of the truth."""
    assert fmt_age(float("inf")) == "never"


@pytest.mark.parametrize("seconds,expected", [
    (0.3, "0.3s"), (59.0, "59.0s"), (90.0, "2m"), (9000.0, "2.5h"),
])
def test_ages_read_at_a_glance(seconds, expected):
    assert fmt_age(seconds) == expected


# -- the health colours --------------------------------------------------

def test_every_status_has_a_colour():
    """A status with no colour would render as a blank dot - the worst outcome."""
    for status in (OK, IDLE, LATE, DEAD):
        assert status in STATUS_COLOUR


def test_ok_and_dead_are_not_the_same_colour():
    assert STATUS_COLOUR[OK] != STATUS_COLOUR[DEAD]
    assert STATUS_COLOUR[LATE] != STATUS_COLOUR[OK]


# -- colour: positive readings in green, with their label ---------------

from tcs2.screen import point_rows, value_tag, verdict_tag
from tcs2.analysis import Point


def test_a_positive_number_is_green():
    """Partha, 2026-09-25: positive values in green, with the label."""
    assert value_tag(64.0) == "good"
    assert value_tag(1) == "good"


def test_a_negative_number_is_red():
    assert value_tag(-73_645) == "bad"
    assert value_tag(-0.5) == "bad"


def test_exactly_zero_is_neither():
    """Zero is a real measurement, not good news and not bad."""
    assert value_tag(0) == "plain"
    assert value_tag(0.0) == "plain"


def test_a_missing_reading_is_dim_never_green():
    """'No answer' must not look like good news - nor like bad news."""
    assert value_tag(None) == "dim"
    assert value_tag(float("nan")) == "dim"


@pytest.mark.parametrize("word", ["UP", "CONFIRMED", "STRONG", "GOOD", "READY",
                                  "CONTINUATION", "TRADE"])
def test_good_states_are_green(word):
    assert value_tag(word) == "good"


@pytest.mark.parametrize("word", ["DOWN", "FALSE", "POOR", "REVERSAL",
                                  "BUYERS_ABSORBED", "SELLERS_ABSORBED"])
def test_bad_states_are_red(word):
    assert value_tag(word) == "bad"


@pytest.mark.parametrize("word", ["FLAT", "SUSPECT", "WEAKENING", "NEUTRAL",
                                  "NONE", "BUILDING"])
def test_in_between_states_are_amber(word):
    assert value_tag(word) == "warn"


def test_state_matching_ignores_case_and_spacing():
    assert value_tag("up") == "good"
    assert value_tag("buyers absorbed") == "bad"


def test_no_trade_is_amber_not_red():
    """A NO TRADE verdict is not a failure - most of the day should be one."""
    assert verdict_tag("NO_TRADE") == "warn"
    assert verdict_tag("TRADE") == "good"
    assert verdict_tag(None) == "dim"


def test_a_true_flag_warns_rather_than_celebrates():
    """Exhaustion or absorption being True is a caution, not a win."""
    assert value_tag(True) == "warn"
    assert value_tag(False) == "dim"


# -- the rows the panel paints ------------------------------------------

def test_point_rows_carry_a_tag_per_point():
    pts = {
        1: Point(1, "direction", "UP", 80.0),
        2: Point(2, "momentum", -12.5, 40.0),
        3: Point(3, "buyer_activity", 64.0, 64.0),
        4: Point(4, "seller_activity", None, None, note="no futures flow"),
    }
    rows = {n: (line, tag) for n, line, tag in point_rows(pts)}
    assert rows[1][1] == "good"
    assert rows[2][1] == "bad"
    assert rows[3][1] == "good"
    assert rows[4][1] == "dim"


def test_a_missing_point_prints_its_reason_not_a_zero():
    pts = {9: Point(9, "support", None, None, note="no level found")}
    _n, line, tag = point_rows(pts)[0]
    assert "no level found" in line
    assert "0" not in line.split("support")[1].split("no level")[0]
    assert tag == "dim"


def test_every_point_present_gets_a_row():
    pts = {n: Point(n, f"p{n}", 1.0, 50.0) for n in range(1, 26)}
    assert len(point_rows(pts)) == 25


def test_a_label_and_its_value_share_the_line():
    """'along with the label' - the name and the value are coloured together."""
    pts = {1: Point(1, "direction", "UP", 80.0)}
    _n, line, tag = point_rows(pts)[0]
    assert "direction" in line and "UP" in line
    assert tag == "good"
