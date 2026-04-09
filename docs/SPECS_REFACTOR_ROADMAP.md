# Specs Refactoring Roadmap

**Date:** 2026-04-09
**Status:** Phase 0 Complete ✅ | Phase 1 Ready
**Version:** 1.1 (Phase 0 Complete)

---

## Overview

Based on the new unified execution architecture, we need to:
1. **UPDATE** 4 specs (RCA, TradeExecutor, Discipline, Decision Engine)
2. **DEPRECATE** 2 specs (Old Executor, Session Manager)
3. **CREATE** 5 new/updated spec documents
4. **REMOVE** 2 old spec files from codebase

---

## Phase 0: Spec Refactoring & Planning (This Week)

### DEPRECATE: Remove Unwanted Specs

| Spec File | Why | Action | Timeline |
|---|---|---|---|
| `ai-engine-executor-spec.md` v2.0 | execution_module.py being deleted; responsibility split | Mark as "DEPRECATED v2.0" | Week 1 |
| `ai-engine-session-spec.md` | Session Manager logic moves to Discipline Engine | Mark as "DEPRECATED" | Week 1 |

**What to do:**
```
❌ ai-engine-executor-spec.md v2.0
   ├─ Rename to: ai-engine-executor-spec_DEPRECATED_v2.0.md
   └─ Add header: "⚠️ DEPRECATED - See TradeExecutorAgent_Spec_v1.1"

❌ ai-engine-session-spec.md
   ├─ Rename to: ai-engine-session-spec_DEPRECATED.md
   └─ Add header: "⚠️ DEPRECATED - Logic moved to DisciplineEngine_Spec_v1.1"
```

### CREATE: New/Updated Specs

| Spec | Current | New | Status | Owner |
|---|---|---|---|---|
| RiskControlAgent | v1.0 (Draft) | **v2.0** ✨ | Create | You |
| TradeExecutorAgent | v1.1 (Draft) | **v1.2** ✨ | Update | You |
| DisciplineEngine | v1.1 (Draft) | **v1.2** ✨ | Update | You |
| PortfolioAgent | v1.0 (Draft) | **v1.0** (minor) | Minor update | You |
| DecisionEngine | (none) | **v3.0** ✨ | Create | You |

---

## Detailed Spec Changes Required

### 1. CREATE: RiskControlAgent_Spec_v2.0.md ✨

**Based on:** ARCHITECTURE_REFACTOR_PLAN.md + DISCIPLINE_vs_RCA_CLARITY.md

**Key Sections:**
```markdown
1. Overview
   └─ Real-time position monitor & risk decision maker

2. Inputs
   ├─ AI Decision Engine (suggested entry/SL/TP)
   ├─ Market data (WebSocket ticks)
   ├─ Portfolio Agent (position state, P&L)
   ├─ Discipline Engine (hard rules, exit signals)
   └─ AI Decision Engine (new signals, modify requests)

3. Responsibilities
   ├─ Trade Approval (validate Decision Engine's suggestion)
   ├─ Real-Time Monitoring (price vs SL/TP)
   ├─ Exit Decisions (own rules + external signals)
   ├─ Modification Requests (SL/TP/TSL adjustments)
   ├─ Paper vs Live Context
   └─ Receive & Validate External Requests

4. Paper Trade Management
   └─ RCA owns complete lifecycle (entry to exit)

5. Live Trade Management
   └─ RCA: monitoring + modifications
   └─ Broker: auto-exit on SL/TP

6. API Contracts
   ├─ /api/risk-control/evaluate (Decision approval)
   ├─ /api/risk-control/ai-decision-request (AI signals)
   ├─ /api/risk-control/discipline-request (Discipline signals)
   └─ Internal calls to TradeExecutorAgent

7. Exit Decision Logic
   ├─ RCA's own rules (momentum, age, volatility)
   ├─ Discipline signals (mandatory)
   ├─ AI signals (validated)
   └─ Decision precedence

8. Testing & Validation
```

**Diff from v1.0:**
```
ADD:
+ Real-time monitoring logic
+ Paper vs live split
+ API contracts (evaluate, ai-request, discipline-request)
+ Exit decision matrix
+ Handling external signals from AI & Discipline

REMOVE:
- Generic risk scoring (already in v1.0)
- Position sizing (stays, but refined)
```

---

### 2. UPDATE: TradeExecutorAgent_Spec_v1.2.md ✨

**Based on:** TradeExecutorAgent_Spec_v1.1.md + new understanding

**Key Additions:**
```markdown
3. Design Rules (enhance)
   ADD:
   + Only TradeExecutorAgent calls broker (enforce this)
   + RCA sends all trade commands (don't deviate)

5. Outputs (enhance)
   ADD:
   + Execution feedback to RCA (price, fills, rejections)
   + Event notifications (filled, partial, rejected)

6. Responsibilities (expand)
   ADD:
   7. Receive modifyOrder requests from RCA
      └─ SL/TP/TSL adjustments (live only)
   
   8. Receive exitTrade requests from RCA
      └─ Execute SELL orders (paper & live)
   
   9. Handle broker events
      └─ Order fills, rejections, SL/TP auto-exits

7. Interfaces (new)
   ADD:
   POST /api/executor/modifyOrder
   POST /api/executor/exitTrade
   GET /api/executor/orderStatus
   
8. Paper vs Live Differences
   ADD:
   └─ Paper: RCA manages all exits
   └─ Live: Broker manages SL/TP, RCA requests modifications

9. Testing (expand)
   ADD:
   + modifyOrder scenarios
   + exitTrade scenarios
   + Broker event handling
```

**Diff from v1.1:**
```
ADD:
+ modifyOrder API & logic
+ exitTrade API & logic
+ Broker event handling
+ Paper vs live detailed flow
+ Enforcement: only executor calls broker

ENHANCE:
- Idempotency (clarify across modify/exit)
- Error recovery (for modify/exit)
```

---

### 3. UPDATE: DisciplineEngine_Spec_v1.2.md ✨

**Based on:** DisciplineEngine_Spec_v1.1.md + Session Manager logic

**Key Additions:**
```markdown
(Keep existing 7 modules)

ADD: Module 8 - Capital Protection & Session Management
  ├─ 8.1 Daily Profit Cap
  │   └─ +5% of capital → send EXIT_ALL to RCA
  │
  ├─ 8.2 Daily Loss Cap
  │   └─ -2% of capital → send EXIT_ALL to RCA
  │
  ├─ 8.3 Session Halted Flag
  │   └─ Set when caps hit → block new entries
  │
  ├─ 8.4 Carry Forward Engine (15:15)
  │   ├─ Evaluate: profit >= 15%, momentum > 70, IV fair, DTE > 2
  │   └─ If any fails: send EXIT signal to RCA
  │
  └─ 8.5 Daily P&L Tracking
      └─ Cumulative realized P&L (from Portfolio Agent)

API Endpoints (new)
  POST /api/discipline/requestExit
  GET /api/discipline/session-status
  POST /api/discipline/evaluate-carry-forward
```

**Diff from v1.1:**
```
ADD:
+ Daily profit/loss cap enforcement
+ Session halted state
+ Carry forward logic
+ Daily P&L tracking
+ EXIT signaling to RCA
+ Session management APIs

MOVE FROM:
- Session Manager (Python) → this spec
```

---

### 4. UPDATE: PortfolioAgent_Spec_v1.0.md ⚙️

**Current v1.0 is good, minor enhancements:**

**Key Updates:**
```markdown
5.1 Portfolio Snapshot (enhance)
   ADD:
   + daily_realized_pnl (cumulative from today's closed trades)
   + daily_pnl_pct (as percentage of capital)

5.2 Trade Outcome Recording (new section)
   └─ POST /api/portfolio/recordTradeClosed
      Input: {
        exit_price, exit_reason, realizedPnl, pnl_pct,
        duration, exit_triggered_by  ← KEY
      }

7. Agent State Model (enhance)
   ├─ Position State
   │  ADD: exit_triggered_by (RCA | BROKER | DISCIPLINE | AI)
   │
   └─ Daily Metrics
      ADD: daily_realized_pnl, daily_pnl_pct
```

**Diff from v1.0:**
```
ENHANCE:
+ Trade outcome recording (with triggered_by)
+ Daily P&L metrics
+ Exit reason tracking

CLARIFY:
- When Portfolio Agent receives updates (after exit)
- Who can write to Portfolio (only TradeExecutor)
```

---

### 5. CREATE: DecisionEngine_Spec_v3.0.md ✨

**New spec: Enhanced Decision Engine (Python module)**

**Based on:** ai-engine-decision-spec.md v2.0 + merging execution_module.py responsibilities

**Key Sections:**
```markdown
1. Overview
   └─ Generate trade suggestions, validate timing, send to RCA

2. Responsibilities
   ├─ Load market data & AI analysis
   ├─ Call Discipline Engine (pre-trade check)
   ├─ Calculate entry timing (momentum, volume, breakout)
   ├─ Generate trade setup (entry, SL, TP, R:R)
   ├─ Determine confidence & risk flags
   └─ Send decision to Risk Control Agent

3. Output Format (enhanced)
   ADD to ai_decision_{instrument}.json:
   {
     "direction": "GO_CALL|GO_PUT|WAIT",
     "trade_setup": {...},
     "confidence_score": float,
     "discipline_status": {
       "allowed": boolean,
       "blocked_by": [...],
       "warnings": [...]
     },
     "entry_timing": {
       "confirmed": boolean,
       "momentum_score": float,
       "volume_spike": boolean,
       "price_breakout": boolean
     },
     "timestamp": "ISO8601"
   }

4. Integration with RCA
   └─ Send decision → RCA validates → RCA approves → TradeExecutor

5. Continuous AI Signals
   └─ Detect trend reversals, anomalies
   └─ Send modify/exit requests to RCA
```

**What's NEW in v3.0:**
```
MERGE from execution_module.py:
+ parse_ai_decision() logic
+ check_discipline_engine() calls
+ check_entry_timing() logic
+ notify_trade_placed/closed() for Discipline

REMOVE:
- All broker calls
- Position tracking
- Exit logic
- Order placement

ADD:
+ API to send decision to RCA
+ AI signal requests (exit, modify)
+ Enhanced output format with discipline status
```

---

## Phase 1: Implement Spec Updates (Week 1)

### Timeline

```
Monday:
└─ DEPRECATE old specs (rename files, add warnings)
└─ READ existing specs (RCA v1.0, Executor v1.1, Discipline v1.1, Decision v2.0)

Tuesday-Wednesday:
├─ CREATE RiskControlAgent_Spec_v2.0.md
├─ UPDATE TradeExecutorAgent_Spec_v1.2.md
└─ UPDATE DisciplineEngine_Spec_v1.2.md

Thursday:
├─ UPDATE PortfolioAgent_Spec_v1.0.md (minor)
└─ CREATE DecisionEngine_Spec_v3.0.md

Friday:
├─ Review all specs for consistency
├─ Update ARCHITECTURE_REFACTOR_PLAN.md with spec links
└─ Create implementation checklists
```

---

## Spec Checklist: What Each Should Document

### RiskControlAgent_Spec_v2.0.md ✨
- [ ] 1. Overview (role, inputs, outputs)
- [ ] 2. Entry Approval (from Decision Engine)
- [ ] 3. Real-Time Monitoring (continuous)
- [ ] 4. Exit Decisions (own rules + external)
- [ ] 5. Paper vs Live Context
- [ ] 6. API Contracts (evaluate, ai-request, discipline-request)
- [ ] 7. Exit Decision Matrix (precedence)
- [ ] 8. Handling AI Signals (validate before execute)
- [ ] 9. Handling Discipline Signals (honor mandatory)
- [ ] 10. Communication with TradeExecutor (exitTrade, modifyOrder)
- [ ] 11. Testing Strategy
- [ ] 12. Implementation Plan (Phase 2-3)

### TradeExecutorAgent_Spec_v1.2.md ✨
- [ ] 1. Overview (unchanged)
- [ ] 2. Purpose (unchanged)
- [ ] 3. Design Rules (ADD: only broker caller rule)
- [ ] 4. Inputs (unchanged)
- [ ] 5. Outputs (ADD: execution feedback to RCA)
- [ ] 6. Responsibilities (ADD: modifyOrder, exitTrade, broker events)
- [ ] 7. Architecture (unchanged)
- [ ] 8. Interfaces & Contracts (ADD: modifyOrder, exitTrade APIs)
- [ ] 9. Testing & Validation (ADD: modify/exit scenarios)
- [ ] 10. Paper vs Live (ADD: detailed difference)
- [ ] 11. Implementation Plan (Phase 2-3)

### DisciplineEngine_Spec_v1.2.md ✨
- [ ] 1-7. Existing modules (keep)
- [ ] 8. Capital Protection & Session Management
  - [ ] 8.1 Daily Profit Cap
  - [ ] 8.2 Daily Loss Cap
  - [ ] 8.3 Session Halted Flag
  - [ ] 8.4 Carry Forward Engine
  - [ ] 8.5 Daily P&L Tracking
- [ ] 9. Exit Signaling API
- [ ] 10. Interaction with RCA
- [ ] 11. Testing Strategy (NEW tests for caps, carry forward)

### DecisionEngine_Spec_v3.0.md ✨
- [ ] 1. Overview (Python module)
- [ ] 2. Inputs (market data, AI analysis)
- [ ] 3. Responsibilities (6 items)
- [ ] 4. Decision Output Format (enhanced JSON)
- [ ] 5. Discipline Engine Integration
- [ ] 6. Entry Timing Validation
- [ ] 7. AI Signal Generation (continuous)
- [ ] 8. API to RCA (submit decision, send signals)
- [ ] 9. Testing Strategy
- [ ] 10. Implementation Plan (Phase 1)

### PortfolioAgent_Spec_v1.0.md ⚙️
- [ ] (Update 3 sections only)
- [ ] 5.1 Portfolio Snapshot (ADD daily P&L)
- [ ] 5.2 Trade Outcome Recording (NEW)
- [ ] 7. Agent State Model (ADD exit_triggered_by)

---

## Cleanup: Old Spec Files

**Action:** Delete after v2.0 specs are approved

```
docs/specs/
├─ ai-engine-executor-spec_DEPRECATED_v2.0.md
│  └─ Rename & mark (keep for reference, note it's deprecated)
│
└─ ai-engine-session-spec_DEPRECATED.md
   └─ Rename & mark (keep for reference, note it's deprecated)

Note: Don't hard-delete yet (Week 4 cleanup phase)
```

---

## Summary of Changes

| Spec | Action | Status | Impact |
|---|---|---|---|
| RiskControlAgent | CREATE v2.0 | ✅ DONE | New detailed monitoring spec |
| TradeExecutorAgent | UPDATE v1.2 | ✅ DONE | Add modify/exit APIs |
| DisciplineEngine | UPDATE v1.2 | ✅ DONE | Add session mgmt, caps |
| PortfolioAgent | UPDATE v1.0 | ✅ DONE | Add outcome recording |
| DecisionEngine | CREATE v3.0 | ✅ DONE | New decision-only spec |
| OldExecutor | DEPRECATE v2.0 | ✅ DONE | Mark & archive |
| SessionManager | DEPRECATE | ✅ DONE | Mark & archive |

**Phase 0 Completion Date:** April 9, 2026 (one day ahead of schedule!)

**Next Phase:** Phase 1 - Implementation (Decision Engine refactor, RCA build, Executor enhance)

---

## Dependencies

```
RCA v2.0 depends on:
  ├─ DISCIPLINE_vs_RCA_CLARITY.md (explain boundary)
  ├─ ARCHITECTURE_REFACTOR_PLAN.md (reference)
  └─ TradeExecutorAgent_Spec_v1.2 (API contract)

Executor v1.2 depends on:
  ├─ RCA v2.0 (what calls it)
  └─ Portfolio v1.0 (what it updates)

Discipline v1.2 depends on:
  ├─ RCA v2.0 (where signals go)
  └─ Portfolio v1.0 (daily P&L from)

Decision v3.0 depends on:
  ├─ Discipline v1.2 (pre-trade check)
  └─ RCA v2.0 (send decision to)
```

---

## Next Steps After Specs

Once specs are finalized:
1. **Phase 1 (Week 1-2):** Refactor Decision Engine (Python)
2. **Phase 2 (Week 2-3):** Build RCA (TypeScript)
3. **Phase 3 (Week 2-3):** Enhance Executor (TypeScript)
4. **Phase 4 (Week 2):** Enhance Discipline (TypeScript)
5. **Phase 5 (Week 1-2):** Enhance Portfolio (TypeScript)
6. **Phase 6 (Week 4):** Integration & cutover

---

## Questions to Answer During Spec Writing

```
RCA v2.0:
  Q1: Exactly which momentum/volatility/age thresholds?
  Q2: How does RCA decide between conflicting signals?
  Q3: Paper trade exit detection frequency? (1s? 5s?)

Executor v1.2:
  Q1: modifyOrder retry logic on broker failure?
  Q2: exitTrade cancellation order? (cancel SL/TP first, then SELL?)
  Q3: Idempotency keys format?

Discipline v1.2:
  Q1: Daily P&L source? (query Portfolio or real-time tracking?)
  Q2: Carry forward evaluation: exact conditions?
  Q3: Session halt: what about open positions at EOD?

Decision v3.0:
  Q1: Timing validation: what's "confirmed"?
  Q2: AI signal frequency? (every tick? every 5 sec?)
  Q3: Output format change: backward compatible?
```

---

**Status:** Ready to start Phase 0 spec refactoring

**Owner:** You (implementation)
**Reviewer:** You (approval)

**Start Date:** 2026-04-09
**Target Completion:** 2026-04-12 (end of week)
