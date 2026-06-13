"""
premium_acceleration.py — T14 (scope F, 2026-06-13) ATM premium-acceleration
drop detector.

The existing parquet exposes `opt_0_ce_premium_momentum` (first derivative
of ATM call premium over 5 ticks) and the PE equivalent. Per V2 spec
deferred L1 list, the SECOND derivative (acceleration_drop) is also
useful — it catches the moment a fast-rising premium stops rising,
which often precedes a directional move reversal.

LightGBM can't compose this cheaply from snapshot rows alone because
it requires comparing the current row's momentum to the PREVIOUS
row's momentum. Stateful classes are the natural way to thread that
information through the tick stream.

Features emitted (per call):
    premium_acceleration_drop_atm_ce
    premium_acceleration_drop_atm_pe

Semantics:
    drop = max(0, prev_momentum - cur_momentum)  WHEN prev_momentum > 0
    drop = NaN                                    WHEN prev_momentum is None / NaN
    drop = 0                                      otherwise

The "only when prev was positive" guard interprets the feature as
"premium WAS gaining and slowed down." Negative momentum (premium
falling) accelerating further negative is a different signal that
existing momentum features already expose.
"""

from __future__ import annotations

import math

_NAN = float("nan")


class PremiumAccelerationState:
    """One instance per session — reset on session_start / expiry rollover.

    Tracks the previous tick's ATM CE + PE premium_momentum so the
    second derivative can be derived per emit.
    """

    __slots__ = ("_prev_ce_momentum", "_prev_pe_momentum")

    def __init__(self) -> None:
        self._prev_ce_momentum: float | None = None
        self._prev_pe_momentum: float | None = None

    def reset(self) -> None:
        self._prev_ce_momentum = None
        self._prev_pe_momentum = None

    def update(
        self,
        ce_momentum: float | None,
        pe_momentum: float | None,
    ) -> dict[str, float]:
        """Fold one emit's ATM premium momentums into the state, return
        the acceleration-drop values.

        Args:
            ce_momentum: current ATM CE premium_momentum (NaN allowed
                during warmup / staleness).
            pe_momentum: current ATM PE premium_momentum.

        Returns:
            Dict with two float keys. NaN on the first valid reading
            (no prev), 0 when prev was non-positive, magnitude of the
            drop when prev was positive and current is lower.
        """
        ce_drop = _drop_signal(self._prev_ce_momentum, ce_momentum)
        pe_drop = _drop_signal(self._prev_pe_momentum, pe_momentum)

        # Update prev only when current is a valid number — NaN inputs
        # don't overwrite the last good reading so a single warmup gap
        # doesn't wipe state forever.
        if ce_momentum is not None and not _isnan(ce_momentum):
            self._prev_ce_momentum = float(ce_momentum)
        if pe_momentum is not None and not _isnan(pe_momentum):
            self._prev_pe_momentum = float(pe_momentum)

        return {
            "premium_acceleration_drop_atm_ce": ce_drop,
            "premium_acceleration_drop_atm_pe": pe_drop,
        }


def _isnan(v) -> bool:
    return isinstance(v, float) and math.isnan(v)


def _drop_signal(prev: float | None, cur: float | None) -> float:
    """Pure helper for the drop math. Extracted so tests can hit it
    directly without constructing the state class.

    Drop = max(0, prev - cur) when prev > 0 AND cur is a valid number.
    NaN when prev is None / NaN.
    0 when prev <= 0 (semantic guard: not interesting).
    """
    if prev is None or _isnan(prev):
        return _NAN
    if cur is None or _isnan(cur):
        return _NAN
    if prev <= 0:
        return 0.0
    if cur >= prev:
        return 0.0
    return float(prev - cur)
