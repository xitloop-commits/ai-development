"""Train the blast model's ENTER and EXIT heads — walk-forward, day-ordered.

Honesty rules baked in (Partha 2026-09-07):
  - Folds are day-ordered: each fold trains ONLY on days before its test days.
  - No absolute price levels as features (spot/strike/atm dropped) — the model
    must learn structure + circumstances, not "the market was at 24000".
  - The partial current day (very few labeled rows) is excluded automatically.

Run:  python -m blast_model.train            (walk-forward report + final fit)
      python -m blast_model.train --no-save  (report only)
Artifacts → models/blast_model/nifty50/ (enter.lgbm, exit.lgbm, features.json)
"""
from __future__ import annotations

import argparse
import glob
import json
import os

from .config import BlastConfig
from .raw_reader import _ROOT

DROP_COLS = {"date", "ts", "side", "label_enter", "label_exit",
             "spot", "atm", "strike"}  # absolutes out; side is re-encoded
MIN_TRAIN_DAYS = 20
TEST_CHUNK_DAYS = 5
MIN_LABELED_ROWS_PER_DAY = 50


def _load(cfg: BlastConfig):
    import pandas as pd

    out_dir = os.path.join(_ROOT, cfg.out_dir)
    files = sorted(glob.glob(os.path.join(out_dir, f"*_{cfg.label_tag()}.parquet")))
    frames = []
    for f in files:
        df = pd.read_parquet(f)
        if df["label_enter"].notna().sum() >= MIN_LABELED_ROWS_PER_DAY:
            frames.append(df)
    if not frames:
        raise SystemExit(f"no dataset parquets with enough labels in {out_dir}")
    df = pd.concat(frames, ignore_index=True)
    df["is_call"] = (df["side"] == "CE").astype(float)
    feats = [c for c in df.columns if c not in DROP_COLS and df[c].dtype.kind in "fiu"]
    return df, feats


def _fit(train, feats, label):
    import lightgbm as lgb

    t = train.dropna(subset=[label])
    model = lgb.LGBMClassifier(
        n_estimators=400, learning_rate=0.05, num_leaves=63,
        min_child_samples=40, subsample=0.9, subsample_freq=1,
        colsample_bytree=0.8, reg_lambda=1.0, verbose=-1, n_jobs=-1,
    )
    model.fit(t[feats], t[label].astype(int))
    return model


def walk_forward(df, feats, label: str):
    from sklearn.metrics import roc_auc_score

    days = sorted(df["date"].unique())
    folds = []
    i = MIN_TRAIN_DAYS
    while i < len(days):
        test_days = days[i : i + TEST_CHUNK_DAYS]
        train = df[df["date"] < test_days[0]]
        test = df[df["date"].isin(test_days)].dropna(subset=[label])
        if len(test) and test[label].nunique() > 1:
            model = _fit(train, feats, label)
            p = model.predict_proba(test[feats])[:, 1]
            folds.append((test_days[0], test_days[-1], len(test),
                          roc_auc_score(test[label].astype(int), p)))
        i += TEST_CHUNK_DAYS
    return folds


def main() -> None:
    import numpy as np

    ap = argparse.ArgumentParser()
    ap.add_argument("--no-save", action="store_true")
    args = ap.parse_args()
    cfg = BlastConfig()
    df, feats = _load(cfg)
    print(f"data: {df['date'].nunique()} days, {len(df):,} rows, {len(feats)} features")

    for label in ("label_enter", "label_exit"):
        folds = walk_forward(df, feats, label)
        aucs = [a for *_, a in folds]
        print(f"\n{label} walk-forward ({len(folds)} folds):")
        for d0, d1, n, a in folds:
            print(f"  {d0}..{d1}  n={n:5d}  AUC {a:.3f}")
        print(f"  MEAN AUC {np.mean(aucs):.3f}  (weighted "
              f"{np.average(aucs, weights=[n for *_, n, _ in folds]):.3f})")

    if not args.no_save:
        out = os.path.join(_ROOT, "models", "blast_model", cfg.instrument)
        os.makedirs(out, exist_ok=True)
        for label, name in (("label_enter", "enter"), ("label_exit", "exit")):
            m = _fit(df, feats, label)
            m.booster_.save_model(os.path.join(out, f"{name}.lgbm"))
            imp = sorted(zip(feats, m.feature_importances_), key=lambda x: -x[1])[:15]
            print(f"\n{name} top features: " + ", ".join(f"{k}({v})" for k, v in imp[:8]))
        with open(os.path.join(out, "features.json"), "w", encoding="utf-8") as f:
            json.dump({"features": feats, "label_tag": cfg.label_tag(),
                       "days": sorted(df["date"].unique().tolist())}, f, indent=1)
        print(f"\nsaved -> {out}")


if __name__ == "__main__":
    main()
