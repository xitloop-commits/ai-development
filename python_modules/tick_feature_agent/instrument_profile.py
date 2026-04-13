"""
instrument_profile.py — Load, validate, and expose instrument configuration.

Each TFA process is started with one profile JSON (e.g. nifty50_profile.json).
This module loads it, validates all 20 required fields, and exposes a frozen
InstrumentProfile dataclass that is read-only at runtime.

Raises ProfileValidationError on any violation — caller (main.py) logs and exits.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from datetime import time as dtime
from pathlib import Path
from typing import Any


class ProfileValidationError(Exception):
    """Raised when the instrument profile JSON is invalid or missing fields."""


@dataclass(frozen=True)
class InstrumentProfile:
    # Identity
    exchange: str                         # "NSE" or "MCX"
    instrument_name: str                  # "NIFTY", "BANKNIFTY", "CRUDEOIL", "NATURALGAS"
    underlying_symbol: str                # e.g. "NIFTY25MAYFUT"
    underlying_security_id: str           # Dhan security ID for the underlying futures contract

    # Session hours (HH:MM IST strings)
    session_start: str
    session_end: str

    # Timeout / staleness thresholds (seconds)
    underlying_tick_timeout_sec: int
    option_tick_timeout_sec: int
    momentum_staleness_threshold_sec: int
    warm_up_duration_sec: int

    # Regime classification thresholds
    regime_trend_volatility_min: float
    regime_trend_imbalance_min: float
    regime_trend_momentum_min: float
    regime_trend_activity_min: float
    regime_range_volatility_max: float
    regime_range_imbalance_max: float
    regime_range_activity_min: float
    regime_dead_activity_max: float
    regime_dead_vol_drought_max: float

    # Lookahead windows for target variable computation (seconds)
    target_windows_sec: tuple[int, ...]

    # ── Helpers ──────────────────────────────────────────────────────────────

    def session_start_time(self) -> dtime:
        h, m = self.session_start.split(":")
        return dtime(int(h), int(m))

    def session_end_time(self) -> dtime:
        h, m = self.session_end.split(":")
        return dtime(int(h), int(m))

    @classmethod
    def for_replay_date(cls, base: "InstrumentProfile", meta: dict) -> "InstrumentProfile":
        """
        Return a copy of `base` with underlying_symbol and underlying_security_id
        overridden from the replay session's metadata.json. All other fields
        (session hours, thresholds, regime params) remain unchanged.

        Used by replay_adapter.py so that replaying 2026-04-10 data uses the
        correct expiry contract for that day without loading a different profile.
        """
        return replace(
            base,
            underlying_symbol=meta["underlying_symbol"],
            underlying_security_id=str(meta["underlying_security_id"]),
        )


# ── Validation helpers ────────────────────────────────────────────────────────

def _require(data: dict, field: str, expected_type: type, context: str = "") -> Any:
    if field not in data:
        raise ProfileValidationError(f"Missing required field: '{field}'{' (' + context + ')' if context else ''}")
    val = data[field]
    if not isinstance(val, expected_type):
        raise ProfileValidationError(
            f"Field '{field}' must be {expected_type.__name__}, got {type(val).__name__}: {val!r}"
        )
    return val


def _parse_hhmm(value: str, field: str) -> dtime:
    try:
        parts = value.split(":")
        if len(parts) != 2:
            raise ValueError()
        return dtime(int(parts[0]), int(parts[1]))
    except (ValueError, TypeError):
        raise ProfileValidationError(
            f"Field '{field}' must be HH:MM format (e.g. '09:15'), got: {value!r}"
        )


# ── Public loader ─────────────────────────────────────────────────────────────

def load_profile(path: str | Path) -> InstrumentProfile:
    """
    Load and validate an instrument profile JSON file.

    Raises:
        ProfileValidationError: on missing fields, wrong types, or failed rules.
        FileNotFoundError: if the file does not exist.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Instrument profile not found: {path}")

    with path.open("r", encoding="utf-8") as f:
        try:
            data: dict = json.load(f)
        except json.JSONDecodeError as e:
            raise ProfileValidationError(f"Invalid JSON in profile file: {e}")

    # ── Field validation (all 20 required fields) ─────────────────────────────

    exchange       = _require(data, "exchange", str)
    instrument_name = _require(data, "instrument_name", str)
    underlying_symbol = _require(data, "underlying_symbol", str)
    underlying_security_id = _require(data, "underlying_security_id", (str, int))
    session_start_raw = _require(data, "session_start", str)
    session_end_raw   = _require(data, "session_end", str)

    underlying_tick_timeout_sec      = _require(data, "underlying_tick_timeout_sec", int)
    option_tick_timeout_sec          = _require(data, "option_tick_timeout_sec", int)
    momentum_staleness_threshold_sec = _require(data, "momentum_staleness_threshold_sec", int)
    warm_up_duration_sec             = _require(data, "warm_up_duration_sec", int)

    regime_trend_volatility_min   = _require(data, "regime_trend_volatility_min", (int, float))
    regime_trend_imbalance_min    = _require(data, "regime_trend_imbalance_min", (int, float))
    regime_trend_momentum_min     = _require(data, "regime_trend_momentum_min", (int, float))
    regime_trend_activity_min     = _require(data, "regime_trend_activity_min", (int, float))
    regime_range_volatility_max   = _require(data, "regime_range_volatility_max", (int, float))
    regime_range_imbalance_max    = _require(data, "regime_range_imbalance_max", (int, float))
    regime_range_activity_min     = _require(data, "regime_range_activity_min", (int, float))
    regime_dead_activity_max      = _require(data, "regime_dead_activity_max", (int, float))
    regime_dead_vol_drought_max   = _require(data, "regime_dead_vol_drought_max", (int, float))
    target_windows_raw            = _require(data, "target_windows_sec", list)

    # ── Value range / semantic checks ─────────────────────────────────────────

    if exchange not in ("NSE", "MCX"):
        raise ProfileValidationError(f"'exchange' must be 'NSE' or 'MCX', got: {exchange!r}")

    if not instrument_name.strip():
        raise ProfileValidationError("'instrument_name' must not be empty")

    if not underlying_symbol.strip():
        raise ProfileValidationError("'underlying_symbol' must not be empty")

    underlying_security_id = str(underlying_security_id).strip()
    if not underlying_security_id:
        raise ProfileValidationError("'underlying_security_id' must not be empty")

    t_start = _parse_hhmm(session_start_raw, "session_start")
    t_end   = _parse_hhmm(session_end_raw, "session_end")
    if t_end <= t_start:
        raise ProfileValidationError(
            f"'session_end' ({session_end_raw}) must be after 'session_start' ({session_start_raw})"
        )

    for field, val in [
        ("underlying_tick_timeout_sec", underlying_tick_timeout_sec),
        ("option_tick_timeout_sec", option_tick_timeout_sec),
        ("momentum_staleness_threshold_sec", momentum_staleness_threshold_sec),
        ("warm_up_duration_sec", warm_up_duration_sec),
    ]:
        if val <= 0:
            raise ProfileValidationError(f"'{field}' must be > 0, got: {val}")

    for field, val in [
        ("regime_trend_volatility_min", regime_trend_volatility_min),
        ("regime_trend_imbalance_min", regime_trend_imbalance_min),
        ("regime_trend_momentum_min", regime_trend_momentum_min),
        ("regime_trend_activity_min", regime_trend_activity_min),
        ("regime_range_volatility_max", regime_range_volatility_max),
        ("regime_range_imbalance_max", regime_range_imbalance_max),
        ("regime_range_activity_min", regime_range_activity_min),
        ("regime_dead_activity_max", regime_dead_activity_max),
        ("regime_dead_vol_drought_max", regime_dead_vol_drought_max),
    ]:
        if not (0.0 <= float(val) <= 1.0):
            raise ProfileValidationError(f"'{field}' must be in [0.0, 1.0], got: {val}")

    # Regime consistency: trend thresholds must be above range thresholds
    if float(regime_trend_volatility_min) <= float(regime_range_volatility_max):
        raise ProfileValidationError(
            f"'regime_trend_volatility_min' ({regime_trend_volatility_min}) must be "
            f"> 'regime_range_volatility_max' ({regime_range_volatility_max})"
        )
    if float(regime_trend_imbalance_min) <= float(regime_range_imbalance_max):
        raise ProfileValidationError(
            f"'regime_trend_imbalance_min' ({regime_trend_imbalance_min}) must be "
            f"> 'regime_range_imbalance_max' ({regime_range_imbalance_max})"
        )

    # target_windows_sec validation
    if not target_windows_raw:
        raise ProfileValidationError("'target_windows_sec' must not be empty")
    if len(target_windows_raw) > 4:
        raise ProfileValidationError(
            f"'target_windows_sec' must have ≤ 4 elements, got {len(target_windows_raw)}"
        )
    for w in target_windows_raw:
        if not isinstance(w, int):
            raise ProfileValidationError(f"'target_windows_sec' elements must be integers, got: {w!r}")
        if not (5 <= w <= 300):
            raise ProfileValidationError(f"'target_windows_sec' element {w} must be in [5, 300]")
    if len(target_windows_raw) != len(set(target_windows_raw)):
        raise ProfileValidationError(f"'target_windows_sec' must not contain duplicates: {target_windows_raw}")

    return InstrumentProfile(
        exchange=exchange,
        instrument_name=instrument_name,
        underlying_symbol=underlying_symbol,
        underlying_security_id=underlying_security_id,
        session_start=session_start_raw,
        session_end=session_end_raw,
        underlying_tick_timeout_sec=underlying_tick_timeout_sec,
        option_tick_timeout_sec=option_tick_timeout_sec,
        momentum_staleness_threshold_sec=momentum_staleness_threshold_sec,
        warm_up_duration_sec=warm_up_duration_sec,
        regime_trend_volatility_min=float(regime_trend_volatility_min),
        regime_trend_imbalance_min=float(regime_trend_imbalance_min),
        regime_trend_momentum_min=float(regime_trend_momentum_min),
        regime_trend_activity_min=float(regime_trend_activity_min),
        regime_range_volatility_max=float(regime_range_volatility_max),
        regime_range_imbalance_max=float(regime_range_imbalance_max),
        regime_range_activity_min=float(regime_range_activity_min),
        regime_dead_activity_max=float(regime_dead_activity_max),
        regime_dead_vol_drought_max=float(regime_dead_vol_drought_max),
        target_windows_sec=tuple(target_windows_raw),
    )
