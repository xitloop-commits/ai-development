"""Overnight GAP model — predict next-day gap up/down from what we HAVE
(Partha 2026-09-08: no external history; train on our recorded days).

One sample per recorded day: end-of-day features from the day's dataset
parquet (spot path, PCR, ATM IV, expiry distance, day-of-week) → target =
sign of tomorrow's opening gap (first spot of next recorded day vs today's
last spot). Walk-forward: expanding window, predict one day ahead.

HONESTY: ~70 samples is tiny for a daily model. The report prints the
out-of-sample hit rate with its uncertainty — if it isn't clearly above
50%, the verdict is NOT TRADEABLE and no hold rule gets built on it.

Run:  python -m blast_model.gap_model
"""
from __future__ import annotations

import glob
import os

from .config import BlastConfig
from .raw_reader import _ROOT

MIN_TRAIN = 30


def _day_features():
    import pandas as pd

    cfg = BlastConfig()
    files = sorted(glob.glob(os.path.join(_ROOT, cfg.out_dir, f"*_{cfg.label_tag()}.parquet")))
    days = []
    for f in files:
        df = pd.read_parquet(f, columns=["date", "ts", "spot", "pcr", "atm_iv", "tte_years", "fut_ret_5m"])
        df = df.drop_duplicates("ts").sort_values("ts")
        if len(df) < 100:      # partial day (recorder down) — unusable sample
            continue
        spot = df["spot"]
        first, last = spot.iloc[0], spot.iloc[-1]
        hi, lo = spot.max(), spot.min()
        last_hr = spot.iloc[-60:] if len(spot) >= 60 else spot
        d = {
            "date": df["date"].iloc[0],
            "close_spot": last,
            "day_ret": (last - first) / first,
            "last_hr_ret": (last_hr.iloc[-1] - last_hr.iloc[0]) / last_hr.iloc[0],
            "close_in_range": (last - lo) / (hi - lo) if hi > lo else 0.5,
            "range_pct": (hi - lo) / last,
            "pcr_close": df["pcr"].iloc[-1],
            "pcr_change": df["pcr"].iloc[-1] - df["pcr"].iloc[0],
            "iv_close": df["atm_iv"].iloc[-1],
            "iv_change": df["atm_iv"].iloc[-1] - df["atm_iv"].iloc[0],
            "is_expiry": float(df["tte_years"].iloc[-1] < 1.5 / 365),
            "dow": pd.Timestamp(df["date"].iloc[0]).dayofweek,
        }
        days.append(d)
    out = pd.DataFrame(days).sort_values("date").reset_index(drop=True)
    # Target: tomorrow's opening gap vs today's close (consecutive recorded days
    # only — a multi-day hole makes the "overnight" claim false, drop those).
    opens = {}
    for f in files:
        df = pd.read_parquet(f, columns=["date", "ts", "spot"]).sort_values("ts")
        if len(df):
            opens[df["date"].iloc[0]] = df["spot"].iloc[0]
    gaps, ok = [], []
    dates = list(out["date"])
    for i, d in enumerate(dates):
        nxt = dates[i + 1] if i + 1 < len(dates) else None
        gap_days = (pd.Timestamp(nxt) - pd.Timestamp(d)).days if nxt else 99
        if nxt and gap_days <= 3 and nxt in opens:   # weekend ok, holes not
            gaps.append((opens[nxt] - out["close_spot"].iloc[i]) / out["close_spot"].iloc[i])
            ok.append(True)
        else:
            gaps.append(float("nan"))
            ok.append(False)
        del gap_days
    out["gap_next"] = gaps
    return out[pd.notna(out["gap_next"])].reset_index(drop=True)


def main() -> None:
    import numpy as np
    import lightgbm as lgb

    df = _day_features()
    feats = [c for c in df.columns if c not in ("date", "close_spot", "gap_next")]
    y = (df["gap_next"] > 0).astype(int)
    print(f"samples: {len(df)} days | gap-up rate {y.mean():.0%} | "
          f"median |gap| {df['gap_next'].abs().median() * 100:.2f}%")
    hits, preds = [], []
    for i in range(MIN_TRAIN, len(df)):
        m = lgb.LGBMClassifier(n_estimators=120, learning_rate=0.08, num_leaves=7,
                               min_child_samples=8, verbose=-1)
        m.fit(df[feats].iloc[:i], y.iloc[:i])
        p = float(m.predict_proba(df[feats].iloc[[i]])[0, 1])
        preds.append(p)
        hits.append(int((p >= 0.5) == bool(y.iloc[i])))
    hits = np.array(hits)
    n = len(hits)
    acc = hits.mean()
    se = (acc * (1 - acc) / n) ** 0.5
    print(f"walk-forward OOS: {n} predictions | hit rate {acc:.0%} ± {se * 100:.0f}% "
          f"(chance = {max(y.mean(), 1 - y.mean()):.0%} by always guessing the majority)")
    conf = [(p, h) for p, h in zip(preds, hits) if abs(p - 0.5) > 0.15]
    if conf:
        print(f"confident calls (|p-0.5|>0.15): {len(conf)}, hit rate "
              f"{np.mean([h for _, h in conf]):.0%}")
    verdict = "POSSIBLY USEFUL — needs more days before any hold rule" if acc - 2 * se > 0.5 \
        else "NOT TRADEABLE yet — indistinguishable from coin flip at this sample size"
    print("VERDICT:", verdict)


if __name__ == "__main__":
    main()
