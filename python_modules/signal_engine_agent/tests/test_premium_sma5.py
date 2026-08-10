"""Tests for the SMA5 entry-gate premium confirmer (`engine._PremiumSma5`)."""
from __future__ import annotations

from signal_engine_agent.engine import _PremiumSma5


def _feed(det, prices):
    """One candle per minute (two ticks each) + a flush, like the detector tests."""
    for m, p in enumerate(prices):
        det.on_tick(m * 60 + 0.0, p)
        det.on_tick(m * 60 + 40.0, p)
    det.on_tick(len(prices) * 60 + 0.0, prices[-1])


def test_warmup_confirms_true():
    """Before the SMA5 is ready, the gate must not block (confirms → True)."""
    det = _PremiumSma5()
    det.on_tick(0.0, 100.0)
    assert det.confirms(50.0) is True  # no SMA yet → don't block


def test_rising_premium_confirms():
    """A premium above its own SMA5 confirms the entry."""
    det = _PremiumSma5()
    _feed(det, [100, 101, 102, 103, 104, 105])
    assert det.confirms(106.0) is True   # well above the SMA
    assert det.confirms(90.0) is False   # below the SMA → not confirmed


def test_falling_premium_below_sma_not_confirmed():
    """A premium sitting below its SMA5 (fading) does NOT confirm."""
    det = _PremiumSma5()
    _feed(det, [110, 108, 106, 104, 102, 100])
    # latest price 99 is below the 5-SMA of a falling series → blocked
    assert det.confirms(99.0) is False


def test_ignores_nonfinite():
    det = _PremiumSma5()
    _feed(det, [100, 101, 102, 103, 104])
    det.on_tick(float("nan"), 200.0)   # ignored, no crash
    assert det.confirms(float("inf")) is True  # bad price → don't block
