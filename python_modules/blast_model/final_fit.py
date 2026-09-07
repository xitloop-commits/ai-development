"""Fit the FINAL enter/exit heads on ALL recorded days at the locked label
(+8% within 5 min, from the 2026-09-07 label sweep) and save artifacts for
the live paper runner.

Run:  python -m blast_model.final_fit [--blast-pct 0.08] [--window-min 5]
Artifacts -> models/blast_model/nifty50/{enter,exit}_<tag>.lgbm + features_<tag>.json
"""
from __future__ import annotations

import argparse
import json
import os

from .config import BlastConfig
from .label_sweep import _load_all, relabel
from .raw_reader import _ROOT
from .train import _fit


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--blast-pct", type=float, default=0.08)
    ap.add_argument("--window-min", type=int, default=5)
    args = ap.parse_args()
    tag = f"b{int(args.blast_pct * 100)}w{args.window_min}"
    cfg = BlastConfig()
    df, feats, candles, idx = _load_all(cfg)
    df = relabel(df, candles, idx, args.blast_pct, args.window_min)
    lab = df["label_enter"].dropna()
    print(f"data: {df['date'].nunique()} days, {len(df):,} rows, "
          f"label {tag} rate {lab.mean():.1%}")
    out = os.path.join(_ROOT, "models", "blast_model", cfg.instrument)
    os.makedirs(out, exist_ok=True)
    for label, name in (("label_enter", "enter"), ("label_exit", "exit")):
        m = _fit(df, feats, label)
        m.booster_.save_model(os.path.join(out, f"{name}_{tag}.lgbm"))
        imp = sorted(zip(feats, m.feature_importances_), key=lambda x: -x[1])[:8]
        print(f"{name}: top {', '.join(k for k, _ in imp)}")
    with open(os.path.join(out, f"features_{tag}.json"), "w", encoding="utf-8") as f:
        json.dump({"features": feats, "label_tag": tag,
                   "blast_pct": args.blast_pct, "window_min": args.window_min,
                   "days": sorted(df["date"].unique().tolist())}, f, indent=1)
    print(f"saved -> {out}")


if __name__ == "__main__":
    main()
