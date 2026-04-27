> **⚠ ARCHIVED 2026-04-27** — roadmap snapshot from 2026-04-21. Active sources: `docs/IMPLEMENTATION_PLAN_v2.md` (build sheet) + `docs/FINAL_VERIFICATION_TRACKER.md` (punch list) + `docs/ARCHITECTURE_REFACTOR_PLAN.md` (architecture). Kept for historical context.

---

# Specs Refactoring Roadmap

**Date:** 2026-04-09 (original) · Revised 2026-04-21
**Status:** Phase 0 Complete ✅ | Phase 1 In Progress
**Version:** 2.0

---

## Overview

This roadmap tracks what was actually delivered for the unified execution architecture. The collapsed model has four live agent specs and no separate Decision Engine spec:

- **UPDATE** 3 specs (RCA → v2.0, TEA → v1.3, Discipline → v1.3)
- **ENHANCE** 1 spec (Portfolio → v1.1)
- **NO** new Decision Engine spec — its responsibilities live in Discipline Modules 4 and 8, with SEA as the upstream signal producer

---

## Phase 0: Spec Refactoring & Planning — Complete

### What was delivered

| Spec | Previous | Delivered | Status |
|---|---|---|---|
| RiskControlAgent | v1.0 (Draft) | **v2.0** | ✅ Done |
| TradeExecutorAgent | v1.1 (Draft) | **v1.3** | ✅ Done |
| DisciplineEngine | v1.1 (Draft) | **v1.3** | ✅ Done |
| PortfolioAgent | v1.0 (Draft) | **v1.1** | ✅ Done |

### What was considered and dropped

- A standalone **Decision Engine** spec was originally planned (v3.0). That agent was eliminated from the architecture; the pre-trade gate and entry timing logic moved to **Discipline Engine Module 4**, capital protection + carry forward moved to **Discipline Engine Module 8**, and AI signal generation stayed in **SEA** (Python). No separate spec is required.

---

## Detailed Spec Changes — What Was Delivered

### 1. RiskControlAgent_Spec_v2.0.md ✅

**Based on:** ARCHITECTURE_REFACTOR_PLAN.md + DISCIPLINE_vs_RCA_CLARITY.md

**Key Sections delivered:**
```markdown
1. Overview — real-time position monitor & risk decision maker
2. Inputs
   ├─ Validated trade request (from Discipline.validateTrade upstream)
   ├─ Market data (WebSocket ticks)
   ├─ Portfolio Agent (position state, P&L) — read-only
   ├─ Discipline Engine (hard rules, MUST_EXIT signals)
   └─ SEA / AI signals (continuous modify/exit requests)

3. Responsibilities
   ├─ Trade approval (validate, size, finalize SL/TP)
   ├─ Real-time monitoring (price vs SL/TP, momentum, volatility)
   ├─ Exit decisions (own rules + external signals)
   ├─ Modification requests (SL/TP/TSL adjustments)
   ├─ Paper vs live context handling
   └─ Receive & validate external requests

4. Paper trade management (RCA owns entry-to-exit)
5. Live trade management (RCA monitors + modifies; broker auto-exits)
6. API contracts
   ├─ /api/risk-control/evaluate
   ├─ /api/risk-control/ai-signal
   └─ /api/risk-control/discipline-request

7. Exit decision matrix (Discipline > RCA own > AI/SEA validated)
8. Testing strategy
```

---

### 2. TradeExecutorAgent_Spec_v1.3.md ✅

**Based on:** TradeExecutorAgent_Spec_v1.2.md + refinements

**Key additions:**
- TradeExecutorAgent is the ONLY module calling the broker (enforced)
- New APIs: `modifyOrder`, `exitTrade`, `getOrderStatus`
- Broker event handling (fills, rejections, SL/TP auto-exit)
- Paper vs live differences (TEA handles paper exits; broker handles live SL/TP)
- Comprehensive idempotency and error recovery
- Full audit trail with latency and slippage tracking

---

### 3. DisciplineEngine_Spec_v1.3.md ✅

**Based on:** DisciplineEngine_Spec_v1.1 + absorbed capital-protection / session-management logic

**Modules 1–7:** Unchanged (existing rule enforcement)

**Module 4 — Pre-Trade Gate (upgraded):**
- Now the entry point for SEA signals
- `POST /api/discipline/validateTrade`
- Validates: time, count, capital, cooldown, entry timing
- Returns approved payload for RCA

**Module 8 — Capital Protection & Session Management (new):**
- Daily Profit Cap (+5%) → MUST_EXIT to RCA
- Daily Loss Cap (-2%) → MUST_EXIT to RCA
- Session Halted Flag (blocks new entries)
- Carry Forward Engine (15:15 IST evaluation, 4 conditions)
- Daily P&L tracking (pushed from Portfolio Agent — no polling)
- Semi-Auto Intervention Flow (grace period with EXIT_ALL / EXIT_INSTRUMENT / REDUCE_EXPOSURE / HOLD)

**API Endpoints (new):**
- `POST /api/discipline/validateTrade`
- `POST /api/discipline/recordTradeOutcome`
- `POST /api/discipline/requestExit`
- `GET  /api/discipline/session-status`
- `POST /api/discipline/evaluate-carry-forward`
- `POST /api/discipline/submitUserAction`

---

### 4. PortfolioAgent_Spec_v1.3.md ✅

**Key updates:**
- Added `dailyRealizedPnl` and `dailyRealizedPnlPercent` to Portfolio Snapshot
- New endpoint: `POST /api/portfolio/recordTradeClosed`
  - Records exit reason and `exitTriggeredBy` (RCA | BROKER | DISCIPLINE | AI | USER)
- Push-only integration with Discipline (no polling)
- `GET /api/portfolio/daily-pnl` — 7-field response for on-demand reads
- Only TradeExecutorAgent writes to Portfolio; others read

---

## Phase 1: Implementation Plan (In Progress)

### Timeline

```
Week 1:
├─ Discipline Engine: Modules 1–7 existing, wire Module 4 validateTrade endpoint
├─ Portfolio Agent: implement snapshot + trade outcome recording
└─ TradeExecutorAgent: submitTrade + broker event handling

Week 2:
├─ Discipline Engine: Module 8 (caps, carry forward, session halt, grace flow)
├─ RCA: trade approval, real-time monitoring loop, exit decision matrix
└─ TradeExecutorAgent: modifyOrder + exitTrade

Week 3:
├─ Discipline → RCA MUST_EXIT path
├─ SEA → Discipline.validateTrade → RCA.evaluate end-to-end
├─ Portfolio → Discipline push path
└─ Integration tests

Week 4:
├─ Full regression
├─ Canary on paper
├─ Rollout on live
└─ Cleanup / doc updates
```

---

## Spec Checklist: What Each Documents

### RiskControlAgent_Spec_v2.0.md ✅
- [x] 1. Overview (role, inputs, outputs)
- [x] 2. Entry Approval (validated request from Discipline upstream)
- [x] 3. Real-Time Monitoring (continuous)
- [x] 4. Exit Decisions (own rules + external)
- [x] 5. Paper vs Live Context
- [x] 6. API Contracts (evaluate, ai-signal, discipline-request)
- [x] 7. Exit Decision Matrix (precedence)
- [x] 8. Handling AI/SEA Signals (validate before execute)
- [x] 9. Handling Discipline Signals (honor mandatory)
- [x] 10. Communication with TradeExecutor (exitTrade, modifyOrder)
- [x] 11. Testing Strategy
- [x] 12. Implementation Plan

### TradeExecutorAgent_Spec_v1.3.md ✅
- [x] 1–2. Overview, Purpose
- [x] 3. Design Rules (only broker caller, enforced)
- [x] 4. Inputs
- [x] 5. Outputs (execution feedback to RCA)
- [x] 6. Responsibilities (submit, modify, exit, broker events)
- [x] 7. Architecture
- [x] 8. Interfaces & Contracts (submitTrade, modifyOrder, exitTrade)
- [x] 9. Testing & Validation
- [x] 10. Paper vs Live
- [x] 11. Implementation Plan

### DisciplineEngine_Spec_v1.3.md ✅
- [x] Modules 1–7 (existing rule enforcement)
- [x] Module 4: Pre-Trade Gate with validateTrade endpoint
- [x] Module 8: Capital Protection
  - [x] 8.1 Daily Profit Cap
  - [x] 8.2 Daily Loss Cap
  - [x] 8.3 Session Halted Flag
  - [x] 8.4 Carry Forward Engine
  - [x] 8.5 Semi-Auto Intervention Flow
  - [x] 8.6 Daily P&L Tracking
- [x] Exit Signaling API
- [x] Interaction with RCA
- [x] Testing Strategy

### PortfolioAgent_Spec_v1.3.md ✅
- [x] Portfolio Snapshot (daily P&L fields)
- [x] Trade Outcome Recording (exitTriggeredBy)
- [x] Push integration with Discipline
- [x] State model (exitReason, exitTriggeredBy)

---

## Summary of Changes

| Spec | Action | Status | Impact |
|---|---|---|---|
| RiskControlAgent | CREATE v2.0 | ✅ Done | Central risk hub spec |
| TradeExecutorAgent | UPDATE v1.3 | ✅ Done | Single broker caller; modify/exit APIs |
| DisciplineEngine | UPDATE v1.3 | ✅ Done | Pre-trade gate + Module 8 capital protection |
| PortfolioAgent | UPDATE v1.1 | ✅ Done | Outcome recording + daily P&L push |

**Phase 0 Completion Date:** April 9, 2026

**Next Phase:** Phase 1 — implementation (Discipline Modules 4 & 8, RCA build, TEA enhance, Portfolio enhance).

---

## Dependencies

```
RCA v2.0 depends on:
  ├─ DISCIPLINE_vs_RCA_CLARITY.md (explain boundary)
  ├─ ARCHITECTURE_REFACTOR_PLAN.md (overall flow)
  ├─ DisciplineEngine_Spec_v1.3 (upstream validateTrade contract)
  └─ TradeExecutorAgent_Spec_v1.3 (downstream command contract)

TEA v1.3 depends on:
  ├─ RCA v2.0 (what calls it)
  └─ Portfolio v1.1 (what it updates)

Discipline v1.3 depends on:
  ├─ RCA v2.0 (where signals go)
  └─ Portfolio v1.1 (daily P&L push source)

Portfolio v1.1 depends on:
  └─ TEA v1.3 (only writer)
```

---

## Next Steps After Specs

1. **Phase 1 (Weeks 1–2):** Implement Discipline Modules 4 & 8
2. **Phase 2 (Weeks 2–3):** Build RCA
3. **Phase 3 (Weeks 2–3):** Enhance TradeExecutorAgent
4. **Phase 4 (Weeks 1–2):** Enhance Portfolio Agent
5. **Phase 5 (Week 4):** End-to-end integration and cutover

---

**Status:** Phase 0 complete, Phase 1 implementation underway.

**Owner:** Engineering Team
**Start Date:** 2026-04-09
**Revised:** 2026-04-21 to reflect collapsed architecture (no Decision Engine agent)
