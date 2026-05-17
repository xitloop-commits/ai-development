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

C1 additions (spec §2.1.4 C1):
    compute_oi_weighted_levels(chain_rows) → 2 features:
        oi_weighted_ce_resistance_strike  Σ(strike·callOI)/Σ(callOI) — smoothed
                                          resistance band, less jittery than the
                                          single argmax max_call_oi_strike.
        oi_weighted_pe_support_strike     Mirror for puts.

    compute_pcr_slope(pcr_history, now_ts) → 1 feature:
        pcr_intraday_slope_30min          Least-squares slope of pcr_global over
                                          the last 30 min of caller-maintained
                                          samples. Units: PCR-per-minute.
                                          +ve = put load rising (bearish drift),
                                          −ve = call load rising (bullish drift).

Wire format:
    In the flat NDJSON output (Phase 9) all chain features carry the `chain_`
    prefix (e.g. `pcr_global` → `chain_pcr_global`).  The prefix is applied
    here so this module can be used directly by the assembler.

Null rule:
    Features are NaN when `chain_available = False`.
    pcr_* are NaN when the call OI denominator is zero (already handled as
    None in ChainCache; converted to NaN here).
    oi_imbalance_atm is NaN when both OI changes are zero (None in ChainCache).
    OI-weighted strikes are NaN when the relevant side's total OI is 0.
    pcr_intraday_slope_30min is NaN with fewer than 2 valid history samples
    in the 30-min window.
"""

from __future__ import annotations

import math
from collections.abc import Iterable

from tick_feature_agent.chain_cache import ChainCache

_NAN = float("nan")
_PCR_WINDOW_SEC = 30 * 60  # 30 minutes
_SECONDS_PER_MINUTE = 60.0


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


def compute_oi_weighted_levels(chain_rows: Iterable[dict] | None) -> dict[str, float]:
    """
    Compute OI-weighted resistance + support strikes (C1 partial).

    Each side is weighted by its own OI:
        ce_resistance = Σ(strike · callOI) / Σ(callOI)
        pe_support    = Σ(strike · putOI)  / Σ(putOI)

    NaN when the relevant side has zero total OI (no data yet).
    """
    out: dict[str, float] = {
        "oi_weighted_ce_resistance_strike": _NAN,
        "oi_weighted_pe_support_strike": _NAN,
    }
    if chain_rows is None:
        return out

    ce_num = 0.0
    ce_den = 0.0
    pe_num = 0.0
    pe_den = 0.0
    for row in chain_rows:
        if not isinstance(row, dict):
            continue
        try:
            strike = float(row.get("strike"))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(strike) or strike <= 0:
            continue
        try:
            c_oi = max(0.0, float(row.get("callOI") or 0))
            p_oi = max(0.0, float(row.get("putOI") or 0))
        except (TypeError, ValueError):
            continue
        if math.isfinite(c_oi):
            ce_num += strike * c_oi
            ce_den += c_oi
        if math.isfinite(p_oi):
            pe_num += strike * p_oi
            pe_den += p_oi

    if ce_den > 0:
        out["oi_weighted_ce_resistance_strike"] = ce_num / ce_den
    if pe_den > 0:
        out["oi_weighted_pe_support_strike"] = pe_num / pe_den
    return out


def compute_pcr_slope(
    pcr_history: list[tuple[float, float]] | None,
    now_ts: float | None,
) -> dict[str, float]:
    """
    Compute the 30-min least-squares slope of PCR (C1 partial).

    Args:
        pcr_history: caller-maintained list of (epoch_seconds, pcr_global)
                     samples, sorted oldest → newest. Snapshots that arrived
                     more than 30 min before now_ts are ignored. NaN/None
                     PCR values within the window are also ignored.
        now_ts:      current epoch second.

    Returns:
        Dict with `pcr_intraday_slope_30min` in PCR-units per MINUTE.
        NaN when the window contains < 2 valid samples or all samples
        share the same timestamp.
    """
    out: dict[str, float] = {"pcr_intraday_slope_30min": _NAN}

    if now_ts is None or pcr_history is None:
        return out
    try:
        now_v = float(now_ts)
    except (TypeError, ValueError):
        return out
    if not math.isfinite(now_v):
        return out

    cutoff = now_v - _PCR_WINDOW_SEC
    xs: list[float] = []
    ys: list[float] = []
    for ts, pcr in pcr_history:
        try:
            ts_v = float(ts)
            pcr_v = float(pcr)
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(ts_v) and math.isfinite(pcr_v)):
            continue
        if ts_v < cutoff or ts_v > now_v:
            continue
        xs.append(ts_v)
        ys.append(pcr_v)

    if len(xs) < 2:
        return out

    # Standard least-squares slope. Numerically stable enough for tiny windows.
    n = float(len(xs))
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    num = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    den = sum((x - mean_x) ** 2 for x in xs)
    if den <= 0:
        return out

    slope_per_sec = num / den
    out["pcr_intraday_slope_30min"] = slope_per_sec * _SECONDS_PER_MINUTE
    return out
