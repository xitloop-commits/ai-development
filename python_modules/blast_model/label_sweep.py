"""Label-threshold sweep (the last axis of build-order step 5).

For each blast definition (+pct within W minutes; drop symmetric) it:
  1. recomputes ENTER/EXIT labels for every feature row from the per-day
     locked-leg 1m candle files (dataset v2) — no raw re-read,
  2. re-runs the day-ordered walk-forward to get OOS predictions,
  3. runs the tune/judge protocol (compact trade-knob grid, ranked on the
     tune window, rank-1 judged on the untouched last N days).
The table's JUDGE column is the only number that counts.

Run:  python -m blast_model.label_sweep [--judge-days 15]
"""
from __future__ import annotations

import argparse
import glob
import itertools
import os

from .backtest import simulate
from .config import BlastConfig
from .labels import blast_labels
from .raw_reader import _ROOT
from .train import DROP_COLS, MIN_LABELED_ROWS_PER_DAY, MIN_TRAIN_DAYS, TEST_CHUNK_DAYS, _fit

VARIANTS = [(p, w) for p in (0.08, 0.10, 0.12) for w in (5, 10, 15)]
ENTER_FLOORS = (0.60, 0.65, 0.70, 0.75)
EXIT_FLOORS = (0.50, 0.60)
HOLDS_MIN = (10, 20, 30)
SIDES = (None, "PE")
SPREAD = 0.10
MIN_TUNE_TRADES = 40


def _load_all(cfg: BlastConfig):
    import pandas as pd
    from .candles import Candle

    out_dir = os.path.join(_ROOT, cfg.out_dir)
    feats_files = sorted(glob.glob(os.path.join(out_dir, f"*_{cfg.label_tag()}.parquet")))
    frames = []
    candles: dict[tuple[str, str], list] = {}
    idx: dict[tuple[str, str], dict[int, int]] = {}
    for f in feats_files:
        date = os.path.basename(f)[:10]
        cf = os.path.join(out_dir, f"{date}_candles1m.parquet")
        if not os.path.exists(cf):
            continue
        df = pd.read_parquet(f)
        if "candle_t" not in df.columns or df["label_enter"].notna().sum() < MIN_LABELED_ROWS_PER_DAY:
            continue
        frames.append(df)
        cdf = pd.read_parquet(cf)
        for side, g in cdf.groupby("side"):
            key = (date, side)
            lst = [Candle(int(r.t), r.open, r.high, r.low, r.close, r.volume)
                   for r in g.sort_values("t").itertuples()]
            candles[key] = lst
            idx[key] = {c.t: i for i, c in enumerate(lst)}
    if not frames:
        raise SystemExit("no v2 dataset files (need *_candles1m.parquet + candle_t) — rebuild first")
    df = pd.concat(frames, ignore_index=True)
    df["is_call"] = (df["side"] == "CE").astype(float)
    feats = [c for c in df.columns
             if c not in DROP_COLS and c != "candle_t" and df[c].dtype.kind in "fiu"]
    return df, feats, candles, idx


def relabel(df, candles, idx, pct: float, window_min: int):
    ent, exi = [], []
    w = window_min * 60
    for r in df.itertuples():
        key = (r.date, r.side)
        lst = candles.get(key)
        i = idx.get(key, {}).get(int(r.candle_t), -1) if lst else -1
        if i < 0:
            ent.append(float("nan")); exi.append(float("nan")); continue
        e, x = blast_labels(lst, i, pct, w, pct, w)
        ent.append(e); exi.append(x)
    df = df.copy()
    df["label_enter"] = ent
    df["label_exit"] = exi
    return df


def oos_preds(df, feats):
    days = sorted(df["date"].unique())
    df = df.copy()
    df["p_enter"] = float("nan")
    df["p_exit"] = float("nan")
    i = MIN_TRAIN_DAYS
    while i < len(days):
        test_days = days[i : i + TEST_CHUNK_DAYS]
        train = df[df["date"] < test_days[0]]
        mask = df["date"].isin(test_days)
        for label, col in (("label_enter", "p_enter"), ("label_exit", "p_exit")):
            if train[label].dropna().nunique() > 1:
                m = _fit(train, feats, label)
                df.loc[mask, col] = m.predict_proba(df.loc[mask, feats])[:, 1]
        i += TEST_CHUNK_DAYS
    return df.dropna(subset=["p_enter"])[
        ["date", "ts", "side", "strike", "premium", "p60s_hh", "p60s_hl", "p_enter", "p_exit"]]


def tune_judge(preds, judge_n: int):
    days = sorted(preds["date"].unique())
    judge_days = days[-judge_n:]
    tune = preds[~preds["date"].isin(judge_days)]
    judge = preds[preds["date"].isin(judge_days)]
    best = None
    for ef, xf, hold, side in itertools.product(ENTER_FLOORS, EXIT_FLOORS, HOLDS_MIN, SIDES):
        _, s = simulate(tune, ef, xf, hold, SPREAD, require_gate=False, side_filter=side)
        if s.get("trades", 0) >= MIN_TUNE_TRADES and (best is None or s["net"] > best[0]):
            best = (s["net"], (ef, xf, hold, side))
    if best is None:
        return None
    tn, combo = best
    _, j = simulate(judge, *combo[:3], SPREAD, require_gate=False, side_filter=combo[3])
    return tn, combo, j


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--judge-days", type=int, default=15)
    args = ap.parse_args()
    cfg = BlastConfig()
    df, feats, candles, idx = _load_all(cfg)
    print(f"data: {df['date'].nunique()} days, {len(df):,} rows, {len(feats)} features\n")
    print("label        rate   TUNE-net  |  JUDGE-net trades win  ₹/day  worst | combo")
    for pct, wmin in VARIANTS:
        d2 = relabel(df, candles, idx, pct, wmin)
        rate = d2["label_enter"].dropna().mean()
        preds = oos_preds(d2, feats)
        r = tune_judge(preds, args.judge_days)
        if r is None:
            print(f"+{pct:.0%}/{wmin:2d}m  {rate:5.1%}   (no combo with enough tune trades)")
            continue
        tn, (ef, xf, hold, side), j = r
        print(f"+{pct:.0%}/{wmin:2d}m  {rate:5.1%} {tn:10,.0f}  | {j.get('net',0):9,.0f} "
              f"{j.get('trades',0):5d} {j.get('win_rate',0):4.0%} {j.get('net_per_day',0):6,.0f} "
              f"{j.get('worst_day',0):6,.0f} | e{ef:.2f} x{xf:.2f} h{hold} side={side or 'both'}")


if __name__ == "__main__":
    main()
