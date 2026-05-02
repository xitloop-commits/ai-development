"""
tests/test_preprocessor.py — Phase E10 PR1 unit tests for MTA preprocessor.

Locks the train/live preprocessing contract shared by `model_training_agent`
(training side) and `signal_engine_agent` (live tick side):

  - Step 1 row filter (is_market_open / data_quality_flag / trading_state)
  - Step 2 column derivation (drop targets, identifiers, filter cols, strings)
  - Step 3 redundancy drop (long-window duplicates of short-window features)
  - The same `feature_config["final_features"]` ordering is used by both
    `preprocess_for_training` and `preprocess_live_tick` — that's the
    train→live consistency contract SEA depends on.

Run: python -m pytest python_modules/model_training_agent/tests/test_preprocessor.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent  # python_modules/
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import numpy as np
import pandas as pd
import pytest

from model_training_agent.preprocessor import (
    FILTER_COLS,
    IDENTIFIER_COLS,
    REDUNDANT_COLS,
    TARGET_COLS,
    LiveTickPreprocessor,
    extract_target_subset,
    preprocess_for_training,
    preprocess_for_training_base,
    preprocess_live_tick,
)

# ── Synthetic-data helpers ────────────────────────────────────────────────


def _build_df(n_rows: int = 50, all_trading: bool = True) -> pd.DataFrame:
    """Build a synthetic feature-frame mirroring TFA Parquet schema.

    Includes:
      - Step 1 filter columns (all set to TRADING by default)
      - Identifier columns (timestamp, instrument, ...)
      - One redundant column (`underlying_ofi_20`)
      - One string non-feature column (`regime`)
      - The trainer's `__date` helper column
      - Two real numeric features (`feature_a`, `feature_b`)
      - Two target columns (`direction_30s` binary, `max_upside_30s` regression)
    """
    rng = np.random.default_rng(42)
    return pd.DataFrame(
        {
            # Step 1 filter cols
            "is_market_open": [1] * n_rows if all_trading else [0] * n_rows,
            "data_quality_flag": [1] * n_rows,
            "trading_state": ["TRADING"] * n_rows,
            # Identifier cols (must be dropped from features)
            "timestamp": pd.date_range("2026-04-01 09:15", periods=n_rows, freq="s"),
            "instrument": ["nifty50"] * n_rows,
            "underlying_symbol": ["NIFTY"] * n_rows,
            # Redundant col (must be dropped)
            "underlying_ofi_20": rng.normal(size=n_rows),
            # String non-feature col (must be dropped)
            "regime": ["BULLISH"] * n_rows,
            # Trainer helper col (string, dropped at the string-filter step)
            "__date": ["2026-04-01"] * n_rows,
            # Real numeric features (kept)
            "feature_a": rng.normal(size=n_rows),
            "feature_b": rng.normal(size=n_rows),
            # Target columns (must be dropped from features but available as y)
            "direction_30s": rng.integers(0, 2, size=n_rows).astype("int64"),
            "max_upside_30s": rng.normal(size=n_rows),
        }
    )


# ── feature_config derivation (first call) ────────────────────────────────


def test_derives_feature_config_when_none() -> None:
    df = _build_df()
    X, y, cfg = preprocess_for_training(df, None, "direction_30s")
    assert isinstance(cfg, dict)
    assert "final_features" in cfg
    # The two real features survive; targets / identifiers / filter / redundant
    # / string columns are all stripped.
    assert set(cfg["final_features"]) == {"feature_a", "feature_b"}


def test_derived_config_strips_target_columns() -> None:
    df = _build_df()
    _X, _y, cfg = preprocess_for_training(df, None, "direction_30s")
    for tcol in TARGET_COLS:
        assert tcol not in cfg["final_features"], f"target column {tcol!r} leaked into feature list"


def test_derived_config_strips_identifier_columns() -> None:
    df = _build_df()
    _X, _y, cfg = preprocess_for_training(df, None, "direction_30s")
    for ident in IDENTIFIER_COLS:
        assert ident not in cfg["final_features"]


def test_derived_config_strips_filter_columns() -> None:
    df = _build_df()
    _X, _y, cfg = preprocess_for_training(df, None, "direction_30s")
    for f in FILTER_COLS:
        assert f not in cfg["final_features"]


def test_derived_config_strips_redundant_columns() -> None:
    df = _build_df()
    _X, _y, cfg = preprocess_for_training(df, None, "direction_30s")
    for r in REDUNDANT_COLS:
        assert r not in cfg["final_features"]


def test_derived_config_strips_string_helper_columns() -> None:
    """`regime` and `__date` are object/string columns and must not become
    features in the MVP (no one-hot encoding yet)."""
    df = _build_df()
    _X, _y, cfg = preprocess_for_training(df, None, "direction_30s")
    assert "regime" not in cfg["final_features"]
    assert "__date" not in cfg["final_features"]


# ── feature_config reuse (second call) ────────────────────────────────────


def test_reuses_existing_feature_config() -> None:
    """When a config is supplied, preprocess_for_training must use it
    verbatim and not re-derive."""
    df = _build_df()
    _X1, _y1, cfg = preprocess_for_training(df, None, "direction_30s")
    # Tamper: use a 1-feature config; the second call must honour it.
    locked = {"final_features": ["feature_a"]}
    X2, _y2, cfg2 = preprocess_for_training(df, locked, "direction_30s")
    assert list(X2.columns) == ["feature_a"]
    assert cfg2 is locked  # same dict returned through


def test_existing_config_preserves_column_ordering() -> None:
    df = _build_df()
    locked = {"final_features": ["feature_b", "feature_a"]}  # reversed
    X, _y, _c = preprocess_for_training(df, locked, "direction_30s")
    assert list(X.columns) == ["feature_b", "feature_a"]


def test_missing_feature_in_config_raises_keyerror() -> None:
    df = _build_df()
    locked = {"final_features": ["feature_a", "feature_b", "phantom_feature"]}
    with pytest.raises(KeyError, match="missing from DataFrame"):
        preprocess_for_training(df, locked, "direction_30s")


# ── NaN target handling ───────────────────────────────────────────────────


def test_drops_rows_with_nan_target() -> None:
    df = _build_df(n_rows=10)
    df["max_upside_30s"] = df["max_upside_30s"].astype("float64")
    df.loc[[2, 5, 9], "max_upside_30s"] = np.nan
    X, y, _cfg = preprocess_for_training(df, None, "max_upside_30s")
    assert len(X) == 7
    assert len(y) == 7
    assert y.notna().all()


def test_drops_rows_with_int32_sentinel_target() -> None:
    """The preprocessor treats -2147483648 as the int32 NaN sentinel for
    targets that pandas stored without a nullable dtype."""
    df = _build_df(n_rows=10)
    df["direction_30s"] = df["direction_30s"].astype("int64")
    df.loc[[1, 4], "direction_30s"] = -2147483648
    X, y, _cfg = preprocess_for_training(df, None, "direction_30s")
    assert len(X) == 8
    assert (y != -2147483648).all()


# ── Missing target column ─────────────────────────────────────────────────


def test_missing_target_column_raises_keyerror() -> None:
    """LOCKED CONTRACT: preprocess_for_training raises KeyError when the
    target column isn't in the DataFrame. (Locked because trainer relies
    on this to fail fast on schema drift.)"""
    df = _build_df()
    df = df.drop(columns=["direction_30s"])
    with pytest.raises(KeyError, match="not in DataFrame"):
        preprocess_for_training(df, None, "direction_30s")


# ── Output dtypes (F4 — float32 to halve memory) ─────────────────────────


def test_output_X_is_float32() -> None:
    """F4 — feature matrix dtype changed from float64 to float32. LightGBM
    accepts float32 natively and produces identical models given the same
    seed (it bins features into uint8/uint16 histograms internally)."""
    df = _build_df()
    X, _y, _cfg = preprocess_for_training(df, None, "direction_30s")
    for col in X.columns:
        assert str(X[col].dtype) == "float32", f"{col} is {X[col].dtype}, expected float32 (F4)"


def test_output_y_is_float32() -> None:
    """F4 — target dtype matches feature dtype to keep LightGBM internal
    casts cheap."""
    df = _build_df()
    _X, y, _cfg = preprocess_for_training(df, None, "direction_30s")
    assert str(y.dtype) == "float32"


# ── Step 1 row filter ─────────────────────────────────────────────────────


def test_row_filter_drops_non_trading_rows() -> None:
    df = _build_df(n_rows=10)
    df.loc[[0, 1, 2], "is_market_open"] = 0
    df.loc[[3, 4], "data_quality_flag"] = 0
    df.loc[[5], "trading_state"] = "PRE_OPEN"
    X, y, _cfg = preprocess_for_training(df, None, "direction_30s")
    assert len(X) == 4  # rows 6, 7, 8, 9 survive
    assert len(y) == 4


def test_row_filter_when_all_rows_non_trading_yields_empty() -> None:
    df = _build_df(n_rows=10, all_trading=False)
    X, y, _cfg = preprocess_for_training(df, None, "direction_30s")
    assert len(X) == 0
    assert len(y) == 0


# ── preprocess_live_tick ──────────────────────────────────────────────────


def _trading_row(**overrides) -> dict:
    base = {
        "is_market_open": 1,
        "data_quality_flag": 1,
        "trading_state": "TRADING",
        "feature_a": 1.5,
        "feature_b": -0.25,
    }
    base.update(overrides)
    return base


def test_live_tick_returns_none_when_market_closed() -> None:
    cfg = {"final_features": ["feature_a", "feature_b"]}
    row = _trading_row(is_market_open=0)
    assert preprocess_live_tick(row, cfg) is None


def test_live_tick_returns_none_when_data_quality_bad() -> None:
    cfg = {"final_features": ["feature_a", "feature_b"]}
    row = _trading_row(data_quality_flag=0)
    assert preprocess_live_tick(row, cfg) is None


def test_live_tick_returns_none_when_not_trading_state() -> None:
    cfg = {"final_features": ["feature_a", "feature_b"]}
    row = _trading_row(trading_state="PRE_OPEN")
    assert preprocess_live_tick(row, cfg) is None


def test_live_tick_returns_numpy_vector_when_valid() -> None:
    cfg = {"final_features": ["feature_a", "feature_b"]}
    vec = preprocess_live_tick(_trading_row(), cfg)
    assert isinstance(vec, np.ndarray)
    # F4 — dtype changed from float64 to float32.
    assert vec.dtype == np.float32
    assert vec.shape == (2,)
    assert vec[0] == pytest.approx(1.5)
    assert vec[1] == pytest.approx(-0.25)


def test_live_tick_respects_feature_config_ordering() -> None:
    """The vector must be emitted in `final_features` order, NOT row.keys()
    order — the SEA model loader feeds this directly into LightGBM, which
    is order-sensitive."""
    cfg = {"final_features": ["feature_b", "feature_a"]}  # reversed
    vec = preprocess_live_tick(_trading_row(), cfg)
    assert vec[0] == pytest.approx(-0.25)  # feature_b
    assert vec[1] == pytest.approx(1.5)  # feature_a


def test_live_tick_fills_missing_features_with_nan() -> None:
    """LightGBM handles NaN natively, so missing keys map to NaN rather
    than raising."""
    cfg = {"final_features": ["feature_a", "feature_b", "feature_c"]}
    vec = preprocess_live_tick(_trading_row(), cfg)
    assert vec is not None
    assert np.isnan(vec[2])
    assert not np.isnan(vec[0])
    assert not np.isnan(vec[1])


def test_live_tick_treats_explicit_none_as_nan() -> None:
    """row.get(c) returns None if the key is mapped to None. Treat the
    same as missing: NaN, not 0.0."""
    cfg = {"final_features": ["feature_a"]}
    vec = preprocess_live_tick(_trading_row(feature_a=None), cfg)
    assert vec is not None
    assert np.isnan(vec[0])


# ── Train↔live consistency contract ───────────────────────────────────────


def test_train_and_live_produce_same_column_order() -> None:
    """Critical contract: with the SAME feature_config, training-frame
    column order MUST match live-vector index order. SEA's predictor
    relies on this — if they drift, we predict on the wrong columns."""
    df = _build_df(n_rows=20)
    X_train, _y, cfg = preprocess_for_training(df, None, "direction_30s")

    # Pull a single row from the source df and emit it as a live tick
    row_dict = {
        "is_market_open": 1,
        "data_quality_flag": 1,
        "trading_state": "TRADING",
        "feature_a": float(df["feature_a"].iloc[0]),
        "feature_b": float(df["feature_b"].iloc[0]),
    }
    vec = preprocess_live_tick(row_dict, cfg)

    assert vec is not None
    assert vec.shape == (len(cfg["final_features"]),)
    assert list(X_train.columns) == cfg["final_features"]
    # Column-by-column the live vector matches the training row's values
    train_first_row = X_train.iloc[0].to_numpy()
    assert np.allclose(vec, train_first_row, equal_nan=True)


# ── F4 — preprocess_for_training_base + extract_target_subset ────────────


def test_base_returns_filtered_df_and_float32_X() -> None:
    """F4 — preprocess_for_training_base does Steps 1+2 with no target
    drop, so the trainer can compute X_train / X_val once per run and
    slice per target with extract_target_subset."""
    df = _build_df(n_rows=10)
    df.loc[[0, 1], "is_market_open"] = 0  # filter these out
    filt, X_base, cfg = preprocess_for_training_base(df, None)
    assert len(filt) == 8  # row filter applied
    assert len(X_base) == 8
    assert set(cfg["final_features"]) == {"feature_a", "feature_b"}
    for col in X_base.columns:
        assert str(X_base[col].dtype) == "float32"


def test_extract_target_subset_drops_nan_target_rows() -> None:
    """extract_target_subset drops NaN target rows from both X and y."""
    df = _build_df(n_rows=10)
    df["max_upside_30s"] = df["max_upside_30s"].astype("float64")
    df.loc[[2, 5, 9], "max_upside_30s"] = np.nan
    filt, X_base, _cfg = preprocess_for_training_base(df, None)
    X, y = extract_target_subset(filt, X_base, "max_upside_30s")
    assert len(X) == 7
    assert len(y) == 7
    assert y.notna().all()
    assert str(y.dtype) == "float32"


def test_base_then_extract_matches_legacy_path() -> None:
    """Composition contract: preprocess_for_training_base + extract_target_subset
    must produce the same (X, y) as the all-in-one preprocess_for_training."""
    df = _build_df(n_rows=20)
    X1, y1, _cfg1 = preprocess_for_training(df, None, "direction_30s")

    filt, X_base, _cfg2 = preprocess_for_training_base(df, None)
    X2, y2 = extract_target_subset(filt, X_base, "direction_30s")

    pd.testing.assert_frame_equal(X1.reset_index(drop=True), X2.reset_index(drop=True))
    pd.testing.assert_series_equal(y1.reset_index(drop=True), y2.reset_index(drop=True))


# ── F4 — LiveTickPreprocessor (in-place buffer, hot path) ─────────────────


def test_live_tick_preprocessor_returns_same_buffer_each_call() -> None:
    """The in-place version reuses one buffer for every call. Caller MUST
    consume it before the next process() call."""
    cfg = {"final_features": ["feature_a", "feature_b"]}
    pp = LiveTickPreprocessor(cfg)
    vec1 = pp.process(_trading_row(feature_a=1.0, feature_b=2.0))
    vec2 = pp.process(_trading_row(feature_a=3.0, feature_b=4.0))
    # Same buffer object — id() / np.shares_memory both confirm.
    assert vec1 is vec2
    # Buffer now reflects the second row's values.
    assert vec2[0] == pytest.approx(3.0)
    assert vec2[1] == pytest.approx(4.0)


def test_live_tick_preprocessor_dtype_is_float32() -> None:
    cfg = {"final_features": ["feature_a", "feature_b"]}
    pp = LiveTickPreprocessor(cfg)
    vec = pp.process(_trading_row())
    assert vec is not None
    assert vec.dtype == np.float32


def test_live_tick_preprocessor_filters_non_trading_rows() -> None:
    cfg = {"final_features": ["feature_a"]}
    pp = LiveTickPreprocessor(cfg)
    assert pp.process(_trading_row(is_market_open=0)) is None
    assert pp.process(_trading_row(data_quality_flag=0)) is None
    assert pp.process(_trading_row(trading_state="PRE_OPEN")) is None


def test_live_tick_preprocessor_treats_none_as_nan() -> None:
    cfg = {"final_features": ["feature_a", "feature_b"]}
    pp = LiveTickPreprocessor(cfg)
    vec = pp.process(_trading_row(feature_a=None))
    assert vec is not None
    assert np.isnan(vec[0])
    assert vec[1] == pytest.approx(-0.25)


def test_live_tick_preprocessor_respects_feature_config_ordering() -> None:
    """Same column-order contract as preprocess_live_tick — the SEA model
    loader feeds this directly into LightGBM."""
    cfg = {"final_features": ["feature_b", "feature_a"]}
    pp = LiveTickPreprocessor(cfg)
    vec = pp.process(_trading_row())
    assert vec is not None
    assert vec[0] == pytest.approx(-0.25)  # feature_b
    assert vec[1] == pytest.approx(1.5)  # feature_a
