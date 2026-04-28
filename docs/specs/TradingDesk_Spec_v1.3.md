# Trading Desk Specification
**Version:** 1.3
**Date:** April 24, 2026
**Project:** Automatic Trading System (ATS)
**Author:** Manus AI

---

## Revision History
| Version | Date | Description |
|---------|------|-------------|
| 1.0 | April 1, 2026 | Initial specification for 250-day compounding table |
| 1.1 | April 2, 2026 | Cross-functionality update: added Charges column (16 cols total), standardized capital column naming, defined quarterly projection calculation, clarified near-expiry reduction |
| 1.2 | April 2, 2026 | Updated summary bar design, removed +NEW TRADE button, updated tabs row, added full rating table |
| 1.3 | April 24, 2026 | **Channel normalization** — Tabs render workspace × mode: 3 top-level tabs (AI Trades / My Trades / Testing), each with an in-tab Live/Paper (or Live/Sandbox) toggle. Default mode per tab: `ai-paper`, `my-paper`, `testing-sandbox`. Default landing channel: `testing-sandbox`. Every mode toggle fires a ConfirmDialog regardless of open positions. Tab switching = navigation only. Theme is keyed by workspace via `channelToWorkspace(channel)`; live and paper share the same colour tone within a tab. Row components (PastRow, FutureRow, TodayTradeRow, TodaySection) accept `channel: Channel` prop. |

---

## 1. Overview
The Trading Desk (formerly Position Tracker) is the core trading workspace of the Automatic Trading System. It is designed around a 250-day compounding challenge, tracking the journey from an initial capital base to a projected goal. The Trading Desk provides a unified interface for live trade execution, paper trading simulation, and performance tracking against a fixed compounding plan.

## 2. Core Concepts

### 2.1 The 250-Day Challenge
The system tracks progress across 250 "Day Index" cycles. A Day Index is not a calendar day; it represents one completed profit cycle where the target percentage (default 5%) is achieved on the available Trade Capital.
- The journey starts at Day 1 and ends at Day 250.
- A single calendar day can complete multiple Day Index cycles if profit exceeds the target (Gift Days).
- A single Day Index cycle can span multiple calendar days if the target is not met before market close (Multi-day).

### 2.2 Dual Workspaces
The Trading Desk features two independent tabs running parallel 250-day journeys:
- **My Trades (LIVE)**: The user's workspace for manual trade execution based on AI signals. Uses real money and routes orders to the broker.
- **AI Trades (PAPER)**: The system's autonomous workspace. The AI engine places and manages simulated trades based on its own logic. No user intervention is required.

Both tabs share the exact same table structure, compounding logic, and starting capital (₹75,000 Trading Pool). They operate independently, allowing direct performance comparison between the user and the AI.

### 2.3 Capital Definitions
- **Trade Capital**: The capital available in the Trading Pool at the start of the Day Index. This is the base amount used to calculate the day's target.
- **Available Capital**: Trade Capital minus the margin currently locked in open positions. Used for position sizing on new trades.
- **Actual Capital**: The real-time capital value, including Trade Capital plus realized P&L from closed trades and unrealized P&L from open positions.
- **Original Proj Capital**: A hidden, fixed value representing the ideal compounding path from Day 1. Used solely to calculate Deviation.

## 3. User Interface Layout

The Trading Desk occupies the full width of the main content area, consisting of three primary sections:

### 3.1 Tabs
- **My Trades**: Active by default, indicated by a green dot indicator.
- **AI Trades**: The system's autonomous workspace.
- **LIVE Badge**: A green "LIVE" badge sits next to the tabs to indicate the active environment.
- **NET/GROSS Toggle**: A toggle switch on the far right of the tabs row to switch all P&L values between net (after charges) and gross.

### 3.2 Summary Bar
A single-row sticky bar providing an at-a-glance snapshot of the active tab's status, featuring icons for each metric:
- **Day**: E.g., "1 / 250".
- **Trade Capital**: The starting capital for the current Day Index.
- **Available**: Capital currently free for new trades.
- **Cum. Profit**: Cumulative net profit from the Trading Pool since Day 1.
- **Today P&L / Target**: E.g., "₹0.00 / ₹3,750.00" with an adjacent "Exit All" (×) button.
- **Charges**: Cumulative charges/fees paid across all trades since Day 1.
- **Reserve**: Current value of the Reserve Pool.
- **Quarterly Projection**: E.g., "Q1 FY27 ₹1.00L" (projected capital at the end of the current quarter, calculated using the user's actual average daily compounding rate so far).
- **Net Worth**: Total value of Trading Pool + Reserve Pool.

### 3.3 Compounding Table
A 16-column data table tracking the 250-day journey. The table auto-scrolls to the current day (Today's section) on page load.

**Columns:**
1. **Day**: Day Index number (1–250).
2. **Date**: Calendar date (left-aligned) and age/duration open (right-aligned, e.g., "4h", "2d").
3. **Trade Capital**: Starting capital for the day.
4. **Target (%)**: Required profit to complete the day (based on system settings).
5. **Proj Capital**: Trade Capital + Target.
6. **Instrument**: Traded asset (dynamic list from settings, auto-color-coded).
7. **Type**: Trade direction (B/S) and option type (CE/PE). Non-options show only B/S.
8. **Strike**: Option strike price (dash for non-options).
9. **Entry**: Average entry price.
10. **LTP**: Last Traded Price (live feed).
11. **Qty**: Position size (absolute total for summary rows).
12. **P&L**: Profit/Loss (live for open trades, aggregated for past days).
13. **Charges**: Brokerage, STT, and fees.
14. **Actual Capital**: Realized + unrealized capital.
15. **Deviation**: Difference between Actual Capital and Original Proj Capital (amount + days ahead/behind).
16. **Rating**: Visual icon representing the day's outcome.

## 4. Row Types and Behaviors

### 4.1 Past Days (Completed)
- **Visual**: Green tint, collapsed into a single summary row per Day Index.
- **Data**: Shows aggregated Qty (absolute total) and P&L. Trade detail columns (Type, Strike, Entry, LTP) show dashes. Instrument column shows all instruments traded that day as side-by-side tags.
- **Rating**: Based on profit percentage against Trade Capital. The rating system is as follows:
  - ⭐ (Rating 1): Profit ≥ 5% but took multiple days
  - 🏆 (Rating 2): Profit ≥ 5% in a single day
  - 🏆🏆 (Rating 3): Profit ≥ 10%
  - 🏆👑 (Rating 4): Profit ≥ 20%
  - 🏆🏆👑💰 (Rating 5): Profit ≥ 50% (jackpot)

### 4.2 Gift Days (Auto-completed)
- **Trigger**: When a day's profit significantly exceeds the target, the excess cascades forward to auto-complete subsequent days.
- **Visual**: Gold tint.
- **Data**: P&L equals exactly the target amount. Deviation is ₹0. Trade detail columns show dashes.
- **Rating**: 🎁 (Gift).

### 4.3 Today (Active Day)
- **Visual**: Yellow tint with a left border. Expanded to show individual trade rows.
- **Trade Rows**: One row per trade. Open trades show a pulsing "OPEN" badge, live LTP/P&L, inline TP/SL sub-text, and an Exit (×) button. Closed trades show final status (✓ TP, ✗ SL, ✓ Partial).
- **New Trade Input Row**: Always visible at the bottom of the active trades list. Contains inputs for Instrument, B/S, CE/PE, Strike, Entry (auto-filled with LTP but editable), and Capital % (5%–25% of Available Capital).
- **Summary Row**: Aggregates all trades for the day. Shows total Qty, total P&L with an Exit All (×) button, live Actual Capital, and live Deviation.

### 4.4 Future Days (Projected)
- **Visual**: Dimmed (45% opacity).
- **Data**: Trade Capital, Target, and Proj Capital recalculate dynamically based on today's Actual Capital. Date skips weekends and holidays. Trade detail columns show dashes.
- **Rating**: ⬜ (Future) or 🏁 (Day 250).

## 5. Core Mechanics

### 5.1 Trade Execution and Management
- **Bracket Orders**: All new trades placed via the Trading Desk are sent as bracket orders. Target and Stop Loss levels are auto-calculated from the entry price based on system settings percentages.
- **Position Sizing**: Position sizing is percentage-based. The user selects a percentage of Available Capital (5%–25%) when placing each trade. The system calculates the quantity based on the selected percentage and the entry price. The Discipline Agent enforces configurable ceilings (default: 40% max per position, 80% max total exposure).
- **Modifications**: Users can click an edit icon next to the TP/SL sub-text on open trades to modify the levels inline.
- **Exits**: Users can exit individual positions via the inline (×) button or all positions via the "Exit All" button. All exit actions require a confirmation prompt.
- **External Sync**: Orders placed or modified directly on the broker platform (e.g., Dhan) are synced via WebSocket and reflected instantly in the Trading Desk. Capital % for external trades is back-calculated from margin used.

### 5.2 Day Completion and Carry Forward
- **Completion**: A Day Index automatically completes when there are no open positions and the realized P&L meets or exceeds the target percentage. The system then advances to the next Day Index.
- **Overnight Positions**: Holding positions overnight is discouraged but allowed. The system alerts the user 15 minutes and 5 minutes before market close. Auto-exit is OFF by default (configurable in Settings).
- **Carry Forward**: If the market closes with open positions (either because the target was not met or positions were held overnight), the Day Index remains active. It carries over to the next calendar day, becoming a multi-day cycle (⭐ rating). The Date column updates to the new calendar date, and the age counter continues ticking.

### 5.3 Loss Adjustment (Clawback)
- Losses are absorbed entirely by the Trading Pool.
- A loss causes the Day Index to rewind. The system finds the past day whose projected capital matches the new Actual Capital.
- Fully consumed past days are wiped and become future rows again (reset completely, no visual trace).
- Partially consumed days become the new "Today," open for new trades, showing the remaining profit and a negative deviation.

### 5.4 Target Percentage Changes
- The target percentage (default 5%) is configurable in system settings.
- Changing the target applies to the current day and all future days. Past completed days retain their historical target.
- The hidden Original Proj Capital (used for Deviation) recalculates from the current day forward using the new target percentage, ensuring Deviation remains meaningful against the current goal.

## 6. Broker Integration Requirements
The Trading Desk relies on the Broker Service (specified separately) for:
- Live LTP WebSocket feed for all active instruments.
- Order placement (bracket orders, market exits, modifications).
- Order update WebSocket feed to sync external trades and status changes.
- Margin calculation data to determine Available Capital and back-calculate Capital % for external trades.
