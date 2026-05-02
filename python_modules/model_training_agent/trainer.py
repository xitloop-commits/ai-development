"""
trainer.py — MVP trainer. Trains 3 LightGBM models per instrument.

Targets (MVP):
  - direction_30s     (binary classification, AUC eval)
  - max_upside_30s    (regression, RMSE eval)
  - max_drawdown_30s  (regression, RMSE eval)

Flow:
  1. Load all Parquet files in [date_from, date_to]
  2. Temporal split: last day = validation, all others = training
  3. Derive feature_config on first run; save to
     config/model_feature_config/{instrument}_feature_config.json
  4. For each target, preprocess + fit LightGBM with early stopping
  5. Save models to models/{instrument}/{timestamp}/{target}.lgbm
  6. Write metrics.json + training_manifest.json
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import date as _date
from datetime import datetime, timedelta
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from joblib import Parallel, delayed

# Single source of truth — the 28 canonical targets (7 types × 4 windows)
# locked Phase D4, surfaced through `_shared.targets` per Phase E9 so the
# trainer + SEA model loader can never drift again. Old local copy
# dropped 2026-04-30; the orphan `upside_percentile_30s` (which never
# fit the 7×4 matrix) is no longer trained — it remains a TFA-emitted
# live session-rank feature column, which is correct.
from _shared.targets import MVP_TARGET_OBJECTIVES as MVP_TARGETS
from model_training_agent.preprocessor import (
    extract_target_subset,
    preprocess_for_training,
    preprocess_for_training_base,
)

LGBM_PARAMS_BINARY = {
    "objective": "binary",
    "metric": "auc",
    "learning_rate": 0.05,
    "num_leaves": 63,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "verbose": -1,
    "n_estimators": 500,
}
LGBM_PARAMS_REGRESSION = {
    "objective": "regression",
    "metric": "rmse",
    "learning_rate": 0.05,
    "num_leaves": 63,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "verbose": -1,
    "n_estimators": 500,
}


@dataclass
class TrainResult:
    timestamp: str
    output_dir: Path
    metrics: dict
    feature_count: int


def _load_parquets(
    instrument: str, date_from: str, date_to: str, features_root: Path
) -> list[tuple[str, pd.DataFrame]]:
    """Load Parquet files for each date in range. Returns list of (date, df)."""
    out: list[tuple[str, pd.DataFrame]] = []
    d = _date.fromisoformat(date_from)
    end = _date.fromisoformat(date_to)
    while d <= end:
        ds = d.isoformat()
        p = features_root / ds / f"{instrument}_features.parquet"
        if p.exists():
            df = pd.read_parquet(p)
            df["__date"] = ds
            out.append((ds, df))
        d += timedelta(days=1)
    return out


def _load_or_derive_feature_config(
    instrument: str, config_dir: Path, df_train: pd.DataFrame
) -> tuple[dict, bool]:
    """Returns (feature_config, newly_created)."""
    config_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = config_dir / f"{instrument}_feature_config.json"
    if cfg_path.exists():
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        return cfg, False
    # Derive by running preprocessor on training slice with first target
    first_target = next(iter(MVP_TARGETS))
    _X, _y, cfg = preprocess_for_training(df_train, None, first_target)
    cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return cfg, True


def _fit_one(
    target: str, objective: str, X_train, y_train, X_val, y_val, *, lgbm_n_jobs: int = -1
) -> tuple[lgb.Booster, dict]:
    """Train one model, return (booster, metrics).

    F5: `lgbm_n_jobs` controls LightGBM's internal thread count. The
    parallel-mode caller pins this to 1 so joblib outer parallelism +
    LightGBM inner parallelism don't oversubscribe CPU cores.
    """
    base = LGBM_PARAMS_BINARY if objective == "binary" else LGBM_PARAMS_REGRESSION
    params = {**base, "n_jobs": lgbm_n_jobs}
    model_class = lgb.LGBMClassifier if objective == "binary" else lgb.LGBMRegressor

    model = model_class(**params)
    model.fit(
        X_train,
        y_train,
        eval_set=[(X_val, y_val)],
        callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(0)],
    )

    metrics: dict = {"n_train": len(X_train), "n_val": len(X_val)}
    if objective == "binary":
        from sklearn.metrics import roc_auc_score

        val_preds = model.predict_proba(X_val)[:, 1]
        metrics["val_auc"] = float(roc_auc_score(y_val, val_preds))
    else:
        from sklearn.metrics import mean_squared_error

        val_preds = model.predict(X_val)
        metrics["val_rmse"] = float(np.sqrt(mean_squared_error(y_val, val_preds)))

    return model.booster_, metrics


def _train_and_save_target(
    target: str,
    objective: str,
    X_train,
    y_train,
    X_val,
    y_val,
    output_path: Path,
    *,
    lgbm_n_jobs: int,
) -> tuple[str, dict | None, str | None]:
    """Fit one target and persist the booster to `output_path`.

    Designed to run in either the main process (serial mode) or a joblib
    worker (parallel mode); the booster is saved to disk inside this
    function so we don't have to pickle a fully-built booster across
    process boundaries on the way back.

    Returns (target, metrics, error_or_None). Exceptions are caught and
    returned as the error string so a single bad target doesn't kill the
    whole batch in parallel mode.
    """
    try:
        booster, metrics = _fit_one(
            target,
            objective,
            X_train,
            y_train,
            X_val,
            y_val,
            lgbm_n_jobs=lgbm_n_jobs,
        )
        booster.save_model(str(output_path))
        return target, metrics, None
    except Exception as e:
        return target, None, f"{type(e).__name__}: {e}"


def _default_n_jobs() -> int:
    """Plan §F5: `min(4, cpu_count() - 1)` capped at the host's logical CPU count."""
    cores = os.cpu_count() or 1
    return max(1, min(4, cores - 1))


def train_instrument(
    instrument: str,
    date_from: str,
    date_to: str,
    features_root: Path = Path("data/features"),
    models_root: Path = Path("models"),
    config_dir: Path = Path("config/model_feature_config"),
    val_days: int = 3,
    n_jobs: int = 1,
) -> TrainResult:
    """Train all MVP targets for one instrument across a date range.

    Split strategy:
      - 1 day available   → random 80/20 split on that day.
      - >=2 days          → walk-forward: last `val_days` chronological days
                            used as val, earlier days used as train. `val_days`
                            is capped at `total_days // 2` so train always has
                            majority of data.

    The wider val split (default 3 days instead of 1) reduces the chance that
    val ends up single-class for long-lookahead binary targets
    (direction_300s / direction_900s), which caused NaN AUC in earlier runs.
    """
    # 1. Load Parquets
    loaded = _load_parquets(instrument, date_from, date_to, features_root)
    if len(loaded) < 1:
        raise RuntimeError(
            f"No Parquet data for {instrument} in [{date_from}, {date_to}]. "
            f"Run replay first: startup\\start-replay.bat {instrument}"
        )

    if len(loaded) == 1:
        # Single-day fallback: random 80/20 split on the one day's data.
        date_only, df_only = loaded[0]
        print(f"  Single-day mode: random 80/20 split on {date_only}")
        split_idx = int(len(df_only) * 0.8)
        df_train = df_only.iloc[:split_idx].reset_index(drop=True)
        df_val = df_only.iloc[split_idx:].reset_index(drop=True)
        train_dates = [date_only + "  (80%)"]
        val_dates = [date_only + " (20%)"]
    else:
        # Walk-forward: last `val_days` days as val, rest as train.
        # Cap at total_days // 2 so train keeps majority of rows.
        effective_val_days = max(1, min(val_days, len(loaded) // 2))
        loaded_by_date = sorted(loaded, key=lambda t: t[0])  # ascending
        train_pairs = loaded_by_date[:-effective_val_days]
        val_pairs = loaded_by_date[-effective_val_days:]

        train_dates = [d for d, _ in train_pairs]
        val_dates = [d for d, _ in val_pairs]

        df_train = pd.concat([df for _, df in train_pairs], ignore_index=True)
        df_val = pd.concat([df for _, df in val_pairs], ignore_index=True)

    print(f"  Training dates:   {train_dates}  ({len(df_train):,} rows)")
    print(f"  Validation dates: {val_dates}  ({len(df_val):,} rows)")

    # 3. Feature config
    feature_config, newly = _load_or_derive_feature_config(
        instrument,
        config_dir,
        df_train,
    )
    print(
        f"  Feature config:   {'NEW' if newly else 'LOADED'}  "
        f"({len(feature_config['final_features'])} features)"
    )

    # 4. Train each target
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = models_root / instrument / ts
    output_dir.mkdir(parents=True, exist_ok=True)

    # F4: compute the row-filtered DataFrame + float32 feature matrix ONCE
    # per (instrument, run). Pre-F4 the trainer ran the full preprocessor
    # ~26 times (once per target) — most of that work was identical
    # (Step 1 row filter, feature extraction, dtype cast). With the
    # split, the per-target work is just `extract_target_subset`, which
    # is a boolean mask + reset_index on already-built X_base.
    df_train_filt, X_train_base, feature_config = preprocess_for_training_base(
        df_train,
        feature_config,
    )
    df_val_filt, X_val_base, _ = preprocess_for_training_base(
        df_val,
        feature_config,
    )

    all_metrics: dict = {}
    skipped_targets: list[str] = []

    # F5 — pre-flight: build the list of fit-able targets and apply the
    # cheap skip rules (no data, single-class val) here so the parallel
    # path doesn't pay subprocess startup cost just to skip.
    fit_jobs: list[tuple[str, str, pd.DataFrame, pd.Series, pd.DataFrame, pd.Series]] = []
    for target, objective in MVP_TARGETS.items():
        X_tr, y_tr = extract_target_subset(df_train_filt, X_train_base, target)
        X_va, y_va = extract_target_subset(df_val_filt, X_val_base, target)

        if len(X_tr) == 0 or len(X_va) == 0:
            reason = f"no data after preprocess (train={len(X_tr)}, val={len(X_va)})"
            print(f"  >> SKIP {target}: {reason}")
            all_metrics[target] = {
                "n_train": len(X_tr),
                "n_val": len(X_va),
                "skipped": True,
                "reason": reason,
            }
            skipped_targets.append(target)
            continue

        if objective == "binary":
            unique_classes = np.unique(y_va)
            if len(unique_classes) < 2:
                reason = (
                    f"val has only one class ({unique_classes.tolist()}); "
                    f"AUC undefined. Widen --val-days or wait for more data."
                )
                print(f"  >> SKIP {target}: {reason}")
                all_metrics[target] = {
                    "n_train": len(X_tr),
                    "n_val": len(X_va),
                    "skipped": True,
                    "reason": reason,
                }
                skipped_targets.append(target)
                continue

        fit_jobs.append((target, objective, X_tr, y_tr, X_va, y_va))

    # F5 — execute: serial when n_jobs<=1 (preserves the original log
    # cadence and is what tests rely on), parallel otherwise. In parallel
    # mode LightGBM's internal thread count is pinned to 1 so the outer
    # joblib workers don't oversubscribe.
    if n_jobs <= 1:
        for target, objective, X_tr, y_tr, X_va, y_va in fit_jobs:
            print(f"\n  >> Training {target} ({objective}) ...")
            _, metrics, err = _train_and_save_target(
                target,
                objective,
                X_tr,
                y_tr,
                X_va,
                y_va,
                output_dir / f"{target}.lgbm",
                lgbm_n_jobs=-1,
            )
            if err is not None:
                print(f"     FAILED: {err}")
                all_metrics[target] = {
                    "n_train": len(X_tr),
                    "n_val": len(X_va),
                    "failed": True,
                    "error": err,
                }
                skipped_targets.append(target)
                continue
            all_metrics[target] = metrics
            metric_key = "val_auc" if objective == "binary" else "val_rmse"
            print(
                f"     {metric_key} = {metrics[metric_key]:.4f}  "
                f"(train={metrics['n_train']:,}, val={metrics['n_val']:,})"
            )
    else:
        print(
            f"\n  >> Training {len(fit_jobs)} targets in parallel "
            f"(n_jobs={n_jobs}, lgbm_n_jobs=1) ..."
        )
        results = Parallel(n_jobs=n_jobs)(
            delayed(_train_and_save_target)(
                target,
                objective,
                X_tr,
                y_tr,
                X_va,
                y_va,
                output_dir / f"{target}.lgbm",
                lgbm_n_jobs=1,
            )
            for target, objective, X_tr, y_tr, X_va, y_va in fit_jobs
        )
        # Re-attach objective / sizes from the input job list so the
        # post-loop print uses the right metric label and counts.
        for (_target_ret, metrics, err), (target_in, objective, X_tr, _yt, X_va, _yv) in zip(
            results, fit_jobs, strict=False
        ):
            if err is not None:
                print(f"     FAILED {target_in}: {err}")
                all_metrics[target_in] = {
                    "n_train": len(X_tr),
                    "n_val": len(X_va),
                    "failed": True,
                    "error": err,
                }
                skipped_targets.append(target_in)
                continue
            all_metrics[target_in] = metrics
            metric_key = "val_auc" if objective == "binary" else "val_rmse"
            print(
                f"     {target_in}: {metric_key} = {metrics[metric_key]:.4f}  "
                f"(train={metrics['n_train']:,}, val={metrics['n_val']:,})"
            )

    # 5. Artifacts
    manifest = {
        "instrument": instrument,
        "timestamp": ts,
        "date_from": date_from,
        "date_to": date_to,
        "train_dates": train_dates,
        "val_dates": val_dates,
        "targets": list(MVP_TARGETS.keys()),
        "trained_count": len(MVP_TARGETS) - len(skipped_targets),
        "skipped_targets": skipped_targets,
        "feature_count": len(feature_config["final_features"]),
    }
    (output_dir / "training_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    (output_dir / "metrics.json").write_text(json.dumps(all_metrics, indent=2), encoding="utf-8")

    # 6. LATEST pointer
    (models_root / instrument / "LATEST").write_text(ts, encoding="utf-8")

    return TrainResult(
        timestamp=ts,
        output_dir=output_dir,
        metrics=all_metrics,
        feature_count=len(feature_config["final_features"]),
    )
