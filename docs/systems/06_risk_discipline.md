# 06 — Risk & Discipline

Single source of truth for the safety layer: **DisciplineAgent (DA)** owns "should this trade happen at all?", **RiskControlAgent (RCA)** owns "is this open trade still healthy?", and the **Charges** model owns "what does this cost?". Together they're the only thing between a model signal and real money on the line.

## 1. Purpose & Scope

**In scope:**
- DisciplineAgent — 8-module pre-trade gate: circuit breaker, trade limits, time windows, signal-quality gate, sizing, journal, weekly review, capital protection.
- Capital protection (Module 8) — daily profit / loss caps, session-halt latching, carry-forward evaluation, grace-period state machine, MUST_EXIT signalling.
- RiskControlAgent — real-time 30 s monitoring loop, 4 exit triggers (age, stale-price, momentum-flip, vol-threshold), Discipline-signal priority.
- Charges model — brokerage + STT / CTT + exchange fee + GST + per-strike-distance slippage penalty; pre-trade preview + post-trade reconcile.
- L7 risk controls per V2 — per-layer concurrent caps, swing entry cutoff, shared daily-loss budget, event blackout (Tier-1 hard / Tier-2 advisory).

**Out of scope:**
- Signal generation → [04 Signal Engine](04_signal_engine.md).
- Order placement → [05 Execution](05_execution.md).
- Position state ownership + P&L feed source → [07 Portfolio & Reporting](07_portfolio_reporting.md).

## 2. Architecture at a glance

```
        04 Signal Engine
              │
              ▼ POST /api/discipline/validateTrade
       DisciplineAgent (DA)
       ┌──────────────────────────────────────────┐
       │  Module 1: circuit breaker (kill switch) │
       │  Module 2: trade limits (per-day / streak) │
       │  Module 3: time windows (event blackout) │
       │  Module 4: pre-trade gate (signal quality + position cap) │
       │  Module 5: sizing (lot computation per L6) │
       │  Module 6: journal (write-through audit) │
       │  Module 7: weekly review (Mon morning report) │
       │  Module 8: capital protection (daily caps + carry-forward + grace) │
       └──────────────────────────────────────────┘
              │
              ▼ pass
       POST /api/risk-control/evaluate
       RiskControlAgent (RCA)
              │
              ▼ approve
              05 TEA places order
              │
              ▼ (open position)
       RCA monitoring loop (30 s)
       ┌──────────────────────────────────────────┐
       │  age trigger        (default 30 min)     │
       │  stale-price trigger (5 min without tick) │
       │  momentum-flip trigger                    │
       │  volatility-threshold trigger             │
       └──────────────────────────────────────────┘
              │
              ▼ trigger fires
              emit EXIT signal → 05 TEA closes
              │
              ▼ fill
       07 Portfolio.applyFill()
              │
              ▼ daily P&L push
       DA Module 8 cap checks
              │
              ▼ cap breached
       MUST_EXIT signal → RCA → TEA
       (grace period 30 s, operator choice: EXIT_ALL / EXIT_INST / REDUCE / HOLD / TIMEOUT)
       (TIMEOUT → auto-EXIT_ALL)
```

## 3. DisciplineAgent — the 8 modules

All 8 are implemented (Module 8 capital protection shipped 2026-05-03).

| # | Module | Responsibility | Code |
|---|---|---|---|
| 1 | Circuit breaker | Global kill switch + per-workspace kill switch | `server/discipline/circuitBreaker.ts` |
| 2 | Trade limits | Max trades/day, max consecutive losses, cooldown after stop | `server/discipline/tradeLimits.ts`, `cooldowns.ts` |
| 3 | Time windows | Pre-open lockout, post-close lockout, event blackout windows | `server/discipline/timeWindows.ts` |
| 4 | Pre-trade gate | Signal quality (`prob ≥ 0.65`, RR ≥ 1.5, upside percentile ≥ 60), open-position cap | `server/discipline/preTradeGate.ts` |
| 5 | Sizing | L6 lot computation: equal allocation per V2 D2 (Option D); upgrade path = T16 confidence-weighted | `server/discipline/sizing.ts` |
| 6 | Journal | Write-through audit of every signal + decision + fill | `server/discipline/journal.ts` (writes to MongoDB) |
| 7 | Weekly review | Monday-morning per-instrument scorecard pushed to UI + Telegram | `server/discipline/weeklyReview.ts` |
| 8 | Capital protection | Daily profit cap (+5% default), daily loss cap (−2% default), session-halt latching, carry-forward evaluation, grace state machine | `server/discipline/capitalProtection.ts` + `capitalProtectionScheduler.ts` |

`validateTrade()` runs Modules 1 → 4 in sequence; the first rejection short-circuits. Module 5 runs only if all gates pass (sizing the approved trade). Modules 6 / 7 / 8 are observers that run on lifecycle events, not at gate time.

## 4. Module 8 — capital protection in detail

The trickiest module because it has to span trading days and handle the carry-forward decision.

**Daily caps.** Module 8 receives a P&L push from Portfolio on every fill (`recordTradeOutcome` endpoint). On each push it computes `dailyPnlPercent` against the opening capital and checks two thresholds:

- `dailyPnlPercent >= profitCapThreshold` → latch profit cap, fire grace.
- `dailyPnlPercent <= -lossCapThreshold` → latch loss cap, fire grace.

Both caps are **latched** — the signal fires once per trigger per day. Subsequent fills don't re-fire even if you cross the threshold a second time.

**Session halt** blocks new entries on the affected exchange (NSE / MCX) until the next trading day. Exits still go through (you can always close). The halt is per-exchange because NSE closes 15:30 IST while MCX runs to 23:30 IST — a halt at 15:16 IST on NSE shouldn't lock down MCX.

**Carry-forward evaluation** runs on a per-exchange cron (NSE 15:15 IST / MCX 23:15 IST). For every open position at that time:

1. Pull current P&L from Portfolio.
2. Pull momentum score from RCA monitor.
3. Pull IV percentile from `ivClassifier.ts`.
4. Compute days-to-expiry.

Evaluate 4 conditions (all must pass):
- C1: `pnl_percent >= minHoldPnlPct`
- C2: momentum still aligned with position direction
- C3: IV in "fair" or "cheap" band (not "expensive" — premium peaked)
- C4: `days_to_expiry >= minDte`

**Any condition fails → MUST_EXIT** dispatched to RCA. RCA sends the exit to TEA via `disciplineRequest({scope: {kind: "TRADE_IDS", tradeIds: […]}})`. All-pass → position carries overnight.

**Grace period** — when a cap or carry-forward fail fires, Discipline starts a 30 s timer (`setTimeout`). The operator gets a UI prompt: `EXIT_ALL` / `EXIT_INSTRUMENT` / `REDUCE_EXPOSURE` / `HOLD` / TIMEOUT. If no action by deadline, the timer fires `EXIT_ALL` automatically. The user-action endpoint (`discipline.submitUserAction` tRPC proc) is spec'd; the grace state + timer code exists; the UI panel wiring is partial.

## 5. RiskControlAgent — real-time monitoring

RCA runs a 30 s polling loop over every channel in `riskControl.channels` config (default: `ai-paper` only). For each open position it evaluates four triggers:

| Trigger | Default | Action |
|---|---|---|
| **Age** | 30 min since entry | EXIT (time stop) |
| **Stale price** | 5 min without a fresh tick | EXIT (broker/feed health concern) |
| **Momentum flip** | calibrated direction inverts vs entry | EXIT (signal reversal) |
| **Vol threshold** | realised-vol breaches per-instrument band | EXIT (regime change) |

**Discipline signals always win.** When DA dispatches `disciplineRequest({...})`, RCA treats it as non-negotiable — skips trigger evaluation, immediately emits the exit to TEA with `exitTriggeredBy: "DISCIPLINE"`. Same path for `MUST_EXIT` from cap latches and from carry-forward failures.

**BROKER_DESYNC counter** is wired as a stub (`desyncTimestamps` map collects events) but doesn't fire a threshold-based halt yet. Tracked as [T45 [BSA]](../PROJECT_TODO.md).

## 6. Charges model

`Charges_Spec_v0.1`. Pre-trade preview when a signal is sized + post-trade reconcile when the broker confirms the actual charges. Components:

- Brokerage (per-broker tariff — flat per order for Dhan).
- STT / CTT (exchange-side statutory).
- Exchange transaction fee.
- GST on (brokerage + exchange fee).
- Slippage penalty — **Option B in production**: a fixed per-strike-distance penalty in `slippage_pct_per_strike_distance` per instrument (NIFTY 0.3 % / BANKNIFTY 0.5 % / CRUDE 1.0 % / NATGAS 1.5 %).

**Cost-floor buffer** per instrument (`cost_floor_buffer_pct`): NIFTY 20 % / BANKNIFTY 25 % / CRUDE 35 % / NATGAS 40 %. Pre-trade gate blocks a signal if `predicted_TP_pts < cost_floor_pts`. The hard veto is spec'd in V2 §2.4 D6 but **not currently enforced by the gate** — `T8` tracks the migration from TP-floor (Option B) to EV-floor (Option D) once calibration is trusted enough to make the EV math meaningful.

**Post-trade reconcile** (broker-charges-vs-estimator diff) is documented in the spec but not implemented. Low priority — broker bills are reliable.

## 7. L7 risk controls (V2 §2.7) — currently UNDER-IMPLEMENTED

The four locked V2 risk decisions:

| Decision | Status |
|---|---|
| **D7 layer cap** — per instrument: at most 1 swing + 1 trend + 1 scalp concurrent. Always enforced (not gated by any flag). | **NOT IMPLEMENTED**. Generic `maxOpenPositions` is in code but it's a global counter, not layer-aware. A scalp + swing on NIFTY would both fire today. |
| **Q1 shared daily-loss budget** — scalp + trend + swing share the same daily-loss budget per instrument. | **NOT IMPLEMENTED**. Module 8 tracks combined P&L percent but doesn't split per layer for visibility. |
| **Swing entry cutoff** — no new swing entries after 13:30 IST (NSE) / 21:30 IST (MCX). Soft, togglable via `risk_limits_enabled`. | **NOT IMPLEMENTED**. No time-of-day check on `head_type='swing'` signals. |
| **D5 expiry-day cutoff** — no new entries after 14:30 IST on expiry day. | **NOT IMPLEMENTED**. No `is_expiry_day && hour >= 14:30` check. |
| **Event blackout** — Tier-1 (RBI / Budget / Election / FOMC) = hard `trading_allowed=0`. Tier-2 (GDP / CPI / expiry) = feature input only. | **NOT IMPLEMENTED**. Discipline reads `event_calendar.json` for blackout windows but the config + enforcement plumbing isn't wired through. |

All four of these gaps are bundled into [T31 [DISC]](../PROJECT_TODO.md), tagged PRE-PAPER MUST, ~2–3 days. **This is the single most important Risk & Discipline gap before paper trade**.

## 8. Q1 LOCKED decisions (for quick reference)

From V2_MASTER_SPEC §2.6 / §2.7:

- **L6 D2 sizing:** equal allocation per layer (Option D), `lots = base_capital / contract_value`. Upgrade path = T16 confidence-weighted.
- **L7 Q1 daily-loss budget:** shared across all layers per instrument.
- **L7 D7 concurrent cap:** 1 swing + 1 trend + 1 scalp per instrument (always enforced).
- **L7 Q2 max signals/day:** 5 (scalp + trend) + 2 (swing) = 7 per instrument.
- **L7 swing entry cutoff:** 13:30 IST NSE / 21:30 IST MCX (soft, togglable).
- **L7 D5 expiry-day:** no entries after 14:30 IST.
- **Cost-floor buffer pct:** NIFTY 20 % / BANKNIFTY 25 % / CRUDE 35 % / NATGAS 40 %.

## 9. Status

**ACTIVE.**
- DisciplineAgent v1.4 — Modules 1–8 all in code. Module 8 capital protection live since 2026-05-03.
- RCA v2.0 — Phase 2 monitoring (4 exit triggers) wired. Discipline-signal priority enforced.
- Charges v0.1 — pre-trade Option B in production. Post-trade reconcile spec'd, deferred.

**Critical gaps before paper trade:**
- [T31 [DISC]](../PROJECT_TODO.md) PRE-PAPER MUST — layer cap + swing cutoff + shared daily-loss + expiry-day cutoff + event blackout. ~2–3 days.
- [T45 [BSA]](../PROJECT_TODO.md) PRE-AI-LIVE — BROKER_DESYNC counter / DesyncReconciler position-compare.

**Deferred (post-calibration / post-paper-fills):**
- [T8](../PROJECT_TODO.md) — cost-floor migration (TP-floor B → EV-floor D). Gated on T25 calibration + reliability validation.
- [T10](../PROJECT_TODO.md) — recalibrate `slippage_pct_per_strike_distance` from real fills (≥ 100 paper fills per instrument).
- [T11](../PROJECT_TODO.md) — slippage Option B → C (volume-conditional). Same trigger as T10.
- [T16](../PROJECT_TODO.md) — confidence-weighted sizing. Gated on reliability check.
- [T18](../PROJECT_TODO.md) — volatility-adaptive thresholds. Gated on ≥ 4 weeks paper data.
- Charges post-trade reconciliation — low-priority, post-paper.
- Grace-period user-action endpoint (`discipline.submitUserAction`) — UI panel wiring missing; gated on T31.

## 10. Test coverage

TypeScript suites under `server/discipline/__tests__/` and `server/risk-control/__tests__/`:

- Each of the 8 Discipline modules has at least one unit test.
- `capitalProtection.test.ts` covers cap latching, grace timer expiry, carry-forward 4-condition evaluation.
- RCA monitor tests cover each of the 4 exit triggers + Discipline-signal-wins-over-own-trigger.
- Integration test for the `validateTrade → evaluate → submitTrade` chain on the happy path.

## 11. Cross-refs

- [04 Signal Engine](04_signal_engine.md) — upstream producer; signals come through Discipline first.
- [05 Execution](05_execution.md) — TEA receives approval / rejection / MUST_EXIT.
- [07 Portfolio & Reporting](07_portfolio_reporting.md) — P&L push source + position-state authority used by carry-forward.
- [PROJECT_TODO.md](../PROJECT_TODO.md) — T31 (PRE-PAPER MUST), T45 (PRE-AI-LIVE), T8 / T10 / T11 / T16 / T18 deferred.

## 12. Code locations

| What | Path |
|---|---|
| Discipline agent root + validateTrade | `server/discipline/index.ts` |
| Module 1 circuit breaker | `server/discipline/circuitBreaker.ts` |
| Module 2 trade limits + cooldowns | `server/discipline/tradeLimits.ts`, `cooldowns.ts` |
| Module 3 time windows | `server/discipline/timeWindows.ts` |
| Module 4 pre-trade gate | `server/discipline/preTradeGate.ts` |
| Module 5 sizing | `server/discipline/sizing.ts` |
| Module 6 journal | `server/discipline/journal.ts` |
| Module 7 weekly review | `server/discipline/weeklyReview.ts` |
| Module 8 capital protection | `server/discipline/capitalProtection.ts` |
| Module 8 carry-forward scheduler | `server/discipline/capitalProtectionScheduler.ts` |
| RCA monitor + endpoints | `server/risk-control/index.ts` |
| IV classifier (carry-forward C3) | `server/risk-control/ivClassifier.ts` |
| Charges model | `server/charges/index.ts` (or equivalent — search `slippage_pct_per_strike_distance`) |
| Python RCA HTTP client (SEA side) | `python_modules/signal_engine_agent/risk_control_client.py` |
| Tests | `server/discipline/__tests__/`, `server/risk-control/__tests__/` |
