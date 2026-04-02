# WebSocket Hybrid Architecture Specification

**Version:** 1.0
**Project:** Automatic Trading System (ATS)
**Author:** Manus AI
**Status:** Approved

---

## 1. Overview

This specification defines the hybrid data architecture for the ATS Python pipeline, replacing the current 5-second REST API polling model with a combination of real-time WebSocket feeds and slow-cycle REST polling. This architecture is a prerequisite for implementing the AI Engine Enhancement v2.4 modules (Momentum Engine, Trade Age Monitor, Execution Timing Engine).

---

## 2. Architecture Components

The hybrid architecture consists of two complementary data channels that serve different purposes within the pipeline.

### 2.1 Component A: Real-Time WebSocket Feed (The Execution Engine)

**Purpose:** Provides sub-second tick data for trade execution, position monitoring, momentum scoring, and volume spike detection.

**Connection:** `wss://api-feed.dhan.co?version=2&token={JWT}&clientId={clientId}&authType=2`

**Subscription Mode:** Full Packet (Code 8) for all subscribed instruments, which provides LTP, Volume, OI, OHLC, Highest/Lowest OI, and 5-level Market Depth in a single packet.

**Data Fields Received:**

| Field | Type | Use Case |
| :--- | :--- | :--- |
| LTP (Last Traded Price) | float32 | SL/TP monitoring, P&L calculation, ATM recalculation |
| Volume | int32 | 1.5x volume spike detection (Execution Timing Engine) |
| Open Interest (OI) | int32 | Momentum Engine (real-time OI change tracking) |
| Highest OI (day) | int32 | Intraday OI range analysis (NSE_FNO only) |
| Lowest OI (day) | int32 | Intraday OI range analysis (NSE_FNO only) |
| Day Open / High / Low | float32 | Bounce/Breakdown Engine, candle strength |
| Bid/Ask (5-level depth) | struct | Slippage estimation, precise entry/exit pricing |
| Previous Day Close + OI | float32/int32 | Daily change percentage baselines |

### 2.2 Component B: Slow-Cycle REST Poller (The Navigation Engine)

**Purpose:** Provides the full option chain with Greeks and IV for strategic analysis — S/R identification, strike selection, PCR calculation, and IV assessment.

**Endpoint:** `POST /v2/optionchain`

**Frequency:** Every 60 seconds (configurable via settings).

**Data Fields Received (not available via WebSocket):**

| Field | Type | Use Case |
| :--- | :--- | :--- |
| Implied Volatility (IV) | float | Theta & IV Protection, Carry Forward (IV stable check) |
| Delta | float | Strike selection (prefer delta 0.4–0.6) |
| Theta | float | Theta decay risk assessment |
| Gamma | float | Advanced risk modeling |
| Vega | float | IV sensitivity analysis |

---

## 3. WebSocket Subscription Rules

### 3.1 Sliding Window: ATM +/- 10 Strikes

For each active instrument, the system subscribes to the **ATM strike and 10 strikes above and below** (21 strikes total), for both CE and PE. This creates a sliding window that moves with the market.

| Instrument | Strike Step | Window Size (points) | Subscriptions (CE + PE) |
| :--- | :--- | :--- | :--- |
| NIFTY 50 | 50 | +/- 500 | 42 |
| BANKNIFTY | 100 | +/- 1000 | 42 |
| CRUDEOIL | 50 | +/- 500 | 42 |
| NATURALGAS | 5 | +/- 50 | 42 |

**Total base subscriptions for 4 instruments:** ~168 security IDs (well within the 5,000 per connection limit).

### 3.2 ATM Recalculation and Window Rebalancing

The ATM strike is recalculated whenever the underlying LTP (received via WebSocket) crosses a strike boundary. When ATM shifts, the system performs a rebalance:

1. **Identify new strikes** that have entered the +/- 10 window.
2. **Subscribe** to the new strikes via the WebSocket.
3. **Unsubscribe** from strikes that have exited the +/- 10 window, unless they are retained by Rule 3.3 or 3.4.

### 3.3 Open Position Strikes (Always Subscribed)

Any strike that has an **open position** must remain subscribed on the WebSocket **regardless of its distance from ATM**. This ensures that SL/TP monitoring and P&L updates continue even if the market moves significantly away from the entry strike.

These strikes are only unsubscribed after the position is fully closed.

### 3.4 Analyzer-Flagged Active Strikes (Dynamic Addition)

If the REST poller's Analyzer identifies a strike outside the +/- 10 window as "active" (e.g., unusually high OI buildup indicating a key S/R level), that strike is **dynamically added** to the WebSocket subscription.

Active strikes are re-evaluated every REST poll cycle (60 seconds). If a previously active strike is no longer flagged, it is unsubscribed (unless retained by Rule 3.2 or 3.3).

### 3.5 Subscription Priority Order

When determining which strikes to subscribe, the following priority applies:

1. **Open position strikes** — always subscribed, never dropped.
2. **ATM +/- 10 window** — the core sliding window.
3. **Analyzer-flagged active strikes** — dynamically added.

### 3.6 Underlying Index Subscription

In addition to option strikes, the system subscribes to the **underlying index or futures contract** (e.g., NIFTY 50 index, BANKNIFTY index) to receive real-time LTP for ATM recalculation and market direction monitoring.

---

## 4. Capacity Estimation

| Component | Count | Notes |
| :--- | :--- | :--- |
| Underlying instruments | 4 | NIFTY, BANKNIFTY, CRUDEOIL, NATURALGAS |
| Base window per instrument | 42 | 21 strikes x 2 (CE + PE) |
| Active strikes per instrument | ~6 | Dynamic, varies |
| Open position strikes | ~4 | Max 4 (1 per instrument) |
| Underlying index/futures | 4 | For ATM recalculation |
| **Total estimated subscriptions** | **~200** | **4% of the 5,000 limit** |

A single WebSocket connection is more than sufficient. The remaining capacity can be used for future instruments or additional expiry monitoring.

---

## 5. How the Two Components Work Together

The interaction between the WebSocket and REST poller follows a clear separation of concerns:

1. **Every 60 seconds**, the REST poller fetches the full option chain and the Analyzer processes it to identify S/R levels, PCR ratio, IV assessment, Greeks, and active strikes.

2. **The Analyzer output** tells the AI Engine: *"The 24150 CE has Delta 0.52, IV is stable at 14.2%, support is at 24000 with 75/100 strength, and strike 23500 PE has unusual OI buildup."*

3. **The WebSocket** monitors the 24150 CE tick-by-tick. When it detects a 1.5x volume spike and strong momentum, the Execution Timing Engine triggers the trade instantly.

4. **Post-entry**, the WebSocket feeds the Momentum Engine and Trade Age Monitor with real-time LTP, volume, and OI for the held strike, enabling dynamic exit decisions.

---

## 6. Configuration Parameters

All parameters below should be centralized in the system settings module.

| Parameter | Default Value | Description |
| :--- | :--- | :--- |
| `WS_STRIKE_WINDOW` | 10 | Number of strikes above and below ATM to subscribe |
| `WS_SUBSCRIPTION_MODE` | `FULL` | Packet type: TICKER, QUOTE, or FULL |
| `REST_POLL_INTERVAL` | 60 | Seconds between full option chain REST API calls |
| `WS_REBALANCE_ON_ATM_SHIFT` | true | Whether to rebalance subscriptions when ATM changes |
| `WS_MAX_CONNECTIONS` | 1 | Number of WebSocket connections to maintain |

---

## 7. References

- [1] DhanHQ API Documentation: Live Market Feed — https://dhanhq.co/docs/v2/live-market-feed/
- [2] DhanHQ API Documentation: Option Chain — https://dhanhq.co/docs/v2/option-chain/
