"""
zone.py — §8.12 Strike-Level Aggregation & Zone Pressure.

Pure function: reads ChainCache active_strikes and ATM ±3 strengths to
compute zone pressure signals.

Features (7 outputs):
    atm_zone_call_pressure   Σ(call.strength for ATM ±3) / 7  [0, 1]
    atm_zone_put_pressure    Σ(put.strength for ATM ±3) / 7   [0, 1]
    atm_zone_net_pressure    call_pressure - put_pressure     [-1, 1]
    active_zone_call_count   Count of active strikes with call.strength > put.strength
    active_zone_put_count    Count of active strikes with put.strength > call.strength
    active_zone_dominance    (call_count - put_count) / max(call+put, 1)  [-1, 1]
    zone_activity_score      (call_pressure + put_pressure) / 2  [0, 1]

Null rules:
    atm_zone_call_pressure, atm_zone_put_pressure, atm_zone_net_pressure,
    zone_activity_score → NaN if chain_available = False.
    active_zone_* → 0 (not NaN) when active_strike_count = 0.
    Unticked strikes within ATM ±3 use call.strength = put.strength = 0.0
    (chain snapshot-derived strength, 0.0 if first snapshot with no vol_diff).
"""

from __future__ import annotations

import math

from tick_feature_agent.chain_cache import ChainCache
from tick_feature_agent.features.active_features import compute_side_strengths

_NAN = float("nan")
_ATM_STRIKE_COUNT = 7


def compute_zone_features(
    cache: ChainCache,
    atm_window: list[int],
) -> dict:
    """
    Compute §8.12 zone pressure features.

    ATM ±3 call/put strengths come from the active_strikes StrikeScore objects
    stored in the chain cache.  Strikes in atm_window that are NOT in
    active_strikes contribute 0.0 to the pressure sums.

    Args:
        cache:      Live ChainCache (updated before this call).
        atm_window: 7-element ATM ±3 strike list.

    Returns:
        Dict of 7 features.
    """
    if not cache.chain_available:
        return {
            "atm_zone_call_pressure":  _NAN,
            "atm_zone_put_pressure":   _NAN,
            "atm_zone_net_pressure":   _NAN,
            "active_zone_call_count":  0,
            "active_zone_put_count":   0,
            "active_zone_dominance":   0.0,
            "zone_activity_score":     _NAN,
        }

    # ── Compute per-side strengths from snapshot (§8.6) ──────────────────────
    snapshot = cache.snapshot
    prev_rows = cache.prev_snapshot.rows if cache.prev_snapshot is not None else None
    side_str = compute_side_strengths(snapshot.rows, prev_rows)
    # side_str: {strike: (call_sv, call_soi, call_strength, put_sv, put_soi, put_strength)}

    # ── ATM ±3 zone pressure ──────────────────────────────────────────────────
    # Strikes not in snapshot contribute 0.0 (per spec null rule).
    call_sum = 0.0
    put_sum  = 0.0
    for strike in atm_window:
        sv = side_str.get(strike)
        if sv is not None:
            call_sum += sv[2]   # call_strength
            put_sum  += sv[5]   # put_strength
        # else: strike absent from snapshot → contributes 0.0

    call_pressure = call_sum / _ATM_STRIKE_COUNT
    put_pressure  = put_sum  / _ATM_STRIKE_COUNT

    # ── Active zone counts ────────────────────────────────────────────────────
    # call_count: active strikes where call.strength > put.strength
    # put_count:  active strikes where put.strength > call.strength
    # Ties excluded from both counts.
    call_count = 0
    put_count  = 0
    for score in cache.active_strikes:
        sv = side_str.get(score.strike)
        if sv is None:
            continue
        cs = sv[2]   # call_strength
        ps = sv[5]   # put_strength
        if cs > ps:
            call_count += 1
        elif ps > cs:
            put_count += 1
        # else: tie → excluded

    denom = max(call_count + put_count, 1)
    dominance = (call_count - put_count) / denom if (call_count + put_count) > 0 else 0.0

    return {
        "atm_zone_call_pressure":  call_pressure,
        "atm_zone_put_pressure":   put_pressure,
        "atm_zone_net_pressure":   call_pressure - put_pressure,
        "active_zone_call_count":  call_count,
        "active_zone_put_count":   put_count,
        "active_zone_dominance":   dominance,
        "zone_activity_score":     (call_pressure + put_pressure) / 2.0,
    }
