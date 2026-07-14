"""train_daily.py — Phase-0b swing spike: pooled cross-sectional daily model.

Pooled LightGBM over all stocks, per swing horizon (1d / 5d / 10d), validated on
held-out STOCKS x held-out DAYS (the decisive generalization test) + a
no-stock_id ablation. Saves unseen x unseen predictions for the cost backtest.
"""
import os
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

ROOT = r"C:\Users\Admin\ai-development\ai-development"
DS = os.path.join(ROOT, "data", "research", "stock_spike", "daily_dataset.parquet")
PRED = os.path.join(ROOT, "data", "research", "stock_spike", "out", "daily_predictions.parquet")

HOLDOUT_STOCKS = ["ICICIBANK", "PFC", "IRCTC", "INFY", "MARUTI",
                  "SUNPHARMA", "NTPC", "TITAN", "JSWSTEEL", "DLF"]
TEST_DAYS = 150   # ~7 months held out at the end
OWN = ["ret_1", "ret_5", "ret_10", "ret_20", "ret_60", "rvol_20", "vol_ratio",
       "rsi_14", "dist_ma20", "dist_ma50", "dist_hi_252", "ret_norm"]
XS = ["xs_rank_ret_5", "xs_rank_ret_20", "xs_rank_ret_60", "xs_rank_vol_ratio",
      "universe_mean_ret_1", "ret_resid_1", "xs_zscore_ret_20"]
FEATS = OWN + XS
PARAMS = dict(objective="binary", n_estimators=400, learning_rate=0.02, num_leaves=31,
              subsample=0.8, colsample_bytree=0.8, min_child_samples=200, reg_lambda=1.0,
              n_jobs=-1, verbose=-1)


def auc(y, p):
    y = np.asarray(y); m = np.isfinite(y) & np.isfinite(p)
    if m.sum() < 50 or len(np.unique(y[m])) < 2:
        return float("nan")
    return roc_auc_score(y[m], p[m])


def main():
    df = pd.read_parquet(DS)
    max_day = df["date_idx"].max()
    test_start = max_day - TEST_DAYS + 1
    hold = df["stock"].isin(HOLDOUT_STOCKS)
    testd = df["date_idx"] >= test_start
    m_train = (~hold) & (~testd)
    quads = {
        "train":                 m_train,
        "unseen-day (seen stk)": (~hold) & testd,
        "unseen-stk (seen day)": hold & (~testd),
        "unseen x unseen":       hold & testd,
    }
    print(f"holdout stocks={len(HOLDOUT_STOCKS)}  test days=last {TEST_DAYS} "
          f"({df.loc[testd,'date'].min()}..{df.loc[testd,'date'].max()})")
    print(f"train rows={m_train.sum():,}  unseenxunseen rows={quads['unseen x unseen'].sum():,}\n")

    models = {}
    for h in ["dir_1", "dir_5", "dir_10"]:
        for use_id in (True, False):
            cols = FEATS + (["stock_id"] if use_id else [])
            hv = df[h].notna()
            tr = df[m_train & hv]
            model = lgb.LGBMClassifier(**PARAMS)
            model.fit(tr[cols], tr[h].astype(int),
                      categorical_feature=(["stock_id"] if use_id else "auto"))
            models[(h, use_id)] = model
            row = [f"{h} {'+id' if use_id else 'no-id'}"]
            for qn, qm in quads.items():
                sub = df[qm & hv]
                row.append(auc(sub[h].values, model.predict_proba(sub[cols])[:, 1]))
            print("  {:14} | ".format(row[0]) +
                  " | ".join(f"{q}={v:.3f}" for q, v in zip(quads, row[1:])))
        print()

    uu = df[quads["unseen x unseen"] & df["dir_10"].notna()].copy()
    cols_id = FEATS + ["stock_id"]
    for h in ("dir_1", "dir_5", "dir_10"):
        uu[f"prob_{h.split('_')[1]}"] = models[(h, True)].predict_proba(uu[cols_id])[:, 1]
    os.makedirs(os.path.dirname(PRED), exist_ok=True)
    uu[["date", "stock", "close", "fwd_ret_1", "fwd_ret_5", "fwd_ret_10",
        "prob_1", "prob_5", "prob_10"]].to_parquet(PRED)
    print(f"Saved unseen-x-unseen predictions -> {PRED}  ({len(uu):,} rows)")


if __name__ == "__main__":
    main()
