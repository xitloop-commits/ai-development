# Trade Executor Agent Spec v1.0

**Document:** TradeExecutorAgent_Spec_v1.0.md
**Project:** Automatic Trading System (ATS)
**Status:** Draft

---

## Change History

| Version | Date       | Author   | Summary |
| ------- | ---------- | -------- | ------- |
| v1.0    | 2026-04-08 | AI Team  | Initial specification for unified, event-driven Trade Executor Agent. |

---

## 1. Overview

The Trade Executor Agent is the single, centralized component responsible for executing all approved trades, managing the full order lifecycle, and updating the Portfolio Agent as the only writer. It ensures accurate, reliable, and safe execution, with strict idempotency, event-driven state management, and robust error handling.

## 2. Purpose

- Execute only fully approved trades (post-risk/discipline)
- Manage order lifecycle (CREATED → PLACED → PARTIAL → FILLED → CLOSED)
- Attach and manage SL/TP/trailing orders
- Update Portfolio Agent on all state changes (entry, exit, fill, rejection)
- Track slippage and execution analytics
- Provide robust error handling and recovery
- Emit execution feedback for ML/risk tuning

## 3. Design Rules

1. Executor is dumb but strict (no decision logic)
2. Idempotent always (never double execute)
3. Portfolio is only updated by Executor
4. Must survive failures (persistent, recoverable)
5. Event-driven preferred (order events trigger actions)

## 4. Inputs

- Approved trade objects (with unique execution ID)
- Portfolio state (read-only)
- Broker order events (WebSocket, REST fallback)
- Market data (for SL/TP/trailing management)

## 5. Outputs

- Portfolio state mutations (via Portfolio Agent API)
- Order lifecycle events (for audit/logging)
- Execution analytics (slippage, latency, outcomes)
- Feedback signals for ML/risk modules

## 6. Responsibilities

1. 🧾 Pre-Execution Sanity Checks
   - Required fields, quantity > 0, price precision
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
    - Store all events, errors, analytics
12. 🔄 Error Handling & Recovery
    - Retry, fallback, emergency exit
13. 🧠 Execution Feedback Loop
    - Emit for ML/risk tuning

## 7. Architecture

- Centralized executor service (Node.js/TypeScript)
- Receives trades via API (tRPC/REST)
- Subscribes to broker WebSocket order updates
- Persists order state and events to DB
- Calls Portfolio Agent API for all state changes
- Provides logging and analytics endpoints

## 8. Interfaces and Contracts

### 8.1 Executor APIs

- `executor.submitTrade(trade)`
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

This spec is versioned as `v1.0`. Future updates must be recorded in the Change History table.

## 11. Notes

- Executor is the only writer to portfolio state
- All modules must submit trades to executor, not broker directly
- Event-driven, robust, and testable by design
