# ⚠️ DEPRECATED — AI Engine — Module 1: Option Chain Fetcher

> **DEPRECATED (2026-04-13):** The old Python option chain fetcher (`option_chain_fetcher.py`) is in `python_modules/deprecated/`. Replaced by TFA (`tick_feature_agent/feed/chain_poller.py`) which handles chain polling as part of the live feature pipeline.

**Document:** ai-engine-fetcher-spec.md
**Project:** Automatic Trading System (ATS)
**Status:** Authoritative Reference

---

## Revision History

| Version | Date       | Author    | Changes                                                  |
| ------- | ---------- | --------- | -------------------------------------------------------- |
| v1.0    | 2026-04-02 | Manus AI  | Initial specification based on latest Python module source code |
| v1.2    | 2026-04-02 | Manus AI  | Made spec broker-agnostic: replaced direct Dhan API references with Broker Service abstractions |
| v2.0    | 2026-04-02 | Manus AI  | Split from monolithic spec into standalone module spec   |

---

## 1. Overview

**File:** `option_chain_fetcher.py` (241 lines)
**Purpose:** Fetch live option chain data via the Broker Service and save to local JSON files.

The Option Chain Fetcher is the first module in the AI Engine pipeline. It is responsible for acquiring raw market data from the Broker Service and making it available to downstream modules via the local filesystem.

---

## 2. Startup Sequence

The Fetcher performs three steps on startup before entering its main loop:

1. **Authentication Verification**: Calls `GET /api/broker/status` on the Broker Service. If the broker is not connected or the token is expired, the Fetcher aborts immediately. This prevents silent failures where invalid credentials produce empty data.

2. **Instrument Validation**: Verifies that all configured instruments are available via the Broker Service. Instruments that cannot be resolved are skipped in the main loop.

---

## 3. Main Loop

The main loop runs indefinitely with a 5-second sleep between full cycles. Within each cycle:

1. **Poll Active Instruments**: Calls `GET /api/trading/active-instruments` on the dashboard. The response contains the list of instruments the user has enabled. The Fetcher maps dashboard keys (e.g., `NIFTY_50`) to its internal keys (e.g., `NIFTY 50`) using a hardcoded mapping. If the dashboard is unreachable, all instruments are processed as a fallback.

2. **For Each Active Instrument:**
   - **Fetch Expiry List**: Calls `GET /api/broker/expiry-list` on the Broker Service with the instrument identifier. Returns an array of expiry date strings.
   - **Select Current Expiry**: Always uses `expiry_dates[0]` — the nearest expiry.
   - **Fetch Option Chain**: Calls `GET /api/broker/option-chain` on the Broker Service with the instrument identifier and selected expiry date. Returns the full option chain with all strikes, CE/PE data, OI, volume, Greeks, and IV.
   - **Save to Disk**: Writes the response to `output/option_chain_{instrument}.json` (inside the `python_modules/output/` directory).

3. **Rate Limiting**: A configurable delay is inserted between each instrument's API call to respect the active broker's rate limits. The Broker Service handles its own internal rate limiting (see `broker-service-spec-v1.2.md`), but the Fetcher adds a courtesy delay to avoid overwhelming the service.

---

## 4. Broker Service Communication

All market data requests are routed through the Broker Service REST API. The Fetcher does not manage any broker credentials directly. Authentication, token rotation, and error handling are fully delegated to the Broker Service (see `broker-service-spec-v1.2.md`, Steps 0.3 and 0.4).

---

## 5. Output Schema

The Fetcher writes the option chain response from the Broker Service. The key structure is:

```json
{
  "last_price": 24150.50,
  "oc": {
    "24000.000000": {
      "ce": {
        "oi": 1250000,
        "volume": 85000,
        "last_price": 185.50,
        "implied_volatility": 14.2,
        "greeks": { "delta": 0.55, "theta": -5.2, "gamma": 0.002, "vega": 12.1 },
        "previous_oi": 1200000
      },
      "pe": {
        "oi": 980000,
        "volume": 62000,
        "last_price": 42.30,
        "implied_volatility": 15.1,
        "greeks": { "delta": -0.45, "theta": -4.8, "gamma": 0.002, "vega": 11.8 }
      }
    }
  },
  "expiry_date": "2026-04-03",
  "target_expiry_date": "2026-04-03"
}
```

Strike keys are formatted as `"24000.000000"` (6 decimal places) for all instruments.

---

## 6. Testing

The Fetcher's core logic (row-to-oc conversion, exchange segment mapping, instrument name mapping, expiry selection) is covered by the `TestOptionChainFetcher` class in `python_modules/test_python_modules.py` (7 tests). The Broker Service endpoints used by the Fetcher (token status, expiry list, option chain, MCX FUTCOM resolution) are tested in `server/broker/brokerPythonEndpoints.test.ts` (30 tests).

---

*End of specification.*
