"""
compression.py — §8.8 Compression & Breakout Signals.

Stateful class: tracks the running median of rolling_std_20 over the first
100 ticks, then freezes it for the rest of the session.

Features (4 outputs):
    range_20ticks           max(price_20) - min(price_20)
    range_percent_20ticks   range_20ticks / median(price_20); NaN if median ≤ 0
    volatility_compression  rolling_std_20 / vol_session_median; NaN until tick 100
    spread_tightening_atm   mean CE spread for ATM ±3 (unticked = 0.0); NaN if no chain

Null rules:
    All outputs NaN if underlying buffer has < 20 ticks.
    volatility_compression NaN if tick_count < 100 (median still bootstrapping).
    volatility_compression NaN if vol_session_median == 0 (frozen zero guard).
    range_percent_20ticks NaN if median(price_20) ≤ 0 (feed error).
    spread_tightening_atm NaN if chain_available is False.

vol_session_median:
    Running median of rolling_std_20 values from ticks 21..100.
    Frozen at tick 100 for the rest of the session.
    Not persisted across sessions (reset() clears it).

Usage:
    comp = CompressionState()                  # per-session instance
    out  = comp.compute(buffer, opt_features, chain_available, atm_window)
    comp.reset()                               # call on session open/rollover
"""

from __future__ import annotations

import math
import statistics

from tick_feature_agent.buffers.tick_buffer import CircularBuffer

_NAN = float("nan")
_FREEZE_TICK = 100  # freeze vol_session_median after this many ticks


class CompressionState:
    """
    Per-session compression signal state.

    Keeps a rolling accumulator of rolling_std_20 values for the first 100
    ticks to compute vol_session_median.  Frozen after tick 100.
    """

    __slots__ = (
        "_tick_count",
        "_std_history",  # rolling_std_20 values seen so far (up to tick 100)
        "_vol_session_median",
        "_median_frozen",
    )

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        """Reset to session-start state.  Call on session open and rollover."""
        self._tick_count: int = 0
        self._std_history: list[float] = []
        self._vol_session_median: float = _NAN
        self._median_frozen: bool = False

    # ── Public API ────────────────────────────────────────────────────────────

    def compute(
        self,
        buffer: CircularBuffer,
        opt_features: dict[tuple[int, str], dict],  # from option_tick.compute_option_tick_features
        chain_available: bool,
        atm_window: list[int],
    ) -> dict:
        """
        Compute all §8.8 compression features for the current tick.

        Args:
            buffer:           Underlying 50-tick circular buffer (current tick pushed).
            opt_features:     Per-strike tick features from option_tick.py.
            chain_available:  True after first chain snapshot.
            atm_window:       7-element ATM ±3 strike list.

        Returns:
            Dict of 4 float features.
        """
        self._tick_count += 1
        n = len(buffer)

        out: dict = {
            "range_20ticks": _NAN,
            "range_percent_20ticks": _NAN,
            "volatility_compression": _NAN,
            "spread_tightening_atm": _NAN,
        }

        if n < 20:
            return out  # all NaN — buffer too small

        ticks = buffer.get_last(20)
        prices = [float(t.ltp) for t in ticks]

        # ── range_20ticks ──────────────────────────────────────────────────────
        price_max = max(prices)
        price_min = min(prices)
        range_20 = price_max - price_min
        out["range_20ticks"] = range_20

        # ── range_percent_20ticks ──────────────────────────────────────────────
        median_price = statistics.median(prices)
        if median_price > 0.0:
            out["range_percent_20ticks"] = range_20 / median_price
        # else stays NaN (feed error — prices ≤ 0)

        # ── rolling_std_20 ─────────────────────────────────────────────────────
        rolling_std = statistics.stdev(prices)  # sample std (ddof=1)

        # ── Update vol_session_median accumulator ─────────────────────────────
        if not self._median_frozen:
            # Accumulate rolling_std_20 values from ticks 21..100
            # (ticks 1..20 don't have a full 20-tick window yet; tick 21 is the
            #  first tick where n >= 20, i.e. tick_count == 21 internally.)
            self._std_history.append(rolling_std)
            if self._tick_count >= _FREEZE_TICK:
                if self._std_history:
                    self._vol_session_median = max(
                        statistics.median(self._std_history),
                        0.01,  # floor: 1 price-unit cent — prevents zero-division in flat markets
                    )
                self._median_frozen = True

        # ── volatility_compression = rolling_std / vol_session_median ─────────
        if self._median_frozen:
            vsm = self._vol_session_median
            if math.isnan(vsm) or vsm == 0.0:
                pass  # stays NaN (zero guard)
            else:
                out["volatility_compression"] = rolling_std / vsm
        # else: still bootstrapping → stays NaN

        # ── spread_tightening_atm ─────────────────────────────────────────────
        if chain_available:
            total_spread = 0.0
            for strike in atm_window:
                feat = opt_features.get((strike, "CE"), {})
                spread = feat.get("spread", _NAN)
                # Unticked strikes contribute 0.0 (tick_available=0 → spread=NaN → 0.0)
                total_spread += 0.0 if math.isnan(spread) else spread
            out["spread_tightening_atm"] = total_spread / 7.0  # denominator always 7
        # else chain not yet available → stays NaN

        return out

    @property
    def vol_session_median(self) -> float:
        return self._vol_session_median

    @property
    def median_frozen(self) -> bool:
        return self._median_frozen

    @property
    def tick_count(self) -> int:
        return self._tick_count
