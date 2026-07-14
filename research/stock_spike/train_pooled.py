"""train_pooled.py — Phase-0 stock spike: pooled cross-sectional LightGBM.

Trains ONE model over all stocks pooled, per horizon (1-min, 10-min), and
evaluates the decisive generalization axes:
  • unseen DAY  (seen stock)   — temporal generalization
  • unseen STOCK (seen day)    — cross-stock generalization
  • unseen × unseen            — a stock it never trained on, on a day it never saw
Plus a no-`stock_id` ablation: if the edge needs stock_id, it's memorizing.

Saves the unseen×unseen predictions to predictions.parquet for the cost backtest.
"""
import os
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

ROOT = r"C:\Users\Admin\ai-development\ai-development"
DS = os.path.join(ROOT, "data", "research", "stock_spike", "dataset.parquet")
PRED = os.path.join(ROOT, "data", "research", "stock_spike", "out", "predictions.parquet")

HOLDOUT_STOCKS = ["ICICIBANK", "PFC", "IRCTC"]   # never in training
TEST_DAYS = 20                                    # last N sessions held out
OWN = ["ret_1", "ret_5", "ret_15", "ret_30", "rvol_20", "vol_ratio", "rsi_14",
       "vwap_dist", "range_pct", "dist_from_open", "accel", "ret_norm", "min_since_open"]
XS = ["xs_rank_ret_5", "xs_rank_ret_15", "xs_rank_vol_ratio", "xs_rank_rvol",
      "universe_mean_ret_5", "ret_resid_5", "xs_zscore_ret_5"]
FEATS = OWN + XS
PARAMS = dict(objective="binary", n_estimators=350, learning_rate=0.03, num_leaves=31,
              subsample=0.8, colsample_bytree=0.8, min_child_samples=300, reg_lambda=1.0,
              n_jobs=-1, verbose=-1)


def auc(y, p):
    y = np.asarray(y); m = np.isfinite(y) & np.isfinite(p)
    if m.sum() < 50 or len(np.unique(y[m])) < 2:
        return float("nan")
    return roc_auc_score(y[m], p[m])


def main():
    df = pd.read_parquet(DS)
    max_day = df["day_idx"].max()
    test_day_start = max_day - TEST_DAYS + 1
    is_hold_stock = df["stock"].isin(HOLDOUT_STOCKS)
    is_test_day = df["day_idx"] >= test_day_start

    m_train = (~is_hold_stock) & (~is_test_day)
    quads = {
        "train (in-sample)":       m_train,
        "unseen-day (seen stk)":   (~is_hold_stock) & is_test_day,
        "unseen-stk (seen day)":   is_hold_stock & (~is_test_day),
        "unseen x unseen":         is_hold_stock & is_test_day,
    }
    print(f"holdout stocks={HOLDOUT_STOCKS}  test days=last {TEST_DAYS} "
          f"({df.loc[is_test_day,'day'].min()}..{df.loc[is_test_day,'day'].max()})")
    print(f"train rows={m_train.sum():,}  unseenxunseen rows={quads['unseen x unseen'].sum():,}\n")

    models = {}
    for horizon in ["dir_1", "dir_10", "dir_30"]:
        for use_id in (True, False):
            cols = FEATS + (["stock_id"] if use_id else [])
            hv = df[horizon].notna()
            tr = df[m_train & hv]
            model = lgb.LGBMClassifier(**PARAMS)
            model.fit(tr[cols], tr[horizon].astype(int),
                      categorical_feature=(["stock_id"] if use_id else "auto"))
            models[(horizon, use_id)] = model
            row = [f"{horizon} {'+id' if use_id else 'no-id'}"]
            for qn, qm in quads.items():
                sub = df[qm & hv]
                p = model.predict_proba(sub[cols])[:, 1]
                row.append(auc(sub[horizon].values, p))
            print("  {:16} | ".format(row[0]) +
                  " | ".join(f"{q}={v:.3f}" for q, v in zip(quads, row[1:])))
        print()

    # save unseen x unseen predictions (dir_30-valid base -> all fwd rets exist)
    uu = df[quads["unseen x unseen"] & df["dir_30"].notna()].copy()
    cols_id = FEATS + ["stock_id"]
    for h in ("dir_1", "dir_10", "dir_30"):
        uu[f"prob_{h.split('_')[1]}"] = models[(h, True)].predict_proba(uu[cols_id])[:, 1]
    os.makedirs(os.path.dirname(PRED), exist_ok=True)
    uu[["timestamp", "stock", "day", "close", "fwd_ret_1", "fwd_ret_10", "fwd_ret_30",
        "prob_1", "prob_10", "prob_30"]].to_parquet(PRED)
    print(f"Saved unseen-x-unseen predictions -> {PRED}  ({len(uu):,} rows)")


if __name__ == "__main__":
    main()
