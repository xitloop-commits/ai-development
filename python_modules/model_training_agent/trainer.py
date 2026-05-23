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
from model_training_agent.calibration import (
    fit_isotonic_for_head,
    read_calibration_sidecar,
    write_calibration_sidecar,
)
from model_training_agent.preprocessor import (
    extract_target_subset,
    preprocess_for_training,
    preprocess_for_training_base,
)
from model_training_agent.validation.sim_pnl import (
    Scorecard,
    simulate_trades,
    write_scorecard_json,
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
    instrument: str,
    date_from: str,
    date_to: str,
    features_root: Path,
    include_dates: list[str] | None = None,
) -> list[tuple[str, pd.DataFrame]]:
    """Load Parquet files for each date. Returns list of (date, df).

    If `include_dates` is given, ONLY those dates are loaded (date_from/date_to
    are ignored). Otherwise walks every day in [date_from, date_to] inclusive
    and loads any parquet present.
    """
    out: list[tuple[str, pd.DataFrame]] = []
    if include_dates:
        for ds in sorted(set(include_dates)):
            p = features_root / ds / f"{instrument}_features.parquet"
            if p.exists():
                df = pd.read_parquet(p)
                df["__date"] = ds
                out.append((ds, df))
        return out
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


# ── T27 — LATEST_HEADS.json writer ────────────────────────────────────────

LATEST_HEADS_VERSION: int = 1
"""Bump on every breaking change to LATEST_HEADS.json shape. SEA's
`schema_reconciler` checks this on read; mismatched versions cause the
loader to ignore the file and fall back to legacy LATEST behavior."""


def _read_current_schema_version(
    schema_registry_dir: Path = Path("config/schema_registry"),
) -> int | None:
    """Read the highest-numbered `v<N>.json` schema_version available.

    The TFA emitter writes `v<LATEST_SCHEMA_VERSION>.json` on every run
    (D66 additive-only policy). The trainer records this number on each
    head so SEA can detect "head was trained against an OLDER feature
    schema than emitter is now producing" and quarantine those heads.

    Returns None if no `v<N>.json` file exists yet — caller treats this
    as "schema_version unknown" and writes 0 + WARNs.
    """
    if not schema_registry_dir.is_dir():
        return None
    candidates: list[tuple[int, Path]] = []
    for p in schema_registry_dir.glob("v*.json"):
        stem = p.stem  # "v8"
        if not stem.startswith("v") or not stem[1:].isdigit():
            continue
        candidates.append((int(stem[1:]), p))
    if not candidates:
        return None
    _, latest = max(candidates, key=lambda t: t[0])
    payload = json.loads(latest.read_text(encoding="utf-8"))
    sv = payload.get("schema_version")
    if not isinstance(sv, int):
        return None
    return sv


def _build_latest_heads_payload(
    *,
    instrument: str,
    timestamp: str,
    schema_version: int | None,
    output_dir: Path,
    skipped_targets: list[str],
) -> dict:
    """Construct the LATEST_HEADS.json payload.

    Walks every entry in `_shared.targets.MVP_TARGETS`. Per head we
    record: head_type (scalp/trend/swing), objective (binary/regression),
    lookahead_seconds, the .lgbm filename (relative to the version dir),
    the calibration sidecar filename (or null), and the schema_version
    the head was trained against.

    Heads in `skipped_targets` are still listed but with `.lgbm` absent
    on disk → SEA reconciler will see them as missing and treat as NaN
    (matches existing missing-.lgbm semantics).
    """
    from _shared.targets import MVP_TARGETS as _ALL_TARGETS

    heads: dict[str, dict] = {}
    skipped_set = set(skipped_targets)
    for spec in _ALL_TARGETS:
        lgbm_name = f"{spec.name}.lgbm"
        cal_name = f"{spec.name}.calibration.json"
        cal_exists = (output_dir / cal_name).exists()
        heads[spec.name] = {
            "head_type": spec.head_type,
            "objective": spec.target_type,
            "lookahead_seconds": int(spec.lookahead_seconds),
            "lgbm_path": lgbm_name if spec.name not in skipped_set else None,
            "calibration_path": cal_name if cal_exists else None,
            "schema_version": schema_version if schema_version is not None else 0,
        }

    return {
        "version": LATEST_HEADS_VERSION,
        "instrument": instrument,
        "timestamp": timestamp,
        "schema_version": schema_version if schema_version is not None else 0,
        "head_count": len(heads),
        "heads": heads,
    }


def write_latest_heads_json(
    payload: dict,
    instrument_models_dir: Path,
) -> Path:
    """Write LATEST_HEADS.json next to LATEST.

    Returns the written path. The file lives at the instrument level
    (not inside the timestamped version dir) so it travels with the
    LATEST pointer and SEA can resolve both in one place.
    """
    out = instrument_models_dir / "LATEST_HEADS.json"
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return out


# ── T24b — 5-fold walk-forward CV ─────────────────────────────────────────


@dataclass(frozen=True)
class FoldSpec:
    """One walk-forward CV fold (V2_MASTER_SPEC §6 / §2.3.1)."""

    fold_index: int
    train_dates: list[str]
    val_dates: list[str]


def _plan_walk_forward_folds(
    sessions: list[str],
    n_folds: int,
    week_size: int,
) -> list[FoldSpec]:
    """Plan `n_folds` holdout windows of `week_size` sessions each, evenly
    spaced across the (sorted) `sessions`.

    Per V2_MASTER_SPEC §6 (locked 2026-05-16, Sugg #5 Option B): "Training
    set for fold N = all sessions except that week's holdout." Spaced
    evenly so the 5 windows cover different parts of the dataset and
    catch regime-shift variance.

    Returns [] if `len(sessions) < n_folds * week_size`; caller falls
    back to single-split with a WARN log (T24b "short-data" mode).
    """
    if n_folds < 1 or week_size < 1:
        raise ValueError(
            f"n_folds and week_size must be >= 1 (got {n_folds}, {week_size})"
        )
    sorted_sessions = sorted(sessions)
    n = len(sorted_sessions)
    if n < n_folds * week_size:
        return []
    step = n // n_folds
    folds: list[FoldSpec] = []
    for i in range(n_folds):
        start = i * step
        val = sorted_sessions[start : start + week_size]
        train = sorted_sessions[:start] + sorted_sessions[start + week_size :]
        folds.append(
            FoldSpec(fold_index=i, train_dates=list(train), val_dates=list(val))
        )
    return folds


def _validate_one_fold(
    fold: FoldSpec,
    loaded: list[tuple[str, pd.DataFrame]],
    feature_config: dict,
) -> dict:
    """Train every head on `fold.train_dates` and score on `fold.val_dates`.

    Returns `{target_name: metrics dict}`. Models are discarded after
    scoring — this is the evaluation-only pass; the production .lgbm
    comes from the final single-split path.

    Same skip rules as the main loop apply (no data, single-class val,
    fit exception) so per-fold metrics align with what the production
    head will actually look like.
    """
    train_set = set(fold.train_dates)
    val_set = set(fold.val_dates)
    train_dfs = [df for d, df in loaded if d in train_set]
    val_dfs = [df for d, df in loaded if d in val_set]
    df_train = pd.concat(train_dfs, ignore_index=True)
    df_val = pd.concat(val_dfs, ignore_index=True)

    df_train_filt, X_train_base, _ = preprocess_for_training_base(df_train, feature_config)
    df_val_filt, X_val_base, _ = preprocess_for_training_base(df_val, feature_config)

    metrics: dict = {}
    for target, objective in MVP_TARGETS.items():
        X_tr, y_tr = extract_target_subset(df_train_filt, X_train_base, target)
        X_va, y_va = extract_target_subset(df_val_filt, X_val_base, target)
        if len(X_tr) == 0 or len(X_va) == 0:
            metrics[target] = {
                "n_train": int(len(X_tr)),
                "n_val": int(len(X_va)),
                "failed": True,
                "reason": "no data after preprocess",
            }
            continue
        if objective == "binary" and y_va.nunique() < 2:
            metrics[target] = {
                "n_train": int(len(X_tr)),
                "n_val": int(len(X_va)),
                "failed": True,
                "reason": "single-class val (would yield NaN AUC)",
            }
            continue
        try:
            _, fit_metrics = _fit_one(
                target, objective, X_tr, y_tr, X_va, y_va, lgbm_n_jobs=1,
            )
            metrics[target] = fit_metrics
        except Exception as e:
            metrics[target] = {
                "n_train": int(len(X_tr)),
                "n_val": int(len(X_va)),
                "failed": True,
                "error": f"{type(e).__name__}: {e}",
            }
    return metrics


def _aggregate_fold_metrics(fold_results: list[dict]) -> dict:
    """Compute mean + worst-fold per-head metrics across all folds.

    Returns `{target_name: {mean_<metric>, worst_<metric>, n_folds_ok}}`.
    Skipped folds (`failed: True`) don't contribute to mean/worst — that
    head's `n_folds_ok` reflects how many folds actually scored it.
    """
    if not fold_results:
        return {}

    out: dict = {}
    all_targets: set[str] = set()
    for fr in fold_results:
        all_targets.update(fr.get("metrics", {}).keys())

    for target in all_targets:
        fold_vals: list[dict] = []
        for fr in fold_results:
            m = fr.get("metrics", {}).get(target)
            if m is None or m.get("failed"):
                continue
            fold_vals.append(m)

        if not fold_vals:
            out[target] = {"n_folds_ok": 0}
            continue

        agg: dict = {"n_folds_ok": len(fold_vals)}
        # Detect metric keys (val_auc for binary, val_rmse for regression)
        sample = fold_vals[0]
        for key in ("val_auc", "val_rmse"):
            if key in sample:
                vals = [float(fv[key]) for fv in fold_vals if key in fv]
                if vals:
                    agg[f"mean_{key}"] = float(np.mean(vals))
                    # "Worst" = lower AUC (bad) or higher RMSE (bad).
                    agg[f"worst_{key}"] = (
                        float(np.min(vals)) if key == "val_auc"
                        else float(np.max(vals))
                    )
        out[target] = agg

    return out


def train_instrument(
    instrument: str,
    date_from: str,
    date_to: str,
    features_root: Path = Path("data/features"),
    models_root: Path = Path("models"),
    config_dir: Path = Path("config/model_feature_config"),
    val_days: int = 3,
    cal_days: int = 5,
    n_folds: int = 5,
    fold_week_size: int = 5,
    n_jobs: int = 1,
    include_dates: list[str] | None = None,
) -> TrainResult:
    """Train all MVP targets for one instrument across a date range.

    Split strategy (T24a — calibration fold carve-out, 2026-05-23):
      Before any train/val split, peel off the most recent `cal_days`
      chronological sessions as a held-out CALIBRATION fold. These
      sessions are never seen by the trainer; they're recorded in the
      manifest for T25 (per-head isotonic calibration) to consume later.

      Carve-out only happens when `len(loaded) >= cal_days + 2`. Below
      that threshold the carve-out is skipped with a WARN — keeps short-
      data dev / v0-stopgap runs working. The remaining sessions then
      go through the existing split:
      - 1 day remaining   → random 80/20 split on that day.
      - >=2 days remaining → last `val_days` chronological days used as
                             val, earlier days used as train. `val_days`
                             is capped at `total_days // 2` so train
                             keeps the majority of rows.

    The wider val split (default 3 days instead of 1) reduces the chance
    that val ends up single-class for long-lookahead binary targets
    (direction_300s, trend_direction_1800s), which caused NaN AUC in
    earlier runs.
    """
    # 1. Load Parquets
    loaded = _load_parquets(
        instrument, date_from, date_to, features_root,
        include_dates=include_dates,
    )
    if len(loaded) < 1:
        if include_dates:
            raise RuntimeError(
                f"No Parquet data for {instrument} in include-dates "
                f"{sorted(set(include_dates))}. "
                f"Run replay first: startup\\start-replay.bat {instrument}"
            )
        raise RuntimeError(
            f"No Parquet data for {instrument} in [{date_from}, {date_to}]. "
            f"Run replay first: startup\\start-replay.bat {instrument}"
        )

    # 2. Calibration fold carve-out (T24a). Retain `cal_df` for the
    # post-training T25 isotonic pass — the cal sessions never touch
    # train / val so the trainer cannot peek at them, but we hold the
    # raw rows here to avoid re-reading parquet at calibration time.
    loaded_by_date_all = sorted(loaded, key=lambda t: t[0])  # ascending
    calibration_dates: list[str] = []
    cal_df: pd.DataFrame | None = None
    if cal_days > 0 and len(loaded_by_date_all) >= cal_days + 2:
        cal_pairs = loaded_by_date_all[-cal_days:]
        calibration_dates = [d for d, _ in cal_pairs]
        cal_df = pd.concat([df for _, df in cal_pairs], ignore_index=True)
        loaded = loaded_by_date_all[:-cal_days]
        print(
            f"  Calibration fold: {len(calibration_dates)} sessions reserved "
            f"({calibration_dates[0]} → {calibration_dates[-1]}); held out from training"
        )
    elif cal_days > 0:
        # Not enough data to carve out — skip with a clear log
        print(
            f"  WARN: calibration fold carve-out skipped — need >= {cal_days + 2} "
            f"sessions, got {len(loaded_by_date_all)}. T25 calibration will be "
            f"skipped (degraded mode, dev runs only)."
        )
        loaded = loaded_by_date_all  # use everything

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

    # 3.5. Walk-forward CV fold validation (T24b, V2_MASTER_SPEC §6).
    # Runs ONLY when enough sessions are available after the cal carve-
    # out. Each fold trains all 84 heads on (sessions - val_week - cal)
    # and scores on val_week — models are discarded after scoring; only
    # the metrics flow into the manifest. The production `.lgbm` files
    # come from the existing single-split path below (small spec
    # deviation noted in PROJECT_TODO T24b: the final model loses
    # `val_days` of training data; revisit if it hurts in practice).
    fold_results: list[dict] = []
    fold_aggregate: dict = {}
    folds = _plan_walk_forward_folds(
        [d for d, _ in loaded], n_folds, fold_week_size,
    )
    if folds:
        print(
            f"\n  >> Walk-forward CV: {len(folds)} folds × "
            f"{fold_week_size} sessions ..."
        )
        for fold in folds:
            print(
                f"     Fold {fold.fold_index + 1}/{len(folds)}: "
                f"val=[{fold.val_dates[0]} → {fold.val_dates[-1]}] "
                f"({len(fold.val_dates)} days), "
                f"train={len(fold.train_dates)} days"
            )
            fm = _validate_one_fold(fold, loaded, feature_config)
            fold_results.append({
                "fold_index": fold.fold_index,
                "train_dates": fold.train_dates,
                "val_dates": fold.val_dates,
                "metrics": fm,
            })
        fold_aggregate = _aggregate_fold_metrics(fold_results)
        print(
            f"  Walk-forward CV: aggregated across {len(folds)} folds for "
            f"{len(fold_aggregate)} heads"
        )
    else:
        needed = n_folds * fold_week_size
        print(
            f"  WARN: walk-forward CV skipped — need >= {needed} sessions "
            f"after cal carve-out, got {len(loaded)}. Falling back to "
            f"single-split metrics only (dev / short-data mode)."
        )

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

    # 4.5. Per-head isotonic calibration (T25, V2_MASTER_SPEC D72).
    # Only binary heads — regression heads emit signed point estimates
    # where calibration is meaningless (D75 Gap 4 narrowing 2026-05-18).
    calibration_fit_count = 0
    calibration_skipped: list[str] = []
    if cal_df is not None:
        binary_targets = [
            t for t, obj in MVP_TARGETS.items() if obj == "binary"
        ]
        print(
            f"\n  >> Fitting per-head isotonic calibration on cal fold "
            f"({len(calibration_dates)} sessions, {len(cal_df):,} rows) "
            f"for {len(binary_targets)} binary heads ..."
        )
        df_cal_filt, X_cal_base, _ = preprocess_for_training_base(
            cal_df, feature_config,
        )
        for target in binary_targets:
            if target in skipped_targets:
                calibration_skipped.append(
                    f"{target} (head was skipped during training)"
                )
                continue
            model_path = output_dir / f"{target}.lgbm"
            if not model_path.exists():
                calibration_skipped.append(f"{target} (missing .lgbm)")
                continue
            X_cal, y_cal = extract_target_subset(
                df_cal_filt, X_cal_base, target,
            )
            if len(X_cal) == 0:
                calibration_skipped.append(f"{target} (no cal data)")
                continue
            booster = lgb.Booster(model_file=str(model_path))
            raw_probs = booster.predict(X_cal.values)
            try:
                cmap = fit_isotonic_for_head(
                    np.asarray(raw_probs),
                    y_cal.values,
                    target,
                )
            except ValueError as exc:
                calibration_skipped.append(f"{target} ({exc})")
                continue
            sidecar = output_dir / f"{target}.calibration.json"
            write_calibration_sidecar(sidecar, cmap)
            calibration_fit_count += 1
        print(
            f"  Calibration: {calibration_fit_count}/{len(binary_targets)} "
            f"binary heads fitted, {len(calibration_skipped)} skipped"
        )

    # 4.6. Sim-PnL validation harness (T26, V2_MASTER_SPEC §2.3.4).
    # Runs after the main loop + T25 calibration, on the single-split
    # val set. v1 uses a simple direction-only gate (calibrated
    # `direction_60s` prob ≥ 0.65 → LONG_CE; ≤ 0.35 → LONG_PE) because
    # the real `decide_action_v2` gate needs the full 60-key prediction
    # dict and is being upgraded in T29 to handle trend/swing heads
    # too. Spec deviation noted in PROJECT_TODO T26; upgrade path is
    # "swap signal_action_fn" once T29 lands.
    sim_pnl_summary = Scorecard().manifest_summary()  # zeros by default
    sim_pnl_scorecard: Scorecard | None = None
    dir_model_path = output_dir / "direction_60s.lgbm"
    has_option_cols = all(
        c in df_val.columns for c in (
            "opt_atm_ce_bid", "opt_atm_ce_ask",
            "opt_atm_pe_bid", "opt_atm_pe_ask",
        )
    )
    if dir_model_path.exists() and has_option_cols and len(df_val_filt) > 0:
        print(
            f"\n  >> Sim-PnL validation (T26 v1): direction-only gate on "
            f"{len(df_val_filt):,} val rows ..."
        )
        try:
            dir_booster = lgb.Booster(model_file=str(dir_model_path))
            X_val_for_gate, _ = extract_target_subset(
                df_val_filt, X_val_base, "direction_60s",
            )
            raw_probs = dir_booster.predict(X_val_for_gate.values)
            cmap = read_calibration_sidecar(
                output_dir / "direction_60s.calibration.json",
            )
            cal_probs = (
                np.asarray(cmap.apply(np.asarray(raw_probs)))
                if cmap is not None
                else np.asarray(raw_probs)
            )

            # Map filtered-row index → calibrated prob; rows that were
            # dropped during preprocess get prob=NaN → gate ignores.
            # The filtered df's index column is preserved as `.index`,
            # so we can align back to df_val by position.
            prob_by_pos = dict(
                zip(df_val_filt.index.tolist(), cal_probs.tolist())
            )

            def _dir_gate(row: pd.Series) -> str | None:
                p = prob_by_pos.get(row.name)
                if p is None or not np.isfinite(p):
                    return None
                if p >= 0.65:
                    return "LONG_CE"
                if p <= 0.35:
                    return "LONG_PE"
                return None

            sim_pnl_scorecard = simulate_trades(
                df_val,
                signal_action_fn=_dir_gate,
                instrument=instrument,
            )
            sim_pnl_summary = sim_pnl_scorecard.manifest_summary()
            write_scorecard_json(
                sim_pnl_scorecard, output_dir / "sim_pnl_scorecard.json",
            )
            print(
                f"  Sim-PnL: signals={sim_pnl_scorecard.n_signals}, "
                f"wins={sim_pnl_scorecard.n_wins}, "
                f"total=₹{sim_pnl_scorecard.total_pnl_inr:,.2f}, "
                f"expectancy=₹{sim_pnl_scorecard.expectancy_inr:,.2f}"
            )
        except Exception as exc:
            print(f"  Sim-PnL: SKIPPED — {type(exc).__name__}: {exc}")
    else:
        reasons = []
        if not dir_model_path.exists():
            reasons.append("direction_60s.lgbm not on disk")
        if not has_option_cols:
            reasons.append("val data missing opt_atm_{ce,pe}_{bid,ask} cols")
        if len(df_val_filt) == 0:
            reasons.append("empty val")
        print(f"  Sim-PnL: SKIPPED — {', '.join(reasons)}")

    # 5. Artifacts
    manifest = {
        "instrument": instrument,
        "timestamp": ts,
        "date_from": date_from,
        "date_to": date_to,
        "train_dates": train_dates,
        "val_dates": val_dates,
        "calibration_dates": calibration_dates,
        "calibration_fit_count": calibration_fit_count,
        "calibration_skipped": calibration_skipped,
        # T24b — walk-forward CV per-fold metrics (empty list if dataset
        # was too short and the fold pass was skipped — see WARN log).
        "folds": fold_results,
        "fold_aggregate": fold_aggregate,
        # T26 — sim-PnL summary (zeros when harness was skipped).
        **sim_pnl_summary,
        "targets": list(MVP_TARGETS.keys()),
        "trained_count": len(MVP_TARGETS) - len(skipped_targets),
        "skipped_targets": skipped_targets,
        "feature_count": len(feature_config["final_features"]),
    }
    (output_dir / "training_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    (output_dir / "metrics.json").write_text(json.dumps(all_metrics, indent=2), encoding="utf-8")

    # 6. LATEST pointer (legacy plain-text)
    (models_root / instrument / "LATEST").write_text(ts, encoding="utf-8")

    # 7. LATEST_HEADS.json (T27, V2_MASTER_SPEC D66 / I10 / D72).
    # Per-head schema_version + head_type + calibration sidecar path so
    # SEA's schema_reconciler can quarantine heads trained against an
    # older feature schema than the emitter is currently producing.
    schema_version = _read_current_schema_version()
    if schema_version is None:
        print(
            "  WARN: no config/schema_registry/v<N>.json found — "
            "LATEST_HEADS.json will record schema_version=0. SEA "
            "reconciler will treat all heads as 'version unknown' "
            "(trust them, no quarantine)."
        )
    latest_heads_payload = _build_latest_heads_payload(
        instrument=instrument,
        timestamp=ts,
        schema_version=schema_version,
        output_dir=output_dir,
        skipped_targets=skipped_targets,
    )
    write_latest_heads_json(latest_heads_payload, models_root / instrument)

    return TrainResult(
        timestamp=ts,
        output_dir=output_dir,
        metrics=all_metrics,
        feature_count=len(feature_config["final_features"]),
    )
