# Feature 4: Settings Page Specification

**Version:** 1.2  
**Date:** April 2, 2026  
**Project:** Automatic Trading System (ATS)  
**Author:** Manus AI

---

## Revision History
| Version | Date | Description |
|---------|------|-------------|
| 1.0 | March 30, 2026 | Initial specification |
| 1.1 | April 2, 2026 | Expanded Discipline section to include all 39 configurable parameters, enable/disable toggles, types, ranges, and defaults from the Discipline Engine spec. |
| 1.2 | April 2, 2026 | Cross-functionality update: established as master parameter registry, updated exposure/position defaults (40%/80%), added graduated near-expiry reduction model |

---

## 1. Overview

The Settings Page (Feature 4) provides a centralized, authenticated interface for users to configure their trading environment within the Automatic Trading System. It consolidates broker connections, order execution preferences, risk management rules, time-based trading windows, instrument-specific expiry controls, and dynamic charge rates into a single, cohesive view.

The page is designed using the "Terminal Noir" aesthetic, featuring a two-column layout with a sticky sidebar navigation on the left and content sections on the right. All settings are persisted to MongoDB on a per-user basis, ensuring that configurations are maintained across sessions and devices.

---

## 2. User Interface Architecture

The Settings Page is accessible via the `/settings` route and is integrated into the global `AppLayout` component, which provides the standard top status bar, navigation tabs, and footer.

### 2.1 Authentication and Access

Access to the Settings Page is strictly gated. The page utilizes the `useAuth` hook to verify the user's session. If an unauthenticated user attempts to access the page, they are presented with a "Sign in to continue" prompt that redirects them to the centralized OAuth portal.

### 2.2 Layout Structure

The layout consists of two primary areas. The **Sidebar Navigation** on the left is a sticky vertical menu listing the six configuration sections. Each item displays an icon, a title, and a brief description. The active section is highlighted with the primary brand color and a chevron indicator. The **Content Area** on the right is the main display area for the selected configuration section. It includes a section header (title and description) followed by grouped settings cards. Each section provides dedicated "Reset" and "Save" buttons at the bottom to manage state changes.

---

## 3. Configuration Sections

The Settings Page is divided into six distinct sections, each managing a specific domain of the trading system.

### 3.1 Broker Config

This section manages the connection to the trading broker (e.g., Dhan) and displays the current integration status. Users can select the active broker from a dropdown menu. Real-time badges display the status of the API connection, WebSocket connection, and access token validity. A prominent "KILL SWITCH ACTIVE" warning is displayed if trading is halted.

The credentials area displays the masked Client ID and Access Token, along with the token's current status and the timestamp of its last update. A secure input field allows the user to paste a new access token, which is critical as broker tokens typically expire every 24 hours. The connection details area displays API latency (in milliseconds) and the timestamp of the last API call. Finally, a capabilities grid provides an overview of the broker's supported features (e.g., Option Chain, Websocket, Paper Trading), indicated by checkmarks or cross marks.

### 3.2 Order Execution

This section defines the default parameters used when placing new trades, streamlining the order entry process.

| Setting | Description | Options/Range |
|---|---|---|
| **Entry Offset** | Calculates limit order prices below the current Last Traded Price (LTP). | 0% to 10% |
| **Order Type** | The default order type for new trades. | LIMIT, MARKET, SL, SL-M |
| **Product Type** | The default product type. | INTRADAY, CNC, MARGIN |
| **Default Stop Loss** | Defines the default stop-loss distance from the entry price. | 0% to 50% |
| **Default Target Profit** | Defines the default target profit distance from the entry price. | 0% to 100% |
| **Trailing Stop** | A toggle to enable automatic trailing stop-loss functionality. | Toggle |
| **Trailing SL %** | The percentage distance from the peak price at which the trailing stop is maintained. | 0% to 50% |

### 3.3 Discipline

This section enforces risk management and trading psychology rules, preventing emotional or excessive trading. Every discipline rule has an explicit **enabled/disabled toggle**. When disabled, the rule does not block trades and its weight is redistributed in the discipline score.

| Category | Setting | Type | Range / Options | Default | Description |
|---|---|---|---|---|---|
| **Circuit Breaker** | Daily loss limit enabled | Toggle | — | ON | Master toggle for daily loss limit. |
| | Daily loss limit threshold | Number | 1–10% | 3% | Block all trading when daily loss hits this % of capital. |
| | Max consecutive losses enabled | Toggle | — | ON | Master toggle for consecutive loss cooldown. |
| | Max consecutive losses count | Number | 2–10 | 3 | Number of back-to-back losses before cooldown. |
| | Max consecutive losses cooldown | Number | 10–120 min | 30 min | Mandatory cooldown duration after consecutive losses. |
| **Trade Limits** | Max trades per day enabled | Toggle | — | ON | Master toggle for daily trade count limit. |
| | Max trades per day limit | Number | 1–20 | 5 | Maximum number of trades allowed per day. |
| | Max open positions enabled | Toggle | — | ON | Master toggle for concurrent position limit. |
| | Max open positions limit | Number | 1–10 | 3 | Maximum number of simultaneously open positions. |
| | Revenge cooldown enabled | Toggle | — | ON | Master toggle for post-loss cooldown. |
| | Revenge cooldown duration | Select | 10 / 15 / 30 min | 15 min | Mandatory cooldown duration after any SL hit. |
| | Require loss acknowledgment | Toggle | — | ON | Require typing "I accept the loss" to start cooldown. |
| **Pre-Trade Gate** | Pre-trade gate enabled | Toggle | — | ON | Master toggle for the pre-trade confirmation checklist. |
| | Min R:R check enabled | Toggle | — | ON | Sub-toggle to enforce minimum Risk:Reward ratio. |
| | Min R:R ratio | Number | 1.0–5.0 | 1.5 | Minimum acceptable R:R ratio for trade approval. |
| | Emotional state check enabled | Toggle | — | ON | Sub-toggle to block trades if state is Revenge/FOMO. |
| **Position Sizing** | Max position size enabled | Toggle | — | ON | Master toggle for single position size limit. |
| | Max position size % | Number | 5–50% | 40% | Maximum capital allocation for a single position. |
| | Max total exposure enabled | Toggle | — | ON | Master toggle for total open exposure limit. |
| | Max total exposure % | Number | 20–100% | 80% | Maximum combined capital allocation for all open positions. |
| **Journal & Review** | Journal enforcement enabled | Toggle | — | ON | Master toggle for mandatory trade journaling. |
| | Max unjournaled trades | Number | 1–10 | 3 | Block new trades if this many past trades are unjournaled. |
| | Weekly review enabled | Toggle | — | ON | Master toggle for mandatory Monday morning review. |
| | Discipline score warning threshold | Number | 50–90 | 70 | Show warning if daily discipline score drops below this. |
| | Red week reduction trigger | Number | 2–5 weeks | 3 weeks | Number of consecutive losing weeks to trigger auto-reduction. |
| **Streaks** | Winning streak reminder enabled | Toggle | — | ON | Master toggle for overconfidence warnings. |
| | Winning streak trigger | Number | 3–10 days | 5 days | Number of consecutive winning days to trigger reminder. |
| | Losing streak auto-reduce enabled | Toggle | — | ON | Master toggle for losing streak position size reduction. |
| | Losing streak trigger | Number | 2–7 days | 3 days | Number of consecutive losing days to trigger reduction. |
| | Losing streak reduction | Number | 25–75% | 50% | Percentage by which max position size is reduced. |

### 3.4 Time Windows

This section defines the specific hours during which trading is permitted, separated by exchange. Every time window rule has an explicit **enabled/disabled toggle**.

| Exchange | Setting | Type | Range | Default | Description |
|---|---|---|---|---|---|
| **NSE** | No trading after open enabled | Toggle | — | ON | Master toggle for NSE morning block. |
| | No trading after open | Number | 5–60 min | 15 min | Minutes after 9:15 AM IST when trading is blocked. |
| | No trading before close enabled | Toggle | — | ON | Master toggle for NSE evening block. |
| | No trading before close | Number | 5–60 min | 15 min | Minutes before 3:30 PM IST when trading is blocked. |
| | Lunch break pause enabled | Toggle | — | OFF | Master toggle for NSE lunch break block. |
| | Lunch break start | Time | — | 12:30 | Start time for lunch break pause. |
| | Lunch break end | Time | — | 13:30 | End time for lunch break pause. |
| **MCX** | No trading after open enabled | Toggle | — | ON | Master toggle for MCX morning block. |
| | No trading after open | Number | 5–60 min | 15 min | Minutes after 9:00 AM IST when trading is blocked. |
| | No trading before close enabled | Toggle | — | ON | Master toggle for MCX evening block. |
| | No trading before close | Number | 5–60 min | 15 min | Minutes before 11:30 PM IST when trading is blocked. |

### 3.5 Expiry Controls

This section provides granular risk management rules specific to the expiry days of different instruments (NIFTY 50, BANK NIFTY, CRUDE OIL, NATURAL GAS).

| Setting | Description | Default (Weekly) | Default (Monthly) |
|---|---|---|---|
| **Block on Expiry Day** | A toggle to completely prevent trading of the instrument on its expiry day. | OFF | OFF |
| **Block Days Before** | The number of days prior to expiry when trading is blocked. | 0 | 0 |
| **Near-Expiry Window** | The number of days before expiry when graduated linear reduction of exposure limits begins. | 3 days | 7 days |
| **Max Reduction at Expiry** | The maximum percentage by which exposure limits are reduced on expiry day (scales linearly). | 50% | 50% |
| **Warning Banner** | A toggle to display a prominent warning banner in the UI when trading near expiry. | ON | ON |
| **Auto Exit** | A toggle to automatically close open positions before the market closes on expiry day. | OFF | OFF |
| **Exit Before (min)** | The number of minutes before market close when the auto-exit is triggered. | 30 min | 60 min |
| **No Carry to Expiry** | A toggle preventing positions from being carried overnight into the expiry day. | ON | ON |

### 3.6 Charges

This section allows users to configure the various fees and taxes applied to trades, ensuring accurate net Profit and Loss (P&L) calculations.

The system provides a list of standard Indian trading charges (e.g., Brokerage, STT, Exchange Transaction, GST, SEBI, Stamp Duty). For each charge, the user can toggle whether the specific charge is included in the P&L calculation, edit the numerical value of the charge, and view the unit of the charge (e.g., ₹/order, % sell, % buy, % on brokerage).

---

## 4. Data Model and Persistence

All user settings (excluding Broker Config and Order Execution, which are tied to the broker adapter) are persisted in a dedicated MongoDB collection named `user_settings`.

### 4.1 Schema Definition

The `user_settings` collection utilizes a single document per user, identified by a unique `userId`. The document structure is defined using Mongoose schemas and TypeScript interfaces in `server/userSettings.ts`.

| Field | Type | Description |
|---|---|---|
| `userId` | Number | Unique identifier for the user (Indexed). |
| `timeWindows` | Object | Nested object containing `nse` and `mcx` time window configurations. |
| `discipline` | Object | Nested object containing all discipline and risk management thresholds. |
| `expiryControls` | Object | Nested object containing an array of `rules` for each instrument. |
| `charges` | Object | Nested object containing an array of `rates` for various fees and taxes. |
| `updatedAt` | Number | UTC timestamp (in milliseconds) of the last modification. |

### 4.2 Default Values

To ensure the system functions correctly even before a user explicitly configures their settings, the backend provides comprehensive default values. When a user's settings are queried for the first time, these defaults are returned and subsequently saved upon the first update.

Key defaults include a maximum of 5 trades per day, a 3% maximum daily loss, and a 15-minute cooldown after a loss for discipline settings. Time windows default to 15-minute no-trade zones at the open and close for both NSE and MCX. Expiry controls default to "No Carry to Expiry" enabled for all instruments, with position size reduction disabled. Charges are pre-populated with standard Indian options trading rates, such as a ₹20 flat brokerage fee and 18% GST.

### 4.3 Update Mechanism (Upsert)

The backend utilizes an upsert pattern for saving settings. The `updateUserSettings` helper function performs a partial-field merge. This means that when a specific section (e.g., Discipline) is updated, only the provided fields within that section are modified, leaving the rest of the document intact. This is achieved using MongoDB's `$set` operator with dot notation for nested fields.

---

## 5. API Endpoints (tRPC)

The Settings Page communicates with the backend via tRPC procedures defined in `server/routers.ts`. All settings-related endpoints are protected and require an authenticated user context.

### 5.1 Settings Router (`trpc.settings.*`)

| Endpoint | Type | Description |
|---|---|---|
| `get` | Query | Retrieves the complete settings document for the authenticated user. Returns default values if no document exists. |
| `updateTimeWindows` | Mutation | Accepts a partial `timeWindows` object and updates the corresponding fields in the database. |
| `updateDiscipline` | Mutation | Accepts a partial `discipline` object and updates the corresponding fields. |
| `updateExpiryControls` | Mutation | Accepts an array of `rules` and replaces the existing expiry controls array. |
| `updateCharges` | Mutation | Accepts an array of `rates` and replaces the existing charges array. |

### 5.2 Broker Router (`trpc.broker.*`)

The Broker Config and Order Execution sections utilize existing endpoints from the broker service.

| Endpoint | Type | Description |
|---|---|---|
| `config.get` / `config.list` | Query | Retrieves active and available broker configurations, masking sensitive access tokens. |
| `status` | Query | Retrieves the overall health and connection status of the broker service. |
| `token.status` | Query | Validates the current access token with the broker API. |
| `token.update` | Mutation | Submits a new access token to the broker adapter and updates the database. |
| `config.updateSettings` | Mutation | Saves changes made in the Order Execution section to the active broker's configuration document. |
| `config.switchBroker` | Mutation | Changes the active broker adapter. |

---

## 6. Error Handling and Notifications

The Settings Page employs robust error handling to ensure a smooth user experience. While data is being fetched or mutations are in progress, the UI displays loading spinners (e.g., on the "Save" buttons) and disables inputs to prevent concurrent modifications. Input fields utilize HTML5 validation (e.g., `min`, `max`, `step`) to restrict invalid entries on the client side. The backend tRPC routers enforce strict validation using Zod schemas, rejecting any malformed data. The `sonner` library is used to provide immediate, non-intrusive feedback. Successful saves trigger a green success toast, while any errors (e.g., network failure, validation error) trigger a red error toast displaying the specific error message returned by the backend.
