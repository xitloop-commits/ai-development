"""
active_features.py — §8.6–8.7 Active Strike Features + Cross-Feature Intelligence.

Two groups of outputs:

  1. Per-slot active strike features (6 slots × 24 features = 144 columns)
     Keys: active_{slot}_{field}  for slot in 0..5.
     Empty slots (beyond len(active_strikes)) are all NaN.

  2. §8.7 cross-feature aggregates (4 columns)
     call_put_strength_diff   Σ(call.strength) − Σ(put.strength) across active strikes
     call_put_volume_diff     call_vol_diff_atm − put_vol_diff_atm; NaN if !vol_diff_available
     call_put_oi_diff         oi_change_call_atm − oi_change_put_atm
     premium_divergence       Σ(call.pm) − Σ(put.pm) across active; NaN if count=0

Per-strike call/put strength computation (§8.6):
    call_strength_volume  = normalize(call_vol_diff across all chain strikes)
    call_strength_oi      = normalize(abs(callOIChange) across all chain strikes)
    call_strength         = (call_strength_volume + call_strength_oi) / 2.0
    put_strength_volume   = normalize(put_vol_diff across all chain strikes)
    put_strength_oi       = normalize(abs(putOIChange) across all chain strikes)
    put_strength          = (put_strength_volume + put_strength_oi) / 2.0

    Normalization: min-max across ALL strikes in the current chain snapshot.
    vol_diff is clamped to 0 (no negative — volume is strictly non-decreasing intraday).
    When prev_snapshot is None (first snapshot), all vol_scores are 0.0.

tick_age_sec (per slot):
    min(time_since_last_call_tick, time_since_last_put_tick)
    NaN if tick_available = 0 (neither side has ticked this session).

Null rules:
    tick-derived features = NaN when tick_available = 0.
    premium_momentum = NaN when buffer < 5 or time_span > staleness_threshold_sec.
    call_put_volume_diff = NaN when vol_diff_available = False.
    premium_divergence = NaN when active_strike_count = 0.
    Empty slots = NaN for all 24 fields.

Public API:
    compute_side_strengths()     — call/put strengths for all strikes in snapshot
    compute_active_features()    — full §8.6–8.7 output dict (148 keys)
"""

from __future__ import annotations

import math

from tick_feature_agent.buffers.option_buffer import OptionBufferStore, OptionTick
from tick_feature_agent.chain_cache import ChainCache
from tick_feature_agent.feed.chain_poller import ChainSnapshot

_NAN = float("nan")
_N_SLOTS = 6

# Per-slot column names (24 per slot)
_SLOT_KEYS = (
    "strike",
    "distance_from_spot",
    "tick_available",
    "call_strength_volume",
    "call_strength_oi",
    "call_strength",
    "call_ltp",
    "call_bid",
    "call_ask",
    "call_spread",
    "call_volume",
    "call_bid_ask_imbalance",
    "call_premium_momentum",
    "put_strength_volume",
    "put_strength_oi",
    "put_strength",
    "put_ltp",
    "put_bid",
    "put_ask",
    "put_spread",
    "put_volume",
    "put_bid_ask_imbalance",
    "put_premium_momentum",
    "tick_age_sec",
)

# Empty-slot sentinel (24 NaN values; tick_available=0, strike=NaN)
_EMPTY_SLOT: dict = {k: _NAN for k in _SLOT_KEYS}
_EMPTY_SLOT["tick_available"] = 0

_CROSS_KEYS = (
    "call_put_strength_diff",
    "call_put_volume_diff",
    "call_put_oi_diff",
    "premium_divergence",
)


# ── Per-side strength helper ──────────────────────────────────────────────────

def _normalize(values: list[float]) -> list[float]:
    """Min-max normalization. All-zero → 0.0; all-equal-nonzero → 1.0."""
    if not values:
        return []
    mx = max(values)
    if mx == 0.0:
        return [0.0] * len(values)
    mn = min(values)
    if mx == mn:                      # all equal and non-zero
        return [1.0] * len(values)
    span = mx - mn
    return [(v - mn) / span for v in values]


def compute_side_strengths(
    rows: list[dict],
    prev_rows: list[dict] | None,
) -> dict[int, tuple[float, float, float, float, float, float]]:
    """
    Compute per-side (call and put) normalized strength components for every
    strike in the chain snapshot.

    Args:
        rows:      Current chain snapshot rows.
        prev_rows: Previous snapshot rows (None → first snapshot, vol_diff = 0).

    Returns:
        dict mapping strike (int) →
            (call_sv, call_soi, call_strength, put_sv, put_soi, put_strength)

        call_sv        = normalize(call_vol_diff across all strikes)
        call_soi       = normalize(abs(callOIChange) across all strikes)
        call_strength  = (call_sv + call_soi) / 2
        put_sv         = normalize(put_vol_diff across all strikes)
        put_soi        = normalize(abs(putOIChange) across all strikes)
        put_strength   = (put_sv + put_soi) / 2

    Used by compute_active_features() and zone.py for ATM zone pressure.
    """
    prev_map: dict[int, dict] = {}
    if prev_rows:
        for r in prev_rows:
            prev_map[int(r["strike"])] = r

    strikes: list[int] = []
    call_vols: list[float] = []
    put_vols:  list[float] = []
    call_ois:  list[float] = []
    put_ois:   list[float] = []

    for row in rows:
        strike = int(row["strike"])
        strikes.append(strike)

        if prev_rows is not None:
            prev = prev_map.get(strike, {})
            call_vol_diff = max(0.0,
                float(row.get("callVolume", 0) or 0)
                - float(prev.get("callVolume", 0) or 0)
            )
            put_vol_diff = max(0.0,
                float(row.get("putVolume", 0) or 0)
                - float(prev.get("putVolume", 0) or 0)
            )
        else:
            call_vol_diff = 0.0
            put_vol_diff  = 0.0

        call_vols.append(call_vol_diff)
        put_vols.append(put_vol_diff)
        call_ois.append(abs(float(row.get("callOIChange", 0) or 0)))
        put_ois.append(abs(float(row.get("putOIChange",  0) or 0)))

    call_sv_norm  = _normalize(call_vols)
    put_sv_norm   = _normalize(put_vols)
    call_soi_norm = _normalize(call_ois)
    put_soi_norm  = _normalize(put_ois)

    result: dict[int, tuple[float, float, float, float, float, float]] = {}
    for i, strike in enumerate(strikes):
        csv = call_sv_norm[i]
        csoi = call_soi_norm[i]
        psv = put_sv_norm[i]
        psoi = put_soi_norm[i]
        result[strike] = (
            csv,
            csoi,
            (csv + csoi) / 2.0,
            psv,
            psoi,
            (psv + psoi) / 2.0,
        )
    return result


# ── Tick feature helpers ──────────────────────────────────────────────────────

def _bid_ask_imbalance(tick: OptionTick) -> float:
    denom = float(tick.bid_size) + float(tick.ask_size)
    if denom == 0.0:
        return _NAN
    return (float(tick.bid_size) - float(tick.ask_size)) / denom


def _premium_momentum(
    ticks: list[OptionTick],
    staleness_sec: float,
) -> float:
    """5-tick premium momentum; NaN if < 5 ticks or time_span > staleness_sec."""
    if len(ticks) < 5:
        return _NAN
    window = ticks[-5:]
    if window[-1].timestamp - window[0].timestamp > staleness_sec:
        return _NAN
    return float(window[-1].ltp) - float(window[0].ltp)


def _tick_features(
    option_store: OptionBufferStore,
    strike: int,
    opt_type: str,
    staleness_sec: float,
) -> dict:
    """
    Return tick-derived features for (strike, opt_type).
    All NaN if tick_available = 0.
    """
    if not option_store.tick_available(strike, opt_type):
        return {
            "ltp":               _NAN,
            "bid":               _NAN,
            "ask":               _NAN,
            "spread":            _NAN,
            "volume":            _NAN,
            "bid_ask_imbalance": _NAN,
            "premium_momentum":  _NAN,
        }
    ticks = option_store.get_last(strike, opt_type, n=10)
    current = ticks[-1]
    bid_f = float(current.bid)
    ask_f = float(current.ask)
    return {
        "ltp":               float(current.ltp),
        "bid":               bid_f,
        "ask":               ask_f,
        "spread":            ask_f - bid_f,
        "volume":            float(current.volume),
        "bid_ask_imbalance": _bid_ask_imbalance(current),
        "premium_momentum":  _premium_momentum(ticks, staleness_sec),
    }


# ── Main compute function ─────────────────────────────────────────────────────

def compute_active_features(
    cache: ChainCache,
    option_store: OptionBufferStore,
    current_time: float,
    spot_price: float,
    staleness_threshold_sec: float = 60.0,
) -> dict:
    """
    Compute §8.6–8.7 active strike features for the current tick.

    Args:
        cache:                   Live ChainCache (updated before this call).
        option_store:            Per-strike option buffers.
        current_time:            Current wall-clock Unix timestamp.
        spot_price:              Current underlying spot price.
        staleness_threshold_sec: From Instrument Profile (default 60s).

    Returns:
        Flat dict with 148 keys:
          - 6 slots × 24 per-slot keys (active_0_* … active_5_*)
          - 4 §8.7 cross-feature keys
    """
    out: dict = {}

    # ── Empty-slot defaults ───────────────────────────────────────────────────
    for slot in range(_N_SLOTS):
        prefix = f"active_{slot}_"
        for k in _SLOT_KEYS:
            out[prefix + k] = _EMPTY_SLOT[k]

    # ── Cross-feature defaults ────────────────────────────────────────────────
    for k in _CROSS_KEYS:
        out[k] = _NAN

    if not cache.chain_available or cache.snapshot is None:
        # Chain not yet available: all slots empty (already set), cross-features NaN
        out["call_put_oi_diff"] = (
            cache.oi_change_call_atm - cache.oi_change_put_atm
            if cache.chain_available else _NAN
        )
        return out

    # ── Compute per-side strengths from snapshot ──────────────────────────────
    snapshot = cache.snapshot
    prev_rows = cache.prev_snapshot.rows if cache.prev_snapshot is not None else None
    side_str: dict[int, tuple] = compute_side_strengths(snapshot.rows, prev_rows)

    # ── Populate per-slot features ────────────────────────────────────────────
    active = cache.active_strikes   # ordered by descending combined strength
    call_strength_sum = 0.0
    put_strength_sum  = 0.0
    call_pm_sum       = 0.0
    put_pm_sum        = 0.0
    any_active        = len(active) > 0

    for slot, score in enumerate(active[:_N_SLOTS]):
        strike = score.strike
        prefix = f"active_{slot}_"

        # Per-side chain strengths
        sv = side_str.get(strike, (0.0, 0.0, 0.0, 0.0, 0.0, 0.0))
        call_sv, call_soi, call_str, put_sv, put_soi, put_str = sv

        # Tick availability
        call_avail = option_store.tick_available(strike, "CE")
        put_avail  = option_store.tick_available(strike, "PE")
        tick_avail = 1 if (call_avail or put_avail) else 0

        # Tick age
        if tick_avail:
            t_call = option_store.last_tick_time(strike, "CE")
            t_put  = option_store.last_tick_time(strike, "PE")
            ages = []
            if t_call is not None:
                ages.append(current_time - t_call)
            if t_put is not None:
                ages.append(current_time - t_put)
            tick_age = min(ages) if ages else _NAN
        else:
            tick_age = _NAN

        # Tick-derived features per side
        call_tf = _tick_features(option_store, strike, "CE", staleness_threshold_sec)
        put_tf  = _tick_features(option_store, strike, "PE", staleness_threshold_sec)

        # Accumulate cross-feature sums
        call_strength_sum += call_str
        put_strength_sum  += put_str

        # premium_divergence: NaN pm → contributes 0
        cpm = call_tf["premium_momentum"]
        ppm = put_tf["premium_momentum"]
        call_pm_sum += 0.0 if math.isnan(cpm) else cpm
        put_pm_sum  += 0.0 if math.isnan(ppm) else ppm

        # Write slot
        out[prefix + "strike"]                = float(strike)
        out[prefix + "distance_from_spot"]    = float(strike) - spot_price
        out[prefix + "tick_available"]        = tick_avail
        out[prefix + "call_strength_volume"]  = call_sv
        out[prefix + "call_strength_oi"]      = call_soi
        out[prefix + "call_strength"]         = call_str
        out[prefix + "call_ltp"]              = call_tf["ltp"]
        out[prefix + "call_bid"]              = call_tf["bid"]
        out[prefix + "call_ask"]              = call_tf["ask"]
        out[prefix + "call_spread"]           = call_tf["spread"]
        out[prefix + "call_volume"]           = call_tf["volume"]
        out[prefix + "call_bid_ask_imbalance"]= call_tf["bid_ask_imbalance"]
        out[prefix + "call_premium_momentum"] = call_tf["premium_momentum"]
        out[prefix + "put_strength_volume"]   = put_sv
        out[prefix + "put_strength_oi"]       = put_soi
        out[prefix + "put_strength"]          = put_str
        out[prefix + "put_ltp"]               = put_tf["ltp"]
        out[prefix + "put_bid"]               = put_tf["bid"]
        out[prefix + "put_ask"]               = put_tf["ask"]
        out[prefix + "put_spread"]            = put_tf["spread"]
        out[prefix + "put_volume"]            = put_tf["volume"]
        out[prefix + "put_bid_ask_imbalance"] = put_tf["bid_ask_imbalance"]
        out[prefix + "put_premium_momentum"]  = put_tf["premium_momentum"]
        out[prefix + "tick_age_sec"]          = tick_age

    # ── §8.7 cross-feature aggregates ─────────────────────────────────────────
    out["call_put_strength_diff"] = max(-1.0, min(1.0, call_strength_sum - put_strength_sum))

    if cache.vol_diff_available:
        cdv = cache.call_vol_diff_atm
        pdv = cache.put_vol_diff_atm
        out["call_put_volume_diff"] = (
            (cdv if cdv is not None else 0.0)
            - (pdv if pdv is not None else 0.0)
        )
    # else: remains NaN

    out["call_put_oi_diff"] = cache.oi_change_call_atm - cache.oi_change_put_atm

    if any_active:
        out["premium_divergence"] = call_pm_sum - put_pm_sum
    # else: remains NaN

    return out
