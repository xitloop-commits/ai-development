"""
regime.py — §8.10 Regime Classification.

Pure function: computes TREND / RANGE / DEAD / NEUTRAL from four normalized
input signals and configurable thresholds from the Instrument Profile.

Features (2 outputs):
    regime             "TREND" | "RANGE" | "DEAD" | "NEUTRAL" | None
    regime_confidence  float [0, 1] | NaN

Input signals (all normalized 0–1):
    S_volatility  = volatility_compression       (high = expansion)
    S_imbalance   = abs(tick_imbalance_20)        (high = directional)
    S_momentum    = abs(Δprice_20) / rolling_std  (high = directional)
    S_activity    = min(active_strike_count/4, 1) (high = live)

Warm-up:  both outputs are None/NaN when:
    - underlying 20-tick buffer not yet full (n < 20)
    - vol_diff_available is False (before 2nd chain snapshot)
    - trading_state == "WARMING_UP"
    - Any required signal (volatility_compression, tick_imbalance_20) is NaN

Default thresholds (see instrument profile for per-instrument values):
    regime_trend_volatility_min  = 0.8
    regime_trend_imbalance_min   = 0.3
    regime_trend_momentum_min    = 0.5
    regime_trend_activity_min    = 0.5
    regime_range_volatility_max  = 0.5
    regime_range_imbalance_max   = 0.3
    regime_range_activity_min    = 0.25
    regime_dead_activity_max     = 0.25
    regime_dead_vol_drought_max  = 0.05  (fraction of session_avg)
"""

from __future__ import annotations

import math
import statistics

from tick_feature_agent.buffers.tick_buffer import CircularBuffer

_NAN = float("nan")

# Default thresholds — override per instrument via compute() `thresholds` param
_DEFAULTS: dict = {
    "regime_trend_volatility_min": 0.8,
    "regime_trend_imbalance_min": 0.3,
    "regime_trend_momentum_min": 0.5,
    "regime_trend_activity_min": 0.5,
    "regime_range_volatility_max": 0.5,
    "regime_range_imbalance_max": 0.3,
    "regime_range_activity_min": 0.25,
    "regime_dead_activity_max": 0.25,
    "regime_dead_vol_drought_max": 0.05,
}


def compute_regime_features(
    buffer: CircularBuffer,
    volatility_compression: float,
    tick_imbalance_20: float,
    active_strike_count: int,
    vol_diff_available: bool,
    trading_state: str = "TRADING",
    volume_drought_atm: float = _NAN,
    thresholds: dict | None = None,
) -> dict:
    """
    Compute §8.10 regime classification.

    Args:
        buffer:                 Underlying 50-tick buffer (current tick pushed).
        volatility_compression: From compression.py; NaN during warm-up.
        tick_imbalance_20:      From underlying.py; NaN if < 20 ticks.
        active_strike_count:    From decay.py or ChainCache.
        vol_diff_available:     True after second chain snapshot.
        trading_state:          State machine state ("TRADING", "WARMING_UP", etc.)
        volume_drought_atm:     From decay.py; NaN until 2nd snapshot.
        thresholds:             Dict of regime_* keys (merged with defaults).

    Returns:
        Dict with keys "regime" (str | None) and "regime_confidence" (float).
        regime = None and regime_confidence = NaN during warm-up.
    """
    t = dict(_DEFAULTS)
    if thresholds:
        t.update(thresholds)

    n = len(buffer)

    # ── Warm-up guard ─────────────────────────────────────────────────────────
    warm_up = (
        n < 20
        or not vol_diff_available
        or trading_state == "WARMING_UP"
        or math.isnan(volatility_compression)
        or math.isnan(tick_imbalance_20)
    )
    if warm_up:
        return {"regime": None, "regime_confidence": _NAN}

    # ── Compute rolling_std_20 and price delta ────────────────────────────────
    ticks = buffer.get_last(20)
    prices = [float(tk.ltp) for tk in ticks]
    rolling_std_20 = statistics.stdev(prices)
    price_now = prices[-1]
    price_20ago = prices[0]

    # ── Signals ───────────────────────────────────────────────────────────────
    s_volatility = volatility_compression  # already [0,∞]; can exceed 1
    s_imbalance = abs(tick_imbalance_20)  # [0, 1]
    if rolling_std_20 == 0.0:
        s_momentum = 0.0
    else:
        s_momentum = abs(price_now - price_20ago) / rolling_std_20
    s_activity = min(active_strike_count / 4.0, 1.0)  # [0, 1]

    # ── Threshold evaluation ──────────────────────────────────────────────────
    is_dead = s_activity < t["regime_dead_activity_max"] or (
        not math.isnan(volume_drought_atm)
        and volume_drought_atm < t["regime_dead_vol_drought_max"]
        and active_strike_count == 0
    )
    is_trend = (
        s_volatility > t["regime_trend_volatility_min"]
        and s_imbalance > t["regime_trend_imbalance_min"]
        and s_momentum > t["regime_trend_momentum_min"]
        and s_activity > t["regime_trend_activity_min"]
    )
    is_range = (
        s_volatility < t["regime_range_volatility_max"]
        and s_imbalance < t["regime_range_imbalance_max"]
        and s_activity > t["regime_range_activity_min"]
    )

    # ── Priority assignment ───────────────────────────────────────────────────
    if is_dead:
        regime = "DEAD"
        confidence = 1.0 - s_activity
    elif is_trend:
        regime = "TREND"
        confidence = (s_volatility + s_imbalance + s_momentum + s_activity) / 4.0
        confidence = min(1.0, confidence)  # clamp: s_volatility can exceed 1
    elif is_range:
        regime = "RANGE"
        confidence = ((1.0 - s_volatility) + (1.0 - s_imbalance) + s_activity) / 3.0
        confidence = max(0.0, min(1.0, confidence))
    else:
        regime = "NEUTRAL"
        confidence = 0.5

    return {"regime": regime, "regime_confidence": confidence}
