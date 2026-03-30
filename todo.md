# Project TODO

- [x] Basic Terminal Noir dashboard layout
- [x] StatusBar with 4 module heartbeats
- [x] InstrumentCard components (Nifty 50, Crude Oil, Natural Gas)
- [x] Live Signals Feed component
- [x] Position Tracker component
- [x] Control Panel with trading mode toggle
- [x] OI bar visualization and polish
- [x] Upgrade to full-stack project with backend server and database
- [x] Create tRPC API endpoints to serve live trading data
- [x] Create REST API data ingestion endpoints for Python modules to push data
- [x] Create in-memory trading store for real-time data
- [x] Update frontend InstrumentCard to fetch real-time data via tRPC
- [x] Update frontend SignalsFeed to fetch real-time signals via tRPC
- [x] Update frontend PositionTracker to fetch real-time positions via tRPC
- [x] Update frontend StatusBar to show real module health status
- [x] Update frontend ControlPanel to control trading mode via API
- [x] Add 3-second polling for real-time data refresh
- [x] Write vitest tests for trading store (18 tests passing)
- [x] Test full data pipeline: REST push -> Store -> tRPC -> React
- [x] Create Python data pusher script for bridging Python modules to dashboard
- [x] Save checkpoint and deliver integrated dashboard
- [x] Sound engine using Web Audio API (programmatic alert tones)
- [x] NotificationProvider React context (permission state, settings, alert queue)
- [x] useAlertMonitor hook (detect new signals, position changes, module status)
- [x] AlertSettingsPanel UI in Control Panel (toggles, volume, DND mode)
- [x] AlertHistory collapsible panel (last 20 alerts with timestamps)
- [x] Integrate alert system into Dashboard page
- [x] Write vitest tests for alert utilities (13 tests passing)
- [x] Save checkpoint for Browser Push Notifications & Sound Alerts
- [x] Instrument filter context (include/exclude instruments with localStorage persistence)
- [x] Instrument filter toggle UI in Control Panel
- [x] Dashboard filters instrument cards, signals, and positions based on active instruments
- [x] Server-side active instruments store with GET/SET REST + tRPC endpoints
- [x] Sync frontend instrument filter toggles to backend via tRPC mutation
- [x] Update dhan_option_chain_fetcher.py to poll active instruments and skip disabled
- [x] Update option_chain_analyzer.py to poll active instruments and skip disabled
- [x] Update ai_decision_engine.py to poll active instruments and skip disabled
- [x] Update execution_module.py to poll active instruments and skip disabled
- [x] Update dashboard_data_pusher.py to respect active instruments
- [x] Write vitest tests for active instruments endpoints (13 tests passing)
- [x] Save checkpoint for Option B Full Pipeline Control
- [x] Fix: Fetcher ignores active instruments filter (was missing DASHBOARD_URL env var)
- [x] Fix: CRUDEOIL security_id 472789 expired — now auto-resolved from scrip master
- [x] Update Dhan access token in all Python modules
- [x] Auto-detect CRUDEOIL/NATURALGAS security_ids from Dhan scrip master CSV at startup
- [x] Fix: UI instrument filter toggle not syncing — trailing space in DASHBOARD_URL env var, added .strip() to all modules
- [x] Enhanced AI engine: weighted scoring (OI momentum, wall strength, IV, PCR trend, theta risk)
- [x] Enhanced AI engine: breakout vs bounce prediction at support/resistance levels
- [x] Enhanced AI engine: auto-calculate ATM strike, target prices, stop loss, risk:reward
- [x] Enhanced AI engine: trade setup with rationale and risk flags
- [x] Server-side: update shared types and data processing for enhanced AI fields
- [x] Enhance existing instrument cards with trade signal, wall strength, breakout/bounce, trade setup
- [x] Write vitest tests for enhanced AI decision data (11 tests passing)
- [x] Save checkpoint for enhanced instrument cards + AI engine
- [ ] Python analyzer: capture opening OI snapshot at 9:15 AM for intraday S/R tracking
- [ ] Python analyzer: compute intraday OI change, wall strength, activity labels at each S/R level
- [ ] Python AI engine: output S/R activity labels (Buyers/Sellers Entering/Exiting)
- [x] Shared types: add S/R intraday data types (SRLevel, SRData, activity labels)
- [x] Server store: process and pass through S/R intraday data
- [x] SRStrengthLine UI component (horizontal bar chart with intraday tracking)
- [ ] PreEntryChecklist interactive overlay (step-by-step GO/NO-GO walkthrough)
- [x] Integrate S/R line into instrument cards (merged, removed duplicated sections)
- [x] Write vitest tests for S/R data (9 tests passing)
- [ ] Save checkpoint for S/R Strength Line + Pre-Entry Checklist
- [x] Fix: Execution module reads both old and new AI format
- [x] Fix: Paper trades use real option chain prices from fetcher data
- [x] Fix: Paper positions tracked in-memory with real-time SL/TP monitoring
- [x] Push paper trade entries/exits to dashboard via REST API
- [x] Dashboard server: already accepts position data via existing REST endpoint
- [x] Save checkpoint for execution module fix
- [x] Left sidebar: collapse/expand toggle (shrink to icons-only, expand to full width)
- [x] Right sidebar (Signals Feed): collapse/expand toggle
- [x] Save checkpoint for sidebar collapse/expand feature
- [x] Audit InstrumentCard for data overlap with S/R line design
- [x] Merge S/R Strength Line into InstrumentCard (remove duplicated visualizations)
- [ ] Update Python analyzer to output S/R intraday data (opening OI snapshot, wall strength, activity labels)
- [x] Update shared types and server store for S/R level data
- [x] Redesign InstrumentCard with unified layout: trade signal + S/R line + compact OI
- [x] Write vitest tests for merged card data (9 tests passing)
- [x] Save checkpoint for merged S/R + InstrumentCard
- [x] Add BANKNIFTY to server instrument configs (tradingStore.ts)
- [x] Add BANKNIFTY to active instruments list (tradingStore.ts)
- [x] Add BANKNIFTY mock data (mockData.ts)
- [x] Update Python modules: fetcher, analyzer, AI engine, data pusher for BANKNIFTY
- [x] Update vitest tests for BANKNIFTY (64 tests passing)
- [x] Save checkpoint for BANKNIFTY instrument addition
- [x] Enhanced news: multi-query targeted fetching per instrument
- [x] Enhanced news: improved sentiment scoring with weighted keywords and context phrases
- [x] Enhanced news: event calendar awareness (RBI policy, OPEC, EIA inventory, US Fed, expiry days)
- [x] Enhanced news: instrument-specific sentiment keywords
- [x] Enhanced news: richer news_sentiment output (article scores, source, event flags)
- [x] Update shared types and server store for enhanced news sentiment data
- [x] Update frontend InstrumentCard to show enhanced news sentiment details
- [x] Market holidays: add NSE trading + settlement holidays for 2026
- [x] Market holidays: add MCX trading + settlement holidays for 2026
- [x] Market holidays: server endpoint to serve upcoming holidays
- [x] Market holidays: frontend component showing upcoming NSE/MCX holidays
- [x] Run vitest tests for enhanced news and holidays (77 tests passing)
- [x] Save checkpoint for enhanced news sentiment + market holidays
- [x] Feature 1: Pre-Entry Checklist — interactive step-by-step risk assessment overlay
- [x] Pre-Entry Checklist: 8 automated checks (S/R alignment, IV, theta, news, R:R, PCR, OI momentum, confidence)
- [x] Pre-Entry Checklist: manual override toggles for each check
- [x] Pre-Entry Checklist: overall readiness score (GO/CAUTION/NO-GO)
- [x] Pre-Entry Checklist: integrated into InstrumentCard with trigger button
- [x] Feature 2: Opening OI Snapshot — Python analyzer captures 9:15 AM OI for true intraday tracking
- [x] Opening OI Snapshot: compute_intraday_oi_analysis function with wall strength and activity labels
- [x] Opening OI Snapshot: sr_intraday_levels output with change_from_open and activity classification
- [x] Opening OI Snapshot: shared types (SRIntradayLevel) and server store mapping
- [x] Feature 4: Trade Journal / P&L Tracker — full CRUD with database persistence
- [x] Trade Journal: database schema (trade_journal table with 24 columns)
- [x] Trade Journal: server query helpers (create, update, close, list, stats)
- [x] Trade Journal: tRPC endpoints (create, close, update, list, stats) with auth
- [x] Trade Journal: P&L auto-calculation on trade close (supports buy and sell types)
- [x] Trade Journal: stats engine (win rate, avg R:R, max drawdown, total P&L)
- [x] Trade Journal: frontend page with new trade form, close trade form, trade list, stats grid
- [x] Trade Journal: filters (status, instrument) and expandable trade details
- [x] Trade Journal: linked from Dashboard header and App.tsx route
- [x] Write vitest tests for trade journal (22 tests, 99 total passing)
- [x] Save checkpoint for Pre-Entry Checklist + Opening OI Snapshot + Trade Journal
- [x] AI Engine: Add Gift Nifty pre-market direction query and keywords
- [x] AI Engine: Add India VIX fear/volatility query and keywords
- [x] AI Engine: Add US market overnight moves (S&P 500, Nasdaq, Wall Street) query
- [x] AI Engine: Add India CPI/WPI inflation and PMI data query and keywords
- [x] AI Engine: Add US banking contagion query for BANKNIFTY
- [x] AI Engine: Add US Dollar Index (DXY) query for CRUDEOIL
- [x] AI Engine: Add European gas TTF benchmark query for NATURALGAS
- [x] AI Engine: Add Russia/sanctions supply disruption query for CRUDEOIL
- [x] AI Engine: Add India VIX event calendar entries (weekly expiry, CPI, PMI, rig count)
- [x] Dashboard: Updated mock data with Gift Nifty, VIX, DXY, TTF, US banking articles
- [x] Run tests and save checkpoint for enhanced news coverage (99 tests passing)
- [x] Bug fix: AI engine crashes on empty analyzer JSON output (JSONDecodeError)
- [x] Bug fix: load_option_chain also crashes on empty JSON — fixed all unsafe json.load calls in ai_decision_engine.py and option_chain_analyzer.py
- [ ] Dhan Access Token Management: MongoDB collection (dhan_credentials) to store access_token, client_id, updated_at
- [ ] Dhan Access Token Management: On app start, check token age — if <24h use stored token, if ≥24h show blocking popup for new token
- [ ] Dhan Access Token Management: Mid-day expiry detection — if any Dhan API returns 401, show same popup immediately
- [ ] Dhan Access Token Management: Python modules read token from MongoDB instead of hardcoded values
- [ ] Dhan Access Token Management: After token update, all modules reconnect (WebSocket + API retry)

## Position Tracker — 150-Day Compounding Table

- [ ] Position Tracker: 150-day table with 15 columns (Day, Date, Open Capital, Target 5%, Proj Capital, Instrument, Type, Strike, Entry, LTP, Qty, P&L, Actual Capital, Deviation, Rating)
- [ ] Position Tracker: Past days rows (green tint, collapsed data, completed trades)
- [ ] Position Tracker: Today rows (yellow highlight, multiple trade sub-rows, live data)
- [ ] Position Tracker: Future days rows (dimmed, projected values)
- [ ] Position Tracker: Gift days (auto-completed when excess profit covers multiple days)
- [ ] Position Tracker: Multi-day support (star rating, day spans multiple calendar dates)
- [ ] Position Tracker: Rating system — 🏆 (target hit), 🏆🏆 (≥10% profit), 🎁 (gift), ⭐ (multi-day), ⬜ (future), 🏁 (final day)
- [ ] Position Tracker: Type column shows B/S prefix — B CE, B PE (green/long), S CE, S PE (red/short)
- [ ] Position Tracker: Inline (x) exit button next to P&L for open trades — green if profit, red if loss
- [ ] Position Tracker: Exit All (x) button as suffix on Today's P&L in summary bar
- [ ] Position Tracker: Inline (+) new trade button in LTP column of day summary row
- [ ] Position Tracker: New trade inline input row — slides in above summary row with [B|S] + [CE|PE] toggles, instrument dropdown, strike/entry/qty inputs, ✓/✗ in P&L column
- [ ] Position Tracker: Dual tabs — "My Trades LIVE" and "AI Trades PAPER"
- [ ] Position Tracker: Summary bar — Current Day, Capital, Profit (+%), Today's P&L + Exit All, Target Remaining, Schedule
- [ ] Position Tracker: Status badges — ✓ TP, ✗ SL, ✓ Partial, OPEN (with pulse dot)
- [ ] Position Tracker: Color-coded instrument tags (NIFTY 50, BANK NIFTY, CRUDE OIL, NAT GAS)
- [ ] Position Tracker: Column renamed "Curr/Exit" to "LTP"
- [ ] Position Tracker: Auto-scroll to current day on page load (smooth scroll animation)
- [ ] Position Tracker: Store all position tracker data in MongoDB

## Charges & Net Profit System

- [ ] Charges: Indian standard structure — Brokerage (₹20/order flat via Dhan), STT (0.0625% sell side), Exchange Txn (0.053% NSE), GST (18% on brokerage+exchange), SEBI (0.0001%), Stamp Duty (0.003% buy side)
- [ ] Charges: Net P&L displayed everywhere (P&L column, summary bar Profit, Today's P&L)
- [ ] Charges: Hover/tooltip breakdown on P&L — Gross P&L → Brokerage → STT → Exchange → GST → SEBI → Stamp → Net P&L
- [ ] Charges: Designed for Options now, extensible schema for Futures & Equity charge rates
- [ ] Charges: Daily auto-check for charge rate changes from reliable sources (Dhan charge page, NSE/BSE circulars)
- [ ] Charges: Alert notification when any charge rate changes (old rate → new rate, effective date, source)
- [ ] Charges: Charge rate history stored in MongoDB with effective dates (versioned, never overwritten)
- [ ] Charges: Each trade's charges calculated using rates active on that trade's date

## UI/UX Improvements

- [ ] UX: Keyboard navigation — ↑/↓ move between rows, N opens new trade, Esc cancels, Enter confirms, T jumps to today
- [ ] UX: Floating "Jump to Today" button — appears when scrolled away, shows ↑/↓ Today, smooth scroll back
- [ ] UX: Trade timer on open positions — live running timer next to OPEN badge (e.g., "12m 34s")
- [ ] UX: Risk indicator per trade — colored dot showing position size as % of capital (green <5%, yellow 5-10%, red >10%)

## Trade Execution Flow

- [ ] Execution: Place limit order at 1% below current LTP (configurable from settings page)
- [ ] Execution: SL/TP configuration in settings page
- [ ] Execution: Dhan handles SL/TP triggers (bracket/cover order)
- [ ] Execution: Settings page — order entry offset % (default 1%), SL %, TP %, and other trade parameters

## Real-Time Data Feed

- [ ] Real-Time: Implement Dhan WebSocket client for live LTP (per Dhan documentation)
- [ ] Real-Time: Push every tick from Dhan WebSocket to UI in real-time
- [ ] Real-Time: Show last closing price when market is closed

## Day Transition Logic

- [ ] Day Logic: Manual day close by user
- [ ] Day Logic: Auto-close at 11:59 PM only if ALL positions closed AND realized profit ≥5%
- [ ] Day Logic: Day remains open if any position is still OPEN — regardless of profit or loss
- [ ] Day Logic: Multi-day support — if target not met and positions closed, day carries forward to next calendar day
- [ ] Day Logic: Only realized P&L counts toward day completion (unrealized excluded)

## Capital Management

- [ ] Capital: Shared capital pool model — all trades draw from same capital, no per-trade locking
- [ ] Capital: Risk indicator shows each trade's % of total capital as visual safeguard
- [ ] Capital: Open Capital for new day = previous day's Actual Capital (realized only)
- [ ] Capital: TBD — overnight positions and unrealized P&L impact on capital (ask user before implementing)

## AI Trades PAPER Tab

- [ ] AI Paper: Same table structure and principles as "My Trades LIVE" tab
- [ ] AI Paper: Trades executed automatically by AI decision engine
- [ ] AI Paper: Paper trading — simulated, no real orders placed
- [ ] AI Paper: Separate P&L tracking and day progression from live trades

## Error Handling & Edge Cases

- [ ] Errors: Dhan API down — show blocking alert preventing user from trading, indicate status in footer
- [ ] Errors: Partial fills — show partial qty in the table
- [ ] Errors: Failed exit order — show alert to user

## General Requirements

- [ ] MongoDB: Set up MongoDB connection for all new data (charges, trades, credentials, position tracker)
- [ ] MongoDB: Existing MySQL/TiDB stays untouched until user says to migrate
- [ ] Settings: Configurable order entry offset % (default 1% below LTP)
- [ ] Settings: SL/TP configuration
- [ ] Settings: Charge rate overrides (if needed)
- [ ] Architecture: Python modules stay in Python (fetcher, analyzer, AI engine, execution)
- [ ] Architecture: Node.js dashboard + API layer
- [ ] Architecture: Replace REST polling with WebSocket push (Python → Node.js) for lower latency
- [ ] Historical: View completed past 150-day challenges
- [ ] Historical: One active challenge at a time
- [ ] Desktop only: No mobile/responsive for now

## Trading Discipline Engine

- [ ] Discipline: Daily Loss Limit (Circuit Breaker) — block all trading when daily loss hits threshold (default 3% of capital)
- [ ] Discipline: Daily Loss Limit — red overlay screen "Daily loss limit reached. Trading disabled until tomorrow."
- [ ] Discipline: Max Consecutive Losses — after N back-to-back losses (default 3), force cooldown (default 30 min)
- [ ] Discipline: Max Trades Per Day — disable new trade button after limit reached (default 5 trades/day)
- [ ] Discipline: Max Open Positions — cannot open new trade until one is closed (default 3 simultaneous)
- [ ] Discipline: Revenge Trade Prevention — mandatory cooldown after SL hit (configurable: 10/15/30 min)
- [ ] Discipline: Revenge Trade Cooldown — (+) button shows countdown timer during cooldown
- [ ] Discipline: Optional "I accept the loss" acknowledgment before cooldown starts
- [ ] Discipline: Position Size Enforcement — reject order if qty × entry > max % of capital (default 10%)
- [ ] Discipline: Max Total Exposure — block new trades if total open exposure > threshold (default 30% of capital)
- [ ] Discipline: No Trading First N Minutes — disable trading during market open volatility (default 9:15–9:30 AM)
- [ ] Discipline: No Trading Last N Minutes — disable trading during market close volatility (default 3:15–3:30 PM)
- [ ] Discipline: Optional Lunch Break Pause — disable trading 12:30–1:30 PM (off by default)
- [ ] Discipline: Pre-Trade Confirmation Gate — quick checklist before every trade (plan aligned? checklist done? R:R check? emotional check?)
- [ ] Discipline: Block trade if R:R ratio < configurable minimum (default 1:1.5)
- [ ] Discipline: Pre-Trade Gate can be toggled off in settings for experienced mode
- [ ] Discipline: Weekly Performance Review Gate — mandatory review screen Monday 9:00 AM (last week stats, discipline score)
- [ ] Discipline: If discipline score < 70%, show warning and require acknowledgment
- [ ] Discipline: If 3 consecutive red weeks, suggest reducing position size by 50%
- [ ] Discipline: Trade Journal Enforcement — require journal entry after every closed trade (why entered, why exited, lesson, emotional state)
- [ ] Discipline: Block next trade if 3+ trades not journaled
- [ ] Discipline: Streak Protection — overconfidence reminder on 5+ day winning streak
- [ ] Discipline: Streak Protection — auto-reduce max position size by 50% on 3+ day losing streak
- [ ] Discipline: Discipline Dashboard / Score — 0-100 score based on rule adherence (weighted)
- [ ] Discipline: Dashboard shows rules broken today with timestamps
- [ ] Discipline: Monthly discipline score trend chart
- [ ] Discipline: Correlation overlay — discipline score vs P&L to show disciplined days = profitable days

## Settings Page — Discipline Configuration

- [ ] Settings: Daily loss limit % (default 3%)
- [ ] Settings: Max consecutive losses before cooldown (default 3)
- [ ] Settings: Cooldown duration after consecutive losses (default 30 min)
- [ ] Settings: Max trades per day (default 5)
- [ ] Settings: Max open positions (default 3)
- [ ] Settings: Revenge trade cooldown duration (default 15 min, options: 10/15/30 min)
- [ ] Settings: Require "I accept the loss" acknowledgment (default on)
- [ ] Settings: Max position size % of capital (default 10%)
- [ ] Settings: Max total exposure % of capital (default 30%)
- [ ] Settings: No trading first N minutes after market open (default 15 min)
- [ ] Settings: No trading last N minutes before market close (default 15 min)
- [ ] Settings: Lunch break pause toggle (default off)
- [ ] Settings: Pre-trade confirmation gate toggle (default on)
- [ ] Settings: Minimum R:R ratio for trade approval (default 1:1.5)
- [ ] Settings: Weekly review gate toggle (default on)
- [ ] Settings: Trade journal enforcement toggle (default on)
- [ ] Settings: Max unjournaled trades before block (default 3)
- [ ] Settings: Winning streak reminder threshold (default 5 days)
- [ ] Settings: Losing streak auto-reduce threshold (default 3 days)
- [ ] Settings: Store all discipline settings in MongoDB (per user, with history of changes)

## Market Hours & Exchange Awareness

- [ ] Market Hours: NSE — Pre-open 9:00-9:15 AM, Regular 9:15 AM - 3:30 PM IST
- [ ] Market Hours: MCX — Regular 9:00 AM - 11:30 PM IST
- [ ] Market Hours: Discipline rules are instrument/exchange-aware (detect exchange from instrument)
- [ ] Market Hours: Time window blocks apply per exchange (NSE first 15 min = 9:15-9:30 AM, MCX first 15 min = 9:00-9:15 AM)
- [ ] Market Hours: LTP feed active only during respective market hours; show last closing price outside
- [ ] Market Hours: MCX trading day ends at 11:30 PM (market close)
- [ ] Market Hours: Overall day auto-close at 11:59 PM applies after both markets closed
- [ ] Market Hours: Daily loss limit is COMBINED across NSE + MCX (one shared limit)
- [ ] Market Hours: Max trades per day is COMBINED across NSE + MCX (one shared limit)
- [ ] Market Hours: Lunch break pause applies only during NSE hours (MCX has no lunch break)
- [ ] Market Hours: Settings page — separate time window config for NSE and MCX

## Near Expiry Controls (Discipline Engine)

- [ ] Expiry: Detect expiry schedules per instrument — NIFTY weekly (Thursday), BANK NIFTY weekly (Wednesday), CRUDE OIL monthly (19th), NAT GAS monthly (25th)
- [ ] Expiry: Setting — Block trading on expiry day (toggle, default OFF)
- [ ] Expiry: Setting — Block trading N days before expiry (configurable, default 0)
- [ ] Expiry: Setting — Max position size near expiry — reduce max % within N days of expiry (configurable, default 5%)
- [ ] Expiry: Setting — Expiry day warning banner — amber "Expiry day — High theta decay & volatility" (toggle, default ON)
- [ ] Expiry: Setting — Auto-exit before expiry — auto-close positions N minutes before expiry (configurable, default OFF)
- [ ] Expiry: Setting — No carry to expiry — prevent holding overnight into expiry day (toggle, default ON)
- [ ] Expiry: All near expiry settings configurable per instrument from settings page

## Broker Service — Abstraction Layer (P0 — Highest Priority)

- [ ] Broker Service: Unified interface/contract (TypeScript interface) — placeOrder, exitOrder, exitAll, modifyOrder, placeBracketOrder, getPositions, getOrderStatus, getOrderHistory, getMargin, getScripMaster, validateToken, refreshToken, subscribeLTP, onOrderUpdate, onPositionUpdate, disconnect
- [ ] Broker Service: Internal module in backend (server/broker/) with clean interface boundary, designed for future extraction to microservice
- [ ] Broker Service: Adapter pattern — each broker implements the unified interface
- [ ] Broker Service: Dhan adapter — REST API (orders, positions, margin, scrip master, token validation)
- [ ] Broker Service: Dhan adapter — WebSocket (LTP feed, order updates, position updates)
- [ ] Broker Service: Dhan adapter — scrip master CSV auto-resolution for security IDs
- [ ] Broker Service: Mock adapter — in-memory paper trading simulation (for AI Trades PAPER tab)
- [ ] Broker Service: MongoDB collection `broker_configs` — per-broker config document (brokerId, displayName, isActive, isPaperBroker, credentials, settings, connection status, capabilities)
- [ ] Broker Service: No history tracking for broker configs (simple overwrite)
- [ ] Broker Service: On app start, read broker_configs, load active adapter (isActive=true) for LIVE, load paper adapter (isPaperBroker=true) for PAPER
- [ ] Broker Service: Token validation — check credentials.updatedAt + expiresIn, trigger popup if expired
- [ ] Broker Service: Real-time connection status updates (apiStatus, wsStatus, lastApiCall, lastWsTick, latencyMs)
- [ ] Broker Service: REST endpoints for Python modules to call (POST /api/broker/place-order, etc.)
- [ ] Broker Service: tRPC endpoints for frontend (trpc.broker.placeOrder, etc.)
- [ ] Broker Service: Settings page integration — active broker dropdown, per-broker credentials, connection status display
- [ ] Broker Service: Frontend and Python modules never call Dhan/broker directly — always through Broker Service
- [ ] Broker Service: Switching active broker = flip isActive flag in MongoDB + restart adapter
- [ ] Broker Service: Future-ready for Zerodha, Angel One, Upstox adapters (empty adapter stubs)

## Main Page Layout & Navigation

- [ ] Layout: Top-level navigation tabs below StatusBar — Dashboard, Position Tracker, Discipline, Journal, Settings
- [ ] Layout: StatusBar redesign — add Dhan API status, WebSocket status, Discipline status, Market status indicators
- [ ] Layout: Footer redesign — Dhan API connected/disconnected + latency, WebSocket streaming/reconnecting/disconnected, last tick timestamp, data mode (LIVE/DEMO), active challenge (Day X/150), discipline score, version
- [ ] Layout: Position Tracker as separate full-width page (15 columns need full width)
- [ ] Layout: Discipline Dashboard as separate page (charts, score, violations, trends)
- [ ] Layout: Settings as separate page with sidebar navigation (execution, discipline, charges, time windows, expiry, broker config)
- [ ] Layout: Journal already exists — integrate into top-level navigation
- [ ] Layout: Dashboard page keeps current 3-column grid (instrument cards + signals + controls)
- [ ] Layout: Page routing in App.tsx — /, /tracker, /discipline, /journal, /settings
