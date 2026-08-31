"""Tests for the candleblue HH+HL structure detector (candleblue_signal.py).

One tick per candle, 60s candles. We build swing highs/lows by zig-zagging the
premium and check: LONG when both a higher-high and a higher-low are confirmed,
EXIT on a lower high, and the hard stop on a collapse with no new swing high.
"""
from __future__ import annotations

from signal_engine_agent.candleblue_signal import CandleBlueDetector


def _run(det: CandleBlueDetector, leg: str, prices: list[float]):
    ev = []
    for i, p in enumerate(prices):
        for e in det.on_leg_tick(leg, float(i * 60), p):
            ev.append((i, e))
    return ev


def test_enters_on_confirmed_hh_and_hl():
    # zig-zag UP: each swing low higher than the last, each swing high higher too.
    # lows:  100 ...      104 ...      108
    # highs:      110 ...      116 ...
    prices = [100, 110, 104, 116, 108, 122, 114, 128]
    det = CandleBlueDetector(candle_sec=60)
    names = [e for _, e in _run(det, "CE", prices)]
    assert "LONG_CE" in names, f"expected LONG on confirmed HH+HL: {names}"


def test_no_entry_when_only_higher_high():
    # highs rise but lows DON'T (flat/lower lows) → not both up → no entry.
    prices = [100, 110, 100, 116, 100, 122, 100, 128]
    det = CandleBlueDetector(candle_sec=60)
    names = [e for _, e in _run(det, "CE", prices)]
    assert "LONG_CE" not in names, f"should not enter without a higher low: {names}"


def test_exit_on_lower_high():
    # zig-zag up (SH 110,120,130 / SL 105,110,120) → LONG, then a LOWER high
    # (125 < 130) / pullback → EXIT.
    prices = [100, 110, 105, 120, 110, 130, 120, 125, 115, 118]
    det = CandleBlueDetector(candle_sec=60)
    ev = _run(det, "CE", prices)
    names = [e for _, e in ev]
    assert "LONG_CE" in names and "EXIT_CE" in names, f"{ev}"
    li = next(i for i, e in ev if e == "LONG_CE")
    xi = next(i for i, e in ev if e == "EXIT_CE")
    assert li < xi


def test_hard_stop_on_collapse():
    # Enter on HH+HL, then COLLAPSE straight down (no new swing high) → the hard
    # stop under the last higher low must fire the exit.
    prices = [100, 110, 105, 120, 110, 130, 115, 100, 90]  # → LONG, then breaks the stop
    det = CandleBlueDetector(candle_sec=60)
    ev = _run(det, "CE", prices)
    names = [e for _, e in ev]
    assert "LONG_CE" in names and "EXIT_CE" in names, f"collapse must stop out: {ev}"


def test_warm_is_silent():
    prices = [100, 110, 104, 116, 108, 122, 114, 128]
    det = CandleBlueDetector(candle_sec=60)
    # warm should not fire during replay; it may return a single LONG if it ends
    # in a confirmed position, but must not emit per-tick.
    evs = det.warm("CE", [(float(i * 60), p) for i, p in enumerate(prices)])
    assert evs in ([], ["LONG_CE"])


def test_legs_are_independent():
    det = CandleBlueDetector(candle_sec=60)
    up = [100, 110, 104, 116, 108, 122, 114, 128]
    ce = [e for _, e in _run(det, "CE", up)]
    pe = [e for _, e in _run(det, "PE", [100, 100, 100, 100, 100, 100])]  # flat
    assert "LONG_CE" in ce and "LONG_PE" not in pe
