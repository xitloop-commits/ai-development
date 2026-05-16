# Signal System v2 — 8-Layer Master Design

**Status:** SKELETON (skeleton pass — 8 short sections; per-layer deep dives produced separately)
**Date:** 2026-05-16
**Companion docs:** [TARGET_SPEC_V2_DESIGN.md](TARGET_SPEC_V2_DESIGN.md) (covers Layers 1-3 in detail)
**Per-layer deep dives (to come, one per session):** `docs/GATE_LOGIC_DESIGN.md`, `docs/TRADE_MGMT_DESIGN.md`, `docs/RISK_CONTROLS_DESIGN.md`, `docs/POSITION_SIZING_DESIGN.md`, `docs/REGIME_META_DESIGN.md`.

## Locked constraints (do not re-litigate)

- Trades must live MINUTES (>5 min hold).
- Noise floor for nifty50 ≈ 8 pts; TP ≥25 pts, SL ≥15 pts.
- Real trends visible only at 10-30 min horizons.
- LightGBM stays — no transformer/LSTM pivot this iteration.
- Wave 2 scalp model stays as a **backup** signal layer (do not delete).
- Holdout-protected validation, ≥30 sessions before retrain.

## The 8 layers at a glance

| # | Layer | Status | Where designed |
|---|---|---|---|
| 1 | Input features | Partial | TARGET_SPEC_V2_DESIGN.md §5 |
| 2 | Target labels | Partial | TARGET_SPEC_V2_DESIGN.md §3-4 |
| 3 | Model architecture | Partial | TARGET_SPEC_V2_DESIGN.md §6 |
| 4 | Gate logic | Sketch only | This doc §4 → GATE_LOGIC_DESIGN.md |
| 5 | Trade management | Sketch only | This doc §5 → TRADE_MGMT_DESIGN.md |
| 6 | Position sizing | Sketch only | This doc §6 → POSITION_SIZING_DESIGN.md |
| 7 | Risk controls | Sketch only | This doc §7 → RISK_CONTROLS_DESIGN.md |
| 8 | Regime / meta | Sketch only | This doc §8 → REGIME_META_DESIGN.md |

Suggested deep-dive order: **4 → 5 → 7 → 6 → 8 → revisit 1-3.**

Rationale: 4 unblocks paper-trade gate, 5 defines TP/SL semantics 4 depends on, 7 (risk caps) must exist before any live capital, 6 (sizing) needs 7's caps as inputs, 8 (regime) is an enhancement on a working baseline, 1-3 only revisit if 4-8 surface a feature/target gap.

---

## Layer 1 — Input features

**What it is:** the columns TFA emits per tick that the model reads. Today: ~370 tick-level features (bid/ask microstructure, volume buckets, recent vol).

**v2 direction (TARGET_SPEC_V2_DESIGN.md §5):** add **~15 multi-timeframe features** so the model can see what a chart-watching trader sees: MA structure on 1/5/15-min candles, ADX-5min, momentum 5/15-min, distance-from-VWAP, session-high/low age, consecutive higher-highs counts, range compression ratio. Existing 370 stay untouched; new columns extend the parquet schema (~440 cols total). Old Wave 2 model continues to load and run, ignoring the new columns.

**Open items for revisit:** noise-floor values per instrument (nifty50 8 pts locked; crudeoil / naturalgas / sensex TBD), feature-importance pruning post-retrain.

---

## Layer 2 — Target labels

**What it is:** the columns the model is trained to predict. Today: 60 Wave 2 heads at 60-300s horizons (microstructure scalp — verified directionally correct but inside noise floor).

**v2 direction (TARGET_SPEC_V2_DESIGN.md §3-4):** add **18 trend targets** = 6 target types × 3 horizons {600s, 900s, 1800s}. Types per horizon: `trend_direction`, `trend_magnitude`, `trend_max_excursion`, `trend_max_drawdown`, `trend_continues`, `trend_breakout_imminent`. Critical: directions are labeled positive **only when |Δspot| ≥ noise_floor**, so the model learns "real move vs nothing," not "any drift up vs any drift down" — the root cause of Wave 2's near-base-rate predictions.

**Open items for revisit:** per-instrument noise-floor calibration, whether to add a 60-min horizon if 30-min trends look promising.

---

## Layer 3 — Model architecture

**What it is:** the learner. Today: LightGBM, one binary classifier per target head, default class weights.

**v2 direction (TARGET_SPEC_V2_DESIGN.md §6):** keep LightGBM. Add `scale_pos_weight = n_neg / n_pos` per target (currently 1.0 — root cause of model collapsing to base rate on imbalanced trend labels). Validation metric becomes `val_auc + simulated-PnL on holdout after fees`, not just AUC. Holdout grows from `last_n=1` to `last_n=5` (full week reserved). Total model heads per instrument: 60 Wave 2 + 18 trend = 78.

**Open items for revisit:** whether to add a single multi-output booster vs 78 separate boosters (compute trade-off), feature-importance-based pruning, walk-forward retrain cadence.

---

## Layer 4 — Gate logic ← **NEXT DEEP DIVE**

**What it is:** the per-tick decision function inside SEA that converts the 18 trend-head predictions into a binary "emit a trade signal now / don't" — and if yes, with what TP/SL. Today: `decide_action_wave2` uses a single probability threshold on `direction_60s` + a magnitude check.

**v2 sketch:** an AND-gate `decide_action_trend(predictions, regime)` that emits a signal only when **all** of: (a) `trend_direction_900s` prob ≥ θ_dir (per-instrument), (b) `trend_magnitude_900s` ≥ 25 pts, (c) `trend_max_drawdown_900s` ≤ 15 pts (predicted SL below cap), (d) cooldown since last signal ≥ 5 min, (e) regime from Layer 8 is "trend-permissive." TP/SL come from the predicted magnitude / max-drawdown, not fixed levels. Per-instrument config opt-in: `gate_mode: "wave2"` (legacy), `"trend"` (v2 only), or `"wave2+trend"` (ensemble).

**Open for deep dive:** θ_dir tuning method (precision-at-K vs F1 vs simulated-PnL), dwell-time requirement (must signal persist N ticks?), priority when both Wave 2 and trend gates fire on the same tick, what predictions feed TP/SL (point estimates vs quantile heads).

---

## Layer 5 — Trade management

**What it is:** what happens between signal-emit and position-close — TP/SL placement, trailing, time-stops, partial fills.

**v2 sketch:** **Hybrid static + time + trail.** At entry: static TP from `trend_magnitude_900s`, static SL from `trend_max_drawdown_900s`. Time-stop at `min(predicted_horizon, 1800s)` regardless of P&L. After 50% of TP distance reached, activate a per-minute trailing stop at `entry + 50% × magnitude_remaining_to_TP`. No partial profit-taking in v1 — full position out at TP / SL / time / trail-stop.

**Open for deep dive:** trail trigger formula, whether to recalculate TP/SL from rolling model predictions (re-eval each minute) vs lock at entry, re-entry rules after a stop-out on a still-strong signal, broker fill-quality assumptions (limit vs market).

---

## Layer 6 — Position sizing

**What it is:** how many lots to take per signal.

**v2 sketch:** **Volatility-scaled** with hard caps. `lots = floor(per_trade_risk_INR / (predicted_drawdown_pts × contract_multiplier))`, where `per_trade_risk_INR` = `daily_risk_budget / max_signals_per_day`. Cap by per-instrument exposure limit (read from Layer 7 config). Floor at 1 lot (skip signal if calculated size = 0). No Kelly-fraction in v1 — too sensitive to win-rate estimates with only 100-trade samples.

**Open for deep dive:** how daily_risk_budget composes with account equity (% of equity vs fixed INR), signal-confidence weighting (size up on high-prob predictions?), portfolio-level concurrent-position risk aggregation, whether to size differently for `wave2` vs `trend` gate outputs.

---

## Layer 7 — Risk controls

**What it is:** the hard kill-layer that overrides gate output regardless of model conviction. The thing that survives bugs in Layers 1-6.

**v2 sketch:** static config-driven hard limits: daily-loss-limit (halt trading for the day if hit), max concurrent positions (per instrument and total), max signals/day per instrument, blackout windows (lunch 12:30-13:30, last 5 min before close, broker maintenance windows), broker WS budget caps (already implemented — see Dual Dhan Account Architecture). Plus N-consecutive-losers auto-pause (resume requires manual re-enable). All limits checked **before** Layer 6 sizing, so a tripped limit blocks the trade entirely, not just downsizes it.

**Open for deep dive:** kill-switch event hooks (Slack/email on halt), reset cadence (daily / weekly / manual), max drawdown over rolling N days as a halt trigger, paper vs live limit divergence, expiry-day special handling.

---

## Layer 8 — Regime / meta

**What it is:** a layer above the gate that classifies the current market state and gates which signals are allowed in which states.

**v2 sketch:** 3-state classifier `{trend, range, chop}` from rules first: `trend` if ADX-5min ≥ 25 AND `consecutive_higher_highs_5min ≥ 3` (or symmetric down), `chop` if range-compression-ratio < 0.6 AND ADX < 15, `range` otherwise. Layer 4 gate reads this and only emits trend signals in `trend` regime (initially); Wave 2 scalp can run in `range` or `chop` as a future ensemble. Rule-based first because labels for a learned regime classifier are circular (you'd label them using the same trend definition).

**Open for deep dive:** thresholds tuning, time-of-day regime priors (open volatility vs midday range vs close), look-ahead avoidance, whether to add a second LightGBM head trained on hand-labeled regime windows, how regime transitions interact with open positions (close on regime change?).

---

## What this design EXPLICITLY does not do

- Does not change the LightGBM choice (covered in Layer 3 lock).
- Does not drop Wave 2 scalp — it stays as backup / ensemble candidate.
- Does not introduce ML position sizing (Kelly etc.) in v1.
- Does not introduce ML regime classification in v1 — rules first.
- Does not commit per-instrument numeric thresholds in this skeleton (those land in per-layer deep dives).

## Next action

Start the **Layer 4 deep dive** in the next session: produce `docs/GATE_LOGIC_DESIGN.md`. Pull the open items from §4 above into that doc's agenda.
