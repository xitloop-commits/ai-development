"""
emitter.py — Flat per-tick feature vector assembly + NDJSON / Parquet output.

The output column count is **dynamic per instrument profile**: the
target-variable block contributes `len(target_windows_sec) * 7 + 1`
columns, so a profile with `[30, 60]` windows lands at 370 columns
total and a profile with `[30, 60, 300, 900]` windows lands at 384.
Per Phase E8 / D4 the canonical live profile uses 4 windows = 384
columns; the 2-window legacy layout is still supported (replay of
pre-D4 data, tests).

Use `column_names_for(target_windows_sec)` to get the ordered tuple
for any profile, and `int_columns_for(target_windows_sec)` to get the
matching `direction_<W>s` int-typed-column set. The module-level
`COLUMN_NAMES` and `_INT_COLUMNS` exports default to the 2-window
layout for backward compat with pre-E8 callers and exist primarily
for tests; production code should pass the actual profile windows
through `Emitter(target_windows_sec=profile.target_windows_sec, ...)`.

Assembles all per-tick feature groups into a single ordered flat dict
matching the wire format defined in spec §9.1, then serialises to NDJSON.

Column groups (counts shown for the 2-window default profile = 370 total;
4-window canonical profile lands at 384):
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
    343–357  Target Variables — 15 columns (default [30s, 60s] windows)
    358–361  Trading State (4)
    362–370  Metadata (9)

Public API:
    column_names_for(windows)       → tuple[str, ...]   Ordered column names for any profile windows
    int_columns_for(windows)        → frozenset[str]    Int32-typed parquet columns for those windows
    COLUMN_NAMES                    Tuple of column name strings for the 2-window default (legacy)
    assemble_flat_vector(**kwargs)  → dict              Build ordered flat dict
    serialize_row(row)              → str               NaN/None → JSON null, no trailing newline
    Emitter(target_windows_sec=...) Class managing file + socket + parquet output sinks

NaN encoding:
    Python float('nan') and Python None both become JSON null in wire output.
    Strings use "" for missing values (spec §9.1 encoding rules).
"""

from __future__ import annotations

import json
import math
import socket
import threading
from pathlib import Path
from typing import IO

_NAN = float("nan")

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
    cols.append(f"upside_percentile_{min(target_windows_sec)}s")
    return tuple(cols)


# ── Build COLUMN_NAMES ────────────────────────────────────────────────────────


def _build_column_names(
    target_windows_sec: tuple[int, ...] = (30, 60),
) -> tuple[str, ...]:
    """Build the full ordered tuple of 370 column names for the given windows."""
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
) -> dict:
    """
    Assemble all per-tick feature groups into a single ordered 370-column dict.

    Column order matches spec §9.1 exactly. The returned dict is ordered (Python
    3.7+ dict insertion order) and has exactly 370 keys.

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
        """
        self._lock = threading.Lock()
        self._file: IO[str] | None = None
        self._sock: socket.socket | None = None
        self.socket_drops: int = 0
        self._mode = mode
        self._parquet_rows: list[dict] | None = [] if mode == "replay" else None
        self._target_windows_sec: tuple[int, ...] = tuple(target_windows_sec)

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
                addr = socket_addr
            elif isinstance(socket_addr, int):
                addr = ("127.0.0.1", socket_addr)
            else:
                addr = socket_addr
            try:
                s = socket.socket(socket_family, socket.SOCK_STREAM)
                s.setblocking(False)
                s.connect(addr)
                self._sock = s
            except (OSError, ConnectionRefusedError):
                # Consumer not yet available — socket sink silent no-op until connected
                pass

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

            if self._sock is not None:
                try:
                    self._sock.sendall(line_bytes)
                except BlockingIOError:
                    self.socket_drops += 1
                except OSError:
                    self.socket_drops += 1

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

    def write_parquet(self, path: str | Path) -> None:
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
        writing so the emitter can be reused for the next session.

        Args:
            path: Output Parquet file path (e.g. ``data/features/2026-04-14/nifty50_features.parquet``).

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
            return

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

    @property
    def row_count(self) -> int:
        """Number of rows accumulated in replay mode buffer."""
        if self._parquet_rows is None:
            return 0
        with self._lock:
            return len(self._parquet_rows)
