"""backtest_costs.py — Phase-0 stock spike: post-cost tradability of the OOS edge.

Runs on the UNSEEN x UNSEEN predictions (held-out stocks AND days) — the honest
set. For each horizon and confidence threshold: LONG when prob>thr, SHORT when
prob<1-thr, gross = (+/-) forward return, net = gross - round-trip cost (bps).
Reports per-signal EXPECTANCY (the go/no-go metric) across cost levels + a
per-stock/per-day breakdown at a realistic cost.

Caveat: 1-min signals overlap for the 10-min horizon (each minute opens a new
10-min trade) — expectancy-per-signal is still a valid edge measure; capital
deployment is a later concern.
"""
import os
import numpy as np
import pandas as pd

ROOT = r"C:\Users\Admin\ai-development\ai-development"
PRED = os.path.join(ROOT, "data", "research", "stock_spike", "out", "predictions.parquet")
THRESHOLDS = [0.52, 0.55, 0.58, 0.60, 0.62]
COSTS_BPS = [3, 5, 8, 12]          # round-trip: spread + slippage + charges
REALISTIC_BPS = 8


def run(df, prob_col, fwd_col, thr):
    p = df[prob_col].values
    fwd = df[fwd_col].values
    long_m = p > thr
    short_m = p < (1 - thr)
    gross = np.where(long_m, fwd, np.where(short_m, -fwd, np.nan))
    m = np.isfinite(gross)
    return gross[m], df.loc[m, "stock"].values, df.loc[m, "day"].values


def main():
    df = pd.read_parquet(PRED)
    print(f"unseen x unseen predictions: {len(df):,} rows, {df['stock'].nunique()} stocks, "
          f"{df['day'].nunique()} days\n")

    for horizon, prob_col, fwd_col in [("1-min", "prob_1", "fwd_ret_1"),
                                       ("10-min", "prob_10", "fwd_ret_10"),
                                       ("30-min", "prob_30", "fwd_ret_30")]:
        print(f"=== {horizon} horizon ===")
        print(f"{'thr':>5} {'trades':>7} {'gross_bps':>10} | " +
              " ".join(f"net@{c}bps".rjust(9) for c in COSTS_BPS))
        best = None
        for thr in THRESHOLDS:
            gross, _, _ = run(df, prob_col, fwd_col, thr)
            if len(gross) < 50:
                continue
            gbps = gross.mean() * 1e4
            nets = [(gross - c / 1e4).mean() * 1e4 for c in COSTS_BPS]
            print(f"{thr:>5.2f} {len(gross):>7} {gbps:>10.2f} | " +
                  " ".join(f"{n:>9.2f}" for n in nets))
            # track best by net expectancy at realistic cost
            realistic = (gross - REALISTIC_BPS / 1e4).mean() * 1e4
            if best is None or realistic > best[1]:
                best = (thr, realistic, gross)
        # breakdown at the best threshold, realistic cost
        if best:
            thr, exp_bps, gross = best
            g, stk, day = run(df, prob_col, fwd_col, thr)
            net = g - REALISTIC_BPS / 1e4
            print(f"  best thr={thr:.2f}  net/trade={exp_bps:+.2f} bps  "
                  f"hit={(net>0).mean()*100:.1f}%  trades={len(g)}  @ {REALISTIC_BPS}bps cost")
            per_stock = pd.Series(net, index=stk).groupby(level=0).mean() * 1e4
            per_day = pd.Series(net, index=day).groupby(level=0).mean() * 1e4
            print(f"  per-stock net bps: " +
                  " ".join(f"{s}={v:+.1f}" for s, v in per_stock.items()))
            print(f"  positive days: {(per_day > 0).sum()}/{len(per_day)}")
        print()


if __name__ == "__main__":
    main()
