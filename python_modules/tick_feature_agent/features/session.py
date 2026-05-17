"""
session.py — B3 session-relative features (spec §2.1.3 B3).

Stateful session tracker that watches the underlying ticks across a
trading session and exposes 4 features so the gate can read where spot
is sitting inside the day's range and how stale the day's extremes
have become.

Features (4 outputs):
    dist_from_session_open_pct   (spot − session_open) / session_open × 100
    dist_from_session_vwap_pct   (spot − session_vwap) / session_vwap × 100
                                 VWAP weighted by tick_volume across the
                                 session. NaN until session has seen any
                                 positive tick_volume (NSE indices that
                                 don't publish volume → permanently NaN
                                 for this feature — caller can substitute
                                 a proxy if/when needed).
    session_high_age_min         Minutes elapsed since the latest tick whose
                                 LTP equalled or exceeded the running session
                                 high. 0.0 at the moment of a fresh-high tick.
    session_low_age_min          Mirror for session low.

State lifecycle:
    1. Construct `SessionState()` (empty) at session start.
    2. Call `state.update(ts, ltp, tick_volume)` on every underlying tick.
    3. Call `compute_session_features(state, now_ts)` per emitter tick.
    4. Call `state.reset()` at session close / rollover before the next session.

Null rules:
    - All features NaN until the FIRST valid tick has been ingested.
    - dist_from_session_vwap_pct stays NaN until cumulative volume > 0.
    - now_ts must be finite and ≥ the most recent update ts, otherwise
      *_age_min returns NaN (we don't extrapolate ages into the past).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

_NAN = float("nan")
_SECONDS_PER_MINUTE = 60.0


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
class SessionState:
    """Per-session OHLC + VWAP accumulator for the underlying."""

    open_price: float | None = None
    open_ts: float | None = None
    last_ts: float | None = None
    session_high: float | None = None
    session_high_ts: float | None = None
    session_low: float | None = None
    session_low_ts: float | None = None
    cum_value: float = 0.0   # Σ ltp · tick_volume
    cum_volume: float = 0.0

    def reset(self) -> None:
        self.open_price = None
        self.open_ts = None
        self.last_ts = None
        self.session_high = None
        self.session_high_ts = None
        self.session_low = None
        self.session_low_ts = None
        self.cum_value = 0.0
        self.cum_volume = 0.0

    def update(self, ts: float, ltp: float, tick_volume: float = 0.0) -> None:
        ts_v = _safe_float(ts)
        ltp_v = _safe_pos(ltp)
        if ts_v is None or ltp_v is None:
            return
        # Reject backwards-time ticks. A late-arriving tick whose ts is
        # before the most recent forward tick would otherwise corrupt
        # session_high / session_low / cum_value (caught by Test-24
        # no-lookahead suite, 2026-05-17). Matches the guards in
        # BarAggregator and OiDominanceState.
        if self.last_ts is not None and ts_v < self.last_ts:
            return
        vol_v = _safe_float(tick_volume) or 0.0
        if vol_v < 0:
            vol_v = 0.0

        if self.open_price is None:
            # First tick: seed everything.
            self.open_price = ltp_v
            self.open_ts = ts_v
            self.session_high = ltp_v
            self.session_high_ts = ts_v
            self.session_low = ltp_v
            self.session_low_ts = ts_v
        else:
            # Extremes — capture latest touch of an equal-or-better value.
            if ltp_v >= self.session_high:
                self.session_high = ltp_v
                self.session_high_ts = ts_v
            if ltp_v <= self.session_low:
                self.session_low = ltp_v
                self.session_low_ts = ts_v

        self.last_ts = ts_v
        if vol_v > 0:
            self.cum_value += ltp_v * vol_v
            self.cum_volume += vol_v

    @property
    def vwap(self) -> float | None:
        if self.cum_volume <= 0:
            return None
        return self.cum_value / self.cum_volume


def compute_session_features(
    state: SessionState | None,
    spot: float | None,
    now_ts: float | None,
) -> dict[str, float]:
    """
    Compute the 4 B3 session-relative features.

    Args:
        state:   Live SessionState fed via .update() on each underlying tick.
        spot:    Current underlying spot (typically the latest LTP).
        now_ts:  Current epoch second (for *_age_min computation).

    Returns:
        Dict of 4 float features. NaN where the session hasn't started
        or the inputs are invalid.
    """
    out: dict[str, float] = {
        "dist_from_session_open_pct": _NAN,
        "dist_from_session_vwap_pct": _NAN,
        "session_high_age_min": _NAN,
        "session_low_age_min": _NAN,
    }

    if state is None or state.open_price is None:
        return out

    spot_v = _safe_pos(spot)

    if spot_v is not None and state.open_price > 0:
        out["dist_from_session_open_pct"] = (spot_v - state.open_price) / state.open_price * 100.0

    vwap = state.vwap
    if spot_v is not None and vwap is not None and vwap > 0:
        out["dist_from_session_vwap_pct"] = (spot_v - vwap) / vwap * 100.0

    now_v = _safe_float(now_ts)
    if now_v is not None:
        if state.session_high_ts is not None and now_v >= state.session_high_ts:
            out["session_high_age_min"] = max(
                0.0, (now_v - state.session_high_ts) / _SECONDS_PER_MINUTE
            )
        if state.session_low_ts is not None and now_v >= state.session_low_ts:
            out["session_low_age_min"] = max(
                0.0, (now_v - state.session_low_ts) / _SECONDS_PER_MINUTE
            )

    return out
