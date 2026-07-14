"""
Tests for the MA-Signal detector (`ma_signal.MASignalDetector`).

Segments the underlying by the slope of its 20-EMA and fires LONG_CE / LONG_PE
at a trend leg's start and EXIT_CE / EXIT_PE at its end, with sticky hysteresis
so a real trend holds through minor pauses.
"""
from __future__ import annotations

from signal_engine_agent.ma_signal import MASignalDetector
from signal_engine_agent.thresholds import MASignalThresholds


def _det(**kw) -> MASignalDetector:
    return MASignalDetector(MASignalThresholds(**kw))


def _run(det, closes):
    """Feed one candle per minute (a couple of ticks each). The first tick of a
    new minute closes the prior candle, so a final flush tick closes the last."""
    fires = []
    for m, c in enumerate(closes):
        fires.extend(det.on_tick(m * 60 + 0.0, c))
        det.on_tick(m * 60 + 40.0, c)
    fires.extend(det.on_tick(len(closes) * 60 + 0.0, closes[-1]))
    return fires


def test_no_event_during_warmup():
    """Fewer candles than the slope lookback needs → never fires."""
    assert _run(_det(), [1000 + i * 10 for i in range(5)]) == []


def test_up_leg_fires_call_once():
    """A clean, unbroken uptrend fires exactly one CALL (sticky holds the rest)."""
    assert _run(_det(), [1000 + i * 10 for i in range(16)]) == ["LONG_CE"]


def test_down_leg_fires_put_once():
    """A clean downtrend fires exactly one PUT."""
    assert _run(_det(), [2000 - i * 10 for i in range(16)]) == ["LONG_PE"]


def test_flat_no_event():
    """A dead-flat line stays FLAT → no signal."""
    assert _run(_det(), [1000.0] * 16) == []


def test_sticky_holds_through_pause():
    """A brief pause inside a strong uptrend must NOT exit/re-enter — the whole
    move stays one leg (this is the fix for the fragmentation Partha spotted)."""
    rise = [1000 + i * 10 for i in range(15)]
    pause = [rise[-1]] * 2
    rise2 = [rise[-1] + (i + 1) * 10 for i in range(8)]
    assert _run(_det(), rise + pause + rise2) == ["LONG_CE"]


def test_leg_end_exits_and_flips():
    """When an up-leg rolls over into a down-leg, it exits the CE and enters PE."""
    up = [1000 + i * 10 for i in range(15)]
    down = [up[-1] - (i + 1) * 12 for i in range(15)]
    fires = _run(_det(), up + down)
    assert "LONG_CE" in fires and "EXIT_CE" in fires and "LONG_PE" in fires
