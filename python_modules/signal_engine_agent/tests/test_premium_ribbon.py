"""Tests for the T163 premium-ribbon detector (see premium_ribbon.py).

Synthetic premium series, one tick per second, 60s candles:
  quiet phase (tiny jitter) → establishes the causal noise floor (gray),
  strong rise → ribbon UP → LONG on the transition,
  strong fall → ribbon DOWN → EXIT on the transition,
  and warm() replays history without emitting anything.
"""

from __future__ import annotations

from signal_engine_agent.premium_ribbon import PremiumRibbonDetector


def _ticks(prices: list[float], start_candle: int = 0, candle_sec: int = 60):
    """One tick per candle: (ts at the candle's start, price)."""
    return [(float((start_candle + i) * candle_sec), p) for i, p in enumerate(prices)]


def _series() -> tuple[list[float], int, int]:
    """(prices, rise_start_idx, fall_start_idx) — quiet, then +1%/candle up
    for 12 candles, then −1%/candle down for 12."""
    prices: list[float] = []
    p = 100.0
    # Quiet: jitter far below the absolute noise floor (0.002% of 100) → gray.
    for i in range(40):
        prices.append(p + (0.0005 if i % 2 == 0 else -0.0005))
    rise_start = len(prices)
    for _ in range(12):                    # strong rise
        p *= 1.01
        prices.append(p)
    fall_start = len(prices)
    for _ in range(12):                    # strong fall
        p *= 0.99
        prices.append(p)
    return prices, rise_start, fall_start


def _run(det: PremiumRibbonDetector, leg: str, prices: list[float]) -> list[tuple[int, str]]:
    events: list[tuple[int, str]] = []
    for i, (ts, price) in enumerate(_ticks(prices)):
        for ev in det.on_leg_tick(leg, ts, price):
            events.append((i, ev))
    return events


def test_ce_rise_longs_then_fall_exits() -> None:
    det = PremiumRibbonDetector("sma5", candle_sec=60)
    prices, rise_start, fall_start = _series()
    events = _run(det, "CE", prices)
    names = [e for _, e in events]
    assert "LONG_CE" in names, f"no LONG on the rise: {events}"
    assert "EXIT_CE" in names, f"no EXIT on the fall: {events}"
    long_i = next(i for i, e in events if e == "LONG_CE")
    exit_i = next(i for i, e in events if e == "EXIT_CE")
    assert rise_start <= long_i, "LONG fired during the quiet (gray) phase"
    assert fall_start <= exit_i, "EXIT fired before the fall began"
    assert long_i < exit_i


def test_pe_leg_is_symmetric() -> None:
    det = PremiumRibbonDetector("ma", candle_sec=60)
    prices, _, _ = _series()
    names = [e for _, e in _run(det, "PE", prices)]
    assert "LONG_PE" in names and "EXIT_PE" in names


def test_quiet_series_stays_gray_no_events() -> None:
    det = PremiumRibbonDetector("sma5", candle_sec=60)
    prices = [100.0 + (0.0005 if i % 2 == 0 else -0.0005) for i in range(80)]
    assert _run(det, "CE", prices) == []


def test_warm_is_silent_and_state_carries() -> None:
    det = PremiumRibbonDetector("sma5", candle_sec=60)
    prices, _, fall_start = _series()
    up_hist = prices[:fall_start]          # ends mid-uptrend (state UP)
    det.warm("CE", _ticks(up_hist))
    assert det.leg("CE").state == 1, "warm-up should leave the leg in UP"
    # Live continuation: the fall must fire EXIT (a NEW transition), and no
    # LONG may fire (the up-leg belongs to the past).
    p = up_hist[-1]
    live: list[float] = []
    for _ in range(12):
        p *= 0.99
        live.append(p)
    events: list[str] = []
    for ts, price in _ticks(live, start_candle=fall_start):
        events.extend(det.on_leg_tick("CE", ts, price))
    assert "EXIT_CE" in events and "LONG_CE" not in events


def test_gray_exit_fires_on_plateau() -> None:
    """Partha 2026-08-13: a ride ends the moment the ribbon LEAVES UP — a flat
    plateau (gray) after a rise must fire the EXIT without any DOWN turn."""
    det = PremiumRibbonDetector("sma5", candle_sec=60)
    prices, _, fall_start = _series()
    up = prices[:fall_start]               # quiet + strong rise (ends UP)
    plateau = [up[-1]] * 15                # dead flat — slope decays into gray
    events = _run(det, "CE", up + plateau)
    names = [e for _, e in events]
    assert "LONG_CE" in names
    assert "EXIT_CE" in names, f"no EXIT on the gray plateau: {events}"


def test_hold_through_gray_when_disabled() -> None:
    """exit_on_gray=False restores the legacy rule: the plateau holds, only a
    DOWN turn exits."""
    det = PremiumRibbonDetector("sma5", candle_sec=60, exit_on_gray=False)
    prices, _, fall_start = _series()
    up = prices[:fall_start]
    plateau = [up[-1]] * 15
    names = [e for _, e in _run(det, "CE", up + plateau)]
    assert "LONG_CE" in names and "EXIT_CE" not in names


def test_relock_reset_rewarms() -> None:
    det = PremiumRibbonDetector("sma5", candle_sec=60)
    prices, _, _ = _series()
    _run(det, "CE", prices)
    det.reset_leg("CE")
    assert det.leg("CE").state == 0
