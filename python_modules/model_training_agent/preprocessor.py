"""
preprocessor.py — MVP pipeline (MTA spec §9.2 Steps 1-3).

Two public functions shared with SEA:

  preprocess_for_training(df, feature_config, target_col)
      → (X_features, y_labels, feature_config)
      Used by MTA trainer.

  preprocess_live_tick(row, feature_config)
      → np.ndarray | None
      Used by SEA on every tick.

Both functions produce feature columns in the same order.
feature_config["final_features"] is the authoritative column list.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# ── All target columns — these are the y labels, never features ───────────
TARGET_COLS: tuple[str, ...] = (
    # 30s / 60s
    "direction_30s", "direction_60s",
    "direction_30s_magnitude", "direction_60s_magnitude",
    "max_upside_30s", "max_upside_60s",
    "max_drawdown_30s", "max_drawdown_60s",
    "risk_reward_ratio_30s", "risk_reward_ratio_60s",
    "upside_percentile_30s",
    "total_premium_decay_30s", "total_premium_decay_60s",
    "avg_decay_per_strike_30s", "avg_decay_per_strike_60s",
    # 300s (5 min)
    "direction_300s", "direction_300s_magnitude",
    "max_upside_300s", "max_drawdown_300s",
    "risk_reward_ratio_300s",
    "total_premium_decay_300s", "avg_decay_per_strike_300s",
    # 900s (15 min)
    "direction_900s", "direction_900s_magnitude",
    "max_upside_900s", "max_drawdown_900s",
    "risk_reward_ratio_900s",
    "total_premium_decay_900s", "avg_decay_per_strike_900s",
)

# ── Identifier / metadata columns — drop from features ────────────────────
IDENTIFIER_COLS: tuple[str, ...] = (
    "timestamp", "chain_timestamp",
    "exchange", "instrument", "underlying_symbol", "underlying_security_id",
)

# ── Filter / state columns — drop from features after row filter ──────────
FILTER_COLS: tuple[str, ...] = (
    "is_market_open", "data_quality_flag", "trading_state", "trading_allowed",
    "chain_available", "warm_up_remaining_sec", "stale_reason",
)

# ── Step 3: redundancy — drop these in favour of shorter-window equivalents ──
REDUNDANT_COLS: tuple[str, ...] = (
    "underlying_ofi_20", "underlying_realized_vol_20",
    "underlying_tick_up_count_20", "underlying_tick_down_count_20",
)


def _row_filter(df: pd.DataFrame) -> pd.DataFrame:
    """Step 1 — keep only TRADING rows with clean data."""
    mask = pd.Series(True, index=df.index)
    if "is_market_open" in df.columns:
        mask &= df["is_market_open"] == 1
    if "data_quality_flag" in df.columns:
        mask &= df["data_quality_flag"] == 1
    if "trading_state" in df.columns:
        mask &= df["trading_state"] == "TRADING"
    return df[mask].reset_index(drop=True)


def _derive_feature_columns(df: pd.DataFrame) -> list[str]:
    """
    Step 2 + 3 — determine which columns remain as features.

    Called once on first training run to produce the locked feature_config.
    """
    drop = set(TARGET_COLS) | set(IDENTIFIER_COLS) | set(FILTER_COLS) | set(REDUNDANT_COLS)
    kept: list[str] = []
    for c in df.columns:
        if c in drop:
            continue
        # Drop any remaining string / object columns — MVP has no one-hot yet
        dt = str(df[c].dtype)
        if dt in ("object", "str", "string", "string[pyarrow]"):
            continue
        kept.append(c)
    return kept


def preprocess_for_training_base(
    df: pd.DataFrame,
    feature_config: dict | None,
) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    """
    Steps 1 + 2 (row filter + feature column extraction) — the heavy work,
    target-independent. Returns the filtered DataFrame plus a float32
    feature matrix that can be sliced per-target by `extract_target_subset`.

    F4 introduced this split so the trainer computes X_train / X_val once
    per (instrument, run) instead of once per target. The float32 cast
    halves memory vs the prior float64 path; LightGBM accepts float32
    natively.

    Args:
        df:              Raw Parquet DataFrame (one instrument, one or more days)
        feature_config:  Locked config dict with "final_features" list, or None
                         on first run (columns will be derived from df).

    Returns:
        filtered_df:    Row-filtered DataFrame (still has all columns including
                        targets) — pass to `extract_target_subset` for per-target
                        slicing.
        X_base:         Feature DataFrame, dtype=float32, aligned with filtered_df.
        feature_config: Locked config dict.
    """
    df = _row_filter(df)

    if feature_config is None:
        feature_cols = _derive_feature_columns(df)
        feature_config = {"final_features": feature_cols}
    else:
        feature_cols = feature_config["final_features"]
        missing = [c for c in feature_cols if c not in df.columns]
        if missing:
            raise KeyError(f"Features in config missing from DataFrame: {missing[:5]}")

    # F4: float32 instead of float64 — halves the memory footprint of the
    # full feature matrix on multi-day training runs. LightGBM accepts
    # float32 inputs natively and produces identical models given the
    # same seed, since it bins features into uint8/uint16 histograms
    # internally before training.
    X_base = df[feature_cols].copy().astype("float32")

    return df, X_base, feature_config


def extract_target_subset(
    filtered_df: pd.DataFrame,
    X_base: pd.DataFrame,
    target_col: str,
) -> tuple[pd.DataFrame, pd.Series]:
    """
    Pair function with `preprocess_for_training_base`. Drops rows where
    the target is NaN / int32-sentinel from both X and y. Cheap — a
    single boolean mask + reset_index per target.
    """
    if target_col not in filtered_df.columns:
        raise KeyError(f"Target column {target_col!r} not in DataFrame")

    y = filtered_df[target_col]
    INT32_SENTINEL = -2147483648
    valid_mask = y.notna() & (y != INT32_SENTINEL)
    X = X_base[valid_mask].reset_index(drop=True)
    y = y[valid_mask].reset_index(drop=True).astype("float32")
    return X, y


def preprocess_for_training(
    df: pd.DataFrame,
    feature_config: dict | None,
    target_col: str,
) -> tuple[pd.DataFrame, pd.Series, dict]:
    """
    Apply MVP pipeline (Steps 1-3) for training. Backward-compatible
    composition of `preprocess_for_training_base` + `extract_target_subset`.

    Returns:
        X_features:     DataFrame of feature columns (float32), same order as
                        feature_config["final_features"]
        y_labels:       Series with the target column (float32, NaN rows dropped)
        feature_config: Locked config dict. If input was None, newly derived.
    """
    if target_col not in df.columns:
        raise KeyError(f"Target column {target_col!r} not in DataFrame")

    filtered_df, X_base, feature_config = preprocess_for_training_base(df, feature_config)
    X, y = extract_target_subset(filtered_df, X_base, target_col)
    return X, y, feature_config


# F4: in-place live-tick preprocessor for the SEA hot path. SEA used to
# allocate a fresh np.array per tick (~30 ticks/sec across 4 instruments
# = a lot of churn). With this class, the buffer is allocated once at
# instance construction and reused; the returned array IS the buffer,
# so callers must consume it before the next `process()` call.
class LiveTickPreprocessor:
    """
    Stateful in-place version of `preprocess_live_tick`. Instantiate once
    per (SEA instance, feature_config) and call `process(row)` per tick.

    Returns the SAME ndarray each call (mutated in place); valid only
    until the next `process()` call. Suitable for SEA's predict-and-go
    flow where the vector is consumed immediately.
    """

    def __init__(self, feature_config: dict) -> None:
        self.feature_cols: list[str] = list(feature_config["final_features"])
        self.n_features: int = len(self.feature_cols)
        # F4 dtype change — LightGBM accepts float32 natively.
        self._buf: np.ndarray = np.empty(self.n_features, dtype=np.float32)

    def process(self, row: dict) -> np.ndarray | None:
        """Return the cached buffer with this row's values, or None if
        the row should be filtered out (non-trading / bad data)."""
        if row.get("is_market_open") != 1:
            return None
        if row.get("data_quality_flag") != 1:
            return None
        if row.get("trading_state") != "TRADING":
            return None

        buf = self._buf
        for i, c in enumerate(self.feature_cols):
            v = row.get(c)
            buf[i] = np.float32("nan") if v is None else np.float32(v)
        return buf


def preprocess_live_tick(
    row: dict,
    feature_config: dict,
) -> np.ndarray | None:
    """
    Apply Steps 1-2 to a single live tick dict. Allocates a fresh ndarray
    per call — for the SEA hot path use `LiveTickPreprocessor` instead.

    Returns:
        np.ndarray of shape (n_features,), dtype=float32, in the same
        order as feature_config["final_features"], or None if the row
        should be filtered out.
    """
    if row.get("is_market_open") != 1:
        return None
    if row.get("data_quality_flag") != 1:
        return None
    if row.get("trading_state") != "TRADING":
        return None

    feature_cols = feature_config["final_features"]
    # np.nan for missing keys — LightGBM handles NaN natively.
    vec = np.array(
        [row.get(c) if row.get(c) is not None else np.nan for c in feature_cols],
        dtype=np.float32,
    )
    return vec
