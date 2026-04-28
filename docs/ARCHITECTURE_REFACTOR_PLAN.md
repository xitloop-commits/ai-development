# Architecture Refactor Plan: Unified Execution Model
**Date:** 2026-04-08 (original) · Revised 2026-04-21
**Status:** Approved for Implementation
**Version:** 2.0

---

## Preamble (Revision 2026-04-21)

The original (2026-04-08) plan introduced a separate **Decision Engine** as a fifth agent sitting between AI signal generation and RCA. That split has since been collapsed:

- **No standalone Decision Engine.** Its two responsibilities — pre-trade policy validation and entry timing — are owned by the **Discipline Agent** (Module 4: Pre-Trade Gate) and, for capital protection / session halt, **Module 8**.
- **SEA** (Strategy / Signal Engine Agent, Python) is the sole producer of AI trade signals. SEA posts directly to Discipline, then RCA, then TEA.
- The Python monolith that previously bundled these concerns has been deleted. Its seven legacy responsibilities have been split across the four remaining agents (see mapping below).

This document is retained as the authoritative architecture record. Every section has been updated to reflect the collapsed model. References to "Decision Engine" as a live module have been removed.

---

## Executive Summary

The trading system is organized around four specialized agents with strictly non-overlapping responsibilities, plus SEA as the upstream signal producer:

```
SEA (Python, generates signals)
  → POST /api/discipline/validateTrade   (Discipline: pre-trade gate + entry timing — Module 4)
  → POST /api/risk-control/evaluate      (RCA: approves, sizes, sets SL/TP)
  → POST /api/executor/submitTrade       (TEA — ONLY broker caller)
  → Broker (Dhan)
  → Portfolio Agent records outcome
  → Portfolio pushes P&L to Discipline (caps + carry forward — Module 8)
  → Discipline sends MUST_EXIT signals to RCA when caps/circuit-breaker trip
  → RCA validates AI/SEA exit signals + own rules + honors Discipline → TEA.exitTrade
```

**Key principles (enforced):**

1. **Single execution point** — TradeExecutorAgent is the ONLY module that calls the broker.
2. **Single position owner** — Portfolio Agent owns all position state and trade outcomes.
3. **Single risk owner** — RCA owns all live SL/TP/TSL and exit decisions.
4. **Single policy owner** — Discipline Agent owns all pre-trade gating, capital caps, and session halts.

---

## Legacy Responsibilities → New Owners

The earlier Python monolith carried seven responsibilities. The module itself has been deleted; each responsibility now lives in one of the surviving agents.

| # | Legacy responsibility | New owner | Notes |
|---|---|---|---|
| 1 | Read AI decisions | SEA (produces directly) | SEA writes signal; Discipline validates before it reaches RCA |
| 2 | Check Discipline Agent | Discipline Agent — Module 4 | `POST /api/discipline/validateTrade` is the pre-trade gate |
| 3 | Entry timing validation | Discipline Agent — Module 4 | Folded into the pre-trade gate evaluation |
| 4 | Profit exits (6%, 10%) | Risk Control Agent | RCA's own rules in continuous monitoring |
| 5 | Position monitoring & exits | Risk Control Agent | 1–5s monitoring loop over all open positions |
| 6 | Session management | Discipline Agent — Module 8 | Daily caps, carry forward, session halt |
| 7 | Feedback loop tuning | FeedbackAgent (future) | Deferred |

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          UNIFIED EXECUTION FLOW                              │
└─────────────────────────────────────────────────────────────────────────────┘

1. SEA (Python) — Signal Producer
   ├─ Loads market data, option chain, AI analysis
   ├─ Emits trade signal: {direction, entry, suggested_SL, suggested_TP,
   │                       confidence, entry_timing, timestamp}
   └─ POSTs to Discipline: /api/discipline/validateTrade

   Continuous (while positions open):
   ├─ Emits AI signals (trend reversal, breakout failed, anomalies)
   └─ POSTs to RCA: /api/risk-control/ai-signal

                              ↓

2. DISCIPLINE ENGINE (TypeScript) — Policy Layer
   Modules 1–7 (existing rule enforcement):
   ├─ Circuit breaker, trade limits, time windows
   ├─ Position sizing, journal, streaks
   └─ Pre-Trade Gate (Module 4) — validates SEA signal:
        - Is trading allowed? (time, count, capital, cooldowns)
        - Entry timing confirmation (momentum, volume, breakout)
        - Session halted? → BLOCK
      Output: { allowed: bool, blocked_by: [...], warnings: [...],
                approved_signal_payload_for_RCA }

   Module 8 (Capital Protection & Session Management):
   ├─ Daily Profit Cap: +5% → MUST_EXIT signal to RCA
   ├─ Daily Loss Cap: -2% → MUST_EXIT signal to RCA
   ├─ Session Halt Flag (blocks new entries)
   ├─ Carry Forward Engine (15:15 evaluation)
   └─ Daily P&L Tracking (pushed from Portfolio Agent)

   If allowed → forwards to RCA: /api/risk-control/evaluate

                              ↓

3. RISK CONTROL AGENT (TypeScript) — HUB FOR ALL RISK DECISIONS

   A. Entry Approval:
   ├─ Validate capital, portfolio, volatility
   ├─ Override / finalize SL/TP
   ├─ Decide position size
   └─ If APPROVE → POST /api/executor/submitTrade

   B. Continuous Monitoring (1–5s):
   ├─ Monitor price for all OPEN positions
   ├─ Check exit conditions:
   │  ├─ Discipline MUST_EXIT signals (mandatory)
   │  ├─ RCA's own rules (momentum, volatility, age)
   │  └─ AI/SEA signals (validated before executing)
   │
   ├─ Paper trades: RCA detects SL/TP hits, triggers exit
   ├─ Live trades: broker manages SL/TP; RCA may modifyOrder / exitTrade
   └─ Sends commands to TEA only

                              ↓

4. TRADE EXECUTOR AGENT (TradeExecutorAgent / TEA, TypeScript)
   ├─ ONLY broker caller
   ├─ submitTrade() → brokerService.placeOrder(), attaches SL/TP/TSL
   ├─ modifyOrder() → brokerService.modifyOrder()
   ├─ exitTrade()   → brokerService.cancelOrder() + placeOrder(SELL)
   ├─ Handles broker events (fills, rejections, SL/TP auto-exit)
   └─ Notifies Portfolio Agent on every state change

                              ↓

5. PORTFOLIO AGENT (TypeScript)
   ├─ Owns all position state (open/closed)
   ├─ Records trade outcomes (win/loss, exit reason, P&L, exit_triggered_by)
   ├─ Computes daily realized P&L (absolute + percent)
   └─ Pushes trade outcomes to Discipline:
        POST /api/discipline/recordTradeOutcome   (triggers cap checks)

                              ↓

6. FEEDBACK AGENT (TypeScript, Future)
   └─ Deferred — analyzes Portfolio Agent outcomes and tunes parameters
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

2. DISCIPLINE ENGINE (hard rules)
   ├─ Circuit breaker hit (daily loss limit) → EXIT_ALL
   ├─ Daily loss cap (-2%) / profit cap (+5%) → EXIT_ALL
   ├─ Cooldown active (loss penalty) → EXIT_THIS
   ├─ Session halted (15:15 carry forward failed) → EXIT_OPEN
   └─ Action: Discipline → RCA → TradeExecutorAgent → Broker

   Note: RCA honors these unconditionally (they're mandatory)

3. AI/SEA SIGNALS (continuous signals from SEA)
   ├─ Trend reversal detected → EXIT
   ├─ Breakout failed at resistance → EXIT
   ├─ New bullish/bearish pattern → MODIFY_TP
   ├─ Anomaly in price action → EXIT or TIGHTEN_SL
   ├─ Stop hunt detected → TIGHTEN_SL or EXIT
   └─ Action: SEA → RCA → TradeExecutorAgent → Broker

   Note: RCA validates these against current momentum/volatility
         May accept, reject, or partially honor
```

### Communication Diagram

```
                    ┌─────────────────────┐
                    │        SEA          │
                    │      (Python)       │
                    └──────────┬──────────┘
                               │
               Trade signal + continuous AI signals
                               │
                               ▼
        ┌──────────────────────────────────────────┐
        │   DISCIPLINE ENGINE (TypeScript)         │
        │   Module 4: Pre-Trade Gate               │
        │   Module 8: Capital Protection           │
        │   - validates SEA signal                 │
        │   - enforces caps, cooldowns, windows    │
        │   - emits MUST_EXIT to RCA when tripped  │
        └──────────────┬───────────────────────────┘
                       │ validated signal
                       ▼
        ┌──────────────────────────────────────────┐
        │  RISK CONTROL AGENT (TypeScript)         │
        │  ← HUB FOR ALL RISK DECISIONS            │
        │                                           │
        │  Sources of requests:                     │
        │  ├─ Own rules (continuous monitoring)     │
        │  ├─ Discipline Agent (mandatory)         │
        │  └─ SEA AI signals (validated)            │
        │                                           │
        │  Decides: APPROVE / EXIT / MODIFY        │
        └──────────────┬───────────────────────────┘
                       │ submitTrade / modifyOrder / exitTrade
                       ▼
        ┌──────────────────────────────────────────┐
        │  TRADE EXECUTOR AGENT (TypeScript)       │
        │  ← ONLY BROKER CALLER                    │
        │                                           │
        │  Executes:                                │
        │  ├─ placeOrder()                          │
        │  ├─ modifyOrder()                         │
        │  └─ cancelOrder() + placeOrder(SELL)      │
        └──────────────┬───────────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────────┐
        │  BROKER (Dhan API)                       │
        │  ├─ Live: manages SL/TP auto-exit         │
        │  └─ Paper: TEA/RCA manage exits           │
        └──────────────┬───────────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────────┐
        │  PORTFOLIO AGENT (TypeScript)            │
        │  ← OUTCOME RECORDER                       │
        │                                           │
        │  Records:                                 │
        │  ├─ Trade outcome (win/loss)              │
        │  ├─ Exit reason (SL, TP, MOMENTUM, etc)   │
        │  ├─ exit_triggered_by (RCA, Broker,       │
        │  │   Discipline, AI/SEA, USER)            │
        │  └─ Pushes daily P&L to Discipline        │
        └──────────────────────────────────────────┘
```

---

## Detailed Responsibility Mapping

### 1. SEA (Python) — Signal Producer

**Responsibilities:**

- Load market data, option chain, news sentiment
- Compute weighted scores (OI momentum, wall strength, IV, PCR, theta risk)
- Predict breakout vs bounce at S/R levels
- Produce signal output:

```json
{
  "instrument": "NIFTY_50",
  "direction": "GO_CALL" | "GO_PUT" | "WAIT",
  "trade_setup": {
    "strike": 24150,
    "entry_price": 185.50,
    "target_price": 241.15,
    "stop_loss": 148.40,
    "risk_reward": 1.5
  },
  "confidence_score": 0.72,
  "entry_timing": {
    "momentum_score": 65,
    "volume_spike": true,
    "price_breakout": true
  },
  "timestamp": "ISO8601"
}
```

**Does NOT:**
- Call the broker
- Track positions
- Place or exit orders
- Validate pre-trade rules (that's Discipline)

**Outbound APIs:**
- `POST /api/discipline/validateTrade` (entry)
- `POST /api/risk-control/ai-signal` (continuous AI signals on open positions)

---

### 2. DISCIPLINE ENGINE (TypeScript)

**Modules 1–7 (existing, unchanged from v1.1):**
- Circuit Breaker & Loss Limits
- Trade Limits & Cooldowns
- Time Windows
- Pre-Trade Gate (validates SEA signal, runs entry-timing check)
- Position Size & Exposure
- Journal & Weekly Review
- Streaks & Dashboard

**Module 8 (Capital Protection & Session Management):**
- Daily P&L tracking (pushed by Portfolio Agent)
- Circuit breaker / profit cap / loss cap
- Session halted flag
- Carry forward rules (15:15 auto-evaluate)
- Sends `MUST_EXIT` signals to RCA

**Inbound APIs:**
- `POST /api/discipline/validateTrade` — called by SEA before a trade
- `POST /api/discipline/recordTradeOutcome` — called by Portfolio after each close

**Outbound APIs:**
- `POST /api/risk-control/discipline-request` — signals RCA to exit or modify

See **DisciplineAgent_Spec_v1.4.md** for the full specification.

---

### 3. RISK CONTROL AGENT (TypeScript)

**Responsibilities:**

#### A. Trade Approval (after Discipline pre-trade gate)
```typescript
POST /api/risk-control/evaluate
  Input: validated SEA signal + Discipline status
  Logic:
    ├─ Validate capital, portfolio, volatility
    ├─ Size position, finalize SL/TP
    └─ APPROVE → POST /api/executor/submitTrade
  Output: { action, approved_trade, constraints }
```

#### B. Real-Time Monitoring (Continuous, 1–5s)
```typescript
for each OPEN_POSITION:
  ├─ Get current_price (WebSocket)
  ├─ Check exit conditions (in precedence order):
  │  ├─ Discipline signal (mandatory)
  │  ├─ SL / TP / momentum / age (RCA own rules)
  │  └─ AI/SEA signal (validated)
  │
  ├─ Check modification opportunities (live only):
  │  ├─ Trailing SL update
  │  ├─ SL tighten on volatility spike
  │  ├─ TP extend on momentum growth
  │  └─ TSL trigger adjustment
  │
  └─ Send commands to TEA:
     ├─ exitTrade(position_id, reason)
     ├─ modifyOrder(position_id, new_SL, new_TP, new_TSL)
     └─ adjustTrailingSL(position_id, new_distance)
```

#### C. Handling External Requests

**From Discipline Agent:**
```typescript
POST /api/risk-control/discipline-request
  Body: {position_id, action: 'EXIT'|'MODIFY', reason, params}
  Reasons: CIRCUIT_BREAKER | COOLDOWN | SESSION_HALT | LOSS_LIMIT | PROFIT_CAP | CARRY_FORWARD
  Behavior: mandatory — RCA executes immediately
```

**From SEA (AI signals):**
```typescript
POST /api/risk-control/ai-signal
  Body: {position_id, action: 'EXIT'|'MODIFY', signal, reason, params}
  Signals: TREND_REVERSAL | BREAKOUT_FAILED | NEW_DIRECTION | ANOMALY | TIGHTEN_SL | ADJUST_TP | ENABLE_TSL
  Behavior: RCA validates against current momentum/volatility; accepts, rejects, or partially honors
```

**What RCA Does NOT Do:**
```
❌ Record trade outcomes (Portfolio Agent owns)
❌ Track P&L (Portfolio Agent owns)
❌ Persist position state (Portfolio Agent owns)
❌ Enforce pre-trade rules (Discipline owns)
❌ Generate AI signals (SEA owns)
❌ Call broker (TEA only)
```

**APIs RCA Exposes:**

```
POST /api/risk-control/evaluate            ← from Discipline (entry approval)
POST /api/risk-control/ai-signal           ← from SEA (continuous)
POST /api/risk-control/discipline-request  ← from Discipline (hard rules)
GET  /api/risk-control/position/:id        ← monitoring queries
```

See **RiskControlAgent_Spec_v2.0.md** for the full specification.

---

### 4. TRADE EXECUTOR AGENT (TypeScript)

**Responsibilities:**

#### A. Execute Trade Submissions from RCA
```typescript
POST /api/executor/submitTrade
  Input: { environment: 'paper'|'live', instrument, direction,
           quantity, entry_price, stop_loss, take_profit,
           trailing_stop_loss, order_type, product_type }
  Execution:
    ├─ Sanity + idempotency checks
    ├─ brokerService.placeOrder()   ← ONLY place that calls broker
    ├─ Update Portfolio Agent
    └─ Return { trade_id, position_id, executed_price }
```

#### B. Execute Modifications from RCA (live only)
```typescript
POST /api/executor/modifyOrder
  Input: { position_id, new_SL, new_TP, new_TSL, reason }
  Execution: brokerService.modifyOrder()
```

#### C. Execute Exits from RCA
```typescript
POST /api/executor/exitTrade
  Input: { position_id, exit_type, exit_price?, reason }
  Live: cancel broker SL/TP, then placeOrder(SELL)
  Paper: placeOrder(SELL) via paper adapter
  Updates Portfolio Agent
```

#### D. Receive Broker Events
```typescript
// WebSocket
receive: orderUpdateEvent({order_id, status, filled_qty, fill_price})
  ├─ Update Portfolio Agent
  ├─ Notify RCA (filled, rejected, partial)

// SL/TP auto-exit (live trades)
receive: tradeClosedEvent({position_id, exit_price, reason: 'SL'|'TP'})
  └─ Portfolio Agent records outcome
```

**Key Rule:**
```
❌ NEVER call brokerService from any module except TradeExecutorAgent
✅ All other modules submit requests to TradeExecutorAgent via API
```

See **TradeExecutorAgent_Spec_v1.3.md** for the full specification.

---

### 5. PORTFOLIO AGENT (TypeScript)

**Owns:**
- All position objects (open/closed)
- Trade outcomes (win/loss, P&L, exit reason, `exit_triggered_by`)
- P&L calculations (realized + unrealized)
- Daily realized P&L (absolute + percent)
- Capital / margin usage
- Win/loss streaks
- Historical trade records

**Updated By:** TradeExecutorAgent ONLY
**Queried By:** RCA, Discipline Agent, Dashboard, FeedbackAgent (future)

**APIs:**
```
POST /api/portfolio/recordTradePlaced
POST /api/portfolio/recordTradeUpdated
POST /api/portfolio/recordTradeClosed
POST /api/portfolio/recordExitRequest

GET  /api/portfolio/state
GET  /api/portfolio/positions
GET  /api/portfolio/metrics
GET  /api/portfolio/daily-pnl
GET  /api/portfolio/tradeOutcomes
```

**Push to Discipline on every close:**
```
POST /api/discipline/recordTradeOutcome
  → triggers cap checks (Module 8)
```

See **PortfolioAgent_Spec_v1.3.md** for the full specification.

---

## Implementation Phases

### Phase 0: Planning & Design — ✅ Complete
- Architecture approved (2026-04-08)
- API contracts defined
- RCA v2.0, TEA v1.3, Discipline v1.3, Portfolio v1.1 specs written
- Discipline Module 8 folded Session Manager in (same phase)

### Phase 1: Discipline Agent (Weeks 1–2)
- Add Module 4 Pre-Trade Gate `/api/discipline/validateTrade`
- Add Module 8 Capital Protection (caps, carry forward, session halt)
- Wire `recordTradeOutcome` receiver
- Tests: 35+ unit, 10+ integration

### Phase 2: Risk Control Agent (Weeks 2–3)
- Create `server/risk-agent/`
- Trade approval logic + position sizing
- Real-time monitoring loop (WebSocket + 1–5s poll fallback)
- Exit decision logic (paper + live)
- Modification requests (live)
- APIs: `/evaluate`, `/ai-signal`, `/discipline-request`
- Tests: 30+ unit, 10+ integration

### Phase 3: Trade Executor Agent (Weeks 2–3, parallel)
- `submitTrade`, `modifyOrder`, `exitTrade`, broker event handling
- Idempotency keys and audit trail
- Tests: 25+ unit, 10+ integration

### Phase 4: Portfolio Agent (Weeks 1–2, parallel)
- Position/outcome models + persistence
- Daily P&L metrics
- Push to Discipline on each close
- Tests: 15+ unit

### Phase 5: Integration & Cutover (Week 4)
- SEA → Discipline → RCA → TEA → Broker end-to-end
- Discipline → RCA MUST_EXIT path
- Portfolio push-to-Discipline path
- Full regression
- Canary on paper, then live

### Phase 6: Cleanup (Week 4)
- Confirm Python monolith is deleted (no references remain)
- Update documentation
- Archive diagrams labeled "legacy"

### Phase 7: FeedbackAgent (Future, out of scope)

---

## API Contracts Summary

### SEA → Discipline Agent (pre-trade gate)
```
POST /api/discipline/validateTrade
Body: { instrument, trade_setup, confidence_score, entry_timing, timestamp }
Returns: { allowed, blocked_by, warnings, approved_payload_for_rca }
```

### Discipline Agent → Risk Control Agent (entry)
```
POST /api/risk-control/evaluate
Body: { signal, discipline_status }
Returns: { action, approved_trade, constraints }
```

### SEA → Risk Control Agent (continuous AI signals)
```
POST /api/risk-control/ai-signal
Body: { position_id, action, signal, reason, params }
```

### Discipline Agent → Risk Control Agent (hard rules)
```
POST /api/risk-control/discipline-request
Body: { position_id, action, reason, params }
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

### Portfolio Agent → Discipline Agent (push)
```
POST /api/discipline/recordTradeOutcome
```

---

## Key Principles (Enforced)

1. **Single Execution Point** — TradeExecutorAgent is the ONLY module calling the broker.
2. **Single Position Owner** — Portfolio Agent owns all position state.
3. **Single Risk Owner** — RCA owns all SL/TP/TSL and exit decisions.
4. **Single Policy Owner** — Discipline Agent owns all pre-trade gating and capital protection.
5. **Paper vs Live Aware** — RCA and TEA differentiate; broker handles SL/TP on live.
6. **Event-Driven** — Broker events drive state transitions.
7. **Audit Trail** — All decisions, modifications, exits logged with `exit_triggered_by`.
8. **Fail-Safe** — Missing or stale data blocks execution (conservative).

---

## Success Criteria

- ✅ Python execution monolith fully removed from repo
- ✅ Zero direct broker calls outside TradeExecutorAgent
- ✅ Portfolio Agent is single source of position truth
- ✅ Portfolio Agent records all trade outcomes with `exit_triggered_by`
- ✅ RCA monitors all open positions in real-time (< 5s latency)
- ✅ Discipline Agent can halt trading and request exits via RCA
- ✅ SEA AI signals flow through Discipline → RCA (no direct SEA → TEA path)
- ✅ Paper trades fully managed by RCA
- ✅ Live trades allow RCA to modify SL/TP/TSL via TEA
- ✅ Full test coverage (100+ tests across all four agents)
- ✅ Zero data consistency issues across agents

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| RCA monitoring lag | WebSocket ticks + 1s polling fallback |
| Broker fills while RCA modifying | Idempotency + transaction IDs |
| RCA → TEA latency | In-process calls (same server) |
| Paper SL/TP not detected | RCA checks every 1–5s |
| Live SL/TP not detected by broker | RCA monitors as backup |
| Discipline signal lost | Event-based with ack/retry |
| SEA emits while Discipline halted | Discipline blocks validateTrade; signal never reaches RCA |

---

**Status:** Architecture locked. Implementation in progress.
**Approval:** User (2026-04-08)
**Revised:** 2026-04-21 to collapse Decision Engine into Discipline Modules 4 & 8
**Owner:** Engineering Team
