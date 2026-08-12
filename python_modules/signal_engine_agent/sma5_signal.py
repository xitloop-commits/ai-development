"""
sma5_signal.py — SEA SMA-5 price-cross detector (2026-08-05).

A stateful detector that segments the underlying by a SIMPLE moving average of
its close (the SMA-5 line on the chart) and fires on a price↔line cross:

  • Aggregate live spot ticks into 1-minute candles; keep the last ``period``
    closes and take their simple mean (the SMA line the chart draws). By default
    (``use_ha`` true) the Heikin-Ashi close is used instead of the raw close —
    smoother, so crossovers are cleaner and fewer; set ``use_ha`` false to A/B
    against raw closes.
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
        # In-progress 1-min candle OHLC (o/h/l needed for the Heikin-Ashi close).
        self._o = self._h = self._l = self._c = 0.0
        # Prior Heikin-Ashi open/close (HA is recursive). None until the 1st close.
        self._ha_open_prev: float | None = None
        self._ha_close_prev: float | None = None
        self._state = "FLAT"               # "FLAT" | "ABOVE" | "BELOW"
        # Reversal confirmation: a candidate new state must hold for
        # ``confirm_candles`` consecutive closes before the flip (and its EXIT)
        # fires. Only reversals are gated; the first entry from FLAT is immediate.
        self._pending: str | None = None   # candidate side awaiting confirmation
        self._pending_streak = 0           # consecutive closes on the pending side
        # Entry-watch: after a cross sets a new side, WAIT this many candles that
        # each keep closing in the trade's direction (each close beyond the prior
        # candle's) before entering — so a spike that crosses and reverts is never
        # bought. 0 = enter immediately on the cross (original).
        self._entered = False              # LONG already emitted for the current side?
        self._entry_watch_left = 0         # continuation candles still needed (0 = none pending)
        self._entry_ref_close = 0.0        # the prior candle's close the next must beat
        # One-line audit note describing the LAST entry-watch transition (armed /
        # confirming N/M / entered / cancelled), or None. Set on a candle close,
        # cleared every tick — the engine prints it (with instrument) so the wait
        # is visible in the SEA output. Diagnostic only; never affects decisions.
        self.last_watch_note: str | None = None
        # Live-tunable (the engine may overwrite these from the control channel).
        self.confirm_candles = max(1, int(getattr(cfg, "confirm_candles", 1) or 1))
        # Deadband (% of the line) the close must clear to flip; 0 = exact cross.
        self.buffer_pct = max(0.0, float(getattr(cfg, "buffer_pct", 0.0) or 0.0))
        self.entry_watch = max(0, int(getattr(cfg, "entry_watch", 0) or 0))
        # Candle timeframe in SECONDS (60 = 1m, 180 = 3m, 300 = 5m). The 5-SMA is
        # 5 candles of THIS size, so a 3m timeframe = a 15-min line. Live-tunable.
        self.candle_sec = max(1, int(getattr(cfg, "candle_sec", 60) or 60))

    def set_candle_sec(self, sec: int) -> None:
        """Live timeframe change. Resets the candle aggregation so the new-size
        candles rebuild cleanly (the SMA re-warms over `period` candles); the
        ABOVE/BELOW state is kept so an open side still tracks. No-op if unchanged."""
        sec = max(1, int(sec))
        if sec == self.candle_sec:
            return
        self.candle_sec = sec
        self._cur_minute = None
        self._o = self._h = self._l = self._c = 0.0
        self._closes.clear()
        self._ha_open_prev = None
        self._ha_close_prev = None
        self._pending = None
        self._pending_streak = 0

    def _start_candle(self, spot: float) -> None:
        self._o = self._h = self._l = self._c = spot

    def on_tick(self, ts: float, spot: float) -> list[str]:
        self.last_watch_note = None        # only a candle-close transition sets it
        if not (math.isfinite(ts) and math.isfinite(spot)):
            return []
        minute = int(ts // self.candle_sec)
        if self._cur_minute is None:
            self._cur_minute = minute
            self._start_candle(spot)
            return []
        if minute == self._cur_minute:
            self._c = spot                 # close = latest spot in the minute
            if spot > self._h:
                self._h = spot
            if spot < self._l:
                self._l = spot
            return []
        # a new minute began → the current candle just CLOSED
        events = self._close_and_eval()
        self._cur_minute = minute
        self._start_candle(spot)
        return events

    def _candle_value(self) -> float:
        """The price the SMA + cross use for the just-closed candle: the regular
        close, or the Heikin-Ashi close when ``use_ha`` is on."""
        if not self.cfg.use_ha:
            return self._c
        ha_close = (self._o + self._h + self._l + self._c) / 4.0
        ha_open = (
            (self._o + self._c) / 2.0
            if self._ha_open_prev is None
            else (self._ha_open_prev + self._ha_close_prev) / 2.0
        )
        self._ha_open_prev = ha_open
        self._ha_close_prev = ha_close
        return ha_close

    def _close_and_eval(self) -> list[str]:
        cfg = self.cfg
        value = self._candle_value()       # regular close or HA close
        self._closes.append(value)
        if len(self._closes) < cfg.period:
            return []                      # not enough closes for the SMA yet
        sma = sum(self._closes) / len(self._closes)
        if sma <= 0:
            return []
        buf = self.buffer_pct / 100.0
        prev = self._state
        target = prev
        if value > sma * (1.0 + buf):
            target = "ABOVE"
        elif value < sma * (1.0 - buf):
            target = "BELOW"
        # else: inside the deadband → HOLD the current state

        events: list[str] = []

        if target != prev:
            # A state change. The first entry from FLAT is immediate; a REVERSAL
            # (which exits the current side) waits for `confirm_candles` consecutive
            # closes on the new side (a one-candle poke that recovers no longer
            # flips).
            confirm = self.confirm_candles if prev != "FLAT" else 1
            if confirm > 1:
                if self._pending == target:
                    self._pending_streak += 1
                else:
                    self._pending = target
                    self._pending_streak = 1
                if self._pending_streak < confirm:
                    target = prev          # not yet confirmed → no flip this candle
            if target != prev:
                # Confirmed flip: EXIT the old side now; ARM the entry-watch for the
                # new side (the LONG only fires once the watch is satisfied).
                self._pending = None
                self._pending_streak = 0
                if prev == "ABOVE":
                    events.append("EXIT_CE")
                elif prev == "BELOW":
                    events.append("EXIT_PE")
                self._state = target
                self._entered = False
                self._entry_watch_left = self.entry_watch
                self._entry_ref_close = value
                side = "CE" if target == "ABOVE" else "PE"
                if self._entry_watch_left <= 0:
                    events.append("LONG_CE" if target == "ABOVE" else "LONG_PE")
                    self._entered = True
                else:
                    # Cross confirmed, but hold entry until the watch is satisfied.
                    self.last_watch_note = f"{side} armed — waiting {self.entry_watch} candle(s) to confirm"
                return events
        else:
            # Holding the current side → any pending reversal is void.
            self._pending = None
            self._pending_streak = 0

        # Entry-watch: after the cross, require `entry_watch` candles that each
        # close FURTHER in the trade's direction (above the prior candle for CE,
        # below for PE) before entering. A candle that breaks the run cancels it —
        # a fresh cross re-arms.
        if self._state != "FLAT" and not self._entered and self._entry_watch_left > 0:
            cont = value > self._entry_ref_close if self._state == "ABOVE" else value < self._entry_ref_close
            side = "CE" if self._state == "ABOVE" else "PE"
            if cont:
                self._entry_ref_close = value
                self._entry_watch_left -= 1
                done = self.entry_watch - self._entry_watch_left
                if self._entry_watch_left <= 0:
                    events.append("LONG_CE" if self._state == "ABOVE" else "LONG_PE")
                    self._entered = True
                    self.last_watch_note = f"{side} entered — {done}/{self.entry_watch} candles confirmed"
                else:
                    self.last_watch_note = f"{side} confirming {done}/{self.entry_watch}"
            else:
                self._entry_watch_left = 0   # run broke → wait for a fresh cross
                self.last_watch_note = f"{side} cancelled — candle closed against the move"

        return events
