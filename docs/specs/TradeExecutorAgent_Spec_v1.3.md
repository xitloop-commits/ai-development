# Trade Executor Agent Specification v1.3

**Document:** TradeExecutorAgent_Spec_v1.3.md
**Project:** Automatic Trading System (ATS)
**Status:** Specification (Ready for Implementation)
**Version:** 1.3
**Date:** 2026-04-09

---

## Change History

| Version | Date | Author | Summary |
|---------|------|--------|---------|
| v1.0 | 2026-04-08 | AI Team | Initial specification for unified, event-driven execution |
| v1.1 | 2026-04-08 | AI Team | Clarified broker service usage, exclusive trade execution, settings centralization |
| v1.2 | 2026-04-09 | AI Team | Added modifyOrder & exitTrade APIs, broker event handling, paper vs live differences, RCA integration, execution flow diagrams |
| v1.3 | 2026-04-09 | AI Team | **UPDATED:** Added DISCIPLINE_EXIT handling specification to Section 4.3 — highest-priority market-order exit, portfolio recording with exitTriggeredBy: "DISCIPLINE", retry-once on broker failure, partial exit support for user-driven Reduce Exposure and Exit by Instrument actions |

---

## 1. Overview

The Trade Executor Agent (TEA) is the **single, centralized execution gateway** for all trades in the system. It is the **ONLY module allowed to call broker services** (placeOrder, modifyOrder, cancelOrder).

TEA ensures:
- ✅ All trades go through unified execution path
- ✅ Orders are placed idempotently (no duplicates)
- ✅ SL/TP/TSL are attached as specified by RCA
- ✅ Paper & live trades are handled correctly
- ✅ Portfolio Agent is updated on all state changes
- ✅ Complete audit trail of all executions

**Core Principle:**
```
Risk Control Agent decides WHAT to do
Trade Executor Agent executes HOW to do it
Broker Service handles WHERE to execute (broker-specific)
```

---

## 2. Purpose

- Execute only **fully approved trades** from RCA
- Manage **complete order lifecycle** (entry → execution → monitoring → exit)
- Attach & manage **SL/TP/TSL** for entry orders
- Modify **SL/TP/TSL** on RCA request (live trades)
- Execute **exit orders** on RCA request
- Update **Portfolio Agent** on every state change
- Emit **execution feedback** for RCA & risk monitoring
- **Support both paper & live** trades with clear separation
- **Record trade origin** (RCA vs user) for analytics

---

## 3. Design Rules (CRITICAL)

1. ✅ **Single Execution Point**: TEA is ONLY module calling brokerService
2. ✅ **Idempotent Always**: Never double-execute (use execution IDs)
3. ✅ **Portfolio is Only Updated By TEA**: TEA is sole writer to Portfolio Agent
4. ✅ **Must Survive Failures**: Persistent, recoverable state
5. ✅ **Event-Driven Preferred**: Broker events trigger state transitions
6. ✅ **No Decision Logic**: TEA executes commands, doesn't make decisions
7. ✅ **Paper vs Live Aware**: Different execution paths per environment
8. ✅ **Audit Trail Complete**: Every action logged with timestamp & details

---

## 4. Inputs

### 4.1 Trade Submission from RCA

```json
POST /api/executor/submitTrade

{
  "executionId": "EXEC-20260409-120530-1",
  "tradeId": "TRD-20260409-120530-1",
  "environment": "paper" | "live",
  "origin": "RCA",
  
  "instrument": "NIFTY_50",
  "direction": "BUY" | "SELL",
  "quantity": 50,
  "entryPrice": 185.50,
  
  "stopLoss": 176.22,
  "takeProfit": 220.00,
  "trailingStopLoss": {
    "enabled": false,
    "distance": 5.0,
    "trigger": 50.0
  },
  
  "orderType": "MARKET" | "LIMIT",
  "productType": "INTRADAY" | "BO",
  
  "timestamp": "2026-04-09T10:15:35Z"
}
```

### 4.2 Modification Request from RCA

```json
POST /api/executor/modifyOrder

{
  "executionId": "EXEC-20260409-120535-2",
  "positionId": "POS-20260409-120530-1",
  
  "modifications": {
    "stopLoss": 180.00,
    "takeProfit": 225.00,
    "trailingStopLoss": {
      "enabled": true,
      "distance": 5.0,
      "trigger": 50.0
    }
  },
  
  "reason": "MOMENTUM_ADJUSTMENT" | "VOLATILITY_ADJUSTMENT" | 
           "AI_SIGNAL" | "DISCIPLINE_REQUEST",
  "detail": "Momentum increased to 75, extending TP and enabling TSL",
  
  "timestamp": "2026-04-09T10:15:35Z"
}
```

### 4.3 Exit Request from RCA

```json
POST /api/executor/exitTrade

{
  "executionId": "EXEC-20260409-120540-3",
  "positionId": "POS-20260409-120530-1",
  
  "exitType": "MARKET" | "LIMIT",
  "exitPrice": 195.00,
  
  "reason": "MOMENTUM_EXIT" | "SL_HIT" | "TP_HIT" | "AGE_EXIT" | 
           "DISCIPLINE_EXIT" | "AI_EXIT",
  "detail": "Momentum dropped below 30, triggering full exit",
  
  "currentPrice": 190.50,
  "currentPnl": 250.00,
  
  "timestamp": "2026-04-09T10:15:35Z"
}
```

**`DISCIPLINE_EXIT` handling (special case):**

When RCA forwards a Discipline Agent signal with `reason: "DISCIPLINE_EXIT"`, TEA applies the following rules:

| Rule | Behavior |
|---|---|
| **Priority** | Highest — no delay, no queuing behind other orders |
| **Order type** | Always MARKET order, regardless of exitType in request |
| **Scope** | If RCA sends `exit_all: true`, TEA exits every open position in sequence |
| **No validation** | TEA does not question or defer a DISCIPLINE_EXIT — it is non-negotiable |
| **Portfolio recording** | TEA calls `portfolio.recordTradeClosed()` with `exitTriggeredBy: "DISCIPLINE"` and `exitReason: "DISCIPLINE_EXIT"` for each position |
| **On broker failure** | TEA retries once immediately. If retry fails, TEA escalates back to RCA with failure status. TEA does NOT silently drop the exit. |
| **Partial exit** | If RCA sends `request_type: "PARTIAL_EXIT"` (from user's Reduce Exposure or Exit by Instrument action), TEA exits only the specified positions or quantities |

---

### 4.4 Broker WebSocket Events

```
Subscribed to broker order updates:

{
  "orderId": "ORD-12345",
  "tradeId": "TRD-20260409-120530-1",
  "status": "TRADED" | "PARTIAL" | "PENDING" | "REJECTED" | "CANCELLED",
  "quantity": 50,
  "filledQuantity": 50,
  "fillPrice": 185.60,
  "timestamp": "2026-04-09T10:15:36Z"
}

SL/TP Auto-Exit Events (Live):

{
  "positionId": "POS-20260409-120530-1",
  "exitReason": "SL" | "TP",
  "exitPrice": 176.20,
  "exitTime": "2026-04-09T10:25:36Z"
}
```

---

## 5. Outputs

### 5.1 Trade Submission Response

```json
Response (200 OK):
{
  "success": true,
  "tradeId": "TRD-20260409-120530-1",
  "positionId": "POS-20260409-120530-1",
  "orderId": "ORD-12345",
  "executedPrice": 185.60,
  "executedQuantity": 50,
  "status": "PLACED" | "FILLED" | "PARTIAL",
  "timestamp": "2026-04-09T10:15:36Z"
}

Response (400 Bad Request):
{
  "success": false,
  "error": "Duplicate execution ID detected",
  "tradeId": null,
  "orderId": null
}

Response (503 Service Unavailable):
{
  "success": false,
  "error": "Broker service unavailable",
  "retry": true
}
```

### 5.2 Modification Response

```json
Response (200 OK):
{
  "success": true,
  "positionId": "POS-20260409-120530-1",
  "modificationId": "MOD-20260409-120535-2",
  "oldSL": 176.22,
  "newSL": 180.00,
  "oldTP": 220.00,
  "newTP": 225.00,
  "appliedAt": "2026-04-09T10:15:35Z"
}

Response (400 Bad Request):
{
  "success": false,
  "error": "New SL (190) must be < Entry (185.50)",
  "modificationId": null
}
```

### 5.3 Exit Response

```json
Response (200 OK):
{
  "success": true,
  "positionId": "POS-20260409-120530-1",
  "exitId": "EXIT-20260409-120540-3",
  "exitPrice": 190.50,
  "executedQuantity": 50,
  "realizedPnl": 250.00,
  "realizedPnlPct": 1.35,
  "exitTime": "2026-04-09T10:15:40Z"
}

Response (404 Not Found):
{
  "success": false,
  "error": "Position not found",
  "positionId": "POS-INVALID"
}
```

### 5.4 Events Emitted to Portfolio Agent

```
Every state change:

POST /api/portfolio/recordTradePlaced
{
  "position_id": "POS-20260409-120530-1",
  "instrument": "NIFTY_50",
  "direction": "BUY",
  "entry_price": 185.50,
  "quantity": 50,
  "stop_loss": 176.22,
  "take_profit": 220.00,
  "environment": "paper" | "live",
  "origin": "RCA",
  "status": "PLACED"
}

POST /api/portfolio/recordTradeUpdated
{
  "position_id": "POS-20260409-120530-1",
  "current_price": 190.00,
  "unrealized_pnl": 225.00,
  "status": "OPEN"
}

POST /api/portfolio/recordTradeClosed
{
  "position_id": "POS-20260409-120530-1",
  "exit_price": 190.50,
  "exit_reason": "MOMENTUM_EXIT",
  "realized_pnl": 250.00,
  "realized_pnl_pct": 1.35,
  "duration_seconds": 600,
  "exit_triggered_by": "RCA"
}
```

---

## 6. Responsibilities

### 6.1 Pre-Execution Sanity Checks

For every incoming request:

```
1. Validate Required Fields
   ├─ executionId: non-empty, UUID format
   ├─ tradeId: non-empty
   ├─ environment: "paper" or "live"
   ├─ quantity: > 0
   ├─ prices: entry, SL, TP > 0
   └─ Reject if any missing

2. Validate Price Consistency
   ├─ For BUY: SL < Entry < TP
   ├─ For SELL: TP < Entry < SL
   └─ Reject if violated

3. Validate Idempotency
   ├─ Check if executionId already seen
   ├─ If yes: return previous result (idempotent)
   └─ If no: proceed with execution
```

### 6.2 Idempotency Protection

```
Store execution history:
  {
    executionId: "EXEC-20260409-120530-1",
    command: "submitTrade",
    result: {
      success: true,
      tradeId: "TRD-...",
      positionId: "POS-...",
      timestamp: "..."
    },
    createdAt: "2026-04-09T10:15:35Z"
  }

On duplicate executionId:
  └─ Return stored result (not retry, return same response)
  └─ Log: "Idempotent return for EXEC-..."
```

### 6.3 Normalize for Broker

Before calling brokerService:

```python
def normalize_for_broker(trade_request, environment):
    """
    Convert RCA's trade format to broker's format
    """
    normalized = {
        "instrument": {
            "securityId": lookup_security_id(
                trade_request.instrument,
                trade_request.expiry,
                trade_request.strike,
                trade_request.option_type
            ),
            "exchange": EXCHANGE_MAP[trade_request.instrument],
            "tradingSymbol": build_trading_symbol(...)
        },
        "transactionType": trade_request.direction,
        "productType": trade_request.productType,
        "orderType": trade_request.orderType,
        "quantity": round_to_lot_size(
            trade_request.quantity,
            trade_request.instrument
        ),
        "price": trade_request.entryPrice,
        "validity": "DAY",
        "correlationId": generate_correlation_id(trade_request)
    }
    
    # Validate & return
    return validate_broker_format(normalized)
```

### 6.4 Place Entry Order

When submitTrade request arrives:

```
1. Sanity Check
   └─ Validate fields, prices, idempotency (see 6.1-6.2)

2. Normalize
   └─ Convert to broker format (6.3)

3. Place Order
   ├─ For PAPER:
   │  └─ Call brokerService.placeOrder(paper_adapter)
   │
   ├─ For LIVE:
   │  ├─ Call brokerService.placeOrder(live_broker)
   │  ├─ Attach SL order (if broker supports)
   │  └─ Attach TP order (if broker supports)
   │
   └─ Handle response:
      ├─ If FILLED/TRADED: position open
      ├─ If PARTIAL: track fill, wait for more
      ├─ If REJECTED: abort, notify RCA
      └─ If TIMEOUT: retry logic (see 6.9)

4. Update Portfolio Agent
   └─ POST /api/portfolio/recordTradePlaced

5. Return Success
   └─ Return tradeId, positionId, executedPrice
```

### 6.5 Modify Order (Live Trades Only)

When modifyOrder request arrives:

```
1. Sanity Check
   ├─ executionId (new, for idempotency)
   ├─ positionId exists
   ├─ environment = "live" (paper: modify local values)
   ├─ New SL, TP valid (SL < Entry < TP for BUY)
   └─ Reject if any invalid

2. Idempotency Check
   └─ If same executionId seen: return previous result

3. For LIVE Trades:
   ├─ Call brokerService.modifyOrder(orderId, new_SL, new_TP, new_TSL)
   └─ Handle response:
      ├─ If success: update local position, notify Portfolio Agent
      ├─ If rejected: log reason, notify RCA
      └─ If timeout: retry with exponential backoff

4. For PAPER Trades:
   ├─ Update local SL/TP values
   └─ Continue monitoring

5. Update Portfolio Agent
   └─ POST /api/portfolio/recordTradeUpdated

6. Return Success
   └─ Return modificationId, oldSL, oldTP, newSL, newTP
```

### 6.6 Execute Exit Order

When exitTrade request arrives:

```
1. Sanity Check
   ├─ executionId (new, for idempotency)
   ├─ positionId exists
   ├─ exitType valid (MARKET or LIMIT)
   ├─ exitPrice > 0 (for LIMIT)
   └─ Reject if invalid

2. Idempotency Check
   └─ If same executionId seen: return previous result

3. For PAPER Trades:
   ├─ Call brokerService.placeOrder(SELL, quantity, exit_price)
   ├─ Simulate fill at exit_price (paper adapter)
   └─ Continue to step 5

4. For LIVE Trades:
   ├─ Cancel pending SL order (if any)
   ├─ Cancel pending TP order (if any)
   ├─ Call brokerService.placeOrder(SELL, quantity, exit_price)
   └─ Wait for fill confirmation

5. Update Portfolio Agent
   └─ POST /api/portfolio/recordTradeClosed
      {
        exit_price, exit_reason, realized_pnl,
        realized_pnl_pct, duration, exit_triggered_by
      }

6. Record Audit Trail
   └─ Log: exit_time, exit_price, pnl, reason

7. Return Success
   └─ Return exitId, exitPrice, realizedPnl, exitTime
```

### 6.7 Handle Order Lifecycle Events

Subscribe to broker WebSocket order updates:

```
On order update event:

if status == "TRADED" or "PARTIAL":
  ├─ Update position (quantity, entry price if partial)
  ├─ Update Portfolio Agent
  ├─ If fully filled: notify RCA (position open, ready to monitor)
  └─ If partial: wait for more fills (track fill price, quantity)

if status == "REJECTED":
  ├─ Notify RCA: "Order rejected by broker"
  ├─ Mark position as FAILED
  ├─ Update Portfolio Agent
  └─ Log rejection reason

if status == "CANCELLED":
  ├─ Mark position as CANCELLED
  ├─ Update Portfolio Agent
  └─ Log cancellation reason

if status == "PENDING":
  └─ Track, wait for update
```

### 6.8 Handle SL/TP Auto-Exit Events (Live)

When broker notifies of SL/TP auto-exit:

```
On SL/TP auto-exit event:

1. Receive event from broker
   ├─ positionId, exitReason (SL|TP), exitPrice

2. Update position
   ├─ Mark as CLOSED
   ├─ Record exitPrice, exitTime

3. Update Portfolio Agent
   └─ POST /api/portfolio/recordTradeClosed
      {
        exit_price: exitPrice,
        exit_reason: exitReason,
        realized_pnl: (exitPrice - entry) * qty,
        exit_triggered_by: "BROKER"
      }

4. Notify RCA
   └─ "Position closed by broker: {exitReason}"

5. Log & Audit
   └─ Complete audit trail with broker's exit
```

### 6.9 Error Handling & Recovery

```
Order Placement Failures:

1. Timeout (no response from broker within 15s)
   ├─ Retry once (wait 5s, retry)
   ├─ If still fails: notify RCA, mark PENDING
   └─ Background task: keep polling until confirmed/rejected

2. Network Error (connection lost)
   ├─ Exponential backoff: 1s, 2s, 4s, 8s, 16s (max)
   ├─ Keep retrying for 60 seconds
   └─ If not resolved: notify RCA, await manual intervention

3. Broker Rejection (invalid symbol, qty, etc)
   ├─ Log full rejection details
   ├─ Notify RCA immediately
   ├─ Mark position as REJECTED
   └─ Do NOT retry (fix required)

4. Partial Fill
   ├─ Track fill_price, filled_quantity
   ├─ If filled >= requested: treat as complete
   ├─ If not: keep open, monitor for more fills
   └─ Timeout: if no more fills in 5min, partial close allowed

5. Recovery on Process Restart
   ├─ Query broker for pending orders
   ├─ Reconcile with local state
   ├─ Update Portfolio Agent with current state
   └─ Resume monitoring/execution
```

### 6.10 Logging & Analytics

Every action logged with:

```
{
  timestamp: "2026-04-09T10:15:35Z",
  executionId: "EXEC-20260409-120530-1",
  tradeId: "TRD-20260409-120530-1",
  positionId: "POS-20260409-120530-1",
  action: "ENTRY" | "MODIFY" | "EXIT",
  status: "SUCCESS" | "FAILED" | "PARTIAL",
  
  details: {
    environment: "paper" | "live",
    instrument: "NIFTY_50",
    quantity: 50,
    entryPrice: 185.50,
    executedPrice: 185.60,
    slippage: 0.10,
    latency: 145,  // milliseconds
    broker_orderId: "ORD-12345"
  }
}

Analytics tracked:
  ├─ Execution latency (order placement to fill)
  ├─ Slippage per trade
  ├─ Fill rate (% of orders filled)
  ├─ Modification success rate
  ├─ Exit accuracy (hit SL/TP vs other reasons)
  └─ Downtime/retries per day
```

### 6.11 Paper vs Live Differences

```
PAPER TRADING:
├─ Entry: Mock adapter instantly fills at entry_price
├─ SL/TP: TEA monitors locally, triggers exit
├─ Modify: TEA updates local SL/TP values
├─ Exit: Mock adapter fills at exit_price
└─ Slippage: None (assumed 0)

LIVE TRADING:
├─ Entry: Broker places real order, applies SL/TP
├─ SL/TP: Broker manages auto-exit, TEA receives event
├─ Modify: TEA calls brokerService.modifyOrder()
├─ Exit: TEA places real SELL order, broker executes
└─ Slippage: Tracked (executed vs requested price)

Key Difference:
  Paper: TEA manages complete lifecycle
  Live: Broker manages SL/TP exit, TEA requests modifications & exits
```

---

## 7. API Contracts (External)

### 7.1 Trade Submission

```
POST /api/executor/submitTrade

Request:
{
  "executionId": "EXEC-20260409-120530-1",
  "tradeId": "TRD-20260409-120530-1",
  "environment": "paper" | "live",
  "origin": "RCA",
  "instrument": "NIFTY_50",
  "direction": "BUY",
  "quantity": 50,
  "entryPrice": 185.50,
  "stopLoss": 176.22,
  "takeProfit": 220.00,
  "trailingStopLoss": {
    "enabled": false,
    "distance": 5.0,
    "trigger": 50.0
  },
  "orderType": "MARKET",
  "productType": "INTRADAY",
  "timestamp": "2026-04-09T10:15:35Z"
}

Success (200):
{
  "success": true,
  "tradeId": "TRD-20260409-120530-1",
  "positionId": "POS-20260409-120530-1",
  "orderId": "ORD-12345",
  "executedPrice": 185.60,
  "executedQuantity": 50,
  "status": "FILLED",
  "timestamp": "2026-04-09T10:15:36Z"
}

Conflict (409):
{
  "success": false,
  "error": "Duplicate executionId - idempotent return",
  "previousResult": {...}
}
```

### 7.2 Modify Order

```
POST /api/executor/modifyOrder

Request:
{
  "executionId": "EXEC-20260409-120535-2",
  "positionId": "POS-20260409-120530-1",
  "modifications": {
    "stopLoss": 180.00,
    "takeProfit": 225.00,
    "trailingStopLoss": {
      "enabled": true,
      "distance": 5.0,
      "trigger": 50.0
    }
  },
  "reason": "MOMENTUM_ADJUSTMENT",
  "detail": "Momentum increased to 75",
  "timestamp": "2026-04-09T10:15:35Z"
}

Success (200):
{
  "success": true,
  "positionId": "POS-20260409-120530-1",
  "modificationId": "MOD-20260409-120535-2",
  "oldSL": 176.22,
  "newSL": 180.00,
  "oldTP": 220.00,
  "newTP": 225.00,
  "appliedAt": "2026-04-09T10:15:35Z"
}

BadRequest (400):
{
  "success": false,
  "error": "Invalid: new SL (190) must be < entry (185.50)",
  "positionId": "POS-20260409-120530-1"
}
```

### 7.3 Exit Trade

```
POST /api/executor/exitTrade

Request:
{
  "executionId": "EXEC-20260409-120540-3",
  "positionId": "POS-20260409-120530-1",
  "exitType": "MARKET",
  "exitPrice": 190.50,
  "reason": "MOMENTUM_EXIT",
  "detail": "Momentum dropped below 30",
  "currentPrice": 190.50,
  "currentPnl": 250.00,
  "timestamp": "2026-04-09T10:15:35Z"
}

Success (200):
{
  "success": true,
  "positionId": "POS-20260409-120530-1",
  "exitId": "EXIT-20260409-120540-3",
  "exitPrice": 190.50,
  "executedQuantity": 50,
  "realizedPnl": 250.00,
  "realizedPnlPct": 1.35,
  "exitTime": "2026-04-09T10:15:40Z"
}

NotFound (404):
{
  "success": false,
  "error": "Position not found",
  "positionId": "POS-INVALID"
}
```

### 7.4 Get Order Status

```
GET /api/executor/orderStatus/{orderId}

Response (200):
{
  "orderId": "ORD-12345",
  "tradeId": "TRD-20260409-120530-1",
  "positionId": "POS-20260409-120530-1",
  "status": "TRADED" | "PARTIAL" | "PENDING" | "REJECTED",
  "quantity": 50,
  "filledQuantity": 50,
  "fillPrice": 185.60,
  "timestamp": "2026-04-09T10:15:36Z"
}
```

### 7.5 Get Execution Log

```
GET /api/executor/executionLog/{tradeId}

Response (200):
{
  "tradeId": "TRD-20260409-120530-1",
  "positionId": "POS-20260409-120530-1",
  "events": [
    {
      "timestamp": "2026-04-09T10:15:35Z",
      "action": "ENTRY",
      "status": "SUCCESS",
      "executedPrice": 185.60,
      "orderId": "ORD-12345"
    },
    {
      "timestamp": "2026-04-09T10:20:00Z",
      "action": "MODIFY",
      "status": "SUCCESS",
      "modification": {new_SL, new_TP},
      "modificationId": "MOD-..."
    },
    {
      "timestamp": "2026-04-09T10:25:00Z",
      "action": "EXIT",
      "status": "SUCCESS",
      "exitPrice": 190.50,
      "realizedPnl": 250.00
    }
  ]
}
```

---

## 8. Broker Service Integration

TEA calls brokerService for execution:

```typescript
// ONLY place these calls are made in TEA:

// 1. Place Order (entry or exit)
brokerService.placeOrder({
  instrument, direction, quantity, price,
  orderType, productType
})

// 2. Modify Order (live trades)
brokerService.modifyOrder({
  orderId, newStopLoss, newTakeProfit, newTrailingSL
})

// 3. Cancel Order (for exit on live)
brokerService.cancelOrder({
  orderId
})

// 4. Get Order Status (for polling fallback)
brokerService.getOrderStatus({
  orderId
})

// 5. Get Positions (for reconciliation)
brokerService.getPositions()

// 6. Get Scrip Master (for security ID lookup)
brokerService.getScripMaster()

Note: NO other module calls these functions
```

---

## 9. Testing & Validation

### 9.1 Unit Tests (25+ tests)

```
Sanity Checks:
  - ✅ Accept valid trade request
  - ✅ Reject missing executionId
  - ✅ Reject invalid prices (SL > TP for BUY)
  - ✅ Reject zero quantity

Idempotency:
  - ✅ Duplicate executionId returns cached result
  - ✅ Different executionId creates new trade
  - ✅ Idempotent across broker failures

Order Placement:
  - ✅ Place market order
  - ✅ Place limit order
  - ✅ Attach SL/TP for live trade
  - ✅ Handle broker rejection
  - ✅ Handle timeout & retry

Modification (Live):
  - ✅ Modify SL only
  - ✅ Modify TP only
  - ✅ Modify both SL & TP
  - ✅ Enable/disable TSL
  - ✅ Reject invalid modification (SL > TP)
  - ✅ Handle broker rejection on modify

Exit:
  - ✅ Market exit
  - ✅ Limit exit
  - ✅ Cancel pending SL/TP before exit (live)
  - ✅ Partial fill handling
  - ✅ Record exit correctly

Paper vs Live:
  - ✅ Paper: TEA monitors exits
  - ✅ Live: Broker manages exits
  - ✅ Live: modifyOrder sends to broker
  - ✅ Paper: modifyOrder updates local values

Error Handling:
  - ✅ Retry on timeout
  - ✅ Exponential backoff on network failure
  - ✅ Reconcile on process restart
  - ✅ Log all failures
```

### 9.2 Integration Tests (10+ tests)

```
RCA → TEA → Broker Flow:
  - ✅ Full trade lifecycle (entry → modify → exit)
  - ✅ Paper trade scenario
  - ✅ Live trade scenario
  - ✅ Modification during hold
  - ✅ Multiple modifications in sequence

Broker Event Handling:
  - ✅ Order fill event updates position
  - ✅ Partial fill tracked correctly
  - ✅ Order rejection handled
  - ✅ SL/TP auto-exit event processed
  - ✅ Events out-of-order handled gracefully

Portfolio Agent Integration:
  - ✅ TEA updates Portfolio on trade placed
  - ✅ TEA updates Portfolio on trade closed
  - ✅ Portfolio receives complete audit trail
  - ✅ Exit reason recorded correctly

Concurrent Operations:
  - ✅ Simultaneous entry & exit requests
  - ✅ Multiple modifications in quick succession
  - ✅ Broker events while modification pending
```

### 9.3 Stress Tests

```
- ✅ 100+ concurrent trades
- ✅ 1000+ modifications/hour
- ✅ Network latency (500ms+)
- ✅ Broker API rate limiting
- ✅ Process restart recovery
- ✅ WebSocket reconnection
```

---

## 10. Paper vs Live: Detailed Differences

### 10.1 Entry

```
PAPER:
├─ Call brokerService.placeOrder(paper_adapter)
├─ Mock adapter fills instantly at entryPrice
├─ No SL/TP orders (TEA monitors locally)
└─ Position marked FILLED immediately

LIVE:
├─ Call brokerService.placeOrder(live_broker)
├─ Broker places real order
├─ Broker attaches SL order (if supported)
├─ Broker attaches TP order (if supported)
├─ Wait for broker fill confirmation
└─ Position marked FILLED when broker confirms
```

### 10.2 Monitoring

```
PAPER:
├─ TEA continuously monitors position
├─ Checks price vs local SL/TP every 1 second
├─ Detects SL hit: initiates exit
├─ Detects TP hit: initiates exit
└─ Detects other conditions: request RCA or exit

LIVE:
├─ Broker monitors auto-exit (SL/TP)
├─ TEA monitors as backup
├─ On SL hit: Broker exits, TEA receives event
├─ On TP hit: Broker exits, TEA receives event
└─ TEA doesn't initiate SL/TP exits (broker does)
```

### 10.3 Modification

```
PAPER:
├─ RCA sends modifyOrder request
├─ TEA updates local SL/TP values
├─ No broker call needed
└─ Continue monitoring with new values

LIVE:
├─ RCA sends modifyOrder request
├─ TEA calls brokerService.modifyOrder()
├─ Broker updates its SL/TP/TSL
├─ TEA receives confirmation
└─ Continue monitoring with new values
```

### 10.4 Exit

```
PAPER:
├─ RCA sends exitTrade request
├─ TEA calls brokerService.placeOrder(SELL)
├─ Mock adapter fills at exitPrice
└─ Position marked CLOSED

LIVE:
├─ RCA sends exitTrade request (or broker's SL/TP hit)
├─ If TEA initiating:
│  ├─ Cancel pending SL order (if any)
│  ├─ Cancel pending TP order (if any)
│  ├─ Call brokerService.placeOrder(SELL)
│  └─ Wait for broker fill confirmation
├─ If broker initiated (SL/TP hit):
│  ├─ Receive exit event from broker
│  └─ Position marked CLOSED
└─ Either way, update Portfolio Agent
```

---

## 11. Configuration & Settings

```python
# Centralized settings (in Settings page)

TRADE_EXECUTOR_SETTINGS = {
    # Order timeout
    "ORDER_PLACEMENT_TIMEOUT_SEC": 15,
    "ORDER_CONFIRMATION_TIMEOUT_SEC": 30,
    
    # Retry logic
    "RETRY_MAX_ATTEMPTS": 3,
    "RETRY_BACKOFF_BASE_SEC": 1,
    "RETRY_BACKOFF_MAX_SEC": 16,
    
    # Broker communication
    "BROKER_API_TIMEOUT_SEC": 10,
    "BROKER_RATE_LIMIT_PER_SEC": 10,
    "BROKER_RATE_LIMIT_PER_MIN": 250,
    
    # Execution mode
    "PAPER_TRADING_MODE": True,
    "LIVE_TRADING_ENABLED": False,
    
    # Slippage tracking
    "SLIPPAGE_WARNING_THRESHOLD_PCTS": 0.5,
    "SLIPPAGE_ERROR_THRESHOLD_PCTS": 1.0,
    
    # Monitoring
    "POSITION_MONITOR_INTERVAL_SEC": 1,
    "BROKER_EVENT_POLL_INTERVAL_SEC": 5,
    
    # Logging
    "LOG_LEVEL": "INFO",
    "LOG_RETENTION_DAYS": 30
}
```

---

## 12. Implementation Plan

### Phase 1: Foundation (Week 1)
- [ ] Create TEA service skeleton
- [ ] Implement submitTrade API
- [ ] Implement order placement logic
- [ ] Implement idempotency protection
- [ ] Wire to Portfolio Agent (record placed)

### Phase 2: Management APIs (Week 2)
- [ ] Implement modifyOrder API
- [ ] Implement exitTrade API
- [ ] Handle paper vs live differences
- [ ] Implement broker event handling
- [ ] Wire order status tracking

### Phase 3: Integration (Week 2-3)
- [ ] Wire to RCA (submitTrade, modifyOrder, exitTrade)
- [ ] Wire to Broker Service
- [ ] Wire to Portfolio Agent (complete lifecycle)
- [ ] Implement error handling & recovery
- [ ] Implement logging & analytics

### Phase 4: Testing (Week 3-4)
- [ ] Unit tests (25+ tests)
- [ ] Integration tests (10+ tests)
- [ ] Stress tests (concurrency)
- [ ] Paper trading validation
- [ ] Live trading validation (small positions)

---

## 13. Deployment

```
Stage 1: Paper Trading
  └─ Full TEA deployment for paper trades
  └─ Monitor for 3-5 days
  └─ Verify all APIs, error handling, Portfolio updates

Stage 2: Live Trading (Conservative)
  └─ Enable for small positions only
  └─ Manual approval for large orders
  └─ Monitor slippage, fills, modifications

Stage 3: Full Production
  └─ Remove manual approval
  └─ Full automation enabled
  └─ Monitor metrics, adjust thresholds
```

---

## 14. Monitoring & Observability

### TEA Health Metrics

```
- Order placement latency (entry → fill)
- Modification latency (request → broker acknowledgment)
- Exit execution latency
- Fill rate (% of orders filled)
- Slippage per trade (executed vs requested)
- Retry rate (% requiring retry)
- Broker uptime (% of time API available)
- Error rate (% of requests failing)
```

### Logs & Traces

```
Every action logged:
  - executionId
  - tradeId
  - positionId
  - action (ENTRY|MODIFY|EXIT)
  - status (SUCCESS|FAILURE|PARTIAL)
  - timestamp
  - latency
  - broker_response
```

---

## 15. Success Criteria

- ✅ All trades execute through TEA (zero direct broker calls)
- ✅ Paper trades manage complete lifecycle
- ✅ Live trades respect broker auto-exit for SL/TP
- ✅ modifyOrder requests processed < 500ms
- ✅ Idempotency prevents duplicate executions
- ✅ Portfolio Agent receives all updates
- ✅ Error handling & recovery working
- ✅ 100+ unit & integration tests passing
- ✅ Execution latency < 2 seconds (entry to fill)
- ✅ Slippage tracked and logged for analytics

---

## Appendix A: Command Types

```
ENTRY           Initial trade placement
MODIFY          SL/TP/TSL adjustment
EXIT            Full position close
PARTIAL_EXIT    Partial position close
CANCEL          Abort pending order
```

---

**Status:** Ready for Implementation
**Approval:** User (2026-04-09)
**Owner:** AI Team
**Next:** DisciplineAgent_Spec_v1.4.md
