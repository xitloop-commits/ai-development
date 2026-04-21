# Trade Executor Agent Implementation Plan (v1.2)

## 1. Core Service & API Layer
- Create a dedicated executor service/module (Node.js/TypeScript).
- Expose tRPC/REST endpoints:
  - `submitTrade(trade)` (accepts only fully approved trades with executionId)
  - `getOrderStatus(orderId)`
  - `getExecutionLog(tradeId)`

## 2. Sanity Check & Idempotency
- Implement pre-execution sanity checks (required fields, quantity, price precision).
- Add idempotency layer: store/check executionId to prevent duplicate execution.

## 3. Broker Normalization
- Centralize all broker-specific mapping (symbol, lot size, tick rounding) in a normalization utility.
- Ensure all trade requests to broker are normalized here.

## 4. Order Manager & Lifecycle Tracking
- Place all entry, SL, TP, and trailing orders via broker adapter.
- Track and persist order state transitions (CREATED → PLACED → PARTIAL → FILLED → CLOSED).
- Store all order events and transitions in the database.

## 5. Event Handler (WebSocket/Order Events)
- Subscribe to broker WebSocket for real-time order updates.
- Drive all state transitions, SL/TP/trailing placement, and position management from these events.
- Handle out-of-order, duplicate, or missed events robustly.

## 6. Risk Order Manager (SL/TP/TSL Handling)
- **Paper Trading:**
  - System manages all SL/TP/TSL logic and triggers exits in software.
- **Live Trading:**
  - Set SL/TP/TSL at order placement if broker supports.
  - Broker manages auto-exit/TSL/TP as per initial order.
  - Executor can dynamically adjust SL/TP/TSL by sending modifyOrder to broker (e.g., for trailing, tightening SL, or strategy-driven changes).
  - Only send modifyOrder when a real change is needed (deduplicate, rate-limit).
  - Track and log all modifications and outcomes for audit.

## 7. Portfolio Updater
- Call Portfolio Agent API to record all trade state changes (placed, filled, closed, rejected).
- Ensure only the executor mutates portfolio state.

## 8. Logger & Analytics
- Use a dedicated logger under `server/executor/` with `[TradeExecutor]` prefix (to be created as part of the agent implementation).
- Log every execution step, event, error, and state change (structured, with executionId, tradeId, orderId, etc.).
- Track slippage, latency, and outcomes for analytics and ML feedback.

## 9. Recovery Engine
- Implement retry queues and recovery logic for timeouts, network failures, and stuck partials.
- Ensure all retries are idempotent and state is recoverable after process restarts.

## 10. Centralized Settings
- Move all trade execution settings (timeouts, retries, slippage, broker selection, etc.) to a single “Trade Executor Agent Setting” section.
- Update the settings page UI to manage these settings centrally.

## 11. Testing & Validation
- Unit tests for each module (sanity, idempotency, normalization, order manager, event handler, etc.).
- Integration tests for full trade lifecycle, event-driven flows, error handling, and portfolio updates.
- Regression suite for all flows, with CI/CD integration.
- Mock broker events to test real-time handling, reconnection, and recovery.
- Test both paper and live SL/TP/TSL management logic.

## 12. Migration & Enforcement
- Refactor/remove all direct trade execution logic from Python, capital engine, and server modules.
- Ensure only the executor calls brokerService.placeOrder/modifyOrder/cancelOrder for live trades.
- Allow other modules to use broker service for read-only/informational APIs only.

---

**SL/TP/TSL Management:**
- Paper: system manages all exits.
- Live: broker manages exits, but executor can intelligently adjust SL/TP/TSL via modifyOrder as needed, based on real-time strategy or market conditions.  
- Executor must be smart, efficient, and auditable in all SL/TP/TSL management.
