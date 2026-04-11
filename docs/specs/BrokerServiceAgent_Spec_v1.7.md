# Broker Service Agent (BSA)
**Version:** 1.7  
**Date:** April 11, 2026  
**Project:** Automatic Trading System (ATS)  
**Author:** Manus AI

---

## Revision History

| Version | Date | Description |
|---------|------|-------------|
| 1.0 | March 28, 2026 | Initial specification |
| 1.1 | April 2, 2026 | Deferred order execution settings to Settings spec |
| 1.2 | April 2, 2026 | Added Step 0.7: WebSocket Hybrid Architecture |
| 1.3 | April 11, 2026 | Renamed to Broker Service Agent (BSA). Updated architecture: TFA direct to Dhan WS. Removed ATM sliding window and greeksPoller. Simplified SubscriptionManager. Pending items documented. |
| 1.4 | April 11, 2026 | Added Trading Modes section: 4 channels (ai-live, ai-paper, my-live, my-paper), dual MockAdapter instances, shared DhanAdapter for live channels, mode ownership per workspace. |
| 1.5 | April 11, 2026 | Added Testing workspace: 2 additional channels (testing-sandbox, testing-live), sandboxMode flag on DhanAdapter, no capital pool connection. Full 6-channel table. |
| 1.6 | April 11, 2026 | Clarifications: Testing is one tab with Live/Sandbox toggle (not two tabs). Kill switch is per-workspace and independent (ai-live, my-live, testing-live each have own switch). Two MockAdapter broker_configs documents (mock-ai, mock-my). Channel parameter added to all order/position/margin REST endpoints. Sandbox connect() is token-validation only (no WebSocket). |
| 1.7 | April 11, 2026 | Fixed duplicate section numbers. Updated data flow diagram for 6 channels. Added channel input to tRPC procedures. Added workspace input to broker.killSwitch tRPC. Added broker_configs seed documents table. Added brokerService.ts refactor to §10 Pending. |

---

## 1. Trading Modes

The ATS has three independent trading workspaces. Each has its own mode, its own channels, and its own purpose.

### 1.1 Workspaces

| Workspace | Who Trades | Purpose | Mode Switch Location |
|-----------|-----------|---------|---------------------|
| **AI Trades** | AI model (automatic) | Production AI trading | Settings page only |
| **My Trades** | User (manual) | Production manual trading | On-screen toggle |
| **Testing** | User (manual) | Code & logic validation only — not for production trading | On-screen toggle |

- **AI Trades** — shows only the active mode at a time (Live or Paper). Mode switched from Settings page.
- **My Trades** — displays Live and Paper as **two independent tabs**, both always active simultaneously. Mode toggled on-screen.
- **Testing** — **one tab** with a Live/Sandbox toggle. Only one mode active at a time. No capital pool connection — purely for code and integration validation before promoting to production channels.

### 1.2 Channels

BSA routes all orders through one of six channels. Each channel has its own adapter instance and its own isolated state.

| Channel | Workspace | Mode | Adapter | `brokerId` | Capital Pool |
|---------|-----------|------|---------|------------|--------------|
| `ai-live` | AI Trades | Live | `DhanAdapter` | `"dhan"` | AI Live pool |
| `ai-paper` | AI Trades | Paper | `MockAdapter` | `"mock-ai"` | AI Paper pool |
| `my-live` | My Trades | Live | `DhanAdapter` | `"dhan"` | My Live pool |
| `my-paper` | My Trades | Paper | `MockAdapter` | `"mock-my"` | My Paper pool |
| `testing-live` | Testing | Live | `DhanAdapter` | `"dhan"` | **None** |
| `testing-sandbox` | Testing | Sandbox | `DhanAdapter` (sandboxMode) | `"dhan-sandbox"` | **None** |

**Key points:**

- `ai-live`, `my-live`, and `testing-live` all use the **same DhanAdapter** instance (`brokerId: "dhan"`) — same Dhan account, same credentials, same real order book. Orders from any of these channels are visible together in the Dhan order book.
- `ai-paper` and `my-paper` are **two separate MockAdapter instances** with separate `broker_configs` documents (`"mock-ai"` and `"mock-my"`) — completely isolated in-memory state; positions and P&L of one have no effect on the other.
- `testing-sandbox` uses a separate `DhanAdapter` instance (`brokerId: "dhan-sandbox"`, `sandboxMode: true`) pointed at `sandbox.dhan.co` with separate Dhan DevPortal credentials. Fills at a fixed ₹100 regardless of order price — for API contract validation only.
- `testing-live` uses real Dhan with small real money — for end-to-end logic validation before promoting to production channels.
- **No capital pool** for Testing channels. Testing is purely for code and integration validation.
- Capital pools for AI Trades and My Trades are independent per channel — each follows the 75/25 compounding principle (`CapitalPools_Spec_v1.4.md`). Pool management is handled by the Capital Pools system — not BSA.
- BSA does not enforce which channel a consumer targets. It routes whatever channel is specified in the request.

### 1.3 Mode State Storage

| Workspace | Field | Default | Stored in |
|-----------|-------|---------|-----------|
| AI Trades | `aiTradesMode` (`"live"` \| `"paper"`) | `"paper"` | `user_settings` (Settings page only) |
| My Trades | `myTradesMode` (`"live"` \| `"paper"`) | `"paper"` | `user_settings` (on-screen toggle, persisted) |
| Testing | `testingMode` (`"live"` \| `"sandbox"`) | `"sandbox"` | `user_settings` (on-screen toggle, persisted) |

> My Trades and Testing mode toggles are on-screen but persisted to `user_settings` so they survive page refresh. AI Trades mode is Settings-only — no on-screen toggle in the AI Trades workspace.

---

## 2. Overview

The **Broker Service Agent (BSA)** is the single authoritative gateway for all broker interactions in the ATS. Every order, market data request, and credential flows through it.

**Responsibilities:**
- Broker abstraction — today Dhan, tomorrow any broker via `BrokerAdapter` interface
- Credential management — access token lifecycle, expiry, update
- Order routing — place, modify, cancel, exit across all 6 channels
- Market data — option chain snapshots, expiry list, scrip master lookups on demand
- WebSocket feed — opens and maintains the Dhan WebSocket connection; frontend consumes ticks via tRPC SSE
- Kill switch — per-workspace, independent; exits always bypass

**Not BSA's responsibility:**
- ATM window management — consumers own their subscription logic
- Greeks / IV polling — TFA polls option chain at its own cadence
- Capital pool tracking — owned by Capital Pools system (`CapitalPools_Spec_v1.4.md`)
- Feature engineering, model inference, trade decisions — upstream AI pipeline

---

## 3. Architecture

### 3.1 Data Flow

```
                                     ┌──► DhanAdapter (live) ──► api.dhan.co
                                     │     ai-live, my-live, testing-live
Frontend (Next.js) ──► tRPC ──► BSA ─┤
                                     ├──► DhanAdapter (sandbox) ──► sandbox.dhan.co
Python AI Engine ──► REST ───► BSA ──┤    testing-sandbox
                                     │
                                     ├──► MockAdapter (mock-ai) ──► In-Memory
                                     │    ai-paper
                                     └──► MockAdapter (mock-my) ──► In-Memory
                                          my-paper

TFA (TickFeatureAgent) ──────────────────────────► Dhan WS (direct, low latency)
                         └──► BSA REST (option chain, scrip master, token)

BSA tickBus / tickWs ────────────────────────────► Frontend tick display (latency-insensitive)
```

**Key design decision — TFA direct WS:** Routing ticks through BSA (Dhan WS → Node.js parser → tickBus → tickWs → Python) adds relay latency on every tick. TFA obtains Dhan credentials from `GET /api/broker/token` at startup and opens its own direct WebSocket connection for the full session. BSA's `tickBus` and `tickWs.ts` remain for frontend display only.

### 3.2 Module Location

```
server/broker/
├── brokerService.ts          — singleton, adapter registry, kill switch
├── brokerConfig.ts           — MongoDB model + CRUD for broker_configs
├── brokerRoutes.ts           — Express REST endpoints for Python consumers
├── brokerRouter.ts           — tRPC router for frontend
├── tickBus.ts                — internal EventEmitter, single tick source of truth
├── tickWs.ts                 — WebSocket server at /ws/ticks (frontend/future use)
├── types.ts                  — BrokerAdapter interface, OrderParams, TickData, etc.
└── adapters/
    ├── mock/
    │   ├── index.ts          — MockAdapter (paper trading, in-memory fills)
    │   └── mockOrderBook.ts  — in-memory order + position tracking
    └── dhan/
        ├── index.ts          — DhanAdapter (live Dhan API v2)
        ├── auth.ts           — token validation, expiry, 401 handler
        ├── constants.ts      — API URLs, exchange segments, error codes
        ├── types.ts          — Dhan API request/response shapes
        ├── utils.ts          — shared helpers
        ├── websocket.ts      — DhanWebSocket binary parser + reconnection
        ├── subscriptionManager.ts — subscription registry + budget tracking
        └── orderUpdateWs.ts  — order update WebSocket (fills/status changes)
```

### 3.3 MongoDB Collection

`broker_configs` — one document per broker adapter.

Stores: identity (`brokerId`, `displayName`, `isActive`, `isPaperBroker`, `sandboxMode`), credentials (access token, clientId, updatedAt, expiresIn, status), settings (see §3.4), connection status (API/WS status, latency), capabilities (bracket orders, websocket, option chain, etc.).

**Required seed documents (must exist before BSA starts):**

| `brokerId` | `displayName` | `sandboxMode` | `isPaperBroker` | Used by channels |
|------------|--------------|---------------|-----------------|-----------------|
| `"dhan"` | `"Dhan Live"` | `false` | `false` | `ai-live`, `my-live`, `testing-live` |
| `"dhan-sandbox"` | `"Dhan Sandbox"` | `true` | `false` | `testing-sandbox` |
| `"mock-ai"` | `"Paper (AI Trades)"` | `false` | `true` | `ai-paper` |
| `"mock-my"` | `"Paper (My Trades)"` | `false` | `true` | `my-paper` |

### 3.4 Settings Reference

Order execution defaults (Entry Offset, Order Type, Product Type, Default SL, Default TP, Trailing Stop) are stored in `broker_configs.settings` and managed via the Settings Page (§3.2 of `Settings_Spec_v1.4.md`). BSA reads these defaults when consumers omit optional order parameters.

---

## 4. Broker Adapter Interface

All adapters implement the `BrokerAdapter` interface (16 methods):

| Category | Methods |
|----------|---------|
| Identity | `brokerId`, `displayName` |
| Auth | `validateToken()`, `updateToken()` |
| Orders | `placeOrder()`, `modifyOrder()`, `cancelOrder()`, `exitAll()`, `getOrderBook()`, `getOrderStatus()`, `getTradeBook()` |
| Positions & Funds | `getPositions()`, `getMargin()` |
| Market Data | `getScripMaster()`, `getExpiryList()`, `getOptionChain()` |
| Real-time | `subscribeLTP()`, `unsubscribeLTP()`, `onOrderUpdate()` |
| Lifecycle | `connect()`, `disconnect()` |
| Emergency | `killSwitch()` |

### 4.1 DhanAdapter

Implements `BrokerAdapter` against Dhan API v2.

Two instances exist at runtime:

| Instance | Base URL | Used by channels | Credentials |
|----------|----------|-----------------|-------------|
| Live | `https://api.dhan.co` | `ai-live`, `my-live`, `testing-live` | Live Dhan account |
| Sandbox | `https://sandbox.dhan.co` | `testing-sandbox` | Dhan DevPortal (separate) |

The `sandboxMode: Boolean` field on the `broker_configs` document controls which base URL the adapter uses. The sandbox document has `brokerId: "dhan-sandbox"` and `sandboxMode: true`.

> **Sandbox behaviour:** Dhan Sandbox fills all orders at a fixed ₹100 regardless of the submitted price. This makes it suitable only for API contract testing — not realistic P&L simulation.

- `connect()` — **Live instance:** validates token, opens `DhanWebSocket` (binary feed), opens `orderUpdateWs` (order fill stream). **Sandbox instance:** validates token only — Dhan Sandbox has no WebSocket feed; `DhanWebSocket` and `orderUpdateWs` are not started.
- `getOptionChain()` — calls `POST /v2/optionchain`; returns `OptionChainData` including `callOIChange` / `putOIChange` (= `oi − previous_oi`, intraday ΔOI) and `callSecurityId` / `putSecurityId` per strike
- `getExpiryList()` — calls `POST /v2/optionchain/expirylist`
- `getScripMaster()` — downloads and caches scrip master CSV; exposes `lookupSecurity()`, `getScripExpiryDates()`, `resolveMCXFutcom()`
- `subscribeLTP()` / `unsubscribeLTP()` — delegates to `SubscriptionManager`

### 4.2 MockAdapter

In-memory paper trading adapter. Fills at `params.price` (caller sends current live LTP). No external dependencies. Used for paper trading and tests.

- `placeOrder()` — instant fill at `params.price`; P&L tracked in-memory
- `getPositions()` / `getMargin()` — returns in-memory state
- `subscribeLTP()` / `unsubscribeLTP()` — no-op (no tick feed)
- Token validation always returns valid

---

## 5. WebSocket Architecture

### 5.1 Dhan WebSocket (`websocket.ts`)

- Connects to `wss://api-feed.dhan.co`
- Binary protocol (Little-Endian); parses: Ticker (code 11), Quote (12), OI (15), PrevClose (16), Full Packet (8, 162 bytes), Index (14), MarketStatus, Disconnect
- `mergeTick()` — accumulates partial packets into complete `TickData`
- Batches subscribe/unsubscribe (max 100 security IDs per message, grouped by mode)
- Reconnection: exponential backoff 1s → 30s, max 10 attempts; re-subscribes all instruments on reconnect

### 5.2 SubscriptionManager (`subscriptionManager.ts`)

Maintains the subscription registry for the Dhan WebSocket.

**Retained:**
- Subscription registry — tracks which `securityId`s are subscribed and at which mode (`ltp` / `quote` / `full`)
- Budget tracking — guards against the 5000 instrument Dhan limit
- `subscribeManual(securityIds, mode)` — batch subscribe, deduplicates, enforces budget
- `unsubscribeManual(securityIds)` — batch unsubscribe, cleans registry
- Re-subscribe all on WebSocket reconnect

**Removed:**
- ATM window logic (`setupATMWindow`, `updateATM`, `rebalanceATMWindow`, `removeATMWindow`) — BSA does not know what ATM means; consumers own their subscription strategy
- Position locking (`lockPositions`, `unlockPositions`) — not BSA's concern

### 5.3 tickBus (`tickBus.ts`) — unchanged

Internal `EventEmitter`. Single source of truth for parsed ticks. All BSA consumers (tRPC SSE, tickWs) subscribe here.

Methods: `emitTick()`, `emitRawBinary()`, `emitOrderUpdate()`, `getLatestTick()`, `getAllTicks()`, `clear()`

### 5.4 tickWs (`tickWs.ts`) — unchanged

WebSocket server at `/ws/ticks`. Forwards raw Dhan binary packets to all connected clients. Also sends a JSON snapshot on connect. Kept for frontend and future use.

### 5.5 TFA Tick Consumption (Direct)

TFA (TickFeatureAgent, Python) connects **directly** to the Dhan WebSocket — not through BSA's relay — to eliminate the Node.js relay latency. TFA:

1. Calls `GET /api/broker/token` at startup to obtain live Dhan credentials
2. Opens its own Dhan WS connection using those credentials
3. Subscribes full current-expiry option chain + underlying futures contract directly
4. Manages its own expiry rollover (unsubscribe old strikes → subscribe new)

BSA's `tickBus` and `tickWs.ts` continue to serve the frontend (latency-insensitive display).

---

## 6. REST Endpoints (Python consumers)

### 6.1 Implemented

**Channel-scoped endpoints** — `:channel` = `ai-live` | `ai-paper` | `my-live` | `my-paper` | `testing-live` | `testing-sandbox`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/broker/:channel/orders` | Place order (kill switch checked for live channels) |
| PUT | `/api/broker/:channel/orders/:id` | Modify order (kill switch checked for live channels) |
| DELETE | `/api/broker/:channel/orders/:id` | Cancel order (bypasses kill switch) |
| GET | `/api/broker/:channel/orders` | Order book for channel |
| GET | `/api/broker/:channel/positions` | Current positions for channel |
| GET | `/api/broker/:channel/margin` | Margin / fund info for channel |
| POST | `/api/broker/:channel/exit-all` | Exit all positions for channel (bypasses kill switch) |

**Global endpoints** — not channel-scoped; always route to the live DhanAdapter (`"dhan"`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/broker/status` | Connection + token status |
| GET | `/api/broker/config` | Active broker config (token masked) |
| GET | `/api/broker/configs` | All broker configs (tokens masked) |
| POST | `/api/broker/config` | Create / update broker config |
| GET | `/api/broker/token/status` | Token validity check |
| POST | `/api/broker/token/update` | Update access token |
| POST | `/api/broker/kill-switch` | Activate / deactivate kill switch (body: `{ workspace: "ai" \| "my" \| "testing", action: "ACTIVATE" \| "DEACTIVATE" }`) |
| GET | `/api/broker/option-chain` | Option chain snapshot (`?underlying=&expiry=`) |
| GET | `/api/broker/option-chain/expiry-list` | Expiry dates from Dhan API |
| GET | `/api/broker/scrip-master/status` | Scrip master cache status |
| POST | `/api/broker/scrip-master/refresh` | Force re-download scrip master |
| GET | `/api/broker/scrip-master/lookup` | Lookup security ID by symbol/expiry/strike |
| GET | `/api/broker/scrip-master/expiry-list` | Expiry dates from scrip master cache |
| GET | `/api/broker/scrip-master/mcx-futcom` | Resolve nearest-month MCX FUTCOM |
| POST | `/api/broker/charts/intraday` | Intraday OHLCV candle data |
| POST | `/api/broker/charts/historical` | Daily historical OHLCV candle data |
| GET | `/api/broker/trades` | Trade book |

### 6.2 Pending (to be added at final wiring)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/broker/token` | **Unmasked** credentials for TFA's direct Dhan WS connection |
| POST | `/api/broker/feed/subscribe` | Subscribe security IDs to BSA's Dhan WS (for non-TFA consumers) |
| POST | `/api/broker/feed/unsubscribe` | Unsubscribe security IDs |
| GET | `/api/broker/feed/state` | Current subscription registry + WS status |

> **Tick stream format:** TFA connects directly to Dhan WS (§4.5), so BSA's `/ws/ticks` raw binary format is sufficient for the frontend relay. If any Python consumer needs JSON ticks from BSA, a `/ws/ticks-json` endpoint (parsed `TickData` as JSON NDJSON) can be added — decision deferred.

---

## 7. tRPC Procedures (Frontend)

| Procedure | Type | Description |
|-----------|------|-------------|
| `broker.config.get` | Query | Active broker config |
| `broker.config.list` | Query | All broker configs |
| `broker.config.update` | Mutation | Update broker config |
| `broker.config.switchBroker` | Mutation | Switch active broker |
| `broker.config.updateSettings` | Mutation | Update order execution settings |
| `broker.status` | Query | Connection + token health |
| `broker.token.status` | Query | Token validity |
| `broker.token.update` | Mutation | Update access token |
| `broker.orders.place` | Mutation | Place order — requires `channel` input (`"ai-live"` \| `"ai-paper"` \| `"my-live"` \| `"my-paper"` \| `"testing-live"` \| `"testing-sandbox"`) |
| `broker.orders.modify` | Mutation | Modify order — requires `channel` input |
| `broker.orders.cancel` | Mutation | Cancel order — requires `channel` input |
| `broker.orders.list` | Query | Order book — requires `channel` input |
| `broker.orders.exitAll` | Mutation | Exit all positions — requires `channel` input |
| `broker.positions` | Query | Current positions — requires `channel` input |
| `broker.margin` | Query | Margin / fund info — requires `channel` input |
| `broker.killSwitch` | Mutation | Activate / deactivate kill switch — requires `workspace` input (`"ai"` \| `"my"` \| `"testing"`) and `action` (`"ACTIVATE"` \| `"DEACTIVATE"`) |
| `broker.feed.subscribe` | Mutation | Subscribe instruments to WS feed |
| `broker.feed.unsubscribe` | Mutation | Unsubscribe instruments |
| `broker.feed.state` | Query | Subscription registry + WS status |
| `broker.feed.resolveInstruments` | Query | Resolve security IDs for 4 tracked underlyings |
| `broker.feed.getAllTicks` | Query | Latest tick snapshot for all subscribed instruments |
| `broker.feed.onTick` | SSE Subscription | Stream `TickData` events to frontend |
| `broker.feed.onOrderUpdate` | SSE Subscription | Stream order fill/status events to frontend |

---

## 8. Kill Switch

Kill switches are **per-workspace and independent**. Triggering the AI Trades kill switch has no effect on My Trades or Testing, and vice versa.

| Kill Switch | Blocks channel | Bypassed by |
|-------------|---------------|-------------|
| `aiKillSwitch` | `ai-live` only | — |
| `myKillSwitch` | `my-live` only | — |
| `testingKillSwitch` | `testing-live` only | — |

**Rules (apply to each kill switch independently):**
- `POST /api/broker/:channel/orders` and `PUT /api/broker/:channel/orders/:id` — blocked when that channel's kill switch is active (`HTTP 403 KILL_SWITCH_ACTIVE`)
- `DELETE /api/broker/:channel/orders/:id` and `POST /api/broker/:channel/exit-all` — **always bypass** kill switch; position closure must always be possible
- Paper channels (`ai-paper`, `my-paper`) and `testing-sandbox` are **never affected** by any kill switch
- Kill switch state is persisted to `user_settings` per workspace so it survives server restart

---

## 9. greeksPoller — Removed

`server/broker/adapters/dhan/greeksPoller.ts` is **deleted**.

Previously polled `POST /v2/optionchain` every 60 seconds for Greeks. This is removed because:
- TFA (`TickFeatureAgent_Spec_1.0.md`) explicitly excludes Greeks from its feature set (§2 Design Principles: "Avoid: Greeks, Implied Volatility models")
- TFA polls `GET /api/broker/option-chain` at its own 5-second cadence for OI, volume, and delta OI
- A BSA-internal 60-second poller duplicates the request at the wrong interval with the wrong owner

`DhanAdapter.connectFeed()` — the `greeksPoller.start()` call is removed.

---

## 10. Implementation Steps (Status)

All original steps (0.1–0.7) are complete as of v1.2. The v1.3 changes below are pending implementation.

| Step | Description | Status |
|------|-------------|--------|
| 0.1 | Broker Interface + Types + Service Core | ✅ Complete |
| 0.2 | Mock Adapter (Paper Trading) | ✅ Complete |
| 0.3 | tRPC + REST Endpoints | ✅ Complete |
| 0.4 | Dhan Adapter — Auth + Token Management | ✅ Complete |
| 0.5 | Dhan Adapter — Scrip Master + Option Chain | ✅ Complete |
| 0.6 | Dhan Adapter — Orders + Positions + Funds | ✅ Complete |
| 0.7 | Dhan Adapter — WebSocket + Feed Infrastructure | ✅ Complete |

---

## 11. Pending Implementation

### 11.1 Refactor `brokerService.ts` — Multi-Adapter State

**File:** `server/broker/brokerService.ts`

**Current state:** Single `activeAdapter: BrokerAdapter | null` — one adapter at a time.

**Required state:** Four named adapter slots, initialised at startup:

```typescript
interface BSAAdapters {
  dhanLive: DhanAdapter | null;       // brokerId: "dhan"         → ai-live, my-live, testing-live
  dhanSandbox: DhanAdapter | null;    // brokerId: "dhan-sandbox" → testing-sandbox
  mockAi: MockAdapter | null;         // brokerId: "mock-ai"      → ai-paper
  mockMy: MockAdapter | null;         // brokerId: "mock-my"      → my-paper
}
```

**`getAdapter(channel)` helper** — resolves channel string to the correct adapter instance:

```typescript
function getAdapter(channel: string): BrokerAdapter {
  switch (channel) {
    case "ai-live":
    case "my-live":
    case "testing-live":   return adapters.dhanLive ?? error("dhan not initialised");
    case "testing-sandbox": return adapters.dhanSandbox ?? error("dhan-sandbox not initialised");
    case "ai-paper":       return adapters.mockAi ?? error("mock-ai not initialised");
    case "my-paper":       return adapters.mockMy ?? error("mock-my not initialised");
    default: throw new Error(`Unknown channel: ${channel}`);
  }
}
```

**Startup sequence:**
1. Load all 4 `broker_configs` documents from MongoDB.
2. Instantiate `DhanAdapter("dhan")` → assign to `adapters.dhanLive` → call `connect()` (opens WS).
3. Instantiate `DhanAdapter("dhan-sandbox")` → assign to `adapters.dhanSandbox` → call `connect()` (token validation only — no WS).
4. Instantiate `MockAdapter("mock-ai")` → assign to `adapters.mockAi` → call `connect()` (no-op).
5. Instantiate `MockAdapter("mock-my")` → assign to `adapters.mockMy` → call `connect()` (no-op).

**Kill switch state** — replace single `killSwitchActive: boolean` with per-workspace flags, loaded from and persisted to `user_settings.tradingMode`:

```typescript
interface KillSwitchState {
  ai: boolean;
  my: boolean;
  testing: boolean;
}
```

**`_resetForTesting()` bug fix** — add `adapterMeta.clear()` alongside existing resets.

---

### 11.2 Delete greeksPoller

**File:** `server/broker/adapters/dhan/greeksPoller.ts`  
**Action:** Delete the file entirely.

**File:** `server/broker/adapters/dhan/index.ts` — `connectFeed()` method  
**Action:** Remove the `greeksPoller.start()` call. Remove any import of `greeksPoller`.

**Why:** TFA explicitly excludes Greeks from its feature set. TFA polls `GET /api/broker/option-chain` at its own 5-second cadence. A BSA-internal poller at 60 seconds duplicates work at the wrong interval.

---

### 11.3 Simplify SubscriptionManager

**File:** `server/broker/adapters/dhan/subscriptionManager.ts`

**Remove these methods entirely:**
- `setupATMWindow(config)` — BSA does not manage ATM windows
- `updateATM(newATM)` — same
- `rebalanceATMWindow()` — same
- `removeATMWindow(underlying)` — same
- `lockPositions(securityIds)` — not BSA's concern
- `unlockPositions(securityIds)` — same

**Remove associated types** from `server/broker/types.ts`:
- `ATMWindowConfig`
- Any types used exclusively by the above methods

**Retain:**
- Subscription registry — `Map<securityId, { exchange, mode }>` tracking all currently subscribed instruments
- Budget tracking — `totalSubscriptions` counter, guard against 5000 Dhan limit
- `subscribeManual(securityIds, mode)` — batch subscribe; deduplicates; rejects if budget exceeded
- `unsubscribeManual(securityIds)` — batch unsubscribe; removes from registry
- Re-subscribe all on WebSocket reconnect (existing behaviour — unchanged)
- `getSubscriptionState()` — returns `{ totalSubscriptions, maxSubscriptions, wsConnected, instruments }`

---

### 11.4 Fix `_resetForTesting()` Bug

**File:** `server/broker/brokerService.ts` — `_resetForTesting()` function

**Problem:** `adapterMeta` Map is not cleared on reset, causing stale adapter metadata to persist between tests.

**Fix:** Add `adapterMeta.clear()` inside `_resetForTesting()` alongside the existing `adapterFactories.clear()` and `activeAdapter = null` resets.

---

### 11.5 Add `GET /api/broker/token` Endpoint

**File:** `server/broker/brokerRoutes.ts`

**Endpoint:** `GET /api/broker/token`  
**Purpose:** Returns unmasked Dhan credentials so TFA can open its own direct Dhan WebSocket connection at startup.  
**Response:**
```json
{
  "success": true,
  "data": {
    "accessToken": "<full token>",
    "clientId": "<client id>",
    "status": "valid | expired | unknown"
  }
}
```
**Note:** This endpoint returns the raw access token. It is for internal Python AI Engine consumers only — not exposed to the browser frontend.

---

### 11.6 Add REST Feed Subscribe / Unsubscribe Endpoints

**File:** `server/broker/brokerRoutes.ts`

**Endpoint:** `POST /api/broker/feed/subscribe`  
**Purpose:** Allows Python consumers (non-TFA) to subscribe security IDs to BSA's Dhan WebSocket feed.  
**Request body:**
```json
{
  "instruments": [
    { "securityId": "1333", "exchange": "NSE_FNO" },
    { "securityId": "26000", "exchange": "IDX_I" }
  ],
  "mode": "full"
}
```
**`mode` values:** `"ltp"` | `"quote"` | `"full"` (default `"full"` — required for `bid_size` / `ask_size` in market depth)  
**Response:**
```json
{ "success": true, "subscribed": 2, "total": 48 }
```

**Endpoint:** `POST /api/broker/feed/unsubscribe`  
**Request body:**
```json
{
  "instruments": [
    { "securityId": "1333", "exchange": "NSE_FNO" }
  ]
}
```
**Response:**
```json
{ "success": true, "unsubscribed": 1, "total": 47 }
```

**Endpoint:** `GET /api/broker/feed/state`  
**Purpose:** Returns current subscription registry and WebSocket connection status.  
**Response:**
```json
{
  "success": true,
  "data": {
    "wsConnected": true,
    "totalSubscriptions": 47,
    "maxSubscriptions": 5000,
    "instruments": ["1333", "26000"]
  }
}
```

---

## 12. Dependencies

| Package | Purpose |
|---------|---------|
| `mongoose` | MongoDB ODM |
| `csv-parse` | Scrip master CSV parsing |
| `ws` | Dhan WebSocket connection |
