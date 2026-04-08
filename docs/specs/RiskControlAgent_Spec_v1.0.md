# Risk Control Agent Spec v1.0

**Document:** RiskControlAgent_Spec_v1.0.md
**Project:** Automatic Trading System (ATS)
**Status:** Draft

---

## Change History

| Version | Date | Author | Summary |
| --- | --- | --- | --- |
| v1.0 | 2026-04-08 | AI Team | Initial specification for centralized Risk Control Agent with multi-agent inputs and unified risk decisioning. |

---

## 1. Overview

This document defines the architecture, inputs, responsibilities, and implementation plan for a centralized **Risk Control Agent** in the Automatic Trading System.

The Risk Control Agent unifies risk management across multiple subsystems, receiving inputs from the ML/Strategy Agent, Market Data Agent, and Portfolio State. It becomes the authoritative decision engine for trade validation, position sizing, exit management, capital protection, and risk rule enforcement.

## 2. Purpose

The Risk Control Agent is responsible for:

- Validating every trade before execution
- Deciding position size
- Enforcing risk rules
- Managing stop loss (SL), trailing stop loss (TSL), and exit decisions
- Killing bad trades early
- Protecting capital during adverse market conditions

## 3. Inputs

### 3.1 From ML / Strategy Agent

- `direction`: BUY / SELL
- `confidenceScore`: 0–1
- `entryPrice`: Proposed entry price
- `targetPrice`: Expected target price
- `suggestedStopLoss`: Suggested stop loss price

### 3.2 From Market Data Agent

- `volatility`: ATR, VIX-like proxy
- `liquidity`: Depth and volume metrics
- `spread`: Bid/ask spread
- `slippage`: Expected execution slippage
- `timeOfDay`: Market session timing

### 3.3 From Portfolio State

- `currentCapital`: Available capital
- `openPositions`: Current open positions and exposure
- `dailyPnl`: Realized and unrealized profit/loss
- `drawdownPercent`: Peak-to-trough capital decline
- `winLossStreak`: Current win/loss streak count

## 4. Architecture

### 4.1 Agent Communication

The Risk Control Agent receives data from three source agents and manages centralized state.

- ML/Strategy Agent → Risk Control Agent
- Market Data Agent → Risk Control Agent
- Portfolio State → Risk Control Agent

The Risk Control Agent exposes decision APIs to:

- Execution Engine
- Strategy Agent (for feedback)
- Monitoring and dashboard systems

### 4.2 Core Components

The Risk Control Agent consists of the following modules:

- `risk-engine.ts`: Core risk evaluation and rule engine
- `position-manager.ts`: Position sizing and exposure management
- `exit-manager.ts`: SL/TSL and exit orchestration
- `capital-monitor.ts`: Capital protection, drawdown, and circuit breakers
- `market-conditions.ts`: Volatility, liquidity, spread, and time-of-day adjustments
- `persistence.ts`: Risk state persistence and recovery
- `communication.ts`: Inter-agent interface and API endpoints

### 4.3 State Management

The agent maintains central risk state for:

- Open positions and exposure
- Active risk adjustments and cooldowns
- Daily loss limits and circuit breaker status
- Risk parameter configuration
- Market data freshness

## 5. Risk Evaluation Pipeline

### 5.1 Input Normalization

All incoming data must be validated and normalized before evaluation. Stale or missing data should trigger conservative fallback rules.

### 5.2 Risk Score Calculation

A composite risk score is derived from three components:

- Strategy risk
- Market risk
- Portfolio risk

Example weightings:

- Strategy risk: 40%
- Market risk: 35%
- Portfolio risk: 25%

### 5.3 Outcome

For each trade request, the Risk Control Agent returns:

- `passed`: Whether the trade is approved
- `reason`: If rejected, the blocking rationale
- `recommendedPositionSize`
- `recommendedStopLoss`
- `recommendedAction`: APPROVE / REDUCE_SIZE / REJECT / REVIEW
- `riskScore`

## 6. Responsibilities

### 6.1 Pre-Trade Validation

The Risk Control Agent must validate:

- Trade direction and confidence
- Entry/target/stop loss consistency
- Minimum risk:reward ratio
- Maximum position size limit
- Total exposure limit
- Time window restrictions
- Market condition restrictions
- Emotional or streak-based safeguards

### 6.2 Position Sizing

Position sizing is determined by:

- Current capital
- Trade confidence
- Expected reward distance
- Volatility adjustment
- Liquidity constraints
- Drawdown state
- Streak-based adjustments

### 6.3 Risk Rule Enforcement

The agent enforces:

- Daily loss limits
- Max trades per day
- Max open positions
- Consecutive loss cooldowns
- Drawdown-based risk reduction
- Market session blocks

### 6.4 Exit Management

The agent centrally manages exits including:

- Hard stop loss execution
- Trailing stop loss updates
- Profit partial exits
- Momentum or volatility-based exits
- Trade age exits
- Emergency exits

### 6.5 Bad Trade Termination

The agent can decide early exit when:

- P&L hits hard limits
- Momentum weakens early
- Market conditions deteriorate
- Drawdown thresholds are breached

### 6.6 Capital Protection

The agent protects capital by:

- Triggering circuit breakers
- Reducing position sizes during drawdown
- Blocking new trades after large losses
- Enforcing cooldowns after bad streaks
- Applying conservative rules in poor market conditions

## 7. Implementation Plan

### Phase 1: Foundation

- Create `server/risk-agent/` directory
- Define core interfaces and types
- Develop risk state store and persistence
- Implement inter-agent communication APIs
- Add input validation and normalization

### Phase 2: Trade Validation & Position Sizing

- Migrate pre-trade validation rules
- Implement unified position sizing engine
- Add market-aware sizing adjustments
- Populate risk evaluation API

### Phase 3: Exit Management & Monitoring

- Centralize exit decision logic
- Add SL/TSL and adaptive exit management
- Implement live position risk monitoring
- Add alert and notification support

### Phase 4: Portfolio & Capital Protection

- Build portfolio-level risk checks
- Implement drawdown protection
- Add streak-based and market condition adjustments
- Integrate circuit breaker and kill switches

### Phase 5: Integration & Migration

- Replace fragmented risk logic with agent calls
- Update Python execution module and strategy systems
- Maintain fallback compatibility
- Optimize performance and latency

### Phase 6: Testing & Validation

- Add unit tests for all risk components
- Add integration tests with strategy and execution flows
- Simulate adverse market and drawdown scenarios
- Validate agent behavior under stale or missing input

## 8. Interaction Contracts

### 8.1 Risk Evaluation Request

```typescript
interface RiskEvaluationRequest {
  strategy: {
    direction: 'BUY' | 'SELL';
    confidenceScore: number;
    entryPrice: number;
    targetPrice: number;
    suggestedStopLoss: number;
  };
  marketData: {
    volatility: {
      atr: number;
      vixProxy: number;
    };
    liquidity: {
      depth: number;
      volume: number;
    };
    spread: number;
    slippage: number;
    timeOfDay: string;
  };
  portfolio: {
    currentCapital: number;
    openPositions: any[];
    dailyPnl: number;
    drawdownPercent: number;
    winLossStreak: number;
  };
  instrument: string;
  timestamp: string;
}
```

### 8.2 Risk Evaluation Result

```typescript
interface RiskEvaluationResult {
  passed: boolean;
  reason?: string;
  recommendedPositionSize?: number;
  recommendedStopLoss?: number;
  recommendedAction: 'APPROVE' | 'REDUCE_SIZE' | 'REJECT' | 'REVIEW';
  riskScore: number;
  details?: Record<string, unknown>;
}
```

## 9. Versioning

This document is versioned as `v1.0`. Future updates must be recorded in the Change History table.

## 10. Notes

- The Risk Control Agent is designed to be the single source of truth for all risk decisions.
- All existing fragmented risk logic should migrate into this agent over time.
- The agent must be conservative by default when input freshness or quality is uncertain.
