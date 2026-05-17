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

Max-pain features (C10, spec §2.1.4):
    max_pain_strike                    Strike that minimises total option-holder payout
    distance_to_max_pain_pct           Signed % distance from spot to max-pain strike
    max_pain_gravity_strength          OI within ±2% of max-pain ÷ total chain OI ∈ [0, 1]

Cross-day-state level features (B5, spec §2.1.3):
    distance_to_prev_day_high_pct      (spot − prev_day_high) / spot * 100
    distance_to_prev_day_low_pct       (spot − prev_day_low)  / spot * 100
    distance_to_round_number_above_pct (spot − nearest_round_above) / spot * 100  (≤ 0)
    distance_to_round_number_below_pct (spot − nearest_round_below) / spot * 100  (≥ 0)
    distance_to_5d_swing_high_pct      (spot − swing_5d_high) / spot * 100
    distance_to_5d_swing_low_pct       (spot − swing_5d_low)  / spot * 100

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


_GRAVITY_BAND_PCT = 0.02  # ±2% of spot defines the "near max-pain" window


def compute_max_pain_features(
    spot: float | None,
    chain_rows: Iterable[dict] | None,
) -> dict[str, float]:
    """
    Compute 3 C10 max-pain features.

    Max pain = the settlement strike K_s that MINIMISES total payout to
    option HOLDERS at expiry:

        payout(K_s) = Σ_K callOI(K)·max(K_s − K, 0) + Σ_K putOI(K)·max(K − K_s, 0)

    Spot tends to gravitate toward this strike near expiry (the "pin").
    Gravity strength = fraction of total chain OI sitting within ±2% of
    spot from the max-pain strike. Higher = stronger pinning pressure.

    Args:
        spot:        Current underlying spot price.
        chain_rows:  Iterable of chain row dicts with strike / callOI / putOI.

    Returns:
        Dict with 3 keys. NaN where input is missing or chain is empty.
    """
    out: dict[str, float] = {
        "max_pain_strike": _NAN,
        "distance_to_max_pain_pct": _NAN,
        "max_pain_gravity_strength": _NAN,
    }

    spot_pos = _safe_pos(spot)
    if chain_rows is None:
        return out

    # Materialise + validate rows once.
    clean: list[tuple[float, float, float]] = []  # (strike, callOI, putOI)
    total_oi = 0.0
    for r in chain_rows:
        if not isinstance(r, dict):
            continue
        strike = _safe_pos(r.get("strike"))
        if strike is None:
            continue
        try:
            c_oi = max(0.0, float(r.get("callOI") or 0))
            p_oi = max(0.0, float(r.get("putOI") or 0))
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(c_oi) and math.isfinite(p_oi)):
            continue
        clean.append((strike, c_oi, p_oi))
        total_oi += c_oi + p_oi

    if not clean or total_oi <= 0:
        return out

    # Candidate settlement strikes = the same grid we observe in the chain.
    # For each candidate, compute total holder-side payout. Argmin = max pain.
    best_strike: float | None = None
    best_payout = math.inf
    for k_s, _c, _p in clean:
        payout = 0.0
        for k, c_oi, p_oi in clean:
            if c_oi > 0 and k_s > k:
                payout += c_oi * (k_s - k)
            if p_oi > 0 and k > k_s:
                payout += p_oi * (k - k_s)
        if payout < best_payout:
            best_payout = payout
            best_strike = k_s

    if best_strike is None:
        return out

    out["max_pain_strike"] = best_strike

    if spot_pos is not None:
        out["distance_to_max_pain_pct"] = (spot_pos - best_strike) / spot_pos * 100.0
        band_half_width = _GRAVITY_BAND_PCT * spot_pos
        nearby_oi = sum(
            c_oi + p_oi
            for k, c_oi, p_oi in clean
            if abs(k - best_strike) <= band_half_width
        )
        out["max_pain_gravity_strength"] = nearby_oi / total_oi

    return out


def compute_cross_day_level_features(
    spot: float | None,
    prev_day_high: float | None,
    prev_day_low: float | None,
    swing_5d_high: float | None,
    swing_5d_low: float | None,
    round_number_step: int | float | None,
) -> dict[str, float]:
    """
    Compute 6 cross-day-state level features (B5, spec §2.1.3).

    Adds awareness of:
      • Previous trading day's extremes (carry-over S/R for gap/open logic)
      • Multi-day swing pivots over the last 5 trading days
      • Round-number levels (psychological S/R) at instrument-specific steps

    All outputs are signed % distances using spot as the denominator. The
    sign convention mirrors the rest of this module:
        > 0 → spot is ABOVE the level
        < 0 → spot is BELOW the level
        = 0 → spot is AT the level

    Round-number computation:
        nearest_round_above = smallest multiple of round_number_step ≥ spot
        nearest_round_below = largest  multiple of round_number_step ≤ spot
        When spot lands exactly on a round number, both distances are 0.

    Args:
        spot:               Current underlying spot price.
        prev_day_high:      Previous trading day's high.
        prev_day_low:       Previous trading day's low.
        swing_5d_high:      Highest high over the last 5 trading days.
        swing_5d_low:       Lowest low over the last 5 trading days.
        round_number_step:  Instrument-specific psychological step
                            (e.g. 100 for NIFTY, 1000 for BANKNIFTY,
                            100 for CRUDEOIL, 10 for NATURALGAS). Caller
                            supplies from the InstrumentProfile.

    Null rules:
        spot missing or ≤ 0 → all 6 features NaN.
        Any other single missing / non-positive input → only the feature(s)
        depending on it are NaN; the rest compute normally.
        round_number_step missing or ≤ 0 → only the 2 round-number features
        are NaN; the other 4 compute fine.

    Returns:
        Dict with 6 keys, all floats. NaN where input is missing.
    """
    out: dict[str, float] = {
        "distance_to_prev_day_high_pct": _NAN,
        "distance_to_prev_day_low_pct": _NAN,
        "distance_to_round_number_above_pct": _NAN,
        "distance_to_round_number_below_pct": _NAN,
        "distance_to_5d_swing_high_pct": _NAN,
        "distance_to_5d_swing_low_pct": _NAN,
    }

    spot_pos = _safe_pos(spot)
    if spot_pos is None:
        return out

    pdh_pos = _safe_pos(prev_day_high)
    pdl_pos = _safe_pos(prev_day_low)
    sh_pos = _safe_pos(swing_5d_high)
    sl_pos = _safe_pos(swing_5d_low)
    step_pos = _safe_pos(round_number_step)

    if pdh_pos is not None:
        out["distance_to_prev_day_high_pct"] = (spot_pos - pdh_pos) / spot_pos * 100.0
    if pdl_pos is not None:
        out["distance_to_prev_day_low_pct"] = (spot_pos - pdl_pos) / spot_pos * 100.0
    if sh_pos is not None:
        out["distance_to_5d_swing_high_pct"] = (spot_pos - sh_pos) / spot_pos * 100.0
    if sl_pos is not None:
        out["distance_to_5d_swing_low_pct"] = (spot_pos - sl_pos) / spot_pos * 100.0

    if step_pos is not None:
        # math.ceil/floor of spot/step gives the multiple count; multiply
        # back by step to land on the nearest round number on each side.
        nearest_above = math.ceil(spot_pos / step_pos) * step_pos
        nearest_below = math.floor(spot_pos / step_pos) * step_pos
        out["distance_to_round_number_above_pct"] = (spot_pos - nearest_above) / spot_pos * 100.0
        out["distance_to_round_number_below_pct"] = (spot_pos - nearest_below) / spot_pos * 100.0

    return out
