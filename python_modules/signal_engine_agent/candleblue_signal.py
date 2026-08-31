"""
candleblue_signal — structure-based HH+HL entry on the locked ATM premium.

Partha's "candleblue" cohort (temp name, 2026-08-30). Pure swing structure, no
ribbon. Per leg (locked CE + locked PE, independent), from the premium candles:

  ENTRY  — go LONG when BOTH are freshly confirmed up:
             higher low  (latest swing low  > previous swing low)  AND
             higher high (latest swing high > previous swing high).
           Fires on the candle that completes the SECOND of the two.
  EXIT   — a LOWER high forms (latest swing high < previous swing high).
  STOP   — a hard stop just under the last higher low; ratchets UP as new higher
           lows print. Catches a straight collapse where no new swing high forms.

Swing points are 1-bar pivots on the premium candles (a high with a lower/equal
high after it; a low with a higher/equal low after it) — the same blue/green
arrows the chart draws. Pure per-leg state, never raises.

``on_leg_tick(leg, ts, price)`` feeds one premium tick and returns the events
fired ("LONG_CE" | "EXIT_CE" | "LONG_PE" | "EXIT_PE"), usually []. ``warm(leg,
ticks)`` replays history WITHOUT emitting (state ends where the past leaves it),
so a freshly-started engine doesn't fire on the past.
"""
from __future__ import annotations

import math
from collections import deque
from typing import Callable

CandleBlueEvent = str  # "LONG_CE" | "EXIT_CE" | "LONG_PE" | "EXIT_PE"


class CandleBlueLeg:
    """One contract's swing structure: premium candles → swing highs/lows →
    HH+HL entry, lower-high exit, higher-low trailing stop."""

    def __init__(self, candle_sec: int = 60, stop_buffer_pct: float = 0.2) -> None:
        self.candle_sec = max(1, int(candle_sec))
        # Stop sits this % BELOW the higher low it trails (a hair under it).
        self.stop_buffer_pct = max(0.0, float(stop_buffer_pct))
        self.reset()

    def reset(self) -> None:
        self._bucket: int | None = None
        self._o = 0.0
        self._h = 0.0
        self._l = 0.0
        self._c = 0.0
        # last three completed-candle highs / lows, for 1-bar pivot detection
        self._highs: deque[float] = deque(maxlen=3)
        self._lows: deque[float] = deque(maxlen=3)
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
            self.reset()

    # ── tick / candle plumbing ──────────────────────────────────────────────
    def _stop_from(self, higher_low: float) -> float:
        return higher_low * (1.0 - self.stop_buffer_pct / 100.0)

    def on_tick(self, ts: float, price: float, emit: bool) -> list[CandleBlueEvent]:
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

    def _close_candle(self, emit: bool) -> list[CandleBlueEvent]:
        self._highs.append(self._h)
        self._lows.append(self._l)
        out: list[CandleBlueEvent] = []

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

        higherHigh = len(self.swing_highs) >= 2 and self.swing_highs[-1] > self.swing_highs[-2]
        higherLow = len(self.swing_lows) >= 2 and self.swing_lows[-1] > self.swing_lows[-2]
        lowerHigh = len(self.swing_highs) >= 2 and self.swing_highs[-1] < self.swing_highs[-2]

        if not self.in_position:
            # ENTRY — both confirmed up, fired on the candle completing the second.
            if higherHigh and higherLow:
                self.stop = self._stop_from(self.swing_lows[-1])
                self.in_position = True
                if emit:
                    out.append(self._long())
        else:
            # Trail the stop up on a fresh higher low.
            if newSwingLow and higherLow:
                self.stop = max(self.stop or 0.0, self._stop_from(self.swing_lows[-1]))
            # Hard-stop backstop — the just-closed candle's low broke the stop
            # (catches a collapse where no new swing high forms). Close-confirmed;
            # the intra-candle path in on_tick also fires it live within a candle.
            if self.stop is not None and self._l < self.stop:
                self.in_position = False
                if emit:
                    out.append(self._exit())
            # EXIT — a lower high forms (the structural break).
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


class CandleBlueDetector:
    """Two CandleBlueLegs (locked CE + locked PE) → LONG/EXIT events."""

    def __init__(self, candle_sec: int = 60, stop_buffer_pct: float = 0.2) -> None:
        mk: Callable[[], CandleBlueLeg] = lambda: CandleBlueLeg(candle_sec, stop_buffer_pct)
        self._legs = {"CE": mk(), "PE": mk()}
        for name, leg in self._legs.items():
            leg._long = (lambda n=name: f"LONG_{n}")   # type: ignore[method-assign]
            leg._exit = (lambda n=name: f"EXIT_{n}")    # type: ignore[method-assign]

    def leg(self, leg: str) -> CandleBlueLeg:
        return self._legs[leg]

    def set_candle_sec(self, sec: int) -> None:
        for leg in self._legs.values():
            leg.set_candle_sec(sec)

    def reset_leg(self, leg: str) -> None:
        self._legs[leg].reset()

    def warmup(self) -> dict:
        """Ready once each leg has seen enough candles to judge structure (>=2
        swing highs and >=2 swing lows on the slower leg)."""
        need = 2
        have = min(
            min(len(l.swing_highs), len(l.swing_lows)) for l in self._legs.values()
        )
        return {"ready": have >= need, "samples": have, "need": need}

    def on_leg_tick(self, leg: str, ts: float, price: float) -> list[CandleBlueEvent]:
        return self._legs[leg].on_tick(ts, price, emit=True)

    def warm(self, leg: str, ticks: list[tuple[float, float]]) -> list[CandleBlueEvent]:
        """Replay history silently — state ends where the past leaves it. If the
        leg finishes ALREADY in a confirmed HH+HL position, fire a LONG so an
        into-structure turn inside the history isn't missed."""
        lg = self._legs[leg]
        for ts, price in ticks:
            lg.on_tick(ts, price, emit=False)
        return [f"LONG_{leg}"] if lg.in_position else []
