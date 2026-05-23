"""
tests/test_schema_reconciler.py — T27 D66 schema reconciliation tests.

The reconciler is a pure read-only function that takes (path-to-
LATEST_HEADS.json, path-to-schema_registry) and returns a list of
head names to quarantine. We exercise it via planted tmp files so the
contract is locked in isolation from the trainer + loader.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent  # python_modules/
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from signal_engine_agent.schema_reconciler import (
    QuarantineReport,
    reconcile_loaded_heads,
)


def _plant_schema_registry(tmp_path: Path, schema_version: int) -> Path:
    """Plant a single `v<N>.json` and return the schema_registry dir."""
    d = tmp_path / "schema_registry"
    d.mkdir()
    (d / f"v{schema_version}.json").write_text(
        json.dumps({
            "schema_version": schema_version,
            "feature_count": 0,
            "columns": [],
        }),
        encoding="utf-8",
    )
    return d


def _plant_latest_heads(
    tmp_path: Path, heads: dict[str, int], file_version: int = 1,
) -> Path:
    """heads = {head_name: schema_version}. file_version = LATEST_HEADS shape version."""
    path = tmp_path / "LATEST_HEADS.json"
    path.write_text(
        json.dumps({
            "version": file_version,
            "instrument": "nifty50",
            "timestamp": "test",
            "schema_version": max(heads.values()) if heads else 0,
            "head_count": len(heads),
            "heads": {
                name: {
                    "head_type": "scalp",
                    "objective": "binary",
                    "lookahead_seconds": 60,
                    "lgbm_path": f"{name}.lgbm",
                    "calibration_path": None,
                    "schema_version": sv,
                }
                for name, sv in heads.items()
            },
        }),
        encoding="utf-8",
    )
    return path


# ── happy paths ───────────────────────────────────────────────────────────


def test_no_quarantine_when_all_heads_match(tmp_path: Path) -> None:
    reg = _plant_schema_registry(tmp_path, 8)
    lh = _plant_latest_heads(tmp_path, {"a_60s": 8, "b_60s": 8, "c_60s": 8})
    report = reconcile_loaded_heads(lh, reg)
    assert report.quarantined == []
    assert report.inspected == 3
    assert report.current_schema_version == 8


def test_quarantine_when_one_head_stale(tmp_path: Path) -> None:
    reg = _plant_schema_registry(tmp_path, 9)
    lh = _plant_latest_heads(tmp_path, {
        "fresh_60s": 9,
        "stale_60s": 8,
        "fresh_120s": 9,
    })
    report = reconcile_loaded_heads(lh, reg)
    assert report.quarantined == ["stale_60s"]
    assert report.inspected == 3
    assert report.current_schema_version == 9


def test_picks_highest_v_when_multiple_registry_files(tmp_path: Path) -> None:
    d = tmp_path / "schema_registry"
    d.mkdir()
    for v in (6, 7, 8, 9):
        (d / f"v{v}.json").write_text(
            json.dumps({"schema_version": v, "feature_count": 0, "columns": []}),
            encoding="utf-8",
        )
    lh = _plant_latest_heads(tmp_path, {"x_60s": 9})
    report = reconcile_loaded_heads(lh, d)
    assert report.current_schema_version == 9
    assert report.quarantined == []


# ── conservative-on-uncertainty paths ─────────────────────────────────────


def test_no_quarantine_when_version_zero(tmp_path: Path) -> None:
    """version=0 = "unknown" → trust the head, no quarantine."""
    reg = _plant_schema_registry(tmp_path, 8)
    lh = _plant_latest_heads(tmp_path, {"unknown_60s": 0})
    report = reconcile_loaded_heads(lh, reg)
    assert report.quarantined == []
    assert report.inspected == 0  # version=0 not counted


def test_no_quarantine_when_latest_heads_missing(tmp_path: Path) -> None:
    """Legacy run pre-T27 → no LATEST_HEADS.json → no-op."""
    reg = _plant_schema_registry(tmp_path, 8)
    report = reconcile_loaded_heads(tmp_path / "LATEST_HEADS.json", reg)
    assert report.quarantined == []
    assert report.inspected == 0
    assert report.current_schema_version == 8


def test_no_quarantine_when_registry_missing(tmp_path: Path) -> None:
    """No config/schema_registry yet → reconciler can't decide → no-op."""
    lh = _plant_latest_heads(tmp_path, {"x_60s": 8})
    report = reconcile_loaded_heads(lh, tmp_path / "nonexistent_dir")
    assert report.quarantined == []
    assert report.inspected == 0
    assert report.current_schema_version is None


def test_no_quarantine_on_unsupported_file_version(tmp_path: Path) -> None:
    """LATEST_HEADS.json with future shape version → bail rather than guess."""
    reg = _plant_schema_registry(tmp_path, 8)
    lh = _plant_latest_heads(tmp_path, {"x_60s": 8}, file_version=999)
    report = reconcile_loaded_heads(lh, reg)
    assert report.quarantined == []
    assert report.inspected == 0


def test_skips_malformed_head_entries(tmp_path: Path) -> None:
    """A head whose schema_version is missing/null/non-int is treated
    like version=0 (skip the head, don't quarantine)."""
    reg = _plant_schema_registry(tmp_path, 8)
    path = tmp_path / "LATEST_HEADS.json"
    path.write_text(
        json.dumps({
            "version": 1,
            "instrument": "nifty50",
            "timestamp": "test",
            "schema_version": 8,
            "head_count": 3,
            "heads": {
                "ok_60s": {"head_type": "scalp", "schema_version": 8},
                "no_sv_60s": {"head_type": "scalp"},  # missing schema_version
                "null_sv_60s": {"head_type": "scalp", "schema_version": None},
            },
        }),
        encoding="utf-8",
    )
    report = reconcile_loaded_heads(path, reg)
    assert report.quarantined == []
    assert report.inspected == 1  # only ok_60s had a real version


def test_quarantine_strips_loader_models_at_load_time(tmp_path: Path) -> None:
    """End-to-end: a head whose schema_version mismatches is dropped from
    LoadedModels.models so the engine treats it as missing (NaN)."""
    import lightgbm as lgb
    import numpy as np

    from signal_engine_agent.model_loader import load_models

    # Build the layout: models/nifty50/v_test/{direction_60s.lgbm,...} +
    # config + LATEST_HEADS.json pointing direction_60s to OLD schema.
    models_root = tmp_path / "models"
    inst = "nifty50"
    version_dir = models_root / inst / "v_test"
    version_dir.mkdir(parents=True)

    # Train tiny boosters
    rng = np.random.RandomState(0)
    X = rng.rand(50, 3)
    y = (X[:, 0] > 0.5).astype(int)
    for target in ("direction_60s", "max_upside_60s"):
        m = lgb.LGBMClassifier(n_estimators=2, verbose=-1)
        m.fit(X, y)
        m.booster_.save_model(str(version_dir / f"{target}.lgbm"))

    (models_root / inst / "LATEST").write_text("v_test", encoding="utf-8")

    config_dir = tmp_path / "config" / "model_feature_config"
    config_dir.mkdir(parents=True)
    (config_dir / f"{inst}_feature_config.json").write_text(
        json.dumps({"final_features": ["f0", "f1", "f2"]}),
        encoding="utf-8",
    )

    # Plant a schema_registry with current=v9 and LATEST_HEADS saying
    # direction_60s was trained against v8 (stale) but max_upside_60s
    # against v9 (current).
    sr = tmp_path / "schema_registry"
    sr.mkdir()
    (sr / "v9.json").write_text(
        json.dumps({"schema_version": 9, "feature_count": 0, "columns": []}),
        encoding="utf-8",
    )
    (models_root / inst / "LATEST_HEADS.json").write_text(
        json.dumps({
            "version": 1,
            "instrument": inst,
            "timestamp": "v_test",
            "schema_version": 9,
            "head_count": 2,
            "heads": {
                "direction_60s": {
                    "head_type": "scalp", "objective": "binary",
                    "lookahead_seconds": 60, "lgbm_path": "direction_60s.lgbm",
                    "calibration_path": None, "schema_version": 8,
                },
                "max_upside_60s": {
                    "head_type": "scalp", "objective": "regression",
                    "lookahead_seconds": 60, "lgbm_path": "max_upside_60s.lgbm",
                    "calibration_path": None, "schema_version": 9,
                },
            },
        }),
        encoding="utf-8",
    )

    # Loader has to find the schema_registry at its default
    # `config/schema_registry` relative to cwd. cd into tmp_path so the
    # planted one wins.
    import os as _os
    cwd_before = _os.getcwd()
    try:
        _os.chdir(tmp_path)
        # Move planted schema_registry under config/ so default path resolves.
        (tmp_path / "config" / "schema_registry").mkdir(exist_ok=True)
        (tmp_path / "config" / "schema_registry" / "v9.json").write_text(
            (sr / "v9.json").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        loaded = load_models(inst, models_root=models_root, config_dir=config_dir)
    finally:
        _os.chdir(cwd_before)

    # direction_60s should have been quarantined → not in loaded.models
    assert "direction_60s" not in loaded.models
    # max_upside_60s should still be loaded
    assert "max_upside_60s" in loaded.models
