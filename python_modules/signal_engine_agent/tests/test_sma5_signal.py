"""
Tests for the SMA-5 price-cross detector (`sma5_signal.Sma5SignalDetector`).

Fires LONG_CE when the 1-min close crosses ABOVE the 5-period SMA and LONG_PE
when it crosses BELOW; a flip emits the opposite side's EXIT_* first (symmetric).
"""
from __future__ import annotations

from signal_engine_agent.sma5_signal import Sma5SignalDetector
from signal_engine_agent.thresholds import Sma5SignalThresholds


def _det(**kw) -> Sma5SignalDetector:
    return Sma5SignalDetector(Sma5SignalThresholds(**kw))


def _run(det, closes):
    """Feed one candle per minute (a couple of ticks each). The first tick of a
    new minute closes the prior candle; a final flush tick closes the last."""
    fires = []
    for m, c in enumerate(closes):
        fires.extend(det.on_tick(m * 60 + 0.0, c))
        det.on_tick(m * 60 + 40.0, c)
    fires.extend(det.on_tick(len(closes) * 60 + 0.0, closes[-1]))
    return fires


def test_no_event_during_warmup():
    """Fewer closes than the SMA period → never fires."""
    assert _run(_det(use_ha=False), [1000, 1010, 1020, 1030]) == []


def test_cross_above_fires_call_once():
    """A clean rising series crosses above the SMA-5 and fires ONE call."""
    assert _run(_det(use_ha=False), [1000, 1010, 1020, 1030, 1040, 1050]) == ["LONG_CE"]


def test_cross_below_fires_put_and_exits_call():
    """Rise (CALL) then a drop below the line → EXIT_CE + LONG_PE (symmetric)."""
    closes = [1000, 1010, 1020, 1030, 1040, 1050, 900]
    assert _run(_det(use_ha=False), closes) == ["LONG_CE", "EXIT_CE", "LONG_PE"]


def test_flip_back_above_exits_put_and_re_enters_call():
    """A down leg then a fresh push above the line flips PE→CE."""
    closes = [1000, 990, 980, 970, 960, 950, 1100]
    fires = _run(_det(use_ha=False), closes)
    assert fires[:1] == ["LONG_PE"]
    assert fires[-2:] == ["EXIT_PE", "LONG_CE"]


def test_buffer_deadband_suppresses_marginal_cross():
    """With a buffer, a close only just above the line does NOT flip."""
    # Flat-ish series so the close sits a hair above the SMA; 5% buffer swallows it.
    closes = [1000, 1000, 1000, 1000, 1000, 1001]
    assert _run(_det(buffer_pct=5.0, use_ha=False), closes) == []


def test_ha_mode_fires_on_clean_uptrend():
    """Heikin-Ashi mode still fires a call on a clean rising series (path works)."""
    assert _run(_det(use_ha=True), [1000 + i * 10 for i in range(8)]) == ["LONG_CE"]


def test_ha_mode_symmetric_put_on_downtrend():
    assert _run(_det(use_ha=True), [1000 - i * 10 for i in range(8)]) == ["LONG_PE"]
