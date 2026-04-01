# Feature 0: Broker Service + Token Management (Merged)
**Version:** 1.1  
**Date:** April 2, 2026  
**Author:** Manus AI

---

## Revision History
| Version | Date | Description |
|---------|------|-------------|
| 1.0 | March 28, 2026 | Initial specification |
| 1.1 | April 2, 2026 | Cross-functionality update: deferred order execution settings to Settings spec |

---

## Overviewew

This specification details the implementation of **Feature 0: Broker Service + Token Management**. This feature establishes the foundational broker abstraction layer and integrates the Dhan API. The original Feature 0 (Broker Service Abstraction) and Feature 2 (Dhan Token Management) have been merged because token management acts as the gatekeeper for the Dhan adapter. Testing any Dhan functionality is impossible without it, and building them together avoids a half-usable intermediate state.

## Architecture

The system architecture follows a modular, broker-specific design to facilitate future integrations with other brokers.

**Data Flow:**
*   **Frontend (React)** ──► tRPC Procedures ──► Broker Service ──► Dhan Adapter ──► Dhan API/WS
*   **Python Modules** ────► REST Endpoints ──► Broker Service ──► Mock Adapter ──► In-Memory

**Storage & Location:**
*   **Module Location:** `server/broker/`
*   **Database:** MongoDB collection named `broker_configs`. This collection stores one document per broker (e.g., Dhan, Mock, and future stubs).

## Deliverables & Implementation Steps

The implementation is divided into 6 testable steps. Each step produces a working, testable checkpoint. No step depends on Dhan credentials until Step 0.4.

### Step 0.1: Broker Interface + Types + Service Core

This step defines the contract that all broker adapters must implement and creates the core service that loads and routes requests to the active adapter.

**Files:**
*   `server/broker/types.ts` — Defines the `BrokerAdapter` interface, `OrderParams`, `Position`, etc.
*   `server/broker/brokerService.ts` — Singleton service containing methods like `getActiveBroker()`, `switchBroker()`, and `getBrokerStatus()`.
*   `server/broker/brokerConfig.ts` — Mongoose model and CRUD operations for the `broker_configs` collection.

**Broker Interface (16 Methods):**
The `BrokerAdapter` interface requires implementation of the following methods:
*   **Identity:** `brokerId`, `displayName`
*   **Auth:** `validateToken()`, `updateToken()`
*   **Orders:** `placeOrder()`, `modifyOrder()`, `cancelOrder()`, `exitAll()`, `getOrderBook()`, `getOrderStatus()`, `getTradeBook()`
*   **Positions & Funds:** `getPositions()`, `getMargin()`
*   **Market Data:** `getScripMaster()`, `getExpiryList()`, `getOptionChain()`
*   **Real-time (WebSocket):** `subscribeLTP()`, `unsubscribeLTP()`, `onOrderUpdate()`
*   **Lifecycle:** `connect()`, `disconnect()`
*   **Emergency:** `killSwitch()`

**MongoDB `broker_configs` Schema:**
The schema stores the broker's identity, active status, paper trading flag, credentials (including encrypted access token, client ID, update timestamp, expiry, and status), connection status (API/WS status, latency), and capabilities (e.g., bracket orders, websockets, option chains).

*Note: Order execution settings (order entry offset, default stop-loss/take-profit, order type, product type) have been moved to the global `user_settings` collection. See `Settings_Spec_v1.2.md`.*

**Testable Deliverables:**
*   Vitest: Mongoose model CRUD operations.
*   Vitest: `BrokerService` loads adapter by `brokerId` and `switchBroker()` changes the active adapter.
*   curl: `GET /api/broker/config` returns config and `POST /api/broker/config` creates/updates config.

### Step 0.2: Mock Adapter (Paper Trading)

This step implements a full in-memory paper trading adapter (`MockAdapter`) that requires no external dependencies.

**Files:**
*   `server/broker/adapters/mock/index.ts` — `MockAdapter` implementation.
*   `server/broker/adapters/mock/mockOrderBook.ts` — In-memory order tracking and fill simulation.

**Behavior:**
*   Orders are instantly filled at the provided price.
*   Positions and P&L are simulated in-memory.
*   Margin returns a configurable virtual amount (default ₹5,00,000).
*   Token validation always returns valid.
*   The kill switch blocks all new orders and exits all positions.

**Testable Deliverables:**
*   Vitest: Order placement, position creation, P&L calculation on exit, exit all functionality, and kill switch behavior.
*   curl: Endpoints for placing orders, listing positions, and returning margin using the mock adapter.

### Step 0.3: tRPC + REST Endpoints

This step exposes the Broker Service to both the frontend (via tRPC) and Python modules (via REST).

**tRPC Procedures (Frontend):**
*   Config management (`broker.config.get`, `broker.config.update`)
*   Status and token management (`broker.status`, `broker.token.status`, `broker.token.update`)
*   Order management (`broker.orders.place`, `broker.orders.modify`, `broker.orders.cancel`, `broker.orders.list`, `broker.orders.exitAll`)
*   Portfolio management (`broker.positions`, `broker.margin`)
*   Emergency (`broker.killSwitch`)

**REST Endpoints (Python Modules):**
*   `GET /api/broker/status`, `GET /api/broker/config`, `POST /api/broker/config`
*   `POST /api/broker/token/update`, `GET /api/broker/token/status`
*   `POST /api/broker/orders`, `PUT /api/broker/orders/:id`, `DELETE /api/broker/orders/:id`, `GET /api/broker/orders`
*   `GET /api/broker/positions`, `GET /api/broker/margin`
*   `POST /api/broker/exit-all`, `POST /api/broker/kill-switch`

**Testable Deliverables:**
*   Vitest: tRPC caller tests for each procedure using the mock adapter.
*   curl: All REST endpoints return correct responses with the mock adapter.
*   Full round-trip testing (e.g., place order via REST, check position via tRPC).

### Step 0.4: Dhan Adapter — Auth + Token Management

This step introduces the Dhan adapter skeleton with real authentication logic. This is the first step requiring Dhan credentials.

**Files:**
*   `server/broker/adapters/dhan/index.ts` — `DhanAdapter` implementation.
*   `server/broker/adapters/dhan/types.ts` — Dhan API request/response types.
*   `server/broker/adapters/dhan/constants.ts` — API URLs, exchange segments, error codes.
*   `server/broker/adapters/dhan/auth.ts` — Token validation, expiry check, 401 handler.

**Token Management Logic:**
1.  On startup, read `broker_configs.dhan.credentials` from MongoDB.
2.  Check `updatedAt` and `expiresIn` against the current time.
3.  If valid, use the token and set status to "valid".
4.  If expired, set status to "expired" and prompt the frontend for a new token.
5.  Handle mid-day 401 Unauthorized errors by setting the status to "expired".
6.  After a token update, validate it against the Dhan `GET /v2/profile` API.

**Testable Deliverables:**
*   Vitest: Token expiry calculation, 401 detection, and token update flow.
*   curl: Token update and validation against the Dhan profile API, token status, and connection status.

### Step 0.5: Dhan Adapter — Scrip Master + Option Chain

This step implements market data retrieval for the Dhan adapter.

**Implemented Methods:**
*   `getScripMaster()`: Downloads, parses, and caches the scrip master CSV in memory.
*   `getExpiryList()`: Calls Dhan `POST /v2/optionchain/expirylist`.
*   `getOptionChain()`: Calls Dhan `POST /v2/optionchain`.
*   Internal methods for security ID lookup and auto-resolving nearest-month MCX contracts.

**Testable Deliverables:**
*   Vitest: Scrip master CSV parsing, security ID lookup logic, and MCX resolution logic.
*   curl: Endpoints for scrip master status, refresh, lookup, expiry list, and option chain data.

### Step 0.6: Dhan Adapter — Orders + Positions + Funds

This step completes the Dhan adapter by implementing order management and portfolio queries.

**Implemented Methods:**
*   `placeOrder()`: Dhan `POST /v2/orders` (LIMIT at configurable % below LTP).
*   `modifyOrder()`: Dhan `PUT /v2/orders/{id}`.
*   `cancelOrder()`: Dhan `DELETE /v2/orders/{id}`.
*   `exitAll()`: Cancels all pending orders and closes all positions.
*   `getOrderBook()`: Dhan `GET /v2/orders`.
*   `getOrderStatus()`: Dhan `GET /v2/orders/{id}`.
*   `getTradeBook()`: Dhan `GET /v2/trades`.
*   `getPositions()`: Dhan `GET /v2/positions`.
*   `getMargin()`: Dhan `GET /v2/fund-limit`.
*   `killSwitch()`: Dhan `POST /v2/killswitch` and exits all positions.

**Testable Deliverables:**
*   Vitest: Order parameter construction and error handling (rejection, timeout, partial fill).
*   curl: All order, position, and margin endpoints with the Dhan adapter active.
*   *Safety Note:* All tests use paper mode or mocked responses to ensure no real orders are placed during testing.

## Deferred Features

The following items are not included in this feature and are deferred to later stages:
*   **WebSocket LTP streaming:** Deferred to Feature 7 (Real-Time Data).
*   **WebSocket order updates:** Deferred to Feature 7.
*   **Frontend token popup UI:** Deferred to Feature 3 (Navigation & Layout).
*   **Settings page broker section:** Deferred to Feature 4 (Settings Page).
*   **Future broker stubs (e.g., Zerodha):** Feature 0 creates empty stubs only.

## Dependencies

*   **mongoose:** Already installed (Feature 1).
*   **csv-parse:** Required for scrip master CSV parsing.
*   **ws:** Reserved for Feature 7 (WebSocket).

## Build Order & Testing Summary

The build order is sequential, ensuring that Steps 0.1 through 0.3 can be built and tested entirely without Dhan credentials using the Mock adapter.

1.  **Step 0.1 (Core + Config)**
2.  **Step 0.2 (Mock Adapter)**
3.  **Step 0.3 (Endpoints)**
4.  **Step 0.4 (Dhan Auth)** *(Requires Dhan Token)*
5.  **Step 0.5 (Scrip + Option Chain)** *(Requires Dhan Token)*
6.  **Step 0.6 (Orders + Positions)** *(Requires Dhan Token, tested in paper mode)*

Total tests planned: ~42 Vitest tests and 27 curl tests.
