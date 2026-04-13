"""
horizon.py — §8.20 Multi-Horizon Features.

Compares short-term signals against medium-term baselines to detect momentum
alignment versus divergence.

Features (3 outputs):
    underlying_horizon_momentum_ratio   return_5ticks  / return_50ticks
    underlying_horizon_vol_ratio        realized_vol_5 / realized_vol_20
    underlying_horizon_ofi_ratio        ofi_5          / ofi_50

Null rules:
    horizon_momentum_ratio   NaN if ticks < 50 or return_50ticks == 0
    horizon_vol_ratio        NaN if ticks < 20 or realized_vol_20 == 0
    horizon_ofi_ratio        NaN if ticks < 50 or ofi_50 == 0

These features are derived from already-computed underlying feature dicts
rather than from the buffer directly — callers pass the output of the three
upstream compute functions.

Note: "NaN" (not 0.0) is emitted when the denominator is zero — per spec §8.20:
"zero denominator means no signal, not zero ratio".
"""

from __future__ import annotations

import math

_NAN = float("nan")


def compute_horizon_features(
    underlying: dict,
    ofi: dict,
    realized_vol: dict,
) -> dict:
    """
    Compute §8.20 multi-horizon ratio features.

    Args:
        underlying:   Output of compute_underlying_features()
        ofi:          Output of compute_ofi_features()
        realized_vol: Output of compute_realized_vol_features()

    Returns:
        Dict of 3 float features.  NaN when the denominator is NaN, not yet
        available, or exactly zero.
    """
    out: dict = {
        "underlying_horizon_momentum_ratio": _NAN,
        "underlying_horizon_vol_ratio":      _NAN,
        "underlying_horizon_ofi_ratio":      _NAN,
    }

    # ── horizon_momentum_ratio = return_5ticks / return_50ticks ───────────────
    r5  = underlying.get("return_5ticks",  _NAN)
    r50 = underlying.get("return_50ticks", _NAN)
    if not (math.isnan(r5) or math.isnan(r50)) and r50 != 0.0:
        out["underlying_horizon_momentum_ratio"] = r5 / r50

    # ── horizon_vol_ratio = realized_vol_5 / realized_vol_20 ─────────────────
    v5  = realized_vol.get("underlying_realized_vol_5",  _NAN)
    v20 = realized_vol.get("underlying_realized_vol_20", _NAN)
    if not (math.isnan(v5) or math.isnan(v20)) and v20 != 0.0:
        out["underlying_horizon_vol_ratio"] = v5 / v20

    # ── horizon_ofi_ratio = ofi_5 / ofi_50 ───────────────────────────────────
    o5  = ofi.get("underlying_ofi_5",  _NAN)
    o50 = ofi.get("underlying_ofi_50", _NAN)
    if not (math.isnan(o5) or math.isnan(o50)) and o50 != 0.0:
        out["underlying_horizon_ofi_ratio"] = o5 / o50

    return out
