"""
Tests for the leg-start gate (`leg_start.LegStartDetector`).

The detector aggregates spot ticks into 1-min Heikin-Ashi candles, tracks a
21-EMA trend line, and fires ONE trend-aligned signal per leg:
  CALL  — 2 green candles + higher-low + model up-prob >= dir_ce + rising trend
  PUT   — 3 red candles + fresh lower-low + model down-conv + falling trend
with a one-per-leg lock until the leg breaks.
"""
from __future__ import annotations

from signal_engine_agent.leg_start import LegStartDetector
from signal_engine_agent.thresholds import LegStartThresholds


def _det(**kw) -> LegStartDetector:
    return LegStartDetector(LegStartThresholds(**kw))


def _push(det, minute, o, h, l, c, dirp):
    """Feed one minute of ticks (o→h→l→c). The FIRST tick of the minute closes
    the PREVIOUS candle, so the fire (if any) for candle m-1 is returned here."""
    fired = det.on_tick(minute * 60 + 0.0, o, dirp)
    det.on_tick(minute * 60 + 20.0, h, dirp)
    det.on_tick(minute * 60 + 40.0, l, dirp)
    det.on_tick(minute * 60 + 55.0, c, dirp)
    return fired


def _run_trend(det, rising: bool, n: int, dirp: float):
    """Feed n steadily rising (or falling) candles; return list of fires."""
    fires = []
    for m in range(n):
        step = m if rising else -m
        base = 100.0 + step * 3.0
        # green-ish rising / red-ish falling raw candle
        if rising:
            o, h, l, c = base, base + 2.5, base - 0.3, base + 2.2
        else:
            o, h, l, c = base, base + 0.3, base - 2.5, base - 2.2
        r = _push(det, m, o, h, l, c, dirp)
        if r:
            fires.append(r)
    return fires


# ── warmup ────────────────────────────────────────────────────────────────

def test_no_signal_during_warmup():
    """Fewer candles than the rule needs → never fires."""
    det = _det()
    fires = _run_trend(det, rising=True, n=4, dirp=0.60)
    assert fires == []


# ── call side ───────────────────────────────────────────────────────────────

def test_call_fires_once_on_clean_uptrend():
    """A steady, unbroken uptrend with model agreeing up fires exactly one CALL
    (the one-per-leg lock suppresses the rest)."""
    det = _det()
    fires = _run_trend(det, rising=True, n=15, dirp=0.60)
    assert fires == ["LONG_CE"]


def test_no_call_when_model_disagrees():
    """Same uptrend but the model says DOWN (dir below dir_ce) → no call."""
    det = _det()
    fires = _run_trend(det, rising=True, n=15, dirp=0.45)
    assert "LONG_CE" not in fires


# ── put side ────────────────────────────────────────────────────────────────

def test_put_fires_once_on_clean_downtrend():
    """A steady downtrend with model agreeing down fires exactly one PUT."""
    det = _det()
    fires = _run_trend(det, rising=False, n=15, dirp=0.35)
    assert fires == ["LONG_PE"]


def test_no_put_when_model_disagrees():
    """Downtrend but model says up (dir above dir_pe) → no put."""
    det = _det()
    fires = _run_trend(det, rising=False, n=15, dirp=0.55)
    assert "LONG_PE" not in fires


# ── trend filter ────────────────────────────────────────────────────────────

def test_call_blocked_against_falling_trend():
    """Model agrees up, but the trend line is falling → the trend filter blocks
    the call (no counter-trend entries)."""
    det = _det()
    fires = _run_trend(det, rising=False, n=15, dirp=0.60)  # falling trend, up model
    assert "LONG_CE" not in fires


# ── one-per-leg lock re-arms after a break ─────────────────────────────────

def test_lock_rearms_after_leg_breaks():
    """After a call, an opposite candle that takes out the prior low breaks the
    leg and unlocks; a fresh uptrend can then fire a second call."""
    det = _det()
    first = _run_trend(det, rising=True, n=12, dirp=0.60)
    assert first == ["LONG_CE"]
    # sharp break down (several red candles taking out lows) → unlock
    top = 100.0 + 11 * 3.0
    for k in range(6):
        base = top - (k + 1) * 5.0
        _push(det, 12 + k, base, base + 0.3, base - 4.0, base - 3.5, 0.40)
    # new uptrend → a second call is allowed
    second = []
    for k in range(10):
        base = (top - 30.0) + k * 3.0
        r = _push(det, 18 + k, base, base + 2.5, base - 0.3, base + 2.2, 0.60)
        if r:
            second.append(r)
    assert "LONG_CE" in second


# ── put mirror toggle (experiment, 2026-07-14) ──────────────────────────────

def test_put_mirror_fires_via_lower_high_path():
    """With pe_mirror on (call-symmetric put: 2 red + lower-high + dir<=0.48), a
    clean downtrend fires exactly one PUT through the mirror branch. dirp=0.45
    would be BLOCKED by the default dir_pe=0.42, so a fire here also confirms the
    loosened threshold is in effect."""
    det = _det(pe_mirror=True, ng_pe=2, dir_pe=0.48)
    fires = _run_trend(det, rising=False, n=15, dirp=0.45)
    assert fires == ["LONG_PE"]
