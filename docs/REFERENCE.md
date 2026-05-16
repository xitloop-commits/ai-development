# Signal system reference — 8-layer architecture + 7 proposed changes

Captured 2026-05-16. Reference doc for the v2 signal system design conversation. Background context for any session picking up the Layer 4-8 brainstorm work (see `docs/PROJECT_TODO.md` T2).

## The complete signal system has 8 layers

```
┌─────────────────────────────────────────────────────────────┐
│ 1. INPUT FEATURES        what model sees                    │
│    (tick microstructure + multi-TF context + regime)        │
├─────────────────────────────────────────────────────────────┤
│ 2. TARGET LABELS         what model predicts                │
│    (multi-horizon direction + magnitude, noise-floored)     │
├─────────────────────────────────────────────────────────────┤
│ 3. MODEL ARCHITECTURE    how it learns                      │
│    (LightGBM, class-weighted, cost-aware metrics)           │
├─────────────────────────────────────────────────────────────┤
│ 4. GATE LOGIC            predictions → trade decision       │
│    (scalp gate + trend gate + ensemble combinator)          │
├─────────────────────────────────────────────────────────────┤
│ 5. TRADE MANAGEMENT      after entry                        │
│    (TP / SL / trailing / time-exit / scale-out)             │
├─────────────────────────────────────────────────────────────┤
│ 6. POSITION SIZING       how much                           │
│    (confidence → contracts; volatility-adjusted)            │
├─────────────────────────────────────────────────────────────┤
│ 7. RISK CONTROLS         when to stop                       │
│    (daily DD circuit, max trades/day, lockout per loss)     │
├─────────────────────────────────────────────────────────────┤
│ 8. REGIME / META         conditional everything             │
│    (skip dull days, scale up trend days, halt event days)   │
└─────────────────────────────────────────────────────────────┘
```

## What was drafted as of 2026-05-16

| Layer | Status |
|---|---|
| 1. Input features | ✅ basic spec (multi-TF context) in `docs/TARGET_SPEC_V2_DESIGN.md` |
| 2. Target labels | ✅ spec with noise floor in `docs/TARGET_SPEC_V2_DESIGN.md` |
| 3. Model architecture | ⚠️ partial (`scale_pos_weight` mentioned) |
| 4. Gate logic | ❌ minimal (`decide_action_trend` named only) |
| 5. Trade management | ❌ not designed |
| 6. Position sizing | ❌ not designed |
| 7. Risk controls | ❌ not designed |
| 8. Regime / meta | ❌ deferred to P3 |

So roughly 30% of the signal system is designed. The other 70% needs work — and most of it doesn't require training data, so it can proceed in parallel with the auto-recorder accumulating 30+ sessions.

## Suggested 4-week design schedule

| Week | Focus | Output |
|---|---|---|
| 1 | Layers 4 + 5 (gate logic + trade management) | `docs/GATE_DESIGN_V2.md` — full gate flowchart, exit rules, ensemble policy |
| 2 | Layer 7 (risk controls) | `docs/RISK_CONTROL_DESIGN.md` — DD limits, daily caps, recovery rules |
| 3 | Layer 6 (position sizing) | `docs/SIZING_DESIGN.md` — Kelly-lite, conviction-weighted, volatility-scaled |
| 4 | Layer 8 (regime detection) + integration | `docs/REGIME_DESIGN.md` + master `docs/SIGNAL_SYSTEM_V2.md` tying everything together |

By end of month: full design ready, data accumulated, then 5-7 days of implementation → paper trade.

## Where to start

**Layer 4 (gate logic)** — everything downstream depends on it. The gate decides what counts as a trade; TP/SL/sizing are tuned per gate output.

---

# Why the 7 proposed changes — what each one does to signal strength

Concrete mechanism-by-mechanism analysis of how each Change should improve signal quality.

## Change 1 — Longer target horizons (10/15/30 min vs 60-300s)

**Mechanism:** Model trained to predict "where will price be in 15 minutes" instead of "where in 60 seconds."

**Why this improves signal:**
- 60s direction is dominated by microstructure noise (one big tick can flip it). Signal-to-noise ratio is bad.
- 15-min direction is dominated by actual order flow trends (institutional positioning, momentum). Better S/N because noise averages out over more samples.
- Real money moves visible only at minute-scale; tick-scale just sees algos trading against each other.

**Expected impact:** Direction prediction AUC could improve from 0.57 (current 300s persists) → 0.60-0.65 (15-min direction). Win rate when fires: 50% → 55-60%.

**Risk:** Longer horizon = harder to predict from current inputs alone. Needs multi-TF features (Change 3) to actually deliver.

## Change 2 — Noise floor in labels (≥8 pts = "1", else "0")

**Mechanism:** Current `direction_60s=1` for any positive move, even +0.5 pts. New `trend_direction_15min=1` only if move ≥8 pts.

**Why this improves signal:**
- Current model trains on "is the next tick up or down" — labels are 50/50 split by random walk. The model converges to "predict 0.5 for everything."
- New labels separate economically meaningful moves from drift. Model learns features that distinguish "this looks like a real move starting" from "this is just noise."
- Class imbalance reflects reality (~15-20% of windows have ≥8 pt moves) instead of an artificially balanced random walk.

**Expected impact:** **The single biggest change.** Model predictions go from clustered near 0.5 (uninformative) to a meaningful distribution (rare high-conviction calls, mostly low-conviction). Gates become tradeable.

**Risk:** If noise floor too high, no positive examples to learn from. Tune per instrument.

## Change 3 — Multi-TF context features (15 new inputs)

**Mechanism:** Model sees not just current tick but also 1m/5m/15m candle structure, MAs, ADX, session-VWAP distance.

**Why this improves signal:**
- A human trader looks at a 5-min chart to see "we just broke above the 20-bar high with strong momentum." Current model sees only the latest tick. It literally can't see context.
- ADX > 25 = trending market; ADX < 20 = ranging. Same predictions mean different things in different regimes. Model needs the regime input to weight predictions correctly.
- MA alignment (price > MA5 > MA20 = uptrend structure) is a coincident indicator with high explanatory power for next 15-min direction.

**Expected impact:** Adds 5-15 percentage points to AUC of long-horizon targets. Probably the **second-biggest change** after labels.

**Risk:** Adds features → adds dimensionality → needs more data to avoid overfitting. Synergistic with Change 5.

## Change 4 — `scale_pos_weight` in LightGBM

**Mechanism:** When training on 5% positive class, LightGBM by default predicts near 5% for everything (correct on average, useless for ranking). With `scale_pos_weight = n_neg/n_pos = 19`, the model up-weights positive samples in loss.

**Why this improves signal:**
- Predictions get pushed UP into actionable ranges (top decile predictions become 0.30-0.60 instead of 0.05-0.10).
- Top-1% predictions become differentiable from average (not collapsed near base rate).
- Gates can use absolute thresholds (e.g., "prob ≥ 0.50") instead of percentile ranking gymnastics.

**Expected impact:** Doesn't change AUC much (LightGBM was already ranking correctly), but makes predictions **usable** for fixed-threshold gates. Effectively transforms "predicted 0.054" → "predicted 0.42" for the same input — same ranking, different scale.

**Risk:** Over-weighting positives can introduce false positives if positives are themselves noisy. Tune the weight.

## Change 5 — More training data (30+ sessions)

**Mechanism:** From 9 sessions × ~25k rows = 225k rows → 30 sessions × ~25k = 750k rows. 3.3× more.

**Why this improves signal:**
- 15-30 min trend windows are rare events. In 9 days × 6 hours × ~12 windows/hour = ~648 distinct 30-min windows. Of those maybe 50-80 are "real trends." That's tiny.
- 30 days × same density = ~2160 windows, ~150-250 real trends. Enough to learn patterns.
- More regime diversity (volatile days, ranging days, news days) → model generalizes better.

**Expected impact:** Probably +5-10 percentage points to AUC just from having enough positive examples. Critical for Change 2 to work.

**Risk:** Diminishing returns past ~60 sessions. Also: if regime shifts dramatically (e.g., new policy), old data hurts more than helps.

## Change 6 — Larger holdout (n=5 days)

**Mechanism:** Hold out 5 most-recent complete days from training; backtest model on them.

**Why this improves signal:**
- Single-day holdout (current) is noisy — one outlier day can flip the verdict. 5 days = 5x more statistical power.
- 5 days covers Mon-Fri regime variation (Monday vs expiry-Thursday vs Friday-of-week behave differently).
- Catches overfitting better — model that aces in-sample but fails on 5 OOS days is visibly broken, while it might look fine on 1 OOS day.

**Expected impact:** Doesn't make the model better, makes our **verdict on the model** more reliable. Equally important.

**Risk:** Costs 5 days of training data. Acceptable trade if you have 30+ total.

## Change 7 — New trend gate + ensemble

**Mechanism:** `decide_action_trend` uses 15-min predictions with appropriate thresholds; runs alongside `decide_action_wave2` (scalp).

**Why this improves signal:**
- Scalp gate fires at day-extreme reversals (we verified this works — 9/9 correct on small captures).
- Trend gate fires on multi-bar momentum confirmation (catches the 10:50-11:20 type moves).
- Both can fire on the same day for different setups; ensemble means more total signals AND better filtering of false positives (when both gates disagree, skip).

**Expected impact:** Total trade frequency: 5-10/day per instrument (vs 2-3 today). Win rate per trade: model-dependent, target ≥55%.

**Risk:** Two gates can interact badly (e.g., scalp says SHORT, trend says LONG → trader confused). Need clear precedence rules.

---

## Combined expected change in signal strength

| Metric | Today (Wave 2 scalp) | After all changes (realistic) |
|---|---|---|
| Direction AUC at 15-min | N/A (no target) | 0.60-0.65 |
| Top-1% prediction value | 0.0028 (collapsed) | 0.40-0.60 (usable) |
| Win rate on trend signals | N/A | 55-60% |
| Trade frequency / instrument / day | 2-3 (scalp only) | 5-10 (scalp + trend) |
| Per-trade target capture | ~5 pts | 15-30 pts |
| Per-trade expectancy after slippage | ~+2 pts (marginal) | +6 to +12 pts |
| Daily expected PnL per instrument | ~+5 to +15 pts | +30 to +80 pts |

## Honest probability of hitting these numbers

- **70% chance** the new system reaches "barely profitable after costs" — meaning Changes 2+3+5 do their job
- **40% chance** of hitting the daily PnL targets in the table — needs all 7 changes working together AND data quality holding
- **15% chance** of failure to learn (data too thin, labels too rare, regime too unstable) — would need another iteration
