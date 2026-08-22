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


def test_warm_fires_long_if_ends_up() -> None:
    # Partha 2026-08-23: if warm-up completes with the ribbon already UP, warm()
    # fires a LONG so an into-green turn INSIDE the history isn't missed.
    det = PremiumRibbonDetector("sma5", candle_sec=60)
    prices, _, fall_start = _series()
    up_hist = prices[:fall_start]           # ends mid-uptrend (state UP)
    evs = det.warm("CE", _ticks(up_hist))
    assert det.leg("CE").state == 1
    assert evs == ["LONG_CE"]


def test_warm_silent_if_not_ending_up() -> None:
    # Replaying through the fall ends the leg DOWN → warm fires nothing.
    det = PremiumRibbonDetector("sma5", candle_sec=60)
    prices, _, _ = _series()
    evs = det.warm("CE", _ticks(prices))    # full series ends in the downtrend
    assert det.leg("CE").state != 1
    assert evs == []


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


def test_binary_mode_sign_only() -> None:
    """gray_pctile=0 (Partha 2026-08-14: SMA5 has no gray): the state is the
    sign of the slope — no noise floor, no sample warm-up. LONG fires as soon
    as the slope turns positive, EXIT on the first negative-slope candle."""
    det = PremiumRibbonDetector("sma5", candle_sec=60, gray_pctile=0.0)
    prices, rise_start, fall_start = _series()
    events = _run(det, "CE", prices)
    names = [e for _, e in events]
    assert "LONG_CE" in names and "EXIT_CE" in names
    long_i = next(i for i, e in events if e == "LONG_CE")
    # No 15-sample warm-up: the long may fire well before the quiet phase ends
    # (any positive jitter counts) — it must exist, and an exit must follow the
    # fall.
    exit_i = max(i for i, e in events if e == "EXIT_CE")
    assert long_i < exit_i


def test_relock_reset_rewarms() -> None:
    det = PremiumRibbonDetector("sma5", candle_sec=60)
    prices, _, _ = _series()
    _run(det, "CE", prices)
    det.reset_leg("CE")
    assert det.leg("CE").state == 0


def test_drain_closed_emits_closed_candle_lines() -> None:
    """T169-B — every CLOSED candle (once the line exists) queues one line
    sample for the chart; warm-up candles (no line yet) do not, and drain
    clears the queue."""
    det = PremiumRibbonDetector("sma5", candle_sec=60, gray_pctile=0.0)
    prices, _, _ = _series()
    _run(det, "CE", prices)
    samples = det.drain_closed()
    assert samples, "expected closed-candle line samples"
    # Shape: (leg, t_epoch, line, state, close, deg).
    leg, t, line, state, close, deg = samples[0]
    assert leg == "CE"
    assert t % 60 == 0                 # bucket-aligned epoch seconds
    assert isinstance(line, float) and line > 0
    assert state in (-1, 0, 1)
    assert isinstance(deg, float)      # slope angle for the readout
    # Every sample is bucket-aligned and the series is time-ordered per leg.
    ce = [s for s in samples if s[0] == "CE"]
    assert all(s[1] % 60 == 0 for s in ce)
    assert [s[1] for s in ce] == sorted(s[1] for s in ce)
    # Draining again returns nothing (queue was cleared).
    assert det.drain_closed() == []


def test_warm_does_not_queue_chart_lines() -> None:
    """History replayed via warm() must not spam the chart store."""
    det = PremiumRibbonDetector("sma5", candle_sec=60, gray_pctile=0.0)
    prices, _, _ = _series()
    det.warm("CE", _ticks(prices))
    assert det.drain_closed() == []
