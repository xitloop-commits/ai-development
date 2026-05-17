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

C1 wall-strength + OI-delta additions (V2_MASTER_SPEC §2.5 trend exits):
    compute_wall_strength(chain_rows) → 2 features:
        ce_wall_strength_rel              max(callOI across strikes) / mean(callOI).
                                          1.0 = flat distribution; >1.0 = concentrated
                                          call wall (resistance). NaN with < 2 valid
                                          strikes or zero mean.
        pe_wall_strength_rel              Mirror for puts (support concentration).

    compute_oi_change_deltas(oi_history, now_ts) → 6 features:
        ce_oi_change_5min_pct             %-change of total call OI vs ~5/15/60 min
        pe_oi_change_5min_pct             ago, drawn from a caller-maintained
        ce_oi_change_15min_pct            (ts, total_call_oi, total_put_oi) history.
        pe_oi_change_15min_pct            Tolerances: 60s/90s/180s for 5/15/60-min.
        ce_oi_change_60min_pct            NaN per-window if baseline missing or
        pe_oi_change_60min_pct            stale; NaN per-side if baseline OI == 0.

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
    Wall-strength is NaN when < 2 valid strikes contribute on a side or the
    mean is 0; per-side independent.
    OI-change %s are NaN when the per-window baseline is missing/stale or the
    baseline OI is 0 (can't divide); per-window and per-side independent.
"""

from __future__ import annotations

import math
from collections.abc import Iterable

from tick_feature_agent.chain_cache import ChainCache

_NAN = float("nan")
_PCR_WINDOW_SEC = 30 * 60  # 30 minutes
_SECONDS_PER_MINUTE = 60.0

# OI-delta windows: (lookback_sec, tolerance_sec) for 5/15/60-min snapshots.
_OI_DELTA_WINDOWS_SEC = (
    (300, 60),
    (900, 90),
    (3600, 180),
)
_OI_DELTA_LABELS = ("5min", "15min", "60min")


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


def compute_wall_strength(chain_rows: Iterable[dict] | None) -> dict[str, float]:
    """
    Compute relative OI-wall strength on each side (C1 trend-exit input).

    Formula per side:
        wall_strength_rel = max(OI across strikes) / mean(OI across strikes)

    Bounded below by 1.0 (perfectly flat). Larger value = more concentrated
    wall. Strikes with OI ≤ 0 (or malformed) are excluded from both the
    numerator and the denominator on that side.

    NaN when fewer than 2 valid strikes contribute on the side or the mean
    is 0. The two sides are independent.
    """
    out: dict[str, float] = {
        "ce_wall_strength_rel": _NAN,
        "pe_wall_strength_rel": _NAN,
    }
    if chain_rows is None:
        return out

    ce_oi: list[float] = []
    pe_oi: list[float] = []
    for row in chain_rows:
        if not isinstance(row, dict):
            continue
        try:
            c_oi = float(row.get("callOI") or 0)
        except (TypeError, ValueError):
            c_oi = _NAN
        try:
            p_oi = float(row.get("putOI") or 0)
        except (TypeError, ValueError):
            p_oi = _NAN
        if math.isfinite(c_oi) and c_oi > 0:
            ce_oi.append(c_oi)
        if math.isfinite(p_oi) and p_oi > 0:
            pe_oi.append(p_oi)

    if len(ce_oi) >= 2:
        mean_ce = sum(ce_oi) / len(ce_oi)
        if mean_ce > 0:
            out["ce_wall_strength_rel"] = max(ce_oi) / mean_ce
    if len(pe_oi) >= 2:
        mean_pe = sum(pe_oi) / len(pe_oi)
        if mean_pe > 0:
            out["pe_wall_strength_rel"] = max(pe_oi) / mean_pe
    return out


def _safe_finite(v) -> float | None:
    """Coerce to float and reject NaN/Inf. Returns None on failure."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return f


def compute_oi_change_deltas(
    oi_history: list[tuple[float, float, float]] | None,
    now_ts: float | None,
) -> dict[str, float]:
    """
    Compute %-change of total call/put OI over 5/15/60-min windows.

    Args:
        oi_history: list of (ts_epoch_seconds, total_call_oi, total_put_oi)
                    snapshots, oldest → newest. Caller (chain_cache or
                    tick_processor) maintains this buffer.
        now_ts:     current epoch second.

    For each (lookback_sec, tolerance_sec) window in _OI_DELTA_WINDOWS_SEC:
        target = now_ts - lookback_sec
        baseline = latest snapshot at-or-before target, within tolerance_sec.
        ce_pct  = (current_call_oi - baseline_call_oi) / baseline_call_oi * 100
        pe_pct  = (current_put_oi  - baseline_put_oi)  / baseline_put_oi  * 100

    NaN rules:
        - history None/empty/single-sample → all 6 NaN.
        - now_ts None / non-finite / non-numeric → all 6 NaN.
        - baseline missing within tolerance for a window → that window's 2 NaN.
        - baseline OI == 0 on a side → that side's % NaN (can't divide).
    """
    out: dict[str, float] = {
        f"{side}_oi_change_{label}_pct": _NAN
        for label in _OI_DELTA_LABELS
        for side in ("ce", "pe")
    }

    now_v = _safe_finite(now_ts)
    if now_v is None or not oi_history:
        return out

    # Find the latest valid snapshot at-or-before now_ts. This drives the
    # numerator for every window. Walk backward — the tail is usually it.
    current_call: float | None = None
    current_put: float | None = None
    for sample in reversed(oi_history):
        if not isinstance(sample, tuple) or len(sample) != 3:
            continue
        ts_v = _safe_finite(sample[0])
        if ts_v is None or ts_v > now_v:
            continue
        c_oi = _safe_finite(sample[1])
        p_oi = _safe_finite(sample[2])
        if c_oi is None or p_oi is None:
            continue
        current_call = c_oi
        current_put = p_oi
        break

    if current_call is None or current_put is None:
        return out

    for (lookback_sec, tol_sec), label in zip(_OI_DELTA_WINDOWS_SEC, _OI_DELTA_LABELS):
        target_ts = now_v - float(lookback_sec)
        baseline_call: float | None = None
        baseline_put: float | None = None
        for sample in reversed(oi_history):
            if not isinstance(sample, tuple) or len(sample) != 3:
                continue
            ts_v = _safe_finite(sample[0])
            if ts_v is None or ts_v > target_ts:
                continue
            # First sample at-or-before target_ts. Check tolerance.
            if target_ts - ts_v > float(tol_sec):
                break  # too stale — leave NaN for this window
            c_oi = _safe_finite(sample[1])
            p_oi = _safe_finite(sample[2])
            if c_oi is None or p_oi is None:
                break
            baseline_call = c_oi
            baseline_put = p_oi
            break

        if baseline_call is not None and baseline_call > 0:
            out[f"ce_oi_change_{label}_pct"] = (
                (current_call - baseline_call) / baseline_call * 100.0
            )
        if baseline_put is not None and baseline_put > 0:
            out[f"pe_oi_change_{label}_pct"] = (
                (current_put - baseline_put) / baseline_put * 100.0
            )

    return out
