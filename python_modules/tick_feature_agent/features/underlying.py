"""
underlying.py — §8.2 Underlying base features.

All features are computed from the CircularBuffer after the current tick has
been pushed. Returns a flat dict with float values. Unavailable features (not
enough history) are float('nan').

Feature list (22 outputs):
    ltp, bid, ask, spread
    return_5ticks, return_10ticks, return_20ticks, return_50ticks
    momentum, velocity
    tick_up_count_10,  tick_down_count_10,  tick_flat_count_10,  tick_imbalance_10
    tick_up_count_20,  tick_down_count_20,  tick_flat_count_20,  tick_imbalance_20
    tick_up_count_50,  tick_down_count_50,  tick_flat_count_50,  tick_imbalance_50

Null rules:
    return_Nticks   NaN if buffer has < N ticks
    momentum        NaN if buffer has < 2 ticks
    velocity        NaN if buffer has < 3 ticks
    tick_*_N        NaN if buffer has < N ticks
    spread          0.0 when bid=ask=0 (pre-depth-packet state) — not NaN
"""

from __future__ import annotations

import math

from tick_feature_agent.buffers.tick_buffer import CircularBuffer

_NAN = float("nan")
_RETURN_WINDOWS = (5, 10, 20, 50)
_COUNT_WINDOWS = (10, 20, 50)


def compute_underlying_features(buffer: CircularBuffer) -> dict:
    """
    Compute all §8.2 underlying base features.

    Args:
        buffer: CircularBuffer with the current tick already pushed.
                Maxlen=50 is assumed (the standard underlying buffer size).

    Returns:
        Dict of 22 float features. Unavailable features are float('nan').
    """
    n = len(buffer)

    if n == 0:
        return _empty_features()

    ticks = buffer.get_last(n)  # list[UnderlyingTick], oldest → newest
    current = ticks[-1]

    ltp = float(current.ltp)
    bid = float(current.bid)
    ask = float(current.ask)

    out: dict = {
        "ltp": ltp,
        "bid": bid,
        "ask": ask,
        "spread": ask - bid,
    }

    # ── return_Nticks ──────────────────────────────────────────────────────────
    for w in _RETURN_WINDOWS:
        key = f"return_{w}ticks"
        if n >= w:
            ref = float(ticks[-w].ltp)
            out[key] = (ltp - ref) / ref if ref != 0.0 else _NAN
        else:
            out[key] = _NAN

    # ── momentum (tick-to-tick return) ─────────────────────────────────────────
    if n >= 2:
        prev = float(ticks[-2].ltp)
        out["momentum"] = (ltp - prev) / prev if prev != 0.0 else _NAN
    else:
        out["momentum"] = _NAN

    # ── velocity (change in momentum) ──────────────────────────────────────────
    if n >= 3:
        p1 = float(ticks[-2].ltp)
        p2 = float(ticks[-3].ltp)
        prev_mom = (p1 - p2) / p2 if p2 != 0.0 else _NAN
        curr_mom = out["momentum"]
        out["velocity"] = (
            curr_mom - prev_mom if not (math.isnan(curr_mom) or math.isnan(prev_mom)) else _NAN
        )
    else:
        out["velocity"] = _NAN

    # ── tick counts (10 / 20 / 50) ─────────────────────────────────────────────
    for w in _COUNT_WINDOWS:
        if n >= w:
            window_ticks = ticks[-w:]  # length = w, oldest → newest
            up = down = flat = 0
            for i in range(1, w):
                diff = window_ticks[i].ltp - window_ticks[i - 1].ltp
                if diff > 0:
                    up += 1
                elif diff < 0:
                    down += 1
                else:
                    flat += 1
            out[f"tick_up_count_{w}"] = float(up)
            out[f"tick_down_count_{w}"] = float(down)
            out[f"tick_flat_count_{w}"] = float(flat)
            # Flat ticks excluded from denominator per spec §8.2
            # All-flat window → perfectly neutral imbalance = 0.0 (not NaN)
            out[f"tick_imbalance_{w}"] = (up - down) / (up + down) if (up + down) > 0 else 0.0
        else:
            out[f"tick_up_count_{w}"] = _NAN
            out[f"tick_down_count_{w}"] = _NAN
            out[f"tick_flat_count_{w}"] = _NAN
            out[f"tick_imbalance_{w}"] = _NAN

    return out


def _empty_features() -> dict:
    """Return all-NaN dict for an empty buffer."""
    out = {"ltp": _NAN, "bid": _NAN, "ask": _NAN, "spread": _NAN}
    for w in _RETURN_WINDOWS:
        out[f"return_{w}ticks"] = _NAN
    out["momentum"] = _NAN
    out["velocity"] = _NAN
    for w in _COUNT_WINDOWS:
        out[f"tick_up_count_{w}"] = _NAN
        out[f"tick_down_count_{w}"] = _NAN
        out[f"tick_flat_count_{w}"] = _NAN
        out[f"tick_imbalance_{w}"] = _NAN
    return out
