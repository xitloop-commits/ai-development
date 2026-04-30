# Main Screen Specification
**Version:** 1.3
**Date:** April 24, 2026
**Project:** Automatic Trading System (ATS)
**Author:** Manus AI

---

## Revision History
| Version | Date | Description |
|---------|------|-------------|
| 1.0 | April 1, 2026 | Initial specification for single-screen command center |
| 1.1 | April 2, 2026 | Cross-functionality update: defined overlay hotkeys (Ctrl+D/J/S), linked TBD markers to existing specs, added gold price API source, expanded discipline score tooltip |
| 1.2 | April 2, 2026 | Updated sidebar behavior (visible by default, push layout, fully disappear on hide). Added explicit implementation constraints to prevent unwanted UI elements (Market Status, Live/Demo pills, standalone MarketHolidays panel, extra center content). |
| 1.3 | April 24, 2026 | **Channel normalization** — AppBar tab strip now hosts the workspace × mode model: 3 top-level tabs (AI Trades / My Trades / Testing), each with an in-tab LIVE/PAPER (or LIVE/SANDBOX) pill. Active tab carries the CLEAR button for paper/sandbox channels. The earlier hidden `testingMode` local-state toggle (under Manual Paper) is removed; mode lives in tab UI for all three workspaces uniformly. Every mode flip shows a ConfirmDialog. The standalone `<TestingControls>` component is folded into `<ChannelTabs>`. |

---

## 1. Overview
The Main Screen is the persistent, single-screen shell of the Automatic Trading System (ATS). It replaces the traditional multi-page navigation model with a unified command center approach. The core trading workspace (Trading Desk) remains permanently visible in the center, surrounded by sticky status and summary bars, and flanked by two collapsible sidebars. All other system views (Discipline, Journal, Settings) are invoked as overlay dialogs via keyboard shortcuts.

**Implementation Constraint:** The Main Screen must strictly adhere to this specification. No additional components, panels, or indicators (such as standalone MarketHolidays panels, cooldown cards, trade limit bars, instrument summary grids, or shortcut hint bars) should be rendered in the center content area outside of the defined Trading Desk.

## 2. Architectural Layout
The Main Screen is divided into four vertical layers, with two sidebars that push the center content:

1. **App Bar** (Sticky Top)
2. **Summary Bar** (Sticky below App Bar)
3. **Trading Desk** (Scrollable Center Content, flanked by sidebars)
4. **Footer** (Sticky Bottom)

*Note: The Trading Desk content is specified separately in `TradingDesk_Spec_v1.1.md`.*

## 3. Component Specifications

### 3.1 App Bar (Sticky Top)
The App Bar serves as the global system status indicator, the channel (workspace × mode) selector, and the sidebar control center.

**Layout Structure:**
- **Left Edge:** Left Sidebar Toggle Button `[☰]`
- **Left Group:** ATS Brand Mark (Cyan square + "ATS" + "Automatic Trading System" label)
- **Center Group — Channel Tab Strip (workspace × mode):**
  The center slot of the AppBar hosts a 3-tab top-level strip plus an in-tab mode pill. This is the single source of truth for the active channel; there is no separate "AI Trades mode toggle" anywhere else in the app (it is **not** in Settings).
  - **Top-level tabs (3):**
    - `AI Trades` — workspace `ai`, supports modes `LIVE` / `PAPER`
    - `My Trades` — workspace `my`, supports modes `LIVE` / `PAPER`
    - `Testing`   — workspace `testing`, supports modes `LIVE` / `SANDBOX`
  - **In-tab mode pill:** the active tab carries a two-segment pill (`LIVE` | `PAPER` for `ai`/`my`, `LIVE` | `SANDBOX` for `testing`). Inactive tabs do not show the pill.
  - **CLEAR button:** when the active tab's pill is on a non-live mode (`PAPER` or `SANDBOX`), a `CLEAR` action appears next to the pill and resets that workspace's paper/sandbox pool. `CLEAR` is hidden in `LIVE`.
  - **Per-workspace mode memory:** switching tabs lands on each workspace's last-used mode (e.g. flipping from `My Trades / LIVE` to `AI Trades` returns to whatever mode `AI Trades` was last on).
  - **Confirm dialog:** every mode flip and every cross-workspace tab switch shows a `ConfirmDialog` (or anchor-positioned `ConfirmPopover`) before committing. New orders route to the target channel; open positions on the source remain.
- **Right Group:** Service Indicators
  - **Broker Connectivity — two dots (one per Dhan account), keyed by `brokerId`:**
    - **Dot 1 — `brokerId="dhan"`** — primary trading account (order placement, positions, funds).
    - **Dot 2 — `brokerId="dhan-ai-data"`** — secondary "data / spouse" account used by the AI for tick feed and historical data (no order placement).
    - Each dot is independently colored (Green=Connected, Amber=Connecting/Degraded, Red=Disconnected, Grey=Disabled). Hovering each dot reveals a tooltip with that account's `brokerId`, mode, login state, and last error. The two dots are explicitly **not** merged into a single aggregate indicator — they replace the prior single-broker dot wording.
  - WebSocket / Feed Status (WiFi icon, separate from broker connectivity)
  - Discipline Score (Shield icon + "100")
  - Live IST Clock (HH:MM:SS format)
- **Right Edge:** Right Sidebar Toggle Button `[☰]`

### 3.2 Summary Bar (Sticky below App Bar)
The Summary Bar provides an immediate, high-level financial snapshot. It is divided into four sections. All content is centered within its respective section, with a tiny descriptive label at the top.

**Layout Structure:**
- **Section 1 (Fixed Width, Left): Profit**
  - Displays today's profit amount and percentage in a single line (e.g., `₹X,XXX +X.X%`).
- **Section 2 (Elastic Width, Center-Left): Capital Breakdown**
  - Displays three values spread across the elastic space:
    - **Capital:** Total Trading Pool fund (e.g., `₹X,XX,XXX`).
    - **Free:** Available funds + percentage of total (e.g., `₹X,XX,XXX XX%`).
    - **Used:** Deployed funds + percentage of total (e.g., `₹X,XXX XX%`).
- **Section 3 (Fixed Width, Center-Right): Gold Reference**
  - Features a subtle gold coin/texture background.
  - Displays the current spot gold price (24K/g), today's price change, and percentage change (e.g., `₹X,XXX/g +₹XX +X.X%`).
  - Below the price, displays the equivalent gold weight purchasable with today's profit (e.g., `X.XX grams`). If profit is zero or negative, displays `0 grams 😞`.
  - *Note: Gold price data should be fetched from a free API (e.g., GoldAPI.io or similar Indian gold price source), with a refresh interval and fallback behavior to be determined during implementation.*
- **Section 4 (Fixed Width, Right): Loss**
  - Displays today's loss amount and percentage in a single line (e.g., `₹X,XXX -X.X%`).

### 3.3 Trading Desk (Center Content)
The Trading Desk occupies the flexible center area of the screen, dynamically resizing based on the visibility of the sidebars. It is the primary workspace for the 250-day compounding challenge, featuring dual tabs (LIVE/PAPER), a compounding table, and active trade management.
*Refer to `TradingDesk_Spec_v1.1.md` for full details.*

### 3.4 Footer (Sticky Bottom)
The Footer provides historical context, upcoming events, and total net worth.

**Implementation Constraint:** The footer must strictly follow this layout. Unwanted indicators such as "MARKET OPEN/CLOSED" or "LIVE DATA/DEMO MODE" must not be included.

**Layout Structure:**
- **Left Group (Fixed, Stuck Left): Monthly Growth**
  - **Previous Month:** Fund value and growth percentage (e.g., `₹X,XX,XXX +X.X%`).
  - **Current Month:** Fund value and growth percentage (e.g., `₹X,XX,XXX +X.X%`).
  - *Hover Behavior:* Tooltip displays the breakdown between Trading Pool and Reserve Pool for that specific month, including the growth percentage for each pool.
- **Center Group (Elastic): Events & Discipline**
  - **`HolidayIndicator` (Holiday Info):** The `HolidayIndicator` component lives in the **footer center group, immediately to the left of the Discipline Score** (i.e. just to the left of the clock/discipline cluster on the bottom-right side of the elastic center). It is rendered exactly once on the Main Screen — it must **not** also appear in the AppBar. Displays the next upcoming market holiday (e.g., `In 3 days: Holi`). If no holidays exist in the current month, displays "No holidays this month".
    - *Click Behavior:* Opens a dialog listing all upcoming NSE and MCX holidays and settlement holidays.
  - **Discipline Score:** Displays the current score (e.g., `🛡 95/100`).
    - *Hover Behavior:* Tooltip displays the detailed breakdown of the discipline score across all 7 categories:
      ```
      Discipline Score: 85/100
      
      Circuit Breaker   20/20  ✓  No daily loss limit violations
      Trade Limits      12/15     Under max trades/day, max positions
      Cooldowns         15/15  ✓  No revenge trades, respected cooldowns
      Time Windows      10/10  ✓  Traded within allowed windows
      Pre-Trade Gate    10/15     Passed all checklist items
      Journal           10/15     All trades journaled
      Streaks            8/10     Healthy streak behavior
      ```
- **Right Group (Fixed, Stuck Right): Net Worth**
  - Displays the total combined value of the Trading Pool and Reserve Pool, along with the cumulative growth percentage since inception (e.g., `Net Worth ₹X,XX,XXX +X.X% since start`).
  - *Hover Behavior:* Tooltip displays the current exact breakdown between the Trading Pool and Reserve Pool, including the growth percentage for each pool.

## 4. Sidebar & Overlay Mechanics

### 4.1 Sidebars (Push Layout)
Unlike traditional overlays, the sidebars are part of the document flow and push the center Trading Desk content when visible.

- **Default State:** Both sidebars are **visible by default** and sticky to the left and right edges of the screen.
- **Toggle Behavior:** Triggered by the respective `[☰]` buttons in the App Bar.
- **Hidden State:** When hidden, the sidebar fully disappears (it does not collapse to a thin icon strip). The center Trading Desk content expands to fill the available space.
- **Animation:** Smooth transition as sidebars slide in/out and the center content resizes.

**Sidebar Content:**
- **Left Sidebar (Instrument Cards):**
  - Contains the detailed analysis cards for the four tracked instruments (NIFTY 50, BANK NIFTY, CRUDE OIL, NATURAL GAS).
  - Features a tabbed navigation at the top to switch between instruments, displaying only one card at a time.
  - The card content (Header, Trade Direction, AI Rationale, Trade Setup, S/R Strength Line, OI Summary, IV & Theta, News Sentiment, Risk Flags, Scoring Factors) scrolls vertically within the sidebar.
- **Right Sidebar (Signals & Alerts):**
  - Contains the real-time **Signals Feed** (chronological scrolling feed of market events, breakouts, AI signals, etc.).
  - Contains the **Alert History** panel (collapsible list of recent system alerts, order fills, and module notifications).

### 4.2 Overlay Screens
Secondary system views are no longer accessed via navigation tabs. They are invoked as full-screen overlays using keyboard shortcuts (hotkeys), and can be dismissed with `Esc`.

| Shortcut | Action |
|----------|--------|
| `Ctrl+D` | Open Discipline Dashboard overlay (read-only monitoring view) |
| `Ctrl+J` | Open Journal overlay |
| `Ctrl+S` | Open Settings overlay |
| `Ctrl+[` | Toggle Left Sidebar (Instrument Cards) |
| `Ctrl+]` | Toggle Right Sidebar (Signals & Alerts) |
| `Esc` | Close any open overlay |

*Note: Discipline enforcement overlays (Circuit Breaker, Cooldown, Pre-Trade Gate, etc.) are system-triggered only and appear automatically when rules are violated during trade placement.*

**References:**
- **Discipline Agent:** See `DisciplineAgent_Spec_v1.4.md`
- **Trade Journal:** See Task I in `ats-feature-requirements.md`
- **System Settings:** See `Settings_Spec_v1.2.md`

---

## Appendix: Implementation Deviations (as of 2026-04-17)

> This section tracks differences between the spec and the actual implementation.
> It will be merged into the spec body when the code stabilises.

- Font scaling: all 665 hardcoded `text-[Npx]` values in `client/src/` converted to rem-based equivalents. Responsive root font-size added via `clamp(16px, 0.625vw + 4px, 28px)` — scales from 16px at 1080p to 28px at 4K. Commit 4f66e01.
- InstrumentCard v2 redesign approved (Option B) but **not yet implemented**. Planned 6 sections: Live Snapshot, SEA Signal, Live Features, Chain OI, Health, News Sentiment. Drops legacy sections: AI Rationale, S/R Strength Line, Scoring Factors, Phase 2 Filter Badges.
- PreEntryChecklist: deferred. All 8 legacy checks depend on removed AI engine fields. Planned partial rewrite (Option III) using Python pipeline outputs once SEA LONG/SHORT signals are built.
- LeftDrawer pipeline health dots (per-instrument green/yellow/red based on DQ flag + tick rate): planned but not yet implemented.
- Model status popover in AppBar: planned but not yet implemented.
- SEA signals wiring to RightDrawer SignalsFeed: planned but not yet implemented.
