# Portfolio Agent Spec v1.0

**Document:** PortfolioAgent_Spec_v1.0.md
**Project:** Automatic Trading System (ATS)
**Status:** Draft

---

## Change History

| Version | Date | Author | Summary |
| --- | --- | --- | --- |
| v1.0 | 2026-04-08 | AI Team | Initial specification for a unified, centralized Portfolio Agent that manages portfolio state, capital, exposure, drawdown, and portfolio-level risk signals. |

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

### 5.2 Portfolio Risk Signals

- `maxExposureBreached`
- `drawdownThresholdHit`
- `tradingCapacityLow`
- `positionConcentrationAlert`
- `portfolioHealthScore`

### 5.3 Historical Metrics

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
- `portfolio.recordTradeClosed(trade)`
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

### Performance Metrics

- `dailyPnl`
- `cumulativePnl`
- `maxDrawdown`
- `winRate`
- `averageRr`
- `tradeCount`

## 10. Versioning

This spec is versioned as `v1.0`. Future updates must be recorded in the Change History table.

## 11. Notes

- The Portfolio Agent is intended to become the authoritative portfolio state engine for the ATS.
- It should reduce duplicate state held in Python modules and server memory stores.
- Inputs from trade execution, market valuation, and capital updates must be kept consistent and fresh.
