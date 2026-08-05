"""
sma5_signal.py — SEA SMA-5 price-cross detector (2026-08-05).

A stateful detector that segments the underlying by a SIMPLE moving average of
its close (the SMA-5 line on the chart) and fires on a price↔line cross:

  • Aggregate live spot ticks into 1-minute candles; keep the last ``period``
    closes and take their simple mean (the SMA line the chart draws).
  • Classify each closed candle by where the close sits versus the line
    (a small ``buffer_pct`` deadband avoids whipsaw right at the line):
      ABOVE  when close >  sma × (1 + buffer)   (price above → CALL)
      BELOW  when close <  sma × (1 - buffer)   (price below → PUT)
      otherwise HOLD the current state.
  • Emit ``LONG_CE`` when the close crosses ABOVE the line and ``LONG_PE`` when
    it crosses BELOW; a cross emits the opposite side's ``EXIT_*`` first, so a
    flip from below→above yields ``EXIT_PE`` + ``LONG_CE`` (symmetric CE/PE).

Pure state, no I/O, model-independent (price only) — same shape as
``ma_signal.MASignalDetector``. The engine feeds it (timestamp, spot) every tick
and emits the returned events as the ``sma5_signal`` cohort.

Tuned in ``config/sea_thresholds/<inst>.json`` under the ``sma5_signal`` block;
see ``Sma5SignalThresholds`` for the fields.
"""

from __future__ import annotations

import math
from collections import deque

from signal_engine_agent.thresholds import Sma5SignalThresholds


class Sma5SignalDetector:
    """Stateful SMA-5 price-cross detector. See module docstring.

    ``on_tick(ts, spot)`` returns a list of event strings on the tick that
    completes a candle (possibly empty), else ``[]``. Never raises.
    """

    def __init__(self, cfg: Sma5SignalThresholds) -> None:
        self.cfg = cfg
        self._closes: deque[float] = deque(maxlen=max(1, cfg.period))
        self._cur_minute: int | None = None
        self._c = 0.0                      # in-progress candle close (last spot)
        self._state = "FLAT"               # "FLAT" | "ABOVE" | "BELOW"

    def on_tick(self, ts: float, spot: float) -> list[str]:
        if not (math.isfinite(ts) and math.isfinite(spot)):
            return []
        minute = int(ts // 60)
        if self._cur_minute is None:
            self._cur_minute = minute
            self._c = spot
            return []
        if minute == self._cur_minute:
            self._c = spot                 # candle close = latest spot in the minute
            return []
        # a new minute began → the current candle just CLOSED
        events = self._close_and_eval()
        self._cur_minute = minute
        self._c = spot
        return events

    def _close_and_eval(self) -> list[str]:
        cfg = self.cfg
        self._closes.append(self._c)
        if len(self._closes) < cfg.period:
            return []                      # not enough closes for the SMA yet
        sma = sum(self._closes) / len(self._closes)
        if sma <= 0:
            return []
        buf = cfg.buffer_pct / 100.0
        prev = self._state
        st = prev
        if self._c > sma * (1.0 + buf):
            st = "ABOVE"
        elif self._c < sma * (1.0 - buf):
            st = "BELOW"
        # else: inside the deadband → HOLD the current state

        if st == prev:
            return []
        self._state = st
        events: list[str] = []
        if prev == "ABOVE":
            events.append("EXIT_CE")
        elif prev == "BELOW":
            events.append("EXIT_PE")
        if st == "ABOVE":
            events.append("LONG_CE")
        elif st == "BELOW":
            events.append("LONG_PE")
        return events
