"""
chain.py — §8.5 Option Chain Features.

All chain features are pre-computed by ChainCache (updated on every REST
snapshot and on ATM shifts). This module is a thin extractor that maps the
ChainCache dataclass fields to the flat output dict expected by the feature
engine.

Features (8 outputs):
    chain_pcr_global            put_oi / call_oi (global); None → NaN
    chain_pcr_atm               put_oi / call_oi (ATM zone); None → NaN
    chain_oi_total_call         Sum call OI (all strikes)
    chain_oi_total_put          Sum put OI (all strikes)
    chain_oi_change_call        Sum call delta OI (all strikes)
    chain_oi_change_put         Sum put delta OI (all strikes)
    chain_oi_change_call_atm    Sum call delta OI (ATM ±3)
    chain_oi_change_put_atm     Sum put delta OI (ATM ±3)
    chain_oi_imbalance_atm      (call_chg - put_chg)/(|call_chg|+|put_chg|)

Wire format:
    In the flat NDJSON output (Phase 9) all chain features carry the `chain_`
    prefix (e.g. `pcr_global` → `chain_pcr_global`).  The prefix is applied
    here so this module can be used directly by the assembler.

Null rule:
    Features are NaN when `chain_available = False`.
    pcr_* are NaN when the call OI denominator is zero (already handled as
    None in ChainCache; converted to NaN here).
    oi_imbalance_atm is NaN when both OI changes are zero (None in ChainCache).
"""

from __future__ import annotations

from tick_feature_agent.chain_cache import ChainCache

_NAN = float("nan")


def compute_chain_features(cache: ChainCache) -> dict:
    """
    Extract §8.5 chain features from a ChainCache.

    Args:
        cache: Live ChainCache instance (updated by chain_poller).

    Returns:
        Dict of 9 float features (NaN when unavailable).
    """
    if not cache.chain_available:
        return {
            "chain_pcr_global": _NAN,
            "chain_pcr_atm": _NAN,
            "chain_oi_total_call": _NAN,
            "chain_oi_total_put": _NAN,
            "chain_oi_change_call": _NAN,
            "chain_oi_change_put": _NAN,
            "chain_oi_change_call_atm": _NAN,
            "chain_oi_change_put_atm": _NAN,
            "chain_oi_imbalance_atm": _NAN,
        }

    return {
        "chain_pcr_global": _opt(cache.pcr_global),
        "chain_pcr_atm": _opt(cache.pcr_atm),
        "chain_oi_total_call": float(cache.oi_total_call),
        "chain_oi_total_put": float(cache.oi_total_put),
        "chain_oi_change_call": float(cache.oi_change_call),
        "chain_oi_change_put": float(cache.oi_change_put),
        "chain_oi_change_call_atm": float(cache.oi_change_call_atm),
        "chain_oi_change_put_atm": float(cache.oi_change_put_atm),
        "chain_oi_imbalance_atm": _opt(cache.oi_imbalance_atm),
    }


def _opt(value: float | None) -> float:
    """Convert None → NaN; pass through float values."""
    return _NAN if value is None else float(value)
