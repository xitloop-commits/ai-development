"""
leg_start.py — SEA leg-start gate (2026-07-10).

A stateful signal detector that fires ONCE at the start of a small directional
"leg" instead of on every tick. Built to replace the per-candle signal flood
with a handful of clean, trend-aligned entries (banknifty went 237/day → ~20).

How it works (all on the UNDERLYING spot, 1-minute Heikin-Ashi candles):

  • Aggregate live spot ticks into 1-min Heikin-Ashi candles.
  • Maintain a 21-period EMA of the HA close as the "trend line".
  • CALL (up-leg) fires when:  NG_CE green candles in a row + a higher-low
      + the model agrees up (direction_prob_60s ≥ DIR_CE) + the trend is rising.
  • PUT (down-leg) fires when: NG_PE red candles in a row + a FRESH lower-low
      (breaks the last PE_LOOK candles' low) + the model agrees down
      (direction_prob_60s ≤ DIR_PE) + the trend is falling.
  • One-per-leg LOCK: after a signal, no new one until the leg breaks (an
      opposite-colour candle takes out the prior extreme) or MAXHOLD candles pass.

The detector is pure state (no I/O). The engine feeds it (timestamp, spot,
direction_prob) every tick and prices/emits the returned leg. Exit is handled
by the execution side (fixed % SL + the existing time/momentum exits) — this
module only decides ENTRIES.

Tuned in ``config/sea_thresholds/<inst>.json`` under the ``legstart`` block;
see ``LegStartThresholds`` for the fields.
"""

from __future__ import annotations

import math
from collections import deque

from signal_engine_agent.thresholds import LegStartThresholds


class _Candle:
    """One completed 1-min Heikin-Ashi candle (only the fields we gate on)."""

    __slots__ = ("ha_close", "ha_low", "ha_high", "green", "dir", "ema")

    def __init__(self, ha_close: float, ha_low: float, ha_high: float,
                 green: bool, dir_prob: float, ema: float) -> None:
        self.ha_close = ha_close
        self.ha_low = ha_low
        self.ha_high = ha_high
        self.green = green
        self.dir = dir_prob      # model direction_prob_60s at candle close
        self.ema = ema           # 21-EMA of ha_close through this candle


class LegStartDetector:
    """Stateful leg-start signal detector. See module docstring.

    ``on_tick(ts, spot, dir_prob)`` returns ``"LONG_CE"`` / ``"LONG_PE"`` on the
    tick that completes a signalling candle, else ``None``. Never raises.
    """

    def __init__(self, cfg: LegStartThresholds) -> None:
        self.cfg = cfg
        # Keep just enough history to evaluate every rule.
        keep = max(cfg.ng_ce, cfg.ng_pe, cfg.pe_look, cfg.trend_slope) + 3
        self._candles: deque[_Candle] = deque(maxlen=keep)
        # in-progress minute bucket
        self._cur_minute: int | None = None
        self._o = self._h = self._l = self._c = 0.0
        self._last_dir = 0.5
        # HA / EMA recursion state
        self._ha_open_prev: float | None = None
        self._ha_close_prev: float | None = None
        self._ema_prev: float | None = None
        # one-per-leg lock
        self._in_leg = False
        self._leg = ""            # "CE" | "PE"
        self._candles_in_leg = 0

    # ── tick ingestion ──────────────────────────────────────────────────────
    def on_tick(self, ts: float, spot: float, dir_prob: float) -> str | None:
        if not (math.isfinite(ts) and math.isfinite(spot)):
            return None
        if not math.isfinite(dir_prob):
            dir_prob = 0.5
        minute = int(ts // 60)

        if self._cur_minute is None:
            self._start_bucket(minute, spot, dir_prob)
            return None

        if minute == self._cur_minute:
            # accumulate into the in-progress candle
            if spot > self._h:
                self._h = spot
            if spot < self._l:
                self._l = spot
            self._c = spot
            self._last_dir = dir_prob
            return None

        # a new minute began → the current candle just CLOSED
        self._close_candle()
        fired = self._evaluate()
        self._start_bucket(minute, spot, dir_prob)
        return fired

    # ── candle machinery ────────────────────────────────────────────────────
    def _start_bucket(self, minute: int, spot: float, dir_prob: float) -> None:
        self._cur_minute = minute
        self._o = self._h = self._l = self._c = spot
        self._last_dir = dir_prob

    def _close_candle(self) -> None:
        o, h, l, c = self._o, self._h, self._l, self._c
        ha_close = (o + h + l + c) / 4.0
        ha_open = (o + c) / 2.0 if self._ha_open_prev is None \
            else (self._ha_open_prev + self._ha_close_prev) / 2.0
        ha_high = max(h, ha_open, ha_close)
        ha_low = min(l, ha_open, ha_close)
        a = 2.0 / (self.cfg.ema_period + 1)
        ema = ha_close if self._ema_prev is None \
            else a * ha_close + (1.0 - a) * self._ema_prev
        self._candles.append(
            _Candle(ha_close, ha_low, ha_high, ha_close > ha_open, self._last_dir, ema)
        )
        self._ha_open_prev, self._ha_close_prev = ha_open, ha_close
        self._ema_prev = ema

    # ── trigger + lock ──────────────────────────────────────────────────────
    def _evaluate(self) -> str | None:
        cfg = self.cfg
        C = self._candles
        need = max(cfg.ng_ce, cfg.ng_pe, cfg.pe_look, cfg.trend_slope) + 1
        if len(C) < need:
            return None
        i = len(C) - 1              # index of the just-closed candle
        cc = C[i]

        # If we're inside a leg, only look for the break that unlocks us.
        if self._in_leg:
            self._candles_in_leg += 1
            broke = (
                (self._leg == "CE" and (not cc.green) and cc.ha_low < C[i - 1].ha_low)
                or (self._leg == "PE" and cc.green and cc.ha_high > C[i - 1].ha_high)
                or self._candles_in_leg >= cfg.maxhold_candles
            )
            if broke:
                self._in_leg = False
            return None            # never fire twice inside one leg

        trend_up = cc.ema > C[i - cfg.trend_slope].ema
        trend_dn = cc.ema < C[i - cfg.trend_slope].ema

        up = (
            all(C[k].green for k in range(i - cfg.ng_ce + 1, i + 1))
            and cc.ha_low > C[i - 1].ha_low
            and cc.dir >= cfg.dir_ce
            and trend_up
        )
        dn = (
            all(not C[k].green for k in range(i - cfg.ng_pe + 1, i + 1))
            and cc.ha_low < min(C[k].ha_low for k in range(i - cfg.pe_look, i))
            and cc.dir <= cfg.dir_pe
            and trend_dn
        )
        if up:
            self._enter("CE")
            return "LONG_CE"
        if dn:
            self._enter("PE")
            return "LONG_PE"
        return None

    def _enter(self, leg: str) -> None:
        self._in_leg = True
        self._leg = leg
        self._candles_in_leg = 0