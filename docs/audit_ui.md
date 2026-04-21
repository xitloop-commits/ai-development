# UI Specification Audit — April 21, 2026

## Executive Summary

**Overall Completion: 78%** (80/102 items built)

- MainScreen v1.2: 75% (24/32 items)
- TradingDesk v1.2: 71% (20/28 items)  
- Settings v1.4: 86% (36/42 items)

**Top 4 Critical Gaps:**
1. Hotkey system broken — Ctrl+D/S/J/brackets don't work (modifier key filter blocks them)
2. Module heartbeats missing — 0/4 system health dots in AppBar
3. Module 8 missing — 6 discipline params (daily loss/profit caps, grace period) completely absent from Settings
4. TradingDesk redesign not started — Approved 10-column simplification not implemented

---

## SECTION A: Purpose Recap

**MainScreen_Spec_v1.2**: Single-screen command center. Sticky AppBar + SummaryBar top, TradingDesk center (flanked by push sidebars), sticky Footer. Overlays via hotkeys. Sidebars visible by default, fully disappear when hidden.

**TradingDesk_Spec_v1.2**: 250-day compounding workspace. Dual tabs (LIVE/PAPER), 16-column table, live trade execution with bracket orders. Rows by status: PAST (green summary), TODAY (yellow expanded), GIFT (gold), FUTURE (dimmed).

**Settings_Spec_v1.4**: Master parameter registry. Terminal Noir layout: sidebar nav left, 6 content sections right (Broker Config, Order Execution, Discipline with 39 params, Time Windows, Expiry Controls, Trading Mode, Charges). Full MongoDB persistence per-user.

---

## SECTION B: Capability Audit

**Layout & Component Tree: BUILT**
- AppBar sticky top (z-40)
- SummaryBar (4 sections: profit/capital/gold/loss) wired to CapitalContext
- TradingDesk center in 3-column layout with sidebars
- LeftSidebar (4 instrument tabs, visible by default)
- RightSidebar (SignalsFeed + AlertHistory)
- Footer sticky bottom
- Sidebars fully disappear when hidden

**Data Sources: MOSTLY LIVE**
- CapitalContext: LIVE updates
- tRPC capital/broker/discipline endpoints: LIVE
- WebSocket ticks & order updates: LIVE
- Gold price: STUB (hardcoded 7250)
- SEA signals: MOCK (spec notes "live wiring planned")
- Module heartbeats: MISSING (not fetched)

**User Interactions: CRITICAL FAILURE**

Hotkey System: useHotkeyListener.ts L18 blocks ALL Ctrl/Cmd/Alt/Shift combinations.

Required hotkeys per spec:
- Ctrl+D (Discipline) — BROKEN
- Ctrl+S (Settings) — BROKEN  
- Ctrl+J (Journal) — MISSING (feature removed)
- Ctrl+[ (Left sidebar) — BROKEN
- Ctrl+] (Right sidebar) — BROKEN
- Esc (Close overlay) — MISSING
- F2 (Settings) — MISSING

System only supports single-key shortcuts. All modifier combinations are blocked.

**Visual States: BUILT**
- Loading spinners, empty states, error dialogs
- Day row coloring (past green/today yellow/gift gold/future dimmed)
- Rating emoji (⭐🏆💰🎁)
- Status badges (OPEN/TP/SL)

**Responsive: BUILT**
- Sidebar push layout with dynamic width
- TradingDesk expands when sidebars hidden
- Rem-based font scaling (clamp 16px to 28px)
- Correct z-index layering

---

## SECTION C: TradingDesk Redesign

**Approved Target** (from project_tradedesk_redesign.md):
- Summary bar: 10 items → 6 (remove Available, Charges, Reserve)
- Table: 15 cols → 10 (remove Proj+, Entry, LTP, Qty; expand only in today)

**Current State**: TradingDesk.tsx L1087-1122 still has 16 columns and 10 summary items.

**Verdict: NOT IMPLEMENTED** (0/2 changes completed). Approved but deferred.

---

## SECTION D: Settings — Discipline Parameters

**File**: client/src/pages/Settings.tsx (2490 lines)

**Broker Config**: BUILT (switch, token, latency, capabilities)
**Order Execution**: BUILT (7 params: entry offset, order type, product type, SL%, TP%, trailing)
**Discipline**: 33 BUILT, 6 MISSING

Built sections:
- Circuit Breaker (daily loss limit, consecutive losses)
- Trade Limits (max trades/day, positions, revenge cooldown)
- Pre-Trade Gate (min R:R, emotional state check)
- Position Sizing (max position %, total exposure %)
- Journal & Review (enforcement, weekly review, score warning)
- Streaks (winning streak, losing streak auto-reduce)

**MISSING: Module 8 Capital Protection** (Spec v1.4 L103-109)
- Daily loss cap enabled
- Daily loss cap threshold (0.5–5%, default 2%)
- Daily profit cap enabled
- Daily profit cap threshold (1–20%, default 5%)
- Grace period duration (10–300 sec, default 30s)
- Carry forward evaluation enabled + time

DisciplineSection (L1275-1674) ends after Streaks. No Capital Protection card. Completely absent.

**Time Windows**: BUILT (NSE/MCX blocks with toggles)
**Expiry Controls**: BUILT (per-instrument rules)
**Trading Mode**: BUILT (workspace modes + kill switches per v1.4)
**Charges**: BUILT (Indian trading fees)

**Verdict: PARTIAL (36/42 items = 86%)**

---

## SECTION E: Cross-Cutting Concerns

**AppBar Heartbeat Dots: MISSING**

Spec requires: Four system modules (FETCHER, ANALYZER, AI ENGINE, EXECUTOR) with pulsing status dots.

Found: ModelStatusIndicator (L34-78) shows ML model versions, NOT system module health.

Status: 0/4 module heartbeats implemented (wrong component type).

**AppBar Service Indicators: BUILT**
- Dhan API Status (Globe)
- WebSocket Status (WiFi)
- Discipline Score (Shield)
- IST Clock (HH:MM:SS)

**Footer: BUILT**
- Monthly Growth
- Holiday info + dialog
- Discipline Score (7-category on hover)
- Net Worth (with inject/transfer popover)

**Z-Index Layering: BUILT**
All sticky elements correctly layered.

---

## SECTION F: Mock Data & Stubs

**Removed Components** (cleaned per context):
PreEntryChecklist, PreTradeGate, NewsSentimentBadge, SRStrengthLine, DisciplinePanel, Map, ManusDialog, StatusBar, AiPaperTab

**Remaining Stubs:**
1. Gold price (SummaryBar L26): hardcoded 7250
2. Gold change (L27): hardcoded 45
3. Module heartbeats: not fetched
4. SEA signals: mock data (live wiring planned)
5. Module 8: Settings UI missing
6. Journal: feature removed
7. InstrumentCard v2: approved not implemented
8. LeftDrawer health dots: planned not implemented

**Live Data (>95% of UI):**
- Capital figures (CapitalContext)
- Trade execution (tRPC + real orders)
- Broker status (tRPC)
- Discipline score (tRPC)
- All Settings (tRPC)
- Order fills (WebSocket)
- Live LTP (WebSocket)

---

## Top 10 Missing Items by Impact

1. **Hotkey System** — 7 required, 0 working. HIGH severity.
2. **Module Heartbeats** — 0/4 system health dots. MEDIUM severity.
3. **Module 8 Capital Protection** — 6 params missing from Settings. MEDIUM severity.
4. **TradingDesk Redesign** — Approved 10-column table not started. MEDIUM severity.
5. **Gold API Wiring** — Hardcoded values in SummaryBar. LOW severity.
6. **Journal Feature** — Removed; spec still references. MEDIUM severity.
7. **SEA Signal Live** — Mock signals in RightDrawer. LOW severity.
8. **InstrumentCard v2** — Approved not implemented. LOW severity.
9. **LeftDrawer Health Dots** — Planned not implemented. LOW severity.
10. **Escape Key Dismiss** — Overlays only close via button. LOW severity.

---

## Recommendations (Estimated Effort)

1. Fix hotkey system (enable Ctrl+D/S/J/[/], Esc, F2) — 30 mins
2. Implement module heartbeats (fetch 4 modules, add dots to AppBar) — 1 hour
3. Add Module 8 Capital Protection UI (new SettingsCard) — 1 hour
4. Complete TradingDesk redesign (10 cols, 6 summary items) — 2 hours
5. Wire gold API (replace hardcoded values) — 1 hour
6. Restore/remove Journal (feature cleanup) — 30 mins

