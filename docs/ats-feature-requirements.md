# Automatic Trading System (ATS) — Complete Feature & Requirements Reference

**Version:** 1.0  
**Date:** March 30, 2026  
**Project:** Automatic Trading System (Manus Project ID: Qiqjca5Lodf9Jn8ejWVfDH)  
**Repository:** github.com/xitloop-commits/ai-development (private)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [Completed Features (Tasks A–K + Features 0–1)](#3-completed-features)
4. [Pending Features (Features 3–24)](#4-pending-features)
5. [Python Pipeline Modules](#5-python-pipeline-modules)
6. [Key Design Decisions](#6-key-design-decisions)
7. [Priority & Dependency Map](#7-priority--dependency-map)

---

## 1. System Overview

The Automatic Trading System is a comprehensive trading dashboard and execution platform for Indian derivatives markets. It covers four instruments — **NIFTY 50**, **BANK NIFTY** (NSE), **CRUDE OIL**, and **NATURAL GAS** (MCX) — and provides real-time option chain analysis, AI-driven trade signals, automated and manual trade execution, a 250-day compounding Trading Desk, a full trading discipline engine, and a trade journal with P&L analytics.

The system operates in two parallel modes. The **"My Trades LIVE"** tab is where the user manually executes trades through the Dhan broker, guided by AI signals. The **"AI Trades PAPER"** tab runs fully automated paper trades using the AI decision engine and a mock broker adapter, allowing direct performance comparison between human and AI trading.

### Design Theme

The UI follows the **"Terminal Noir"** aesthetic — a dark, information-dense terminal inspired by Bloomberg Terminal and cyberpunk interfaces. The palette uses a near-black canvas (`#0A0E14`) with vivid signal colors: green for profit/bullish, red for loss/bearish, amber for warnings, and cyan for informational highlights. Typography uses **JetBrains Mono** for all data and numbers, and **Space Grotesk** for headings.

---

## 2. Technology Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19 (SPA) + Vite + Tailwind CSS 4 + shadcn/ui + wouter routing |
| **Backend** | Express 4 + tRPC 11 + Mongoose (MongoDB) + Drizzle ORM (MySQL/TiDB) |
| **Databases** | MongoDB Atlas (database: `100cr`) for all new data; MySQL/TiDB for legacy data |
| **Testing** | Vitest (263 tests passing as of last checkpoint) |
| **Python Pipeline** | 6 standalone modules for market data fetching, analysis, AI decisions, execution, and data pushing |
| **Broker** | Dhan API v2 (REST + WebSocket) via Broker Service abstraction layer |
| **Hosting** | Manus hosting (tradingdash-hzhdul7u.manus.space) |
| **Platform** | Desktop only (no mobile/responsive) |

---

## 3. Completed Features

### 3.1 Task A: Core Dashboard Layout ✅

The foundation of the UI: a Terminal Noir themed 3-column grid layout with a sticky StatusBar at the top showing four module heartbeats (FETCHER, ANALYZER, AI ENGINE, EXECUTOR), a collapsible left sidebar (Control Panel), a center area for instrument cards and data, and a collapsible right sidebar (Signals Feed + Alert History). The dashboard header displays a clock, date, market status (OPEN/CLOSED), and data mode (LIVE/DEMO).

### 3.2 Task B: Instrument Cards ✅

Each of the four instruments (NIFTY 50, BANK NIFTY, CRUDE OIL, NATURAL GAS) has a rich card with 10 sections:

1. **Header** — display name, last price, ATM strike, exchange/expiry/strikes count, market bias badge (BULLISH/BEARISH/RANGE_BOUND/NEUTRAL)
2. **Trade Direction Badge** — GO CALL / GO PUT / WAIT with confidence percentage
3. **AI Rationale** — 2-line text explaining the AI decision
4. **Trade Setup** — option type, strike, entry/target/SL, R:R ratio, delta, PRE-ENTRY CHECKLIST button
5. **S/R Strength Line** — horizontal bar chart (S5→ATM→R5) with OI bars, intraday change %, activity labels (Buyers/Sellers Entering/Exiting), trend arrows, BOUNCE/BREAKOUT badges, hover tooltips, legend
6. **OI Summary Row** — Call OI vs Put OI proportional bars, PCR ratio
7. **IV & Theta Row** — ATM IV% with CHEAP/FAIR/EXPENSIVE label, DTE, theta per day
8. **News Sentiment** — sentiment + strength + confidence bar + article count, event flags, expandable bull/bear score bar and top headlines
9. **Risk Flags** — warning/danger badges
10. **Scoring Factors** — collapsible weighted factor bars with contribution scores

### 3.3 Task C: Full-Stack Backend Integration ✅

Upgraded from a static frontend to a full tRPC + Express backend. Includes REST API data ingestion endpoints for Python modules to push data, an in-memory trading store for real-time data, and frontend fetching via tRPC with 3-second polling. A Python data pusher script bridges the Python analysis pipeline to the dashboard.

### 3.4 Task D: Browser Push Notifications & Sound Alerts ✅

A sound engine using Web Audio API with programmatic alert tones, a NotificationProvider React context managing permission state, settings, and alert queue, a useAlertMonitor hook detecting new signals, position changes, and module status changes, an AlertSettingsPanel in the Control Panel with toggles, volume, and DND mode, and an AlertHistory collapsible panel showing the last 20 alerts with timestamps.

### 3.5 Task E: Instrument Filter (Full Pipeline Control) ✅

Include/exclude instruments with localStorage persistence. Filter toggles in the Control Panel sync to the backend via tRPC mutation. All four Python modules (fetcher, analyzer, AI engine, executor) poll the dashboard for active instruments and skip disabled ones. The dashboard filters cards, signals, and positions based on active instruments.

### 3.6 Task F: Enhanced AI Decision Engine ✅

Weighted scoring across OI momentum, wall strength, IV, PCR trend, and theta risk. Breakout vs bounce prediction at S/R levels. Auto-calculation of ATM strike, target prices, stop loss, and risk:reward ratio. Trade setup output includes rationale and risk flags. Enhanced news coverage includes Gift Nifty pre-market, India VIX, US overnight moves (S&P/Nasdaq), India CPI/PMI, US banking contagion (for BANKNIFTY), DXY (for CRUDEOIL), European TTF (for NATURALGAS), and Russia/sanctions supply disruption. Event calendar entries for weekly expiry, India CPI monthly, India PMI monthly, and Baker Hughes rig count.

### 3.7 Task G: S/R Strength Line + Merged InstrumentCard ✅

The SRStrengthLine component was merged directly into the InstrumentCard, removing duplicated OI visualizations. The merged card shows a unified layout: trade signal + S/R strength line + compact OI summary.

### 3.8 Task H: BANKNIFTY Addition ✅

Added BANK NIFTY as the 4th instrument across all layers — server instrument configs, active instruments, mock data, and all Python modules (fetcher with security_id 25, analyzer, AI engine with strike step 100, execution module with lot size 30, and data pusher).

### 3.9 Task I: Trade Journal / P&L Tracker ✅

Full CRUD with database persistence (24-column schema). Server query helpers for create, update, close, list, and stats. tRPC endpoints with auth. P&L auto-calculation on trade close supporting both buy and sell types. Stats engine computing win rate, average R:R, max drawdown, and total P&L. Frontend page with new trade form, close trade form, trade list with filters (status, instrument), expandable trade details, and stats grid.

### 3.10 Task J: Market Holidays ✅

NSE and MCX trading and settlement holidays for 2026 with exchange tabs, session details, and settlement holiday tracking. Server endpoint and frontend component showing upcoming holidays.

### 3.11 Task K: Execution Module Fixes ✅

The execution module now reads both old and new AI format for backward compatibility. Paper trades use real option chain prices from fetcher data. Paper positions are tracked in-memory with real-time SL/TP monitoring. Paper trade entries and exits are pushed to the dashboard via REST API.

### 3.12 Feature 0: Broker Service + Token Management (6 Steps) ✅

A complete broker abstraction layer in `server/broker/` with the adapter pattern. This is the highest-priority infrastructure feature, merging the original Broker Service and Dhan Token Management features.

**Architecture:**
```
Frontend (React) → tRPC Procedures → Broker Service → Dhan Adapter → Dhan API/WS
Python Modules   → REST Endpoints  → Broker Service → Mock Adapter → In-Memory
```

**Step 0.1 — Core Interface + Types + Service + MongoDB Config (21 tests):**
The BrokerAdapter interface defines 21 methods across auth, orders, positions/funds, market data, real-time WebSocket, lifecycle, and emergency categories. The BrokerService singleton manages adapter registration, initialization, switching, kill switch, and status. The Mongoose `broker_configs` model stores per-broker configuration with full CRUD (create, read, update credentials/settings/connection, delete, set active).

**Step 0.2 — Mock Adapter / Paper Trading (34 tests):**
The MockAdapter implements the full BrokerAdapter interface with an in-memory order book. Orders are instantly filled at the provided price. Positions are tracked with P&L calculation (profit on exit, loss on exit). Virtual margin defaults to ₹5,00,000. The kill switch blocks all new orders and exits all positions. Supports order/trade book queries, modify/cancel rejection for filled orders, sample market data, order update callbacks, and full reset.

**Step 0.3 — tRPC + REST Endpoints (20 tests):**
12 tRPC procedures for the frontend (config, status, token, orders, positions, margin, killSwitch, exitAll, trades, scripMaster, expiryList, optionChain). 14 REST endpoints for Python modules (`/api/broker/*`). The MockAdapter is registered on server startup and wired into the appRouter.

**Step 0.4 — Dhan Adapter Auth + Token Management (20 tests):**
The DhanAdapter skeleton implements all 21 BrokerAdapter methods. Token validation uses Dhan `GET /v2/fundlimit`. Token expiry detection checks `updatedAt + expiresIn` vs now with a 1-hour buffer warning. Any Dhan 401 response automatically marks the token as expired in MongoDB. The `updateToken` flow validates the new token against Dhan, then persists to MongoDB. Connect/disconnect lifecycle management is included.

**Step 0.5 — Scrip Master + Option Chain (31 tests):**
Downloads and caches the scrip master CSV from Dhan (`api-scrip-master.csv`, 16-column compact format, auto-refresh every 12 hours). Security ID lookup by symbol + expiry + strike + optionType (case-insensitive). MCX nearest-month FUTCOM auto-resolution. Expiry list and option chain via Dhan API + scrip master cache. Seven additional REST endpoints for scrip master status, refresh, lookup, expiry list, MCX FUTCOM, and option chain.

**Step 0.6 — Orders + Positions + Funds (32 tests):**
Rate limiter enforcing 10 requests/second and 250 requests/minute for all Dhan API calls. Retry logic for transient network errors. Trading symbol parser supporting three Dhan formats (hyphenated, compact, space-separated). Configurable limit price offset for order placement. Bracket SL/TP calculation. P&L percentage on positions. All order, position, and trade mapping now parses the trading symbol for optionType, strike, and expiry.

### 3.13 Feature 1: MongoDB Setup & Connection ✅

Mongoose connection to MongoDB Atlas with retry logic, health checks (ping), and graceful shutdown. tRPC and REST health endpoints. Six vitest tests covering env, connect, ping, CRUD, health, and latency.

---

## 4. Pending Features

### Feature 3: Main Screen Layout & Navigation

This feature implements the single-screen command center shell, replacing the traditional multi-page navigation model.

| Requirement | Detail |
|-------------|--------|
| **Single-Screen Shell** | Four sticky layers: App Bar, Summary Bar, Trading Desk (center), Footer |
| **Side Drawers** | Left drawer for Instrument Cards (`Ctrl+[`), Right drawer for Signals & Alerts (`Ctrl+]`) |
| **Overlays** | Full-screen overlays for Discipline Dashboard (`Ctrl+D`), Journal (`Ctrl+J`), and Settings (`Ctrl+S`), dismissed with `Esc` |
| **App Bar** | Dhan API status, WebSocket status, Discipline status, Market status, and module heartbeats |
| **Footer** | Dhan API latency, WebSocket status, last tick, data mode, active challenge, discipline score (with 7-category tooltip), version |
| **Trading Desk** | Always visible in the center, full width |
| **Discipline Dashboard** | Read-only monitoring view shown as an overlay |
| **Settings** | Overlay with sidebar navigation (6 sections) |
| **Journal** | Overlay for trade journaling |

---

### Feature 4: Settings Page — Foundation

A comprehensive settings page with sidebar navigation and MongoDB persistence.

**Six sections:**

1. **Broker Config** — active broker dropdown, per-broker credentials display, connection status, token update button
2. **Order Execution** — order entry offset % (default 1% below LTP), SL % and TP %, order type (LIMIT/MARKET), product type (INTRADAY/BO)
3. **Discipline** — all 20+ discipline toggles and configurable parameters (see Feature 14–18 details below)
4. **Time Windows** — separate NSE and MCX time window config, no-trading first/last N minutes, lunch break pause
5. **Expiry Controls** — per-instrument expiry rules (block on expiry day, block N days before, reduce position size, warning banner, auto-exit, no carry to expiry)
6. **Charges** — charge rate overrides if needed

**Data storage:** MongoDB `user_settings` collection (per user, with history of changes for discipline settings). tRPC endpoints for get/update settings.

---

### Feature 5: Trading Desk — Core Table

The centerpiece of the system: a 250-day compounding challenge table.

**Table structure — 16 columns:**

| Column | Description |
|--------|-------------|
| Day | Day number (1–250) |
| Date | Calendar date |
| Trade Capital | Starting capital for the day |
| Target 5% | Daily target amount (5% of Trade Capital) |
| Proj Capital | Projected capital if target hit |
| Instrument | Color-coded instrument tag (NIFTY/BANKNIFTY/CRUDE/NATGAS) |
| Type | B CE, B PE (green/long), S CE, S PE (red/short) |
| Strike | Option strike price |
| Entry | Entry price |
| LTP | Last Traded Price (live for open trades, exit price for closed) |
| Qty | Quantity |
| P&L | Profit/Loss with inline exit button |
| Charges | Brokerage, STT, and fees per trade/day |
| Actual Capital | Realized capital after trades |
| Deviation | Difference from projected |
| Rating | Trophy, double trophy, gift, star, flag, or blank |

**Row types:**
- **Past days** — green tint, collapsed data, completed trades
- **Today** — yellow highlight, multiple trade sub-rows, live data
- **Future days** — dimmed, projected values based on 5% compounding
- **Gift days** — gold tint, auto-completed when excess profit covers multiple days
- **Multi-day** — star rating, day spans multiple calendar dates if target not met

**Rating system:**
- 🏆 Target hit (exactly 5% or close)
- 🏆🏆 Exceptional (≥10% profit)
- 🎁 Gift day (covered by previous day's excess)
- ⭐ Multi-day (took more than one calendar day)
- ⬜ Future (not yet reached)
- 🏁 Final day (Day 150)

**Summary bar:** Current Day, Capital, Profit (+%), Today's P&L + Exit All button, Target Remaining, Schedule

**Dual tabs:** "My Trades LIVE" and "AI Trades PAPER"

**Status badges:** ✓ TP (target profit hit), ✗ SL (stop loss hit), ✓ Partial (partial fill), OPEN (with animated pulse dot)

**Additional features:**
- Auto-scroll to current day on page load (smooth scroll animation)
- Floating "Jump to Today" button (appears when scrolled away, shows ↑/↓ Today)
- All Trading Desk data stored in MongoDB (`challenges` and `trades` collections)

---

### Feature 6: Trading Desk — Trade Input & Exit

Interactive trade management within the Trading Desk table.

| Requirement | Detail |
|-------------|--------|
| **New trade button** | Inline (+) button in the LTP column of the day summary row |
| **New trade input row** | Slides in above summary row with [B\|S] toggle + [CE\|PE] toggle, instrument dropdown, strike/entry/qty inputs, ✓/✗ confirm/cancel in P&L column |
| **Trade execution** | Via Broker Service (not Dhan directly) — limit order at configurable % below LTP |
| **Exit button** | Inline (x) next to P&L for each open trade — green if profit, red if loss |
| **Exit All** | (x) button as suffix on Today's P&L in summary bar — calls Broker Service exitAll() |
| **SL/TP** | Via Dhan bracket orders (settings-driven), Dhan handles triggers server-side |
| **Type column** | B/S prefix with color — B CE, B PE in green, S CE, S PE in red |
| **Instrument tags** | Color-coded badges per instrument |

---

### Feature 7: Real-Time Data — Dhan WebSocket

Live market data streaming from Dhan's WebSocket binary protocol.

| Requirement | Detail |
|-------------|--------|
| **WebSocket client** | Dhan WebSocket binary protocol implementation in the Broker Service Dhan adapter |
| **LTP subscription** | Subscribe to LTP for active instruments via Broker Service |
| **Frontend push** | Push every tick from Dhan WebSocket to the frontend via server WebSocket or SSE |
| **Closing price fallback** | Show last closing price when market is closed |
| **Trade timer** | Live running timer next to OPEN badge on open positions (e.g., "12m 34s") |
| **Risk indicator** | Colored dot per trade showing position size as % of capital — green (<5%), yellow (5–10%), red (>10%) |
| **Reconnection** | Auto-reconnect on disconnect with exponential backoff |

---

### Feature 8: Trade Execution via Broker Service

Order management through the Broker Service abstraction.

| Requirement | Detail |
|-------------|--------|
| **Limit orders** | Place at configurable % below current LTP (default 1%) |
| **Bracket orders** | SL/TP via Dhan bracket/cover order — Dhan handles triggers server-side |
| **Settings integration** | Order execution section in Settings page — offset %, SL %, TP %, other parameters |
| **Error handling** | Order failure alerts shown to user |
| **Partial fills** | Display partial quantity in the table |

---

### Feature 9: Charges System

Indian standard brokerage and regulatory charges with versioned rate tracking.

| Charge Type | Rate |
|-------------|------|
| **Brokerage** | ₹20/order flat (Dhan) |
| **STT** | 0.0625% sell side |
| **Exchange Transaction** | 0.053% (NSE) |
| **GST** | 18% on brokerage + exchange transaction |
| **SEBI** | 0.0001% |
| **Stamp Duty** | 0.003% buy side |

**Requirements:**
- MongoDB collection `charge_rates` with versioned records and effective dates (never overwritten)
- Seed initial Indian standard rates for Options; extensible schema for Futures and Equity
- Net P&L calculation engine: Gross P&L → deductions → Net P&L
- Each trade's charges calculated using rates active on that trade's date
- Daily auto-check for charge rate changes from reliable sources (Dhan charge page, NSE/BSE circulars)
- Alert notification when any charge rate changes (old rate → new rate, effective date, source)

---

### Feature 10: Net P&L Integration

Apply charges to all P&L displays throughout the system.

- Net P&L displayed everywhere: P&L column in Trading Desk, summary bar Profit, Today's P&L
- Hover/tooltip breakdown: Gross P&L → Brokerage → STT → Exchange → GST → SEBI → Stamp → Net P&L
- Summary bar shows net values with tooltip for gross breakdown

---

### Feature 11: Market Hours & Exchange Awareness

Exchange-specific trading hours and rules.

| Exchange | Pre-Open | Regular Session |
|----------|----------|-----------------|
| **NSE** | 9:00–9:15 AM IST | 9:15 AM – 3:30 PM IST |
| **MCX** | — | 9:00 AM – 11:30 PM IST |

**Requirements:**
- Discipline rules are instrument/exchange-aware (detect exchange from instrument)
- Time window blocks apply per exchange (NSE first 15 min = 9:15–9:30 AM, MCX first 15 min = 9:00–9:15 AM)
- LTP feed active only during respective market hours; show last closing price outside hours
- MCX trading day ends at 11:30 PM
- Overall day auto-close at 11:59 PM applies after both markets closed
- Daily loss limit is COMBINED across NSE + MCX (one shared limit)
- Max trades per day is COMBINED across NSE + MCX (one shared limit)
- Lunch break pause applies only during NSE hours (MCX has no lunch break)
- Settings page has separate time window config for NSE and MCX
- Helper functions: `isMarketOpen()`, `getMarketCloseTime()`, `isNearClose()`

---

### Feature 12: Day Transition & Capital Logic

Day lifecycle management for the 250-day challenge.

| Requirement | Detail |
|-------------|--------|
| **Manual day close** | User clicks to close the day |
| **Auto-close** | At 11:59 PM only if ALL positions closed AND realized profit ≥5% |
| **Day stays open** | If any position is still OPEN — regardless of profit or loss |
| **Multi-day support** | If target not met and positions closed, day carries forward to next calendar day |
| **Realized P&L only** | Only realized P&L counts toward day completion (unrealized excluded) |
| **Capital model** | Shared capital pool — all trades draw from the same capital, no per-trade locking |
| **Capital progression** | Trade Capital for new day = previous day's Actual Capital (realized only) |
| **Gift days** | When excess profit covers multiple 5% targets, subsequent days are auto-completed as "gift" days |
| **Rating assignment** | Based on day outcome (trophy, double trophy, gift, star, flag) |
| **Overnight Positions** | Discouraged but allowed. System alerts 15 min and 5 min before close. If not exited, position carries forward to next day. Day Index stays open. |
| **Auto-Close** | Configurable in Settings (default OFF). If ON, system auto-exits positions before market close. |

---

### Feature 13: Near Expiry Controls

Per-instrument expiry awareness and risk controls.

| Instrument | Expiry Schedule |
|------------|----------------|
| NIFTY 50 | Weekly (Thursday) |
| BANK NIFTY | Weekly (Wednesday) |
| CRUDE OIL | Monthly (19th) |
| NATURAL GAS | Monthly (25th) |

**Configurable settings (all per-instrument):**
- Block trading on expiry day (toggle, default OFF)
- Block trading N days before expiry (configurable, default 0)
- Near-expiry reduction — graduated linear reduction of max position size and max exposure (default: 3-day window for weekly, 7-day for monthly, max 50% reduction at expiry)
- Expiry day warning banner — amber "Expiry day — High theta decay & volatility" (toggle, default ON)
- Auto-exit before expiry — auto-close positions N minutes before expiry (configurable, default OFF)
- No carry to expiry — prevent holding overnight into expiry day (toggle, default ON)

---

### Feature 14: Discipline — Circuit Breaker & Loss Limits

| Rule | Default | Detail |
|------|---------|--------|
| **Daily Loss Limit** | 3% of capital | Block all trading when daily loss hits threshold. Red overlay screen: "Daily loss limit reached. Trading disabled until tomorrow." Combined across NSE + MCX. |
| **Max Consecutive Losses** | 3 losses | After N back-to-back losses, force cooldown (default 30 min). Resets after a winning trade. |

---

### Feature 15: Discipline — Trade Limits & Cooldowns

| Rule | Default | Detail |
|------|---------|--------|
| **Max Trades Per Day** | 5 trades/day | Disable new trade button after limit reached. Combined across NSE + MCX. |
| **Max Open Positions** | 3 simultaneous | Cannot open new trade until one is closed. |
| **Revenge Trade Cooldown** | 15 min | Mandatory cooldown after SL hit. (+) button shows countdown timer during cooldown. Configurable: 10/15/30 min. |
| **Loss Acknowledgment** | ON | Optional "I accept the loss" acknowledgment before cooldown starts. |

---

### Feature 16: Discipline — Time Windows

| Rule | Default | Detail |
|------|---------|--------|
| **No Trading First N Minutes** | 15 min | Disable trading during market open volatility. Per exchange: NSE 9:15–9:30 AM, MCX 9:00–9:15 AM. |
| **No Trading Last N Minutes** | 15 min | Disable trading during market close volatility. Per exchange: NSE 3:15–3:30 PM, MCX 11:15–11:30 PM. |
| **Lunch Break Pause** | OFF | Optional: disable trading 12:30–1:30 PM. Applies only during NSE hours (MCX has no lunch break). |

All time windows show an amber banner with countdown during blocked periods.

---

### Feature 17: Discipline — Pre-Trade Gate

An inline checklist that appears after clicking the confirm button on a new trade.

**Checks:**
1. Trend aligned with trade direction?
2. R:R ratio ≥ configurable minimum (default 1:1.5) — **blocks trade if below**
3. Position size within max % of capital (default 40%)
4. Total exposure within max % (default 80%)
5. Emotional state selector: Calm / Anxious / Revenge / FOMO — **blocks trade if Revenge or FOMO**
6. Plan aligned?
7. Checklist done?

The entire pre-trade gate can be toggled off in settings for experienced mode.

---

### Feature 18: Discipline — Position Size & Exposure

| Rule | Default | Detail |
|------|---------|--------|
| **Max Position Size** | 40% of capital | Reject order if qty × entry > max % of capital. Red warning + blocked confirm. |
| **Max Total Exposure** | 80% of capital | Block new trades if total open exposure > threshold. Exposure bar turns red. |

---

### Feature 19: Discipline — Journal & Weekly Review

| Rule | Default | Detail |
|------|---------|--------|
| **Trade Journal Enforcement** | ON | Require journal entry after every closed trade (why entered, why exited, lesson, emotional state). |
| **Journal Block** | 3 trades | Block next trade if 3+ trades not journaled. |
| **Weekly Performance Review** | ON | Mandatory review screen Monday 9:00 AM (last week stats, discipline score). |
| **Discipline Score Warning** | 70% | If discipline score < 70%, show warning and require acknowledgment. |
| **Red Week Reduction** | 3 weeks | If 3 consecutive red weeks, suggest reducing position size by 50%. |

---

### Feature 20: Discipline — Streaks & Dashboard

| Rule | Default | Detail |
|------|---------|--------|
| **Winning Streak Reminder** | 5+ days | Overconfidence reminder on extended winning streaks. |
| **Losing Streak Auto-Reduce** | 3+ days | Auto-reduce max position size by 50% on losing streaks. |
| **Discipline Score** | 0–100 | Weighted score based on rule adherence across all discipline categories. |
| **Violations Tracking** | — | Dashboard shows rules broken today with timestamps. |
| **Monthly Trend Chart** | — | Monthly discipline score trend visualization. |
| **P&L Correlation** | — | Overlay showing discipline score vs P&L to demonstrate that disciplined days = profitable days. |

---

### Feature 21: Keyboard Navigation & UI Polish

| Shortcut | Action |
|----------|--------|
| ↑ / ↓ | Move between rows in Trading Desk |
| N | Open new trade input |
| Esc | Cancel current action |
| Enter | Confirm current action |
| T | Jump to today's row |

All visual polish from mockups applied.

---

### Feature 22: AI Trades PAPER Tab

The second tab in the Trading Desk, running fully automated paper trades.

- Same table structure and principles as "My Trades LIVE" tab
- Trades executed automatically by the AI decision engine
- Paper trading via Mock adapter (Broker Service) — simulated, no real orders placed
- Separate P&L tracking and day progression from live trades
- Uses real option chain prices for realistic simulation
- Allows direct performance comparison: user vs AI

---

### Feature 23: Error Handling

| Scenario | Behavior |
|----------|----------|
| **Dhan API down** | Blocking alert preventing user from trading, status indicator in footer |
| **Partial fills** | Show partial quantity in the Trading Desk table |
| **Failed exit order** | Alert notification to user with retry option |

---

### Feature 24: Historical Data

- View historical daily data for the single 250-day challenge
- One challenge only — once 250 days are completed, the project is over
- Challenge summary stats (total P&L, win rate, discipline score, duration)

---

## 5. Python Pipeline Modules

Six standalone Python modules form the data analysis and execution pipeline. They run independently and communicate with the dashboard via REST API.

| Module | File | Purpose |
|--------|------|---------|
| **Option Chain Fetcher** | `dhan_option_chain_fetcher.py` | Downloads scrip master CSV, resolves MCX security IDs, fetches option chain data from Dhan API, polls dashboard for active instruments, saves JSON files |
| **Option Chain Analyzer** | `option_chain_analyzer.py` | Analyzes option chain data: OI distribution, PCR, max pain, S/R levels, wall strength, IV analysis. Captures opening OI snapshot at 9:15 AM for intraday tracking. |
| **AI Decision Engine** | `ai_decision_engine.py` | Weighted scoring across OI momentum, wall strength, IV, PCR trend, theta risk. Breakout vs bounce prediction. Auto-calculates ATM strike, target, SL, R:R. Enhanced news sentiment with multi-query targeted fetching, weighted keyword scoring, event calendar awareness. Outputs trade direction, setup, rationale, and risk flags. |
| **Execution Module** | `execution_module.py` | Reads AI decisions, manages paper/live trades. Paper trades use real option chain prices. In-memory position tracking with SL/TP monitoring. Pushes position updates to dashboard. Supports both enhanced and legacy AI format. |
| **Data Pusher** | `dashboard_data_pusher.py` | Bridges Python modules to the dashboard. Reads JSON output files and pushes data via REST API. Respects active instruments filter. |
| **Test Analyzer** | `test_analyzer.py` | Test harness for the option chain analyzer module. |

**Future migration (Feature 21 in task breakdown):** All Python modules will be updated to call the Broker Service REST endpoints instead of Dhan directly. Hardcoded tokens will be removed; credentials will be read from MongoDB via the Broker Service.

---

## 6. Key Design Decisions

These decisions are **locked** and should not be revisited without explicit user approval.

| Decision | Resolution |
|----------|-----------|
| Broker integration | Broker Service abstraction layer with adapter pattern (`server/broker/`) |
| Broker config storage | MongoDB `broker_configs` collection, no history tracking (simple overwrite) |
| Active broker for LIVE | Dhan adapter (first implementation) |
| Active broker for PAPER | Mock adapter (in-memory simulation) |
| Language split | Python (fetcher, analyzer, AI engine) + Node.js (dashboard + API + Broker Service) |
| Database | MongoDB Atlas for all new data; existing MySQL/TiDB untouched until user says to migrate |
| Trade execution | Via Broker Service → Dhan adapter → LIMIT order at configurable % below LTP (default 1%) |
| SL/TP handling | Dhan bracket orders (server-side triggers), not in-memory monitoring |
| Real-time data | Via Broker Service → Dhan WebSocket, every tick pushed to frontend |
| Day transition | Manual close; auto at 11:59 PM only if all positions closed + ≥5% realized profit |
| Capital model | Shared pool, realized P&L only, day stays open if any position open |
| Daily loss limit | Combined across NSE + MCX (one shared limit) |
| Max trades per day | Combined across NSE + MCX (one shared limit) |
| MCX day end | 11:30 PM (market close) |
| Discipline rules | All exchange/instrument-aware, all have on/off toggle in settings |
| P&L display | Net (after all charges), gross breakdown on hover tooltip |
| Responsive design | Desktop only for now |
| Type column | B (green) = long/buy, S (red) = short/sell |
| Overnight positions (D1) | Discouraged but allowed. Carries forward to next day. |
| Frontend and Python | Never call Dhan/broker directly — always through Broker Service |
| Switching broker | Flip `isActive` flag in MongoDB + restart adapter |
| Future brokers | Ready for Zerodha, Angel One, Upstox adapters (empty stubs) |

---

## 7. Priority & Dependency Map

### Priority Tiers

| Tier | Focus | Features |
|------|-------|----------|
| **P0** | Core Infrastructure | Features 0 ✅, 1 ✅, 3, 4, 5, 6, 7, 8 |
| **P1** | Essential Trading | Features 9, 10, 11, 12, 13 |
| **P2** | Discipline & Risk | Features 14, 15, 16, 17, 18 |
| **P3** | Enhancement & Polish | Features 19, 20, 21, 22, 23, 24 |

### Dependency Chain

```
Feature 0 (Broker Service) ✅
Feature 1 (MongoDB) ✅
  ├── Feature 3 (Navigation & Layout)
  │     └── Feature 4 (Settings Page)
  │           ├── Feature 11 (Market Hours)
  │           │     ├── Feature 13 (Near Expiry)
  │           │     └── Feature 16 (Time Windows)
  │           └── Feature 14 (Circuit Breaker)
  │                 ├── Feature 15 (Trade Limits)
  │                 └── Feature 17 (Pre-Trade Gate)
  ├── Feature 5 (Trading Desk Core)
  │     ├── Feature 6 (Trade Input & Exit) → needs Feature 0, Feature 9
  │     │     └── Feature 7 (Real-Time Data) → needs Feature 0
  │     │           └── Feature 8 (Trade Execution) → needs Feature 0
  │     ├── Feature 10 (Net P&L) → needs Feature 9
  │     ├── Feature 12 (Day Transition)
  │     └── Feature 21 (Keyboard Nav)
  ├── Feature 9 (Charges System)
  ├── Feature 18 (Position Size & Exposure)
  ├── Feature 19 (Journal & Weekly Review)
  ├── Feature 20 (Streaks & Dashboard)
  ├── Feature 22 (AI Paper Tab) → needs Feature 0, Feature 5
  ├── Feature 23 (Error Handling)
  └── Feature 24 (Historical Data)
```

### Test Summary

| Feature | Tests | Status |
|---------|-------|--------|
| Task A–K (legacy) | 99 | ✅ Passing |
| Feature 1 (MongoDB) | 6 | ✅ Passing |
| Feature 0, Step 0.1 | 21 | ✅ Passing |
| Feature 0, Step 0.2 | 34 | ✅ Passing |
| Feature 0, Step 0.3 | 20 | ✅ Passing |
| Feature 0, Step 0.4 | 20 | ✅ Passing |
| Feature 0, Step 0.5 | 31 | ✅ Passing |
| Feature 0, Step 0.6 | 32 | ✅ Passing |
| **Total** | **263** | **✅ All Passing** |

---

### Settings Page — Complete Parameter Reference

**Note:** The inline parameter list has been removed to maintain a single source of truth. 

Please refer to **`docs/specs/Settings_Spec_v1.1.md`** for the complete, authoritative list of all 39 configurable parameters, including their types, ranges, defaults, and per-rule toggles.

---

### Dhan API Integration Reference

**Base URL:** `https://api.dhan.co/v2`  
**Auth:** Header `access-token: <JWT>`

**Rate Limits:**

| Category | Limit |
|----------|-------|
| Order APIs | 10/sec, 250/min, 1000/hr, 7000/day |
| Data APIs | 5/sec, 100,000/day |
| Quote APIs | 1/sec, unlimited |
| Non Trading APIs | 20/sec, unlimited |
| Order modifications | Max 25/order |

**Implemented in Broker Service (Feature 0):**
- Token validation via `GET /v2/fundlimit`
- Orders: place, modify, cancel via `/v2/orders`
- Order book, trade book, single order status
- Positions via `GET /v2/positions`
- Funds/margin via `GET /v2/fund-limit`
- Kill switch via `POST /v2/killswitch`
- Scrip master CSV download and parsing
- Option chain expiry list and data

**Not yet implemented (deferred to Feature 7):**
- Live Market Feed WebSocket (binary protocol)
- Live Order Update WebSocket
- Market Quote single-shot LTP
- Historical data

**Important:** Order placement, modification, and cancellation require static IP whitelisting on Dhan's platform.

---

### Mockup Files Reference

| File | Description |
|------|-------------|
| `mockups/position-tracker-mockup/index.html` | Trading Desk table design with 16 columns, row types, summary bar |
| `mockups/discipline-mockup/index.html` | Discipline Engine standalone with 8 tabs |
| `mockups/position-tracker-discipline-mockup/index.html` | Integrated Trading Desk + all discipline rules (11 scenarios) |
| `mockups/instrument-card-mockup/index.html` | Instrument Card with all 10 sections |
