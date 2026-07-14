"""build_daily_dataset.py — Phase-0b swing spike: daily features + N-day labels.

Reads the per-stock 5yr DAILY CSVs, computes daily momentum/vol/volume features
+ CROSS-SECTIONAL (per-day, across the universe) relative-strength features, and
forward N-day return labels (1d / 5d / 10d, close-to-close — swing holds overnight).
Pools all stocks -> data/research/stock_spike/daily_dataset.parquet.
"""
import glob
import os
import numpy as np
import pandas as pd

ROOT = r"C:\Users\Admin\ai-development\ai-development"
DAILY = os.path.join(ROOT, "data", "research", "stock_spike", "daily")
OUT = os.path.join(ROOT, "data", "research", "stock_spike", "daily_dataset.parquet")
IST = 19800

OWN = ["ret_1", "ret_5", "ret_10", "ret_20", "ret_60", "rvol_20", "vol_ratio",
       "rsi_14", "dist_ma20", "dist_ma50", "dist_hi_252", "ret_norm"]
XS = ["xs_rank_ret_5", "xs_rank_ret_20", "xs_rank_ret_60", "xs_rank_vol_ratio",
      "universe_mean_ret_1", "ret_resid_1", "xs_zscore_ret_20"]
FEATURES = OWN + XS


def rsi(c, n=14):
    d = c.diff()
    up = d.clip(lower=0).rolling(n, min_periods=n // 2).mean()
    dn = (-d.clip(upper=0)).rolling(n, min_periods=n // 2).mean()
    return 100.0 - 100.0 / (1.0 + up / (dn + 1e-12))


def build_stock(sym, path):
    df = pd.read_csv(path).sort_values("timestamp").reset_index(drop=True)
    df["stock"] = sym
    df["date"] = pd.to_datetime(df["timestamp"] + IST, unit="s").dt.strftime("%Y-%m-%d")
    c, v = df["close"], df["volume"]
    for n in (1, 5, 10, 20, 60):
        df[f"ret_{n}"] = c.pct_change(n)
    df["rvol_20"] = df["ret_1"].rolling(20, min_periods=10).std()
    df["vol_ratio"] = v / v.rolling(20, min_periods=10).mean()
    df["rsi_14"] = rsi(c, 14)
    df["dist_ma20"] = c / c.rolling(20, min_periods=10).mean() - 1.0
    df["dist_ma50"] = c / c.rolling(50, min_periods=25).mean() - 1.0
    df["dist_hi_252"] = c / c.rolling(252, min_periods=60).max() - 1.0
    df["ret_norm"] = df["ret_20"] / (df["rvol_20"] + 1e-9)
    # forward N-day labels (close-to-close; swing holds overnight)
    for n in (1, 5, 10):
        df[f"fwd_ret_{n}"] = c.shift(-n) / c - 1.0
    return df


def main():
    files = sorted(glob.glob(os.path.join(DAILY, "*.csv")))
    frames = []
    for sid, f in enumerate(files):
        sym = os.path.basename(f).replace(".csv", "")
        d = build_stock(sym, f)
        d["stock_id"] = sid
        frames.append(d)
    a = pd.concat(frames, ignore_index=True)

    # ── cross-sectional, per trading day across the universe ──
    gd = a.groupby("date")
    a["universe_size"] = gd["ret_1"].transform("count")
    a["xs_rank_ret_5"] = gd["ret_5"].rank(pct=True)
    a["xs_rank_ret_20"] = gd["ret_20"].rank(pct=True)
    a["xs_rank_ret_60"] = gd["ret_60"].rank(pct=True)
    a["xs_rank_vol_ratio"] = gd["vol_ratio"].rank(pct=True)
    u1 = gd["ret_1"].transform("mean")
    a["universe_mean_ret_1"] = u1
    a["ret_resid_1"] = a["ret_1"] - u1
    m20, s20 = gd["ret_20"].transform("mean"), gd["ret_20"].transform("std")
    a["xs_zscore_ret_20"] = (a["ret_20"] - m20) / (s20 + 1e-12)

    for n in (1, 5, 10):
        a[f"dir_{n}"] = np.where(a[f"fwd_ret_{n}"].isna(), np.nan, (a[f"fwd_ret_{n}"] > 0).astype("float64"))

    a = a[a["universe_size"] >= 20].copy()
    days = sorted(a["date"].unique())
    a["date_idx"] = a["date"].map({d: i for i, d in enumerate(days)})

    keep = (FEATURES + ["stock_id", "dir_1", "dir_5", "dir_10",
                        "fwd_ret_1", "fwd_ret_5", "fwd_ret_10",
                        "date", "date_idx", "stock", "close"])
    out = a[keep].dropna(subset=FEATURES).reset_index(drop=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out.to_parquet(OUT)
    print(f"Wrote {OUT}")
    print(f"  rows={len(out):,}  stocks={out['stock'].nunique()}  days={out['date'].nunique()} "
          f"({days[0]}..{days[-1]})  features={len(FEATURES)}")
    print(f"  up-rate dir_1={out['dir_1'].mean():.3f} dir_5={out['dir_5'].mean():.3f} dir_10={out['dir_10'].mean():.3f}")


if __name__ == "__main__":
    main()
