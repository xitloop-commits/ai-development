"""build_dataset.py — Phase-0 stock spike: features + labels -> pooled parquet.

Reads the per-stock 1-min CSVs, computes stock-RELATIVE own-series features and
CROSS-SECTIONAL (per-timestamp, across the universe) features + within-session
forward-return labels, pools all stocks into one frame, and writes
data/research/stock_spike/dataset.parquet.

Everything is within-session (no overnight leakage): returns/labels reset per day.
"""
import glob
import os
import numpy as np
import pandas as pd

ROOT = r"C:\Users\Admin\ai-development\ai-development"
CAND = os.path.join(ROOT, "data", "research", "stock_spike", "candles")
OUT = os.path.join(ROOT, "data", "research", "stock_spike", "dataset.parquet")
IST = 19800
H10 = 10                       # the ~10-min intraday horizon
MIN_UNIVERSE = 6               # drop timestamps with fewer stocks present

OWN_FEATURES = [
    "ret_1", "ret_5", "ret_15", "ret_30", "rvol_20", "vol_ratio", "rsi_14",
    "vwap_dist", "range_pct", "dist_from_open", "accel", "ret_norm", "min_since_open",
]
XS_FEATURES = [
    "xs_rank_ret_5", "xs_rank_ret_15", "xs_rank_vol_ratio", "xs_rank_rvol",
    "universe_mean_ret_5", "ret_resid_5", "xs_zscore_ret_5",
]
FEATURES = OWN_FEATURES + XS_FEATURES  # stock_id kept separate (toggleable in trainer)


def rsi(c: pd.Series, n: int = 14) -> pd.Series:
    d = c.diff()
    up = d.clip(lower=0).rolling(n, min_periods=n // 2).mean()
    dn = (-d.clip(upper=0)).rolling(n, min_periods=n // 2).mean()
    return 100.0 - 100.0 / (1.0 + up / (dn + 1e-12))


def build_stock(sym: str, path: str) -> pd.DataFrame:
    df = pd.read_csv(path).sort_values("timestamp").reset_index(drop=True)
    df["stock"] = sym
    df["dt"] = pd.to_datetime(df["timestamp"] + IST, unit="s")
    df["day"] = df["dt"].dt.strftime("%Y-%m-%d")
    parts = []
    for _, g in df.groupby("day", sort=True):
        g = g.copy()
        c, v, h, l, o = g["close"], g["volume"], g["high"], g["low"], g["open"]
        g["ret_1"] = c.pct_change(1)
        g["ret_5"] = c.pct_change(5)
        g["ret_15"] = c.pct_change(15)
        g["ret_30"] = c.pct_change(30)
        g["rvol_20"] = g["ret_1"].rolling(20, min_periods=10).std()
        g["vol_ratio"] = v / v.rolling(20, min_periods=5).mean()
        g["rsi_14"] = rsi(c, 14)
        tp = (h + l + c) / 3.0
        vwap = (tp * v).cumsum() / v.cumsum().replace(0, np.nan)
        g["vwap_dist"] = (c - vwap) / vwap
        g["range_pct"] = (h - l) / c
        g["dist_from_open"] = (c - o.iloc[0]) / o.iloc[0]
        g["accel"] = g["ret_5"] - g["ret_30"]
        g["ret_norm"] = g["ret_5"] / (g["rvol_20"] + 1e-9)
        g["min_since_open"] = np.arange(len(g), dtype="float64")
        # within-session forward-return labels
        g["fwd_ret_1"] = c.shift(-1) / c - 1.0
        g["fwd_ret_10"] = c.shift(-H10) / c - 1.0
        g["fwd_ret_30"] = c.shift(-30) / c - 1.0
        parts.append(g)
    return pd.concat(parts, ignore_index=True)


def main() -> None:
    files = sorted(glob.glob(os.path.join(CAND, "*_1m.csv")))
    syms = [os.path.basename(f).replace("_1m.csv", "") for f in files]
    frames = []
    for sid, (sym, f) in enumerate(zip(syms, files)):
        d = build_stock(sym, f)
        d["stock_id"] = sid
        frames.append(d)
        print(f"  {sym:10} {len(d):>6} rows")
    a = pd.concat(frames, ignore_index=True)

    # ── cross-sectional, per timestamp across the universe ──
    gt = a.groupby("timestamp")
    a["universe_size"] = gt["ret_5"].transform("count")
    a["xs_rank_ret_5"] = gt["ret_5"].rank(pct=True)
    a["xs_rank_ret_15"] = gt["ret_15"].rank(pct=True)
    a["xs_rank_vol_ratio"] = gt["vol_ratio"].rank(pct=True)
    a["xs_rank_rvol"] = gt["rvol_20"].rank(pct=True)
    u_mean = gt["ret_5"].transform("mean")
    u_std = gt["ret_5"].transform("std")
    a["universe_mean_ret_5"] = u_mean
    a["ret_resid_5"] = a["ret_5"] - u_mean
    a["xs_zscore_ret_5"] = (a["ret_5"] - u_mean) / (u_std + 1e-12)

    # binary direction labels (NaN where no forward bar within the session)
    a["dir_1"] = np.where(a["fwd_ret_1"].isna(), np.nan, (a["fwd_ret_1"] > 0).astype("float64"))
    a["dir_10"] = np.where(a["fwd_ret_10"].isna(), np.nan, (a["fwd_ret_10"] > 0).astype("float64"))
    a["dir_30"] = np.where(a["fwd_ret_30"].isna(), np.nan, (a["fwd_ret_30"] > 0).astype("float64"))

    # min-universe guard + day index for splitting
    a = a[a["universe_size"] >= MIN_UNIVERSE].copy()
    days = sorted(a["day"].unique())
    a["day_idx"] = a["day"].map({d: i for i, d in enumerate(days)})

    keep_cols = (FEATURES + ["stock_id", "dir_1", "dir_10", "dir_30",
                             "fwd_ret_1", "fwd_ret_10", "fwd_ret_30",
                             "day", "day_idx", "stock", "timestamp", "close"])
    out = a[keep_cols].dropna(subset=FEATURES).reset_index(drop=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out.to_parquet(OUT)
    print(f"\nWrote {OUT}")
    print(f"  rows={len(out):,}  stocks={out['stock'].nunique()}  days={out['day'].nunique()} "
          f"({days[0]}..{days[-1]})  features={len(FEATURES)}")
    print(f"  dir_10 up-rate={out['dir_10'].mean():.3f}  dir_1 up-rate={out['dir_1'].mean():.3f}")


if __name__ == "__main__":
    main()
