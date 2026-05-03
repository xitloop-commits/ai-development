"""
time_to_move.py — §8.11 Time-to-Move Signals.

Stateful class: tracks session history for running median velocity, last big
move timestamp, and stagnation/momentum persistence state machines.

Features (5 outputs):
    time_since_last_big_move     Seconds since abs(velocity) > 2×median_velocity
                                 NaN for ticks 1–2; NaN until first big move occurs
    stagnation_duration_sec      Seconds since last price change > 0.1% LTP
                                 Never null; always ≥ 0; capped at 300s
    momentum_persistence_ticks   Length of longest consecutive same-direction run
                                 ending at current tick within last 20 ticks; ≥ 1
    breakout_readiness           0.0 or 1.0 — fires in RANGE + compression + stagnation
    breakout_readiness_extended  0.0 or 1.0 — fires in RANGE/NEUTRAL + zone confirmation

Spec constants (hardcoded):
    COMPRESSION_THRESHOLD      = 0.4
    STAGNATION_THRESHOLD_SEC   = 10
    MOMENTUM_PERSISTENCE_THRESHOLD = 3
    ZONE_PRESSURE_MIN          = 0.3
    DEAD_SCORE_MAX             = 0.5
    STAGNATION_CAP_SEC         = 300
    STAGNATION_PRICE_THRESHOLD = 0.001  (0.1% of LTP)

Usage:
    ttm = TimeToMoveState()
    out = ttm.compute(current_tick, velocity, regime, zone_call_pressure,
                      zone_put_pressure, dead_market_score, vol_compression)
    ttm.reset()   # on session open / rollover
"""

from __future__ import annotations

import math

_NAN = float("nan")

# Hardcoded spec constants
_COMPRESSION_THRESHOLD = 0.4
_STAGNATION_THRESHOLD_SEC = 10.0
_MOMENTUM_PERSISTENCE_THRESHOLD = 3
_ZONE_PRESSURE_MIN = 0.3
_DEAD_SCORE_MAX = 0.5
_STAGNATION_CAP_SEC = 300.0
_STAGNATION_PRICE_THRESHOLD = 0.001  # 0.1% of LTP


class TimeToMoveState:
    """
    Per-session state for time-to-move signals.
    """

    __slots__ = (
        "_tick_count",
        "_velocity_history",  # abs(velocity) for all session ticks
        "_last_big_move_ts",  # wall-clock ts of last big move (None = none yet)
        "_stagnation_sec",  # current stagnation counter
        "_persist_direction",  # current streak direction (-1, 0, +1)
        "_persist_length",  # current streak length
    )

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        """Reset to session-start state."""
        self._tick_count: int = 0
        self._velocity_history: list[float] = []
        self._last_big_move_ts: float | None = None
        self._stagnation_sec: float = 0.0
        self._persist_direction: int = 0  # UNDEFINED on tick 1
        self._persist_length: int = 1

    # ── Public API ────────────────────────────────────────────────────────────

    def compute(
        self,
        ltp: float,
        prev_ltp: float | None,
        timestamp: float,
        velocity: float,
        time_diff_sec: float,
        regime: str | None,
        vol_compression: float,
        zone_call_pressure: float,
        zone_put_pressure: float,
        dead_market_score: float,
    ) -> dict:
        """
        Compute §8.11 time-to-move features for the current tick.

        Args:
            ltp:                 Current last traded price.
            prev_ltp:            Previous tick's LTP (None on tick 1).
            timestamp:           Unix epoch of current tick.
            velocity:            Current tick's velocity (NaN for ticks 1–2).
            time_diff_sec:       Elapsed seconds since previous tick (0 on tick 1).
            regime:              Current regime string or None (warm-up).
            vol_compression:     volatility_compression (NaN during warm-up).
            zone_call_pressure:  atm_zone_call_pressure (NaN if no chain).
            zone_put_pressure:   atm_zone_put_pressure (NaN if no chain).
            dead_market_score:   dead_market_score (NaN until tick 100).

        Returns:
            Dict of 5 features.
        """
        self._tick_count += 1

        out: dict = {
            "time_since_last_big_move": _NAN,
            "stagnation_duration_sec": 0.0,
            "momentum_persistence_ticks": 1,
            "breakout_readiness": 0.0,
            "breakout_readiness_extended": 0.0,
        }

        # ── Update velocity history for running median ─────────────────────────
        if not math.isnan(velocity):
            self._velocity_history.append(abs(velocity))

        # ── Compute running median velocity (valid from tick 3 onward) ─────────
        median_vel = _NAN
        if len(self._velocity_history) >= 2:
            vels = sorted(self._velocity_history)
            n = len(vels)
            median_vel = vels[n // 2] if n % 2 == 1 else (vels[n // 2 - 1] + vels[n // 2]) / 2.0

        # ── time_since_last_big_move ───────────────────────────────────────────
        if self._tick_count >= 3 and not math.isnan(velocity) and not math.isnan(median_vel):
            if median_vel == 0.0:
                pass  # no threshold — stays NaN
            else:
                if abs(velocity) > 2.0 * median_vel:
                    self._last_big_move_ts = timestamp
                if self._last_big_move_ts is not None:
                    out["time_since_last_big_move"] = timestamp - self._last_big_move_ts

        # ── stagnation_duration_sec ────────────────────────────────────────────
        if prev_ltp is None or prev_ltp == 0.0:
            # Tick 1: no prior tick
            self._stagnation_sec = 0.0
        else:
            price_change_pct = abs(ltp - prev_ltp) / prev_ltp
            if price_change_pct > _STAGNATION_PRICE_THRESHOLD:
                self._stagnation_sec = 0.0
            else:
                self._stagnation_sec = min(
                    self._stagnation_sec + time_diff_sec,
                    _STAGNATION_CAP_SEC,
                )
        out["stagnation_duration_sec"] = self._stagnation_sec

        # ── momentum_persistence_ticks ─────────────────────────────────────────
        if self._tick_count == 1 or prev_ltp is None:
            # Tick 1: no direction yet
            self._persist_direction = 0  # UNDEFINED
            self._persist_length = 1
        else:
            diff = ltp - prev_ltp
            direction = 1 if diff > 0 else (-1 if diff < 0 else 0)
            if direction == 0:
                # Flat: carry forward unchanged
                pass
            elif self._persist_direction == 0:
                # First non-flat tick: set direction, length = 2 (includes tick 1)
                self._persist_direction = direction
                self._persist_length = 2
            elif direction == self._persist_direction:
                self._persist_length += 1
            else:
                # Direction change
                self._persist_direction = direction
                self._persist_length = 1
        out["momentum_persistence_ticks"] = self._persist_length

        # ── breakout_readiness ─────────────────────────────────────────────────
        if (
            regime is not None
            and not math.isnan(vol_compression)
            and regime == "RANGE"
            and vol_compression < _COMPRESSION_THRESHOLD
            and self._stagnation_sec > _STAGNATION_THRESHOLD_SEC
            and self._persist_length > _MOMENTUM_PERSISTENCE_THRESHOLD
        ):
            out["breakout_readiness"] = 1.0

        # ── breakout_readiness_extended ────────────────────────────────────────
        if (
            regime is not None
            and not math.isnan(vol_compression)
            and not math.isnan(zone_call_pressure)
            and not math.isnan(dead_market_score)
            and regime in ("RANGE", "NEUTRAL")
            and vol_compression < _COMPRESSION_THRESHOLD
            and self._stagnation_sec > _STAGNATION_THRESHOLD_SEC
            and max(zone_call_pressure, zone_put_pressure) > _ZONE_PRESSURE_MIN
            and dead_market_score < _DEAD_SCORE_MAX
        ):
            out["breakout_readiness_extended"] = 1.0

        return out

    @property
    def tick_count(self) -> int:
        return self._tick_count
