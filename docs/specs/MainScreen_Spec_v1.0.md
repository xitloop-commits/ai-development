# Main Screen Specification v1.0

## 1. Overview
The Main Screen is the persistent, single-screen shell of the Automatic Trading System (ATS). It replaces the traditional multi-page navigation model with a unified command center approach. The core trading workspace (Trading Desk) remains permanently visible in the center, surrounded by sticky status and summary bars. All other system views (Discipline, Journal, Settings) are invoked as overlay dialogs via keyboard shortcuts.

## 2. Architectural Layout
The Main Screen is divided into four vertical layers, with two hidden side drawers:

1. **App Bar** (Sticky Top)
2. **Summary Bar** (Sticky below App Bar)
3. **Trading Desk** (Scrollable Center Content)
4. **Footer** (Sticky Bottom)

*Note: The Trading Desk content is specified separately in `TradingDesk_Spec_v1.0.md`.*

## 3. Component Specifications

### 3.1 App Bar (Sticky Top)
The App Bar serves as the global system status indicator and drawer control center.

**Layout Structure:**
- **Left Edge:** Left Drawer Toggle Button `[☰]`
- **Left Group:** ATS Brand Mark (Cyan square + "ATS" + "Automatic Trading System" label)
- **Center Group:** Module Heartbeats
  - Four modules: FETCHER, ANALYZER, AI ENGINE, EXECUTOR
  - Each displays a pulsing status dot (Green=Active, Amber=Warning, Red=Error, Grey=Idle), an icon, and a label.
  - Hovering reveals a tooltip with the full module name and current status message.
- **Right Group:** Service Indicators
  - Dhan API Status (Globe icon)
  - WebSocket Status (WiFi icon)
  - Discipline Score (Shield icon + "100")
  - Live IST Clock (HH:MM:SS format)
- **Right Edge:** Right Drawer Toggle Button `[☰]`

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
- **Section 4 (Fixed Width, Right): Loss**
  - Displays today's loss amount and percentage in a single line (e.g., `₹X,XXX -X.X%`).

### 3.3 Trading Desk (Center Content)
The Trading Desk occupies the flexible center area of the screen. It is the primary workspace for the 250-day compounding challenge, featuring dual tabs (LIVE/PAPER), a compounding table, and active trade management.
*Refer to `TradingDesk_Spec_v1.0.md` for full details.*

### 3.4 Footer (Sticky Bottom)
The Footer provides historical context, upcoming events, and total net worth.

**Layout Structure:**
- **Left Group (Fixed, Stuck Left): Monthly Growth**
  - **Previous Month:** Fund value and growth percentage (e.g., `₹X,XX,XXX +X.X%`).
  - **Current Month:** Fund value and growth percentage (e.g., `₹X,XX,XXX +X.X%`).
  - *Hover Behavior:* Tooltip displays the breakdown between Trading Pool and Reserve Pool for that specific month.
- **Center Group (Elastic): Events & Discipline**
  - **Holiday Info:** Displays the next upcoming market holiday (e.g., `In 3 days: Holi`). If no holidays exist in the current month, displays "No holidays this month".
    - *Click Behavior:* Opens a dialog listing all upcoming NSE and MCX holidays and settlement holidays.
  - **Discipline Score:** Displays the current score (e.g., `🛡 95/100`).
    - *Hover Behavior:* Tooltip displays the detailed breakdown of the discipline score (specifics TBD).
- **Right Group (Fixed, Stuck Right): Net Worth**
  - Displays the total combined value of the Trading Pool and Reserve Pool, along with the cumulative growth percentage since inception (e.g., `Net Worth ₹X,XX,XXX +X.X% since start`).
  - *Hover Behavior:* Tooltip displays the current exact breakdown between the Trading Pool and Reserve Pool.

## 4. Drawer & Overlay Mechanics

### 4.1 Side Drawers
- **Left Drawer:** Triggered by the left `[☰]` button in the App Bar. Slides in from the left edge. Content is currently designated for the Control Panel (specifics TBD).
- **Right Drawer:** Triggered by the right `[☰]` button in the App Bar. Slides in from the right edge. Content is currently designated for Signals and Alerts (specifics TBD).
- **Behavior:** Both drawers slide in as overlays on top of the Trading Desk without dimming the background content.

### 4.2 Overlay Screens
Secondary system views are no longer accessed via navigation tabs. They are invoked as full-screen or modal overlays using keyboard shortcuts (hotkeys).
- **Discipline Engine** (Spec TBD)
- **Trade Journal** (Spec TBD)
- **System Settings** (Spec TBD)
