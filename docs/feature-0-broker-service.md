# Feature 0: Broker Service + Token Management (Merged)

**Combines:** Original Feature 0 (Broker Service Abstraction) + Feature 2 (Dhan Token Management)

**Why merged:** Token management is the gatekeeper for the Dhan adapter — you can't test any Dhan functionality without it. Building them together avoids a half-usable intermediate state.

---

## Architecture

```
Frontend (React) ──► tRPC Procedures ──► Broker Service ──► Dhan Adapter ──► Dhan API/WS
Python Modules ────► REST Endpoints  ──► Broker Service ──► Mock Adapter ──► In-Memory
```

**Module location:** `server/broker/`

**MongoDB collection:** `broker_configs` — one document per broker (Dhan, Mock, future stubs)

---

## Deliverables — 6 Testable Steps

Each step produces a working, testable checkpoint. No step depends on Dhan credentials until Step 4.

---

### Step 0.1: Broker Interface + Types + Service Core

**What:** Define the contract that all adapters must implement. Create the service that loads and routes to the active adapter.

**Files:**
```
server/broker/
  types.ts              — BrokerAdapter interface, OrderParams, Position, etc.
  brokerService.ts      — Singleton: getActiveBroker(), switchBroker(), getBrokerStatus()
  brokerConfig.ts       — Mongoose model + CRUD for broker_configs collection
```

**Broker Interface (16 methods):**
```typescript
interface BrokerAdapter {
  // Identity
  readonly brokerId: string;
  readonly displayName: string;

  // Auth
  validateToken(): Promise<{ valid: boolean; expiresAt?: number }>;
  updateToken(token: string, clientId?: string): Promise<void>;

  // Orders
  placeOrder(params: OrderParams): Promise<OrderResult>;
  modifyOrder(orderId: string, params: ModifyParams): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<OrderResult>;
  exitAll(): Promise<OrderResult[]>;
  getOrderBook(): Promise<Order[]>;
  getOrderStatus(orderId: string): Promise<Order>;
  getTradeBook(): Promise<Trade[]>;

  // Positions & Funds
  getPositions(): Promise<Position[]>;
  getMargin(): Promise<MarginInfo>;

  // Market Data
  getScripMaster(exchange: string): Promise<Instrument[]>;
  getExpiryList(underlying: string): Promise<string[]>;
  getOptionChain(underlying: string, expiry: string): Promise<OptionChainData>;

  // Real-time (WebSocket)
  subscribeLTP(instruments: SubscribeParams[], callback: TickCallback): void;
  unsubscribeLTP(instruments: SubscribeParams[]): void;
  onOrderUpdate(callback: OrderUpdateCallback): void;

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Emergency
  killSwitch(action: 'ACTIVATE' | 'DEACTIVATE'): Promise<{ status: string }>;
}
```

**MongoDB `broker_configs` schema:**
```json
{
  "brokerId": "dhan",
  "displayName": "Dhan",
  "isActive": true,
  "isPaperBroker": false,
  "credentials": {
    "accessToken": "encrypted...",
    "clientId": "...",
    "updatedAt": 1743321600000,
    "expiresIn": 86400000,
    "status": "valid | expired | unknown"
  },
  "settings": {
    "orderEntryOffset": 1.0,
    "defaultSL": 2.0,
    "defaultTP": 5.0,
    "orderType": "LIMIT",
    "productType": "INTRADAY"
  },
  "connection": {
    "apiStatus": "connected | disconnected | error",
    "wsStatus": "connected | disconnected | error",
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

**Testable deliverable:**
- Vitest: Mongoose model CRUD (create config, read, update, delete)
- Vitest: BrokerService loads adapter by brokerId
- Vitest: switchBroker() changes active adapter
- curl: `GET /api/broker/config` returns config (empty at first)
- curl: `POST /api/broker/config` creates/updates config

---

### Step 0.2: Mock Adapter (Paper Trading)

**What:** Full implementation of BrokerAdapter for paper trading. No external dependencies — everything in-memory.

**Files:**
```
server/broker/adapters/mock/
  index.ts              — MockAdapter implements BrokerAdapter
  mockOrderBook.ts      — In-memory order tracking, fill simulation
```

**Behavior:**
- `placeOrder()` → instant fill at provided price, generates orderId
- `modifyOrder()` → updates pending order params
- `cancelOrder()` → marks order cancelled
- `exitAll()` → closes all open positions
- `getPositions()` → returns in-memory positions with simulated P&L
- `getMargin()` → returns configurable virtual margin (default ₹5,00,000)
- `getOrderBook()` / `getTradeBook()` → returns in-memory records
- `validateToken()` → always returns `{ valid: true }`
- `subscribeLTP()` → no-op (mock doesn't stream real data)
- `killSwitch('ACTIVATE')` → blocks all new orders, exits all positions

**Testable deliverable:**
- Vitest: Place order → verify in order book
- Vitest: Place order → verify position created
- Vitest: Exit position → verify P&L calculated
- Vitest: Exit All → verify all positions closed
- Vitest: Kill switch → verify orders blocked
- curl: `POST /api/broker/orders` (with mock active) → order placed
- curl: `GET /api/broker/positions` → positions listed
- curl: `GET /api/broker/margin` → margin returned

---

### Step 0.3: tRPC + REST Endpoints

**What:** Expose Broker Service to both frontend (tRPC) and Python modules (REST).

**tRPC procedures (frontend):**
```typescript
broker.config.get        — Get active broker config (masked token)
broker.config.update     — Update broker settings
broker.status            — Connection status + token status
broker.token.status      — Is token valid/expired?
broker.token.update      — Paste new token
broker.orders.place      — Place order
broker.orders.modify     — Modify order
broker.orders.cancel     — Cancel order
broker.orders.list       — Order book
broker.orders.exitAll    — Exit all positions
broker.positions         — Current positions
broker.margin            — Available margin
broker.killSwitch        — Emergency stop
```

**REST endpoints (Python modules):**
```
GET    /api/broker/status              — Connection + token status
GET    /api/broker/config              — Active broker config
POST   /api/broker/config              — Create/update config
POST   /api/broker/token/update        — Update access token
GET    /api/broker/token/status        — Token validity check
POST   /api/broker/orders              — Place order
PUT    /api/broker/orders/:id          — Modify order
DELETE /api/broker/orders/:id          — Cancel order
GET    /api/broker/orders              — Order book
GET    /api/broker/positions           — Positions
GET    /api/broker/margin              — Margin
POST   /api/broker/exit-all            — Exit all positions
POST   /api/broker/kill-switch         — Kill switch
```

**Testable deliverable:**
- Vitest: tRPC caller tests for each procedure (using mock adapter)
- curl: All REST endpoints return correct responses with mock adapter
- Full round-trip: place order via REST → check position via tRPC

---

### Step 0.4: Dhan Adapter — Auth + Token Management

**What:** Dhan adapter skeleton with real auth. This is where Dhan credentials are needed.

**Files:**
```
server/broker/adapters/dhan/
  index.ts              — DhanAdapter implements BrokerAdapter
  types.ts              — Dhan API request/response types
  constants.ts          — API URLs, exchange segments, error codes
  auth.ts               — Token validation, expiry check, 401 handler
```

**Token management logic:**
1. On startup: read `broker_configs.dhan.credentials` from MongoDB
2. Check `updatedAt + expiresIn` vs `Date.now()`
3. If valid → use token, set status = "valid"
4. If expired → set status = "expired", return to frontend
5. Frontend shows blocking popup → user pastes new token → `POST /api/broker/token/update`
6. Mid-day: any Dhan 401 → set status = "expired" → tRPC returns expired status on next poll
7. After token update: validate against `GET /v2/profile` → if OK, set status = "valid"

**Implemented methods (this step):**
- `validateToken()` → calls Dhan `GET /v2/profile`, returns valid/expired
- `updateToken()` → saves to MongoDB, validates, updates status
- `connect()` → validates token on startup
- `disconnect()` → cleanup

**Stub methods (implemented in later features):**
- All order/position/market data methods → throw "Not implemented yet"

**Testable deliverable:**
- Vitest: Token expiry calculation (mocked dates)
- Vitest: 401 detection sets status to expired
- Vitest: Token update flow (mocked Dhan API)
- curl: `POST /api/broker/token/update` with real Dhan token → validates against Dhan profile API
- curl: `GET /api/broker/token/status` → returns valid/expired
- curl: `GET /api/broker/status` → shows Dhan connection status

**User action required:** Provide Dhan access token + client ID

---

### Step 0.5: Dhan Adapter — Scrip Master + Option Chain

**What:** Download and cache scrip master CSV, resolve security IDs, fetch option chain data.

**Implemented methods:**
- `getScripMaster(exchange)` → download CSV, parse, cache in memory
- `getExpiryList(underlying)` → call Dhan `POST /v2/optionchain/expirylist`
- `getOptionChain(underlying, expiry)` → call Dhan `POST /v2/optionchain`
- Internal: `lookupSecurityId(instrument, expiry, strike, type)` → from cached scrip master
- Internal: `resolveMCXSecurityIds()` → auto-resolve nearest-month FUTCOM

**Testable deliverable:**
- Vitest: Scrip master CSV parsing (with sample CSV fixture)
- Vitest: Security ID lookup logic
- Vitest: MCX resolution logic
- curl: `GET /api/broker/scrip-master/status` → last download time, record count
- curl: `POST /api/broker/scrip-master/refresh` → force re-download
- curl: `GET /api/broker/scrip-master/lookup?instrument=NIFTY&expiry=...&strike=24500&type=CE`
- curl: `GET /api/broker/option-chain/expiry-list?underlying=NIFTY_50`
- curl: `GET /api/broker/option-chain?underlying=NIFTY_50&expiry=...`

---

### Step 0.6: Dhan Adapter — Orders + Positions + Funds

**What:** Complete the Dhan adapter with order management and position/fund queries.

**Implemented methods:**
- `placeOrder()` → Dhan `POST /v2/orders` (LIMIT at configurable % below LTP)
- `modifyOrder()` → Dhan `PUT /v2/orders/{id}`
- `cancelOrder()` → Dhan `DELETE /v2/orders/{id}`
- `exitAll()` → cancel all pending + close all positions
- `getOrderBook()` → Dhan `GET /v2/orders`
- `getOrderStatus()` → Dhan `GET /v2/orders/{id}`
- `getTradeBook()` → Dhan `GET /v2/trades`
- `getPositions()` → Dhan `GET /v2/positions`
- `getMargin()` → Dhan `GET /v2/fund-limit`
- `killSwitch()` → Dhan `POST /v2/killswitch` + exit all

**Testable deliverable:**
- Vitest: Order param construction (mocked Dhan responses)
- Vitest: Error handling (order rejection, timeout, partial fill)
- curl: All order/position/margin endpoints with Dhan adapter active
- **Safety:** All tests use paper mode or mocked responses — no real orders placed

---

## What's NOT in This Feature (Deferred)

| Item | Deferred To |
|------|-------------|
| WebSocket LTP streaming | Feature 7 (Real-Time Data) |
| WebSocket order updates | Feature 7 |
| Frontend token popup UI | Feature 3 (Navigation & Layout) |
| Settings page broker section | Feature 4 (Settings Page) |
| Future broker stubs (Zerodha, etc.) | Feature 0 creates empty stubs only |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `mongoose` | Already installed (Feature 1) |
| `csv-parse` | Scrip master CSV parsing |
| `ws` | Reserved for Feature 7 (WebSocket) |

---

## Test Summary

| Step | Vitest Tests | curl Tests | Requires Dhan Token? |
|------|-------------|------------|---------------------|
| 0.1 Core + Config | ~6 | 2 | No |
| 0.2 Mock Adapter | ~8 | 3 | No |
| 0.3 Endpoints | ~10 | 8 | No |
| 0.4 Dhan Auth | ~6 | 3 | **Yes** |
| 0.5 Scrip + OC | ~6 | 5 | **Yes** |
| 0.6 Orders + Pos | ~6 | 6 | **Yes** (paper mode) |
| **Total** | **~42** | **27** | |

---

## Build Order

```
Step 0.1 (Core + Config)
  └── Step 0.2 (Mock Adapter) ── can test everything without Dhan
       └── Step 0.3 (Endpoints) ── full API surface with mock
            └── Step 0.4 (Dhan Auth) ── needs Dhan token
                 ├── Step 0.5 (Scrip + Option Chain)
                 └── Step 0.6 (Orders + Positions)
```

**Steps 0.1–0.3 need zero external credentials.** You can test the entire Broker Service with the Mock adapter before ever touching Dhan.
