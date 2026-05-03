> **⚠ ARCHIVED 2026-04-27** — gap-analysis snapshot from 2026-04-21. Many findings are resolved or superseded by `docs/FINAL_VERIFICATION_TRACKER.md`. Kept for historical context.

---

# Trading Execution Architecture — Gap Analysis Audit

**Date:** 2026-04-21  
**Overall Completion:** ~20% (Discipline Modules 1-7 built; Module 8 + RCA + TEA + Portfolio missing)

## EXECUTIVE SUMMARY

**Built:** Discipline Modules 1-7 (3000+ LOC, substantially functional)
**Missing:** Discipline Module 8, RCA, TEA, Portfolio Agent, cross-agent contracts

**Critical Blockers:**
1. TEA deleted — no execution gateway
2. Portfolio Agent missing — no unified state
3. RCA missing — no dynamic risk management  
4. Discipline Module 8 missing — no capital protection
5. All cross-agent contracts broken — no inter-service communication

## DISCIPLINE ENGINE v1.3

**Modules 1-7: BUILT (87.5%)**
- Data models (discipline_state, discipline_settings, discipline_daily_scores)
- Core logic (circuit breaker, trade limits, time windows, position sizing, journal, streaks)
- tRPC endpoints (validate, getSettings, getState, acknowledgeLoss, etc.)
- Evidence: server/discipline/*.ts (3012 LOC across 14 files)

**Module 8: MISSING (0%)**
- dailyProfitCap/dailyLossCap fields missing
- sessionHalted flag missing
- graceDeadline + userAction state missing
- carryForwardEvaluation missing
- capitalProtection settings missing
- recordTradeOutcome endpoint missing
- submitUserAction endpoint missing
- Exit signals to RCA missing

**Impact:** Capital protection unavailable; carry forward impossible.

## RISK CONTROL AGENT v2.0

**Status: 0% BUILT**
- No server/rca/ folder
- No trade approval endpoint (POST /api/risk-control/evaluate)
- No monitoring loop (1-5s)
- No momentum calculation
- No exit decision matrix
- No signal handlers (Discipline, AI)
- No TradeExecutor integration

**Required:** 600+ LOC code, 30+ unit tests, 10+ integration tests

## TRADE EXECUTOR AGENT v1.3

**Status: 0% BUILT**
- /server/executor/ deleted
- No submitTrade, modifyOrder, exitTrade endpoints
- No idempotency protection
- No paper/live execution paths
- No Portfolio integration
- No broker event handling

**Alert:** capitalRouter.ts may have trade execution logic (violation of unified executor principle).

**Required:** 400+ LOC code, 25+ unit tests

## PORTFOLIO AGENT v1.1

**Status: 0% BUILT**
- No server/portfolio/ folder
- Capital module ≠ Portfolio Agent (different responsibilities)
- Missing recordTrade* endpoints
- Missing dailyRealizedPnl + dailyRealizedPnlPercent tracking
- Missing exitTriggeredBy field (RCA|BROKER|DISCIPLINE|AI|USER)
- No push to discipline.recordTradeOutcome
- No queries from RCA for risk decisions

**Required:** 500+ LOC code

## CROSS-AGENT CONTRACTS: ALL BROKEN

| Contract | Endpoint | Status |
|---|---|---|
| Discipline → RCA | POST /api/risk-control/discipline-request | MISSING (RCA doesn't exist) |
| Portfolio → Discipline | POST /api/discipline/recordTradeOutcome | MISSING (Portfolio doesn't exist) |
| TEA → Portfolio | POST /api/portfolio/recordTrade* | MISSING (TEA + Portfolio don't exist) |
| RCA → TEA | POST /api/executor/* | MISSING (RCA + TEA don't exist) |

## TOP 5 LARGEST BUILT ITEMS

1. **Discipline Validation Pipeline (Modules 1-7)** — 3000+ LOC
   - Pre-trade gate fully functional
   - 7 modules (circuit breaker, trade limits, time windows, position sizing, journal, streaks)
   - Settings per-rule configurable
   - Evidence: server/discipline/*.ts

2. **Discipline Router + Dashboard** — 400+ LOC
   - tRPC endpoints for Modules 1-7
   - Dashboard data serialization
   - Score persistence
   - Evidence: server/discipline/disciplineRouter.ts

3. **Capital Management Engine** — 800+ LOC
   - Day index tracking
   - Capital pools + projections
   - Gift day simulation
   - Evidence: server/capital/capitalEngine.ts

4. **Broker Service Abstraction** — 500+ LOC
   - Paper + live adapters
   - Dhan + mock brokers
   - Tick bus (real-time prices)
   - Evidence: server/broker/*

5. **Discipline Type System** — 300+ LOC
   - Rich types + MongoDB schemas
   - Defaults + constants
   - IST date handling
   - Evidence: server/discipline/types.ts

## TOP 10 LARGEST MISSING ITEMS

1. **Trade Executor Agent** — ~400 LOC
   - submitTrade, modifyOrder, exitTrade APIs
   - Idempotency + broker normalization
   - Paper/live execution paths
   - Portfolio integration

2. **Portfolio Agent** — ~500 LOC
   - Position + capital + P&L schemas
   - recordTrade* endpoints
   - Daily P&L tracking
   - Queries for RCA

3. **Risk Control Agent** — ~600 LOC
   - Trade approval endpoint
   - Monitoring loop + momentum calculation
   - Exit decision matrix
   - Signal handlers (Discipline, AI)

4. **Discipline Module 8** — ~400 LOC
   - Profit/loss cap detection
   - Session halt logic
   - Grace period + user intervention
   - Carry forward engine (15:15 IST)

5. **Carry Forward Engine** — ~200 LOC
   - 15:15 IST scheduler
   - 4-condition evaluation (profit ≥15%, momentum ≥70, IV fair, DTE ≥2)
   - Portfolio + RCA queries
   - Exit signal to RCA

6. **Cross-Agent APIs** — ~150 LOC
   - discipline.recordTradeOutcome receiver
   - risk-control.discipline-request endpoint
   - portfolio.recordTrade* endpoints
   - All signal contracts

7. **Grace Period + User Intervention** — ~200 LOC
   - Session state tracking
   - submitUserAction endpoint
   - Timeout auto-exit handler

8. **Exit Triggered By Tracking** — ~150 LOC
   - exitTriggeredBy field propagation
   - TEA → Portfolio → Discipline flow

9. **Testing Suite** — ~500 LOC tests
   - 35+ unit tests (Module 8, RCA, TEA)
   - 10+ integration tests
   - E2E scenarios

10. **Observability** — ~100 LOC
    - Structured logs (executionId, tradeId, positionId)
    - Metrics (caps, timeouts, exits)
    - Heartbeats (15:15 evaluation)

## KEY DISCREPANCIES

**1. Capital Module vs Portfolio Agent**
- Spec: Portfolio Agent = unified position + capital + P&L hub
- Code: capital/ folder exists but is capital algebra (pools, gift days), not Portfolio Agent
- Action: Clarify separation; build Portfolio Agent as standalone module

**2. Trade Execution Authority**
- Spec (TEA §1): "TEA is ONLY module calling brokerService"
- Code (capitalRouter.ts): May have placeTrade + exitTrade mutations calling broker
- Action: Audit capitalRouter; refactor if executing trades

**3. Session Reset**
- Spec: "Session halt resets at 9:15 AM IST"
- Code: No explicit reset logic
- Action: Implement reset or confirm auto-reset via new date

**4. Carry Forward Scheduling**
- Spec: "At 15:15 IST, Discipline Engine evaluates carry forward"
- Code: No scheduler exists
- Action: Implement Bull/cron job for 15:15 IST

**5. Grace Period Timeout**
- Spec: "If graceDeadline expires, auto send MUST_EXIT to RCA"
- Code: No timeout monitor
- Action: Implement background grace deadline checker

## IMPLEMENTATION ROADMAP (Weeks 1-3)

**Week 1:**
- Portfolio Agent foundation (models, recordTrade* endpoints)
- Discipline Module 8 schemas + recordTradeOutcome receiver
- capital module audit

**Week 2:**
- TEA foundation (API, idempotency, paper/live)
- RCA foundation (approval, monitoring, signal handlers)
- Cross-agent integration endpoints

**Week 3:**
- Carry forward engine + grace period
- Integration tests (full trade flow)
- Unit tests (35+ Module 8, 30+ RCA, 25+ TEA)

## OVERALL COMPLETION ESTIMATE

| Module | Status | % |
|---|---|---|
| Discipline Modules 1-7 | Substantial | 87.5% |
| Discipline Module 8 | Spec only | 0% |
| RCA | Spec only | 0% |
| TEA | Spec only (deleted) | 0% |
| Portfolio Agent | Spec only | 0% |
| System Integration | Not started | 0% |
| **OVERALL** | ~20% | 20% |

**Critical Path:** Build Portfolio Agent + TEA + RCA + Module 8 + cross-agent contracts.
