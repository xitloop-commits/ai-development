"""
option_tick.py — §8.4 Option Tick Features (ATM ±3 window, per strike × CE/PE).
Also covers §8.21 `premium_momentum_10` (10-tick option feature).

For each of the 7 ATM ±3 strikes × 2 option types (CE/PE) = 14 pairs, computes:

    tick_available          1 if strike has received ≥1 tick this session, else 0
    ltp                     Last traded price (NaN if tick_available = 0)
    bid                     Best bid
    ask                     Best ask
    spread                  ask - bid
    volume                  Cumulative day volume
    bid_ask_imbalance       (bid_size - ask_size) / (bid_size + ask_size)
                            NaN if bid_size + ask_size = 0
    premium_momentum        ltp_now - ltp_5_ticks_ago
                            NaN if buffer < 5 or time_span > staleness_threshold
    premium_momentum_10     ltp_now - ltp_10_ticks_ago   (§8.21)
                            NaN if buffer < 10 or time_span > staleness_threshold

Return value:
    dict keyed by (strike: int, opt_type: str) → dict of 9 float/int features.
    Absent strikes (not in atm_window) are silently omitted.

Null handling:
    If tick_available = 0 all fields except tick_available are NaN.
    bid_ask_imbalance is NaN even when tick_available = 1 if both sizes are 0.
    premium_momentum staleness check: newest minus oldest timestamp in the
    N-tick window.  Evaluated on each incoming tick for that strike — no
    proactive invalidation between ticks.
"""

from __future__ import annotations

import math

from tick_feature_agent.buffers.option_buffer import OptionBufferStore, OptionTick

_NAN = float("nan")
_OPT_TYPES = ("CE", "PE")

# Sentinels used when tick_available = 0
_NULL_FEATURES: dict = {
    "tick_available":      0,
    "ltp":                 _NAN,
    "bid":                 _NAN,
    "ask":                 _NAN,
    "spread":              _NAN,
    "volume":              _NAN,
    "bid_ask_imbalance":   _NAN,
    "premium_momentum":    _NAN,
    "premium_momentum_10": _NAN,
}


def _bid_ask_imbalance(tick: OptionTick) -> float:
    denom = float(tick.bid_size) + float(tick.ask_size)
    if denom == 0.0:
        return _NAN
    return (float(tick.bid_size) - float(tick.ask_size)) / denom


def _premium_momentum(
    ticks: list[OptionTick],
    n: int,
    staleness_sec: float,
) -> float:
    """
    Compute premium_momentum over the last `n` ticks.

    Args:
        ticks:          Full tick history for this strike (oldest → newest).
        n:              Window size (5 for §8.4, 10 for §8.21).
        staleness_sec:  Max allowed time span (newest.ts - oldest.ts) in window.

    Returns:
        ltp_now - ltp_n_ago, or NaN if warm-up or stale.
    """
    if len(ticks) < n:
        return _NAN
    window = ticks[-n:]   # length == n, oldest first
    time_span = window[-1].timestamp - window[0].timestamp
    if time_span > staleness_sec:
        return _NAN
    return float(window[-1].ltp) - float(window[0].ltp)


def compute_option_tick_features(
    atm_window: list[int],
    option_store: OptionBufferStore,
    staleness_threshold_sec: float = 60.0,
) -> dict[tuple[int, str], dict]:
    """
    Compute §8.4 (+ §8.21 premium_momentum_10) option tick features.

    Args:
        atm_window:               7-element list [ATM-3s … ATM+3s].
        option_store:             Live per-strike option buffers.
        staleness_threshold_sec:  Max allowed time span for momentum window
                                  (from instrument profile; default 60 s).

    Returns:
        {(strike, opt_type): feature_dict} for all 14 pairs.
        feature_dict has keys: tick_available, ltp, bid, ask, spread, volume,
        bid_ask_imbalance, premium_momentum, premium_momentum_10.
    """
    result: dict[tuple[int, str], dict] = {}

    for strike in atm_window:
        for opt_type in _OPT_TYPES:
            key = (strike, opt_type)

            if not option_store.tick_available(strike, opt_type):
                result[key] = dict(_NULL_FEATURES)   # copy so callers can't mutate sentinel
                continue

            # Retrieve full tick history (maxlen=10 for option buffers)
            ticks = option_store.get_last(strike, opt_type, n=10)
            current = ticks[-1]

            bid_f = float(current.bid)
            ask_f = float(current.ask)

            features: dict = {
                "tick_available":      1,
                "ltp":                 float(current.ltp),
                "bid":                 bid_f,
                "ask":                 ask_f,
                "spread":              ask_f - bid_f,
                "volume":              float(current.volume),
                "bid_ask_imbalance":   _bid_ask_imbalance(current),
                "premium_momentum":    _premium_momentum(ticks, 5,  staleness_threshold_sec),
                "premium_momentum_10": _premium_momentum(ticks, 10, staleness_threshold_sec),
            }
            result[key] = features

    return result
