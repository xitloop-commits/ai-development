# Trade Executor Agent Spec v1.1

**Document:** TradeExecutorAgent_Spec_v1.1.md
**Project:** Automatic Trading System (ATS)
**Status:** Draft

---

## Change History

| Version | Date       | Author   | Summary |
| ------- | ---------- | -------- | ------- |
| v1.0    | 2026-04-08 | AI Team  | Initial specification for unified, event-driven Trade Executor Agent. |
| v1.1    | 2026-04-08 | AI Team  | Clarified broker service usage, exclusive trade execution, and settings centralization. |

---

## 1. Overview

The Trade Executor Agent is the single, centralized component responsible for executing all approved trades—across both paper and live environments—managing the full order lifecycle, and updating the Portfolio Agent as the only writer. It ensures accurate, reliable, and safe execution, with strict idempotency, event-driven state management, and robust error handling. The agent supports trades originating from both the user and the AI model, and records the origin of each trade for analytics and compliance.

## 2. Purpose

- Execute only fully approved trades (post-risk/discipline)
- Manage order lifecycle (CREATED → PLACED → PARTIAL → FILLED → CLOSED)
- Attach and manage SL/TP/trailing orders
- Update Portfolio Agent on all state changes (entry, exit, fill, rejection)
- Track slippage and execution analytics
- Provide robust error handling and recovery
- Emit execution feedback for ML/risk tuning
- **Support both paper and live trade execution, with clear separation and configuration.**
- **Record the origin of each trade (user or AI model) in trade records.**
- **Record the outcome of each trade (win/loss, P&L rate) for analytics and ML training.**

## 3. Design Rules

1. Executor is dumb but strict (no decision logic)
2. Idempotent always (never double execute)
3. Portfolio is only updated by Executor
4. Must survive failures (persistent, recoverable)
5. Event-driven preferred (order events trigger actions)
6. **Only the Trade Executor Agent may call brokerService.placeOrder, modifyOrder, or cancelOrder for live trades.**
7. **Other modules/agents may use broker service for read-only or informational APIs, but not for executing trades.**

## 4. Inputs

- Approved trade objects (with unique execution ID, trade origin [user/model], and environment [paper/live])
- Portfolio state (read-only)
- Broker order events (WebSocket, REST fallback)
- Market data (for SL/TP/trailing management)

## 5. Outputs

- Portfolio state mutations (via Portfolio Agent API)
- Order lifecycle events (for audit/logging)
- Execution analytics (slippage, latency, outcomes, trade origin, environment)
- Feedback signals for ML/risk modules
- **Trade outcome records (win/loss, P&L rate) for each executed trade, available for downstream analytics and model training.**

## 6. Responsibilities

1. 🧾 Pre-Execution Sanity Checks
   - Required fields, quantity > 0, price precision, trade origin, environment
2. 🔄 Idempotency Protection
   - Deduplicate by execution/trade ID
3. 🔧 Normalize for Broker
   - Symbol mapping, lot size, tick rounding
4. 📡 Place Entry Order
   - Handle success, rejection, timeout
5. 🔁 Order Lifecycle Management
   - Track all states, persist transitions
6. 📊 Handle Execution Outcomes
   - Fully filled, partial, rejected, retry logic
7. 🛡️ Attach Risk Orders
   - SL/TP/trailing after entry fill
8. 🔁 Manage Open Position
   - Monitor, react to SL/TP/exit/trailing
9. 📉 Slippage Tracking
   - Store executed vs expected price
10. 📊 Update Portfolio Agent
    - Only executor writes portfolio state
11. 🧾 Logging
    - Store all events, errors, analytics (distinct [TradeExecutor] prefix)
12. 🔄 Error Handling & Recovery
    - Retry, fallback, emergency exit
13. 🧠 Execution Feedback Loop
    - Emit for ML/risk tuning
14. **Centralize all trade execution settings (timeouts, retries, slippage, etc.) under "Trade Executor Agent Setting" in the settings page.**
15. **Ensure every trade record includes: environment (paper/live), origin (user/model), and outcome (win/loss, P&L rate).**

## 7. Architecture

- Centralized executor service (Node.js/TypeScript)
- Receives trades via API (tRPC/REST)
- Subscribes to broker WebSocket order updates
- Persists order state and events to DB
- Calls Portfolio Agent API for all state changes
- Provides logging and analytics endpoints
- **All trade placement, modification, and cancellation must go through the executor.**

## 8. Interfaces and Contracts

### 8.1 Executor APIs

- `executor.submitTrade(trade)`
   - Trade object must include: unique ID, environment (paper/live), origin (user/model), and all required execution parameters.
- `executor.getOrderStatus(orderId)`
- `executor.getExecutionLog(tradeId)`

### 8.2 Event Contracts

- `order.placed`
- `order.filled`
- `order.partial`
- `order.closed`
- `order.rejected`
- `order.slippage`
- `order.error`

Payloads include: `tradeId`, `orderId`, `status`, `qty`, `price`, `slippage`, `timestamp`, etc.

## 9. Testing & Validation

### 9.1 Unit Tests
- All modules: normalization, idempotency, error handling, SL/TP logic
- Edge cases: duplicate, partial, rejection, network

### 9.2 Integration Tests
- Full trade lifecycle: submit → broker → events → portfolio update
- Event-driven flows: entry, partial, fill, SL/TP, exit, rejection, recovery
- Portfolio state only updated by executor

### 9.3 WebSocket/Event Tests
- Mock broker order events, test real-time handling
- Reconnection, missed/out-of-order events

### 9.4 Idempotency & Recovery
- Duplicate submissions, process restarts, state recovery

### 9.5 Error Handling
- Inject failures, verify retry, fallback, emergency exit

### 9.6 Portfolio Consistency
- Assert portfolio state after every test
- Stress/concurrency tests

### 9.7 Regression Suite
- Full regression suite for all flows, CI/CD integration

## 10. Versioning

This spec is versioned as `v1.1`. Future updates must be recorded in the Change History table.

## 11. Notes

- Executor is the only writer to portfolio state
- All modules must submit trades to executor, not broker directly
- Event-driven, robust, and testable by design
- **Broker service may be used by other agents for non-trade actions (order book, margin, etc.), but not for trade execution.**
- **All trade execution settings are managed centrally.**
- **All trade records must include environment (paper/live), origin (user/model), and outcome (win/loss, P&L rate) for compliance, analytics, and ML training.**
