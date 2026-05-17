"""
intraday_time.py — C6 intraday-timing features (V2_MASTER_SPEC §2.1.4 C6).

Pure function. Reads the current tick timestamp and today's session bounds
and emits 3 features that let every gate condition behaviour on where we
are inside the trading day.

Features (3 outputs):
    minutes_from_open      (now_ts − session_open_ts) / 60. Clamp to ≥ 0
                           (pre-market ticks → 0). NaN if either timestamp
                           is missing/invalid.
    minutes_to_close       (session_close_ts − now_ts) / 60. Clamp to ≥ 0
                           (post-close ticks → 0). NaN if either timestamp
                           is missing/invalid.
    lunch_session_flag     1.0 if the current IST clock hour is 12 (i.e.
                           local time ∈ [12:00, 13:00)), else 0.0. NaN if
                           now_ts is missing/invalid.

Why these:
    The trend / swing gate today has no notion of time-of-day, so 09:20
    (noisy open) and 13:30 (lunch chop) get identical treatment. These
    three features let the model learn that:
      - The first 15–30 minutes carry open-auction noise that should
        damp aggressive entries (minutes_from_open small).
      - The last 30–60 minutes are theta-heavy and benefit from tighter
        TPs (minutes_to_close small).
      - The IST 12:00–13:00 lunch hour has lower participation across
        both NSE and MCX — explicit flag lets the model down-weight
        otherwise-clean signals.

Lunch flag is intentionally clock-based (IST hour ∈ {12}), not
session-relative — NSE (09:15–15:30) and MCX (09:00–23:30) both observe
the same lunch lull around midday IST.

Null rules:
    Any required timestamp missing/invalid → NaN for the affected output.
    `minutes_from_open` and `minutes_to_close` need now_ts AND their
    respective session bound; `lunch_session_flag` only needs now_ts.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

_NAN = float("nan")
_SECONDS_PER_MINUTE = 60.0
_IST = timezone(timedelta(hours=5, minutes=30))
_LUNCH_HOUR_IST = 12  # local hour ∈ [12:00, 13:00)


def _safe_ts(v: float | None) -> float | None:
    """Validate that v is a finite, positive epoch second."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0:
        return None
    return f


def _safe_pos(v: float) -> float:
    """Clamp a delta-in-minutes to ≥ 0 (pre/post-session ticks)."""
    return v if v >= 0.0 else 0.0


def compute_intraday_time_features(
    now_ts: float | None,
    session_open_ts: float | None,
    session_close_ts: float | None,
) -> dict[str, float]:
    """
    Compute 3 intraday-timing features.

    Args:
        now_ts:            Current epoch second (e.g. tick timestamp).
        session_open_ts:   Epoch second of TODAY's session open
                           (NSE 09:15, MCX 09:00).
        session_close_ts:  Epoch second of TODAY's session close
                           (NSE 15:30, MCX 23:30).

    Returns:
        Dict with 3 float keys. NaN where input is missing/invalid.
    """
    out: dict[str, float] = {
        "minutes_from_open": _NAN,
        "minutes_to_close": _NAN,
        "lunch_session_flag": _NAN,
    }

    now_v = _safe_ts(now_ts)
    open_v = _safe_ts(session_open_ts)
    close_v = _safe_ts(session_close_ts)

    if now_v is not None and open_v is not None:
        out["minutes_from_open"] = _safe_pos((now_v - open_v) / _SECONDS_PER_MINUTE)

    if now_v is not None and close_v is not None:
        out["minutes_to_close"] = _safe_pos((close_v - now_v) / _SECONDS_PER_MINUTE)

    if now_v is not None:
        # Convert epoch → IST clock and check hour bucket.
        ist_dt = datetime.fromtimestamp(now_v, tz=_IST)
        out["lunch_session_flag"] = 1.0 if ist_dt.hour == _LUNCH_HOUR_IST else 0.0

    return out
