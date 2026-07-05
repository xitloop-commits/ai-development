"""
emitter.py — Flat per-tick feature vector assembly + NDJSON / Parquet output.

The output column count is **dynamic per instrument profile**: the
target-variable block contributes `len(target_windows_sec) * 12 + 1`
columns (Wave 2 added 5 new target types), and Phase 2 of v2 appends
a trend/swing Layer-1 block of 69 features (23 B-block multi-TF + 46
C-block context features) AFTER the legacy 402-column scalp layout.

So the 2-window profile now lands at 402 + 69 = 471 columns, and the
canonical 4-window profile (`[30, 60, 300, 900]`) lands at 426 + 69 =
495 columns. Per Phase E8 / D4 the canonical live profile uses 4 windows;
the 2-window legacy layout is still supported (replay of pre-D4 data,
tests).

Use `column_names_for(target_windows_sec)` to get the ordered tuple
for any profile, and `int_columns_for(target_windows_sec)` to get the
matching `direction_<W>s` int-typed-column set. The module-level
`COLUMN_NAMES` and `_INT_COLUMNS` exports default to the 2-window
layout for backward compat with pre-E8 callers and exist primarily
for tests; production code should pass the actual profile windows
through `Emitter(target_windows_sec=profile.target_windows_sec, ...)`.

Assembles all per-tick feature groups into a single ordered flat dict
matching the wire format defined in spec §9.1, then serialises to NDJSON.

Column groups (counts shown for the 2-window default profile = 471 total;
4-window canonical profile lands at 495):
    1        timestamp
    2–13     Underlying Base (12)
    14–33    Underlying Extended: OFI + Realized Vol + Multi-Window (20)
    34–36    ATM Context (3)
    37–41    Compression & Breakout (5)
    42–45    Time-to-Move (4)
    46–171   Option Tick ATM ±3, 7 offsets × 9 CE + 9 PE columns (126)
    172–180  Option Chain (9)
    181–324  Active Strikes, 6 slots × 24 columns (144)
    325–328  Cross-Feature Intelligence (4)
    329–333  Decay & Dead Market Detection (5)
    334–335  Regime Classification (2)
    336–342  Zone Aggregation (7)
    343–367  Target Variables — 25 columns (default [30s, 60s] windows, Wave 2)
    368–371  Trading State (4)
    372–380  Metadata (9)
    381–388  Wave 1 Levels — S/R distances + OI walls (8)
    389–397  Wave 1 Greeks — ATM IV + Black-Scholes Greeks (9)
    398–402  Wave 1 Expiry — DTE + session position (5)
    403–471  Phase 2 trend/swing Layer-1 (69) — see _PHASE2_BC_COLUMNS:
             B1 multi-TF MAs (5), B2 trend strength (3), B3 session
             relative (4), B4 multi-bar patterns (3), B5 opening range
             (2) + cross-day levels (6), C1 OI flow (12), C2 technical
             (5), C3 vol regime (2), C4 dealer hedging (5), C5 exhaustion
             (2), C6 intraday timing (3), C7 strike rotation (3), C8
             premium VWAP (3), C9 IV velocity (4), C10 max pain (3),
             C11 event calendar (3), C12 expiry bucket (1).

Schema registry write behaviour (V2_MASTER_SPEC §2.3 D74 B1 — LOCKED 2026-05-17):
    The Emitter is the AUTHORITATIVE writer for `config/schema_registry/v<N>.json`.
    On Emitter construction it compares `LATEST_SCHEMA_VERSION` against the
    highest `v<N>.json` already on disk and only writes a fresh file if the
    constant is strictly HIGHER. Failure to write is logged (warning) but
    never raised — the data pipeline must never be blocked by a registry
    bookkeeping problem.

Public API:
    column_names_for(windows)       → tuple[str, ...]   Ordered column names for any profile windows
    int_columns_for(windows)        → frozenset[str]    Int32-typed parquet columns for those windows
    COLUMN_NAMES                    Tuple of column name strings for the 2-window default (legacy)
    assemble_flat_vector(**kwargs)  → dict              Build ordered flat dict
    serialize_row(row)              → str               NaN/None → JSON null, no trailing newline
    Emitter(target_windows_sec=...) Class managing file + socket + parquet output sinks
    LATEST_SCHEMA_VERSION           Int. Bumped on every additive schema change.

NaN encoding:
    Python float('nan') and Python None both become JSON null in wire output.
    Strings use "" for missing values (spec §9.1 encoding rules).
"""

from __future__ import annotations

import json
import logging
import math
import os
import socket
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import IO

_NAN = float("nan")

# ── Schema versioning ─────────────────────────────────────────────────────
# Bump LATEST_SCHEMA_VERSION on every additive schema change. The Emitter
# constructor writes a fresh `config/schema_registry/v<N>.json` on startup
# if this constant exceeds the highest version currently on disk. Per
# V2_MASTER_SPEC §2.3 D74 B1 (LOCKED 2026-05-17), the emitter is the SOLE
# authoritative writer of the registry.
#
# Schema version log (each row = one bump = one v<N>.json file shipped):
#
#   v6 (scalp-targets-expanded) — Wave 2 scalp added 5 new target types per
#        window (direction_persists, breakout_in, exit_signal, max_upside_pe,
#        max_drawdown_pe), +10 target cols on the 2-window profile. Landed
#        2-window at 402.
#
#   v7 (trend-swing-features) — Phase 2 added 69 trend/swing Layer-1 input
#        features (23 B-block: bars / session / opening-range / multi-TF;
#        46 C-block: VIX / dealer-hedging / events / OI flow / IV velocity /
#        technicals / etc.). Landed 2-window at 471, 4-window at 495.
#
#   v8 (trend-swing-targets) — Phase 3 added 24 trend + swing target labels
#        (6 types × 4 horizons: 15m/30m for trend, 1h/2h for swing). These
#        are populated by the replay backfill pipeline; live emits NaN per
#        the Option B decision (2026-05-18). Lands 2-window at 495, 4-window
#        at 519.
#
# Each version's file at config/schema_registry/v<N>.json captures the
# exact ordered column list so downstream consumers (SEA, retrain) can
# reconcile parquets written by older emitters.
# v9 (2026-06-13 — T37): added 26 ATM-only order-book depth columns
#   (opt_0_ce_depth_* + opt_0_pe_depth_*, 13 keys per side).
#   Pure additive: prior parquet schemas remain backward-compatible.
# v10 (2026-06-13 — T14 scope F): added 3 stateful Layer-1 features:
#   premium_acceleration_drop_atm_ce / _pe (ATM second-derivative of
#   premium momentum) + strike_migration_persistence_ticks (counter
#   of consecutive-same-direction strike shifts).
# v11 (2026-06-20 — target-window profile bump): TFA now runs with the
#   (60, 120, 180, 240, 300) profile (was 30s/900s); this swaps 25 old
#   target columns (direction_30s, _900s, etc.) for 37 new ones
#   (direction_120s/180s/240s + persists/breakout/exit/upside/drawdown
#   per window). Net +12 columns to 560. MVP_TARGETS already targets
#   the new windows; v10.json was structurally inconsistent until now.
# v12 (2026-07-05 — pivot structure): added 12 intraday market-structure
#   FEATURE columns from the stateful PivotStructureTracker — swing + trend
#   fractal pivots, each emitting dist_high/low_pct, structure (+1/0/-1),
#   high_is_hh, low_is_hl, bars_since. Pure additive; prior columns unchanged.
LATEST_SCHEMA_VERSION: int = 12

_log = logging.getLogger("tick_feature_agent.emitter")

# ── Internal: underlying bare-key lists ─────────────────────────────────────

# Keys returned by compute_underlying_features() WITHOUT the underlying_ prefix.
# Must stay in sync with features/underlying.py output.
_UNDERLYING_BASE_BARE = (
    "ltp",
    "bid",
    "ask",
    "spread",
    "return_5ticks",
    "return_20ticks",
    "momentum",
    "velocity",
    "tick_up_count_20",
    "tick_down_count_20",
    "tick_flat_count_20",
    "tick_imbalance_20",
)  # 12 keys

_UNDERLYING_EXTENDED_BARE_FROM_UF = (
    # keys from compute_underlying_features() that land in the Extended group
    "return_10ticks",
    "tick_up_count_10",
    "tick_down_count_10",
    "tick_flat_count_10",
    "tick_imbalance_10",
    "return_50ticks",
    "tick_up_count_50",
    "tick_down_count_50",
    "tick_flat_count_50",
    "tick_imbalance_50",
)  # 10 keys

# Keys already carrying the underlying_ prefix (from ofi, realized_vol, horizon)
_UNDERLYING_EXTENDED_PREFIXED = (
    "underlying_trade_direction",
    "underlying_ofi_5",
    "underlying_ofi_20",
    "underlying_ofi_50",
    "underlying_realized_vol_5",
    "underlying_realized_vol_20",
    "underlying_realized_vol_50",
    "underlying_return_10ticks",
    "underlying_tick_up_count_10",
    "underlying_tick_down_count_10",
    "underlying_tick_flat_count_10",
    "underlying_tick_imbalance_10",
    "underlying_return_50ticks",
    "underlying_tick_up_count_50",
    "underlying_tick_down_count_50",
    "underlying_tick_flat_count_50",
    "underlying_tick_imbalance_50",
    "underlying_horizon_momentum_ratio",
    "underlying_horizon_vol_ratio",
    "underlying_horizon_ofi_ratio",
)  # 20 keys — same order as spec cols 14–33

# ── Internal: option tick structure ──────────────────────────────────────────

# ATM offsets in the order they appear in the wire format (spec cols 46–171)
_OPT_OFFSETS = ("m3", "m2", "m1", "0", "p1", "p2", "p3")  # 7 offsets
_OPT_SIDES = ("ce", "pe")  # 2 sides (CE then PE within each offset)
_OPT_SIDE_MAP = {"ce": "CE", "pe": "PE"}

# Per-side column suffixes in order (9 per side)
_OPT_FIELD_NAMES = (
    "tick_available",
    "ltp",
    "bid",
    "ask",
    "spread",
    "volume",
    "bid_ask_imbalance",
    "premium_momentum",
    "premium_momentum_10",
)

# T37 (2026-06-13): depth-feature suffixes for ATM ONLY (offset "0").
# Far-OTM depth would be mostly NaN and triple the schema width for
# negligible signal — emit at ATM only where the book is consistently
# active. 13 keys × 2 sides (CE/PE) = 26 new columns total.
# Source of truth lives in features/option_depth.py.
from tick_feature_agent.features.option_depth import (  # noqa: E402
    _empty_feature_dict as _empty_depth_dict,
)
_DEPTH_FIELD_NAMES: tuple[str, ...] = tuple(_empty_depth_dict().keys())

# NaN sentinel for missing option data (used when strike absent from snapshot)
_OPT_NULL: dict = {
    "tick_available": 0,
    "ltp": _NAN,
    "bid": _NAN,
    "ask": _NAN,
    "spread": _NAN,
    "volume": _NAN,
    "bid_ask_imbalance": _NAN,
    "premium_momentum": _NAN,
    "premium_momentum_10": _NAN,
}

# ── Internal: active strike slot columns ─────────────────────────────────────

# 24 per-slot sub-columns in order (matches active_features.py output + spec)
_ACTIVE_SLOT_FIELDS = (
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
)  # 24 fields

_CROSS_FEATURE_KEYS = (
    "call_put_strength_diff",
    "call_put_volume_diff",
    "call_put_oi_diff",
    "premium_divergence",
)

# ── Internal: remaining group keys ───────────────────────────────────────────

_CHAIN_KEYS = (
    "chain_pcr_global",
    "chain_pcr_atm",
    "chain_oi_total_call",
    "chain_oi_total_put",
    "chain_oi_change_call",
    "chain_oi_change_put",
    "chain_oi_change_call_atm",
    "chain_oi_change_put_atm",
    "chain_oi_imbalance_atm",
)

_DECAY_KEYS = (
    "total_premium_decay_atm",
    "momentum_decay_20ticks_atm",
    "volume_drought_atm",
    "active_strike_count",
    "dead_market_score",
)

_ZONE_KEYS = (
    "atm_zone_call_pressure",
    "atm_zone_put_pressure",
    "atm_zone_net_pressure",
    "active_zone_call_count",
    "active_zone_put_count",
    "active_zone_dominance",
    "zone_activity_score",
)

_META_KEYS = (
    "exchange",
    "instrument",
    "underlying_symbol",
    "underlying_security_id",
    "chain_timestamp",
    "time_since_chain_sec",
    "chain_available",
    "data_quality_flag",
    "is_market_open",
)

# ── Wave 1 (Phase 1A Layer 1) feature blocks ──────────────────────────────
# Appended AFTER metadata so legacy column indices (0–369) are preserved.
# Adds 22 columns: 8 S/R + 9 IV/Greek + 5 DTE = total parquet width 392.

_LEVEL_KEYS = (
    "distance_to_day_high_pct",
    "distance_to_day_low_pct",
    "distance_to_prev_close_pct",
    "day_range_position",
    "max_call_oi_strike",
    "max_put_oi_strike",
    "distance_to_max_call_oi_strike_pct",
    "distance_to_max_put_oi_strike_pct",
)

_GREEK_KEYS = (
    "atm_ce_iv",
    "atm_pe_iv",
    "iv_skew_atm",
    "atm_ce_delta",
    "atm_pe_delta",
    "atm_gamma",
    "atm_ce_theta",
    "atm_pe_theta",
    "atm_vega",
)

_EXPIRY_KEYS = (
    "days_to_expiry",
    "hours_to_expiry",
    "is_expiry_day",
    "is_monthly_expiry",
    "session_remaining_pct",
)

# ── Phase 2 (v2 trend/swing) Layer-1 feature blocks ────────────────────────
# Appended AFTER Wave 1 so legacy column indices (0–401) are preserved.
# 23 B-block + 46 C-block = 69 new columns. Order locked here is the
# order published in v7.json — never reorder within a published schema.
# Keys match the EXACT dict keys returned by each feature module's
# compute_*() function so the assembler can blindly merge them in.

# B1 — Multi-timeframe MAs (5 keys from features/multi_tf.py)
_B1_MA_KEYS = (
    "ma_5_1min",
    "ma_20_1min",
    "ma_5_5min",
    "ma_20_5min",
    "ma_5_15min",
)

# B2 — Trend strength (3 keys from features/multi_tf.py)
_B2_TREND_STRENGTH_KEYS = (
    "adx_5min",
    "momentum_5min",
    "momentum_15min",
)

# B3 — Session relative (4 keys from features/session.py)
_B3_SESSION_KEYS = (
    "dist_from_session_open_pct",
    "dist_from_session_vwap_pct",
    "session_high_age_min",
    "session_low_age_min",
)

# B4 — Multi-bar patterns (3 keys from features/multi_tf.py)
_B4_PATTERN_KEYS = (
    "consecutive_higher_highs_5min",
    "consecutive_higher_lows_5min",
    "range_compression_ratio",
)

# B5 — Opening range (2 keys from features/opening_range.py)
_B5_OPENING_RANGE_KEYS = (
    "distance_to_opening_range_high_pct",
    "distance_to_opening_range_low_pct",
)

# B5 — Cross-day levels (6 keys from features/levels.py compute_cross_day_level_features)
_B5_CROSS_DAY_KEYS = (
    "distance_to_prev_day_high_pct",
    "distance_to_prev_day_low_pct",
    "distance_to_round_number_above_pct",
    "distance_to_round_number_below_pct",
    "distance_to_5d_swing_high_pct",
    "distance_to_5d_swing_low_pct",
)

# C1 — OI flow / dominance (12 keys spread across features/oi_dominance.py
#      and features/chain.py {wall_strength, oi_change_deltas, oi_weighted_levels, pcr_slope})
_C1_OI_FLOW_KEYS = (
    "oi_dominance_streak_min",
    "ce_wall_strength_rel",
    "pe_wall_strength_rel",
    "ce_oi_change_5min_pct",
    "pe_oi_change_5min_pct",
    "ce_oi_change_15min_pct",
    "pe_oi_change_15min_pct",
    "ce_oi_change_60min_pct",
    "pe_oi_change_60min_pct",
    "oi_weighted_ce_resistance_strike",
    "oi_weighted_pe_support_strike",
    "pcr_intraday_slope_30min",
)

# C2 — Technical oscillators on 5-min bars (5 keys from features/technical.py)
_C2_TECHNICAL_KEYS = (
    "rsi_14_5min",
    "macd_5min",
    "macd_signal_5min",
    "macd_histogram_5min",
    "volume_price_divergence_5min",
)

# C3 — Vol regime (2 keys from features/india_vix.py)
_C3_VIX_KEYS = (
    "india_vix",
    "india_vix_change_5min",
)

# C4 — Dealer hedging / GEX (5 keys from features/dealer_hedging.py)
_C4_DEALER_HEDGING_KEYS = (
    "net_gex",
    "gamma_flip_distance_pct",
    "dealer_net_delta",
    "charm_estimate_atm",
    "vanna_estimate_atm",
)

# C5 — Trend exhaustion (2 keys from features/exhaustion.py)
_C5_EXHAUSTION_KEYS = (
    "trend_age_ticks",
    "volume_no_move_score",
)

# C6 — Intraday timing (3 keys from features/intraday_time.py)
_C6_INTRADAY_TIME_KEYS = (
    "minutes_from_open",
    "minutes_to_close",
    "lunch_session_flag",
)

# C7 — Strike rotation (3 keys from features/active_features.py compute_strike_rotation_features)
_C7_STRIKE_ROTATION_KEYS = (
    "active_strike_shift_direction",
    "active_strike_shift_velocity",
    "atm_to_otm_flow_ratio",
)

# C8 — Premium VWAP (3 keys from features/premium_vwap.py)
_C8_PREMIUM_VWAP_KEYS = (
    "atm_ce_premium_vwap_dist",
    "atm_pe_premium_vwap_dist",
    "premium_vwap_reclaim_count",
)

# C9 — IV velocity (4 keys from features/greeks.py compute_iv_velocity_features)
_C9_IV_VELOCITY_KEYS = (
    "iv_change_1min",
    "iv_change_5min",
    "iv_skew_velocity",
    "iv_expansion_without_spot",
)

# C10 — Max pain (3 keys from features/levels.py compute_max_pain_features)
_C10_MAX_PAIN_KEYS = (
    "max_pain_strike",
    "distance_to_max_pain_pct",
    "max_pain_gravity_strength",
)

# C11 — Macro-event calendar (3 keys from features/event_calendar.py)
_C11_EVENT_CALENDAR_KEYS = (
    "is_tier_2_event_day",
    "event_type_categorical",
    "hours_to_next_tier_1_or_2_event",
)

# T14 scope F (2026-06-13) — 3 keys: ATM premium-acceleration drop per leg,
# + strike-migration persistence counter. Stateful (sourced from
# features/premium_acceleration.py + features/strike_migration_persistence.py
# via the adapter). Schema bumped v9 → v10.
_T14F_KEYS = (
    "premium_acceleration_drop_atm_ce",
    "premium_acceleration_drop_atm_pe",
    "strike_migration_persistence_ticks",
)

# C12 — Expiry bucket (1 new key on top of existing _EXPIRY_KEYS — added to
#       features/expiry.py compute_expiry_features). Appended here rather
#       than inside _EXPIRY_KEYS so the Wave 1 expiry column ordering is
#       preserved bit-for-bit with v6.
_C12_EXPIRY_BUCKET_KEYS = (
    "days_to_expiry_bucket",
)

# Ordered concatenation of every Phase 2 column group. This is the
# load-bearing source of truth — `_build_column_names` appends this
# block verbatim after the Wave 1 columns.
_PHASE2_BC_COLUMNS: tuple[str, ...] = (
    *_B1_MA_KEYS,
    *_B2_TREND_STRENGTH_KEYS,
    *_B3_SESSION_KEYS,
    *_B4_PATTERN_KEYS,
    *_B5_OPENING_RANGE_KEYS,
    *_B5_CROSS_DAY_KEYS,
    *_C1_OI_FLOW_KEYS,
    *_C2_TECHNICAL_KEYS,
    *_C3_VIX_KEYS,
    *_C4_DEALER_HEDGING_KEYS,
    *_C5_EXHAUSTION_KEYS,
    *_C6_INTRADAY_TIME_KEYS,
    *_C7_STRIKE_ROTATION_KEYS,
    *_C8_PREMIUM_VWAP_KEYS,
    *_C9_IV_VELOCITY_KEYS,
    *_C10_MAX_PAIN_KEYS,
    *_C11_EVENT_CALENDAR_KEYS,
    *_C12_EXPIRY_BUCKET_KEYS,
)

assert len(_PHASE2_BC_COLUMNS) == 69, (
    f"_PHASE2_BC_COLUMNS expected 69 entries (23 B-block + 46 C-block), "
    f"got {len(_PHASE2_BC_COLUMNS)}"
)
assert len(set(_PHASE2_BC_COLUMNS)) == len(_PHASE2_BC_COLUMNS), (
    "Duplicate column name detected in _PHASE2_BC_COLUMNS"
)


# ── Phase 3 trend + swing target columns (36, v8 schema + Part B) ────────
# Nine target types × four horizons (trend 900s/1800s + swing 3600s/7200s).
# Part B added direction_down (2026-07-02) + reversal + exit_signal
# (2026-07-04) per layer/horizon (+12 cols total over the original 24).
# See features/trend_swing_targets.py for the compute logic. Replay
# populates these from end-of-day raw recordings; live emits NaN per the
# Option B decision (2026-05-18). This is a label-only addition — the model
# feature vector is unchanged, so LATEST_SCHEMA_VERSION stays at 11.
from tick_feature_agent.features.trend_swing_targets import (  # noqa: E402
    trend_swing_target_column_names as _trend_swing_target_column_names,
)

_TREND_SWING_TARGET_COLUMNS: tuple[str, ...] = _trend_swing_target_column_names()
assert len(_TREND_SWING_TARGET_COLUMNS) == 36, (
    f"_TREND_SWING_TARGET_COLUMNS expected 36 (9 types × 4 horizons), "
    f"got {len(_TREND_SWING_TARGET_COLUMNS)}"
)

# Intraday market-structure pivots (swing + trend). These are model FEATURES
# (not labels), sourced from the stateful PivotStructureTracker. Additive →
# LATEST_SCHEMA_VERSION bumped 11 → 12.
from tick_feature_agent.features.pivot_structure import (  # noqa: E402
    pivot_structure_column_names as _pivot_structure_column_names,
)

_PIVOT_STRUCTURE_KEYS: tuple[str, ...] = _pivot_structure_column_names()
assert len(_PIVOT_STRUCTURE_KEYS) == 12, (
    f"_PIVOT_STRUCTURE_KEYS expected 12 (6 per scale × swing/trend), "
    f"got {len(_PIVOT_STRUCTURE_KEYS)}"
)

# ── Target column generation ──────────────────────────────────────────────────


def _build_target_columns(target_windows_sec: tuple[int, ...]) -> tuple[str, ...]:
    """
    Build ordered target column names for the given windows (spec §8.13).

    Column order:
        max_upside_Xs for each X
        max_drawdown_Xs for each X
        risk_reward_ratio_Xs for each X
        total_premium_decay_Xs for each X
        avg_decay_per_strike_Xs for each X
        direction_Xs, direction_Xs_magnitude for each X  (interleaved per window)
        direction_persists_Xs for each X     (Wave 2)
        breakout_in_Xs for each X            (Wave 2)
        exit_signal_Xs for each X            (Wave 2)
        max_upside_pe_Xs for each X          (Wave 2)
        max_drawdown_pe_Xs for each X        (Wave 2)
        upside_percentile_{min(windows)}s  (only for smallest window)

    Args:
        target_windows_sec: Tuple of window sizes, e.g. (30, 60).

    Returns:
        Ordered tuple of column name strings.
    """
    cols: list[str] = []
    for x in target_windows_sec:
        cols.append(f"max_upside_{x}s")
    for x in target_windows_sec:
        cols.append(f"max_drawdown_{x}s")
    for x in target_windows_sec:
        cols.append(f"risk_reward_ratio_{x}s")
    for x in target_windows_sec:
        cols.append(f"total_premium_decay_{x}s")
    for x in target_windows_sec:
        cols.append(f"avg_decay_per_strike_{x}s")
    for x in target_windows_sec:
        cols.append(f"direction_{x}s")
        cols.append(f"direction_{x}s_magnitude")
    # Wave 2 additions (5 new types)
    for x in target_windows_sec:
        cols.append(f"direction_persists_{x}s")
    for x in target_windows_sec:
        cols.append(f"breakout_in_{x}s")
    for x in target_windows_sec:
        cols.append(f"exit_signal_{x}s")
    for x in target_windows_sec:
        cols.append(f"max_upside_pe_{x}s")
    for x in target_windows_sec:
        cols.append(f"max_drawdown_pe_{x}s")
    for x in target_windows_sec:
        cols.append(f"risk_reward_ratio_pe_{x}s")  # Part B: PE-leg RR
    cols.append(f"upside_percentile_{min(target_windows_sec)}s")
    return tuple(cols)


# ── Build COLUMN_NAMES ────────────────────────────────────────────────────────


def _build_column_names(
    target_windows_sec: tuple[int, ...] = (30, 60),
) -> tuple[str, ...]:
    """Build the full ordered column-name tuple for the given target
    windows.

    Counts: 402 for default 2-window profile + 69 Phase 2 trend/swing
    features = 471. 4-window (`[30, 60, 300, 900]`) profile lands at
    426 + 69 = 495.
    """
    cols: list[str] = []

    # Col 1: timestamp
    cols.append("timestamp")

    # Cols 2–13: Underlying Base (12)
    for k in _UNDERLYING_BASE_BARE:
        cols.append(f"underlying_{k}")

    # Cols 14–33: Underlying Extended (20, already prefixed)
    cols.extend(_UNDERLYING_EXTENDED_PREFIXED)

    # Cols 34–36: ATM Context (3)
    cols.extend(("spot_price", "atm_strike", "strike_step"))

    # Cols 37–41: Compression & Breakout (5)
    #   37–40 from compression module, 41 (breakout_readiness) from time_to_move
    cols.extend(
        (
            "range_20ticks",
            "range_percent_20ticks",
            "volatility_compression",
            "spread_tightening_atm",
            "breakout_readiness",
        )
    )

    # Cols 42–45: Time-to-Move (4)
    cols.extend(
        (
            "time_since_last_big_move",
            "stagnation_duration_sec",
            "momentum_persistence_ticks",
            "breakout_readiness_extended",
        )
    )

    # Cols 46–171: Option Tick (7 offsets × 9 CE + 9 PE = 126)
    for off in _OPT_OFFSETS:
        for side in _OPT_SIDES:
            for fname in _OPT_FIELD_NAMES:
                cols.append(f"opt_{off}_{side}_{fname}")

    # T37 (2026-06-13): ATM-only depth columns (26 = 2 sides × 13 keys).
    # Schema v9. Far-OTM depth not emitted — see assemble_flat_vector.
    for side in _OPT_SIDES:
        for fname in _DEPTH_FIELD_NAMES:
            cols.append(f"opt_0_{side}_{fname}")

    # Cols 172–180: Option Chain (9)
    cols.extend(_CHAIN_KEYS)

    # Cols 181–324: Active Strikes (6 × 24 = 144)
    for slot in range(6):
        for field in _ACTIVE_SLOT_FIELDS:
            cols.append(f"active_{slot}_{field}")

    # Cols 325–328: Cross-Feature Intelligence (4)
    cols.extend(_CROSS_FEATURE_KEYS)

    # Cols 329–333: Decay & Dead Market (5)
    cols.extend(_DECAY_KEYS)

    # Cols 334–335: Regime Classification (2)
    cols.extend(("regime", "regime_confidence"))

    # Cols 336–342: Zone Aggregation (7)
    cols.extend(_ZONE_KEYS)

    # Cols 343–357: Target Variables (15 for default [30, 60])
    cols.extend(_build_target_columns(target_windows_sec))

    # Cols 358–361: Trading State (4)
    cols.extend(("trading_state", "trading_allowed", "warm_up_remaining_sec", "stale_reason"))

    # Cols 362–370: Metadata (9)
    cols.extend(_META_KEYS)

    # Cols 371–378: Wave 1 levels (8) — S/R distances, OI walls
    cols.extend(_LEVEL_KEYS)

    # Cols 379–387: Wave 1 greeks (9) — ATM IV + Black-Scholes greeks
    cols.extend(_GREEK_KEYS)

    # Cols 388–392: Wave 1 expiry (5) — DTE + session position
    cols.extend(_EXPIRY_KEYS)

    # Cols 403–471 (2-window) / 427–495 (4-window): Phase 2 trend/swing
    # Layer-1 features (69) — 23 B-block + 46 C-block.
    cols.extend(_PHASE2_BC_COLUMNS)

    # Phase 3 trend + swing target labels (24, v8 schema). Same set for
    # every profile — horizons are fixed (900s/1800s trend, 3600s/7200s
    # swing). Replay-pass populates these; live emits NaN.
    cols.extend(_TREND_SWING_TARGET_COLUMNS)

    # T14 scope F (Schema v10, 2026-06-13): 3 stateful features —
    # ATM premium-acceleration drop per leg + strike-migration counter.
    cols.extend(_T14F_KEYS)

    # Intraday market-structure pivots (Schema v12, 2026-07-05): 12 features —
    # swing + trend fractal pivots (HH/HL/LH/LL structure + S/R distances).
    cols.extend(_PIVOT_STRUCTURE_KEYS)

    return tuple(cols)


def column_names_for(target_windows_sec: tuple[int, ...]) -> tuple[str, ...]:
    """Return the ordered tuple of column names for a profile with these
    target windows. Public, dynamic alternative to the module-level
    `COLUMN_NAMES` global. Phase E8 / PY-15. The function is a thin
    public alias over `_build_column_names`."""
    return _build_column_names(tuple(target_windows_sec))


#: Ordered column names for the default 2-window (30s, 60s) configuration.
#: Kept as a backward-compat export — pre-E8 callers reference this
#: directly. Production code should prefer `column_names_for(windows)`.
COLUMN_NAMES: tuple[str, ...] = _build_column_names((30, 60))

assert len(set(COLUMN_NAMES)) == len(COLUMN_NAMES), "Duplicate column name detected in COLUMN_NAMES"


# ══════════════════════════════════════════════════════════════════════════════
# Flat vector assembly
# ══════════════════════════════════════════════════════════════════════════════


def assemble_flat_vector(
    *,
    timestamp: float,
    spot_price: float,
    atm_strike: int | None,
    strike_step: int | None,
    atm_window: list[int],
    underlying_feats: dict,
    ofi_feats: dict,
    realized_vol_feats: dict,
    horizon_feats: dict,
    compression_feats: dict,
    time_to_move_feats: dict,
    opt_tick_feats: dict,
    chain_feats: dict,
    active_feats: dict,
    decay_feats: dict,
    regime_feats: dict,
    zone_feats: dict,
    target_feats: dict | None,
    trading_state: str,
    trading_allowed: int,
    warm_up_remaining_sec: float,
    stale_reason: str | None,
    meta_feats: dict,
    target_windows_sec: tuple[int, ...] = (30, 60),
    level_feats: dict | None = None,
    greek_feats: dict | None = None,
    expiry_feats: dict | None = None,
    # ── Phase 2 trend/swing Layer-1 feature dicts (all optional) ───────────
    # Callers (tick_processor / replay_adapter) wire these in once the
    # corresponding compute_* function is integrated upstream. Missing
    # dicts → all keys in that group emit NaN, which is the spec-compliant
    # cold-start behaviour for every Phase 2 feature.
    multi_tf_feats: dict | None = None,        # multi_tf.compute_multi_tf_features (B1+B2+B4)
    session_feats: dict | None = None,         # session.compute_session_features (B3)
    opening_range_feats: dict | None = None,   # opening_range.compute_opening_range_features (B5)
    cross_day_level_feats: dict | None = None, # levels.compute_cross_day_level_features (B5)
    oi_flow_feats: dict | None = None,         # merged C1: oi_dominance + chain (wall_strength,
                                               #   oi_change_deltas, oi_weighted_levels, pcr_slope)
    technical_feats: dict | None = None,       # technical.compute_technical_features (C2)
    vix_feats: dict | None = None,             # india_vix.compute_india_vix_features (C3)
    dealer_hedging_feats: dict | None = None,  # dealer_hedging.compute_dealer_hedging_features (C4)
    exhaustion_feats: dict | None = None,      # exhaustion.compute_exhaustion_features (C5)
    intraday_time_feats: dict | None = None,   # intraday_time.compute_intraday_time_features (C6)
    strike_rotation_feats: dict | None = None, # active_features.compute_strike_rotation_features (C7)
    premium_vwap_feats: dict | None = None,    # premium_vwap.compute_premium_vwap_features (C8)
    iv_velocity_feats: dict | None = None,     # greeks.compute_iv_velocity_features (C9)
    max_pain_feats: dict | None = None,        # levels.compute_max_pain_features (C10)
    event_calendar_feats: dict | None = None,  # event_calendar.compute_event_calendar_features (C11)
    # T14 (scope F, 2026-06-13): premium-acceleration + strike-migration
    # persistence. 3 keys: premium_acceleration_drop_atm_ce,
    # premium_acceleration_drop_atm_pe, strike_migration_persistence_ticks.
    t14_feats: dict | None = None,
    # ── Intraday market-structure pivots (v12): 12 swing/trend pivot features.
    # Dict from PivotStructureTracker.update(); None → all 12 emit NaN/neutral.
    pivot_feats: dict | None = None,
    # ── Phase 3 trend + swing target labels (v8 schema) ─────────────────────
    # Replay backfills these from end-of-day raw data; live emits NaN per
    # the Option B decision (2026-05-18). Pass None to emit NaN for all 24
    # target columns; pass the dict returned by
    # SpotTargetBuffer.compute_targets() to populate them.
    trend_swing_target_feats: dict | None = None,
) -> dict:
    """
    Assemble all per-tick feature groups into a single ordered flat dict.

    Column order matches spec §9.1 exactly. The returned dict is ordered (Python
    3.7+ dict insertion order). Default 2-window profile → 471 keys; canonical
    4-window profile → 495 keys (includes 69 Phase 2 trend/swing Layer-1
    features appended after the Wave 1 columns).

    Args:
        timestamp:            Unix timestamp of the current tick.
        spot_price:           Underlying LTP used as spot proxy.
        atm_strike:           Current ATM strike (None before first snapshot).
        strike_step:          Strike grid step (None before first snapshot).
        atm_window:           7-element ATM ±3 strike list ([] before snapshot).
        underlying_feats:     From compute_underlying_features() — bare keys.
        ofi_feats:            From compute_ofi_features() — prefixed keys.
        realized_vol_feats:   From compute_realized_vol_features() — prefixed.
        horizon_feats:        From compute_horizon_features() — prefixed.
        compression_feats:    From CompressionState.compute().
        time_to_move_feats:   From TimeToMoveState.compute().
        opt_tick_feats:       From compute_option_tick_features() —
                              {(strike, opt_type): {field: value}}.
        chain_feats:          From compute_chain_features() — chain_ prefixed.
        active_feats:         From compute_active_features() — 148-key flat dict.
        decay_feats:          From DecayState.compute().
        regime_feats:         From compute_regime_features().
        zone_feats:           From compute_zone_features().
        target_feats:         From targets module (Phase 10). Pass None or {} to
                              fill all target columns with NaN.
        trading_state:        State machine string: TRADING/FEED_STALE/WARMING_UP.
        trading_allowed:      1 or 0.
        warm_up_remaining_sec: Seconds until warm-up completes (0.0 when TRADING).
        stale_reason:         State machine stale reason string or None.
        meta_feats:           From compute_meta_features().
        target_windows_sec:   Window sizes from instrument profile (default (30,60)).

    Returns:
        Ordered dict with exactly 370 keys, values ready for JSON serialisation
        (float NaN is still float('nan') here; call serialize_row() to convert
        to JSON-safe form).
    """
    row: dict = {}
    targets = target_feats or {}

    # ── Col 1: timestamp ──────────────────────────────────────────────────────
    row["timestamp"] = timestamp

    # ── Cols 2–13: Underlying Base ────────────────────────────────────────────
    for k in _UNDERLYING_BASE_BARE:
        row[f"underlying_{k}"] = underlying_feats.get(k, _NAN)

    # ── Cols 14–33: Underlying Extended ──────────────────────────────────────
    # Sources: ofi_feats, realized_vol_feats, underlying_feats (some keys),
    #          horizon_feats — all already carry the underlying_ prefix
    _ext_source = {
        **ofi_feats,
        **realized_vol_feats,
        **{
            f"underlying_{k}": underlying_feats.get(k, _NAN)
            for k in _UNDERLYING_EXTENDED_BARE_FROM_UF
        },
        **horizon_feats,
    }
    for col in _UNDERLYING_EXTENDED_PREFIXED:
        row[col] = _ext_source.get(col, _NAN)

    # ── Cols 34–36: ATM Context ───────────────────────────────────────────────
    row["spot_price"] = spot_price
    row["atm_strike"] = float(atm_strike) if atm_strike is not None else _NAN
    row["strike_step"] = float(strike_step) if strike_step is not None else _NAN

    # ── Cols 37–41: Compression & Breakout ───────────────────────────────────
    row["range_20ticks"] = compression_feats.get("range_20ticks", _NAN)
    row["range_percent_20ticks"] = compression_feats.get("range_percent_20ticks", _NAN)
    row["volatility_compression"] = compression_feats.get("volatility_compression", _NAN)
    row["spread_tightening_atm"] = compression_feats.get("spread_tightening_atm", _NAN)
    # breakout_readiness (col 41) comes from time_to_move module
    row["breakout_readiness"] = time_to_move_feats.get("breakout_readiness", _NAN)

    # ── Cols 42–45: Time-to-Move ──────────────────────────────────────────────
    row["time_since_last_big_move"] = time_to_move_feats.get("time_since_last_big_move", _NAN)
    row["stagnation_duration_sec"] = time_to_move_feats.get("stagnation_duration_sec", _NAN)
    row["momentum_persistence_ticks"] = time_to_move_feats.get("momentum_persistence_ticks", _NAN)
    row["breakout_readiness_extended"] = time_to_move_feats.get("breakout_readiness_extended", _NAN)

    # ── Cols 46–171: Option Tick (7 offsets × 9 CE + 9 PE = 126) ─────────────
    # Build strike → offset index mapping from atm_window
    {s: i for i, s in enumerate(atm_window)}

    for i, off in enumerate(_OPT_OFFSETS):
        strike = atm_window[i] if i < len(atm_window) else None
        for side_lower in _OPT_SIDES:
            side_upper = _OPT_SIDE_MAP[side_lower]
            feats = (
                opt_tick_feats.get((strike, side_upper), _OPT_NULL)
                if strike is not None
                else _OPT_NULL
            )
            for fname in _OPT_FIELD_NAMES:
                row[f"opt_{off}_{side_lower}_{fname}"] = feats.get(fname, _NAN)

    # T37 (2026-06-13): ATM-only order-book depth columns (26 floats).
    # Offset "0" only — far-OTM strikes don't sustain depth and would
    # bloat the schema with mostly-NaN columns. Compute already lives
    # inside the per-(strike, opt_type) feature dict above; this block
    # just lays out the parquet column names. Far-OTM depth signal can
    # be added later as a follow-up if it's worth the schema width.
    _ATM_INDEX = 3  # offset "0" sits at index 3 in _OPT_OFFSETS
    atm_strike = atm_window[_ATM_INDEX] if len(atm_window) > _ATM_INDEX else None
    for side_lower in _OPT_SIDES:
        side_upper = _OPT_SIDE_MAP[side_lower]
        feats = (
            opt_tick_feats.get((atm_strike, side_upper), _OPT_NULL)
            if atm_strike is not None
            else _OPT_NULL
        )
        for fname in _DEPTH_FIELD_NAMES:
            row[f"opt_0_{side_lower}_{fname}"] = feats.get(fname, _NAN)

    # ── Cols 172–180: Option Chain ────────────────────────────────────────────
    for k in _CHAIN_KEYS:
        row[k] = chain_feats.get(k, _NAN)

    # ── Cols 181–324: Active Strikes (6 × 24) + Cross-Feature (4) ────────────
    # active_feats from compute_active_features() already has all 148 keys
    for slot in range(6):
        for field in _ACTIVE_SLOT_FIELDS:
            col = f"active_{slot}_{field}"
            row[col] = active_feats.get(col, _NAN)
    for k in _CROSS_FEATURE_KEYS:
        row[k] = active_feats.get(k, _NAN)

    # ── Cols 329–333: Decay ───────────────────────────────────────────────────
    for k in _DECAY_KEYS:
        row[k] = decay_feats.get(k, _NAN)

    # ── Cols 334–335: Regime ─────────────────────────────────────────────────
    row["regime"] = regime_feats.get("regime", None)
    row["regime_confidence"] = regime_feats.get("regime_confidence", _NAN)

    # ── Cols 336–342: Zone ────────────────────────────────────────────────────
    for k in _ZONE_KEYS:
        row[k] = zone_feats.get(k, _NAN)

    # ── Cols 343–357: Target Variables ───────────────────────────────────────
    for col in _build_target_columns(target_windows_sec):
        row[col] = targets.get(col, _NAN)

    # ── Cols 358–361: Trading State ───────────────────────────────────────────
    row["trading_state"] = trading_state
    row["trading_allowed"] = trading_allowed
    row["warm_up_remaining_sec"] = warm_up_remaining_sec
    row["stale_reason"] = stale_reason  # None is valid here

    # ── Cols 362–370: Metadata ────────────────────────────────────────────────
    for k in _META_KEYS:
        row[k] = meta_feats.get(k, _NAN)

    # ── Cols 371–378: Wave 1 Levels (S/R, OI walls) ──────────────────────────
    levels = level_feats or {}
    for k in _LEVEL_KEYS:
        row[k] = levels.get(k, _NAN)

    # ── Cols 379–387: Wave 1 Greeks (IV + Black-Scholes) ─────────────────────
    greeks = greek_feats or {}
    for k in _GREEK_KEYS:
        row[k] = greeks.get(k, _NAN)

    # ── Cols 388–392: Wave 1 Expiry (DTE + session position) ─────────────────
    expiry = expiry_feats or {}
    for k in _EXPIRY_KEYS:
        row[k] = expiry.get(k, _NAN)

    # ── Phase 2 (v2 trend/swing) Layer-1 features (69 cols) ──────────────────
    # Each group sources from the corresponding optional kwarg dict. The
    # one wrinkle is C12 `days_to_expiry_bucket`, which lives in the same
    # dict that backs Wave 1 _EXPIRY_KEYS (features/expiry.py now returns
    # 6 keys, not 5) — so we read it from `expiry_feats`, not a new dict.
    _mt = multi_tf_feats or {}
    for k in _B1_MA_KEYS:
        row[k] = _mt.get(k, _NAN)
    for k in _B2_TREND_STRENGTH_KEYS:
        row[k] = _mt.get(k, _NAN)

    _sess = session_feats or {}
    for k in _B3_SESSION_KEYS:
        row[k] = _sess.get(k, _NAN)

    for k in _B4_PATTERN_KEYS:
        row[k] = _mt.get(k, _NAN)

    _or = opening_range_feats or {}
    for k in _B5_OPENING_RANGE_KEYS:
        row[k] = _or.get(k, _NAN)

    _xday = cross_day_level_feats or {}
    for k in _B5_CROSS_DAY_KEYS:
        row[k] = _xday.get(k, _NAN)

    _oif = oi_flow_feats or {}
    for k in _C1_OI_FLOW_KEYS:
        row[k] = _oif.get(k, _NAN)

    _tech = technical_feats or {}
    for k in _C2_TECHNICAL_KEYS:
        row[k] = _tech.get(k, _NAN)

    _vix = vix_feats or {}
    for k in _C3_VIX_KEYS:
        row[k] = _vix.get(k, _NAN)

    _dh = dealer_hedging_feats or {}
    for k in _C4_DEALER_HEDGING_KEYS:
        row[k] = _dh.get(k, _NAN)

    _exh = exhaustion_feats or {}
    for k in _C5_EXHAUSTION_KEYS:
        row[k] = _exh.get(k, _NAN)

    _itime = intraday_time_feats or {}
    for k in _C6_INTRADAY_TIME_KEYS:
        row[k] = _itime.get(k, _NAN)

    _rot = strike_rotation_feats or {}
    for k in _C7_STRIKE_ROTATION_KEYS:
        row[k] = _rot.get(k, _NAN)

    _pvw = premium_vwap_feats or {}
    for k in _C8_PREMIUM_VWAP_KEYS:
        row[k] = _pvw.get(k, _NAN)

    _ivv = iv_velocity_feats or {}
    for k in _C9_IV_VELOCITY_KEYS:
        row[k] = _ivv.get(k, _NAN)

    _mp = max_pain_feats or {}
    for k in _C10_MAX_PAIN_KEYS:
        row[k] = _mp.get(k, _NAN)

    _evt = event_calendar_feats or {}
    for k in _C11_EVENT_CALENDAR_KEYS:
        row[k] = _evt.get(k, _NAN)

    # C12: days_to_expiry_bucket reuses expiry_feats (compute_expiry_features
    # now returns 6 keys total, the new one appended at the end).
    for k in _C12_EXPIRY_BUCKET_KEYS:
        row[k] = expiry.get(k, _NAN)

    # ── Phase 3 trend + swing target labels (24 columns, v8 schema) ─────────
    _tst = trend_swing_target_feats or {}
    for k in _TREND_SWING_TARGET_COLUMNS:
        row[k] = _tst.get(k, _NAN)

    # ── T14 scope F (v10): ATM premium-acceleration + strike-migration ──────
    _t14 = t14_feats or {}
    for k in _T14F_KEYS:
        row[k] = _t14.get(k, _NAN)

    # ── Intraday market-structure pivots (v12): swing + trend ───────────────
    _pivot = pivot_feats or {}
    for k in _PIVOT_STRUCTURE_KEYS:
        row[k] = _pivot.get(k, _NAN)

    return row


# ══════════════════════════════════════════════════════════════════════════════
# Serialisation
# ══════════════════════════════════════════════════════════════════════════════


def _nan_to_null(v: object) -> object:
    """Convert float NaN to None (JSON null). Pass all other values through."""
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def serialize_row(row: dict) -> str:
    """
    Serialise a flat-vector dict to a JSON string (no trailing newline).

    - float('nan') → JSON null
    - None         → JSON null
    - All other values pass through json.dumps normally.

    Args:
        row: Flat vector dict from assemble_flat_vector().

    Returns:
        JSON string suitable for NDJSON output.
    """
    safe = {k: _nan_to_null(v) for k, v in row.items()}
    return json.dumps(safe, allow_nan=False)


# ══════════════════════════════════════════════════════════════════════════════
# Parquet schema helpers (replay mode)
# ══════════════════════════════════════════════════════════════════════════════

# Window-independent int columns. The window-dependent ones (the
# `direction_<W>s` set) are added by `int_columns_for(windows)`.
_INT_COLUMNS_BASE: frozenset[str] = frozenset(
    {
        # ATM context
        "atm_strike",
        "strike_step",
        # Option tick: tick_available (0/1), volume
        *(f"opt_{off}_{side}_tick_available" for off in _OPT_OFFSETS for side in _OPT_SIDES),
        *(f"opt_{off}_{side}_volume" for off in _OPT_OFFSETS for side in _OPT_SIDES),
        # Chain integer fields
        "chain_oi_change_call",
        "chain_oi_change_put",
        "chain_oi_change_call_atm",
        "chain_oi_change_put_atm",
        # Active strike integer fields
        *(f"active_{i}_{f}" for i in range(6) for f in ("strike", "tick_available")),
        # Trading state
        "trading_allowed",
        # Meta flags
        "chain_available",
        "data_quality_flag",
        "is_market_open",
    }
)


def int_columns_for(target_windows_sec: tuple[int, ...]) -> frozenset[str]:
    """Return the set of int-typed parquet columns for a profile with
    these target windows. Phase E8 / PY-15.

    Pre-E8 the int-column set was a hardcoded frozenset that included
    `direction_{30,60,90,120,150,180,300}s` — the 90/120/150/180 entries
    were stale (no profile uses them) and the canonical 4-window
    profile's `direction_900s` was missing entirely, causing 4-window
    replay parquets to cast direction targets as float32 rather than
    int32. Deriving from the actual windows fixes both halves.
    """
    return _INT_COLUMNS_BASE | frozenset(f"direction_{w}s" for w in target_windows_sec)


#: Backward-compat: int columns for the default 2-window profile. New
#: code should call `int_columns_for(profile.target_windows_sec)`.
_INT_COLUMNS: frozenset[str] = int_columns_for((30, 60))

# Column names that hold string values
_STRING_COLUMNS = frozenset(
    {
        "trading_state",
        "stale_reason",
        "regime",
        "underlying_symbol",
        "underlying_security_id",
        "exchange",
        "instrument",
        "chain_timestamp",
    }
)


_FLOAT64_COLUMNS = frozenset({"timestamp"})  # needs full epoch precision


def _parquet_type(col: str, int_columns: frozenset[str] = _INT_COLUMNS):
    """Return the pyarrow type for a given column name. `int_columns`
    defaults to the 2-window legacy set; pass the result of
    `int_columns_for(profile.target_windows_sec)` to type 4-window
    direction targets correctly."""
    import pyarrow as pa

    if col in _FLOAT64_COLUMNS:
        return pa.float64()
    if col in _STRING_COLUMNS:
        return pa.large_string()
    if col in int_columns or col.endswith("_count"):
        return pa.int32()
    return pa.float32()


def _build_parquet_schema(target_windows_sec: tuple[int, ...] = (30, 60)):
    """Return a pyarrow schema for the column names of the given
    profile windows. Defaults to the 2-window legacy schema for
    backward compat with pre-E8 callers."""
    import pyarrow as pa

    cols = column_names_for(target_windows_sec)
    int_cols = int_columns_for(target_windows_sec)
    return pa.schema([(col, _parquet_type(col, int_cols)) for col in cols])


# ══════════════════════════════════════════════════════════════════════════════
# Schema registry write (V2_MASTER_SPEC §2.3 D74 B1)
# ══════════════════════════════════════════════════════════════════════════════

# Repository-relative path. Resolved from this file's location so the write
# works regardless of CWD. Tests can override `_SCHEMA_REGISTRY_DIR_OVERRIDE`
# via the Emitter ctor to point at a tmp directory.
_REPO_ROOT: Path = Path(__file__).resolve().parents[3]
_DEFAULT_SCHEMA_REGISTRY_DIR: Path = _REPO_ROOT / "config" / "schema_registry"


def _scan_existing_schema_versions(registry_dir: Path) -> int:
    """Return the highest `v<N>.json` integer present in `registry_dir`,
    or 0 if the directory is missing / empty / contains no matching files.
    Malformed filenames are skipped silently.
    """
    if not registry_dir.exists() or not registry_dir.is_dir():
        return 0
    highest = 0
    for entry in registry_dir.iterdir():
        name = entry.name
        if not (name.startswith("v") and name.endswith(".json")):
            continue
        stem = name[1:-5]  # strip "v" and ".json"
        if not stem.isdigit():
            continue
        try:
            n = int(stem)
        except ValueError:
            continue
        if n > highest:
            highest = n
    return highest


def _write_schema_registry(
    registry_dir: Path,
    schema_version: int,
    columns: tuple[str, ...],
) -> Path:
    """Write `v<schema_version>.json` atomically to `registry_dir`.

    Returns the final file path. Caller is responsible for try/except
    wrapping — this function will raise on any I/O failure so unexpected
    crashes surface in logs rather than failing silently.
    """
    registry_dir.mkdir(parents=True, exist_ok=True)
    final_path = registry_dir / f"v{schema_version}.json"
    tmp_path = final_path.with_suffix(".tmp")

    payload = {
        "schema_version": schema_version,
        "feature_count": len(columns),
        "columns": list(columns),
        "written_at_utc": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "written_by": "tick_feature_agent.emitter",
    }

    tmp_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    os.replace(tmp_path, final_path)
    return final_path


def _maybe_write_schema_registry(
    target_windows_sec: tuple[int, ...],
    registry_dir: Path | None = None,
) -> Path | None:
    """Idempotent schema-registry sync. Per V2_MASTER_SPEC §2.3 D74 B1:
    write `v<LATEST_SCHEMA_VERSION>.json` ONLY when the constant is
    strictly higher than the highest version already on disk. Equal /
    lower → no write, no error. Any failure is logged at WARNING and
    swallowed — emitter startup must never abort on registry trouble.

    Returns the written file path, or None if no write occurred (or the
    write failed).
    """
    dir_path = registry_dir if registry_dir is not None else _DEFAULT_SCHEMA_REGISTRY_DIR
    try:
        existing = _scan_existing_schema_versions(dir_path)
        if LATEST_SCHEMA_VERSION <= existing:
            return None
        cols = column_names_for(target_windows_sec)
        written = _write_schema_registry(dir_path, LATEST_SCHEMA_VERSION, cols)
        _log.info(
            "schema_registry: wrote %s (schema_version=%d, feature_count=%d)",
            written, LATEST_SCHEMA_VERSION, len(cols),
        )
        return written
    except Exception as exc:  # noqa: BLE001 — registry-write must never abort startup
        _log.warning(
            "schema_registry: write skipped due to error (%s: %s)",
            type(exc).__name__, exc,
        )
        return None


# ══════════════════════════════════════════════════════════════════════════════
# Emitter — manages output sinks
# ══════════════════════════════════════════════════════════════════════════════


class Emitter:
    """
    Manages output sinks for TFA.

    Live mode (default):
      - File sink:   append NDJSON lines to a rotating daily file.
      - Socket sink: push NDJSON lines to a TCP or Unix socket.

    Replay mode (mode="replay"):
      - Accumulates 370-column rows in memory during the session.
      - Writes a Parquet file at session_close().
      - NDJSON and socket sinks are disabled.

    Thread safety:
      - File writes are protected by a per-emitter lock.
      - Socket send is non-blocking; if the send buffer is full the row is
        dropped and `socket_drops` is incremented (caller can log this).
      - Both sinks are independent — failure of one does not affect the other.

    Usage (live):
        emitter = Emitter(file_path="output/nifty50_features.ndjson")
        row = assemble_flat_vector(...)
        emitter.emit(row)
        emitter.close()

    Usage (replay):
        emitter = Emitter(mode="replay")
        for event in merged_stream:
            ...
            emitter.emit(row)
        emitter.write_parquet("data/features/2026-04-14/nifty50_features.parquet")
    """

    def __init__(
        self,
        file_path: str | None = None,
        socket_addr: str | int | None = None,
        socket_family: int = socket.AF_INET,
        mode: str = "live",
        target_windows_sec: tuple[int, ...] = (30, 60),
        schema_registry_dir: str | Path | None = None,
    ) -> None:
        """
        Args:
            file_path:           Path to output NDJSON file. None = no file sink.
            socket_addr:         Socket address. Unix socket: path string
                                 (socket_family=AF_UNIX). TCP: (host, port) tuple or
                                 int port (binds to localhost). None = no socket sink.
            socket_family:       socket.AF_UNIX or socket.AF_INET (default INET).
            mode:                "live" (NDJSON + socket) or "replay" (Parquet accumulation).
            target_windows_sec:  Profile target windows used to derive the parquet
                                 schema in replay mode (Phase E8). Defaults to the
                                 2-window legacy layout; production callers (main.py,
                                 replay_adapter.py) pass `profile.target_windows_sec`
                                 so 4-window profiles produce 384-column parquets
                                 with `direction_<W>s` correctly typed as int32.
            schema_registry_dir: Override path for `config/schema_registry/`.
                                 Defaults to `<repo_root>/config/schema_registry`.
                                 Tests pass a tmp_path here to avoid touching the
                                 real registry. Per V2_MASTER_SPEC §2.3 D74 B1
                                 the emitter writes `v<LATEST_SCHEMA_VERSION>.json`
                                 into this directory iff the constant exceeds the
                                 highest version already on disk.
        """
        self._lock = threading.Lock()
        self._file: IO[str] | None = None
        self._sock: socket.socket | None = None
        self._sock_addr: str | tuple[str, int] | None = None
        self._sock_family: int = socket_family
        self._sock_next_retry: float = 0.0
        self.socket_drops: int = 0
        self._mode = mode
        self._parquet_rows: list[dict] | None = [] if mode == "replay" else None
        self._target_windows_sec: tuple[int, ...] = tuple(target_windows_sec)

        # Schema-registry sync (V2_MASTER_SPEC §2.3 D74 B1). Runs on EVERY
        # construction (live + replay) so any process that starts the emitter
        # — recorder, replay runner, tests — keeps the registry honest.
        registry_dir_path: Path | None = (
            Path(schema_registry_dir) if schema_registry_dir is not None else None
        )
        _maybe_write_schema_registry(
            target_windows_sec=self._target_windows_sec,
            registry_dir=registry_dir_path,
        )

        if mode == "replay":
            # Replay mode — disable live sinks
            return

        # ── File sink ─────────────────────────────────────────────────────────
        if file_path is not None:
            Path(file_path).parent.mkdir(parents=True, exist_ok=True)
            self._file = open(file_path, "a", encoding="utf-8")

        # ── Socket sink ───────────────────────────────────────────────────────
        if socket_addr is not None:
            if socket_family == socket.AF_UNIX:
                self._sock_addr = socket_addr
            elif isinstance(socket_addr, int):
                self._sock_addr = ("127.0.0.1", socket_addr)
            else:
                self._sock_addr = socket_addr
            self._try_connect_socket()

    @property
    def mode(self) -> str:
        """'live' or 'replay' — lets callers branch without reaching into _mode."""
        return self._mode

    # ── Socket connect / reconnect ────────────────────────────────────────────
    #
    # The consumer (SEA) may start after TFA, or restart mid-session — the
    # whole point of keeping the agents as separate processes. So the sink
    # retries the connect from emit() at most every _SOCK_RETRY_SEC, and a
    # broken pipe during send tears the socket down for the next retry.
    # NOTE: connect must run BLOCKING with a short timeout — a non-blocking
    # TCP connect raises BlockingIOError before completing, which the old
    # code swallowed, leaving the sink permanently dead.

    _SOCK_RETRY_SEC = 3.0

    def _try_connect_socket(self) -> None:
        """One connect attempt; on failure the next retry comes via emit()."""
        self._sock_next_retry = time.monotonic() + self._SOCK_RETRY_SEC
        s: socket.socket | None = None
        try:
            s = socket.socket(self._sock_family, socket.SOCK_STREAM)
            s.settimeout(0.5)
            s.connect(self._sock_addr)
            s.setblocking(False)
            self._sock = s
        except OSError:
            # Consumer not yet available — silent no-op until the retry
            if s is not None:
                try:
                    s.close()
                except OSError:
                    pass
            self._sock = None

    def _maybe_reconnect_socket(self) -> None:
        if (
            self._sock is None
            and self._sock_addr is not None
            and time.monotonic() >= self._sock_next_retry
        ):
            self._try_connect_socket()

    # ── Public API ────────────────────────────────────────────────────────────

    def emit(self, row: dict) -> None:
        """
        Serialise and push one flat-vector row to all active sinks.

        Live mode: file write + socket send (both optional).
        Replay mode: append to in-memory list for later Parquet flush.

        File write: buffered, flushed every call for real-time recovery.
        Socket send: non-blocking; drops row if send buffer full.

        Args:
            row: Flat vector dict from assemble_flat_vector().
        """
        if self._mode == "replay":
            with self._lock:
                if self._parquet_rows is not None:
                    self._parquet_rows.append(dict(row))
            return

        line = serialize_row(row) + "\n"
        line_bytes = line.encode("utf-8")

        with self._lock:
            if self._file is not None:
                try:
                    self._file.write(line)
                    self._file.flush()
                except OSError:
                    pass  # caller handles logging

            self._maybe_reconnect_socket()
            if self._sock is not None:
                try:
                    self._sock.sendall(line_bytes)
                except BlockingIOError:
                    # Send buffer full — consumer alive but slow. Drop this
                    # row (it's still in the ndjson file) but keep the socket.
                    self.socket_drops += 1
                except OSError:
                    # Consumer went away — tear down, reconnect on retry.
                    self.socket_drops += 1
                    try:
                        self._sock.close()
                    except OSError:
                        pass
                    self._sock = None

    def roll_file(self, new_path: str) -> None:
        """
        Close the current file and open a new one at new_path.

        Called at session close / daily rollover.

        Args:
            new_path: Path for the new output file.
        """
        with self._lock:
            if self._file is not None:
                try:
                    self._file.close()
                except OSError:
                    pass
            Path(new_path).parent.mkdir(parents=True, exist_ok=True)
            self._file = open(new_path, "a", encoding="utf-8")

    def close(self) -> None:
        """Flush and close all sinks. Safe to call multiple times."""
        with self._lock:
            if self._file is not None:
                try:
                    self._file.flush()
                    self._file.close()
                except OSError:
                    pass
                self._file = None
            if self._sock is not None:
                try:
                    self._sock.close()
                except OSError:
                    pass
                self._sock = None

    def write_parquet(self, path: str | Path) -> int:
        """
        Flush accumulated rows to a Parquet file (replay mode only).

        Schema is derived from `self._target_windows_sec` (Phase E8):
        2-window profiles → 370 columns, 4-window profiles → 384.
        Column types:
          - Numeric float columns → float32
          - Numeric int columns   → int32 (incl. `direction_<W>s` for
                                    every window in the profile)
          - String/None columns   → large_string (nullable)

        Creates parent directories as needed.  Clears the row buffer after
        writing so the emitter can be reused for the next session — this is
        what makes it safe to call repeatedly for chunked / resumable replay
        (see ``replay_runner.run_one_date``).

        Args:
            path: Output Parquet file path (e.g. ``data/features/2026-04-14/nifty50_features.parquet``).

        Returns:
            Number of rows written. 0 if the buffer was empty (an empty
            parquet with the correct schema is still written so downstream
            readers don't break).

        Raises:
            ImportError: if pyarrow is not installed.
            RuntimeError: if called in live mode (mode != "replay").
        """
        if self._mode != "replay":
            raise RuntimeError("write_parquet() is only available in replay mode")

        try:
            import pyarrow as pa
            import pyarrow.parquet as pq
        except ImportError as exc:
            raise ImportError(
                "pyarrow is required for Parquet output.  "
                "Install with: pip install pyarrow>=14.0.0"
            ) from exc

        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with self._lock:
            rows = list(self._parquet_rows or [])
            self._parquet_rows = []

        # Phase E8: every parquet write uses the schema derived from
        # this emitter's profile windows, not the legacy 2-window default.
        windows = self._target_windows_sec
        cols = column_names_for(windows)
        int_cols = int_columns_for(windows)

        if not rows:
            # Write empty Parquet with correct schema
            table = pa.table({col: pa.array([], type=_parquet_type(col, int_cols)) for col in cols})
            pq.write_table(table, path)
            return 0

        table = pa.Table.from_pylist(rows)
        # Cast columns to spec types
        for col in cols:
            if col in table.schema.names:
                target_type = _parquet_type(col, int_cols)
                try:
                    table = table.set_column(
                        table.schema.get_field_index(col),
                        col,
                        table.column(col).cast(target_type, safe=False),
                    )
                except (pa.ArrowInvalid, pa.ArrowNotImplementedError):
                    pass  # keep original type on cast failure
        pq.write_table(table, path)
        return len(rows)

    @property
    def row_count(self) -> int:
        """Number of rows accumulated in replay mode buffer."""
        if self._parquet_rows is None:
            return 0
        with self._lock:
            return len(self._parquet_rows)

    def discard_buffer(self) -> int:
        """Clear the parquet row buffer WITHOUT writing to disk.

        Used by chunked-resume replay during the "warmup" phase: when
        resuming after a power cut, the adapter needs to be re-fed earlier
        events so its internal pending queue is reconstructed, but any rows
        the emitter receives during warmup are duplicates of rows already
        persisted in earlier chunk files. ``discard_buffer()`` drops them
        cleanly.

        Returns the number of rows discarded.
        """
        if self._mode != "replay":
            raise RuntimeError("discard_buffer() is only available in replay mode")
        with self._lock:
            n = len(self._parquet_rows or [])
            self._parquet_rows = []
            return n
