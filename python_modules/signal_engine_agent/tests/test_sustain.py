"""Tests for sustain.py — Wave 1 sustained-tick filter."""

from __future__ import annotations

import pytest

from signal_engine_agent.sustain import SustainFilter


def test_emits_when_last_n_match():
    sus = SustainFilter(window_n=3)
    assert sus.observe("LONG_CE") == "WAIT"  # only 1 in window
    assert sus.observe("LONG_CE") == "WAIT"  # only 2 in window
    # 3 consecutive same — confirmed
    assert sus.observe("LONG_CE") == "LONG_CE"


def test_breaks_on_action_change():
    sus = SustainFilter(window_n=3)
    sus.observe("LONG_CE")
    sus.observe("LONG_CE")
    sus.observe("LONG_PE")  # break
    assert sus.observe("LONG_PE") == "WAIT"  # only 2 PEs so far
    assert sus.observe("LONG_PE") == "LONG_PE"  # 3 PEs


def test_breaks_on_wait():
    sus = SustainFilter(window_n=3)
    sus.observe("LONG_CE")
    sus.observe("LONG_CE")
    sus.observe("WAIT")  # break
    assert sus.observe("LONG_CE") == "WAIT"  # WAIT contaminated window
    sus.observe("LONG_CE")
    assert sus.observe("LONG_CE") == "LONG_CE"  # window now clean


def test_returns_wait_during_warmup():
    sus = SustainFilter(window_n=10)
    for _ in range(9):
        assert sus.observe("LONG_CE") == "WAIT"
    assert sus.observe("LONG_CE") == "LONG_CE"


def test_observe_none_treated_as_wait():
    sus = SustainFilter(window_n=2)
    sus.observe(None)
    assert sus.observe("LONG_CE") == "WAIT"  # None contaminated window


def test_reset_clears_history():
    sus = SustainFilter(window_n=3)
    sus.observe("LONG_CE")
    sus.observe("LONG_CE")
    sus.observe("LONG_CE")  # would emit
    sus.reset()
    assert sus.observe("LONG_CE") == "WAIT"  # back to warmup


def test_window_n_invalid():
    with pytest.raises(ValueError):
        SustainFilter(window_n=0)
    with pytest.raises(ValueError):
        SustainFilter(window_n=-1)


def test_n_equals_one_emits_immediately():
    sus = SustainFilter(window_n=1)
    assert sus.observe("LONG_CE") == "LONG_CE"
    assert sus.observe("WAIT") == "WAIT"
    assert sus.observe("LONG_PE") == "LONG_PE"
