"""
expiry.py — Wave 1: Days-to-expiry / session-position features (Phase 1A Layer 1).

Pure function. Reads current timestamp, resolved expiry timestamp, today's
session bounds, and an is_monthly flag from the caller. Emits 5 features
that let the model learn theta-acceleration, gamma explosion, and IV crush
patterns near expiry.

Features (6 outputs):
    days_to_expiry          (expiry_ts - now_ts) / 86400; can be fractional
    hours_to_expiry         (expiry_ts - now_ts) / 3600; granular near expiry
    is_expiry_day           1 if today is the expiry date, else 0
    is_monthly_expiry       1 = monthly, 0 = weekly, NaN if caller didn't classify
    session_remaining_pct   today's session: 0 at close, 1 at open. NaN if bounds missing
    days_to_expiry_bucket   Categorical bucket ∈ {0, 1, 2, 3}, capped at 3.
                            Floor of days_to_expiry; "3" = "3-or-more days out".
                            Lets LightGBM learn discrete regime behaviour that
                            doesn't interpolate cleanly (0-DTE gamma cliff vs
                            1-DTE overnight risk vs 2-DTE mid-week calm vs 3+).
                            NaN before expiry data is available; also NaN once
                            days_to_expiry has gone negative (post-expiry).

Why these:
    - Theta is non-linear in DTE — at 1 DTE it's 5–10× stronger than at 5 DTE
    - Gamma explodes near expiry → SL/TP needs DTE-aware sizing
    - Monthly expiry has different liquidity / institutional flow than weekly
    - Session position captures intraday decay patterns (theta decays through the day)

Null rules:
    Any required timestamp missing/invalid → NaN for the affected output.
    is_monthly_expiry is_unknown → NaN (caller classifies).
"""

from __future__ import annotations

import math

_NAN = float("nan")
_SECONDS_PER_DAY = 86400.0
_SECONDS_PER_HOUR = 3600.0


def _safe_ts(v: float | None) -> float | None:
    """Validate that v is a finite, positive epoch second (or year-2000+ ms)."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0:
        return None
    return f


def compute_expiry_features(
    now_ts: float | None,
    expiry_ts: float | None,
    session_open_ts: float | None = None,
    session_end_ts: float | None = None,
    is_monthly: bool | None = None,
) -> dict[str, float]:
    """
    Compute 5 DTE / session features.

    Args:
        now_ts:           Current epoch second (e.g. from row['timestamp']).
        expiry_ts:        Epoch second of expiry-day session close (e.g. 15:30 IST
                          for NSE on the expiry calendar date).
        session_open_ts:  Epoch second of TODAY's session open (NSE 09:15, MCX 09:00).
        session_end_ts:   Epoch second of TODAY's session close (NSE 15:30, MCX 23:30).
        is_monthly:       True = monthly expiry, False = weekly, None = unknown.

    Returns:
        Dict with 5 keys, all floats. NaN where input is missing.
    """
    out: dict[str, float] = {
        "days_to_expiry": _NAN,
        "hours_to_expiry": _NAN,
        "is_expiry_day": _NAN,
        "is_monthly_expiry": _NAN,
        "session_remaining_pct": _NAN,
        "days_to_expiry_bucket": _NAN,
    }

    now_v = _safe_ts(now_ts)
    expiry_v = _safe_ts(expiry_ts)

    if now_v is not None and expiry_v is not None:
        delta_sec = expiry_v - now_v
        dte = delta_sec / _SECONDS_PER_DAY
        out["days_to_expiry"] = dte
        out["hours_to_expiry"] = delta_sec / _SECONDS_PER_HOUR
        # is_expiry_day: same calendar day in IST (caller's session window
        # already implies the IST calendar; we approximate via |delta| < 1 day
        # which is correct because expiry_ts is session-close on expiry date).
        out["is_expiry_day"] = 1.0 if 0.0 <= delta_sec <= _SECONDS_PER_DAY else 0.0
        # DTE bucket: floor + cap at 3. Only emit for non-negative DTE
        # (post-expiry the bucket has no meaningful interpretation).
        if dte >= 0.0:
            out["days_to_expiry_bucket"] = float(min(3, int(dte)))

    if is_monthly is not None:
        out["is_monthly_expiry"] = 1.0 if is_monthly else 0.0

    open_v = _safe_ts(session_open_ts)
    end_v = _safe_ts(session_end_ts)
    if now_v is not None and open_v is not None and end_v is not None and end_v > open_v:
        # Fraction of session REMAINING. 1.0 at open, 0.0 at close.
        elapsed = now_v - open_v
        total = end_v - open_v
        remaining = (total - elapsed) / total
        out["session_remaining_pct"] = max(0.0, min(1.0, remaining))

    return out
