---
name: 250-day journey strategy — full plan from May 3 brainstorm
description: Comprehensive strategic plan developed in the May 3 2026 deep-dive session. Covers the 250-day compounding journey reality, trade frequency framework, day-cycle controller, day-index phases, overshoot mode, drawdown rules, volatility-scaled SL, cost erosion, instrument allocation, edge monitoring, JA Journey Agent architecture, and the diagnosis (validated against actual scorecards) that drives the P0/P1/P2/P3 roadmap.
type: project
originSessionId: dfcdde09-4e2f-4656-b562-fb834170310a
---
This is the full strategic context. Companion to `project_p0_paper_trading.md` (execution state) and `project_filter_architecture.md` (technical finding).

## Diagnosis — what's broken vs working (validated against scorecards)

| Layer | State | Evidence |
|---|---|---|
| Direction model (30s) | ✅ Works | 60.5–64.4% across 4 instruments, calibrated (confidence_correct gap 4–11pp over confidence_wrong) |
| Direction model (60s) | ❌ Calibration broken | confidence_correct ≈ confidence_wrong everywhere — high-conviction calls aren't more accurate than low. Drop from routing. |
| Magnitude regressors | ❌ Near-noise | corr_up_30s 0.02–0.37; up-side worse than down-side; MSE loss dominated by heavy tails. Without fixing this, all TP/SL math is dart-throwing. |
| Regime classifier | ✅ Works | Distributions plausible per instrument |
| Routing (`_decide`) | ⚠️ NEUTRAL gate too tight | Nifty 69% NEUTRAL → 1 trade/day filtered |
| Stage 1–3 filter (legacy) | ✅ Adds precision | BankNifty 62.8% → 78.1% in legacy mode |
| Stage 4 (legacy) | ❌ Kills edge | 99.6% of natgas survivors blocked. **Only matters in legacy path** — production is gate-mode. |
| TP/SL math | ⚠️ Horizon-mismatched | 15min predictions evaluated against 30s scoring, 97.8–99.8% "neither" rate |
| Exit manager | ❌ Does not exist | engine.py only emits entries; no time exit, no trailing |
| Position sizing | ❌ Does not exist | No risk-per-trade logic anywhere |
| Crude oil pipeline | ❌ Bullish branch dead | 0 LONG_CE / 0 SHORT_PE; corr_up_30s null. Likely class imbalance, not target redesign. |

## ChatGPT verdict — what was right and wrong

ChatGPT was directionally correct on ~70% of issues but wrong on root causes for two:

| ChatGPT claim | Truth |
|---|---|
| "Direction prediction works (60-68%)" | ✅ Correct |
| "Stage 4 blocks 95-99%" | ✅ Correct (in legacy path) — but legacy isn't production |
| "TP/SL invalid → 95-100% trades go nowhere" | ✅ Correct outcome, wrong cause |
| **"No magnitude awareness"** | ❌ **Wrong** — magnitude models exist and Stage 3 uses them. The bug is regression correlation 0.02–0.37 (near-noise). |
| **"TP/SL design dimensionally invalid"** | ❌ **Wrong** — units match (option-premium space). The bug is horizon mismatch (15min predictions, 30s scoring). |
| "No exit system" | ✅ Correct |
| "Crude needs full redesign" | ⚠️ Partial — try class-balance fix first |
| "You have a signal system, not a trading system" | ✅ Correct one-liner |

## The 250-day compounding reality

Architecture in [server/portfolio/compounding.ts](ai-development/server/portfolio/compounding.ts):
- ₹1L start → 75/25 split → trading pool ₹75K, reserve ₹25K
- 5% daily target on trading pool
- 75% of profit compounds; 25% to reserve
- **LIFO clawback** consumes prior days' trading-pool gains on losses (newest first); reserve permanently safe; floor at Day 1 starting capital

### Effective compound math

| Outcome | Frequency | Net effect |
|---|---|---|
| Hit target | 55–65% of days | +3.75% (5% × 0.75 to pool) |
| Partial / breakeven | 20–25% | 0% |
| Stopped at -2% | 10–15% | -1.5% |
| Stopped worse (rare) | 1–3% | -3 to -4% |

**Effective expectancy: 2.0–2.6% per day net.** Not the 3.75% headline.

### Day-250 trading pool projections

| Effective daily | Day 250 pool |
|---|---|
| 3.75% (idealized) | ₹74 Cr |
| 3.0% | ₹13 Cr |
| **2.5% (realistic-optimistic)** | **₹3.5 Cr** ← plan around this |
| 2.0% | ₹1.05 Cr |
| 1.5% | ₹31 L |

**Honest target: ₹3-5 Cr at day 250, not ₹74 Cr.** Still life-changing; ₹74 Cr is fairy-tale math.

## Trade frequency framework

### Trades are a budget, not a target

For 30s-5min hold time (your model horizon): **3–8 trades per instrument per session**, total **50–200 trades/day across 4 instruments**. **Stop at target hit.** Hard-stop at -2%/day.

### Backward math: trades-needed = day_target / EV-per-trade

For 60% precision, R/R 1.5:

| Risk per trade | Reward per trade | EV per trade | Trades to hit 5% target |
|:---:|:---:|:---:|:---:|
| 1% | 1.5% | 0.50% | ~10 |
| **2%** | **3%** | **1.00%** | **~5 (sweet spot)** |
| 3% | 4.5% | 1.50% | ~3 |

### Per-instrument healthy targets

| Instrument | Healthy /session | Your current (4-30 backtest) |
|---|---|---|
| Nifty | 15–30 | 1 ❌ |
| BankNifty | 20–45 | 73 ⚠️ slightly high but acceptable |
| Crude | 30–80 (longer session) | 0 ❌ |
| NatGas | 30–80 | 5 ❌ (legacy) / 1066 (gate) |

## Day-Cycle Controller (the missing brain)

A controller that sits between SEA's filtered signals and `tradeExecutor.submitTrade`. Computes per-trade parameters dynamically from current state.

### Inputs

```
day_target_remaining_inr   = day_target - realized_pnl_today
hours_remaining            = session_close - now
max_day_loss_floor         = -2% of trading_pool (hard stop)
trades_taken_today         = N
buffer_credit              = (computed from clawback architecture; see overshoot below)
```

### Per-trade parameter derivation

**Position size:**
```
risk_per_trade = min(
    2% of pool,
    day_target_remaining / 3,            # never risk more than ⅓ of remaining target
    50% of newest_unconsumed_profitHistory_layer  # protect yesterday's gain
)
sl_distance_inr = max(
    model_predicted_drawdown,
    1.5 × ATR_5min,                      # noise floor
    0.10 × current_premium               # absolute floor
)
lots = floor(risk_per_trade / (sl_distance_inr × lot_size))
```

**TP — capped by remaining target:**
```
tp_distance = max(
    1.5 × sl_distance,                   # baseline R/R
    day_target_remaining / lots          # smallest TP that finishes the day
)
```

**TSL — only after meaningful progress:**
```
if realized_pnl_this_trade >= 0.5 × day_target_remaining:
    activate_trailing_stop(distance = 0.3 × current_profit)
```

**TL (time exit) — from session, not just signal:**
```
time_limit = min(
    300s,                                # baseline horizon (matches model)
    hours_remaining_in_session × 0.25    # reserve time for retries
)
```

### Mode states

```
HUNTING       — default, full risk budget
CAUTIOUS      — 2 consecutive losses or rolling 20-trade precision <55% → score=5+, half size
PRESERVE      — target hit (100-110%), score=6 only, 50% size
LOCKED        — overshoot >110% (or hard cap at 150%) → no new trades, lock in gains
HALTED        — daily loss ≤ -2% → no more trades today, period
```

## Day-index-aware discipline phases

Loss tolerance scales **inversely** with day-index — late-journey losses cost disproportionately more in absolute ₹ even though clawback "protects" you.

| Phase | Days | Risk per trade | Daily loss cap | Overshoot mode |
|---|---|---|---|---|
| **GENESIS** | 1–10 | 1% | -1.5% | ❌ |
| **BUILDING** | 11–30 | 1.5% | -2% | ❌ |
| **STEADY** | 31–150 | 2% | -2% | ✅ |
| **MATURE** | 151–220 | 1.75% | -1.75% | ✅ (capped at 130% of target) |
| **HOMESTRETCH** | 221–250 | 1.25% | -1.5% | ❌ |

Reasoning:
- Day 50 with 49 days banked: 3-day clawback = ~₹3,540 loss. Annoying.
- Day 200 with 199 days banked: 3-day clawback at compounded rates = **~₹13L loss**. Same 3 days, 1000× the rupees.
- Day 240 with 10 days left: 5-day clawback = **50% of remaining journey**.

## Overshoot mode (after target hit)

The clawback architecture provides a natural floor — LIFO claw eats today's profit FIRST before touching yesterday. So overshoot losses are bounded by today's already-realized profit.

### Refined rules (validated by clawback semantics)

| Rule | Value | Reasoning |
|---|---|---|
| Hard cap on overshoot loss | **75% of today's realized profit** | Always preserve 25% of overshoot |
| Position size | 50% of HUNTING | |
| Min signal score | 6 only | |
| Min R/R | 2.0 | |
| Time-of-day cutoff | 45 min before close | |
| Trade count cap | Max 3 | Hard cap is on ₹, not count |
| Auto-end mode | When realized profit drops to 100% target | |
| First-loss rule | Removed — hard ₹ cap does same job better without forcing exit on normal-variance loss | |

### The buffer-bank concept is **DROPPED**

Initially proposed a separate buffer-bank for overshoot. **Clawback IS the buffer.** Each completed day = +1 layer of clawback resilience. Don't build a separate smoothing fund.

### Earn the right to OVERSHOOT mode

- Disabled in first 4-6 weeks (GENESIS + BUILDING phases)
- Enabled in STEADY only after 30 sessions of consistent target hits
- Disabled if rolling 5-day precision drops

## Drawdown rules / circuit breakers

| Trigger | Action |
|---|---|
| Day P&L ≤ -1% | Cut next trade size in half |
| Day P&L ≤ -2% | **HALT — stop trading today** |
| 3 losing trades in a row | 30-min cool-off, score=6 only to resume |
| 2 losing days in a row | Tomorrow at half size |
| 3 losing days in a row | Halt 1 day, force review |
| Weekly P&L ≤ -5% | Halt 2 days, refresh signal analysis |
| Rolling 20-trade precision <50% | **AUTO-HALT** — investigate model drift |
| Rolling 5-day precision <53% | Switch to paper mode until back above 55% |
| Any clawback event | 24h cool-off, force journal entry |
| 2 clawback events / week | 2 paper-trade days |
| 3 clawback events / month | System halt + full retrospective |

## Cost erosion (the silent killer)

Per round-trip option trade:
- Brokerage: ₹20-40 flat
- STT: 0.0625% on sell side
- Exchange + SEBI fees: ~0.053% + 0.0001%
- GST: 18% on (brokerage + exchange)
- **Slippage: 0.5-2%** of premium (the big one)

For ATM option at ₹100, 1 lot of 50: order value ₹5K, total cost ₹40-80 = **0.8-1.6% of trade value**.

Implication: a 3% gross trade nets only 1.5-2% after costs. **All EV math must use NET, not gross.** Add `costEstimator.ts` utility; subtract from EV before sizing decisions.

## Volatility-scaled SL (solves "1-5% noise stops me out")

Position sizing scales SL distance to ATR, not to a fixed % of premium:

```
sl_distance = max(
    model_predicted_drawdown,
    1.5 × ATR_5min,
    0.10 × current_premium
)
position_lots = floor(risk_budget / (sl_distance × lot_size))
```

**Quiet options** (low ATR) → tight SL + bigger position. **Noisy options** (high ATR) → wide SL + smaller position. **₹ at risk stays constant.**

Typical ATM option ATR_5min as % of premium:
- Nifty: 2–4%
- BankNifty: 3–5%
- **NatGas: 8–15%** (much noisier)
- **Crude: 6–12%**

Stack with: entry grace period (no SL first 30-60s), multi-tick SL confirmation (3 consecutive adverse), IV-expansion filter, hold for model's predicted horizon (5min) and exit at market.

**Switch to futures by day 30+** when capital allows. Eliminates premium noise at source. Same model, cleaner instrument, much less SL noise.

## Instrument allocation

Three models, by sophistication:

**(a) Static weights:** BN 35%, NG 30%, NF 20%, CO 15%. Reset daily.
**(b) Recent-precision-weighted:** rolling 20-trade win-rate²-weighted budget. Self-throttling. **Recommended.**
**(c) Best-signal-wins:** all instruments queue into shared budget; highest-score wins next slot.

By **day 90-110**, pool hits ₹15-30L → NatGas position sizes hit 2-4% of option chain depth → liquidity pressure. Auto-rebalance away from thin instruments. By **day 150**, probably nifty + banknifty only.

## Edge degradation monitoring

Track and alert on:
- Rolling 50-trade precision per instrument (drop 5pp from baseline → alert)
- Rolling 5-day target-hit rate (drop below 40% → halt + retrain)
- Predicted-vs-realized correlation for direction probability (calibration breaking → halt)
- Regime distribution drift (NEUTRAL share jumping suddenly → re-tune thresholds)

Daily 06:00 IST cron: compare yesterday's scorecard to rolling 30-day baseline; alert on any tripwire; auto-disable affected instrument's auto-trader.

## Discipline Agent (DA) covers ~80% of hygiene

Already built and unusually well-architected (per `server/discipline/index.ts`):

✅ Daily loss circuit breaker | ✅ Consecutive losses cooldown | ✅ Revenge cooldown | ✅ Trade limits (count + positions) | ✅ Time windows | ✅ Position size cap | ✅ Total exposure | ✅ Streak adjustments | ✅ Journal compliance | ✅ Weekly review | ✅ Pre-trade gate | ✅ Per-channel partitioning | ✅ Self-exit immunity (DISCIPLINE-triggered exits don't double-count) | ✅ Score + violation log + dashboard

**What's missing — three new modules to add to DA's pipeline:**

1. **`targetProgress.ts`** — read today's `targetAmount` + `dailyRealizedPnl`, emit mode (HUNTING/CAUTIOUS/PRESERVE/LOCKED). Uses existing `activeAdjustments` plumbing.
2. **`clawbackAware.ts`** — read profitHistory; cap per-trade risk at 50% of newest unconsumed layer. Per-day clawback events trigger 24h cool-off via existing `activeCooldown` plumbing (new reason `CLAWBACK_TRIGGERED`).
3. **`modelHealth.ts`** — rolling 20/50/200 trade precision per instrument; tripwire below threshold blocks instrument until recovery.

Plus **`tradeShaper.ts`** *outside* DA — between SEA filtered signals and DA validation. Computes lots/TP/SL/TSL/TL from day-cycle state. DA still gatekeeps; shaper sizes.

**Estimated additions: 1 week of work.** DA's `activeAdjustments`, `activeCooldown`, `addViolation`, and exit-cause-aware accounting all fit the new responsibilities cleanly.

## JA — Journey Agent (strategic supervisor)

Sits ABOVE the operational layer. Owns the 250-day arc.

### Hybrid architecture

**Layer 1 — Deterministic spine** (TypeScript, ~500 lines, runs production):
- Phase detection from day index
- Mode switching from realized vs target
- Tripwire evaluation
- Allocation math
- Tripwire actions (halt, throttle, escalate)
- State persistence

**Layer 2 — LLM reasoning layer** (Anthropic SDK, ADVISORY ONLY — never touches trade orders):
- Daily plan narrative
- Anomaly explanation
- End-of-day storytelling
- Counterfactual analysis
- Weekly retrospective
- User advisory dialogue

### JA's responsibilities by time horizon

**Pre-market (06:00 IST):**
- Read yesterday's outcomes
- Check journey position (day N of 250, days banked, trajectory vs realistic curve)
- Check model health per instrument
- Decide today's posture per instrument: LIVE_FULL / LIVE_HALF / LIVE_PROBE / PAPER / HALTED
- Allocate today's risk budget
- Set tripwire thresholds
- Emit immutable Daily Plan document

**Intra-market (1-min polling supervisor):**
- Compare progress to plan
- Watch tripwires (precision velocity, drawdown velocity, IV expansion)
- React to events (clawback, mode switch, halt)
- Adapt allocation
- **Never on the trade hot path.** SEA + DA + executor handle individual trades.

**Post-market:**
- Compute final day metrics
- Update journey trajectory
- Detect anomalies + root cause analysis
- Generate End-of-Day report
- Schedule retraining if needed

**Weekly / monthly:**
- 5-day rolling review
- Walk-forward validation
- Buffer status review
- Risk dial review
- Honest narrative to user

### Decision authority hierarchy

| Decision | JA alone | JA + user confirm | User-only |
|---|---|---|---|
| Halt one instrument | ✅ | | |
| Halt all today | ✅ (with strong reason) | | |
| LIVE → PAPER mode | ✅ | | |
| PAPER → LIVE mode | | ✅ | |
| Reduce risk dial below configured | ✅ | | |
| Increase risk dial above configured | | | ✅ |
| Override DA hard rules | ❌ | ❌ | ✅ |
| Trigger model retraining | ✅ | | |
| Approve new model for live | | ✅ | |
| Withdraw from reserve | | ✅ | |
| Force rest day | ✅ | | |
| Force rest week | | ✅ | |
| End journey early | | | ✅ |

**Pattern: JA can always slow down, never speed up beyond user-set ceiling.**

### Tripwires (deterministic, not LLM)

| Tripwire | Threshold | Action |
|---|---|---|
| Precision drop | Rolling 20-trade <50% | Halt instrument |
| Drawdown velocity | -1% in <30 min | Throttle to LIVE_HALF |
| Drawdown velocity | -1.5% in <30 min | Halt all today |
| Cost ratio | costs >25% of expected profit | Block instrument |
| Regime mismatch | Predicted ≠ observed for 2hr | Throttle |
| Model drift | Calibration broken | Halt instrument |
| Clawback event | Any | Tomorrow: max 1 trade/day, score=6 only |
| Buffer >15% pool | | Notify: compound or withdraw? |
| Trajectory drift | >20 days behind realistic curve | Strategic review notification |
| 5 losing days / 7 | | Force rest day |
| 3 losing weeks / month | | Force rest week + full review |

### JA dangers (constrain explicitly)

1. **Confirmation bias amplification.** LLM constructs plausible narratives from random performance. → Always show deterministic numbers next to LLM narrative.
2. **Action paralysis.** Constant throttling can starve. → Tripwires must have recovery conditions; restore posture when metrics recover.
3. **User over-trust.** "JA said it's fine" replaces own judgment. → JA explicitly flags own analysis limits.
4. **JA itself drifting.** Rules might be wrong. → Monthly review of JA's own decisions; JA learns about itself.
5. **Latency creep.** → Read async; never block trade hot path; fail-open if JA crashes.

## P0 → P3 → JA roadmap

```
P0  — Filter + UI fixes                       1 week
      P0.1: gate-mode log fix (real bottleneck) — see project_filter_architecture.md
      P0.2: drop direction_60s
      P0.3: per-instrument NEUTRAL gate
      P0.4: raw stream stabilization (deadband + EMA + flip protection)
      P0.5: UI default source = filtered

P1  — Execution math                           1 week
      P1.4: TP/SL horizon match (use 5min preds + force time-stop)
      P1.5: volatility-scaled SL (ATR-aware sizing)
      P1.6: trade manager (exit logic — NEW MODULE)

P2  — Magnitude rebuild                        2 weeks
      P2.7: rebuild magnitude regressors (Huber/quantile loss + new features)
      P2.8: crude bullish branch (class balance)

P3  — Profitability infra                      1 week
      P3.9: position sizer (Kelly-fraction)
      P3.10: PnL-based scorecard (not just precision)
      P3.11: walk-forward validation

JA — Strategic supervisor                      4 weeks
      JA.1: deterministic spine (state, phase detector, daily planner, tripwires, EOD)
      JA.2: LLM reasoning layer (advisory)
      JA.3: shadow mode (1 week observation)
      JA.4: active mode

DA additions (parallel to P-tracks):
      targetProgress.ts        (day-cycle mode switching)
      clawbackAware.ts         (per-trade sizing)
      modelHealth.ts           (edge degradation tripwires)
      tradeShaper.ts           (parameter optimization, outside DA)
```

**Total runway: ~3 months** to journey-start with high confidence (P0+P1+P2+P3+JA, plus 1-month paper journey, plus tiny live capital validation).

## Hard go/no-go gates before risking capital

1. Filtered precision ≥ 60% on **all 4 instruments** across **3 walk-forward windows**
2. PnL scorecard shows **positive net P&L after costs** at realistic position sizes for ≥10 sessions
3. Time-exit closes ≥80% of trades that don't hit TP/SL within horizon (no "neither" bucket)
4. Max-drawdown ≤ 3× avg-daily-PnL on backtest history

If any of those four fails, you have a signal system, not a trading system.

## The brutal summary

**Edge is real but small.** The 250-day journey works only if:
1. Costs are baked into every decision (today: not at all)
2. Stops enforced by code, not willpower (today: don't exist)
3. Sizing is dynamic from day-cycle target (today: not implemented)
4. Drawdown circuit-breakers exist (today: partial — DA covers most)
5. Edge degradation monitored daily (today: not monitored)
6. Realistic target is **₹3-5 Cr at day 250, not ₹74 Cr**

You have:
- ✅ Directional edge (60-65% precision)
- ✅ Excellent capital architecture (75/25 + clawback + reserve)
- ✅ Mature discipline foundation (DA module)

You're missing:
- ❌ Execution math that matches model horizon
- ❌ Volatility-aware sizing
- ❌ Day-cycle target awareness in trade decisions
- ❌ Cost-aware EV
- ❌ Edge degradation monitoring
- ❌ Strategic supervisor (JA)

The 250-day journey **works** if all six are added. Everything else is detail.

## One-line takeaway

**Prediction is solved, execution is missing, supervision is missing — and your existing capital architecture is more sophisticated than your discipline rules currently exploit.**
