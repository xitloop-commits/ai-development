# Feature 4: Settings Page Specification

**Version:** 1.0  
**Date:** March 30, 2026  
**Project:** Automatic Trading System (ATS)  
**Author:** Manus AI

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

### 3.3 Discipline

This section enforces risk management and trading psychology rules, preventing emotional or excessive trading.

| Category | Setting | Description |
|---|---|---|
| **Trade Limits** | Max Trades / Day | The maximum number of combined trades allowed across all exchanges (NSE and MCX) per day. |
| | Max Position Size | The maximum capital allocation allowed for a single position, expressed as a percentage of total capital. |
| **Loss Protection** | Max Loss / Day (₹) | The absolute maximum daily loss limit in rupees. |
| | Max Loss / Day (%) | The maximum daily loss limit expressed as a percentage of total capital. |
| | Max Consecutive Losses | The number of consecutive losing trades that will trigger a trading halt. |
| | Cooldown After Loss | A mandatory waiting period (in minutes) enforced after a losing trade before a new trade can be placed. |
| | No Revenge Trading | A toggle that completely blocks all further trading for the day once the daily loss limit is reached. |
| **Pre-Trade Checks** | Mandatory Checklist | A toggle requiring the user to complete a pre-entry checklist before placing a trade. |
| | Min Checklist Score | The minimum score (0-100) required on the pre-entry checklist to authorize the trade. |
| | Require Rationale | A toggle requiring the user to input a written rationale for the trade before execution. |
| **Trailing Stop** | Trailing Stop | A toggle to enable automatic trailing stop-loss functionality. |
| | Trailing SL % | The percentage distance from the peak price at which the trailing stop is maintained. |

### 3.4 Time Windows

This section defines the specific hours during which trading is permitted, separated by exchange.

For the **NSE (National Stock Exchange)**, users can configure the number of minutes after market open (9:15 AM IST) and before market close (3:30 PM IST) during which trading is blocked. A toggle allows users to suspend trading during a specified lunch period, with time inputs to define the exact start and end times.

For the **MCX (Multi Commodity Exchange)**, users can configure the number of minutes after market open (9:00 AM IST) and before market close (11:30 PM IST) during which trading is blocked.

### 3.5 Expiry Controls

This section provides granular risk management rules specific to the expiry days of different instruments (NIFTY 50, BANK NIFTY, CRUDE OIL, NATURAL GAS).

| Setting | Description |
|---|---|
| **Block on Expiry Day** | A toggle to completely prevent trading of the instrument on its expiry day. |
| **Block Days Before** | The number of days prior to expiry when trading is blocked. |
| **Reduce Position Size** | A toggle to automatically reduce the maximum allowed position size as expiry approaches. |
| **Reduce To (%)** | The percentage to which the normal position size is reduced. |
| **Warning Banner** | A toggle to display a prominent warning banner in the UI when trading near expiry. |
| **Auto Exit** | A toggle to automatically close open positions before the market closes on expiry day. |
| **Exit Before (min)** | The number of minutes before market close when the auto-exit is triggered. |
| **No Carry to Expiry** | A toggle preventing positions from being carried overnight into the expiry day. |

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

Key defaults include a maximum of 6 trades per day, a ₹5000 maximum daily loss, and a 15-minute cooldown after a loss for discipline settings. Time windows default to 15-minute no-trade zones at the open and close for both NSE and MCX. Expiry controls default to "No Carry to Expiry" enabled for all instruments, with position size reduction disabled. Charges are pre-populated with standard Indian options trading rates, such as a ₹20 flat brokerage fee and 18% GST.

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
