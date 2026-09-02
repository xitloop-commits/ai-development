"""
candleblue2_signal — candleblue v2 (cb2): HH+HL structure + a RANGE-POSITION gate,
on the locked ATM premium, defaulting to a 5-minute candle.

Partha's "cb2" cohort (2026-09-02). A parallel copy of `candleblue` — the existing
candleblue is left untouched so the two can run side-by-side and be compared live.

Difference from candleblue:
  1. RANGE-POSITION GATE — an HH+HL entry only fires when the completing candle's
     close sits in the UPPER part of its recent range (min_range_pos, default 0.5).
     Validated 2026-09-02: the winners are decisive breakouts near the range high;
     the losers are limp mid-range wiggles. Gating those out cut losses ~40% and
     lifted the win-rate across a multi-day, multi-instrument study.
  2. DEFAULT 5-MINUTE CANDLE (candle_sec=300) instead of candleblue's 2 min — the
     2-min tape is too noisy; slower candles produce cleaner breakouts.

Everything else mirrors candleblue: per-leg (locked CE + PE) 1-bar swing pivots,
higher-high + higher-low entry, lower-high exit, higher-low trailing hard stop.

``on_leg_tick(leg, ts, price)`` feeds one premium tick and returns the events
fired ("LONG_CE" | "EXIT_CE" | "LONG_PE" | "EXIT_PE"), usually []. ``warm(leg,
ticks)`` replays history WITHOUT emitting.
"""
from __future__ import annotations

import math
from collections import deque
from typing import Callable

CandleBlue2Event = str  # "LONG_CE" | "EXIT_CE" | "LONG_PE" | "EXIT_PE"


class CandleBlue2Leg:
    """One contract's swing structure: premium candles → swing highs/lows →
    HH+HL entry (gated on range-position), lower-high exit, higher-low stop."""

    def __init__(self, candle_sec: int = 300, stop_buffer_pct: float = 0.2,
                 range_window: int = 2, min_range_pos: float = 0.5) -> None:
        self.candle_sec = max(1, int(candle_sec))
        # Stop sits this % BELOW the higher low it trails (a hair under it).
        self.stop_buffer_pct = max(0.0, float(stop_buffer_pct))
        # A "higher high" must beat the highest of the previous `range_window`
        # swing highs — a GENUINE new range high, not just the last swing.
        self.range_window = max(1, int(range_window))
        # cb2: entry must sit at/above this fraction of the recent range (0 = off).
        self.min_range_pos = max(0.0, min(1.0, float(min_range_pos)))
        self._lb = self._lookback()
        self.reset()

    def _lookback(self) -> int:
        # ~30-minute range lookback, in candles (>=4). Matches the validation.
        return max(4, round(1800 / self.candle_sec))

    def reset(self) -> None:
        self._bucket: int | None = None
        self._o = 0.0
        self._h = 0.0
        self._l = 0.0
        self._c = 0.0
        # last three completed-candle highs / lows, for 1-bar pivot detection
        self._highs: deque[float] = deque(maxlen=3)
        self._lows: deque[float] = deque(maxlen=3)
        # recent completed-candle (high, low) for the range-position gate
        self._range: deque[tuple[float, float]] = deque(maxlen=self._lb)
        # confirmed swing levels (keep the last few; only the last two matter)
        self.swing_highs: list[float] = []
        self.swing_lows: list[float] = []
        self.in_position = False
        self.stop: float | None = None   # trailing hard stop (last higher low − buffer)
        self.last_ltp: float | None = None

    def set_candle_sec(self, sec: int) -> None:
        sec = max(1, int(sec))
        if sec != self.candle_sec:
            self.candle_sec = sec
            self._lb = self._lookback()
            self.reset()

    # ── tick / candle plumbing ──────────────────────────────────────────────
    def _stop_from(self, higher_low: float) -> float:
        return higher_low * (1.0 - self.stop_buffer_pct / 100.0)

    def on_tick(self, ts: float, price: float, emit: bool) -> list[CandleBlue2Event]:
        """Feed one tick. `emit=False` during warm-up (build state only)."""
        if not (math.isfinite(ts) and math.isfinite(price) and price > 0):
            return []
        self.last_ltp = price
        bucket = int(ts // self.candle_sec)
        if self._bucket is None:
            self._bucket = bucket
            self._o = self._h = self._l = self._c = price
            return []
        if bucket == self._bucket:
            self._c = price
            if price > self._h:
                self._h = price
            if price < self._l:
                self._l = price
            # Intra-candle hard-stop breach (only while in a position).
            if emit and self.in_position and self.stop is not None and price < self.stop:
                self.in_position = False
                return [self._exit()]
            return []
        # A candle just closed → evaluate structure, then roll to the new bucket.
        events = self._close_candle(emit)
        self._bucket = bucket
        self._o = self._h = self._l = self._c = price
        return events

    def _range_ok(self) -> bool:
        """cb2 gate — is the just-closed candle's close in the upper part of the
        recent range? Needs a few candles of history first."""
        if self.min_range_pos <= 0.0:
            return True
        if len(self._range) < 4:
            return False
        lo = min(l for _, l in self._range)
        hi = max(h for h, _ in self._range)
        return hi > lo and (self._c - lo) / (hi - lo) >= self.min_range_pos

    def _close_candle(self, emit: bool) -> list[CandleBlue2Event]:
        self._highs.append(self._h)
        self._lows.append(self._l)
        self._range.append((self._h, self._l))
        out: list[CandleBlue2Event] = []

        # Confirm a 1-bar pivot at the MIDDLE of the last three candles.
        newSwingHigh = False
        newSwingLow = False
        if len(self._highs) == 3:
            a, b, c = self._highs[0], self._highs[1], self._highs[2]
            if b > a and c <= b:
                self.swing_highs.append(b)
                newSwingHigh = True
        if len(self._lows) == 3:
            a, b, c = self._lows[0], self._lows[1], self._lows[2]
            if b < a and c >= b:
                self.swing_lows.append(b)
                newSwingLow = True
        # keep memory bounded
        if len(self.swing_highs) > 64:
            self.swing_highs = self.swing_highs[-64:]
        if len(self.swing_lows) > 64:
            self.swing_lows = self.swing_lows[-64:]

        w = self.range_window
        sh, sl = self.swing_highs, self.swing_lows
        higherHigh = len(sh) >= w + 1 and sh[-1] > max(sh[-w - 1:-1])
        higherLow = len(sl) >= 2 and sl[-1] > sl[-2]
        lowerHigh = len(sh) >= 2 and sh[-1] < sh[-2]
        stopAnchor = sl[-2] if len(sl) >= 2 else (sl[-1] if sl else None)

        if not self.in_position:
            # ENTRY — higher high + higher low + range-position gate (cb2).
            if higherHigh and higherLow and self._range_ok() and stopAnchor is not None:
                self.stop = self._stop_from(stopAnchor)
                self.in_position = True
                if emit:
                    out.append(self._long())
        else:
            if newSwingLow and higherLow and stopAnchor is not None:
                self.stop = max(self.stop or 0.0, self._stop_from(stopAnchor))
            if self.stop is not None and self._l < self.stop:
                self.in_position = False
                if emit:
                    out.append(self._exit())
            elif newSwingHigh and lowerHigh:
                self.in_position = False
                if emit:
                    out.append(self._exit())
        return out

    # placeholders overwritten by the detector with the leg name baked in
    def _long(self) -> str:  # pragma: no cover - set by detector
        return "LONG"

    def _exit(self) -> str:  # pragma: no cover - set by detector
        return "EXIT"


class CandleBlue2Detector:
    """Two CandleBlue2Legs (locked CE + locked PE) → LONG/EXIT events."""

    def __init__(self, candle_sec: int = 300, stop_buffer_pct: float = 0.2,
                 range_window: int = 2, min_range_pos: float = 0.5) -> None:
        mk: Callable[[], CandleBlue2Leg] = lambda: CandleBlue2Leg(
            candle_sec, stop_buffer_pct, range_window, min_range_pos)
        self._legs = {"CE": mk(), "PE": mk()}
        for name, leg in self._legs.items():
            leg._long = (lambda n=name: f"LONG_{n}")   # type: ignore[method-assign]
            leg._exit = (lambda n=name: f"EXIT_{n}")    # type: ignore[method-assign]

    def leg(self, leg: str) -> CandleBlue2Leg:
        return self._legs[leg]

    def set_candle_sec(self, sec: int) -> None:
        for leg in self._legs.values():
            leg.set_candle_sec(sec)

    def set_stop_buffer(self, pct: float) -> None:
        for leg in self._legs.values():
            leg.stop_buffer_pct = max(0.0, float(pct))

    def set_min_range_pos(self, v: float) -> None:
        for leg in self._legs.values():
            leg.min_range_pos = max(0.0, min(1.0, float(v)))

    def reset_leg(self, leg: str) -> None:
        self._legs[leg].reset()

    def warmup(self) -> dict:
        need = 2
        have = min(
            min(len(l.swing_highs), len(l.swing_lows)) for l in self._legs.values()
        )
        return {"ready": have >= need, "samples": have, "need": need}

    def on_leg_tick(self, leg: str, ts: float, price: float) -> list[CandleBlue2Event]:
        return self._legs[leg].on_tick(ts, price, emit=True)

    def warm(self, leg: str, ticks: list[tuple[float, float]]) -> list[CandleBlue2Event]:
        lg = self._legs[leg]
        for ts, price in ticks:
            lg.on_tick(ts, price, emit=False)
        return [f"LONG_{leg}"] if lg.in_position else []
