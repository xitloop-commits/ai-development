# Portfolio Agent Spec v1.3

**Document:** PortfolioAgent_Spec_v1.3.md
**Project:** Automatic Trading System (ATS)
**Status:** Implementation (Phase 1 in progress)
**Supersedes:** CapitalPools_Spec_v1.4.md (absorbed)

---

## Change History

| Version | Date | Author | Summary |
| --- | --- | --- | --- |
| v1.0 | 2026-04-08 | AI Team | Initial specification for a unified, centralized Portfolio Agent that manages portfolio state, capital, exposure, drawdown, and portfolio-level risk signals. |
| v1.0.1 | 2026-04-09 | Architecture Team | **ENHANCEMENT:** Added trade outcome recording (Section 5.2), daily P&L metrics, exit_triggered_by field for tracking who initiated trade exits. Integration with Discipline Agent capital protection, RCA exit signals, and SEA (AI signals). |
| v1.1 | 2026-04-09 | AI Team | **UPDATED:** Replaced 5-second polling model with push-only integration — Portfolio Agent calls discipline.recordTradeOutcome after every trade close. Defined full response contract for GET /api/portfolio/daily-pnl (7 fields). Clarified endpoint is for on-demand reads only, not cap monitoring. |
| v1.2 | 2026-04-24 | Architecture Team | **CHANNEL NORMALIZATION:** Replaced legacy `'live' \| 'paper_manual' \| 'paper'` channel vocabulary with the six-channel canonical form per BSA v1.9 (`ai-live \| ai-paper \| my-live \| my-paper \| testing-live \| testing-sandbox`). All API signatures keyed by `channel: Channel`. |
| v1.3 | 2026-04-25 | Architecture Team | **CONSOLIDATION:** Absorbed CapitalPools_Spec_v1.4 content into this document — Project Target, Capital Architecture (75/25 split), Day Index System (forward/backward/clawback/floor), Compounding model, and Position Sizing now live here as Sections 2.1–2.5. CapitalPools_Spec_v1.4.md is deprecated; cross-refs point here. Phase 1 implementation: PortfolioAgent owns `compounding.ts`, `state.ts`, `tickHandler.ts`, and the `portfolio.*` tRPC namespace. |

---

## 1. Overview

The Portfolio Agent is the single source of truth for portfolio state across the ATS. It centralizes capital, exposure, open position state, drawdown tracking, and performance metrics. It also provides portfolio-level data and risk signals to the Strategy Agent, Risk Control Agent, and Execution Engine.

This agent is responsible for maintaining a coherent portfolio view and exposing a standardized API for all trading subsystems.

## 2. Purpose

The Portfolio Agent will:

- Own and persist portfolio state
- Manage open positions and exposure
- Track capital, available funds, and margin usage
- Calculate portfolio-level P&L, drawdown, and risk metrics
- Serve portfolio data to strategy, risk, and execution systems
- Enforce portfolio-level constraints and alerts
- Maintain six independent capital pools, one per **channel** (`ai-live`, `ai-paper`, `my-live`, `my-paper`, `testing-live`, `testing-sandbox`) per BSA v1.9 — pool maths is identical across channels; only the persisted state differs.
- Drive the 250-day compounding journey (75/25 split, Day Index cycles, clawback) — see Sections 2.1–2.5 (absorbed from CapitalPools_Spec_v1.4)

---

### 2.1 Project Target *(absorbed from CapitalPools v1.4 §2)*

> **Achieve 250 completed Day Index cycles starting from ₹1,00,000 initial funding, where each cycle represents a +5% profit on the Trading Capital at the start of that cycle.**

| Parameter | Value |
|-----------|-------|
| Initial Funding | ₹1,00,000 |
| Initial Trading Pool | ₹75,000 (75%) |
| Initial Reserve Pool | ₹25,000 (25%) |
| Target per Day Index Cycle | +5% of Trading Capital at start of cycle (configurable) |
| Effective Compounding Rate (Trading) | 3.75% per cycle (75% of 5% profit retained) |
| Total Cycles | 250 |
| Approximate Timeframe | ~1 year (250 market trading days; cycles may span multiple calendar days) |

These parameters are per-channel — every channel runs its own 250-day journey on its own pools. Default values match a fresh `my-live` allocation; AI/paper/testing channels start identical and diverge based on outcomes.

### 2.2 Capital Architecture *(absorbed from CapitalPools v1.4 §3)*

**Universal Capital Allocation Rule:** All incoming capital — regardless of source — is split 75% to Trading Pool and 25% to Reserve Pool.

| Capital Source | Trading Pool (75%) | Reserve Pool (25%) |
|----------------|--------------------|--------------------|
| Initial allocation | ₹75,000 | ₹25,000 |
| Profit earned | 75% of profit | 25% of profit |
| New capital injection | 75% of new funds | 25% of new funds |

**Capital Rules**

- **Profit split:** 75% → Trading Pool; 25% → Reserve Pool
- **Loss handling:** 100% of loss deducted from Trading Pool; Reserve untouched
- **Reserve rules:** No automatic debit, no clawback, no loss adjustment. Reserve grows only via profit split or new capital injection (25% share). Manual transfer only (Reserve → Trading), via `portfolio.transferFunds`.

### 2.3 Compounding Model *(absorbed from CapitalPools v1.4 §4)*

- Effective compounding rate: 3.75% per Day Index cycle
- Trading Pool compounds; Reserve Pool accumulates (non-compounding)

### 2.4 Day Index System *(absorbed from CapitalPools v1.4 §5)*

A "Day" is **not** a calendar day — it is one completed profit cycle (default +5%, configurable) on the combined Trading Capital across all instruments on that channel. The system stays in the same Day Index until the target is reached, regardless of how many calendar days it takes.

**Forward Movement**
If combined cumulative P&L ≥ target (e.g. +5%) of Trading Capital at start of cycle:
- Move to next day (Day + 1)
- Apply profit split (75/25)

**Backward Movement (Clawback)**
If cumulative loss ≥ −5%:
- The loss eats into the **full profit of the previous day(s)**, but the deduction happens **only from the Trading Pool**.
- The 25% profit that went to Reserve in previous days is permanently safe and not considered for loss adjustment.
- Move backward (Day − 1). The previous day is nullified.
- Continue until loss is fully absorbed by previous Trading Pool profits, or Day 1 is reached.
- **Incomplete Day Recovery:** If a clawback partially eats a previous day's profit, that day is no longer complete. The system stays on that day and must earn the remaining gap to hit the original target. The target does not reset; the remaining profit carries forward.

**Floor Condition**
- Minimum Day = Day 1
- No backward movement below Day 1
- Unabsorbed loss remains in Trading Pool

**Carry Forward Rule**
- Excess profit beyond the target carries forward to the next day cycle (becomes Day N+1's opening P&L).

### 2.5 Position Sizing *(absorbed from CapitalPools v1.4 §7)*

- Position sizing is percentage-based. The user selects a percentage of Available Capital (5%–100%) when placing each trade.
- There is no system-mandated fixed allocation — the user freely chooses per trade.
- The Discipline Agent enforces configurable ceilings (default: 40% max per position, 80% max total exposure) — see DisciplineAgent_Spec_v1.4.
- If there are not enough available funds (Trading Pool minus capital already deployed in open positions) for the selected percentage, the trade does not execute.

## 3. Goals

- Eliminate fragmented portfolio state across Python and server subsystems
- Provide a centralized portfolio state API
- Make portfolio data authoritative for risk, sizing, and execution
- Support real-time updates and historical portfolio analytics
- Facilitate consistent capital and exposure decisions across agents

## 4. Inputs

### 4.1 Trade Lifecycle Events

- `tradePlaced`
- `tradeUpdated`
- `tradeClosed`
- `tradeRejected`

### 4.2 Market Data

- `currentPrice`
- `markToMarket` valuations for open positions
- `marginRate` and exposure adjustments

### 4.3 Capital State Sources

- Broker-reported available funds and margin
- Internal capital pools and session counters
- Historical trade journal records

### 4.4 Strategy / Risk Signals

- `portfolioAllocationRequests`
- `positionSizeRecommendations`
- `capitalDrawdownLimits`

## 5. Outputs

### 5.1 Portfolio Snapshot

- `currentCapital`
- `availableCapital`
- `openExposure`
- `openMargin`
- `unrealizedPnl`
- `realizedPnl`
- `drawdownPercent`
- `winLossStreak`
- `openPositionCount`
- `positionConcentration`
- **`dailyRealizedPnl` ✨** — Cumulative realized P&L from today's closed trades (absolute value, e.g., +5000 or -2500)
- **`dailyRealizedPnlPercent` ✨** — Daily realized P&L as percentage of opening capital (e.g., +3.7%, -1.9%)

### 5.2 Trade Outcome Recording ✨

When a trade closes, the Portfolio Agent records the outcome including P&L, duration, and who triggered the exit. This data is used by Discipline Agent to track daily P&L and by RCA to validate exit decisions.

**Endpoint:** `POST /api/portfolio/recordTradeClosed`

**Request Body:**
```typescript
interface TradeClosedRequest {
  tradeId: string;                // Unique trade identifier
  instrument: string;             // "NIFTY_50_CE_24500" etc
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryTime: Date;
  exitTime: Date;
  
  // P&L Details
  realizedPnl: number;            // Absolute P&L (e.g., +5000 or -2500)
  realizedPnlPercent: number;     // As % of entry capital for this trade
  
  // Exit Information
  exitReason: string;             // "SL" | "TP" | "RCA_EXIT" | "AI_EXIT" | "DISCIPLINE_EXIT" | "MANUAL"
  exitTriggeredBy: "RCA" | "BROKER" | "DISCIPLINE" | "AI" | "USER";  // ✨ KEY FIELD
  
  // Trade Duration & Context
  duration: number;               // In seconds
  pnlCategory: "win" | "loss" | "breakeven";
  
  // Additional Context
  signalSource?: string;          // If AI-triggered or RCA-triggered, source of signal
  timestamp: Date;                // When trade closed
}
```

**Response:**
```typescript
interface TradeClosedResponse {
  success: boolean;
  tradeId: string;
  dailyPnlUpdated: number;        // Updated daily realized P&L
  dailyPnlPercentUpdated: number; // Updated daily P&L %
  positionsRemaining: number;     // Count of still-open positions
  timestamp: Date;
}
```

### 5.3 Portfolio Risk Signals

- `maxExposureBreached`
- `drawdownThresholdHit`
- `tradingCapacityLow`
- `positionConcentrationAlert`
- `portfolioHealthScore`

### 5.4 Historical Metrics

- `realizedPnlHistory`
- `maxDrawdownHistory`
- `dailyPnl`
- `winRate`
- `averageRr`
- `tradeCount`

## 6. Architecture

### 6.1 Agent Responsibilities

The Portfolio Agent will implement the following modules:

- `state-manager`: central portfolio state store and persistence
- `position-manager`: open/close position tracking and mark-to-market
- `capital-manager`: current/available capital, pools, and margin
- `exposure-manager`: portfolio exposure, concentration, and limit tracking
- `performance-engine`: P&L, drawdown, streaks, and history
- `api-layer`: tRPC/REST interfaces for other agents
- `integration-layer`: event ingestion from trade, market, and broker sources

### 6.2 Data Ownership

The Portfolio Agent owns:

- open position objects
- portfolio-level exposure totals
- available capital and margin usage
- realized and unrealized PnL
- portfolio drawdown and streak state
- session and channel state

### 6.3 Persistence

The agent persists portfolio state to the same backend used by the rest of the server stack. It also maintains an in-memory cache for low-latency queries.

Suggested persistence model:

- `portfolio_state` table / model
- `position_state` table / model
- `portfolio_metrics` table or derived view
- `portfolio_events` audit log

## 7. Interfaces and Contracts

### 7.1 Portfolio Agent APIs

#### Query APIs

- `portfolio.getState(channel)`
- `portfolio.getPositions(channel)`
- `portfolio.getMetrics(channel)`
- `portfolio.getHistory(channel, range)`

#### Mutation APIs

- `portfolio.recordTradePlaced(trade)`
- `portfolio.recordTradeUpdated(trade)`
- **`portfolio.recordTradeClosed(trade)` ✨** — Record trade outcome with P&L, exit reason, and who triggered the exit (RCA | BROKER | DISCIPLINE | AI)
- `portfolio.recordTradeRejected(trade, reason)`

#### Signal APIs

- `portfolio.evaluateExposure()`
- `portfolio.evaluateDrawdown()`
- `portfolio.evaluateHealth()`

### 7.2 Event Contracts

Event names and payloads:

- `trade.placed`
- `trade.cancelled`
- `trade.closed`
- `position.markedToMarket`
- `capital.updated`

Payload shape should include:

- `tradeId`, `instrument`, `qty`, `entryPrice`, `side`, `status`
- `currentPrice`, `unrealizedPnl`, `realizedPnl`
- `channel`, `timestamp`

## 8. Implementation Plan

### Phase 1: Foundation

- Define portfolio state model and schema
- Implement state manager and persistence layer
- Create position manager for open position tracking
- Add capital manager for current/available capital
- Expose query API for portfolio state
- Add event ingestion contract for trade lifecycle events

### Phase 2: Open Position & Exposure Management

- Implement accurate open exposure calculation
- Support mark-to-market valuation updates
- Add open position concentration metrics
- Build portfolio-level margin and available capital calculations
- Add portfolio health scoring

### Phase 3: Portfolio Performance Metrics

- Implement realized/unrealized PnL tracking
- Add drawdown and win/loss streak calculation
- Persist daily and historical portfolio metrics
- Add portfolio event audit logging

### Phase 4: Risk Signal Integration

- Expose portfolio risk signals to Risk Control Agent
- Implement `maxExposureBreached` and `drawdownThresholdHit`
- Add portfolio-level alerts for capacity and concentration
- Support feed to Strategy Agent for position sizing and trade acceptance

### Phase 5: Integration & Migration

- Replace fragmented portfolio state sources with Portfolio Agent APIs
- Update Python executor and server discipline calls to query portfolio state
- Migrate existing `OPEN_POSITIONS` and capital workflows into the agent
- Maintain compatibility with broker and capital subsystems during transition

### Phase 6: Testing & Validation

- Add unit tests for portfolio state and exposure calculations
- Add integration tests for trade lifecycle events and API contracts
- Simulate adverse drawdown and margin stress conditions
- Validate portfolio state consistency across channels

## 9. Agent State Model

### Portfolio State

- `channel`
- `currentCapital`
- `availableCapital`
- `openExposure`
- `openMargin`
- `realizedPnl`
- `unrealizedPnl`
- `drawdownPercent`
- `winLossStreak`
- `openPositionCount`
- `maxPositionPercent`
- `lastUpdated`

### Position State

- `id`
- `instrument`
- `side`
- `quantity`
- `entryPrice`
- `currentPrice`
- `stopLoss`
- `targetPrice`
- `status`
- `unrealizedPnl`
- `realizedPnl`
- `openedAt`
- `closedAt`
- **`exitTriggeredBy` ✨** — Who initiated the exit: "RCA" (real-time monitoring), "BROKER" (SL/TP auto-exit), "DISCIPLINE" (capital caps), "AI" (decision engine), or "USER" (manual)
- **`exitReason` ✨** — Why the position was closed: "SL", "TP", "RCA_EXIT", "DISCIPLINE_EXIT", "AI_EXIT", "MANUAL"

### Performance Metrics

- **`dailyRealizedPnl` ✨** — Cumulative realized P&L for today (sum of all closed trades today)
- **`dailyRealizedPnlPercent` ✨** — Daily realized P&L as percentage of opening capital
- `cumulativePnl`
- `maxDrawdown`
- `winRate`
- `averageRr`
- `tradeCount`
- **`dailyTradeOutcomes` ✨** — Array of closed trades for today with exit reasons and who triggered each exit

## 10. Integration with Other Agents ✨

### 10.1 Discipline Agent Integration

The Portfolio Agent pushes P&L data to Discipline Agent after every trade close. There is no polling.

**Push mechanism (primary):**

After every trade closes, Portfolio Agent calls:
```
POST /api/discipline/recordTradeOutcome
```
This is the trigger for Discipline Agent to run cap checks. No periodic polling exists.

**Reference endpoint (available on demand):**

```
GET /api/portfolio/daily-pnl

Response:
{
  channel: "ai-live" | "ai-paper" | "my-live" | "my-paper" | "testing-live" | "testing-sandbox",
  date: string,                       // "2026-04-09" IST
  openingCapital: number,             // Capital at start of day (denominator for % calc)
  dailyRealizedPnl: number,           // Absolute P&L from closed trades today
  dailyRealizedPnlPercent: number,    // (dailyRealizedPnl / openingCapital) × 100
  dailyUnrealizedPnl: number,         // MTM of currently open positions
  openPositionCount: number,          // Number of currently open positions
  lastUpdatedAt: Date                 // Timestamp of last P&L update
}
```

This endpoint is available for the carry forward evaluation at 15:15 IST and for any on-demand reads (e.g. dashboard, testing). It is not used for cap monitoring.

### 10.2 RCA Integration

The Portfolio Agent records when RCA exits a position:

- Trade outcome recorded with `exitTriggeredBy: "RCA"`
- RCA provides `exit_reason: "RCA_EXIT"` when exiting due to momentum, volatility, or age
- Portfolio Agent updates `dailyRealizedPnl` and triggers Discipline Agent cap checks

### 10.3 SEA (AI Signals) Integration

The Portfolio Agent records when AI signals (from SEA) trigger an exit:

- Trade outcome recorded with `exitTriggeredBy: "AI"`
- RCA validates the AI signal and executes exit via TradeExecutorAgent
- Exit reason: "AI_EXIT"

### 10.4 Broker Integration

The Portfolio Agent records when broker auto-exits (SL/TP hits) on live trades:

- Trade outcome recorded with `exitTriggeredBy: "BROKER"`
- Broker sends order fill/closure event to TradeExecutorAgent
- TradeExecutorAgent notifies Portfolio Agent: exit reason "SL" or "TP"

### 10.5 Data Ownership

**Important:** Only TradeExecutorAgent writes to Portfolio Agent's trade state.

- TradeExecutorAgent calls `portfolio.recordTradePlaced()` when order enters market
- TradeExecutorAgent calls `portfolio.recordTradeClosed()` when order exits market
- Other agents (RCA, Discipline, AI) read Portfolio data but do NOT write directly
- All exit decisions flow through TradeExecutorAgent to maintain authoritative audit trail

## 11. Versioning

This spec is versioned as `v1.3`. Future updates must be recorded in the Change History table.

## 12. Notes

- The Portfolio Agent is intended to become the authoritative portfolio state engine for the ATS.
- It should reduce duplicate state held in Python modules and server memory stores.
- Inputs from trade execution, market valuation, and capital updates must be kept consistent and fresh.
- **v1.0.1 (2026-04-09):** Enhanced for new unified execution architecture. Trade outcome recording now includes `exitTriggeredBy` field to track whether exit came from RCA, Broker, Discipline Agent, or AI signals (from SEA). Daily P&L metrics now feed capital protection monitoring in Discipline Agent.
- **v1.3 (2026-04-25):** CapitalPools_Spec_v1.4 fully absorbed. The Portfolio Agent is now the single document of record for capital pools, the 75/25 split, the 250-day journey, clawback mechanics, and position sizing — formerly split across two specs. Phase 1 implementation: `server/portfolio/{compounding,state,tickHandler,portfolioAgent}.ts` + the `portfolio.*` tRPC namespace + `/api/portfolio/daily-pnl` REST endpoint.
