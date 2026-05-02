"""
tests/test_trainer.py — Phase E10 PR1 unit tests for MTA trainer.

Locked contracts:

  - PY-5 val-split guard: when validation has only one class for a binary
    target, the trainer must SKIP that target (no .lgbm file, metrics
    flagged with skipped=true + reason mentioning "one class") rather
    than fitting LightGBM with NaN AUC. Other binary targets in the same
    run with valid val-day class balance must still train.
  - Single-day mode: 1 parquet → random 80/20 split, "Single-day mode" log.
  - Multi-day mode: walk-forward split, last `val_days` chronological
    days as val, capped at `total_days // 2`.
  - `_load_or_derive_feature_config` writes JSON on first run, reads it
    on second run, returns (cfg, newly=False) when reading.
  - `train_instrument` writes `training_manifest.json` and `metrics.json`
    with the expected keys, and updates `models/<instrument>/LATEST`.

The data is synthesised to be LightGBM-friendly: ~200 rows × ~10 numeric
features per day, so each test runs in seconds.

Run: python -m pytest python_modules/model_training_agent/tests/test_trainer.py -v
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent  # python_modules/
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import numpy as np
import pandas as pd
import pytest

from _shared.targets import MVP_TARGET_NAMES, MVP_TARGET_OBJECTIVES
from model_training_agent import trainer as trainer_mod
from model_training_agent.trainer import (
    _load_or_derive_feature_config,
    _load_parquets,
    train_instrument,
)


# ── Synthetic-data helpers ────────────────────────────────────────────────

# A small but learnable feature panel. 10 numeric columns is enough to
# exercise the preprocessor + LightGBM without slowing tests.
_FEATURE_COLS: tuple[str, ...] = tuple(f"feature_{i}" for i in range(10))


def _build_day_df(
    *,
    n_rows: int = 200,
    seed: int = 0,
    direction_900s_override: np.ndarray | None = None,
    instrument: str = "nifty50",
    date_str: str = "2026-04-01",
) -> pd.DataFrame:
    """Build one day's synthetic feature-frame matching the trainer's input.

    Includes:
      - Step 1 filter cols all set to TRADING.
      - Identifier cols.
      - The 10 numeric features.
      - All 28 MVP target columns. Binary targets get a balanced 0/1 mix;
        regression targets get standard-normal noise.

    `direction_900s_override` lets the caller force one specific binary
    target's values (used to construct the PY-5 single-class val day).
    """
    rng = np.random.default_rng(seed)
    n = n_rows

    data: dict[str, object] = {
        "is_market_open":    np.ones(n, dtype="int64"),
        "data_quality_flag": np.ones(n, dtype="int64"),
        "trading_state":     ["TRADING"] * n,
        "timestamp":         pd.date_range(f"{date_str} 09:15", periods=n, freq="s"),
        "instrument":        [instrument] * n,
    }
    # Numeric features
    for col in _FEATURE_COLS:
        data[col] = rng.normal(size=n).astype("float64")

    # All 28 MVP targets
    for name, objective in MVP_TARGET_OBJECTIVES.items():
        if objective == "binary":
            # Balanced 0/1 to keep AUC well-defined
            data[name] = rng.integers(0, 2, size=n).astype("int64")
        else:
            data[name] = rng.normal(size=n).astype("float64")

    df = pd.DataFrame(data)

    if direction_900s_override is not None:
        assert len(direction_900s_override) == n
        df["direction_900s"] = direction_900s_override.astype("int64")

    return df


def _write_day_parquet(features_root: Path, instrument: str, date_str: str,
                       df: pd.DataFrame) -> Path:
    day_dir = features_root / date_str
    day_dir.mkdir(parents=True, exist_ok=True)
    p = day_dir / f"{instrument}_features.parquet"
    df.to_parquet(p)
    return p


# ── _load_parquets ────────────────────────────────────────────────────────

def test_load_parquets_returns_only_existing_dates(tmp_path: Path) -> None:
    features_root = tmp_path / "features"
    instrument = "nifty50"
    # Two days exist, one day in the middle is missing
    _write_day_parquet(features_root, instrument, "2026-04-01",
                       _build_day_df(seed=1, date_str="2026-04-01"))
    _write_day_parquet(features_root, instrument, "2026-04-03",
                       _build_day_df(seed=3, date_str="2026-04-03"))

    loaded = _load_parquets(instrument, "2026-04-01", "2026-04-03", features_root)
    dates = [d for d, _ in loaded]
    assert dates == ["2026-04-01", "2026-04-03"]


def test_load_parquets_attaches_date_column(tmp_path: Path) -> None:
    features_root = tmp_path / "features"
    _write_day_parquet(features_root, "nifty50", "2026-04-01",
                       _build_day_df(seed=1, date_str="2026-04-01"))
    loaded = _load_parquets("nifty50", "2026-04-01", "2026-04-01", features_root)
    assert len(loaded) == 1
    _date_str, df = loaded[0]
    assert "__date" in df.columns
    assert (df["__date"] == "2026-04-01").all()


# ── _load_or_derive_feature_config ────────────────────────────────────────

def test_feature_config_is_derived_on_first_call(tmp_path: Path) -> None:
    config_dir = tmp_path / "feature_config"
    df = _build_day_df(seed=1)
    cfg, newly = _load_or_derive_feature_config("nifty50", config_dir, df)

    assert newly is True
    assert "final_features" in cfg
    cfg_path = config_dir / "nifty50_feature_config.json"
    assert cfg_path.exists(), "feature config JSON should be written on first call"
    on_disk = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert on_disk == cfg


def test_feature_config_is_loaded_on_second_call(tmp_path: Path) -> None:
    """Second call: file exists → returns (cfg, False) without re-deriving.
    We tamper with the JSON between calls to prove it's actually being
    read from disk and not re-derived from the dataframe."""
    config_dir = tmp_path / "feature_config"
    df = _build_day_df(seed=1)
    _cfg, newly = _load_or_derive_feature_config("nifty50", config_dir, df)
    assert newly is True

    # Tamper with the on-disk config
    cfg_path = config_dir / "nifty50_feature_config.json"
    tampered = {"final_features": ["feature_0", "feature_1"]}
    cfg_path.write_text(json.dumps(tampered), encoding="utf-8")

    cfg2, newly2 = _load_or_derive_feature_config("nifty50", config_dir, df)
    assert newly2 is False
    assert cfg2 == tampered


# ── Single-day mode ───────────────────────────────────────────────────────

def test_single_day_mode_runs_random_80_20_split(tmp_path: Path,
                                                  capsys: pytest.CaptureFixture,
                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    """1 parquet in date range → fallback to random 80/20 split, with the
    'Single-day mode' diagnostic in stdout."""
    features_root = tmp_path / "features"
    instrument = "nifty50"
    _write_day_parquet(features_root, instrument, "2026-04-01",
                       _build_day_df(seed=42, date_str="2026-04-01"))

    result = train_instrument(
        instrument=instrument,
        date_from="2026-04-01",
        date_to="2026-04-01",
        features_root=features_root,
        models_root=tmp_path / "models",
        config_dir=tmp_path / "feature_config",
        val_days=3,
    )

    captured = capsys.readouterr()
    assert "Single-day mode" in captured.out

    manifest = json.loads(
        (result.output_dir / "training_manifest.json").read_text(encoding="utf-8")
    )
    # Train + val labels both reference the same single day
    assert any("80%" in d for d in manifest["train_dates"])
    assert any("20%" in d for d in manifest["val_dates"])


# ── Multi-day mode + val_days cap ─────────────────────────────────────────

def test_multi_day_mode_uses_walk_forward_split(tmp_path: Path) -> None:
    """4 days, val_days=1: train = first 3 days, val = last 1 day."""
    features_root = tmp_path / "features"
    instrument = "nifty50"
    for i, ds in enumerate(["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04"]):
        _write_day_parquet(features_root, instrument, ds,
                           _build_day_df(seed=i, date_str=ds))

    result = train_instrument(
        instrument=instrument,
        date_from="2026-04-01",
        date_to="2026-04-04",
        features_root=features_root,
        models_root=tmp_path / "models",
        config_dir=tmp_path / "feature_config",
        val_days=1,
    )
    manifest = json.loads(
        (result.output_dir / "training_manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["train_dates"] == ["2026-04-01", "2026-04-02", "2026-04-03"]
    assert manifest["val_dates"] == ["2026-04-04"]


def test_val_days_capped_at_half_of_total(tmp_path: Path) -> None:
    """4 days, val_days=10 (over-asked): cap = 4 // 2 = 2 → val gets last
    2 days, train gets first 2 days."""
    features_root = tmp_path / "features"
    instrument = "nifty50"
    for i, ds in enumerate(["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04"]):
        _write_day_parquet(features_root, instrument, ds,
                           _build_day_df(seed=i, date_str=ds))

    result = train_instrument(
        instrument=instrument,
        date_from="2026-04-01",
        date_to="2026-04-04",
        features_root=features_root,
        models_root=tmp_path / "models",
        config_dir=tmp_path / "feature_config",
        val_days=10,  # capped to 2
    )
    manifest = json.loads(
        (result.output_dir / "training_manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["train_dates"] == ["2026-04-01", "2026-04-02"]
    assert manifest["val_dates"]   == ["2026-04-03", "2026-04-04"]


# ── PY-5 val-split guard (THE most important test) ───────────────────────

def test_single_class_val_skips_binary_target(tmp_path: Path) -> None:
    """PY-5 val-split guard: when val day's `direction_900s` is all-1, the
    trainer must SKIP `direction_900s` (would yield NaN AUC) but still
    train every other target whose val data is well-formed.

    Construction:
      - 3 train days (2026-04-01 .. 2026-04-03): every binary target has a
        balanced 0/1 mix.
      - 1 val day (2026-04-04): `direction_900s` forced to all 1s; every
        other binary target keeps its balanced 0/1 mix (the seed for the
        synthetic frame is well past the trivial seed 0, so AUC for those
        is well-defined even on 200 rows).
    """
    features_root = tmp_path / "features"
    models_root   = tmp_path / "models"
    config_dir    = tmp_path / "feature_config"
    instrument    = "nifty50"

    # Train days: balanced
    for i, ds in enumerate(["2026-04-01", "2026-04-02", "2026-04-03"]):
        _write_day_parquet(features_root, instrument, ds,
                           _build_day_df(seed=10 + i, date_str=ds))

    # Val day: direction_900s forced single-class
    val_df = _build_day_df(
        seed=99,
        date_str="2026-04-04",
        direction_900s_override=np.ones(200, dtype="int64"),
    )
    _write_day_parquet(features_root, instrument, "2026-04-04", val_df)

    result = train_instrument(
        instrument=instrument,
        date_from="2026-04-01",
        date_to="2026-04-04",
        features_root=features_root,
        models_root=models_root,
        config_dir=config_dir,
        val_days=1,
    )

    metrics = json.loads(
        (result.output_dir / "metrics.json").read_text(encoding="utf-8")
    )

    # 1) direction_900s must be flagged skipped + reason mentions one class
    assert "direction_900s" in metrics
    assert metrics["direction_900s"].get("skipped") is True, (
        f"direction_900s must be skipped, got {metrics['direction_900s']}"
    )
    assert "one class" in metrics["direction_900s"].get("reason", "").lower(), (
        f"reason should mention 'one class', got "
        f"{metrics['direction_900s'].get('reason')!r}"
    )

    # 2) No .lgbm file written for the skipped target
    assert not (result.output_dir / "direction_900s.lgbm").exists(), (
        "direction_900s.lgbm must NOT be written when skipped"
    )

    # 3) Other binary targets with balanced val data DID train successfully
    #    (at least one — we don't insist on all four because the random seed
    #    could theoretically push another window to single-class on 200 rows;
    #    direction_30s is the canonical guard).
    assert "direction_30s" in metrics
    assert metrics["direction_30s"].get("skipped") is not True, (
        f"direction_30s should have trained, got {metrics['direction_30s']}"
    )
    assert "val_auc" in metrics["direction_30s"]
    assert (result.output_dir / "direction_30s.lgbm").exists()

    # 4) Skipped list reflects the one we forced
    manifest = json.loads(
        (result.output_dir / "training_manifest.json").read_text(encoding="utf-8")
    )
    assert "direction_900s" in manifest["skipped_targets"]


# ── Manifest + LATEST pointer ─────────────────────────────────────────────

def test_training_manifest_has_required_keys(tmp_path: Path) -> None:
    features_root = tmp_path / "features"
    instrument = "nifty50"
    for i, ds in enumerate(["2026-04-01", "2026-04-02"]):
        _write_day_parquet(features_root, instrument, ds,
                           _build_day_df(seed=20 + i, date_str=ds))

    result = train_instrument(
        instrument=instrument,
        date_from="2026-04-01",
        date_to="2026-04-02",
        features_root=features_root,
        models_root=tmp_path / "models",
        config_dir=tmp_path / "feature_config",
        val_days=1,
    )
    manifest = json.loads(
        (result.output_dir / "training_manifest.json").read_text(encoding="utf-8")
    )
    for key in ("instrument", "timestamp", "targets", "trained_count",
                "skipped_targets", "feature_count"):
        assert key in manifest, f"manifest missing required key {key!r}"
    assert manifest["instrument"] == "nifty50"
    assert manifest["targets"] == list(MVP_TARGET_OBJECTIVES.keys())
    assert isinstance(manifest["trained_count"], int)
    assert isinstance(manifest["skipped_targets"], list)
    assert manifest["trained_count"] + len(manifest["skipped_targets"]) == \
        len(MVP_TARGET_OBJECTIVES)
    assert manifest["feature_count"] == result.feature_count


def test_latest_pointer_updates_to_new_timestamp(tmp_path: Path) -> None:
    features_root = tmp_path / "features"
    models_root   = tmp_path / "models"
    instrument = "nifty50"
    for i, ds in enumerate(["2026-04-01", "2026-04-02"]):
        _write_day_parquet(features_root, instrument, ds,
                           _build_day_df(seed=30 + i, date_str=ds))

    result = train_instrument(
        instrument=instrument,
        date_from="2026-04-01",
        date_to="2026-04-02",
        features_root=features_root,
        models_root=models_root,
        config_dir=tmp_path / "feature_config",
        val_days=1,
    )
    latest_path = models_root / instrument / "LATEST"
    assert latest_path.exists()
    assert latest_path.read_text(encoding="utf-8").strip() == result.timestamp
    # And that timestamp dir really is the output dir
    assert (models_root / instrument / result.timestamp) == result.output_dir


def test_no_data_in_range_raises_runtimeerror(tmp_path: Path) -> None:
    features_root = tmp_path / "features"
    with pytest.raises(RuntimeError, match="No Parquet data"):
        train_instrument(
            instrument="nifty50",
            date_from="2026-04-01",
            date_to="2026-04-02",
            features_root=features_root,
            models_root=tmp_path / "models",
            config_dir=tmp_path / "feature_config",
        )


# ── F5 — joblib parallel trainer ──────────────────────────────────────────

from model_training_agent.trainer import (
    _default_n_jobs,
    _train_and_save_target,
)


def test_default_n_jobs_returns_positive_int() -> None:
    """Plan §F5: default is min(4, cpu_count() - 1), at least 1."""
    n = _default_n_jobs()
    assert isinstance(n, int)
    assert n >= 1
    assert n <= 4


def test_train_and_save_target_wraps_errors_for_parallel_safety() -> None:
    """In parallel mode a single bad target must not crash the batch.
    `_train_and_save_target` returns the error string instead of raising."""
    # Empty X — LightGBM will refuse to fit. Verify the wrapper catches.
    X_empty = pd.DataFrame({"feature_a": [], "feature_b": []}, dtype="float32")
    y_empty = pd.Series([], dtype="float32")
    target, metrics, err = _train_and_save_target(
        "direction_30s", "binary",
        X_empty, y_empty, X_empty, y_empty,
        Path("/tmp/should_not_be_written.lgbm"),
        lgbm_n_jobs=1,
    )
    assert target == "direction_30s"
    assert metrics is None
    assert err is not None
    assert isinstance(err, str)


def test_n_jobs_default_is_serial(tmp_path: Path) -> None:
    """Default n_jobs=1 keeps the original serial path. Smoke test that
    the kwarg flows through and produces the expected artifacts."""
    features_root = tmp_path / "features"
    instrument = "nifty50"
    _write_day_parquet(features_root, instrument, "2026-04-01",
                       _build_day_df(seed=1, date_str="2026-04-01"))
    _write_day_parquet(features_root, instrument, "2026-04-02",
                       _build_day_df(seed=2, date_str="2026-04-02"))

    result = train_instrument(
        instrument=instrument,
        date_from="2026-04-01",
        date_to="2026-04-02",
        features_root=features_root,
        models_root=tmp_path / "models",
        config_dir=tmp_path / "feature_config",
        val_days=1,
        # n_jobs intentionally omitted — must default to 1
    )
    # All MVP targets attempted (some may skip due to single-class val,
    # which is fine — we just want the run to complete cleanly).
    assert set(result.metrics.keys()) == set(MVP_TARGET_NAMES)


def test_parallel_n_jobs_2_produces_same_target_set(tmp_path: Path) -> None:
    """n_jobs=2 must train every fit-able target the serial path would,
    and emit a .lgbm file plus a metrics entry for each. We don't compare
    metric *values* — LightGBM doesn't seed `feature_fraction` /
    `bagging_fraction` so AUC isn't bit-identical across runs."""
    features_root = tmp_path / "features"
    instrument = "nifty50"
    for i, ds in enumerate(["2026-04-01", "2026-04-02", "2026-04-03"]):
        _write_day_parquet(features_root, instrument, ds,
                           _build_day_df(seed=i + 1, date_str=ds))

    # Serial run
    serial_root = tmp_path / "serial_models"
    serial_result = train_instrument(
        instrument=instrument,
        date_from="2026-04-01",
        date_to="2026-04-03",
        features_root=features_root,
        models_root=serial_root,
        config_dir=tmp_path / "feature_config",
        val_days=1,
        n_jobs=1,
    )

    # Parallel run — fresh feature config dir so the second run derives
    # its own (avoids any cross-contamination between the two configs).
    parallel_root = tmp_path / "parallel_models"
    parallel_result = train_instrument(
        instrument=instrument,
        date_from="2026-04-01",
        date_to="2026-04-03",
        features_root=features_root,
        models_root=parallel_root,
        config_dir=tmp_path / "feature_config_parallel",
        val_days=1,
        n_jobs=2,
    )

    # Both runs cover the full target set.
    assert set(serial_result.metrics.keys()) == set(MVP_TARGET_NAMES)
    assert set(parallel_result.metrics.keys()) == set(MVP_TARGET_NAMES)

    # And they agree on which targets ran vs were skipped (the skip
    # rules are deterministic — they only depend on the val data).
    serial_ran = {t for t, m in serial_result.metrics.items() if not m.get("skipped")}
    parallel_ran = {t for t, m in parallel_result.metrics.items() if not m.get("skipped")}
    assert serial_ran == parallel_ran

    # Every non-skipped target in the parallel run wrote a .lgbm file.
    for target in parallel_ran:
        assert (parallel_result.output_dir / f"{target}.lgbm").exists(), (
            f"parallel run missing model file for {target}"
        )
