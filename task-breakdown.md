# Automatic Trading System — Task Breakdown

All tasks belong to the same Manus project. Each task is a separate conversation, independently testable. Every task reads `todo.md`, `implementation-plan.md`, and relevant mockups before starting.

---

## COMPLETED TASKS (Already Built)

### Task A: Core Dashboard Layout ✅
- Terminal Noir theme, 3-column grid layout
- StatusBar with 4 module heartbeats
- Left sidebar (Control Panel, collapsible)
- Right sidebar (Signals Feed + Alert History, collapsible)
- Dashboard header with clock, date, market status

### Task B: Instrument Cards ✅
- InstrumentCard components (NIFTY 50, BANK NIFTY, CRUDE OIL, NATURAL GAS)
- OI bar visualization
- S/R Strength Line (horizontal bar chart with intraday tracking)
- Trade signal, wall strength, breakout/bounce prediction
- Trade setup (entry/target/SL, R:R, delta, strike)
- News sentiment badges (expandable, weighted scoring, event flags)
- Pre-Entry Checklist (8 automated checks, manual overrides, GO/CAUTION/NO-GO)

### Task C: Full-Stack Backend Integration ✅
- Upgrade to tRPC + Express backend
- REST API data ingestion endpoints for Python modules
- In-memory trading store for real-time data
- Frontend fetches data via tRPC with 3-second polling
- Python data pusher script (bridge between Python modules and dashboard)

### Task D: Browser Push Notifications & Sound Alerts ✅
- Sound engine (Web Audio API, programmatic alert tones)
- NotificationProvider context (permission, settings, queue)
- useAlertMonitor hook (signals, positions, module status)
- AlertSettingsPanel in Control Panel
- AlertHistory collapsible panel (last 20 alerts)

### Task E: Instrument Filter (Option B Full Pipeline Control) ✅
- Include/exclude instruments with localStorage persistence
- Filter toggles in Control Panel
- Server-side active instruments store with REST + tRPC
- All 4 Python modules respect active instruments filter
- Dashboard filters cards, signals, positions based on active instruments

### Task F: Enhanced AI Decision Engine ✅
- Weighted scoring (OI momentum, wall strength, IV, PCR trend, theta risk)
- Breakout vs bounce prediction at S/R levels
- Auto-calculate ATM strike, target, SL, R:R
- Trade setup with rationale and risk flags
- Enhanced news: Gift Nifty, VIX, DXY, TTF, US banking, inflation, PMI

### Task G: S/R Strength Line + Merged InstrumentCard ✅
- S/R Strength Line UI component
- Merged into InstrumentCard (removed duplicated sections)
- Shared types for S/R intraday data

### Task H: BANKNIFTY Addition ✅
- Server instrument configs, active instruments, mock data
- Python modules updated (fetcher, analyzer, AI engine, data pusher)

### Task I: Trade Journal / P&L Tracker ✅
- Database schema (24 columns)
- Full CRUD with tRPC endpoints
- P&L auto-calculation, stats engine
- Frontend page with forms, filters, expandable details

### Task J: Market Holidays ✅
- NSE + MCX trading and settlement holidays for 2026
- Server endpoint, frontend component

### Task K: Execution Module Fixes ✅
- Reads both old and new AI format
- Paper trades use real option chain prices
- Paper positions tracked in-memory with real-time SL/TP monitoring
- Push paper trade entries/exits to dashboard

---

## NEW TASKS (To Be Implemented)

### Task 0: Master Plan & Specs (This Task) 🔵
**Status:** Active — brainstorming complete
**Scope:** All specs, mockups, todo.md, implementation plan, task breakdown
**Files:**
- `todo.md` — all requirements
- `implementation-plan.md` — 23-feature prioritized plan
- `broker-service-plan.md` — 11-step Broker Service plan
- `task-breakdown.md` — this file
- Mockups: position-tracker, discipline, integrated, instrument-card

---

### Task 1: MongoDB Setup & Connection
**Priority:** P0
**Depends on:** Nothing
**Scope:**
- Install mongoose, configure MongoDB connection in server
- Create connection module with health check
- Test connection, basic CRUD operations
- Vitest: connection test, read/write test
**Test independently:** Postman — `GET /api/health/mongodb`
**Reference:** `todo.md` lines 224-225

---

### Task 2: Broker Service + Dhan Adapter
**Priority:** P0
**Depends on:** Task 1 (MongoDB)
**Scope:** Full 11-step plan from `broker-service-plan.md`
- Step 1: Core module structure + MongoDB broker_configs
- Step 2: Auth & token management (expiry, refresh, 401 detection)
- Step 3: Scrip master download, cache, security ID lookup
- Step 4: Option chain APIs (expiry list + chain data)
- Step 5: Order management (place, modify, cancel, exit all)
- Step 6: Positions & funds (margin, holdings)
- Step 7: WebSocket — Live LTP streaming
- Step 8: WebSocket — Live order updates
- Step 9: Mock adapter (paper trading)
- Step 10: REST endpoints for Python modules
- Step 11: Kill switch (emergency stop)
**Test independently:** Full Postman collection for all 11 steps
**Reference:** `broker-service-plan.md`, `todo.md` lines 314-333

---

### Task 3: Settings Page Foundation
**Priority:** P0
**Depends on:** Task 1 (MongoDB), Task 2 (Broker Service for broker config section)
**Scope:**
- Settings page UI with sidebar navigation
- MongoDB collection: `user_settings` (per user)
- tRPC endpoints: get/update settings
- Sections: Order Execution, Broker Config, Discipline, Time Windows, Expiry Controls, Charges
- All toggles on/off for every discipline feature
- All configurable parameters with defaults
**Test independently:** Postman — `GET/PUT /api/settings`, UI visual check
**Reference:** `todo.md` lines 226-228, 266-287, 301, 312

---

### Task 4: Main Page Layout & Navigation
**Priority:** P0
**Depends on:** Task 3 (Settings page exists)
**Scope:**
- Top-level navigation tabs: Dashboard, Position Tracker, Discipline, Journal, Settings
- StatusBar redesign: add Dhan API status, WebSocket status, Discipline status, Market status
- Footer redesign: connection indicators, last tick, data mode, challenge progress, discipline score
- Page routing in App.tsx: /, /tracker, /discipline, /journal, /settings
- Position Tracker as separate full-width page
- Discipline Dashboard as separate page
- Journal integrated into top-level nav (already built)
**Test independently:** UI visual check, all routes accessible
**Reference:** `todo.md` lines 337-345

---

### Task 5: Charges System
**Priority:** P1
**Depends on:** Task 1 (MongoDB)
**Scope:**
- MongoDB collection: `charge_rates` (versioned with effective dates)
- Seed initial Indian standard rates (Brokerage, STT, Exchange, GST, SEBI, Stamp)
- Net P&L calculation engine (gross → deductions → net)
- Daily auto-check for rate changes (on app start)
- Alert notification on rate changes
- Designed for Options now, extensible for Futures & Equity
**Test independently:** Postman — `GET /api/charges/current`, `POST /api/charges/calculate`
**Reference:** `todo.md` lines 165-172

---

### Task 6: Position Tracker — Core Table
**Priority:** P1
**Depends on:** Task 1 (MongoDB), Task 4 (navigation + full-width page)
**Scope:**
- 150-day table with 15 columns
- Past days (green, collapsed), Today (yellow, live), Future (dimmed, projected)
- Summary bar: Day, Capital, Profit (+%), Today's P&L + Exit All, Target Remaining, Schedule
- Rating system (trophy, double trophy, gift, star, flag)
- Type column: B CE, B PE (green), S CE, S PE (red)
- Status badges: TP, SL, Partial, OPEN (pulse dot)
- Color-coded instrument tags
- Auto-scroll to current day
- Floating "Jump to Today" button
- Store all data in MongoDB
**Test independently:** UI visual check with mock data, compare to mockup
**Reference:** `todo.md` lines 142-161, mockup: `position-tracker-mockup/index.html`

---

### Task 7: Position Tracker — Trade Management
**Priority:** P1
**Depends on:** Task 2 (Broker Service), Task 5 (Charges), Task 6 (Core Table)
**Scope:**
- Inline (+) new trade button in LTP column
- New trade inline input row with [B|S] + [CE|PE] toggles
- Trade execution via Broker Service (limit order at configurable % below LTP)
- Inline (x) exit button next to P&L (green profit, red loss)
- Exit All (x) in summary bar
- SL/TP via Dhan bracket orders (settings-driven)
- Net P&L with charges tooltip on hover
**Test independently:** Place/exit trades via UI, verify in Dhan order book
**Reference:** `todo.md` lines 151-154, 183-186

---

### Task 8: Real-Time Data Feed
**Priority:** P1
**Depends on:** Task 2 (Broker Service WebSocket), Task 6 (Position Tracker table)
**Scope:**
- Live LTP from Dhan WebSocket → Position Tracker LTP column
- Real-time P&L update (net, with charges)
- Trade timer on open positions (live running timer next to OPEN badge)
- Risk indicator per trade (colored dot: green <5%, yellow 5-10%, red >10%)
- Show last closing price when market is closed
**Test independently:** Subscribe to instruments, verify tick updates in UI
**Reference:** `todo.md` lines 178-179, 190-192

---

### Task 9: Market Hours & Exchange Awareness
**Priority:** P1
**Depends on:** Task 3 (Settings), Task 2 (Broker Service)
**Scope:**
- NSE hours: 9:15 AM - 3:30 PM IST
- MCX hours: 9:00 AM - 11:30 PM IST
- Discipline rules are instrument/exchange-aware
- Time window blocks per exchange
- LTP feed active only during market hours
- Combined daily loss limit and max trades across exchanges
- Settings: separate time window config for NSE and MCX
**Test independently:** Verify time-based blocks apply correctly per exchange
**Reference:** `todo.md` lines 291-301

---

### Task 10: Day Transition & Capital Logic
**Priority:** P1
**Depends on:** Task 6 (Position Tracker), Task 7 (Trade Management)
**Scope:**
- Manual day close
- Auto-close at 11:59 PM only if all positions closed AND profit ≥5%
- Day stays open if any position is OPEN
- Multi-day support (day carries forward)
- Capital: shared pool, realized P&L only
- Gift days (excess profit covers multiple days)
- Rating assignment based on day outcome
- TBD: overnight positions impact (ask user)
**Test independently:** Simulate day close scenarios, verify capital progression
**Reference:** `todo.md` lines 196-207

---

### Task 11: Near Expiry Controls
**Priority:** P1
**Depends on:** Task 3 (Settings), Task 9 (Market Hours)
**Scope:**
- Detect expiry schedules per instrument (NIFTY Thu, BANKNIFTY Wed, CRUDE 19th, NATGAS 25th)
- Block trading on expiry day (toggle)
- Block trading N days before expiry
- Reduce max position size near expiry
- Expiry day warning banner
- Auto-exit before expiry
- No carry to expiry (prevent overnight into expiry day)
- All settings per instrument
**Test independently:** Simulate expiry day, verify blocks and warnings
**Reference:** `todo.md` lines 305-312

---

### Task 12: Discipline — Circuit Breaker & Loss Limits
**Priority:** P2
**Depends on:** Task 3 (Settings), Task 7 (Trade Management), Task 9 (Market Hours)
**Scope:**
- Daily loss limit — red overlay blocking screen at threshold (default 3%)
- Max consecutive losses — forced cooldown (default 3 losses → 30 min)
- Disable (+) button, show lock icon
- Summary bar shows circuit breaker status
- Reset at midnight
**Test independently:** Simulate losses, verify blocking overlay appears
**Reference:** `todo.md` lines 238-240, mockup: `position-tracker-discipline-mockup/index.html`

---

### Task 13: Discipline — Trade Limits & Cooldowns
**Priority:** P2
**Depends on:** Task 12 (Circuit Breaker foundation)
**Scope:**
- Max trades per day (default 5) — disable (+) button, show badge
- Max open positions (default 3) — disable (+) until one closed
- Revenge trade cooldown after SL hit (configurable: 10/15/30 min)
- Countdown timer on (+) button during cooldown
- "I accept the loss" acknowledgment (optional)
**Test independently:** Hit trade limits, verify blocks and timers
**Reference:** `todo.md` lines 241-245

---

### Task 14: Discipline — Time Windows & Position Size
**Priority:** P2
**Depends on:** Task 9 (Market Hours), Task 12 (Circuit Breaker)
**Scope:**
- No trading first N minutes (per exchange)
- No trading last N minutes (per exchange)
- Lunch break pause (NSE only, optional)
- Position size enforcement (max % per trade, default 10%)
- Max total exposure (default 30%)
- Amber banner during blocked windows
**Test independently:** Verify time blocks per exchange, size rejection
**Reference:** `todo.md` lines 246-250, 248-249

---

### Task 15: Discipline — Pre-Trade Gate
**Priority:** P2
**Depends on:** Task 7 (Trade Management)
**Scope:**
- Inline checklist below new trade input row
- Checks: trend aligned, R:R ratio, position size, exposure, emotional state
- Block trade if R:R < minimum (default 1:1.5)
- Emotional state selector (calm/anxious/revenge/FOMO)
- Can be toggled off in settings
**Test independently:** Open new trade, verify checklist appears, test blocking
**Reference:** `todo.md` lines 251-253

---

### Task 16: Discipline — Journal & Weekly Review
**Priority:** P3
**Depends on:** Task I (existing Journal), Task 12 (Discipline foundation)
**Scope:**
- Journal prompt after every closed trade (inline below trade row)
- Block trading if 3+ trades unjournaled
- Weekly review overlay on Monday morning
- Consecutive red weeks warning + auto-reduce suggestion
**Test independently:** Close trades without journaling, verify block
**Reference:** `todo.md` lines 254-258

---

### Task 17: Discipline — Streaks & Dashboard
**Priority:** P3
**Depends on:** Task 12 (Discipline foundation), Task 10 (Day logic)
**Scope:**
- Winning streak reminder (5+ days)
- Losing streak auto-reduce (3+ days, halve position size)
- Discipline score (0-100, weighted calculation)
- Violations tracking with timestamps
- Monthly trend chart
- P&L correlation overlay
**Test independently:** Simulate streaks, verify banners and score
**Reference:** `todo.md` lines 259-264

---

### Task 18: Keyboard Navigation & UI Polish
**Priority:** P3
**Depends on:** Task 6 (Position Tracker)
**Scope:**
- ↑/↓ row navigation with highlight
- N = new trade, Esc = cancel, Enter = confirm, T = jump to today
- All visual polish from mockups
**Test independently:** Keyboard interactions on Position Tracker
**Reference:** `todo.md` line 176

---

### Task 19: AI Trades PAPER Tab
**Priority:** P3
**Depends on:** Task 2 (Mock adapter), Task 6 (Position Tracker)
**Scope:**
- Same table structure as "My Trades LIVE"
- Paper trading via Mock adapter (simulated, real prices)
- Receives trades from AI Decision Engine
- Separate P&L tracking and day progression
**Test independently:** AI places paper trades, verify in PAPER tab
**Reference:** `todo.md` lines 211-214

---

### Task 20: Error Handling & Historical Data
**Priority:** P3
**Depends on:** Task 2 (Broker Service), Task 10 (Day logic)
**Scope:**
- Dhan API down: blocking alert + footer indicator
- Partial fills display
- Failed exit alerts
- View past completed 150-day challenges
- One active challenge at a time
**Test independently:** Simulate API failures, verify alerts
**Reference:** `todo.md` lines 218-220, 232-233

---

### Task 21: Python Module Migration to Broker Service
**Priority:** P3
**Depends on:** Task 2 (Broker Service REST endpoints)
**Scope:**
- Update `execution_module.py` to call Broker Service REST instead of Dhan directly
- Update `option_chain_fetcher.py` to call Broker Service for option chain + scrip master
- Remove hardcoded Dhan tokens from all Python files
- All Python modules read credentials from Broker Service
**Test independently:** Run Python modules, verify they use Broker Service
**Reference:** `todo.md` lines 138-139, 328, 331

---

## Pending User Decisions

| Item | Status | When to ask |
|---|---|---|
| D1: Overnight positions / unrealized P&L impact | TBD | Before Task 10 |
| MongoDB connection string | TBD | Before Task 1 |
| Dhan API credentials | TBD | Before Task 2 |

---

## Priority Summary

| Priority | Tasks | Description |
|---|---|---|
| **P0** | 1, 2, 3, 4 | Foundation — MongoDB, Broker Service, Settings, Navigation |
| **P1** | 5, 6, 7, 8, 9, 10, 11 | Core Trading — Charges, Position Tracker, Real-Time, Day Logic |
| **P2** | 12, 13, 14, 15 | Discipline — Blocking rules, limits, gates |
| **P3** | 16, 17, 18, 19, 20, 21 | Enhancement — Journal, streaks, polish, AI paper, migration |
