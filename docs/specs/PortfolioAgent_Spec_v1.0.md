# Portfolio Agent Spec v1.0

**Document:** PortfolioAgent_Spec_v1.0.md
**Project:** Automatic Trading System (ATS)
**Status:** Implementation

---

## Change History

| Version | Date | Author | Summary |
| --- | --- | --- | --- |
| v1.0 | 2026-04-08 | AI Team | Initial specification for a unified, centralized Portfolio Agent that manages portfolio state, capital, exposure, drawdown, and portfolio-level risk signals. |
| v1.0.1 | 2026-04-09 | Architecture Team | **ENHANCEMENT:** Added trade outcome recording (Section 5.2), daily P&L metrics, exit_triggered_by field for tracking who initiated trade exits. Integration with Discipline Engine capital protection, RCA exit signals, and AI Decision Engine. |

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
- Support multi-workspace capital contexts (paper, paper_manual, live)

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

When a trade closes, the Portfolio Agent records the outcome including P&L, duration, and who triggered the exit. This data is used by Discipline Engine to track daily P&L and by RCA to validate exit decisions.

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
- session and workspace state

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

- `portfolio.getState(workspace)`
- `portfolio.getPositions(workspace)`
- `portfolio.getMetrics(workspace)`
- `portfolio.getHistory(workspace, range)`

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
- `workspace`, `timestamp`

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
- Validate portfolio state consistency across workspaces

## 9. Agent State Model

### Portfolio State

- `workspace`
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

### 10.1 Discipline Engine Integration

The Portfolio Agent provides daily P&L data to Discipline Engine for capital protection monitoring:

- `GET /api/portfolio/daily-pnl` — Returns `dailyRealizedPnl` and `dailyRealizedPnlPercent`
- Called by Discipline Engine every 5 seconds to check if daily profit/loss caps are reached
- Used for carry forward evaluation at 15:15 IST (profit >= 15%?)

### 10.2 RCA Integration

The Portfolio Agent records when RCA exits a position:

- Trade outcome recorded with `exitTriggeredBy: "RCA"`
- RCA provides `exit_reason: "RCA_EXIT"` when exiting due to momentum, volatility, or age
- Portfolio Agent updates `dailyRealizedPnl` and triggers Discipline Engine cap checks

### 10.3 AI Decision Engine Integration

The Portfolio Agent records when AI signals trigger an exit:

- Trade outcome recorded with `exitTriggeredBy: "AI"`
- RCA validates AI signal and executes exit via TradeExecutorAgent
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

This spec is versioned as `v1.0`. Future updates must be recorded in the Change History table.

## 12. Notes

- The Portfolio Agent is intended to become the authoritative portfolio state engine for the ATS.
- It should reduce duplicate state held in Python modules and server memory stores.
- Inputs from trade execution, market valuation, and capital updates must be kept consistent and fresh.
- **v1.0.1 (2026-04-09):** Enhanced for new unified execution architecture. Trade outcome recording now includes `exitTriggeredBy` field to track whether exit came from RCA, Broker, Discipline Engine, or AI Decision Engine. Daily P&L metrics now feed capital protection monitoring in Discipline Engine.
