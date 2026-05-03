"""
meta.py — §8.14 Meta Features.

Pure function: combines Instrument Profile static fields, chain cache
availability flags, and per-tick timing to produce the 9 metadata columns
that every output row carries.

Features (9 outputs):
    exchange                 "NSE" or "MCX"  (from Instrument Profile)
    instrument               Instrument name, e.g. "NIFTY"
    underlying_symbol        Active futures contract, e.g. "NIFTY25MAYFUT"
    underlying_security_id   Broker-assigned security ID string
    chain_timestamp          Unix timestamp (float) of current chain snapshot;
                             None if chain_available = False
    time_since_chain_sec     tick_time - chain_timestamp; None if no chain
    chain_available          1 if first snapshot received, else 0
    data_quality_flag        1 = valid; 0 = any quality gate failed (see below)
    is_market_open           1 during session hours, else 0

data_quality_flag = 0 when ANY of the following:
    - chain_available = 0  (no snapshot yet, or post-rollover before new one)
    - vol_diff_available = 0  (first snapshot received, no diff baseline yet)
    - underlying_tick_count < 20  (20-tick buffer not yet full; also covers
      the 5-tick buffer warm-up for ticks 1–4 since 4 < 20)
    - time_since_chain_sec > 30  (chain snapshot is stale)
    - underlying_feed_stale = True  (no underlying tick within timeout)
    - option_feed_stale = True  (any ATM ±3 CE/PE not ticked within timeout)
    - symbol_mismatch = True  (UNDERLYING_SYMBOL_MISMATCH or
      INSTRUMENT_PROFILE_MISMATCH detected by caller)

NOTE: The 50-tick buffer warm-up (ticks 1–49) does NOT lower data_quality_flag.
50-tick-dependent features emit NaN independently; consumers should check
feature-level NaN rather than the quality flag for 50-tick readiness.
"""

from __future__ import annotations

from tick_feature_agent.chain_cache import ChainCache
from tick_feature_agent.instrument_profile import InstrumentProfile

_CHAIN_STALE_THRESHOLD_SEC = 30.0


def compute_meta_features(
    profile: InstrumentProfile,
    cache: ChainCache,
    tick_time: float,
    underlying_tick_count: int,
    is_market_open: bool,
    underlying_feed_stale: bool = False,
    option_feed_stale: bool = False,
    symbol_mismatch: bool = False,
) -> dict:
    """
    Compute §8.14 metadata features for the current tick.

    Args:
        profile:                InstrumentProfile (static, loaded at startup).
        cache:                  Live ChainCache (updated before this call).
        tick_time:              Unix epoch seconds of the current tick.
        underlying_tick_count:  Total underlying ticks received this session
                                (1-indexed: first tick = 1).
        is_market_open:         True if current tick falls within session hours.
        underlying_feed_stale:  True if no underlying tick received within
                                profile.underlying_tick_timeout_sec of now.
        option_feed_stale:      True if any ATM ±3 CE/PE instrument has not
                                received a tick within profile.option_tick_timeout_sec.
        symbol_mismatch:        True if UNDERLYING_SYMBOL_MISMATCH or
                                INSTRUMENT_PROFILE_MISMATCH was detected on
                                this tick by the caller.

    Returns:
        Dict of 9 metadata features.
    """
    # ── Chain timestamp and staleness ─────────────────────────────────────────
    chain_ts: float | None = None
    time_since_chain: float | None = None

    if cache.chain_available and cache.snapshot is not None:
        chain_ts = cache.snapshot.timestamp_sec
        time_since_chain = tick_time - chain_ts

    # ── data_quality_flag ─────────────────────────────────────────────────────
    quality = 1

    if not cache.chain_available:
        quality = 0
    elif not cache.vol_diff_available:
        quality = 0
    elif underlying_tick_count < 20:
        # 20-tick buffer not yet full (also covers 5-tick warm-up for ticks 1–4)
        quality = 0
    elif time_since_chain is not None and time_since_chain > _CHAIN_STALE_THRESHOLD_SEC:
        quality = 0
    elif underlying_feed_stale:
        quality = 0
    elif option_feed_stale:
        quality = 0
    elif symbol_mismatch:
        quality = 0

    return {
        "exchange": profile.exchange,
        "instrument": profile.instrument_name,
        "underlying_symbol": profile.underlying_symbol,
        "underlying_security_id": profile.underlying_security_id,
        "chain_timestamp": chain_ts,
        "time_since_chain_sec": time_since_chain,
        "chain_available": 1 if cache.chain_available else 0,
        "data_quality_flag": quality,
        "is_market_open": 1 if is_market_open else 0,
    }
