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
from dataclasses import dataclass
from datetime import datetime, timedelta, date as _date
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from model_training_agent.preprocessor import preprocess_for_training

MVP_TARGETS: dict[str, str] = {
    "direction_30s":    "binary",
    "max_upside_30s":   "regression",
    "max_drawdown_30s": "regression",
}

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


def _load_parquets(instrument: str, date_from: str, date_to: str,
                   features_root: Path) -> list[tuple[str, pd.DataFrame]]:
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


def _load_or_derive_feature_config(instrument: str, config_dir: Path,
                                   df_train: pd.DataFrame) -> tuple[dict, bool]:
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


def _fit_one(target: str, objective: str,
             X_train, y_train, X_val, y_val) -> tuple[lgb.Booster, dict]:
    """Train one model, return (booster, metrics)."""
    params = LGBM_PARAMS_BINARY if objective == "binary" else LGBM_PARAMS_REGRESSION
    model_class = lgb.LGBMClassifier if objective == "binary" else lgb.LGBMRegressor

    model = model_class(**params)
    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        callbacks=[lgb.early_stopping(30, verbose=False),
                   lgb.log_evaluation(0)],
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


def train_instrument(
    instrument: str,
    date_from: str,
    date_to: str,
    features_root: Path = Path("data/features"),
    models_root: Path = Path("models"),
    config_dir: Path = Path("config/model_feature_config"),
) -> TrainResult:
    """Train all MVP targets for one instrument across a date range."""
    # 1. Load Parquets
    loaded = _load_parquets(instrument, date_from, date_to, features_root)
    if len(loaded) < 1:
        raise RuntimeError(
            f"No Parquet data for {instrument} in [{date_from}, {date_to}]. "
            f"Run replay first: startup\\start-replay.bat {instrument}"
        )

    if len(loaded) == 1:
        # MVP single-day fallback: random 80/20 split on the one day's data.
        # Real runs will have many days → temporal split in the else branch.
        date_only, df_only = loaded[0]
        print(f"  Single-day mode: random 80/20 split on {date_only}")
        split_idx = int(len(df_only) * 0.8)
        df_train = df_only.iloc[:split_idx].reset_index(drop=True)
        df_val   = df_only.iloc[split_idx:].reset_index(drop=True)
        train_dates = [date_only + "  (80%)"]
        val_date    = date_only + " (20%)"
    else:
        # Multi-day: use SMALLEST day as val so training gets most rows (MVP).
        # Real pipeline will use last day as val (temporal) once we have a month.
        dates = [d for d, _ in loaded]
        loaded_sorted = sorted(loaded, key=lambda t: len(t[1]))
        val_date = loaded_sorted[0][0]
        train_dates = [d for d in dates if d != val_date]

        df_train = pd.concat([df for d, df in loaded if d in train_dates],
                             ignore_index=True)
        df_val   = next(df for d, df in loaded if d == val_date)

    print(f"  Training dates:   {train_dates}  ({len(df_train):,} rows)")
    print(f"  Validation date:  {val_date}  ({len(df_val):,} rows)")

    # 3. Feature config
    feature_config, newly = _load_or_derive_feature_config(
        instrument, config_dir, df_train,
    )
    print(f"  Feature config:   {'NEW' if newly else 'LOADED'}  "
          f"({len(feature_config['final_features'])} features)")

    # 4. Train each target
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = models_root / instrument / ts
    output_dir.mkdir(parents=True, exist_ok=True)

    all_metrics: dict = {}
    for target, objective in MVP_TARGETS.items():
        print(f"\n  >> Training {target} ({objective}) ...")
        X_tr, y_tr, _ = preprocess_for_training(df_train, feature_config, target)
        X_va, y_va, _ = preprocess_for_training(df_val,   feature_config, target)

        if len(X_tr) == 0 or len(X_va) == 0:
            print(f"     SKIP: no data after preprocess (train={len(X_tr)}, val={len(X_va)})")
            continue

        booster, metrics = _fit_one(target, objective, X_tr, y_tr, X_va, y_va)
        booster.save_model(str(output_dir / f"{target}.lgbm"))
        all_metrics[target] = metrics
        metric_key = "val_auc" if objective == "binary" else "val_rmse"
        print(f"     {metric_key} = {metrics[metric_key]:.4f}  "
              f"(train={metrics['n_train']:,}, val={metrics['n_val']:,})")

    # 5. Artifacts
    manifest = {
        "instrument": instrument,
        "timestamp": ts,
        "date_from": date_from,
        "date_to": date_to,
        "train_dates": train_dates,
        "val_date": val_date,
        "targets": list(MVP_TARGETS.keys()),
        "feature_count": len(feature_config["final_features"]),
    }
    (output_dir / "training_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    (output_dir / "metrics.json").write_text(
        json.dumps(all_metrics, indent=2), encoding="utf-8"
    )

    # 6. LATEST pointer
    (models_root / instrument / "LATEST").write_text(ts, encoding="utf-8")

    return TrainResult(
        timestamp=ts,
        output_dir=output_dir,
        metrics=all_metrics,
        feature_count=len(feature_config["final_features"]),
    )
