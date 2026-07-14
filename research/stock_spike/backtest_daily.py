"""backtest_daily.py — Phase-0b swing spike: post-cost tradability.

On the UNSEEN x UNSEEN daily predictions. LONG-ONLY (realistic for cash delivery)
is primary; LONG-SHORT shown for comparison (shorts need F&O overnight). Delivery
round-trip cost is bigger than intraday (STT 0.1% both legs + charges ~= 20-30 bps)
but a multi-day move is 100s of bps, so the ratio is what matters.

Per-signal expectancy (edge measure). Overlap caveat: consecutive days open new
N-day trades — fine for measuring edge sign, a portfolio concern later.
"""
import os
import numpy as np
import pandas as pd

ROOT = r"C:\Users\Admin\ai-development\ai-development"
PRED = os.path.join(ROOT, "data", "research", "stock_spike", "out", "daily_predictions.parquet")
THRESHOLDS = [0.52, 0.55, 0.58, 0.60, 0.63]
COSTS_BPS = [15, 25, 40]     # delivery round-trip
REALISTIC = 25


def main():
    df = pd.read_parquet(PRED)
    print(f"unseen x unseen daily predictions: {len(df):,} rows, "
          f"{df['stock'].nunique()} stocks, {df['date'].nunique()} days\n")

    for hz, pc, fc in [("1d", "prob_1", "fwd_ret_1"), ("5d", "prob_5", "fwd_ret_5"),
                       ("10d", "prob_10", "fwd_ret_10")]:
        print(f"=== {hz} horizon ===")
        p, fwd = df[pc].values, df[fc].values
        # LONG-ONLY sweep
        print(f"  LONG-ONLY   {'thr':>5} {'trades':>7} {'gross_bps':>10} | " +
              " ".join(f"net@{c}".rjust(8) for c in COSTS_BPS) + f"  {'hit%':>5}")
        best = None
        for thr in THRESHOLDS:
            m = (p > thr) & np.isfinite(fwd)
            if m.sum() < 30:
                continue
            g = fwd[m]
            gbps = g.mean() * 1e4
            nets = [(g - c / 1e4).mean() * 1e4 for c in COSTS_BPS]
            hit = ((g - REALISTIC / 1e4) > 0).mean() * 100
            print(f"  {'':11} {thr:>5.2f} {m.sum():>7} {gbps:>10.1f} | " +
                  " ".join(f"{n:>8.1f}" for n in nets) + f"  {hit:>4.0f}%")
            real = (g - REALISTIC / 1e4).mean() * 1e4
            if best is None or real > best[1]:
                best = (thr, real, m)
        # LONG-SHORT (needs F&O) at a mid threshold, realistic cost
        thr_ls = 0.55
        long_m, short_m = (p > thr_ls), (p < 1 - thr_ls)
        gls = np.where(long_m, fwd, np.where(short_m, -fwd, np.nan))
        mls = np.isfinite(gls)
        ls_net = (gls[mls] - REALISTIC / 1e4).mean() * 1e4
        print(f"  LONG-SHORT (F&O) thr={thr_ls}: net/trade={ls_net:+.1f} bps  trades={mls.sum()} @ {REALISTIC}bps")
        # breakdown of best long-only config
        if best:
            thr, exp, m = best
            g = fwd[m]; net = g - REALISTIC / 1e4
            stk = df.loc[m, "stock"].values; day = df.loc[m, "date"].values
            print(f"  >> best LONG-ONLY thr={thr:.2f}  net/trade={exp:+.1f} bps  "
                  f"hit={(net>0).mean()*100:.0f}%  trades={m.sum()} @ {REALISTIC}bps")
            ps = pd.Series(net, index=stk).groupby(level=0).mean() * 1e4
            pd_ = pd.Series(net, index=day).groupby(level=0).mean() * 1e4
            print(f"     per-stock net bps: " + " ".join(f"{s}={v:+.0f}" for s, v in ps.items()))
            print(f"     positive stocks: {(ps>0).sum()}/{len(ps)}  positive days: {(pd_>0).sum()}/{len(pd_)}")
        print()


if __name__ == "__main__":
    main()
