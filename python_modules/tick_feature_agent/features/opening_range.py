"""
opening_range.py — B5 opening-range features (spec §2.1.3 B5, D74 B3).

Stateful tracker that locks the high and low of the first 15 minutes of
each session, then exposes spot's % distance from those frozen extremes.
Opening-range breakouts are a well-documented Indian-market pattern;
this gives the swing gate a clean breakout / breakdown trigger.

Features (2 outputs):
    distance_to_opening_range_high_pct   (spot − or_high) / spot × 100
    distance_to_opening_range_low_pct    (spot − or_low)  / spot × 100

Sign convention:
    > 0  → spot is ABOVE the OR boundary
    = 0  → spot is exactly AT the boundary
    < 0  → spot is BELOW the boundary

Window spec (D74 B3, LOCKED 2026-05-17):
    NSE  09:15:00 – 09:29:59 IST (so window_end_ts = 09:30:00 IST)
    MCX  09:00:00 – 09:14:59 IST (so window_end_ts = 09:15:00 IST)

    Caller computes the exact window_end epoch second from the active
    InstrumentProfile and passes it to `state.configure()` at session
    start.

State lifecycle:
    1. Session start → `state.configure(window_end_ts)`.
    2. Every underlying tick → `state.update(ts, ltp)`. Ticks at or after
       window_end_ts are ignored (range is locked).
    3. Every emitter tick → `compute_opening_range_features(state, spot, now_ts)`.
    4. Session close → `state.reset()`.

Null rules:
    - state not configured → both NaN.
    - now_ts inside the forming window (now_ts < window_end_ts) → both NaN.
    - No in-window tick ever landed (state.or_high / or_low still None)
      → both NaN even after window passes (no range to compare against).
    - spot missing / invalid → both NaN.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

_NAN = float("nan")


def _safe_pos(v: float | None) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0:
        return None
    return f


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
class OpeningRangeState:
    """First-15-min high/low tracker for one trading session."""

    window_end_ts: float | None = None
    or_high: float | None = None
    or_low: float | None = None

    def configure(self, window_end_ts: float) -> None:
        """Bind the session's opening-range window end (exclusive bound).

        Clears any previous range extremes — call once per session start.
        """
        ts_v = _safe_float(window_end_ts)
        if ts_v is None:
            raise ValueError(f"window_end_ts must be finite, got {window_end_ts!r}")
        self.window_end_ts = ts_v
        self.or_high = None
        self.or_low = None

    def reset(self) -> None:
        self.window_end_ts = None
        self.or_high = None
        self.or_low = None

    def update(self, ts: float, ltp: float) -> None:
        """Fold a tick. Ticks at or after window_end_ts are ignored."""
        if self.window_end_ts is None:
            return
        ts_v = _safe_float(ts)
        ltp_v = _safe_pos(ltp)
        if ts_v is None or ltp_v is None:
            return
        if ts_v >= self.window_end_ts:
            return
        if self.or_high is None or ltp_v > self.or_high:
            self.or_high = ltp_v
        if self.or_low is None or ltp_v < self.or_low:
            self.or_low = ltp_v


def compute_opening_range_features(
    state: OpeningRangeState | None,
    spot: float | None,
    now_ts: float | None,
) -> dict[str, float]:
    """
    Compute the 2 B5 opening-range distance features.

    Returns dict with both keys; NaN where the window is still forming
    or inputs are missing.
    """
    out: dict[str, float] = {
        "distance_to_opening_range_high_pct": _NAN,
        "distance_to_opening_range_low_pct": _NAN,
    }

    if state is None or state.window_end_ts is None:
        return out
    if state.or_high is None or state.or_low is None:
        return out

    spot_v = _safe_pos(spot)
    now_v = _safe_float(now_ts)
    if spot_v is None or now_v is None:
        return out
    if now_v < state.window_end_ts:
        # Forming window — D74 B3 explicitly mandates NaN here.
        return out

    out["distance_to_opening_range_high_pct"] = (spot_v - state.or_high) / spot_v * 100.0
    out["distance_to_opening_range_low_pct"] = (spot_v - state.or_low) / spot_v * 100.0
    return out
