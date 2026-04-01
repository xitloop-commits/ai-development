# AI Engine — Technical Specification

**Document:** ai-engine-spec-v1.md
**Project:** Automatic Trading System (ATS)
**Status:** Authoritative Reference

---

## Revision History

| Version | Date       | Author    | Changes                                                  |
| ------- | ---------- | --------- | -------------------------------------------------------- |
| v1.0    | 2026-04-02 | Manus AI  | Initial specification based on latest Python module source code |

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [Module 1 — Option Chain Fetcher](#3-module-1--option-chain-fetcher)
4. [Module 2 — Option Chain Analyzer](#4-module-2--option-chain-analyzer)
5. [Module 3 — AI Decision Engine](#5-module-3--ai-decision-engine)
6. [Module 4 — Execution Module](#6-module-4--execution-module)
7. [Module 5 — Dashboard Data Pusher](#7-module-5--dashboard-data-pusher)
8. [Inter-Module Communication](#8-inter-module-communication)
9. [Data Schemas](#9-data-schemas)
10. [Configuration Reference](#10-configuration-reference)
11. [News Sentiment Engine](#11-news-sentiment-engine)
12. [Event Calendar](#12-event-calendar)
13. [Dashboard Integration](#13-dashboard-integration)
14. [Planned Migrations](#14-planned-migrations)
15. [Testing](#15-testing)
16. [Appendix A — Keyword Dictionaries](#appendix-a--keyword-dictionaries)
17. [Appendix B — File Inventory](#appendix-b--file-inventory)

---

## 1. Overview

The AI Engine is the analytical core of the Automatic Trading System. It is a 5-module Python pipeline that runs as separate long-lived processes alongside the Node.js dashboard. The pipeline ingests real-time option chain data from the Dhan API v2, performs multi-layered analysis (OI structure, market bias, news sentiment, IV assessment, theta risk), produces scored trade signals with complete trade setups, and optionally executes paper or live trades.

The system covers four instruments: **NIFTY 50**, **BANK NIFTY**, **CRUDE OIL**, and **NATURAL GAS** — spanning both NSE (equity index options) and MCX (commodity options) exchanges. Each instrument is analyzed independently in every cycle, producing a self-contained decision JSON with 45+ fields.

The pipeline's primary design principle is **modularity through file-based decoupling**. Each module reads input from JSON files written by the upstream module and writes its own output to JSON files for the downstream module. This architecture allows any module to be restarted, replaced, or tested independently without affecting the rest of the pipeline.

---

## 2. System Architecture

### 2.1 Pipeline Data Flow

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL DATA SOURCES                                  │
│  ┌─────────────┐  ┌──────────────────┐  ┌──────────────────────────────────┐    │
│  │  Dhan API v2 │  │  Dhan Scrip      │  │  NewsData.io API                │    │
│  │  (Option     │  │  Master CSV      │  │  (News articles + sentiment)    │    │
│  │   Chain +    │  │  (Security ID    │  │                                  │    │
│  │   Expiry)    │  │   resolution)    │  │                                  │    │
│  └──────┬───────┘  └────────┬─────────┘  └──────────────┬───────────────────┘    │
│         │                   │                            │                        │
└─────────┼───────────────────┼────────────────────────────┼────────────────────────┘
          │                   │                            │
          ▼                   ▼                            │
  ┌───────────────────────────────────┐                    │
  │  MODULE 1: Option Chain Fetcher   │                    │
  │  (dhan_option_chain_fetcher.py)   │                    │
  │  • Auth verification              │                    │
  │  • MCX security ID resolution     │                    │
  │  • Expiry list + option chain     │                    │
  │  • Rate limiting (3s/req, 5s/cyc) │                    │
  └──────────────┬────────────────────┘                    │
                 │                                         │
                 │  option_chain_{instrument}.json          │
                 ▼                                         │
  ┌───────────────────────────────────┐                    │
  │  MODULE 2: Option Chain Analyzer  │                    │
  │  (option_chain_analyzer.py)       │                    │
  │  • 9 analysis functions           │                    │
  │  • Opening OI snapshot system     │                    │
  │  • Intraday S/R tracking          │                    │
  └──────────────┬────────────────────┘                    │
                 │                                         │
                 │  analyzer_output_{instrument}.json       │
                 ▼                                         ▼
  ┌───────────────────────────────────────────────────────────┐
  │  MODULE 3: AI Decision Engine                             │
  │  (ai_decision_engine.py)                                  │
  │  • 6-factor weighted scoring                              │
  │  • Wall strength analysis                                 │
  │  • IV + theta assessment                                  │
  │  • News sentiment (multi-query, weighted keywords)        │
  │  • Trade setup generation (entry/target/SL/R:R)           │
  │  • Risk flag computation                                  │
  └──────────────┬────────────────────────────────────────────┘
                 │
                 │  ai_decision_{instrument}.json
                 ▼
  ┌───────────────────────────────────┐
  │  MODULE 4: Execution Module       │
  │  (execution_module.py)            │
  │  • Paper / live trade execution   │
  │  • Real-time SL/TP monitoring     │
  │  • Position push to dashboard     │
  └──────────────┬────────────────────┘
                 │
                 │  Direct REST API calls
                 ▼
  ┌───────────────────────────────────┐      ┌─────────────────────────┐
  │  MODULE 5: Dashboard Data Pusher  │─────▶│  Node.js Dashboard      │
  │  (dashboard_data_pusher.py)       │      │  (REST API endpoints)   │
  │  • File-mtime change detection    │      │  /api/trading/*         │
  │  • 3 data types pushed            │      └─────────────────────────┘
  │  • Heartbeat every cycle          │
  └───────────────────────────────────┘
```

### 2.2 Process Model

Each module runs as an independent Python process with its own infinite loop. All five processes are started manually or via a process manager. They share no memory; their only communication channel is the local filesystem (JSON files) and the dashboard REST API.

| Module               | Process                                    | Cycle Time                  | Dependencies                              |
| -------------------- | ------------------------------------------ | --------------------------- | ----------------------------------------- |
| Option Chain Fetcher | `python3 dhan_option_chain_fetcher.py`     | ~5s + 3s per instrument     | Dhan API v2, Dhan Scrip Master            |
| Option Chain Analyzer| `python3 option_chain_analyzer.py`         | 5s                          | Fetcher output files                      |
| AI Decision Engine   | `python3 ai_decision_engine.py`            | 5s                          | Analyzer output files, NewsData.io API    |
| Execution Module     | `python3 execution_module.py`              | 5s                          | AI Decision files, Option Chain files, Dhan Scrip Master |
| Data Pusher          | `python3 dashboard_data_pusher.py`         | 3s                          | All output files, Dashboard REST API      |

### 2.3 Instrument Configuration

| Instrument    | Dashboard Key  | Fetcher Key    | Exchange  | Security ID    | Lot Size |
| ------------- | -------------- | -------------- | --------- | -------------- | -------- |
| NIFTY 50      | `NIFTY_50`     | `NIFTY 50`     | IDX_I (NSE) | 13 (fixed)   | 75       |
| BANK NIFTY    | `BANKNIFTY`    | `BANKNIFTY`    | IDX_I (NSE) | 25 (fixed)   | 30       |
| CRUDE OIL     | `CRUDEOIL`     | `CRUDEOIL`     | MCX_COMM  | Auto-resolved  | 100      |
| NATURAL GAS   | `NATURALGAS`   | `NATURALGAS`   | MCX_COMM  | Auto-resolved  | 1250     |

NSE index instruments use fixed security IDs. MCX commodity instruments require automatic resolution at startup: the Fetcher downloads the Dhan scrip master CSV, filters for FUTCOM rows matching the symbol name, and selects the nearest-month contract by expiry date.

---

## 3. Module 1 — Option Chain Fetcher

**File:** `dhan_option_chain_fetcher.py` (241 lines)
**Purpose:** Fetch live option chain data from Dhan API v2 and save to local JSON files.

### 3.1 Startup Sequence

The Fetcher performs three steps on startup before entering its main loop:

1. **MCX Security ID Resolution** (`resolve_security_ids()`): Downloads the Dhan scrip master CSV (~200 MB) from `https://images.dhan.co/api-data/api-scrip-master.csv`. For each MCX instrument with `auto_resolve: True`, it filters rows where `SEM_INSTRUMENT_NAME == "FUTCOM"` and `SM_SYMBOL_NAME` matches the target symbol. It collects all future/current expiry dates, sorts ascending, and picks the nearest-month contract's `SEM_SMST_SECURITY_ID`. This ensures the system always uses the active futures contract, even after monthly expiry rollover.

2. **Authentication Verification** (`test_profile_api()`): Calls `GET /v2/profile` with the configured access token. If this returns anything other than HTTP 200, the Fetcher aborts immediately. This prevents silent failures where expired tokens produce empty data.

3. **Instrument Validation**: Iterates all instruments and warns if any MCX instrument still has `security_id: None` after resolution. Such instruments are skipped in the main loop.

### 3.2 Main Loop

The main loop runs indefinitely with a 5-second sleep between full cycles. Within each cycle:

1. **Poll Active Instruments**: Calls `GET /api/trading/active-instruments` on the dashboard. The response contains the list of instruments the user has enabled. The Fetcher maps dashboard keys (e.g., `NIFTY_50`) to its internal keys (e.g., `NIFTY 50`) using a hardcoded mapping. If the dashboard is unreachable, all instruments are processed as a fallback.

2. **For Each Active Instrument:**
   - **Fetch Expiry List**: `POST /v2/optionchain/expirylist` with `UnderlyingScrip` (security ID) and `UnderlyingSeg` (exchange segment). Returns an array of expiry date strings.
   - **Select Current Expiry**: Always uses `expiry_dates[0]` — the nearest expiry.
   - **Fetch Option Chain**: `POST /v2/optionchain` with the security ID, exchange segment, and selected expiry date. Returns the full option chain with all strikes, CE/PE data, OI, volume, IV, Greeks, and LTP.
   - **Save to Disk**: Writes the raw JSON response to `option_chain_{instrument_key}.json` in the data directory. The filename uses the Fetcher's internal key with spaces replaced by underscores and lowercased (e.g., `option_chain_nifty_50.json`).

3. **Rate Limiting**: A 3-second `time.sleep()` is inserted between each instrument's API call to respect Dhan's rate limits.

### 3.3 Dhan API Authentication

All API calls use two headers:

| Header         | Value                              |
| -------------- | ---------------------------------- |
| `access-token` | Dhan JWT access token              |
| `client-id`    | Dhan client ID (numeric string)    |

The token is currently hardcoded in the module. The planned migration (Feature 21) will move token management to the Broker Service's DhanAdapter, which supports token rotation, validation via fund limit check, and 401 auto-detection.

### 3.4 Output Schema

The Fetcher writes the raw Dhan API response. The key structure is:

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

## 4. Module 2 — Option Chain Analyzer

**File:** `option_chain_analyzer.py` (743 lines)
**Purpose:** Analyze raw option chain data to produce structured signals, S/R levels, market bias, and intraday OI tracking.

### 4.1 State Management

The Analyzer maintains two categories of state:

**In-Memory State** (`previous_option_chain_data`): A dictionary keyed by instrument name, storing the previous cycle's option chain data. This enables cycle-over-cycle comparison for OI change, volume change, and price change calculations. On the first cycle for any instrument, the current data is stored as "previous" and no signals are generated.

**Persistent State** (`opening_oi_snapshots`): The Opening OI Snapshot system captures the first option chain data of each trading day and persists it to disk in the `opening_snapshots/` directory. Files are named `opening_{instrument}_{date}.json`. This survives process restarts and enables intraday OI change tracking relative to market open.

### 4.2 Analysis Functions

The Analyzer runs 9 analysis functions sequentially for each active instrument. Each function receives the current and previous option chain data and returns structured results.

#### 4.2.1 Active Strikes (`identify_active_strikes`)

Identifies the most significant strikes by finding the intersection of three top-N lists for both calls and puts:

1. Top N strikes by absolute OI
2. Top N strikes by absolute OI change (vs previous cycle)
3. Top N strikes by volume

The default `top_n` is 3. A strike must appear in all three lists to qualify as "active." This intersection approach filters out strikes that are merely high-OI (legacy positions) without current activity, and strikes with high volume but low OI (speculative noise).

**Output:** `{"call": [24000, 24100], "put": [23900, 23800]}`

#### 4.2.2 Support and Resistance Levels (`identify_support_resistance`)

Identifies the top 5 support and resistance levels using OI-based analysis:

**Resistance** is determined by Call OI. All strikes with CE data are collected with their OI, OI change, and distance from LTP. The strike with the highest absolute Call OI becomes `main_resistance`. The top 5 are ranked by a composite sort: primary key is OI (descending), secondary is OI change (descending), tertiary is distance from LTP (ascending, i.e., closer to LTP ranks higher).

**Support** follows the same logic using Put OI. The strike with the highest absolute Put OI becomes `main_support`.

**Output:** `main_support`, `main_resistance`, `support_levels[5]`, `resistance_levels[5]`

#### 4.2.3 Market Bias (`identify_market_bias`)

Computes the aggregate Call OI vs Put OI across all strikes:

| Condition                              | Bias         |
| -------------------------------------- | ------------ |
| Total Call OI > Total Put OI x 1.2     | Bearish (heavy call writing = resistance) |
| Total Put OI > Total Call OI x 1.2     | Bullish (heavy put writing = support)     |
| Otherwise                              | Range-bound  |

This interpretation follows the option-writing perspective: high Call OI means writers are selling calls (expecting price to stay below), which is bearish. High Put OI means writers are selling puts (expecting price to stay above), which is bullish.

**Output:** `"Bullish"` | `"Bearish"` | `"Range-bound"`

#### 4.2.4 OI Change Signals (`analyze_signals`)

Classifies OI changes at each strike into one of 8 signal types based on the combination of OI change direction and price change direction:

| OI Change | Price Change | Call Signal          | Put Signal           |
| --------- | ------------ | -------------------- | -------------------- |
| OI up     | Price up     | Call Long Buildup    | Put Short Buildup    |
| OI up     | Price down   | Call Short Buildup   | Put Long Buildup     |
| OI down   | Price up     | Call Short Covering  | Put Long Unwinding   |
| OI down   | Price down   | Call Long Unwinding  | Put Short Covering   |

Additionally, two special signals are detected:

**Call/Put Writing (Resistance/Support Creation):** When OI increases at a strike within 0.5% of the current LTP, it signals active resistance or support creation at the current price level.

**Trap Situation (Danger Zone):** When the same strike shows both Call Long Buildup and Put Short Buildup simultaneously, it indicates a potential trap where both sides are building positions — a dangerous zone for directional trades.

**Output:** Array of human-readable signal strings with strike, OI change, and price change values.

#### 4.2.5 S/R Strength Assessment (`assess_sr_strength`)

Tracks whether existing support and resistance levels are strengthening or weakening over time by comparing OI changes at those specific strikes:

For each support level, it checks Put OI change: increasing = "strengthening," decreasing = "weakening." For each resistance level, it checks Call OI change: increasing = "strengthening," decreasing = "weakening."

**Output:** Array of strings like `"Support at 24000 is strengthening (Put OI increased by 15000)"`

#### 4.2.6 Entry Strategy Signals (`analyze_entry_strategy`)

Generates directional entry signals when price is near a key S/R level with confirming OI conditions:

**CALL BUY Entry** (near support): Triggered when price is within 0.5% of `main_support` AND total Put OI is increasing (support holding) AND total Call OI is decreasing (resistance weakening). This combination suggests the price will bounce off support.

**PUT BUY Entry** (near resistance): Triggered when price is within 0.5% of `main_resistance` AND total Call OI is increasing (resistance holding) AND total Put OI is decreasing (support weakening). This combination suggests the price will reject from resistance.

**Output:** Array of entry signal strings with OI change values.

#### 4.2.7 Real-Time Breakout/Breakdown Signals (`analyze_real_time_signals`)

Detects strong directional moves when price crosses a key S/R level with confirming OI shifts:

**Strong Bullish Breakout:** Price is above `main_resistance` AND Call OI at resistance is decreasing (writers exiting/covering) AND total Put OI is increasing (new support being built above old resistance). This is the classic "resistance becomes support" breakout pattern.

**Strong Bearish Breakdown:** Price is below `main_support` AND Put OI at support is decreasing (writers exiting/covering) AND total Call OI is increasing (new resistance being built below old support).

**Output:** Array of breakout/breakdown signal strings.

#### 4.2.8 Exit Strategy Signals (`analyze_exit_strategy`)

Detects potential exit conditions based on aggregate OI shifts:

| Condition                                | Signal                              |
| ---------------------------------------- | ----------------------------------- |
| Total Put OI up AND Total Call OI down   | Bearish shift — exit long positions |
| Total Call OI up AND Total Put OI down   | Bullish shift — exit short positions|

This is a simplified implementation. The spec notes that a more sophisticated version would track OI change direction flips, volume drops, and price stagnation.

**Output:** Array of exit signal strings.

#### 4.2.9 Smart Money Tracking (`analyze_smart_money_tracking`)

Detects coordinated OI and price movements that suggest institutional activity:

**Strong Bullish Setup:** Total Put OI increasing (put writing = support) AND Total Call OI decreasing (call unwinding = resistance weakening) AND Price moving up. All three conditions must be true simultaneously — this is the highest-conviction bullish signal.

**Strong Bearish Setup:** Total Call OI increasing (call writing = resistance) AND Total Put OI decreasing (put unwinding = support weakening) AND Price moving down.

**Output:** Array of smart money signal strings with OI change and price change values.

### 4.3 Opening OI Snapshot System

The Opening OI Snapshot captures the first option chain data of each trading day and enables intraday OI change tracking. This is critical for understanding how the market structure has evolved since the open.

#### 4.3.1 Capture Logic (`capture_opening_snapshot_if_needed`)

On each cycle, the system checks:

1. **In-memory cache**: If a snapshot for today's date exists in `opening_oi_snapshots`, return it.
2. **Disk persistence**: If a file `opening_{instrument}_{date}.json` exists in the `opening_snapshots/` directory with today's date, load and cache it.
3. **New capture**: If no snapshot exists and the current time is between 9:00 AM and 4:00 PM IST, capture the current data as the opening snapshot, save to disk, and cache in memory.

The snapshot stores the full option chain data, the capture timestamp, the date, and the opening LTP.

#### 4.3.2 Intraday OI Change Computation (`compute_intraday_oi_changes`)

For each S/R level (support levels + resistance levels + ATM strike), the system computes:

| Field                                        | Description                                          |
| -------------------------------------------- | ---------------------------------------------------- |
| `strike`                                     | The strike price                                     |
| `type`                                       | `"support"`, `"resistance"`, or `"atm"`              |
| `call_oi` / `put_oi`                         | Current CE/PE OI                                     |
| `opening_call_oi` / `opening_put_oi`         | Opening snapshot CE/PE OI                            |
| `call_oi_intraday_change` / `put_oi_intraday_change` | Absolute change since open                  |
| `call_change_pct` / `put_change_pct`         | Percentage change since open                         |
| `call_activity` / `put_activity`             | Human-readable activity label                        |
| `wall_strength`                              | 0–100 normalized score based on relevant OI vs max   |
| `is_atm`                                     | Boolean — whether this strike is the ATM strike      |

#### 4.3.3 Activity Classification (`classify_oi_activity`)

OI changes are classified into human-readable labels based on the magnitude and direction of change:

| Change % | OI Direction | Call Label           | Put Label            |
| -------- | ------------ | -------------------- | -------------------- |
| < 2%     | Any          | Holding Steady       | Holding Steady       |
| > 10%    | Increasing   | Heavy Call Writing   | Heavy Put Writing    |
| > 0%     | Increasing   | Sellers Entering     | Sellers Entering     |
| < -10%   | Decreasing   | Short Covering       | Short Covering       |
| < 0%     | Decreasing   | Sellers Exiting      | Sellers Exiting      |

These labels are displayed in the dashboard's S/R Strength Line component.

### 4.4 Output Schema

The Analyzer writes `analyzer_output_{instrument}.json` with the following structure:

```json
{
  "instrument": "NIFTY_50",
  "timestamp": "2026-04-02 10:15:30",
  "last_price": 24150.50,
  "active_strikes": { "call": [24200, 24300], "put": [24000, 23900] },
  "main_support": 24000,
  "main_resistance": 24300,
  "support_levels": [23800, 23900, 24000, 24050, 24100],
  "resistance_levels": [24200, 24250, 24300, 24400, 24500],
  "market_bias": "Bullish",
  "oi_change_signals": ["Call Short Buildup at 24300 (OI Change: 25000, Price Change: -12.50)", "..."],
  "entry_signals": ["CALL BUY Entry Signal: Price near Support 24000, ..."],
  "real_time_signals": [],
  "exit_signals": [],
  "smart_money_signals": ["Strong Bullish Setup: Put OI increasing (45000), ..."],
  "opening_snapshot": { "captured_at": "09:16:05", "opening_ltp": 24120.00 },
  "sr_intraday_levels": [
    {
      "strike": 24000, "type": "support",
      "call_oi": 850000, "put_oi": 1250000,
      "opening_call_oi": 820000, "opening_put_oi": 1180000,
      "call_oi_intraday_change": 30000, "put_oi_intraday_change": 70000,
      "call_change_pct": 3.7, "put_change_pct": 5.9,
      "call_activity": "Sellers Entering", "put_activity": "Heavy Put Writing",
      "relevant_oi": 1250000, "wall_strength": 85, "is_atm": false
    }
  ]
}
```

---

## 5. Module 3 — AI Decision Engine

**File:** `ai_decision_engine.py` (1215 lines)
**Purpose:** Produce a scored trade direction (GO_CALL / GO_PUT / WAIT) with confidence, complete trade setup, and risk assessment for each instrument.

### 5.1 Input Sources

The AI Decision Engine consumes three data sources per instrument:

1. **Analyzer Output** (`analyzer_output_{instrument}.json`): Market bias, S/R levels, entry/exit/breakout signals, smart money signals.
2. **Raw Option Chain** (`option_chain_{instrument}.json`): Live strike data for wall strength analysis, IV assessment, theta assessment, and trade setup pricing.
3. **News Sentiment** (fetched live from NewsData.io API): Multi-query weighted keyword scoring with event calendar awareness.

### 5.2 Wall Strength Analysis

The `analyze_wall_strength` function scores each S/R level on a 0–100 scale and predicts whether price will break through or bounce off.

#### 5.2.1 Scoring Factors

The base score starts at 50 and is adjusted by three factors:

**Factor 1 — Absolute OI vs Average** (up to +25 / -10 points):

| OI Ratio (vs avg across all strikes) | Score Adjustment |
| ------------------------------------- | ---------------- |
| > 3.0x average                        | +25              |
| > 1.5x average                        | +15              |
| <= 1.5x average                       | -10              |

**Factor 2 — OI Change Direction** (up to +15 / -20 points):

| OI Change                | Score Adjustment |
| ------------------------ | ---------------- |
| Increasing (wall building) | +15            |
| Decreasing (wall crumbling)| -20            |
| Unchanged                | 0                |

**Factor 3 — Volume vs Average** (up to +10 points):

| Volume Ratio             | Score Adjustment |
| ------------------------ | ---------------- |
| > 2.0x average           | +10              |
| > 1.0x average           | 0                |
| <= 1.0x average          | 0                |

The final score is clamped to [0, 100].

#### 5.2.2 Prediction Logic

| Strength Score | Support Prediction | Resistance Prediction | Probability                     |
| -------------- | ------------------ | --------------------- | ------------------------------- |
| < 35           | BREAKDOWN          | BREAKOUT              | 50 + (35 - strength), max 85    |
| > 65           | BOUNCE             | BOUNCE                | 50 + (strength - 65), max 85    |
| 35–65          | UNCERTAIN          | UNCERTAIN             | 50                              |

Each prediction includes an evidence array — human-readable strings explaining each scoring factor's contribution.

#### 5.2.3 Wall Type Mapping

For **resistance walls**, the analysis uses Call OI data at the strike. High Call OI means many call writers are defending that level — a strong resistance wall.

For **support walls**, the analysis uses Put OI data at the strike. High Put OI means many put writers are defending that level — a strong support floor.

### 5.3 IV Assessment

The `assess_iv` function evaluates whether ATM options are fairly priced, cheap, or expensive relative to the overall IV surface.

**Method:** The ATM IV is taken as the maximum of CE and PE implied volatility at the ATM strike. This is compared to the average IV across all strikes (both CE and PE) in the option chain.

| IV Ratio (ATM / Average) | Assessment | Implication                                  |
| ------------------------ | ---------- | -------------------------------------------- |
| > 1.3                    | EXPENSIVE  | Options overpriced — risk of IV crush        |
| < 0.8                    | CHEAP      | Options fairly/under-priced — favorable for buyers |
| 0.8–1.3                  | FAIR       | Normal pricing                               |

**Output:** `{"atm_iv": 14.2, "assessment": "FAIR", "detail": "ATM IV 14.2% is near average — fair pricing"}`

### 5.4 Theta Assessment

The `assess_theta` function evaluates time decay risk based on days to expiry (DTE).

**Method:** Extracts the theta value from ATM strike Greeks (maximum of CE and PE theta). Parses the expiry date from the analyzer output, supporting multiple date formats (`%Y-%m-%d`, `%d-%m-%Y`, `%Y-%m-%d %H:%M:%S`).

| DTE  | Warning Level | Warning Text                                          |
| ---- | ------------- | ----------------------------------------------------- |
| <= 1 | CRITICAL      | "Expiry tomorrow — theta decay is extreme"            |
| <= 2 | HIGH RISK     | "2 days to expiry — theta decay accelerating"         |
| <= 4 | CAUTION       | "N days to expiry — theta decay significant"          |
| > 4  | None          | No warning                                            |

**Output:** `{"theta_per_day": 5.20, "days_to_expiry": 3, "warning": "CAUTION: 3 days to expiry..."}`

### 5.5 Weighted Scoring Engine

The `compute_weighted_score` function is the central decision-making algorithm. It combines six factors into a single weighted score that determines trade direction and confidence.

#### 5.5.1 Factor Definitions

**Factor 1: OI Support/Resistance (Weight: 30%)**

| Condition                                                | Score |
| -------------------------------------------------------- | ----- |
| Strong support (>60) + weak resistance (<40)             | +0.8  |
| Strong support (>60) + resistance BREAKOUT prediction    | +0.9  |
| Strong resistance (>60) + weak support (<40)             | -0.8  |
| Strong resistance (>60) + support BREAKDOWN prediction   | -0.9  |
| Support strength > resistance strength                   | +0.3  |
| Resistance strength > support strength                   | -0.3  |

**Factor 2: OI Change Momentum (Weight: 25%)**

Counts bullish and bearish keywords in the analyzer's entry signals, real-time signals, and smart money signals:

- **Bullish keywords:** "bullish", "call buy", "put writing", "put short buildup"
- **Bearish keywords:** "bearish", "put buy", "call writing", "call short buildup"

Score = `(bullish_count - bearish_count) x 0.3`, clamped to [-1.0, +1.0].

**Factor 3: IV Level (Weight: 15%)**

| Assessment | Score |
| ---------- | ----- |
| CHEAP      | +0.5  |
| FAIR       | +0.2  |
| EXPENSIVE  | -0.5  |

**Factor 4: PCR Trend (Weight: 10%)**

| PCR Ratio | Score                                            |
| --------- | ------------------------------------------------ |
| > 1.2     | +0.7 (Bullish — heavy put writing = strong support) |
| > 1.0     | +0.3                                             |
| < 0.8     | -0.7 (Bearish — heavy call writing = strong resistance) |
| < 1.0     | -0.3                                             |

**Factor 5: News Sentiment (Weight: 10% or 15%)**

The base weight is 10%, but increases to 15% on event days (when the event calendar has upcoming events for this instrument). The score is computed as:

```
conf_mult = min(1.0, news_confidence / 80)
strength_mult = max(conf_mult, 1.0 if Strong, 0.6 if Moderate, 0.3 if Mild)
score = +/-0.5 x strength_mult
```

**Factor 6: Theta Risk (Weight: 10%)**

| DTE  | Score |
| ---- | ----- |
| <= 1 | -0.8  |
| <= 2 | -0.5  |
| <= 4 | -0.2  |
| > 4  | +0.3  |

#### 5.5.2 Direction Determination

```
total_score = Sum(factor_score x factor_weight)

if total_score > 0.15  -> GO_CALL
if total_score < -0.15 -> GO_PUT
else                   -> WAIT
```

The +/-0.15 threshold creates a dead zone that prevents marginal signals from triggering trades. This is a deliberate design choice to reduce noise and only act on clear directional conviction.

#### 5.5.3 Confidence Calculation

```
confidence = min(0.95, abs(total_score) x 1.5)

if direction != WAIT:
    confidence = max(0.30, confidence)
```

The confidence is capped at 95% (the system never claims certainty) and floored at 30% when a direction is given (if the engine decided to trade, it has at least 30% conviction).

### 5.6 Trade Setup Generator

When the direction is GO_CALL or GO_PUT, the `generate_trade_setup` function produces a complete trade plan.

#### 5.6.1 Strike Selection

The ATM strike is calculated as: `round(LTP / step) x step`, where `step` is the instrument's strike step size (NIFTY: 50, BANKNIFTY: 100, CRUDEOIL: 50, NATURALGAS: 5).

#### 5.6.2 Entry Price

The entry price is the live `last_price` of the ATM CE (for GO_CALL) or ATM PE (for GO_PUT) from the option chain data.

#### 5.6.3 Target Calculation

The target is based on the distance to the relevant S/R level, adjusted by the wall strength prediction and the option's delta:

**For GO_CALL:**
- Distance to resistance = `resistance_level - LTP`
- If resistance prediction is BREAKOUT: `target_move = distance x 1.5` (expect price to overshoot)
- If resistance prediction is BOUNCE: `target_move = distance x 0.8` (expect price to stall near resistance)
- `target_price = entry_price + (target_move x |delta|)`
- Fallback: `entry_price x 1.3` if delta is zero

**For GO_PUT:**
- Distance to support = `LTP - support_level`
- If support prediction is BREAKDOWN: `target_move = distance x 1.5`
- If support prediction is BOUNCE: `target_move = distance x 0.8`
- `target_price = entry_price + (target_move x |delta|)`

#### 5.6.4 Stop Loss Calculation

The stop loss is based on the distance to the opposite S/R level:

**For GO_CALL:**
- Distance to support = `LTP - support_level`
- `sl_move = distance x 0.6`
- `sl_price = entry_price - (sl_move x |delta|)`
- Floor: `max(sl_price, entry_price x 0.5)` — SL never exceeds 50% of entry

**For GO_PUT:**
- Distance to resistance = `resistance_level - LTP`
- `sl_move = distance x 0.6`
- `sl_price = entry_price - (sl_move x |delta|)`
- Floor: `max(sl_price, entry_price x 0.5)`

#### 5.6.5 Risk:Reward Ratio

```
risk   = entry_price - sl_price
reward = target_price - entry_price
R:R    = reward / risk (rounded to 1 decimal)
```

#### 5.6.6 Trade Setup Output

```json
{
  "direction": "GO_CALL",
  "strike": 24150,
  "option_type": "CE",
  "entry_price": 185.50,
  "target_price": 241.15,
  "target_pct": 30.0,
  "stop_loss": 148.40,
  "sl_pct": 20.0,
  "risk_reward": 1.5,
  "target_label": "Breakout target beyond 24300",
  "delta": 0.550,
  "resistance_level": 24300,
  "support_level": 24000
}
```

### 5.7 Risk Flags

The `compute_risk_flags` function generates warning and danger flags for the trade:

| Condition                                  | Type    | Flag Text                                                       |
| ------------------------------------------ | ------- | --------------------------------------------------------------- |
| IV assessment is EXPENSIVE                 | warning | "IV is elevated at X% — risk of IV crush even if direction is right" |
| Theta warning exists                       | danger  | (Theta warning text from assessment)                            |
| GO_CALL + resistance strength > 70         | warning | "Strong resistance at X — may cap upside"                       |
| GO_PUT + support strength > 70             | warning | "Strong support at X — may cap downside"                        |
| GO_CALL + support strength < 30            | danger  | "Support at X is weak — SL may get hit quickly"                 |
| GO_PUT + resistance strength < 30          | danger  | "Resistance at X is weak — SL may get hit quickly"              |

### 5.8 Decision Output Schema

The AI Decision Engine writes `ai_decision_{instrument}.json` with a dual-format structure that maintains backward compatibility with the legacy format while providing enhanced fields:

```json
{
  "instrument": "NIFTY_50",
  "timestamp": "2026-04-02 10:15:35",
  "decision": "GO",
  "trade_type": "CALL_BUY",
  "confidence_score": 0.72,
  "rationale": "OI Support Resistance: bullish — Support: 75/100 (BOUNCE), ...",
  "market_bias_oc": "Bullish",
  "market_bias_news": "Bullish",
  "active_strikes": { "call": ["..."], "put": ["..."] },
  "main_support": 24000,
  "main_resistance": 24300,
  "entry_signal_details": null,
  "news_summary": "News: Bullish (Strong, 85% conf from 23 articles)",
  "target_strike": null,
  "target_expiry_date": "2026-04-03",
  "trade_direction": "GO_CALL",
  "atm_strike": 24150,
  "ltp": 24155.30,
  "support_analysis": {
    "level": 24000, "strength": 75, "prediction": "BOUNCE", "probability": 60,
    "evidence": ["..."], "oi": 1250000, "oi_change": 70000, "oi_change_pct": 5.9,
    "volume": 85000, "iv": 15.1
  },
  "resistance_analysis": {
    "level": 24300, "strength": 42, "prediction": "BREAKOUT", "probability": 58,
    "evidence": ["..."], "oi": 650000, "oi_change": -15000, "oi_change_pct": -2.3,
    "volume": 45000, "iv": 13.8
  },
  "iv_assessment": { "atm_iv": 14.2, "assessment": "FAIR", "detail": "..." },
  "theta_assessment": { "theta_per_day": 5.20, "days_to_expiry": 3, "warning": "CAUTION: ..." },
  "pcr_ratio": 1.28,
  "trade_setup": {
    "direction": "GO_CALL", "strike": 24150, "option_type": "CE",
    "entry_price": 185.50, "target_price": 241.15, "target_pct": 30.0,
    "stop_loss": 148.40, "sl_pct": 20.0, "risk_reward": 1.5,
    "target_label": "...", "delta": 0.550,
    "resistance_level": 24300, "support_level": 24000
  },
  "risk_flags": [ { "type": "warning", "text": "..." } ],
  "scoring_factors": {
    "oi_support_resistance": { "score": 0.80, "weight": 0.30, "detail": "..." },
    "oi_momentum": { "score": 0.30, "weight": 0.25, "detail": "..." },
    "iv_level": { "score": 0.20, "weight": 0.15, "detail": "..." },
    "pcr_trend": { "score": 0.70, "weight": 0.10, "detail": "..." },
    "news_sentiment": { "score": 0.35, "weight": 0.15, "detail": "..." },
    "theta_risk": { "score": -0.20, "weight": 0.10, "detail": "..." }
  },
  "news_detail": {
    "sentiment": "Bullish", "strength": "Strong", "confidence": 85,
    "total_articles": 23, "bull_score": 18.5, "bear_score": 4.2,
    "net_score": 14.3, "queries_used": 8,
    "event_flags": ["RBI MPC Meeting (Tomorrow)"],
    "top_articles": [ { "title": "...", "source": "...", "score": 4.2 } ]
  }
}
```

### 5.9 Rationale Generation

The rationale string is auto-generated from the top 3 scoring factors (sorted by `|score x weight|` descending). Each factor contributes a clause like: `"OI Support Resistance: bullish — Support: 75/100 (BOUNCE), Resistance: 42/100 (BREAKOUT)"`.

---

## 6. Module 4 — Execution Module

**File:** `execution_module.py` (658 lines)
**Purpose:** Read AI decisions, execute paper or live trades, monitor positions in real-time, and push updates to the dashboard.

### 6.1 Trading Modes

| Mode  | Flag                    | Behavior                                                                  |
| ----- | ----------------------- | ------------------------------------------------------------------------- |
| Paper | `LIVE_TRADING = False`  | Simulated entry/exit at real option chain prices. In-memory position tracking. |
| Live  | `LIVE_TRADING = True`   | Real orders via Dhan API v2. Currently disabled.                          |

### 6.2 Decision Parsing

The `parse_ai_decision` function supports both AI decision formats:

**Enhanced Format** (preferred): Reads `trade_direction` and `trade_setup` fields. Extracts strike, entry price, target, stop loss, confidence, and risk:reward directly from the trade setup.

**Legacy Format** (fallback): Reads `decision` and `trade_type` fields. Maps `GO + CALL_BUY` to `GO_CALL`, `GO + PUT_BUY` to `GO_PUT`. Entry price is obtained from the live option chain since legacy format doesn't include trade setup prices.

### 6.3 Entry Validation

A trade is only executed if all conditions are met:

| Check                                          | Threshold  | Behavior on Failure   |
| ---------------------------------------------- | ---------- | --------------------- |
| Confidence >= minimum                          | 40%        | Skip with log message |
| Risk:Reward >= minimum                         | 1.0        | Skip with log message |
| Valid strike exists                            | Non-null   | Skip with log message |
| Entry price > 0                                | Positive   | Skip with log message |
| No existing open position for instrument       | 1 per instrument | Skip with log message |

### 6.4 Entry Flow

When all validation passes:

1. **Get Entry Price**: Use the trade setup's entry price. If zero, fall back to live option chain `last_price` for the ATM strike.
2. **Get Target/SL**: Use the trade setup's values. If zero, apply defaults: target = entry x 1.30 (30%), SL = entry x 0.85 (15%).
3. **Generate Position ID**: Format `POS-{YYYYMMDDHHMMSS}-{counter}`.
4. **Paper Mode**: Log the simulated entry.
5. **Live Mode**: Look up the option's security ID from the scrip master CSV, then call `POST /v2/orders` on the Dhan API with `transactionType: "BUY"`, `productType: "INTRADAY"`, `orderType: "MARKET"`.
6. **Record Position**: Store in `OPEN_POSITIONS[instrument]` with all fields (id, instrument, type, strike, option_type, entry/current/target/SL prices, quantity, P&L, status, timestamps).
7. **Push to Dashboard**: POST to `/api/trading/position` with the position data.

### 6.5 Position Monitoring

Every cycle, `monitor_positions` iterates all open positions:

1. **Get Current Price**: Read the live option chain and extract `last_price` for the position's strike and option type.
2. **Update P&L**: `pnl = (current_price - entry_price) x quantity`, `pnl_pct = ((current_price - entry_price) / entry_price) x 100`.
3. **Check Stop Loss**: If `current_price <= sl_price`, trigger SL exit.
4. **Check Target Profit**: If `current_price >= tp_price`, trigger TP exit.
5. **On Exit**: Mark position as CLOSED, record exit time/price/reason. In live mode, place a SELL order. Push closed position to dashboard.
6. **No Exit**: Push updated position (with current price and P&L) to dashboard.

### 6.6 Live Order Placement

For live trading, orders are placed via `POST /v2/orders` with:

```json
{
  "dhanClientId": "1101615161",
  "correlationId": "TRD-NIFTY-BUY-20260402101535123456",
  "transactionType": "BUY",
  "exchangeSegment": "NSE_FNO",
  "productType": "INTRADAY",
  "orderType": "MARKET",
  "validity": "DAY",
  "securityId": "12345",
  "quantity": "75"
}
```

The `correlationId` is generated as `TRD-{instrument[:5]}-{type[:3]}-{timestamp_microseconds}` for traceability.

### 6.7 Scrip Master Lookup

The `find_option_security_id` function searches the Dhan scrip master CSV (loaded once via pandas) to find the security ID for a specific option contract. It filters by:

- `SM_SYMBOL_NAME` (e.g., "NIFTY")
- `SEM_EXPIRY_DATE` (matching the target expiry)
- `SEM_STRIKE_PRICE` (matching the target strike)
- `SEM_OPTION_TYPE` (CE or PE)

### 6.8 Heartbeat

Every cycle, the Executor sends a heartbeat to `POST /api/trading/heartbeat` with the module name (`"EXECUTOR"`) and a status message showing open and closed position counts.

---

## 7. Module 5 — Dashboard Data Pusher

**File:** `dashboard_data_pusher.py` (199 lines)
**Purpose:** Bridge between the file-based Python pipeline and the dashboard's REST API.

### 7.1 Change Detection

The Data Pusher uses file modification time (mtime) tracking to detect changes. For each instrument, it monitors three files:

| File Pattern                            | Endpoint                       | Payload Key         |
| --------------------------------------- | ------------------------------ | ------------------- |
| `option_chain_{instrument}.json`        | `POST /api/trading/option-chain` | `{instrument, data}` |
| `analyzer_output_{instrument}.json`     | `POST /api/trading/analyzer`   | `{instrument, data}` |
| `ai_decision_{instrument}.json`         | `POST /api/trading/ai-decision`| `{instrument, data}` |

A file is only pushed when its mtime increases beyond the previously recorded value. This prevents redundant pushes when no upstream module has written new data.

### 7.2 Main Loop

The loop runs every 3 seconds (faster than the 5-second module cycles to ensure timely delivery):

1. Poll active instruments from the dashboard.
2. For each active instrument, check all three file types for changes.
3. Push changed files to the corresponding REST endpoint.
4. Send a heartbeat (module: `"FETCHER"`, message: `"Data pusher active"`) every cycle.
5. Log a status summary every 10 cycles.
6. Skip logging for disabled instruments except every 10 cycles (noise reduction).

### 7.3 Error Handling

Connection errors are silently swallowed (the dashboard may be temporarily unreachable). Other errors are logged with the endpoint name and error message. The pusher never crashes — it continues retrying on the next cycle.

---

## 8. Inter-Module Communication

### 8.1 File-Based Communication

| Source Module | Target Module                  | File Pattern                                      | Content                |
| ------------- | ------------------------------ | ------------------------------------------------- | ---------------------- |
| Fetcher       | Analyzer, AI Engine, Executor  | `option_chain_{instrument}.json`                  | Raw Dhan option chain  |
| Analyzer      | AI Engine                      | `analyzer_output_{instrument}.json`               | 9 analysis outputs     |
| AI Engine     | Executor                       | `ai_decision_{instrument}.json`                   | Scored decision + trade setup |
| Analyzer      | Analyzer (self, persistent)    | `opening_snapshots/opening_{instrument}_{date}.json` | Opening OI snapshot |

All files are written atomically (Python's `json.dump` to a file handle) and read with error handling for empty files, invalid JSON, and missing files.

### 8.2 REST API Communication

| Source       | Target    | Endpoint                              | Direction |
| ------------ | --------- | ------------------------------------- | --------- |
| All modules  | Dashboard | `GET /api/trading/active-instruments` | Poll (every cycle) |
| Data Pusher  | Dashboard | `POST /api/trading/option-chain`      | Push      |
| Data Pusher  | Dashboard | `POST /api/trading/analyzer`          | Push      |
| Data Pusher  | Dashboard | `POST /api/trading/ai-decision`       | Push      |
| Executor     | Dashboard | `POST /api/trading/position`          | Push      |
| Executor     | Dashboard | `POST /api/trading/heartbeat`         | Push      |
| Data Pusher  | Dashboard | `POST /api/trading/heartbeat`         | Push      |

### 8.3 Timing and Ordering

The modules are not synchronized. Each runs its own loop independently. The typical data flow timing for one instrument in one cycle:

```
T+0.0s  Fetcher writes option_chain_nifty_50.json
T+0.5s  Analyzer reads option_chain, writes analyzer_output_nifty_50.json
T+1.0s  AI Engine reads analyzer_output + option_chain, writes ai_decision_nifty_50.json
T+1.5s  Executor reads ai_decision + option_chain, processes trade
T+3.0s  Data Pusher detects file changes, pushes to dashboard
```

In practice, cycles may overlap. The Analyzer may process data from the previous Fetcher cycle if the Fetcher hasn't completed its current cycle yet. This is acceptable because each module operates on the latest available data.

---

## 9. Data Schemas

### 9.1 Option Chain Strike Data (from Dhan API)

| Field               | Type    | Description                  |
| ------------------- | ------- | ---------------------------- |
| `oi`                | integer | Current open interest        |
| `previous_oi`       | integer | Previous day's OI (from Dhan)|
| `volume`            | integer | Today's traded volume        |
| `last_price`        | float   | Last traded price            |
| `implied_volatility`| float   | IV percentage                |
| `greeks.delta`      | float   | Delta (-1 to +1)            |
| `greeks.theta`      | float   | Theta (negative, per day)    |
| `greeks.gamma`      | float   | Gamma                        |
| `greeks.vega`       | float   | Vega                         |

### 9.2 Position Object (Executor to Dashboard)

| Field         | Type    | Description                                        |
| ------------- | ------- | -------------------------------------------------- |
| `id`          | string  | Unique position ID (`POS-{timestamp}-{counter}`)   |
| `instrument`  | string  | Instrument key (e.g., `NIFTY_50`)                  |
| `type`        | string  | `CALL_BUY` or `PUT_BUY`                            |
| `strike`      | number  | Strike price                                       |
| `option_type` | string  | `CE` or `PE`                                       |
| `entryPrice`  | number  | Entry price (2 decimal places)                     |
| `currentPrice`| number  | Current live price                                 |
| `quantity`    | integer | Number of contracts                                |
| `pnl`         | number  | Absolute P&L in currency                           |
| `pnlPercent`  | number  | P&L as percentage of entry                         |
| `slPrice`     | number  | Stop loss price                                    |
| `tpPrice`     | number  | Target profit price                                |
| `status`      | string  | `OPEN` or `CLOSED`                                 |
| `entryTime`   | string  | ISO
 timestamp of entry                         |
| `exitTime`    | string  | `null` or ISO timestamp of exit                    |
| `exitPrice`   | number  | `null` or exit price                               |
| `exitReason`  | string  | `null`, `"SL_HIT"`, or `"TP_HIT"`                 |

---

## 10. Configuration Reference

### 10.1 Module-Level Constants

| Constant              | Module       | Value                                                    | Description                    |
| --------------------- | ------------ | -------------------------------------------------------- | ------------------------------ |
| `INSTRUMENTS`         | All          | `["NIFTY_50", "BANKNIFTY", "CRUDEOIL", "NATURALGAS"]`   | Instruments to process         |
| `DATA_DIR`            | All          | `os.path.dirname(__file__)`                              | Directory for JSON files       |
| `DASHBOARD_URL`       | All          | env `DASHBOARD_URL` or `http://localhost:3000`           | Dashboard REST API base URL    |
| `POLL_INTERVAL`       | Data Pusher  | 3 seconds                                                | File change polling interval   |
| `NEWS_CACHE_EXPIRY`   | AI Engine    | 300 seconds (5 min)                                      | News API cache TTL             |
| `MAX_OI_HISTORY`      | AI Engine    | 6                                                        | OI history cycles for velocity tracking |
| `MIN_CONFIDENCE`      | Executor     | 0.40 (40%)                                               | Minimum confidence to trade    |
| `MIN_RISK_REWARD`     | Executor     | 1.0                                                      | Minimum R:R ratio to trade     |
| `LIVE_TRADING`        | Executor     | `False`                                                  | Paper vs live trading mode     |

### 10.2 Strike Step Sizes

| Instrument    | Step Size | Example ATM (LTP=24155) |
| ------------- | --------- | ----------------------- |
| NIFTY_50      | 50        | 24150                   |
| BANKNIFTY     | 100       | 24200                   |
| CRUDEOIL      | 50        | (varies)                |
| NATURALGAS    | 5         | (varies)                |

### 10.3 Default Lot Sizes

| Instrument    | Lot Size | Exchange |
| ------------- | -------- | -------- |
| NIFTY_50      | 75       | NSE FNO  |
| BANKNIFTY     | 30       | NSE FNO  |
| CRUDEOIL      | 100      | MCX      |
| NATURALGAS    | 1250     | MCX      |

### 10.4 Scoring Weights

| Factor                 | Weight  | Score Range      |
| ---------------------- | ------- | ---------------- |
| OI Support/Resistance  | 30%     | -0.9 to +0.9    |
| OI Change Momentum     | 25%     | -1.0 to +1.0    |
| IV Level               | 15%     | -0.5 to +0.5    |
| PCR Trend              | 10%     | -0.7 to +0.7    |
| News Sentiment         | 10–15%  | -0.5 to +0.5    |
| Theta Risk             | 10%     | -0.8 to +0.3    |

### 10.5 Decision Thresholds

| Parameter               | Value  | Description                                            |
| ----------------------- | ------ | ------------------------------------------------------ |
| Direction threshold     | +/-0.15 | Total score above/below triggers GO_CALL/GO_PUT       |
| Confidence cap          | 0.95   | Maximum confidence value                               |
| Confidence floor        | 0.30   | Minimum confidence when direction is given             |
| Confidence multiplier   | 1.5    | `abs(total_score) x 1.5`                              |

---

## 11. News Sentiment Engine

### 11.1 Architecture

The News Sentiment Engine is embedded within the AI Decision Engine module. It fetches news articles from the NewsData.io API using instrument-specific multi-query configurations, scores each article using weighted keyword dictionaries, and produces an aggregate sentiment assessment.

### 11.2 Query Configuration

Each instrument has 5–8 targeted queries with individual weights:

| Instrument    | Queries    | Weight Range | Categories         |
| ------------- | ---------- | ------------ | ------------------ |
| NIFTY_50      | 8 queries  | 0.50–1.00    | Business           |
| BANKNIFTY     | 7 queries  | 0.50–1.00    | Business           |
| CRUDEOIL      | 7 queries  | 0.50–1.00    | Business, World    |
| NATURALGAS    | 6 queries  | 0.50–1.00    | Business, Science  |

**NIFTY_50 Queries** (representative):

| Query                                          | Weight | Focus                |
| ---------------------------------------------- | ------ | -------------------- |
| "Nifty 50 Indian stock market"                 | 1.00   | Direct instrument news |
| "Gift Nifty SGX Nifty pre market India"        | 0.90   | Pre-market signals   |
| "India VIX volatility index fear gauge"        | 0.85   | Volatility sentiment |
| "RBI monetary policy interest rate India"      | 0.80   | Central bank policy  |
| "FII DII flow India stock market"              | 0.70   | Institutional flows  |
| "S&P 500 Nasdaq Wall Street overnight futures" | 0.65   | US market overnight  |
| "India GDP CPI inflation WPI PMI data"         | 0.60   | Macro data           |
| "Reliance Infosys HDFC Bank quarterly results" | 0.50   | Earnings             |

### 11.3 Keyword Scoring

Each article's title and description are concatenated and scored against instrument-specific keyword dictionaries. Keywords have weights of 1 (moderate signal) or 2 (strong signal).

**Scoring Formula:**

```
bull_score = Sum(keyword_weight) for each bullish keyword found in text
bear_score = Sum(keyword_weight) for each bearish keyword found in text

# API sentiment label also contributes:
if API says "positive": bull_score += 1
if API says "negative": bear_score += 1

# Apply query weight:
article_bull_score = bull_score x query_weight
article_bear_score = bear_score x query_weight
article_net_score  = (bull_score - bear_score) x query_weight
```

### 11.4 Aggregate Sentiment

```
total_bull = Sum(article_bull_scores)
total_bear = Sum(article_bear_scores)
net_score  = total_bull - total_bear

Sentiment:
  net_score > 3  -> Bullish  (confidence = min(100, net_score x 8))
  net_score < -3 -> Bearish  (confidence = min(100, |net_score| x 8))
  otherwise      -> Neutral  (confidence = max(0, 50 - |net_score| x 10))

Strength:
  articles > 15 AND |net_score| > 5 -> Strong
  articles > 5  AND |net_score| > 2 -> Moderate
  articles > 0                      -> Mild
  otherwise                         -> Weak
```

### 11.5 Caching

News results are cached per instrument for 5 minutes (`NEWS_CACHE_EXPIRY = 300`). The cache key is the instrument name, and the cache stores the timestamp and full result object. This prevents excessive API calls (NewsData.io has rate limits) while keeping sentiment reasonably fresh.

### 11.6 Rate Limiting

A 1-second `time.sleep()` is inserted between each query within an instrument's query set. With 6–8 queries per instrument and 4 instruments, a full news refresh takes approximately 24–32 seconds.

---

## 12. Event Calendar

The AI Decision Engine includes a hardcoded event calendar for 2026 that tracks market-moving events. Events are used in two ways:

1. **News weight boost**: On event days, the news sentiment factor weight increases from 10% to 15%.
2. **Event flags**: Upcoming events (within 3 days) are included in the decision output for display on the dashboard.

### 12.1 Event Categories

| Category                     | Frequency               | Instruments Affected           |
| ---------------------------- | ----------------------- | ------------------------------ |
| RBI MPC Meeting              | Bi-monthly (6 dates)    | NIFTY_50, BANKNIFTY            |
| US Fed FOMC Decision         | 8 dates per year        | NIFTY_50, BANKNIFTY, CRUDEOIL  |
| EIA Crude Oil Inventory      | Weekly (Wednesday)      | CRUDEOIL                       |
| EIA Natural Gas Storage      | Weekly (Thursday)       | NATURALGAS                     |
| India GDP Data               | Quarterly (4 dates)     | NIFTY_50, BANKNIFTY            |
| India CPI Inflation          | Monthly (12 dates)      | NIFTY_50, BANKNIFTY            |
| India Manufacturing PMI      | Monthly (12 dates)      | NIFTY_50, BANKNIFTY            |
| Weekly Options Expiry        | Weekly (Thursday)       | NIFTY_50, BANKNIFTY            |
| Baker Hughes Rig Count       | Weekly (Friday)         | CRUDEOIL, NATURALGAS           |
| OPEC+ Meeting                | Quarterly (4 dates)     | CRUDEOIL                       |

### 12.2 Event Detection Logic

The `get_upcoming_events` function checks two types of events:

**Recurring events** (weekly): Compares the current day of the week and tomorrow's day of the week against the `recurrence` field. Labels are "Today" or "Tomorrow."

**Fixed-date events**: Parses the `date` field and computes the delta from today. Events within 0–3 days are included, labeled as "Today," "Tomorrow," or "In N days."

---

## 13. Dashboard Integration

### 13.1 REST API Endpoints Used

| Endpoint                              | Method | Used By                | Purpose                  |
| ------------------------------------- | ------ | ---------------------- | ------------------------ |
| `/api/trading/active-instruments`     | GET    | All modules            | Get enabled instruments  |
| `/api/trading/option-chain`           | POST   | Data Pusher            | Push raw option chain    |
| `/api/trading/analyzer`               | POST   | Data Pusher            | Push analyzer output     |
| `/api/trading/ai-decision`            | POST   | Data Pusher            | Push AI decision         |
| `/api/trading/position`               | POST   | Executor               | Push position updates    |
| `/api/trading/heartbeat`              | POST   | Executor, Data Pusher  | Module health status     |
| `/api/trading/health`                 | GET    | Data Pusher            | Dashboard connectivity check |

### 13.2 Dashboard Display Mapping

The data pushed by the AI Engine pipeline is displayed across several dashboard components:

| Data Source      | Dashboard Component                      | Key Fields Displayed                                       |
| ---------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Analyzer output  | InstrumentCard — OI Bar                  | `active_strikes`, `main_support`, `main_resistance`        |
| Analyzer output  | InstrumentCard — S/R Strength Line       | `sr_intraday_levels` (wall strength, activity labels)      |
| AI Decision      | InstrumentCard — Trade Signal            | `trade_direction`, `confidence_score`                      |
| AI Decision      | InstrumentCard — Wall Strength           | `support_analysis`, `resistance_analysis` (strength, prediction) |
| AI Decision      | InstrumentCard — Trade Setup             | `trade_setup` (strike, entry, target, SL, R:R, delta)     |
| AI Decision      | InstrumentCard — News Sentiment          | `news_detail` (sentiment, strength, event flags, top articles) |
| AI Decision      | InstrumentCard — Pre-Entry Checklist     | `scoring_factors`, `risk_flags`                            |
| AI Decision      | Right Sidebar — Signals Feed             | `trade_direction`, `rationale`                             |
| Position data    | Right Sidebar — Position Tracker         | Position object (entry, current, P&L, SL/TP)              |
| Heartbeat        | StatusBar                                | Module health indicators                                   |

---

## 14. Planned Migrations

### 14.1 Feature 7 — Dhan WebSocket Integration

The current file-based data flow will be supplemented (and partially replaced) by a real-time WebSocket feed from Dhan. The WebSocket will provide live tick data (LTP, bid/ask, volume) without the 5-second polling delay. The option chain will still be fetched via REST API for full OI/IV/Greeks data, but price updates will be near-instantaneous.

### 14.2 Feature 21 — Python Module Migration to Broker Service

The Python modules currently call the Dhan API directly with hardcoded credentials. Feature 21 will migrate them to call the Broker Service's REST API instead. The Broker Service (already built in Steps 0.1–0.6) provides:

- Token management with auto-rotation and validation
- Rate limiting (10/sec, 250/min)
- Retry logic with exponential backoff
- Adapter pattern (swap Dhan for another broker without changing Python code)
- Kill switch for emergency trade halt

### 14.3 Feature 22 — AI Paper Tab

A dedicated "AI Trades PAPER" tab in the Position Tracker will display all paper trades executed by the Execution Module. This will include a full trade history, aggregate statistics, and performance comparison against the user's manual trades.

---

## 15. Testing

### 15.1 Test Analyzer (`test_analyzer.py`)

A standalone test harness (192 lines) that validates the Analyzer's core functions against real option chain data files. It loads JSON from a configurable directory, uses the current data as both current and previous (static analysis), and prints market bias, S/R levels, and active strikes.

### 15.2 Recommended Test Categories

| Category                        | Module      | Estimated Tests | Focus                                            |
| ------------------------------- | ----------- | --------------- | ------------------------------------------------ |
| Fetcher — scrip master parsing  | Fetcher     | 5               | MCX security ID resolution, expiry sorting       |
| Fetcher — API error handling    | Fetcher     | 4               | Auth failure, empty response, timeout            |
| Analyzer — active strikes       | Analyzer    | 6               | Intersection logic, edge cases (no data, single strike) |
| Analyzer — S/R levels           | Analyzer    | 6               | Ranking, proximity weighting, main S/R selection |
| Analyzer — market bias          | Analyzer    | 4               | Bullish/Bearish/Range-bound thresholds           |
| Analyzer — OI signals           | Analyzer    | 8               | All 8 signal types, trap detection               |
| Analyzer — opening snapshot     | Analyzer    | 5               | Capture, persistence, intraday computation       |
| AI Engine — wall strength       | AI Engine   | 8               | Scoring factors, prediction thresholds, evidence |
| AI Engine — IV/theta assessment | AI Engine   | 6               | Assessment categories, DTE warnings              |
| AI Engine — weighted scoring    | AI Engine   | 10              | Direction thresholds, confidence calc, factor weights |
| AI Engine — trade setup         | AI Engine   | 8               | Target/SL calculation, breakout/bounce multipliers, R:R |
| AI Engine — news sentiment      | AI Engine   | 6               | Keyword scoring, caching, event detection        |
| Executor — decision parsing     | Executor    | 6               | Enhanced format, legacy format, validation       |
| Executor — entry/exit flow      | Executor    | 8               | Paper entry, SL hit, TP hit, position tracking   |
| Data Pusher — change detection  | Data Pusher | 4               | Mtime tracking, push/skip logic                  |
| **Total**                       |             | **~94**         |                                                  |

---

## Appendix A — Keyword Dictionaries

### A.1 Equity Keywords (NIFTY_50)

**Bullish (28 keywords):**

| Keyword                                                                  | Weight | Category       |
| ------------------------------------------------------------------------ | ------ | -------------- |
| rally, surge, breakout, record high, all-time high                       | 2      | Strong bullish |
| rate cut, fii buying, strong earnings, beat estimates                    | 2      | Fundamental    |
| gift nifty positive/higher/green, sgx nifty higher, pre market positive  | 2      | Pre-market     |
| vix falls/drops/low/decline, volatility eases                            | 2      | VIX (low = bullish) |
| wall street rally, s&p 500 gains, nasdaq rally, us futures positive      | 2      | US overnight   |
| gdp growth, cpi falls, inflation eases, pmi expansion                    | 2      | India macro    |
| gain, rise, bullish, positive, growth, recovery, uptrend, buying, inflow, upgrade, outperform, optimism, boost, strong | 1 | Moderate |

**Bearish (28 keywords):** Mirror structure with opposite signals (crash, plunge, rate hike, vix spikes, wall street crash, gdp slows, etc.)

### A.2 Banking Keywords (BANKNIFTY)

Extends the Equity dictionary with 9 additional keywords per side:

| Bullish Additions (weight)                                                 | Bearish Additions (weight)                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| credit growth (2), npa reduction (2), loan growth (2)                      | npa increase (2), bad loans (2), provisioning (1)                         |
| nim expansion (2), bank profit (2)                                         | nim compression (2), moratorium (2)                                       |
| deposit growth (1), casa ratio (1), retail lending (1)                     | us bank crisis (2), banking contagion (2), bank run (2)                   |

### A.3 Crude Oil Keywords (CRUDEOIL)

18 bullish + 18 bearish keywords focused on supply/demand, OPEC, geopolitics, and DXY (inverse correlation — dollar weakness = crude bullish).

### A.4 Natural Gas Keywords (NATURALGAS)

13 bullish + 13 bearish keywords focused on weather, storage, EIA reports, TTF/European gas, and rig counts.

---

## Appendix B — File Inventory

### B.1 Source Files

| File                              | Lines | Module      | Role                                |
| --------------------------------- | ----- | ----------- | ----------------------------------- |
| `dhan_option_chain_fetcher.py`    | 241   | Fetcher     | Data acquisition from Dhan API      |
| `option_chain_analyzer.py`        | 743   | Analyzer    | OI analysis and signal generation   |
| `ai_decision_engine.py`          | 1215  | AI Engine   | Scoring, trade setup, news sentiment|
| `execution_module.py`             | 658   | Executor    | Paper/live trade execution          |
| `dashboard_data_pusher.py`        | 199   | Data Pusher | File-to-REST bridge                 |
| `test_analyzer.py`                | 192   | Test        | Standalone analyzer test harness    |
| **Total**                         | **3248** |          |                                     |

### B.2 Runtime Data Files

| File Pattern                                              | Written By | Read By                    | Content              |
| --------------------------------------------------------- | ---------- | -------------------------- | -------------------- |
| `option_chain_{instrument}.json`                          | Fetcher    | Analyzer, AI Engine, Executor | Raw option chain  |
| `analyzer_output_{instrument}.json`                       | Analyzer   | AI Engine                  | Analysis results     |
| `ai_decision_{instrument}.json`                           | AI Engine  | Executor, Data Pusher      | Trade decision       |
| `opening_snapshots/opening_{instrument}_{date}.json`      | Analyzer   | Analyzer                   | Opening OI snapshot  |
| `dhan_scrip_master.csv`                                   | (manual download) | Executor              | Security ID lookup   |

### B.3 External Dependencies

| Dependency       | Module      | Purpose                    |
| ---------------- | ----------- | -------------------------- |
| `requests`       | All         | HTTP client for API calls  |
| `pandas`         | Executor    | Scrip master CSV parsing   |
| `json`           | All         | JSON serialization         |
| `csv` / `io`     | Fetcher     | Scrip master CSV parsing   |
| `math`           | AI Engine   | Mathematical operations    |
| `datetime` / `time` | All      | Timestamps, sleep, date parsing |

---

*End of specification.*
