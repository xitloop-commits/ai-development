# Backtest findings — banknifty/nifty50 OOS, 2026-07-06

**One line:** the retrained model calls **direction well (62–72% OOS, both ways)**, but
**no option-*buying* strategy we tested monetizes it in a way that generalizes** — the one
config that looked great on banknifty (**+₹312k, 7/8 days**) **lost on nifty50 (−₹307k, 0/8)**,
i.e. it was overfit to 8 days of one instrument. **Nothing here is safe to deploy yet.**

## Data
OOS = the retrained models' held-out fold: **3 val days (06-17/18/19)** + **5 calibration
days (06-22, 06-30, 07-01/02/03)** = 8 days. Models trained only on ≤ 06-16. These are OOS
for weights (val used for early-stop, cal for isotonic fit — not truly virgin, but the best
we have). Both instruments re-replayed with the v12 pivot schema + de-leak + Part B.

## Bugs found & fixed (the backtest's biggest value)
1. **Gate `MISSING_PREDICTION`** (`9b34c63`) — the de-leak serves `upside_percentile_60s`
   LAGGED → NaN ~64% of the session; the wave2 gate required it finite → **0 signals**
   (21,070/34k rows on 06-22). Fix: it's a quality filter (C3), not a core input — require
   only direction+RR finite. *This is almost certainly why live signals "stopped."*
2. **sim-PnL columns** (`b271bc1`) — looked for `opt_atm_*_bid/ask`; emitted name is
   `opt_0_*` → training sim-PnL always SKIPPED, promotion scorecard empty.
3. **Backtest 0-puts** (`351f890`) — `backtest_scored.py` fed the gate CE-leg heads only,
   omitting the Part B PE-leg heads → every put WAIT'd. After the fix, puts fire with
   balanced precision (e.g. 06-30: 548 CE + 742 PE, ~62% each). The live engine was fine;
   this was a harness gap.

## What's validated (the asset)
- Direction precision **62–72% OOS, both directions, both instruments.** The Part B
  down-heads work; de-leak held (`direction_60s` at an honest ~0.66, not the inflated ~0.77).
- The v12 pivot feature ranks **#7–9 / 482** on the scalp direction head.

## What does NOT work: buying options
Realistic fills throughout (enter@ask, exit@bid, ₹125 round-trip charges; banknifty lot 30,
nifty50 lot 75).

- **Naive 60s scalp:** banknifty **−₹1.6M / 5 days**, nifty50 −₹1.5M. Every day negative.
- **Decomposition:** the signals are **premium-anti-predictive** — buying loses **−₹116/trade
  at the *mid*, before any cost** (direction is right on *spot*, but the premium has already
  moved; you're buying the spike and it fades). Spread (~₹55) + charges (₹125) pile on → −₹297.
- **Selectivity** (conviction / magnitude / RR, top 5–50%): **no profitable subset** (best −₹206).
- **Trend-alignment, cooldown, structure-TP/SL, buildup-veto:** none rescue it — they *select*
  or change the *exit*, but can't fix a negative-before-costs edge. Tested with all three
  wired into the gate (structure_tp_sl + buildup_filter + real calibrated trend-align, 8 days):
  naive buy still **−₹2.58M**; pullback +₹266k ≈ trend-align alone → the two OFF filters
  (`structure_tp_sl`, `buildup_filter`) **add essentially nothing** — leaving them off is correct.
  (Note: real `apply_trend_alignment` on *calibrated* trend rarely clears 0.55, so it barely bites.)
- **Trend cohort (30-min):** too sparse (11 trades / 5 days, 0 on 3 days) + broken tight-TP.

## The pullback strategy — looked great, then failed the generalization test
Waiting for a **pullback** before buying flips the gross edge positive (you stop buying the
spike). Best banknifty config: **5% pullback limit + trend-aligned + ~2-min hold + −₹20k
daily stop** → **+₹312k over 8 days, 7/8 days positive, +₹183/trade, worst day −₹22k.**

**But the SAME config on nifty50: −₹307k, 0/8 days, −₹113/trade.** A real structural edge
would transfer to the mirror instrument; it does the opposite → the banknifty result was
**overfit to 8 days of one instrument.** Single-instrument robustness (7/8 days) fooled us;
the cross-instrument test caught it. **Cross-instrument agreement is now a hard gate on any
backtest claim.**

## Sell side (noted, not pursued)
The flip — **selling** the (faded) signal, ~30-min hold — was positive on banknifty
(+₹108/trade, 54% win, worst single trade only −₹1,883 because the short hold caps gamma).
Not pursued (operator chose the buy side; selling adds margin + correlated-tail + defined-risk
design). Left here as a lead, **also unvalidated across instruments.**

## Conclusion
- The model is good; **we have not found a generalizable way to monetize it.**
- **8 days is far too little** to isolate a weak edge from noise — every config tuned on it
  produces instrument-specific mirages.
- More backtesting on these 8 days will keep overfitting.

## Next steps (the only honest path)
1. **Forward paper-test at zero/tiny size** to accumulate real OOS days (both instruments).
2. Gather **many more OOS days** (or reserve a multi-week holdout + re-test) before trusting any config.
3. **Never accept a single-instrument backtest result** — require it to hold on the other instrument.

## Method / tooling (reproduce)
Gate signals via `backtest_scored.py <inst> <date>` (W4/`breakout_in_60s_min`=0 to fire).
Realistic-fill PnL sims (pullback entry, TP/SL vs time-stop exit, per-leg decomposition,
selectivity grid, daily-stop, cross-instrument) were run as standalone numpy scripts over the
per-day `signals.ndjson` + the parquet `opt_0_*_bid/ask`. Rank by **days-positive**, not raw PnL.
