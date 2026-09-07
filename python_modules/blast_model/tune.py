"""Formal param sweep + tune (build-order step 5) — the honest protocol:

  TUNE window  = the earlier OOS days: the grid is ranked here.
  JUDGE window = the last N OOS days (default 15): the single tune-window
                 winner is then scored here, untouched — that number is the
                 verdict. The runner-ups' judge scores are shown only for
                 transparency, never for selection.

Grid: enter/exit confidence floors x max-hold x HH+HL gate x side filter.
(Label-threshold variants sweep separately — they need dataset rebuilds.)

Run:  python -m blast_model.tune [--judge-days 15] [--min-tune-trades 40]
"""
from __future__ import annotations

import argparse
import itertools

from .backtest import build_oos_preds, simulate
from .config import BlastConfig

ENTER_FLOORS = (0.55, 0.60, 0.65, 0.70, 0.75, 0.80)
EXIT_FLOORS = (0.50, 0.60, 0.70)
HOLDS_MIN = (10, 20, 30)
GATES = (True, False)
SIDES = (None, "PE", "CE")
SPREAD = 0.10


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--judge-days", type=int, default=15)
    ap.add_argument("--min-tune-trades", type=int, default=40)
    args = ap.parse_args()

    preds = build_oos_preds(BlastConfig())
    days = sorted(preds["date"].unique())
    if len(days) <= args.judge_days + 10:
        raise SystemExit("not enough OOS days for a tune/judge split")
    judge_days = days[-args.judge_days:]
    tune = preds[~preds["date"].isin(judge_days)]
    judge = preds[preds["date"].isin(judge_days)]
    print(f"TUNE {days[0]}..{days[-args.judge_days-1]} ({len(days)-args.judge_days} days)  "
          f"JUDGE {judge_days[0]}..{judge_days[-1]} ({len(judge_days)} days)\n")

    results = []
    for ef, xf, hold, gate, side in itertools.product(
            ENTER_FLOORS, EXIT_FLOORS, HOLDS_MIN, GATES, SIDES):
        _, s = simulate(tune, ef, xf, hold, SPREAD, require_gate=gate, side_filter=side)
        if s.get("trades", 0) >= args.min_tune_trades:
            results.append((s["net"], s, (ef, xf, hold, gate, side)))
    if not results:
        raise SystemExit("no combo produced enough tune-window trades")
    results.sort(key=lambda x: -x[0])

    print("rank  TUNE-net trades win  ₹/day  worst |  JUDGE-net trades win  ₹/day  worst | combo")
    verdict = None
    for rank, (net, s, combo) in enumerate(results[:8], 1):
        ef, xf, hold, gate, side = combo
        _, j = simulate(judge, ef, xf, hold, SPREAD, require_gate=gate, side_filter=side)
        jn, jt = j.get("net", 0.0), j.get("trades", 0)
        jw = j.get("win_rate", 0.0)
        jpd = j.get("net_per_day", 0.0)
        jworst = j.get("worst_day", 0.0)
        tag = f"e{ef:.2f} x{xf:.2f} h{hold} gate={'Y' if gate else 'N'} side={side or 'both'}"
        print(f"{rank:>4}  {net:8,.0f} {s['trades']:5d} {s['win_rate']:4.0%} {s['net_per_day']:6,.0f} "
              f"{s['worst_day']:6,.0f} | {jn:9,.0f} {jt:5d} {jw:4.0%} {jpd:6,.0f} {jworst:6,.0f} | {tag}")
        if rank == 1:
            verdict = (combo, j)

    combo, j = verdict
    ef, xf, hold, gate, side = combo
    print(f"\nVERDICT (rank-1 combo on untouched judge days): "
          f"NET ₹{j.get('net', 0):,.0f} over {args.judge_days} days, "
          f"{j.get('trades', 0)} trades, win {j.get('win_rate', 0):.0%}, "
          f"per-day ₹{j.get('net_per_day', 0):,.0f}, worst day ₹{j.get('worst_day', 0):,.0f}")
    print(f"locked combo: enter≥{ef}, exit≥{xf}, hold≤{hold}m, "
          f"gate={'on' if gate else 'off'}, side={side or 'both'}")


if __name__ == "__main__":
    main()
