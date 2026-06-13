"""
strike_migration_persistence.py — T14 (scope F, 2026-06-13) consecutive-tick
counter for the active strike's migration direction.

The existing parquet exposes `active_strike_shift_direction` ∈ {−1, 0,
+1, NaN} — the instantaneous shift direction since 5-min-ago. Per V2
spec deferred L1 list, a COUNTER of "how many ticks has the strike
been migrating the same way" is also useful: a long sustained
migration is qualitatively different from a one-tick blip.

This module mirrors the existing `momentum_persistence_ticks` pattern
(time_to_move.py) — same rule, different input.

Feature emitted:
    strike_migration_persistence_ticks    integer ≥ 0, or NaN

Semantics:
    direction ∈ {+1, -1}, matches prev          → counter + 1
    direction ∈ {+1, -1}, differs from prev     → reset to 1
    direction == 0  (no shift this tick)        → reset to 0
    direction is NaN (insufficient history)     → counter held; output NaN

Reset on session_start / expiry rollover via reset().
"""

from __future__ import annotations

import math

_NAN = float("nan")


class StrikeMigrationPersistenceState:
    __slots__ = ("_prev_direction", "_count")

    def __init__(self) -> None:
        self._prev_direction: float | None = None
        self._count: int = 0

    def reset(self) -> None:
        self._prev_direction = None
        self._count = 0

    def update(self, direction: float | None) -> float:
        """Fold one emit's shift direction into the counter, return the
        current persistence count as a float (or NaN before the first
        valid reading).

        Args:
            direction: ``active_strike_shift_direction`` for this tick
                (−1.0, 0.0, +1.0, or NaN / None during warmup).

        Returns:
            Float counter. NaN until at least one valid direction has
            landed; 0.0 when this tick's direction is 0 (no shift);
            otherwise 1.0+ for the consecutive-same-direction run.
        """
        if direction is None or (isinstance(direction, float) and math.isnan(direction)):
            # Hold state; downstream emits NaN until next valid reading.
            if self._prev_direction is None:
                return _NAN
            return float(self._count)

        d = float(direction)
        if d == 0.0:
            # Explicit no-shift this tick: counter snaps to 0 and the
            # prev direction is wiped so the next non-zero direction
            # starts a fresh run, not a continuation.
            self._prev_direction = 0.0
            self._count = 0
            return 0.0

        # d is +1 or -1.
        if self._prev_direction is None or self._prev_direction != d:
            # Fresh run (first ever, transitioned from 0, or flipped sign).
            self._count = 1
        else:
            self._count += 1
        self._prev_direction = d
        return float(self._count)
