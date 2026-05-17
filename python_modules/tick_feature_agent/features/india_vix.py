"""
india_vix.py — C3 vol-regime features (trend/swing spec §2.1.4 C3).

Pure function. Reads the current timestamp and a sparse history of
(epoch_seconds, vix_value) samples and emits 2 features that let every
gate condition behaviour on the volatility regime.

Features (2 outputs):
    india_vix                 Latest VIX value at-or-before now_ts
    india_vix_change_5min     india_vix − VIX value ~5 min before now_ts

Why these:
    Today the model sees no vol context — a 0.6% momentum spike on a
    VIX-11 day (drift) gets the same gate treatment as on a VIX-22 day
    (panic). The trend gate needs `india_vix` as a direct input; the
    L8 regime classifier (§2.8) uses both to detect vol expansion.

Buffering contract:
    Caller (tick_processor) maintains a small append-only history of
    (ts, vix) pairs for the current session. ~1 Hz publish rate from
    Dhan, so ≤ 6 hours × 3600 ≈ 22 K samples max — trivial memory.

Null rules:
    - Empty / None history → both NaN.
    - Only samples newer than now_ts in the history → both NaN
      (no current value yet).
    - Single sample available → india_vix populated, change_5min NaN.
    - 5-min baseline sample missing or staler than 60 s gap → change_5min NaN.
"""

from __future__ import annotations

import math

_NAN = float("nan")
_FIVE_MIN_SEC = 300.0
_BASELINE_TOLERANCE_SEC = 60.0


def _safe_ts(v: float | None) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0:
        return None
    return f


def _safe_vix(v: float | None) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0:
        return None
    return f


def compute_india_vix_features(
    now_ts: float | None,
    vix_history: list[tuple[float, float]] | None,
) -> dict[str, float]:
    """
    Compute india_vix + india_vix_change_5min.

    Args:
        now_ts:       Current epoch second (e.g. tick timestamp).
        vix_history:  List of (epoch_second, vix_value) pairs sorted
                      oldest → newest. May be empty / None. May contain
                      samples after now_ts (those are ignored).

    Returns:
        Dict with 2 float keys. NaN where input is missing or stale.
    """
    out: dict[str, float] = {
        "india_vix": _NAN,
        "india_vix_change_5min": _NAN,
    }

    now_v = _safe_ts(now_ts)
    if now_v is None or not vix_history:
        return out

    # Latest sample at-or-before now_ts is the current india_vix.
    # Walk backwards because history is appended in time order and we
    # almost always want the tail.
    current_ts: float | None = None
    current_vix: float | None = None
    for ts, vix in reversed(vix_history):
        ts_v = _safe_ts(ts)
        if ts_v is None or ts_v > now_v:
            continue
        vix_v = _safe_vix(vix)
        if vix_v is None:
            continue
        current_ts = ts_v
        current_vix = vix_v
        break

    if current_vix is None:
        return out

    out["india_vix"] = current_vix

    # Baseline = latest sample at-or-before (now_ts - 300s), within
    # _BASELINE_TOLERANCE_SEC of that target. Beyond tolerance the
    # change is unreliable (data gap, session start, etc.).
    target_ts = now_v - _FIVE_MIN_SEC
    baseline_vix: float | None = None
    for ts, vix in reversed(vix_history):
        ts_v = _safe_ts(ts)
        if ts_v is None or ts_v > target_ts:
            continue
        # First sample at-or-before target_ts. Check freshness.
        if target_ts - ts_v > _BASELINE_TOLERANCE_SEC:
            break  # too stale — leave NaN
        vix_v = _safe_vix(vix)
        if vix_v is None:
            break
        baseline_vix = vix_v
        break

    if baseline_vix is not None:
        out["india_vix_change_5min"] = current_vix - baseline_vix

    return out
