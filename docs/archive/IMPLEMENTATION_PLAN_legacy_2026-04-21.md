> **⚠ ARCHIVED 2026-04-27 — No longer the source of truth.**
>
> Active sources:
> - **Build sheet:** `docs/IMPLEMENTATION_PLAN_v2.md` (phased tasks, acceptance, dependencies)
> - **Punch list:** `docs/FINAL_VERIFICATION_TRACKER.md` (728 findings; §7 is the consolidated Definition of Done)
> - **Architecture reference:** `docs/ARCHITECTURE_REFACTOR_PLAN.md` (kept active)
>
> **Why archived:** §0 completion percentages were materially wrong (claimed PA/TEA/RCA = 0%; reality PA ≈ 85%, TEA ≈ 85%, RCA ≈ 30%). §5 Locked Decisions were tied to retired branch names (`ui-refactoring`) and sequencing assumptions that the actual code state has overtaken.
>
> **What's still useful here:** §3 cross-cutting backlog (post-MVP polish ideas — weekly perf review, trade timer, partial-fill handling, NSE futures rollover, WS push, fb_ columns, etc.) and the §8 change log. Mine for ideas; do not treat as live commitments.

---

# Consolidated Implementation Plan — Single Source of Truth

**Status:** Draft v1 · 2026-04-21 · supersedes [todo.md](../todo.md)
**Scope:** All work required to go from current `ui-refactoring` state → a production-ready ATS that executes live Dhan trades with Discipline + RCA gates and capital protection.

This document is derived from:
- Specs in [docs/specs/](specs/) (15 files, ~11K lines)
- Detailed audits: [audit_trading_execution.md](audit_trading_execution.md), [audit_broker_capital.md](audit_broker_capital.md), [audit_ui.md](audit_ui.md), [audit_data_pipeline.md](audit_data_pipeline.md)
- Project memory (running-system state, known discrepancies, pending items)
- Existing [todo.md](../todo.md) checklist

Everything checked against actual code on branch `ui-refactoring` as of commit `7070745` (post-cleanup).

---

## 0. System Completion Snapshot

| Subsystem | Built % | Remaining risk | Notes |
|---|---|---|---|
| TFA (live recording + replay) | **~90%** | L | 4 instruments recording; corruption fix in place; MCX rollover handled |
| MTA (model training) | **~45%** | M | 3-of-15 targets trained only; no promotion gate; SHAP/importance pruning deferred |
| SEA (signal engine) | **~60%** | M | 4-stage filter working on MVP thresholds; uses file-tail instead of Unix socket; Phase-2 discipline/RCA integration not built |
| Broker Service (BSA) | **~95%** | S | 6-channel routing + kill switches + token lifecycle done; margin-sync & sandbox-fill validation still missing |
| Capital Pools | **~92%** | M | 75/25 split, gift days, clawback, projections all built; broker margin coupling missing |
| Discipline Engine (Modules 1-7) | **~88%** | S | Pre-trade gate, cooldowns, time windows, position sizing all wired |
| Discipline Module 8 (capital protection) | **0%** | H | Spec locked; no code; blocks live trading |
| Trade Executor Agent (TEA) | **0%** | H | Spec locked; no code; single broker-call point |
| Risk Control Agent (RCA) | **0%** | H | Spec locked; no code; owns SL/TP/TSL + exit matrix |
| Portfolio Agent | **0%** | H | Spec locked; no code; single position/P&L owner |
| UI — MainScreen | **~75%** | M | Layout built; hotkeys broken; module heartbeats missing |
| UI — TradingDesk | **~71%** | M | Functional; approved 6+10 redesign not started |
| UI — Settings | **~86%** | M | Most sections wired; Module 8 section missing |
| Feedback Loop (Phases 3-6) | **0%** | Deferred | Requires Portfolio Agent + RCA first |

**Critical blockers for live trading:** Discipline Module 8, TEA, RCA, Portfolio Agent.

---

## 1. Architecture — Target Trade Flow

```
SEA (Python)
  │ produces TradeSignal: LONG_CE / LONG_PE / SHORT_CE / SHORT_PE + entry/SL/TP
  │
  ▼
Discipline Engine (Module 4 Pre-Trade Gate) — tRPC discipline.validateTrade
  │ policy checks: time windows, trade limits, cooldowns, position size, exposure, caps
  │
  ▼
Risk Control Agent — POST /api/risk-control/evaluate
  │ approve/reject/reduce-size, sizing, SL/TP override if needed
  │
  ▼
Trade Executor Agent — POST /api/executor/submitTrade
  │ SOLE caller of brokerService; idempotent execution IDs
  │
  ▼
Broker Service → Dhan / Mock
  │ places order, fills, SL/TP management
  │
  ▼
Portfolio Agent — POST /api/portfolio/recordTradePlaced
  │ owns all position state + P&L
  │
  ▼ on trade close
Discipline Engine Module 8 — POST /api/discipline/recordTradeOutcome
  │ updates daily P&L; triggers caps / carry forward if crossed
  │
  ▼ if cap hit / carry-forward fails
RCA exit path — exit all / partial / reduce (via Module 8 grace flow)
```

**Enforcement invariants:**
1. Only TEA calls the broker.
2. Only Portfolio Agent writes position state.
3. Only RCA modifies live SL/TP/TSL.
4. Discipline is policy (static); RCA is risk (adaptive). Exit precedence: Discipline > RCA > AI signal.
5. Paper vs live handled in RCA & TEA; BSA routes via 6-channel workspace.

---

## 2. Implementation Phases

Phases are sequenced by dependency. Within a phase, items can be parallelized unless called out.

### PRIORITY 0 — TradingDesk Redesign (6+10)  *(user-locked: do first before Phase 1)*

Approved redesign per memory [project_tradedesk_redesign.md](../../.claude/projects/c--Users-Admin-ai-development-ai-development/memory/project_tradedesk_redesign.md). Ships before any Phase 1 work per Decision 5.

- [ ] **Summary bar:** 10 items → 6: Day #/250, Capital, Today P&L+target%, Cum profit, Net worth, NET|GROSS toggle. Remove Available (same as Capital), Charges (move to tooltip), Reserve (show in pools panel only).
- [ ] **Table:** 15 columns → 10: `#`, Date, Capital, Target, Trades, P&L, Charges, End Cap, vs Plan, Status. Remove Proj+ (replaced by vs Plan delta), Entry/LTP/Qty (only in today's expanded row), Rating (replaced by objective Status), Dev. (merged into vs Plan).
- [ ] **Today row expands** to show individual trade sub-rows (inline CE/PE/qty/entry/LTP/P&L).
- [ ] Update colgroup widths and regression-test all 3 workspaces (live / AI / testing).
- [ ] Detailed task breakdown to happen when work starts.

---

### PHASE 1 — Foundations for Execution (~2 weeks)
Must-land before any live-trading path works. Starts after Priority 0 ships.

#### 1.1 Portfolio Agent  `L`  *(Risk blocker)*
Spec: [PortfolioAgent_Spec_v1.3.md](specs/PortfolioAgent_Spec_v1.3.md) · Audit: [audit_trading_execution.md](audit_trading_execution.md)

**Data model (Mongo):**
- [ ] `portfolio_positions` collection: position_id, instrument, direction, qty, entry_price, current_price, sl, tp, tsl, environment (paper/live), status, exit_triggered_by, opened_at, closed_at
- [ ] `portfolio_trade_outcomes` collection: trade_id, instrument, exit_reason, realized_pnl, realized_pnl_percent, duration, exit_triggered_by, closed_at
- [ ] `portfolio_state` collection: daily realized/unrealized P&L, capital_available, margin_used, total_exposure

**REST endpoints (called by TEA only):**
- [ ] POST `/api/portfolio/recordTradePlaced`
- [ ] POST `/api/portfolio/recordTradeUpdated`
- [ ] POST `/api/portfolio/recordTradeClosed` — **emits push to Discipline.recordTradeOutcome**
- [ ] POST `/api/portfolio/recordExitRequest`

**Query endpoints (read-only for RCA/Discipline/UI):**
- [ ] GET `/api/portfolio/state`
- [ ] GET `/api/portfolio/positions?status=open`
- [ ] GET `/api/portfolio/metrics`
- [ ] GET `/api/portfolio/tradeOutcomes?since=...`

**tRPC mirror:** `trpc.portfolio.state/positions/metrics/outcomes` for UI reads.

**Tests:** 20+ unit on position lifecycle, P&L calc, exposure math; 5+ integration with Mongo.

---

#### 1.2 Trade Executor Agent (TEA)  `L`
Spec: [TradeExecutorAgent_Spec_v1.3.md](specs/TradeExecutorAgent_Spec_v1.3.md) · Plan: [TradeExecutorAgent_ImplementationPlan_v1.2.md](specs/TradeExecutorAgent_ImplementationPlan_v1.2.md)

- [ ] Create `server/executor/` folder with dedicated logger (`[TradeExecutor]` prefix)
- [ ] `submitTrade` — receives TradeApprovalResponse from RCA, generates executionId, idempotency check, calls `brokerService.placeOrder()`, updates Portfolio Agent. Paper vs live routing via channel.
- [ ] `modifyOrder` (live only) — SL/TP/TSL modifications via `brokerService.modifyOrder()`
- [ ] `exitTrade` — cancels pending SL/TP orders, places SELL, updates Portfolio. Market order. Records `exit_triggered_by`.
- [ ] Broker event handler — `orderUpdateEvent`, `tradeClosedEvent` (SL/TP auto-fire on live); pushes to Portfolio.
- [ ] **DISCIPLINE_EXIT priority** — highest priority, market order, retry-once.
- [ ] Idempotent execution IDs (Mongo `executor_executions` collection).
- [ ] Zero direct broker calls from anywhere else — enforce via lint rule or module-boundary test.

**Tests:** 25+ unit (submit/modify/exit/retry/idempotency); 10+ integration with Mock adapter.

---

#### 1.3 Risk Control Agent (RCA)  `L`
Spec: [RiskControlAgent_Spec_v2.0.md](specs/RiskControlAgent_Spec_v2.0.md)

- [ ] Create `server/risk-control/` folder
- [ ] **Entry approval** `POST /api/risk-control/evaluate` — validates against current capital/portfolio/volatility; sizes position; overrides SL/TP if needed; returns APPROVE / REDUCE_SIZE / REJECT / REVIEW
- [ ] **Real-time monitoring loop** (every 1-5s, configurable) for all open positions:
  - SL/TP detection (paper mode: RCA detects; live: broker detects, RCA mirrors)
  - Momentum exit (score < threshold)
  - Age exit (trade_age > N minutes)
  - Volatility spike → TIGHTEN_SL
  - Trend breakout → EXTEND_TP or enable TSL
- [ ] **Discipline signal handler** `POST /api/risk-control/discipline-request` — accepts MUST_EXIT / PARTIAL_EXIT, honors highest priority
- [ ] **AI signal handler** `POST /api/risk-control/ai-signal` — receives SEA signals; RCA validates against current market state before executing
- [ ] **Paper vs live awareness** — separate lifecycle management per workspace channel
- [ ] Exit Matrix enforcement: Discipline > RCA own rules > AI signal
- [ ] Emits all executions via TEA only (no direct broker calls)

**Tests:** 30+ unit (approval logic, monitoring loop, exit matrix, paper/live branches); 10+ integration with TEA + Portfolio.

---

#### 1.4 Discipline Engine Module 8  `L`
Spec: [DisciplineEngine_Spec_v1.3.md §11](specs/DisciplineEngine_Spec_v1.3.md)

Extends existing `server/discipline/` with capital-protection module.

**Data model additions:**
- [ ] `DisciplineState` adds: `dailyProfitCap`, `dailyLossCap`, `sessionHalted`, `sessionHaltReason`, `graceDeadline`, `userResponded`, `userAction`, `userActionDetail`, `carryForwardEvaluation`, `dailyRealizedPnlHistory`, `exitSignalsSent`
- [ ] `DisciplineSettings.capitalProtection`: dailyProfitCap {enabled, thresholdPercent}, dailyLossCap {enabled, thresholdPercent}, gracePeriodSeconds, carryForward {enabled, evaluationTime}

**Logic modules:**
- [ ] Daily profit cap detector (+5% default; latched)
- [ ] Daily loss cap detector (-2% default; latched)
- [ ] Session halt flag — blocks pre-trade gate
- [ ] Grace period timer (30s default) with user intervention panel
- [ ] **Background monitor** that fires MUST_EXIT if user doesn't respond before deadline
- [ ] Carry forward engine — 15:15 IST scheduled job, evaluates 4 conditions (profit≥15% + momentum≥70 + IV fair + DTE≥2)
- [ ] Session reset at 9:15 AM IST daily

**New API endpoints:**
- [ ] POST `/api/discipline/requestExit` (inter-service → RCA)
- [ ] POST `/api/discipline/exitSignalAcknowledge` (RCA → Discipline callback)
- [ ] tRPC: `discipline.getSessionStatus` (query), `discipline.evaluateCarryForward` (mutation — testing), `discipline.recordTradeOutcome` (mutation — Portfolio push), `discipline.submitUserAction` (mutation — UI)

**Scheduled jobs:**
- [ ] Cron/Bull queue for 15:15 IST carry forward evaluation (timezone-aware)
- [ ] Background grace deadline checker

**Tests:** 35+ unit (caps, carry forward, grace flow, session halt); 10+ integration with RCA; E2E scenarios per spec.

---

#### 1.5 Cross-agent wiring  `M`
- [ ] Portfolio → Discipline push (on every trade close)
- [ ] Discipline → RCA MUST_EXIT signals
- [ ] SEA → Discipline `validateTrade` pre-trade check (replaces absent "Decision Engine")
- [ ] TEA → Portfolio updates on every state change
- [ ] Integration test: full trade flow SEA → Discipline → RCA → TEA → Broker → Portfolio → Discipline

---

### PHASE 2 — Broker/Capital Hardening (~1 week, parallel with Phase 1)

#### 2.1 Broker Service gaps  `S`
Audit: [audit_broker_capital.md](audit_broker_capital.md)

- [ ] Sandbox fill validation — enforce ₹100 fills in sandbox mode (BSA spec compliance)
- [ ] Telegram notification reliability (hard-fail if env vars declared but absent; don't silently skip)
- [ ] 6-channel isolation integration test — prevent ai-live orders leaking into my-paper
- [ ] Token refresh race test — simultaneous 401 + token endpoint read via `_inflightRefresh`

#### 2.2 Capital ↔ Broker margin sync  `M`
- [ ] `GET /api/capital/availableCapital` → consults BSA `getMargin()` before sizing
- [ ] Position sizing pre-check — reject trade if broker margin < required
- [ ] Workspace → Channel mapping doc (live → ai-live + my-live, paper → ai-paper + my-paper, testing → testing-sandbox)
- [ ] Broker → Capital integration test: trade placed → filled → capital updated → projections recalculated

#### 2.3 Session reset boundary  `S`
- [ ] Detect market open/close in server scheduler (IST-aware)
- [ ] Reset session trade count + P&L at NSE + MCX opens
- [ ] Daily summary emit at combined market close (log + optional Telegram)

---

### PHASE 3 — UI Parity with Specs (~1 week, parallel with Phase 1-2)

Audit: [audit_ui.md](audit_ui.md)

#### 3.1 MainScreen — hotkeys + heartbeats  `M`
Spec: [MainScreen_Spec_v1.2.md](specs/MainScreen_Spec_v1.2.md)

- [ ] **Fix hotkey system** — `useHotkeyListener` currently blocks modifiers. Wire Ctrl+D (Discipline overlay), Ctrl+S (Settings), Ctrl+J (Journal — see 3.4), [ ] (prev/next instrument), Esc (close overlay)
- [ ] AppBar module heartbeat dots: FETCHER (TFA), ANALYZER (SEA), AI ENGINE (MTA), EXECUTOR (TEA) — pull from `/api/trading/moduleStatuses`
- [ ] Replace hardcoded gold price/change in SummaryBar with API (or remove if gold is out-of-scope)
- [ ] Footer: monthly growth, upcoming holidays, discipline score, net worth

#### 3.2 Settings — Module 8 section  `M`
Spec: [Settings_Spec_v1.4.md §3.3](specs/Settings_Spec_v1.4.md)

- [ ] Add **Capital Protection** card under Discipline section with 6 params:
  - Daily profit cap enabled + threshold (default 5%)
  - Daily loss cap enabled + threshold (default 2%)
  - Grace period seconds (default 30)
  - Carry forward enabled + evaluation time (default 15:15 IST)
- [ ] Wire to `discipline.updateSettings` mutation (already exists on server side)

#### 3.3 TradingDesk redesign  —  *moved to Priority 0 (ships before Phase 1 per Decision 5)*

#### 3.4 Journal  —  *deferred post-MVP per Decision 2*
Rebuild as Mongo-backed page + Ctrl+J hotkey after Phase 1 ships. Module 6 journal-enforcement rules (block-after-N-unjournaled) stay inactive until then.

#### 3.5 Module 8 UI — Intervention Panel  `L`
Spec: [DisciplineEngine_Spec_v1.3.md §11.5](specs/DisciplineEngine_Spec_v1.3.md). Requires Phase 1.4 (Module 8 backend) done first.

- [ ] Full-screen overlay when daily cap trips
- [ ] Four actions: Exit All / Exit by Instrument / Reduce Exposure / Hold
- [ ] Grace countdown timer
- [ ] Wire to `discipline.submitUserAction`

#### 3.6 Live SEA signal feed  `S`
Currently RightDrawer shows mock signals.
- [ ] Wire to `/api/trading/seaSignals` (already exists) via tRPC or poll

---

### PHASE 4 — MTA Hardening (~1 week)

Audit: [audit_data_pipeline.md](audit_data_pipeline.md)

#### 4.1 Val-split widening + NaN guard  `S`  ✅ **DONE — merged to `main` commit `15fa7ea` 2026-04-22**

**Problem observed (2026-04-21 BANKNIFTY run):** walk-forward split used the smallest day as val. That day (435 rows) had single-class labels for 300s and 900s direction targets → `roc_auc_score` returned NaN.

**Shipped (on `main` only, not `ui-refactoring`):**
- [x] Widen val to last `N` chronological days (CLI `--val-days`, default 3, capped at `total_days // 2`).
- [x] Degenerate-val guard for binary targets — skip training + record `{skipped: true, reason: ...}` in metrics.json when `y_val` has one class.
- [x] Training manifest now emits `val_dates` (list), `trained_count`, `skipped_targets`.
- [x] `upside_percentile_30s` silent drop (discovered via the guard) is now explicitly logged.
- [ ] Unit test for guard trigger — deferred to Phase 4.4 promotion validator work.
- [ ] Verify on tomorrow's training run that `direction_300s` / `direction_900s` score cleanly or are skipped with clear reason.

#### 4.2 28-target re-replay + retrain  `L`
Per memory: pending. Target-set stabilized at 28 (7 target types × 4 windows — confirmed from [metrics.json](../models/banknifty/20260421_200603/metrics.json) 2026-04-21).

- [ ] Re-replay existing `data/raw/{date}/` into current 384-column Parquet (adds 5min + 15min windows beyond old 370-col format if any legacy files remain)
- [ ] Train all 28 target models per instrument (direction / direction_magnitude / max_upside / max_drawdown / avg_decay_per_strike / total_premium_decay / risk_reward_ratio — each × 30s/60s/300s/900s windows)
- [ ] Validate feature schema stability across preprocess layers
- [ ] **Must run after 4.1** so val metrics are reliable.

#### 4.3 Feature importance pruning (Step 7)  `M`
- [ ] Compute SHAP importance on trained models
- [ ] Prune low-importance columns; relock feature config (337 → ~80-120 per [metrics.json](../models/banknifty/20260421_200603/metrics.json) current count)
- [ ] Retrain with pruned feature set
- [ ] Atomic update: train-all-28 + update config + update LATEST in one transaction

#### 4.4 LATEST promotion validator  `M`
- [ ] Metrics threshold gate — reject LATEST update if val AUC / R² regresses vs current LATEST
- [ ] `--force-promote` flag override
- [ ] metrics.json + training_manifest.json artifacts (already partially emitted; extend with pre/post AUC deltas)
- [ ] Checkpoint resumption (trainer stops/resumes on interrupt)

#### 4.5 SEA threshold upgrade  `S`
- [ ] Implement 3-condition gate (prob ≥0.65 + RR ≥1.5 + upside_percentile ≥60) per spec, replacing MVP direction-only threshold

---

### PHASE 5 — Feedback Loop (deferred, ~4 weeks, enable after Phases 1-4 stable)

Depends on Portfolio Agent being live.

#### 5.1 Outcome recording (Phase 3 per spec)  `M`
- [ ] Tag every SEA-originated signal with `signal_id`
- [ ] Portfolio closes trade → emit outcome event with signal_id linkage
- [ ] Store in `signal_outcomes` collection: signal_id, predicted, actual, pnl, exit_reason

#### 5.2 Win rate analysis (Phase 4)  `M`
- [ ] Aggregation: win rate per signal type (LONG_CE / LONG_PE / SHORT_CE / SHORT_PE)
- [ ] Rolling 7-day / 30-day windows
- [ ] Dashboard: win rate trend + correlation with discipline score

#### 5.3 Automated retrain trigger (Phase 5)  `L`
- [ ] Monitor win rate; if drops below threshold (e.g. -10% from rolling mean), queue MTA retrain
- [ ] Trained model must pass validator before promotion

#### 5.4 Meta-model gatekeeper (Phase 6)  `XL`
- [ ] Ensemble that votes on which of 15 targets to trust per tick
- [ ] Can reject all 15 → WAIT

---

### PHASE 6 — Observability & Operational Hardening (continuous)

#### 6.1 Metrics
- [ ] Prometheus/custom metrics across TEA, RCA, Portfolio, Discipline
- [ ] Latency: SEA signal → TEA submit → broker ack
- [ ] Counters: trades attempted/accepted/rejected per reason

#### 6.2 Structured logs
- [ ] Align all TS agents to TFA-style JSON logs (ts, level, agent, event, context)
- [ ] Central log aggregation path

#### 6.3 Runtime-test strategy (per [project_dhan_ws_limit.md](../../.claude/projects/c--Users-Admin-ai-development-ai-development/memory/project_dhan_ws_limit.md))
- [ ] Mock adapter path for ui-refactoring branch validation (never hits Dhan WS)
- [ ] Pre-merge gate: `pnpm check` + `pnpm test` + mock-adapter end-to-end scenario
- [ ] Runtime validation only after merge to main (which becomes the live recorder)

#### 6.4 Recovered gzip files  `S`
- [ ] Decide: replay should prefer `.recovered.ndjson.gz` over corrupt originals
- [ ] Delete canonical corrupts once recovered versions proven

---

## 3. Cross-cutting Backlog (unsorted by phase)

Small items that don't map cleanly to a phase but are needed somewhere before production.

### Naming / consistency
- [ ] `nifty` vs `nifty50` parquet filename mismatch — per [reference_paths_and_naming.md](../../.claude/projects/c--Users-Admin-ai-development-ai-development/memory/reference_paths_and_naming.md); fix `replay_runner.py` to use profile-key not lowercased name. *(Confirmed fixed per data-pipeline audit — verify and close.)*

### Data pipeline follow-ups
- [ ] Per-strike option-tick timeout monitoring — `option_tick_timeout_sec` loaded but unused; data quality flag never fires
- [ ] Contract rollover for NSE futures (monthly) — add runtime contract-id resolver similar to MCX fix
- [ ] Feedback emitter `fb_` columns (15 cols) integrated into feature pipeline — Phase 5 prerequisite

### Discipline Engine (beyond Module 8)
- [ ] Weekly performance review gate (Monday 9:00 AM enforcement)
- [ ] 3-consecutive-red-weeks → auto-reduce position size 50%
- [ ] Monthly discipline score trend chart
- [ ] Correlation overlay: discipline score vs P&L

### TradingDesk extras
- [ ] Trade timer on open positions (live running timer)
- [ ] Risk indicator per trade (colored dot by % of capital)
- [ ] Keyboard nav in table (↑↓ rows, N new trade, Esc cancel, Enter confirm, T jump to today)
- [ ] Floating "Jump to Today" button

### Charges system  `M`
- [ ] Daily auto-check for Dhan/NSE/BSE rate changes
- [ ] Alert on any charge change (old → new, effective date, source)
- [ ] Versioned rate history in Mongo (never overwrite)

### Error handling
- [ ] Dhan API down blocker — blocking alert prevents trading, footer indicator
- [ ] Partial fill handling in table
- [ ] Failed exit order alert

### Real-time WS push (low priority)
- [ ] Replace 3s REST polling with WebSocket push for lower UI latency

---

## 4. Dependencies & Sequencing

```
✅ Phase 4.1 (val-split + NaN guard) — done on main

Priority 0: TradingDesk redesign ──► (on ui-refactoring)
                    │
                    ▼
Phase 4.2-4.5 (retrain / SHAP / promotion validator / SEA threshold)
                    │
                    ▼
Phase 1.1 Portfolio Agent ─┬─► Phase 1.2 TEA ──┐
                           │                    ├─► Phase 1.5 Wiring ──► Phase 5 Feedback Loop (post-MVP)
                           └─► Phase 1.3 RCA ───┤
                                                │
                  Phase 1.4 Discipline Module 8 ┘

Phase 2 Broker/Capital hardening — parallel with Phase 1
Phase 3 UI — parallel with Phase 1 (except 3.5 Module 8 UI needs 1.4; 3.3 moved to Priority 0; 3.4 deferred)
Phase 5 Feedback Loop — deferred post-MVP; requires 1.1 + 1.3 + 4 done + ~2-4 weeks live data
Phase 6 Observability — continuous
```

---

## 5. Locked Decisions  *(as of 2026-04-22)*

All six sequencing decisions are locked. No further input needed before starting execution.

| # | Decision | Locked answer |
|---|---|---|
| 1 | **Phase 1 agent order** | Portfolio → TEA → RCA → Discipline Module 8 |
| 2 | **Journal feature** | Defer — rebuild Mongo-backed page + Ctrl+J after Phase 1 ships |
| 3 | **Runtime test strategy** | Mock-only pre-merge on `ui-refactoring`; real Dhan validation post-merge on `main` |
| 4 | **Feedback loop (Phase 5)** | Post-MVP — ship Phase 1-4, run live with manual monitoring for 2-4 weeks to accumulate real signal outcomes, then build Phase 5 on top |
| 5 | **TradingDesk redesign (6+10)** | **Priority 0 — ships before Phase 1** (see top of §2) |
| 6 | **MTA retrain timing** | Val-split patch shipped to `main` immediately (done — commit `15fa7ea`); full Phase 4 runs **before** Phase 1 on `ui-refactoring` |

### Effective execution order

1. ✅ **Done** — Val-split patch on `main` (Phase 4.1)
2. **Priority 0** — TradingDesk redesign (6+10) on `ui-refactoring`
3. **Phase 4 continuation** — 28-target retrain, SHAP pruning, promotion validator, SEA threshold upgrade (on `ui-refactoring`, since MTA code changes flow with the refactor branch going forward)
4. **Phase 1** — Portfolio → TEA → RCA → Module 8
5. **Phases 2 + 3** — parallel with Phase 1 (Broker/Capital polish + UI parity)
6. **Phase 5** — deferred post-MVP

---

## 6. Definition of Done — Production-ready MVP

System is "production-ready" when all of these hold:

1. Live trade flow: SEA signal → Discipline gate → RCA approve → TEA execute → Portfolio record → Module 8 monitor. End-to-end tested with Mock adapter.
2. Discipline Modules 1–8 enforced on every trade; test-covered.
3. Portfolio Agent is sole position/P&L source of truth.
4. TEA is sole broker caller (enforced + tested).
5. RCA monitors every open position in real-time; honors Discipline > own rules > AI.
6. Module 8 caps (2% loss / 5% profit) + carry forward + grace period intervention working.
7. Settings UI exposes every param in the spec.
8. TradingDesk shows all 250 days with today-row expansion.
9. `pnpm check` + `pnpm test` clean.
10. BSA 6-channel isolation verified (ai-live never crosses my-paper).

Stretch / post-MVP: Feedback loop Phases 3-6, meta-model gatekeeper, full observability stack, WS push.

---

## 7. Estimated Scale

| Phase | Effort | Blockers |
|---|---|---|
| Priority 0 (TradingDesk) | ~3 days | Done before Phase 1 |
| Phase 4 remaining (4.2-4.5) | ~1 week | Raw data; 4.1 already done on main |
| Phase 1 (Foundations) | ~2 weeks full-time | Priority 0 + Phase 4 |
| Phase 2 (Broker/Capital) | ~1 week (parallel with Phase 1) | BSA context |
| Phase 3 (UI — excluding 3.3 and 3.4) | ~4 days (parallel with Phase 1) | 3.5 needs 1.4 |
| Phase 5 (Feedback) | ~4 weeks (post-MVP) | Requires 1.1, 1.3, + 2-4 weeks live data |
| Phase 6 (Observability) | Continuous | — |

**MVP timeline (sequential priority 0 + phase 4, then phases 1/2/3 in parallel):** ~4-5 weeks
**Post-MVP (feedback loop + observability polish):** another 4-6 weeks

---

## 8. Change Log

| Date | Change |
|---|---|
| 2026-04-21 | Initial draft from audit of all 15 specs + codebase. Supersedes todo.md as source of truth. |
| 2026-04-22 | All 6 sequencing decisions locked (§5). TradingDesk redesign moved to Priority 0. Phase 4.1 (val-split + NaN guard) shipped to `main` commit `15fa7ea`. Journal deferred post-MVP. Feedback loop post-MVP. Mock-only pre-merge test strategy confirmed. |

---

**Next action:** Start Priority 0 — break down TradingDesk redesign (6+10) tasks + begin implementation on `ui-refactoring`.
