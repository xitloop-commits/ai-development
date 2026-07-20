"""
model_loader.py — Load trained LightGBM models for one instrument.

Reads models/{instrument}/LATEST pointer → loads {target}.lgbm files,
the associated feature_config, and any per-head `.calibration.json`
isotonic sidecars (T25, V2_MASTER_SPEC D72).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

import lightgbm as lgb

# Single source of truth — the 88 canonical targets (60 scalp + 14 trend
# + 14 swing per V2_MASTER_SPEC §2.2 D55 + Part B direction_down), surfaced
# through `_shared.targets` per Phase E9 so the trainer + SEA loader can
# never drift again. Old local 29-entry tuple dropped 2026-04-30; the
# orphan `upside_percentile_30s` is no longer trained — it remains a
# TFA-emitted live session-rank feature column on parquet rows, which is
# correct. Heads missing from disk are silently skipped at load time —
# this matters during the v2 ramp when only the 60 scalp .lgbm files
# may exist while trend/swing await first Saturday retrain. Same
# graceful-skip rule applies to `.calibration.json` sidecars — missing
# sidecar → engine falls back to raw predict() output for that head.
from _shared.targets import MVP_TARGET_NAMES as MVP_TARGETS

# T25 — per-head isotonic calibration. Importing the MTA-side module
# from SEA is OK: both live in the same Python package tree at runtime
# and the trainer is the only writer of the sidecar format. Avoids a
# duplicate CalibrationMap definition that could drift.
from model_training_agent.calibration import (
    CalibrationMap,
    read_calibration_sidecar,
)
from signal_engine_agent.schema_reconciler import reconcile_loaded_heads


@dataclass
class LoadedModels:
    instrument: str
    version: str
    models: dict  # {target_name: lgb.Booster}
    feature_config: dict
    feature_names: list[str]
    calibrations: dict = field(default_factory=dict)
    """{target_name: CalibrationMap} — only binary heads with a fitted
    `.calibration.json` sidecar present at load time. Engine helper
    `_pred` applies these automatically; regression heads have no entry
    here and fall through unchanged."""

    def apply_calibration(self, target: str, raw_prob: float) -> float:
        """Map a raw predict() output to a calibrated probability.

        Returns `raw_prob` unchanged when no sidecar exists for this
        head (regression heads, or binary heads that the trainer
        skipped at the last retrain). Callers don't need to branch on
        sidecar presence — this method is the one decision point.
        """
        cmap = self.calibrations.get(target)
        if cmap is None:
            return raw_prob
        return float(cmap.apply(raw_prob))


def list_versions(instrument: str, models_root: Path = Path("models")) -> list[str]:
    """Every trained version on disk for `instrument`, newest first.

    Version dirs are timestamp-named (YYYYMMDD_HHMMSS), so a reverse string sort
    is chronological. Non-version entries (LATEST, LATEST_HEADS.json, the
    LATEST.bak-* files) are skipped.
    """
    root = models_root / instrument
    if not root.is_dir():
        return []
    return sorted(
        (d.name for d in root.iterdir() if d.is_dir() and d.name[:8].isdigit()),
        reverse=True,
    )


def load_models(
    instrument: str,
    models_root: Path = Path("models"),
    config_dir: Path = Path("config/model_feature_config"),
    version: str | None = None,
) -> LoadedModels:
    """
    Load trained models for `instrument`, plus any per-head isotonic calibration
    sidecars (T25).

    `version` pins an explicit version directory; None (the default) follows the
    LATEST pointer. The override exists so the AI menu can hot-swap the running
    model without rewriting LATEST — the pointer stays the restart default while
    the live engine can be pointed elsewhere.

    Raises FileNotFoundError with actionable error message if anything is missing.
    """
    if version is not None:
        version = version.strip()
        if not (models_root / instrument / version).is_dir():
            avail = ", ".join(list_versions(instrument, models_root)) or "(none)"
            raise FileNotFoundError(
                f"Model version {version!r} not found for {instrument}. Available: {avail}"
            )
    else:
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

    # 2026-06-30 — calibration kill switch. The per-head isotonic sidecars were
    # found mis-fit (they collapse the raw model output to a near-constant,
    # wrecking AUC — e.g. nifty50 trend_direction_900s raw 0.43 -> calib 0.08).
    # When SEA_DISABLE_CALIBRATION is set we skip loading every sidecar, so
    # apply_calibration() falls through to the raw probability for all heads.
    disable_cal = os.environ.get("SEA_DISABLE_CALIBRATION", "").strip().lower() not in ("", "0", "false", "no")

    models: dict = {}
    calibrations: dict[str, CalibrationMap] = {}
    for target in MVP_TARGETS:
        p = version_dir / f"{target}.lgbm"
        if p.exists():
            models[target] = lgb.Booster(model_file=str(p))
        # Skip missing models — engine uses .get() which returns nan for absent models

        # T25 sidecar — only present for binary heads the trainer
        # successfully calibrated. Missing sidecar → raw probs (graceful).
        if disable_cal:
            continue
        cal_path = version_dir / f"{target}.calibration.json"
        cmap = read_calibration_sidecar(cal_path)
        if cmap is not None:
            calibrations[target] = cmap

    cfg_path = config_dir / f"{instrument}_feature_config.json"
    if not cfg_path.exists():
        raise FileNotFoundError(f"Missing feature config: {cfg_path}")
    feature_config = json.loads(cfg_path.read_text(encoding="utf-8"))
    feature_names = feature_config["final_features"]

    # T27 — schema reconciliation (V2_MASTER_SPEC D66 / I10 / D72).
    # Drop any heads whose recorded schema_version doesn't match the
    # current emitter schema. Conservative: missing LATEST_HEADS.json,
    # missing schema_registry, or version=0 → no quarantine.
    latest_heads_path = models_root / instrument / "LATEST_HEADS.json"
    report = reconcile_loaded_heads(latest_heads_path)
    if report.quarantined:
        for name in report.quarantined:
            models.pop(name, None)
            calibrations.pop(name, None)

    return LoadedModels(
        instrument=instrument,
        version=version,
        models=models,
        feature_config=feature_config,
        feature_names=feature_names,
        calibrations=calibrations,
    )
