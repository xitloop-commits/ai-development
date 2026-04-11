# Architecture Refactor Plan: Unified Execution Model
**Date:** 2026-04-08
**Status:** Approved for Implementation
**Version:** 1.0

---

## Executive Summary

The current `execution_module.py` has 7 responsibilities that should be split across 4 specialized agents. This document outlines the refactoring required to achieve a clean, single-point-of-execution architecture.

**Key Principle:** 
```
TradeExecutorAgent is the ONLY module allowed to call broker services.
All other modules (Decision Engine, Risk Control Agent, Discipline Engine, AI) 
request actions through TradeExecutorAgent.
```

---

## Current State Analysis

### execution_module.py: 7 Responsibilities

| # | Responsibility | Current Code | Target Module | Action |
|---|---|---|---|---|
| 1 | Read AI decisions | `load_ai_decision()` | Decision Engine | Merge |
| 2 | Check Discipline Engine | `check_discipline_engine()` | Decision Engine | Merge |
| 3 | Entry timing validation | `check_entry_timing()` | Decision Engine | Merge |
| 4 | Profit exits (6%, 10%) | `check_profit_exit()` | Risk Control Agent | Move |
| 5 | Position monitoring & exits | `monitor_positions()` | Risk Control Agent | Move |
| 6 | Session management | `Session Manager` calls | Discipline Engine | Move/Enhance |
| 7 | Feedback loop tuning | `FeedbackLoop` | FeedbackAgent (future) | Defer |

**Result:** `execution_module.py` → **DELETE** after refactoring

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          UNIFIED EXECUTION FLOW                              │
└─────────────────────────────────────────────────────────────────────────────┘

1. DECISION ENGINE (Python)
   ├─ Load market data, AI decisions
   ├─ Call Discipline Engine (pre-trade validation)
   ├─ Check entry timing (momentum, volume, breakout)
   ├─ Output: ai_decision_{instrument}.json
   │  {direction, entry, suggested_SL, suggested_TP, confidence, 
   │   discipline_status, timing_confirmed}
   └─ Send to Risk Control Agent
                    ↓
   ALSO sends to Risk Control Agent (continuous):
   ├─ New AI signals (trend reversal, breakout failed, anomalies)
   ├─ Requests: EXIT or MODIFY SL/TP/TSL
   └─ Example: "EXIT NIFTY_50 pos_123 - Trend reversed to bearish"

                              ↓

2. RISK CONTROL AGENT (TypeScript) ← HUB FOR ALL DECISIONS
   
   A. Entry Approval:
   ├─ Receive decision from Decision Engine
   ├─ Validate against capital, portfolio, volatility
   ├─ Override SL/TP if needed
   ├─ Decide position size
   └─ If APPROVE → submit to TradeExecutorAgent
   
   B. Continuous Monitoring (Real-Time):
   ├─ Monitor price for all OPEN positions
   ├─ Check exit conditions:
   │  ├─ RCA's own rules (momentum, volatility, age)
   │  ├─ Discipline Engine requests (circuit breaker, cooldown, halt)
   │  └─ AI Decision Engine signals (reversal, breakout failed, anomaly)
   │
   ├─ For PAPER trades:
   │  ├─ Detect SL/TP hits
   │  └─ Request exits from TradeExecutorAgent
   │
   ├─ For LIVE trades:
   │  ├─ Monitor SL/TP/TSL (broker manages exit)
   │  ├─ Request modifications: modifyOrder()
   │  └─ Request exits: exitTrade() (RCA decides when)
   │
   └─ Sources of commands to TradeExecutorAgent:
      ├─ RCA's own rules
      ├─ AI requests (validated by RCA)
      └─ Discipline requests (mostly honored)

                              ↓

3. TRADE EXECUTOR AGENT (TypeScript)
   ├─ Receive trade submission from Risk Control Agent
   ├─ Place entry order via brokerService.placeOrder()
   ├─ Attach SL/TP/TSL (if live: set with broker, if paper: RCA manages)
   ├─ Update Portfolio Agent
   
   ALSO (execute commands from Risk Control Agent):
   ├─ modifyOrder(SL, TP, TSL) → brokerService.modifyOrder()
   ├─ exitTrade() → brokerService.cancelOrder() + placeOrder(SELL)
   ├─ Log all executions
   └─ Update Portfolio Agent on every state change

                              ↓

4. PORTFOLIO AGENT (TypeScript)
   ├─ Own all position state
   ├─ Track open/closed positions
   ├─ Calculate P&L, margin, capital
   ├─ RECORD trade outcomes (win/loss, exit reason, P&L)
   └─ Serve data to Risk Control, Discipline, Dashboard

                              ↓

5. DISCIPLINE ENGINE (TypeScript)
   ├─ Pre-trade validation (called by Decision Engine)
   ├─ Time windows (no-trade hours)
   ├─ Trade count limits
   ├─ Loss limits (circuit breaker)
   ├─ Cooldowns, session halts
   ├─ Session P&L tracking
   ├─ Carry forward rules
   └─ SEND halt/exit/modify signals to Risk Control Agent

                              ↓

6. FEEDBACK AGENT (TypeScript, Future)
   ├─ Analyze completed trades (from Portfolio Agent)
   ├─ Recommend parameter adjustments
   └─ Send feedback to Risk Control Agent
```

---

## RCA Communication Flows

### Three Sources of Exit/Modify Requests

```
RISK CONTROL AGENT (RCA) receives requests from 3 sources:

1. OWN RULES (RCA decides independently)
   ├─ Momentum drops below threshold → FULL_EXIT
   ├─ Position age > 10 min → FORCE_EXIT
   ├─ Volatility spike detected → TIGHTEN_SL
   ├─ Price breakout sustained → EXTEND_TP or TSL
   └─ Action: RCA → TradeExecutorAgent → Broker

2. DISCIPLINE ENGINE (Pre-trade & Risk Rules)
   ├─ Circuit breaker hit (daily loss limit) → EXIT_ALL
   ├─ Cooldown active (loss penalty) → EXIT_THIS
   ├─ Session halted (15:15 carry forward) → EXIT_OPEN
   ├─ Risk multiplier reduced (drawdown) → REDUCE_POSITION / TIGHTEN_SL
   └─ Action: Discipline → RCA → TradeExecutorAgent → Broker
   
   Note: RCA mostly honors these (they're hard rules)

3. AI/STRATEGY ENGINE (New signals, pattern breaks)
   ├─ Trend reversal detected → EXIT
   ├─ Breakout failed at resistance → EXIT
   ├─ New bullish/bearish pattern → MODIFY_TP
   ├─ Anomaly in price action → EXIT or TIGHTEN_SL
   ├─ Stop hunt detected → TIGHTEN_SL or EXIT
   └─ Action: AI → RCA → TradeExecutorAgent → Broker
   
   Note: RCA validates these against current momentum/volatility
         May accept, reject, or partially honor
```

### Communication Diagram

```
                    ┌─────────────────────┐
                    │   DECISION ENGINE   │
                    │      (Python)       │
                    └──────────┬──────────┘
                               │
                    Entry Decision + AI Signals
                               │
                               ▼
        ┌──────────────────────────────────────────┐
        │  RISK CONTROL AGENT (TypeScript)         │
        │  ← HUB FOR ALL RISK DECISIONS            │
        │                                           │
        │  Sources of requests:                    │
        │  ├─ Own rules (continuous monitoring)   │
        │  ├─ Discipline Engine                   │
        │  └─ AI Decision Engine signals                 │
        │                                           │
        │  Decides: EXIT or MODIFY SL/TP/TSL      │
        └──────────────────────────────────────────┘
                               │
                    exitTrade() or modifyOrder()
                               │
                               ▼
        ┌──────────────────────────────────────────┐
        │  TRADE EXECUTOR AGENT (TypeScript)       │
        │  ← ONLY BROKER CALLER                   │
        │                                           │
        │  Executes:                               │
        │  ├─ placeOrder()                        │
        │  ├─ modifyOrder()                       │
        │  └─ cancelOrder() + placeOrder(SELL)    │
        └──────────────────────────────────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────────┐
        │  BROKER (Dhan API)                       │
        │  ├─ Live: manages SL/TP auto-exit      │
        │  └─ Paper: RCA manages exits            │
        └──────────────────────────────────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────────┐
        │  PORTFOLIO AGENT (TypeScript)            │
        │  ← OUTCOME RECORDER                      │
        │                                           │
        │  Records:                                │
        │  ├─ Trade outcome (win/loss)            │
        │  ├─ Exit reason (SL, TP, MOMENTUM, etc) │
        │  ├─ Who triggered (RCA, Broker, AI)     │
        │  └─ P&L, duration, performance metrics  │
        └──────────────────────────────────────────┘
```

---

## Detailed Responsibility Mapping

### 1. DECISION ENGINE ENHANCEMENTS (Python)

**Add:**
```python
# From execution_module.py
- parse_ai_decision(decision)
- check_discipline_engine(instrument, params)
- check_entry_timing(instrument, decision, option_chain)
- notify_trade_placed()
- notify_trade_closed(pnl)

# New output format
output: ai_decision_{instrument}.json
{
  "direction": "GO_CALL" | "GO_PUT" | "WAIT",
  "trade_setup": {
    "strike": int,
    "entry_price": float,
    "target_price": float,
    "stop_loss": float,
    "risk_reward": float
  },
  "confidence_score": float,
  "discipline_status": {
    "allowed": boolean,
    "blocked_by": [string],
    "warnings": [string]
  },
  "entry_timing": {
    "confirmed": boolean,
    "momentum_score": float,
    "volume_spike": boolean,
    "price_breakout": boolean
  },
  "timestamp": "ISO8601"
}
```

**Remove:**
```python
- All broker calls (place_broker_order, etc)
- All position tracking (OPEN_POSITIONS)
- All exit logic
- Order placement and monitoring
- Session Manager integration
```

**API:**
- Send to Risk Control Agent: `POST /api/risk-control/evaluate`
- Input: `ai_decision_{instrument}.json`
- Endpoint called by Decision Engine (push model)

---

### 2. RISK CONTROL AGENT (New TypeScript Module)

**Responsibilities:**

#### A. Trade Approval (On Decision Arrival)
```typescript
interface TradeApprovalRequest {
  instrument: string;
  ai_decision: {
    direction: 'GO_CALL' | 'GO_PUT',
    suggested_entry: number,
    suggested_SL: number,
    suggested_TP: number,
    confidence: number,
    discipline_status: {...}
  };
}

interface TradeApprovalResponse {
  action: 'APPROVE' | 'REDUCE_SIZE' | 'REJECT' | 'REVIEW',
  reason?: string,
  
  // If APPROVE:
  approved_trade?: {
    direction: 'BUY' | 'SELL',
    entry_price: number,
    stop_loss: number,
    take_profit: number,
    trailing_stop_loss?: {...},
    position_size: number,
    risk_score: number,
    constraints: {
      max_loss_per_trade: number,
      max_position_size: number,
      volatility_multiplier: number
    }
  }
}
```

#### B. Real-Time Monitoring (Continuous)
```typescript
// Every 1-5 seconds (configurable)
for each OPEN_POSITION:
  ├─ Get current_price (via WebSocket)
  ├─ Check exit conditions:
  │  ├─ SL hit? (paper: detect, live: monitor)
  │  ├─ TP hit? (paper: detect, live: monitor)
  │  ├─ Momentum exit? (all: RCA decides)
  │  ├─ Age exit? (all: RCA decides)
  │  ├─ Discipline halt? (all: listen for signals)
  │  └─ AI signal exit? (all: listen for signals)
  │
  ├─ Check modification opportunities (live only):
  │  ├─ Trailing SL update?
  │  ├─ SL tighten due to momentum?
  │  ├─ TP adjust due to trend?
  │  └─ TSL trigger adjustment?
  │
  └─ Send commands to TradeExecutorAgent:
     ├─ exitTrade(position_id, reason)
     ├─ modifyOrder(position_id, new_SL, new_TP)
     └─ adjustTrailingSL(position_id, new_distance)
```

#### C. Handling External Requests (from AI Decision Engine and Discipline Engine)

**From Discipline Engine:**
```typescript
receive: POST /api/risk-control/discipline-request
  Input: {position_id, action: 'EXIT'|'MODIFY', reason, params}
  
  EXIT request:
  ├─ Reason: 'CIRCUIT_BREAKER'|'COOLDOWN'|'SESSION_HALT'|'LOSS_LIMIT'
  └─ RCA executes: exitTrade(position_id, "DISCIPLINE_" + reason)
  
  MODIFY request:
  ├─ Reason: 'RISK_REDUCTION'
  ├─ Params: {new_SL, new_TP, new_TSL}
  └─ RCA executes: modifyOrder(position_id, params)
```

**From AI Decision Engine Engine:**
```typescript
receive: POST /api/risk-control/ai-request
  Input: {position_id, action: 'EXIT'|'MODIFY', signal, reason, params}
  
  EXIT request:
  ├─ Signal: 'TREND_REVERSAL'|'BREAKOUT_FAILED'|'NEW_DIRECTION'|'ANOMALY'
  ├─ Reason: "Momentum reversed to bearish" | "Breakout failed at resistance"
  └─ RCA executes: exitTrade(position_id, "AI_EXIT: " + signal + " - " + reason)
  
  MODIFY request:
  ├─ Signal: 'TIGHTEN_SL'|'ADJUST_TP'|'ENABLE_TSL'|'ADJUST_TSL'
  ├─ Reason: "New support level detected at 24050" | "Trend acceleration detected"
  ├─ Params: {new_SL?, new_TP?, new_TSL?}
  └─ RCA executes: modifyOrder(position_id, "AI_MODIFY: " + signal, params)
```

**RCA Decision Logic:**
```typescript
// RCA can ACCEPT or REJECT external requests

if (request from Discipline Engine):
  // Circuit breaker / session halt = RCA must honor
  acceptAndExecute(request)
  
if (request from AI Decision Engine):
  // RCA validates against current market conditions
  if (request aligns with RCA's assessment):
    acceptAndExecute(request)
  else:
    log: "AI request rejected: conflict with current momentum/volatility"
    // Can optionally notify AI of rejection
```

#### D. Paper vs Live Context
```typescript
// Paper Trade Management (RCA owns complete lifecycle)
if position.environment === 'paper':
  ├─ RCA monitors price real-time
  ├─ RCA detects SL hit: exitTrade()
  ├─ RCA detects TP hit: exitTrade()
  ├─ RCA decides exit for any reason: exitTrade()
  └─ TradeExecutorAgent executes via broker (paper adapter)

// Live Trade Management (Broker owns exit, RCA owns modifications)
if position.environment === 'live':
  ├─ Broker auto-exits when SL/TP hit
  ├─ RCA monitors price real-time
  ├─ RCA can modify SL/TP/TSL: modifyOrder()
  ├─ RCA can request exit: exitTrade()
  │  └─ (TradeExecutorAgent cancels broker orders, places SELL)
  └─ If SL hit by broker: RCA receives event
```

#### E. What RCA Does NOT Do
```typescript
❌ RCA does NOT record trade outcomes
❌ RCA does NOT track P&L
❌ RCA does NOT persist position state

✅ That's Portfolio Agent's responsibility
```

**Key APIs RCA Exposes:**

```typescript
// ENTRY APPROVAL (from Decision Engine)
POST /api/risk-control/evaluate
  Input: ai_decision_{instrument}.json
  Output: {approved_trade, action, constraints}
  
// REQUESTS FROM AI/STRATEGY ENGINE (continuous monitoring)
POST /api/risk-control/ai-request
  Input: {
    position_id, 
    action: 'EXIT' | 'MODIFY',
    signal: 'TREND_REVERSAL' | 'BREAKOUT_FAILED' | 'NEW_DIRECTION' | etc,
    reason: "Momentum reversed to bearish",
    params?: {new_SL, new_TP, new_TSL}
  }
  Output: {accepted: true/false, reason?}
  
  Note: RCA validates AI request against current market conditions
        If accepted: RCA executes exitTrade() or modifyOrder()
        If rejected: RCA logs rejection (AI signal conflicts with current state)

// REQUESTS FROM DISCIPLINE ENGINE
POST /api/risk-control/discipline-request
  Input: {
    position_id,
    action: 'EXIT' | 'MODIFY',
    reason: 'CIRCUIT_BREAKER' | 'COOLDOWN' | 'SESSION_HALT' | 'LOSS_LIMIT',
    params?: {new_SL, new_TP, new_TSL}
  }
  Output: {executed: true, command_id}
  
  Note: RCA honors Discipline Engine requests (mostly mandatory)

// RCA'S OWN EXIT/MODIFY DECISIONS
POST /api/risk-control/exitTrade [INTERNAL - RCA calls TradeExecutorAgent]
  Input: {position_id, reason, environment}
  Output: {exit_id, exit_price, pnl}

POST /api/risk-control/modifyOrder [INTERNAL - RCA calls TradeExecutorAgent]
  Input: {position_id, new_SL, new_TP, new_TSL, reason}
  Output: {modification_id, applied_at}

// QUERIES
GET /api/risk-control/position/{position_id}
  Output: {current_price, pnl, momentum, momentum_action, last_monitored}
```

---

### 3. TRADE EXECUTOR AGENT (TypeScript)

**Responsibilities:**

#### A. Execute Trade Submissions from RCA
```typescript
POST /api/executor/submitTrade
  Input: {
    environment: 'paper' | 'live',
    instrument, direction, quantity,
    entry_price, stop_loss, take_profit, trailing_stop_loss,
    order_type, product_type
  }
  
  Execution:
  ├─ Sanity checks
  ├─ Idempotency check (by execution_id)
  ├─ Call brokerService.placeOrder() ← ONLY place that calls broker
  ├─ Update Portfolio Agent
  └─ Return: {trade_id, position_id, executed_price}
```

#### B. Execute Modifications from RCA (Live Trades Only)
```typescript
POST /api/executor/modifyOrder
  Input: {position_id, new_SL, new_TP, new_TSL, reason}
  
  Execution:
  ├─ Call brokerService.modifyOrder() ← ONLY place that calls broker
  ├─ Log modification
  ├─ Update Portfolio Agent
  └─ Return: {modification_id, applied_at}
```

#### C. Execute Exits from RCA
```typescript
POST /api/executor/exitTrade
  Input: {position_id, exit_type: 'MARKET'|'LIMIT', exit_price?, reason}
  
  Execution (LIVE):
  ├─ Cancel broker's pending SL/TP orders (if any)
  ├─ Call brokerService.placeOrder(SELL, quantity) ← ONLY place
  ├─ Wait for confirmation
  ├─ Update Portfolio Agent with exit
  └─ Return: {exit_id, exit_price, realized_pnl}
  
  Execution (PAPER):
  ├─ Call brokerService.placeOrder(SELL, quantity)
  ├─ Update Portfolio Agent
  └─ Return: {exit_id, exit_price, realized_pnl}
```

#### D. Receive Broker Events
```typescript
// From WebSocket (broker order updates)
receive: orderUpdateEvent({order_id, status, filled_qty, fill_price})
  ├─ Update Portfolio Agent
  ├─ If filled: notify RCA
  ├─ If rejected: notify RCA
  └─ If partial: track for retry

// From SL/TP auto-exit (live trades)
receive: tradeClosedEvent({position_id, exit_price, reason: 'SL'|'TP'})
  ├─ Update Portfolio Agent
  └─ Portfolio Agent records trade outcome
```

**Key Rule:** 
```
❌ NEVER call brokerService from any module except TradeExecutorAgent
✅ All other modules submit requests to TradeExecutorAgent via API
```

---

### 4. DISCIPLINE ENGINE ENHANCEMENTS (TypeScript)

**Existing (Keep):**
- Time windows (no-trade hours)
- Trade count limits
- Max open positions
- Cooldowns after loss
- Position size limits

**Add:**
```typescript
// Session Management
- Daily P&L tracking (realized)
- Circuit breaker (daily loss limit)
- Session halted flag
- Carry forward rules (15:15 auto-close)

// Exit Signaling
POST /api/discipline/requestExit
  Input: {position_id, reason: 'CIRCUIT_BREAKER'|'COOLDOWN'|'SESSION_HALT'}
  Output: {acked: true}
  
  Effect: Discipline Engine → Risk Control Agent → TradeExecutorAgent → Broker
```

---

### 5. PORTFOLIO AGENT (TypeScript)

**Owns:**
- All position objects (open/closed)
- **Trade outcomes (win/loss, P&L, exit reason)** ← CRITICAL
- P&L calculations (realized/unrealized)
- Capital available/margin used
- Portfolio exposure
- Win/loss streaks
- Historical trade records
- Feeds outcome data to Feedback Loop (future)

**Updated By:** TradeExecutorAgent ONLY
**Queried By:** RiskControlAgent, DisciplineEngine, Dashboard, FeedbackAgent

```typescript
API endpoints:
POST /api/portfolio/recordTradePlaced
  Input: {position_id, instrument, direction, entry_price, qty, SL, TP, environment}
  
POST /api/portfolio/recordTradeUpdated
  Input: {position_id, currentPrice, unrealizedPnl, status}
  
POST /api/portfolio/recordTradeClosed
  Input: {position_id, exit_price, exit_reason, realizedPnl, pnl_pct, 
           duration_seconds, exit_triggered_by}
  Record: ✅ Trade outcome (win/loss)
          ✅ P&L amount and percentage
          ✅ Exit reason (SL, TP, MOMENTUM, AGE, DISCIPLINE, etc)
          ✅ Who triggered exit (RCA, Broker, Discipline, AI)
  
POST /api/portfolio/recordExitRequest
  Input: {position_id, requested_by, reason}

GET /api/portfolio/state
GET /api/portfolio/positions
GET /api/portfolio/metrics
GET /api/portfolio/tradeOutcomes
  Output: {trades: [{exit_reason, pnl_pct, duration, triggered_by}]}
```

---

## Implementation Phases

### Phase 0: Planning & Design (This Week)
- ✅ Finalize architecture (you've approved)
- ✅ Define API contracts
- ⬜ Create Risk Control Agent spec v2.0 (based on this plan)
- ⬜ Update Trade Executor Agent spec to include modify/exit APIs
- ⬜ Document decision → RCA → executor flow

### Phase 1: Decision Engine Refactoring (Week 1)
- ⬜ Merge 3 responsibilities into Decision Engine (Python)
- ⬜ Remove broker calls
- ⬜ Update output format to include discipline_status, entry_timing
- ⬜ Add endpoint to send decision to RCA: `POST /api/risk-control/evaluate`
- ⬜ Tests: 15 unit tests

### Phase 2: Risk Control Agent Build (Week 2-3)
- ⬜ Create `server/risk-agent/` directory
- ⬜ Implement trade approval logic
- ⬜ Implement real-time monitoring (WebSocket, position tracking)
- ⬜ Implement exit decision logic (paper & live)
- ⬜ Implement modification requests (live trades)
- ⬜ Add APIs for Discipline/AI exit requests
- ⬜ Tests: 30+ unit tests, 10+ integration tests

### Phase 3: Trade Executor Agent Build (Week 2-3, parallel)
- ⬜ Create `server/executor/` if not exist
- ⬜ Implement submitTrade() from RCA approval
- ⬜ Implement modifyOrder() from RCA
- ⬜ Implement exitTrade() from RCA
- ⬜ Implement broker event handling
- ⬜ Ensure idempotency
- ⬜ Tests: 25+ unit tests, 10+ integration tests

### Phase 4: Discipline Engine Enhancement (Week 2)
- ⬜ Add session P&L tracking
- ⬜ Add circuit breaker implementation
- ⬜ Add exit signaling: `POST /api/discipline/requestExit`
- ⬜ Tests: 10+ unit tests

### Phase 5: Portfolio Agent (Week 1-2, parallel)
- ⬜ If not exist: create portfolio models & persistence
- ⬜ Implement all mutation APIs
- ⬜ Implement query APIs
- ⬜ Tests: 20+ unit tests

### Phase 6: Integration & Cutover (Week 4)
- ⬜ Decision Engine → Risk Control Agent
- ⬜ Risk Control Agent → Trade Executor Agent
- ⬜ Trade Executor Agent → Broker
- ⬜ Trade Executor Agent → Portfolio Agent
- ⬜ Discipline Engine → Risk Control Agent signals
- ⬜ Full regression tests
- ⬜ Canary: Paper trades only
- ⬜ Rollout: Live trades

### Phase 7: Cleanup (Week 4)
- ⬜ Delete execution_module.py
- ⬜ Remove all direct broker calls from Python
- ⬜ Update documentation
- ⬜ Archive old code

### Phase 8: Feedback Agent (Future, not in scope)
- ⬜ Build FeedbackAgent
- ⬜ Hook to Risk Control Agent
- ⬜ Enable parameter tuning

---

## API Contracts Summary

### Decision Engine → Risk Control Agent
```
POST /api/risk-control/evaluate
Input: ai_decision_{instrument}.json
Output: {action, approved_trade, constraints}
```

### Risk Control Agent → Trade Executor Agent
```
POST /api/executor/submitTrade
POST /api/executor/modifyOrder
POST /api/executor/exitTrade
```

### Trade Executor Agent → Broker (ONLY)
```
brokerService.placeOrder()
brokerService.modifyOrder()
brokerService.cancelOrder()
```

### Trade Executor Agent → Portfolio Agent
```
POST /api/portfolio/recordTradePlaced
POST /api/portfolio/recordTradeUpdated
POST /api/portfolio/recordTradeClosed
```

### Discipline Engine → Risk Control Agent
```
POST /api/risk-control/requestExit
Input: {position_id, reason}
```

---

## Key Principles (Enforced)

1. **Single Execution Point**: TradeExecutorAgent is ONLY module calling broker
2. **Single Position Owner**: Portfolio Agent owns all position state
3. **Single Risk Owner**: RiskControlAgent owns all SL/TP/TSL decisions
4. **Single Rule Owner**: DisciplineEngine owns rule enforcement
5. **Paper vs Live Aware**: RiskControlAgent knows the difference
6. **Event-Driven**: Broker events drive state transitions
7. **Audit Trail**: All decisions, modifications, exits logged
8. **Fail-Safe**: Missing data doesn't execute (conservative)

---

## Success Criteria

- ✅ execution_module.py deleted
- ✅ All 7 responsibilities reassigned to specialized modules
- ✅ Zero direct broker calls outside TradeExecutorAgent
- ✅ Portfolio Agent is single source of position truth
- ✅ Portfolio Agent records all trade outcomes (win/loss, exit reason, P&L)
- ✅ RiskControlAgent monitors all open positions real-time
- ✅ RCA does NOT record outcomes (Portfolio Agent owns this)
- ✅ Discipline Engine can halt trading and request exits
- ✅ AI Decision Engine can request exits via Discipline/RCA
- ✅ Paper trades fully managed by RCA
- ✅ Live trades allow RCA to modify SL/TP/TSL
- ✅ Full test coverage (100+ tests)
- ✅ Zero data consistency issues

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| RCA monitoring lag | WebSocket ticks + 1s polling fallback |
| Broker order fills while RCA modifying | Idempotency + transaction IDs |
| RCA → TradeEx latency | In-process calls (same server) |
| Paper SL/TP not detected | RCA checks every 1-5s |
| Live SL/TP not detected by broker | RCA monitors as backup |
| Discipline signal lost | Event-based with ack/retry |

---

## Questions for Clarification

None at this point. Architecture is locked.

---

**Status:** Ready for Phase 0 → Phase 1 transition
**Approval:** User (2026-04-08)
**Owner:** AI Team
