# Implementation Plan — Automatic Trading System

**Approach:** Feature-by-feature. Each feature is implemented, tested (vitest), checkpointed, and reviewed before moving to the next.

**Total Features:** 24

---

## Priority Tiers

| Tier | Focus | Features |
|---|---|---|
| **P0** | Core Infrastructure & Trading | Features 0–8 |
| **P1** | Essential Day-to-Day Trading | Features 9–13 |
| **P2** | Discipline & Risk Management | Features 14–18 |
| **P3** | Enhancement & Polish | Features 19–24 |

---

## P0 — Core Infrastructure & Trading

### Feature 0: Broker Service — Abstraction Layer ⭐ HIGHEST PRIORITY

**Architecture:** Internal module in backend (`server/broker/`) with clean interface boundary, designed for future extraction to microservice.

**Unified Interface (contract):**
- `placeOrder(params)` → orderId, status
- `exitOrder(orderId)` → status
- `exitAll()` → results[]
- `modifyOrder(orderId, params)` → status
- `placeBracketOrder(params)` → orderId, status (with SL/TP)
- `getPositions()` → positions[]
- `getOrderStatus(orderId)` → order details
- `getOrderHistory(dateRange)` → orders[]
- `getMargin()` → available, used, total
- `getScripMaster(exchange)` → instruments[]
- `validateToken()` → valid/expired
- `refreshToken(newToken)` → status
- `subscribeLTP(instruments)` → stream
- `onOrderUpdate(callback)` → stream
- `onPositionUpdate(callback)` → stream
- `disconnect()` → clean shutdown

**Adapters:**
- Dhan adapter: REST API + WebSocket + scrip master
- Mock adapter: in-memory paper trading simulation
- Future stubs: Zerodha, Angel One, Upstox (empty)

**MongoDB:** `broker_configs` collection — per-broker config (credentials, settings, connection status, capabilities). No history tracking.

**Endpoints:**
- tRPC endpoints for frontend
- REST endpoints for Python modules
- Settings page integration (active broker dropdown, credentials, status)

**Vitest:** adapter interface compliance, mock adapter tests, config CRUD

---

### Feature 1: MongoDB Setup & Connection

- Install MongoDB driver (mongoose)
- Create MongoDB connection module in server
- Test connection, basic CRUD operations
- **Vitest:** connection test, read/write test

---

### Feature 2: Dhan Access Token Management

- Integrated into Broker Service (Dhan adapter credentials)
- On app start: check token age from `broker_configs` — if <24h use stored, if ≥24h show blocking popup
- Mid-day expiry: 401 detection → same popup
- Python modules call Broker Service instead of Dhan directly
- Auto-reconnect after token update
- **Vitest:** token CRUD, expiry logic, 401 handling

---

### Feature 3: Main Page Layout & Navigation

- Top-level navigation tabs below StatusBar: Dashboard, Position Tracker, Discipline, Journal, Settings
- StatusBar redesign: add Dhan API status, WebSocket status, Discipline status, Market status
- Footer redesign: Dhan API + latency, WebSocket status, last tick, data mode, active challenge, discipline score, version
- Page routing: /, /tracker, /discipline, /journal, /settings
- Position Tracker as separate full-width page
- Discipline Dashboard as separate page
- Settings as separate page with sidebar navigation
- **Vitest:** route rendering, navigation state

---

### Feature 4: Settings Page — Foundation

- Settings page UI with sidebar navigation
- Sections: Broker Config, Order Execution, Discipline, Time Windows, Expiry Controls, Charges
- MongoDB: reads/writes to `broker_configs` and `user_settings`
- tRPC endpoints: get/update settings
- **Vitest:** settings CRUD

---

### Feature 5: Position Tracker — Core Table (Static)

- 150-day table with 15 columns
- Past/today/future day rows with visual distinction
- Gift days, multi-day, rating system
- Summary bar: Day, Capital, Profit, Today's P&L + Exit All, Target Remaining, Schedule
- Dual tabs: "My Trades LIVE" / "AI Trades PAPER"
- Auto-scroll to current day + floating "Jump to Today"
- MongoDB collections: `challenges`, `trades`
- **Vitest:** table data calculation, rating logic, capital projection

---

### Feature 6: Position Tracker — Trade Input & Exit

- Inline (+) new trade button, inline input row with [B|S] + [CE|PE] toggles
- Inline (x) exit, Exit All — calls Broker Service (not Dhan directly)
- Type column: B/S prefix (green/red), status badges
- Color-coded instrument tags
- **Vitest:** trade creation, exit logic, status transitions

---

### Feature 7: Real-Time Data — Dhan WebSocket

- Broker Service Dhan adapter: WebSocket client (per Dhan docs)
- Subscribe to LTP for active instruments via Broker Service
- Push every tick to frontend via server WebSocket
- Show last closing price when market closed
- Trade timer on open positions
- Risk indicator dots per trade
- **Vitest:** WebSocket message parsing, LTP update logic

---

### Feature 8: Trade Execution via Broker Service

- Place limit order at configurable % below LTP (default 1%) — via Broker Service
- SL/TP bracket/cover order — via Broker Service
- Settings page: order execution section
- Error handling: order failure alerts
- Partial fills display
- **Vitest:** order construction, error handling (mocked adapter)

---

## P1 — Essential Day-to-Day Trading

### Feature 9: Charges System

- MongoDB collection: `charge_rates` (versioned with effective dates)
- Seed Indian standard rates
- Net P&L calculation engine
- Daily auto-check for rate changes + alert
- Settings page: charges section
- **Vitest:** charge calculation accuracy, rate versioning

---

### Feature 10: Net P&L Integration

- Apply charges to every trade's P&L
- Hover tooltip breakdown: Gross → charges → Net
- Summary bar shows net values with tooltip
- **Vitest:** tooltip data accuracy, end-to-end net P&L

---

### Feature 11: Market Hours & Exchange Awareness

- NSE (9:15 AM - 3:30 PM) and MCX (9:00 AM - 11:30 PM) hours
- Exchange detection from instrument
- Helper functions: isMarketOpen, getMarketCloseTime, isNearClose
- Settings page: separate NSE/MCX config
- **Vitest:** market hours logic, exchange detection

---

### Feature 12: Day Transition & Capital Logic

- Manual day close, auto-close at 11:59 PM (all closed + ≥5%)
- Day stays open if any position open
- Multi-day carry forward
- Shared capital pool, realized P&L only
- **TBD:** overnight positions impact (ask user)
- **Vitest:** day close conditions, capital progression

---

### Feature 13: Near Expiry Controls

- Detect expiry schedules per instrument
- Block/warn/reduce near expiry (all configurable)
- Auto-exit before expiry, no carry to expiry
- Settings page: per-instrument expiry toggles
- **Vitest:** expiry detection, per-instrument rules

---

## P2 — Discipline & Risk Management

### Feature 14: Discipline — Circuit Breaker & Loss Limits

- Daily loss limit (default 3%, combined NSE+MCX)
- Red overlay blocking screen
- Max consecutive losses cooldown
- All settings have on/off toggle
- **Vitest:** loss calculation, threshold detection

---

### Feature 15: Discipline — Trade Limits & Cooldowns

- Max trades/day (default 5, combined), max open positions (default 3)
- Revenge trade cooldown + "I accept the loss"
- Trades badge + exposure bar in summary bar
- All settings have on/off toggle
- **Vitest:** counter logic, cooldown timer, exposure

---

### Feature 16: Discipline — Time Windows

- No trading first/last N minutes (per exchange: NSE/MCX)
- Lunch break pause (NSE only)
- Banner with countdown during blocked windows
- All settings have on/off toggle
- **Vitest:** time window logic, per-exchange rules

---

### Feature 17: Discipline — Pre-Trade Gate

- Inline checklist after clicking ✓
- R:R check, position size, exposure, emotional state
- Block if R:R < minimum or emotional = Revenge/FOMO
- Toggleable from settings
- **Vitest:** gate pass/fail, R:R validation

---

### Feature 18: Discipline — Position Size & Exposure

- Max position size % (default 10%)
- Max total exposure % (default 30%)
- Red warning + blocked confirm when exceeded
- Exposure bar turns red
- **Vitest:** size calculation, exposure limits

---

## P3 — Enhancement & Polish

### Feature 19: Discipline — Journal & Weekly Review

- Inline journal prompt after closed trades
- Block trading if 3+ unjournaled
- Weekly review overlay on Monday
- 3 consecutive red weeks → suggest reduction
- **Vitest:** journal enforcement, weekly trigger

---

### Feature 20: Discipline — Streaks & Dashboard

- Winning streak reminder (5+ days)
- Losing streak auto-reduce (3+ days)
- Discipline score 0-100
- Violations, monthly trend, P&L correlation
- **Vitest:** score calculation, streak detection

---

### Feature 21: Keyboard Navigation & UI Polish

- ↑/↓ rows, N new trade, Esc cancel, Enter confirm, T jump to today
- All visual polish from mockups
- **Vitest:** keyboard event handling

---

### Feature 22: AI Trades PAPER Tab

- Same table structure, paper trading via Mock adapter (Broker Service)
- Receives trades from AI Decision Engine
- Separate P&L and day progression
- **Vitest:** paper trade flow, separation from live

---

### Feature 23: Error Handling

- Dhan API down: blocking alert + footer indicator (via Broker Service connection status)
- Partial fills, failed exits
- **Vitest:** error states

---

### Feature 24: Historical Data

- View past completed 150-day challenges
- One active challenge at a time
- Challenge archive with summary stats
- **Vitest:** historical data retrieval

---

## Key Design Decisions (Locked)

| Decision | Resolution |
|---|---|
| Broker integration | Broker Service abstraction layer with adapter pattern |
| Broker config storage | MongoDB `broker_configs` collection, no history tracking |
| Active broker for LIVE | Dhan adapter (first implementation) |
| Active broker for PAPER | Mock adapter (in-memory simulation) |
| Language split | Python (fetcher, analyzer, AI engine) + Node.js (dashboard + API + Broker Service) |
| Database | MongoDB for all new data; existing MySQL untouched until migration |
| Trade execution | Via Broker Service → Dhan adapter → limit order at 1% below LTP |
| Real-time data | Via Broker Service → Dhan WebSocket, every tick |
| Day transition | Manual close; auto at 11:59 PM only if all closed + ≥5% profit |
| Capital model | Shared pool, realized P&L only, day stays open if any position open |
| Loss limit | Combined across NSE + MCX |
| Max trades | Combined across NSE + MCX |
| MCX day end | 11:30 PM (market close) |
| Discipline rules | All exchange/instrument-aware, all have on/off toggle |
| P&L display | Net (after all charges), gross breakdown on hover tooltip |
| Responsive | Desktop only for now |
| Type column | B (green) = long, S (red) = short |
| D1 (overnight) | TBD — ask user before implementing |

---

## Mockup Files

| File | Description |
|---|---|
| `/home/ubuntu/position-tracker-mockup/index.html` | Position Tracker table design |
| `/home/ubuntu/discipline-mockup/index.html` | Discipline Engine standalone (8 tabs) |
| `/home/ubuntu/position-tracker-discipline-mockup/index.html` | Integrated: Position Tracker + all discipline rules (11 scenarios) |
| `/home/ubuntu/instrument-card-mockup/index.html` | Instrument Card with all 10 sections |
