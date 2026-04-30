"""
model_loader.py — Load trained LightGBM models for one instrument.

Reads models/{instrument}/LATEST pointer → loads {target}.lgbm files and
the associated feature_config.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import lightgbm as lgb

# Single source of truth — the 28 canonical targets (7 types × 4 windows)
# locked Phase D4, surfaced through `_shared.targets` per Phase E9 so the
# trainer + SEA loader can never drift again. Old local 29-entry tuple
# dropped 2026-04-30; the orphan `upside_percentile_30s` (which never fit
# the 7×4 matrix) is no longer trained — it remains a TFA-emitted live
# session-rank feature column on parquet rows, which is correct.
from _shared.targets import MVP_TARGET_NAMES as MVP_TARGETS


@dataclass
class LoadedModels:
    instrument: str
    version: str
    models: dict                 # {target_name: lgb.Booster}
    feature_config: dict
    feature_names: list[str]


def load_models(
    instrument: str,
    models_root: Path = Path("models"),
    config_dir: Path = Path("config/model_feature_config"),
) -> LoadedModels:
    """
    Load the LATEST trained models for `instrument`.

    Raises FileNotFoundError with actionable error message if anything is missing.
    """
    latest = models_root / instrument / "LATEST"
    if not latest.exists():
        raise FileNotFoundError(
            f"No trained model found for {instrument}.\n"
            f"  Missing: {latest}\n"
            f"  Run MTA first: python -m model_training_agent.cli "
            f"--instrument {instrument} --date-from YYYY-MM-DD --date-to YYYY-MM-DD"
        )
    version = latest.read_text(encoding="utf-8").strip()
    version_dir = models_root / instrument / version
    if not version_dir.is_dir():
        raise FileNotFoundError(
            f"LATEST points to {version!r} but directory does not exist: {version_dir}"
        )

    models: dict = {}
    for target in MVP_TARGETS:
        p = version_dir / f"{target}.lgbm"
        if p.exists():
            models[target] = lgb.Booster(model_file=str(p))
        # Skip missing models — engine uses .get() which returns nan for absent models

    cfg_path = config_dir / f"{instrument}_feature_config.json"
    if not cfg_path.exists():
        raise FileNotFoundError(f"Missing feature config: {cfg_path}")
    feature_config = json.loads(cfg_path.read_text(encoding="utf-8"))
    feature_names = feature_config["final_features"]

    return LoadedModels(
        instrument=instrument,
        version=version,
        models=models,
        feature_config=feature_config,
        feature_names=feature_names,
    )
