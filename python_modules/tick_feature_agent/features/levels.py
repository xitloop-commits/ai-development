"""
levels.py — Wave 1: S/R distance features (Phase 1A Layer 1).

Pure function. Reads already-parsed Dhan data (day OHLC, prev_close,
chain rows) and emits 8 distance/level features for the model and gate.

Features (8 outputs):
    distance_to_day_high_pct           (spot - day_high) / day_high * 100
    distance_to_day_low_pct            (spot - day_low) / day_low * 100
    distance_to_prev_close_pct         (spot - prev_close) / prev_close * 100
    day_range_position                 (spot - day_low) / (day_high - day_low)  ∈ [0, 1]
    max_call_oi_strike                 strike with highest CE OI (resistance proxy)
    max_put_oi_strike                  strike with highest PE OI (support proxy)
    distance_to_max_call_oi_strike_pct (spot - strike) / spot * 100
    distance_to_max_put_oi_strike_pct  (spot - strike) / spot * 100

Sign convention:
    distance_to_X_pct < 0  → spot is BELOW level X
    distance_to_X_pct = 0  → spot is AT level X
    distance_to_X_pct > 0  → spot is ABOVE level X

Null rules:
    Any feature requiring a missing input → NaN (never 0).
    Day-high/low/prev_close come from Dhan quote/PrevClose packets;
    None or 0 from broker → emit NaN here.
"""

from __future__ import annotations

import math
from collections.abc import Iterable

_NAN = float("nan")


def _safe_pos(v: float | None) -> float | None:
    """Return v iff finite and > 0; else None. Used for divisor guards."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0:
        return None
    return f


def compute_level_features(
    spot: float | None,
    day_high: float | None,
    day_low: float | None,
    prev_close: float | None,
    chain_rows: Iterable[dict] | None,
) -> dict[str, float]:
    """
    Compute 8 S/R distance features.

    Args:
        spot:        Current underlying spot price (NSE: index, MCX: futures).
        day_high:    Day's high so far (from Dhan quote/full packet).
        day_low:     Day's low so far.
        prev_close:  Previous trading day's close (from PrevClose packet).
        chain_rows:  Iterable of chain row dicts with keys
                     "strike", "callOI", "putOI". None → OI features NaN.

    Returns:
        Dict with 8 keys, all floats. NaN where input is missing.
    """
    out: dict[str, float] = {
        "distance_to_day_high_pct": _NAN,
        "distance_to_day_low_pct": _NAN,
        "distance_to_prev_close_pct": _NAN,
        "day_range_position": _NAN,
        "max_call_oi_strike": _NAN,
        "max_put_oi_strike": _NAN,
        "distance_to_max_call_oi_strike_pct": _NAN,
        "distance_to_max_put_oi_strike_pct": _NAN,
    }

    spot_pos = _safe_pos(spot)
    dh_pos = _safe_pos(day_high)
    dl_pos = _safe_pos(day_low)
    pc_pos = _safe_pos(prev_close)

    # Day OHLC distances
    if spot_pos is not None and dh_pos is not None:
        out["distance_to_day_high_pct"] = (spot_pos - dh_pos) / dh_pos * 100.0
    if spot_pos is not None and dl_pos is not None:
        out["distance_to_day_low_pct"] = (spot_pos - dl_pos) / dl_pos * 100.0
    if spot_pos is not None and pc_pos is not None:
        out["distance_to_prev_close_pct"] = (spot_pos - pc_pos) / pc_pos * 100.0

    # Day-range position (0=at low, 1=at high)
    if spot_pos is not None and dh_pos is not None and dl_pos is not None and dh_pos > dl_pos:
        pos = (spot_pos - dl_pos) / (dh_pos - dl_pos)
        # Clamp to [0, 1] to handle pre-market or feed glitches where spot
        # may briefly fall outside [day_low, day_high]
        out["day_range_position"] = max(0.0, min(1.0, pos))

    # OI walls — find strike with max call OI (resistance) and max put OI (support)
    if chain_rows is not None:
        rows = [r for r in chain_rows if isinstance(r, dict) and r.get("strike") is not None]
        if rows:
            try:
                max_call_row = max(rows, key=lambda r: float(r.get("callOI") or 0))
                max_put_row = max(rows, key=lambda r: float(r.get("putOI") or 0))
                call_strike = float(max_call_row["strike"])
                put_strike = float(max_put_row["strike"])
                # Only emit if at least one row had non-zero OI on that side;
                # all-zero OI means chain hasn't received its first OI tick yet
                if float(max_call_row.get("callOI") or 0) > 0:
                    out["max_call_oi_strike"] = call_strike
                    if spot_pos is not None:
                        out["distance_to_max_call_oi_strike_pct"] = (spot_pos - call_strike) / spot_pos * 100.0
                if float(max_put_row.get("putOI") or 0) > 0:
                    out["max_put_oi_strike"] = put_strike
                    if spot_pos is not None:
                        out["distance_to_max_put_oi_strike_pct"] = (spot_pos - put_strike) / spot_pos * 100.0
            except (TypeError, ValueError):
                # Malformed chain row → leave as NaN
                pass

    return out
