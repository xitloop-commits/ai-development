"""
tests/test_model_loader.py — Phase E10 PR2 lock for the LATEST/version
dance and feature-config plumbing in `signal_engine_agent.model_loader`.

We materialise tiny throwaway LightGBM models (n_estimators=2, 3 features)
into a tmp_path, write a LATEST pointer, and assert the loader resolves
the right version, skips missing-but-non-fatal target files, and
surfaces actionable error messages on the three breakage modes.

Run: python -m pytest python_modules/signal_engine_agent/tests/test_model_loader.py -v
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
import pytest

import lightgbm as lgb

from signal_engine_agent.model_loader import LoadedModels, load_models
from _shared.targets import MVP_TARGET_NAMES


# ── helpers ───────────────────────────────────────────────────────────────

def _make_dummy_lgbm(path: Path, n_features: int = 3) -> None:
    """Train a 2-tree LightGBM on synthetic data and save its booster."""
    rng = np.random.RandomState(0)
    X = rng.rand(50, n_features)
    y = (X[:, 0] > 0.5).astype(int)
    m = lgb.LGBMClassifier(n_estimators=2, verbose=-1)
    m.fit(X, y)
    path.parent.mkdir(parents=True, exist_ok=True)
    m.booster_.save_model(str(path))


def _build_layout(
    tmp_path: Path,
    *,
    instrument: str = "nifty50",
    version: str = "v_test_20260501",
    targets: list[str] | None = None,
    feature_names: list[str] | None = None,
    write_latest: bool = True,
    write_feature_config: bool = True,
) -> tuple[Path, Path]:
    """
    Build models/ + config/model_feature_config/ trees under tmp_path.
    Returns (models_root, config_dir).
    """
    if targets is None:
        targets = ["direction_30s", "risk_reward_ratio_30s", "max_upside_30s"]
    if feature_names is None:
        feature_names = ["f0", "f1", "f2"]

    models_root = tmp_path / "models"
    inst_dir    = models_root / instrument
    version_dir = inst_dir / version
    version_dir.mkdir(parents=True)

    for t in targets:
        _make_dummy_lgbm(version_dir / f"{t}.lgbm", n_features=len(feature_names))

    if write_latest:
        (inst_dir / "LATEST").write_text(version, encoding="utf-8")

    config_dir = tmp_path / "config" / "model_feature_config"
    config_dir.mkdir(parents=True)
    if write_feature_config:
        (config_dir / f"{instrument}_feature_config.json").write_text(
            json.dumps({"final_features": feature_names}),
            encoding="utf-8",
        )

    return models_root, config_dir


# ── happy path ────────────────────────────────────────────────────────────

def test_load_models_returns_loaded_models_dataclass(tmp_path):
    models_root, config_dir = _build_layout(tmp_path)
    loaded = load_models("nifty50", models_root=models_root, config_dir=config_dir)
    assert isinstance(loaded, LoadedModels)
    assert loaded.instrument == "nifty50"


def test_load_models_resolves_latest_pointer(tmp_path):
    models_root, config_dir = _build_layout(tmp_path, version="v_test_20260501")
    loaded = load_models("nifty50", models_root=models_root, config_dir=config_dir)
    assert loaded.version == "v_test_20260501"


def test_load_models_strips_whitespace_from_latest(tmp_path):
    """LATEST pointer with surrounding newline must be stripped — common
    when the file is written by `echo $version > LATEST`."""
    models_root, config_dir = _build_layout(tmp_path, version="v_strip")
    # Overwrite LATEST with whitespace
    (models_root / "nifty50" / "LATEST").write_text("  v_strip  \n", encoding="utf-8")
    loaded = load_models("nifty50", models_root=models_root, config_dir=config_dir)
    assert loaded.version == "v_strip"


def test_load_models_loads_lgbm_files(tmp_path):
    models_root, config_dir = _build_layout(
        tmp_path,
        targets=["direction_30s", "max_upside_30s"],
    )
    loaded = load_models("nifty50", models_root=models_root, config_dir=config_dir)
    assert "direction_30s" in loaded.models
    assert "max_upside_30s" in loaded.models
    # Sanity: the loaded booster can run inference
    X = np.zeros((1, 3))
    out = loaded.models["direction_30s"].predict(X)
    assert out.shape == (1,)


def test_load_models_silently_skips_missing_targets(tmp_path):
    """Not all 28 .lgbm files need exist — missing targets are skipped
    so the engine can call `.get(target)` and treat NaN downstream."""
    models_root, config_dir = _build_layout(
        tmp_path,
        targets=["direction_30s"],  # only one target on disk
    )
    loaded = load_models("nifty50", models_root=models_root, config_dir=config_dir)
    assert "direction_30s" in loaded.models
    assert "max_upside_30s" not in loaded.models
    # No hard failure even with 27/28 missing
    assert len(loaded.models) == 1


def test_load_models_loads_only_canonical_target_names(tmp_path):
    """A stray .lgbm whose name is NOT in MVP_TARGET_NAMES must NOT be
    picked up — guards against legacy `upside_percentile_30s.lgbm`-style
    files getting silently loaded after the E9 lock."""
    models_root, config_dir = _build_layout(tmp_path)
    inst_version_dir = models_root / "nifty50" / "v_test_20260501"
    _make_dummy_lgbm(inst_version_dir / "rogue_target.lgbm", n_features=3)
    loaded = load_models("nifty50", models_root=models_root, config_dir=config_dir)
    assert "rogue_target" not in loaded.models
    # Each loaded name must be one of the 28 canonical targets
    for name in loaded.models:
        assert name in MVP_TARGET_NAMES


def test_load_models_feature_names_match_config(tmp_path):
    models_root, config_dir = _build_layout(
        tmp_path, feature_names=["alpha", "beta", "gamma"],
    )
    loaded = load_models("nifty50", models_root=models_root, config_dir=config_dir)
    assert loaded.feature_names == ["alpha", "beta", "gamma"]
    assert loaded.feature_config["final_features"] == ["alpha", "beta", "gamma"]


def test_load_models_feature_names_preserve_order(tmp_path):
    """Loader returns final_features verbatim — order must round-trip."""
    models_root, config_dir = _build_layout(
        tmp_path, feature_names=["z", "a", "m", "b"],
    )
    loaded = load_models("nifty50", models_root=models_root, config_dir=config_dir)
    assert loaded.feature_names == ["z", "a", "m", "b"]


# ── error paths ───────────────────────────────────────────────────────────

def test_missing_latest_raises_actionable_error(tmp_path):
    """No LATEST pointer → FileNotFoundError naming the instrument and
    pointing the user at the MTA CLI."""
    models_root, config_dir = _build_layout(tmp_path, write_latest=False)
    with pytest.raises(FileNotFoundError) as exc:
        load_models("nifty50", models_root=models_root, config_dir=config_dir)
    msg = str(exc.value)
    assert "nifty50" in msg
    assert "model_training_agent" in msg.lower() or "mta" in msg.lower()
    assert "LATEST" in msg


def test_latest_pointing_at_nonexistent_dir_raises(tmp_path):
    """LATEST exists but version dir missing → clear error showing both
    the pointer value and the resolved path."""
    models_root, config_dir = _build_layout(tmp_path, version="v_real")
    # Overwrite LATEST to point at a nonexistent version
    (models_root / "nifty50" / "LATEST").write_text("v_ghost", encoding="utf-8")
    with pytest.raises(FileNotFoundError) as exc:
        load_models("nifty50", models_root=models_root, config_dir=config_dir)
    msg = str(exc.value)
    assert "v_ghost" in msg


def test_missing_feature_config_raises(tmp_path):
    models_root, config_dir = _build_layout(tmp_path, write_feature_config=False)
    with pytest.raises(FileNotFoundError) as exc:
        load_models("nifty50", models_root=models_root, config_dir=config_dir)
    assert "feature config" in str(exc.value).lower() or "feature_config" in str(exc.value)


def test_unknown_instrument_uses_its_own_path(tmp_path):
    """Loader keys off the `instrument` arg verbatim — passing
    'banknifty' looks for models/banknifty/LATEST regardless of what's
    on disk for nifty50."""
    models_root, config_dir = _build_layout(tmp_path, instrument="nifty50")
    with pytest.raises(FileNotFoundError) as exc:
        load_models("banknifty", models_root=models_root, config_dir=config_dir)
    assert "banknifty" in str(exc.value)


# ── E9 regression: target source-of-truth ─────────────────────────────────

def test_loader_uses_shared_mvp_target_names(tmp_path):
    """Phase E9 lock: the loader walks `_shared.targets.MVP_TARGET_NAMES`,
    not a private 29-entry tuple. Verify by writing every canonical
    target and asserting all 28 are loaded — no more, no less."""
    models_root, config_dir = _build_layout(
        tmp_path,
        targets=list(MVP_TARGET_NAMES),
    )
    loaded = load_models("nifty50", models_root=models_root, config_dir=config_dir)
    assert set(loaded.models.keys()) == set(MVP_TARGET_NAMES)
    assert len(loaded.models) == 28


def test_orphan_upside_percentile_target_not_loaded(tmp_path):
    """Belt-and-braces: even if someone drops an old
    `upside_percentile_30s.lgbm` into a new version dir, the loader
    must ignore it (it's now a TFA-emitted feature column, not a target)."""
    models_root, config_dir = _build_layout(tmp_path)
    inst_version_dir = models_root / "nifty50" / "v_test_20260501"
    _make_dummy_lgbm(inst_version_dir / "upside_percentile_30s.lgbm", n_features=3)
    loaded = load_models("nifty50", models_root=models_root, config_dir=config_dir)
    assert "upside_percentile_30s" not in loaded.models
