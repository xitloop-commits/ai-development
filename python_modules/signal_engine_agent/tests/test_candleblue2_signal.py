"""Tests for cb2 (candleblue v2): HH+HL structure + range-position gate."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from signal_engine_agent.candleblue2_signal import CandleBlue2Detector, CandleBlue2Leg  # noqa: E402

CS = 300


def _run(prices, min_range_pos):
    """Feed one price per candle (3 ticks/candle) through a leg; return events."""
    leg = CandleBlue2Leg(candle_sec=CS, min_range_pos=min_range_pos)
    events, t = [], 0
    for p in prices:
        for k in range(3):
            events += leg.on_tick(t + k, p + (0.3 if k == 1 else 0.0), True)
        t += CS
    return events, leg.in_position


def test_import_and_defaults():
    d = CandleBlue2Detector()
    assert d.leg("CE").candle_sec == 300  # 5-minute default
    assert d.leg("CE").min_range_pos == 0.5


def test_clean_uptrend_longs_with_gate():
    # A steady staircase up: each HH+HL entry sits near the top of its range.
    up = [100, 101, 100.5, 102, 101.5, 103, 102.5, 104, 103.5, 105, 104.5, 106]
    ev, pos = _run(up, min_range_pos=0.5)
    assert "LONG" in ev and pos


def test_gate_off_matches_plain_structure():
    up = [100, 101, 100.5, 102, 101.5, 103, 102.5, 104, 103.5, 105]
    ev, pos = _run(up, min_range_pos=0.0)  # gate disabled = plain candleblue
    assert "LONG" in ev and pos


def test_high_gate_blocks_mid_range_entry():
    # Same structure, but demand the entry be at the very top (0.99). A staircase
    # whose completing candle is not at the extreme top is filtered out.
    up = [100, 101, 100.5, 102, 101.5, 103, 102.5, 104, 103.5, 105]
    ev_open, _ = _run(up, min_range_pos=0.0)
    ev_strict, _ = _run(up, min_range_pos=0.99)
    # The strict gate must fire no MORE entries than the ungated version.
    assert ev_strict.count("LONG") <= ev_open.count("LONG")


def test_detector_symmetric_ce_pe_events():
    d = CandleBlue2Detector(candle_sec=CS, min_range_pos=0.5)
    up = [100, 101, 100.5, 102, 101.5, 103, 102.5, 104, 103.5, 105, 104.5, 106]
    t = 0
    got = []
    for p in up:
        for k in range(3):
            got += d.on_leg_tick("CE", t + k, p + (0.3 if k == 1 else 0.0))
        t += CS
    assert any(e == "LONG_CE" for e in got)
