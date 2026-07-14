"""
ma_signal.py — SEA MA-Signal detector (2026-07-14).

A stateful detector that segments the underlying by the SLOPE of its 20-EMA
(the violet "MA" line on the chart) and fires at the START and END of each
trend leg:

  • Aggregate live spot ticks into 1-minute candles; track a 20-EMA of the
    closes (the same line the chart draws).
  • Measure the EMA slope as its % change over the last ``slope_lookback``
    candles.
  • Classify the leg with STICKY hysteresis (so a genuine trend holds through
    minor pauses instead of fragmenting):
      FLAT → UP   when slope >  thr_hi        (rising  → CALL up-leg)
      FLAT → DOWN when slope < -thr_hi        (falling → PUT down-leg)
      UP stays UP until slope < thr_lo  (then FLAT, or DOWN if slope < -thr_hi)
      DOWN stays DOWN until slope > -thr_lo (then FLAT, or UP if slope > thr_hi)
  • Emit ``LONG_CE`` / ``LONG_PE`` at a leg START and ``EXIT_CE`` / ``EXIT_PE``
    at a leg END. A direct UP↔DOWN flip emits both the exit and the new entry.

Pure state, no I/O, model-independent (price only). The engine feeds it
(timestamp, spot) every tick and emits the returned events as the
``ma_signal`` cohort. SIGNAL-ONLY by design — it loses as a standalone buy
(backtested), so it is charted/logged but not auto-traded.

Tuned in ``config/sea_thresholds/<inst>.json`` under the ``ma_signal`` block;
see ``MASignalThresholds`` for the fields.
"""

from __future__ import annotations

import math
from collections import deque

from signal_engine_agent.thresholds import MASignalThresholds


class MASignalDetector:
    """Stateful MA-Signal (20-EMA slope) detector. See module docstring.

    ``on_tick(ts, spot)`` returns a list of event strings on the tick that
    completes a candle (possibly empty), else ``[]``. Never raises.
    """

    def __init__(self, cfg: MASignalThresholds) -> None:
        self.cfg = cfg
        self._emas: deque[float] = deque(maxlen=cfg.slope_lookback + 3)
        self._cur_minute: int | None = None
        self._c = 0.0                      # in-progress candle close (last spot)
        self._ema_prev: float | None = None
        self._state = "FLAT"               # "FLAT" | "UP" | "DOWN"

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
        a = 2.0 / (cfg.ema_period + 1)
        ema = self._c if self._ema_prev is None else a * self._c + (1.0 - a) * self._ema_prev
        self._ema_prev = ema
        self._emas.append(ema)
        if len(self._emas) < cfg.slope_lookback + 1:
            return []                      # not enough history to measure slope
        base = self._emas[-(cfg.slope_lookback + 1)]
        slope = (ema - base) / base * 100.0 if base else 0.0

        prev = self._state
        st = prev
        if prev == "FLAT":
            if slope > cfg.thr_hi:
                st = "UP"
            elif slope < -cfg.thr_hi:
                st = "DOWN"
        elif prev == "UP":
            if slope < -cfg.thr_hi:
                st = "DOWN"
            elif slope < cfg.thr_lo:
                st = "FLAT"
        elif prev == "DOWN":
            if slope > cfg.thr_hi:
                st = "UP"
            elif slope > -cfg.thr_lo:
                st = "FLAT"

        if st == prev:
            return []
        self._state = st
        events: list[str] = []
        if prev == "UP":
            events.append("EXIT_CE")
        elif prev == "DOWN":
            events.append("EXIT_PE")
        if st == "UP":
            events.append("LONG_CE")
        elif st == "DOWN":
            events.append("LONG_PE")
        return events