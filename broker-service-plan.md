# Broker Service + Dhan Adapter — Implementation Plan

## Overview

A standalone middleware module inside the Node.js backend that abstracts all broker communication. Dhan is the first adapter. Every other part of the system (frontend, backend procedures, Python modules) talks only to the Broker Service — never directly to Dhan.

## Architecture

```
Frontend (React) ──► tRPC Procedures ──► Broker Service ──► Dhan Adapter ──► Dhan API/WS
Python Modules ────► REST Endpoints ──► Broker Service ──► Dhan Adapter ──► Dhan API/WS
```

## What Already Exists (Python — will migrate to Broker Service)

| Feature | Current Location | Dhan API Used |
|---|---|---|
| Auth (hardcoded token) | Both Python files | Header `access-token` |
| Profile check | `option_chain_fetcher.py` | `GET /v2/profile` |
| Scrip master download | `option_chain_fetcher.py` | CSV from `images.dhan.co` |
| MCX security ID resolution | `option_chain_fetcher.py` | Parsed from scrip master CSV |
| Option chain expiry list | `option_chain_fetcher.py` | `POST /v2/optionchain/expirylist` |
| Option chain data | `option_chain_fetcher.py` | `POST /v2/optionchain` |
| Place MARKET order | `execution_module.py` | `POST /v2/orders` |
| Security ID lookup | `execution_module.py` | Local scrip master CSV |
| SL/TP monitoring | `execution_module.py` | In-memory polling (not Dhan) |
| Paper trading simulation | `execution_module.py` | Uses option chain prices |

## What's New (Not yet implemented anywhere)

| Feature | Dhan API |
|---|---|
| LIMIT orders | `POST /v2/orders` with orderType=LIMIT |
| Bracket orders (SL/TP) | `POST /v2/orders` with productType=BO |
| Order modification | `PUT /v2/orders/{order-id}` |
| Order cancellation | `DELETE /v2/orders/{order-id}` |
| Order slicing | `POST /v2/orders/slicing` |
| Order book | `GET /v2/orders` |
| Single order status | `GET /v2/orders/{order-id}` |
| Order by correlation ID | `GET /v2/orders/external/{correlation-id}` |
| Trade book | `GET /v2/trades` |
| Trades of an order | `GET /v2/trades/{order-id}` |
| Positions | `GET /v2/positions` |
| Funds & margin | `GET /v2/fund-limit` |
| Kill switch | `POST /v2/killswitch` |
| Live Market Feed (WebSocket) | Dhan WebSocket binary protocol |
| Live Order Update (WebSocket) | Dhan WebSocket |
| Market Quote (single) | `GET /v2/marketfeed/ltp` |
| Historical data | `GET /v2/charts/historical` |

---

## Implementation — Feature by Feature

### STEP 1: Broker Service Core + MongoDB Config
**Scope:** Create the module structure, broker interface, and MongoDB config store.

**Files to create:**
```
server/broker/
  types.ts              — Unified broker interface (TypeScript types)
  brokerService.ts      — Main service: loads active adapter, routes calls
  brokerConfig.ts       — MongoDB CRUD for broker_configs collection
  adapters/
    dhan/
      index.ts          — Dhan adapter implementing broker interface
      types.ts          — Dhan-specific types (API request/response shapes)
      constants.ts      — Dhan API URLs, exchange segments, error codes
    mock/
      index.ts          — Mock adapter for paper trading
```

**MongoDB collection:** `broker_configs`
```json
{
  "brokerId": "dhan",
  "displayName": "Dhan",
  "isActive": true,
  "isPaperBroker": false,
  "credentials": {
    "accessToken": "...",
    "clientId": "...",
    "updatedAt": "2026-03-30T09:00:00Z",
    "expiresIn": 86400,
    "status": "valid"
  },
  "settings": {
    "orderEntryOffset": 1.0,
    "defaultSL": 2.0,
    "defaultTP": 5.0,
    "orderType": "LIMIT",
    "productType": "INTRADAY"
  },
  "connection": {
    "apiStatus": "disconnected",
    "wsStatus": "disconnected",
    "lastApiCall": null,
    "lastWsTick": null,
    "latencyMs": null
  },
  "capabilities": {
    "bracketOrder": true,
    "coverOrder": true,
    "websocket": true,
    "optionChain": true,
    "gtt": true,
    "amo": true
  }
}
```

**Testing (Postman/curl):**
- `POST /api/broker/config` — Create/update broker config
- `GET /api/broker/config` — Get active broker config
- `GET /api/broker/status` — Get connection status
- `POST /api/broker/validate-token` — Validate stored token against Dhan profile API

---

### STEP 2: Auth & Token Management
**Scope:** Token validation, expiry detection, refresh flow.

**Logic:**
1. On startup: read `broker_configs` from MongoDB
2. Check `credentials.updatedAt` + `credentials.expiresIn` vs current time
3. If valid: use token, set `credentials.status = "valid"`
4. If expired: set `credentials.status = "expired"`, return expired status to frontend
5. Frontend shows blocking popup → user pastes new token → `POST /api/broker/update-token`
6. Mid-day: any Dhan API 401 → set status to "expired" → push event to frontend via WebSocket

**Testing (Postman/curl):**
- `POST /api/broker/update-token` — Update token with new value
- `GET /api/broker/token-status` — Check if token is valid/expired
- Simulate expired token → verify status changes
- Simulate 401 from Dhan → verify expiry detection

---

### STEP 3: Scrip Master & Security ID Resolution
**Scope:** Download, cache, and query scrip master. Replace duplicated logic in both Python files.

**Logic:**
1. On startup (or daily): download scrip master CSV from Dhan
2. Parse and store in memory (Map structure for fast lookup)
3. Auto-resolve MCX commodity security IDs (nearest-month FUTCOM)
4. Expose lookup: `getSecurityId(instrument, expiry, strike, optionType)`

**Testing (Postman/curl):**
- `GET /api/broker/scrip-master/status` — Last download time, record count
- `POST /api/broker/scrip-master/refresh` — Force re-download
- `GET /api/broker/scrip-master/lookup?instrument=NIFTY&expiry=2026-04-03&strike=24500&type=CE` — Lookup security ID
- `GET /api/broker/scrip-master/mcx-resolved` — Show resolved MCX security IDs

---

### STEP 4: Option Chain APIs
**Scope:** Expiry list + option chain data. Replace `option_chain_fetcher.py` Dhan calls.

**Unified interface:**
```typescript
getExpiryList(underlying: string): Promise<string[]>
getOptionChain(underlying: string, expiry: string): Promise<OptionChainData>
```

**Testing (Postman/curl):**
- `GET /api/broker/option-chain/expiry-list?underlying=NIFTY_50` — Get expiry dates
- `GET /api/broker/option-chain?underlying=NIFTY_50&expiry=2026-04-03` — Get full option chain
- `GET /api/broker/option-chain?underlying=CRUDEOIL&expiry=2026-04-19` — MCX test
- Verify response shape matches what Python analyzer expects

---

### STEP 5: Order Management (REST)
**Scope:** Place, modify, cancel orders. Replace `execution_module.py` order logic.

**Unified interface:**
```typescript
placeOrder(params: OrderParams): Promise<{ orderId: string, status: string }>
modifyOrder(orderId: string, params: ModifyParams): Promise<{ orderId: string, status: string }>
cancelOrder(orderId: string): Promise<{ orderId: string, status: string }>
exitAll(): Promise<{ results: OrderResult[] }>
getOrderBook(): Promise<Order[]>
getOrderStatus(orderId: string): Promise<Order>
getTradeBook(): Promise<Trade[]>
```

**Key change from existing:**
- Current: MARKET orders only
- New: LIMIT orders at configurable % below LTP (default 1%)
- New: Bracket orders with SL/TP (Dhan handles triggers)
- New: Order modification and cancellation

**Testing (Postman/curl):**
- `POST /api/broker/orders` — Place order (paper mode first!)
- `PUT /api/broker/orders/:orderId` — Modify order
- `DELETE /api/broker/orders/:orderId` — Cancel order
- `GET /api/broker/orders` — Order book
- `GET /api/broker/orders/:orderId` — Single order status
- `GET /api/broker/trades` — Trade book
- `POST /api/broker/exit-all` — Exit all positions

**IMPORTANT:** Test with paper/mock adapter first, then switch to Dhan with LIVE_TRADING=false.

---

### STEP 6: Positions & Funds
**Scope:** Fetch positions, holdings, margin/fund details.

**Unified interface:**
```typescript
getPositions(): Promise<Position[]>
getMargin(): Promise<{ available: number, used: number, total: number }>
getFundLimit(): Promise<FundDetails>
```

**Testing (Postman/curl):**
- `GET /api/broker/positions` — Current positions
- `GET /api/broker/margin` — Available margin
- `GET /api/broker/fund-limit` — Full fund details

---

### STEP 7: WebSocket — Live Market Feed (LTP)
**Scope:** Real-time LTP streaming from Dhan WebSocket.

**Dhan WebSocket details (from docs):**
- Binary protocol (not JSON)
- Subscribe/unsubscribe to instruments
- Receives tick data: LTP, volume, OI, bid/ask

**Unified interface:**
```typescript
subscribeLTP(instruments: string[], callback: (data: TickData) => void): void
unsubscribeLTP(instruments: string[]): void
```

**Architecture:**
- Broker Service maintains one WebSocket connection to Dhan
- Frontend subscribes via Server-Sent Events (SSE) or WebSocket from Node.js
- Python modules can also subscribe via REST long-poll or WebSocket

**Testing:**
- `GET /api/broker/ltp?instruments=NIFTY_50,BANKNIFTY` — One-shot LTP (REST fallback)
- `WS /api/broker/ws/ltp` — WebSocket stream (subscribe to instruments)
- Verify tick frequency and latency
- Test reconnection on disconnect

---

### STEP 8: WebSocket — Live Order Updates
**Scope:** Real-time order status changes from Dhan.

**Unified interface:**
```typescript
onOrderUpdate(callback: (update: OrderUpdate) => void): void
```

**Testing:**
- Place an order → verify real-time status update received
- Cancel an order → verify cancellation update
- Test with bracket order → verify SL/TP trigger updates

---

### STEP 9: Mock Adapter (Paper Trading)
**Scope:** Full mock implementation for AI Trades PAPER tab.

**Logic:**
- Simulates order placement (instant fill at current option chain price)
- Tracks positions in-memory
- Monitors SL/TP using real LTP from Dhan WebSocket (real prices, fake orders)
- Same interface as Dhan adapter

**Testing:**
- All the same endpoints as Steps 5-6, but with `?broker=mock` or active broker set to mock
- Verify paper P&L matches real price movements

---

### STEP 10: REST Endpoints for Python Modules
**Scope:** Expose Broker Service via REST for Python modules to call.

**Endpoints:**
```
POST   /api/broker/orders              — Place order
PUT    /api/broker/orders/:id          — Modify order
DELETE /api/broker/orders/:id          — Cancel order
GET    /api/broker/orders              — Order book
GET    /api/broker/positions           — Positions
GET    /api/broker/margin              — Margin
GET    /api/broker/ltp                 — One-shot LTP
GET    /api/broker/option-chain        — Option chain
GET    /api/broker/scrip-master/lookup — Security ID lookup
POST   /api/broker/validate-token      — Token check
POST   /api/broker/update-token        — Token update
GET    /api/broker/status              — Connection status
GET    /api/broker/config              — Broker config
```

**Testing:**
- Call all endpoints from Postman
- Call from Python `requests` library to verify compatibility
- Test error responses (invalid token, bad params, Dhan down)

---

### STEP 11: Kill Switch
**Scope:** Emergency stop — cancel all orders, close all positions.

**Unified interface:**
```typescript
killSwitch(action: 'ACTIVATE' | 'DEACTIVATE'): Promise<{ status: string }>
```

**Testing:**
- `POST /api/broker/kill-switch` — Activate kill switch
- Verify all orders cancelled, all positions squared off
- Verify trading blocked until deactivated

---

## Testing Strategy

### Phase 1: Unit Tests (Vitest)
- Broker interface type compliance
- MongoDB config CRUD
- Token expiry logic
- Scrip master parsing
- Mock adapter full flow

### Phase 2: Integration Tests (Postman Collection)
- Create a Postman collection with all endpoints
- Test with Mock adapter first (safe)
- Then test with Dhan adapter (paper mode)
- Export collection for reuse

### Phase 3: End-to-End (Manual)
- Full flow: place order → monitor → SL/TP hit → position closed
- WebSocket: subscribe → receive ticks → verify latency
- Token expiry: simulate → verify popup → paste new token → verify reconnect
- Kill switch: activate → verify everything stops

---

## Dependencies

- `mongoose` — MongoDB driver
- `ws` — WebSocket client for Dhan
- `csv-parse` — Scrip master CSV parsing
- `node-fetch` or built-in `fetch` — Dhan REST API calls

---

## Key Design Decisions

| Decision | Choice |
|---|---|
| Daily loss limit | Combined across all exchanges (2A) |
| Max trades per day | Combined across all exchanges (3A) |
| MCX trading day ends | 11:30 PM (4A) |
| Capital model | Shared pool |
| Day close | All positions must be closed first |
| Order type | LIMIT at configurable % below LTP (default 1%) |
| SL/TP | Dhan bracket orders (server-side triggers) |
| No broker config history tracking | Confirmed |
