"""
oi_dominance.py — C1 OI-dominance persistence feature (V2_MASTER_SPEC §2.1.4).

Stateful tracker that watches the sign of (call_oi_change − put_oi_change)
across chain-poll cycles (~5 s cadence) and exposes a SIGNED minute counter
of how long the currently-dominant side has held its lead.

The gate already sees today's PCR snapshot, but it cannot tell whether the
imbalance is a fresh kink (last tick) or a durable two-hour drift — the
persistence carries different meaning. This feature emits that persistence
so the model can condition on durable sentiment.

Feature (1 output):
    oi_dominance_streak_min   Signed minute counter of continuous OI
                              dominance. Positive ⇒ call-side dominance,
                              negative ⇒ put-side dominance, 0.0 on
                              neutral / first sample / freshly flipped.

Sign convention (LOCKED 2026-05-17, V2_MASTER_SPEC D74 W4):
    > 0  → call-side OI-change dominance (calls being added faster)
    < 0  → put-side OI-change dominance (puts being added faster)
    = 0  → neutral, first sample, or freshly flipped this tick

Cap:
    Magnitude capped at 240.0 minutes (4 hours). Once a streak reaches the
    cap, further elapsed time does NOT push it past — the cap is applied
    inside `compute_oi_dominance_features`, not on the state itself, so the
    state remains honest.

State lifecycle:
    1. Construct `OiDominanceState()` at session start.
    2. Every chain-poll cycle → `state.update(ts, oi_change_call, oi_change_put)`.
    3. Every emitter tick → `compute_oi_dominance_features(state)`.
    4. Session close → `state.reset()`.

Null rules:
    - state is None → NaN.
    - Otherwise → 0.0 on neutral / cold / freshly-flipped, else signed elapsed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

_NAN = float("nan")
_SECONDS_PER_MINUTE = 60.0
_STREAK_CAP_MIN = 240.0


def _safe_float(v) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return f


@dataclass
class OiDominanceState:
    """Tracks the sign of OI-change dominance and how long it has held."""

    current_side: int = 0          # +1 = call-dominant, -1 = put-dominant, 0 = neutral
    streak_start_ts: float | None = None
    last_update_ts: float | None = None

    def reset(self) -> None:
        self.current_side = 0
        self.streak_start_ts = None
        self.last_update_ts = None

    def update(
        self,
        ts: float,
        oi_change_call: float,
        oi_change_put: float,
    ) -> None:
        """Fold one chain-poll observation.

        Determines the sign of (call_change − put_change) and either
        extends the running streak (last_update_ts advances) or restarts
        it (streak_start_ts resets, current_side flips).

        Silently ignores updates whose ts goes backwards or whose OI
        deltas are non-finite — matches the paranoid style of the other
        feature modules.
        """
        ts_v = _safe_float(ts)
        call_v = _safe_float(oi_change_call)
        put_v = _safe_float(oi_change_put)
        if ts_v is None or call_v is None or put_v is None:
            return
        if self.last_update_ts is not None and ts_v < self.last_update_ts:
            # ts went backwards — ignore silently.
            return

        if call_v > put_v:
            new_side = 1
        elif put_v > call_v:
            new_side = -1
        else:
            new_side = 0

        if new_side != self.current_side:
            # Side changed (including → neutral or ← neutral) — restart streak.
            self.current_side = new_side
            self.streak_start_ts = ts_v
        # If side matched, streak_start_ts is preserved; only last_update_ts advances.

        self.last_update_ts = ts_v


def compute_oi_dominance_features(
    state: OiDominanceState | None,
) -> dict[str, float]:
    """Compute the C1 OI-dominance persistence feature.

    Returns:
        {"oi_dominance_streak_min": float}
        - NaN if state is None.
        - 0.0 on neutral / cold / freshly-flipped (current_side == 0
          OR streak_start_ts is None OR no elapsed time yet).
        - Otherwise current_side · min(elapsed_min, 240.0).
    """
    out: dict[str, float] = {"oi_dominance_streak_min": _NAN}

    if state is None:
        return out

    if (
        state.current_side == 0
        or state.streak_start_ts is None
        or state.last_update_ts is None
    ):
        out["oi_dominance_streak_min"] = 0.0
        return out

    elapsed_sec = state.last_update_ts - state.streak_start_ts
    if elapsed_sec <= 0:
        out["oi_dominance_streak_min"] = 0.0
        return out

    elapsed_min = elapsed_sec / _SECONDS_PER_MINUTE
    capped = min(elapsed_min, _STREAK_CAP_MIN)
    out["oi_dominance_streak_min"] = float(state.current_side) * capped
    return out
