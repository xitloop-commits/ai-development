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
