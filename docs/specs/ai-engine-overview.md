# ⚠️ DEPRECATED — AI Engine — Technical Specification Overview

> **DEPRECATED (2026-04-13):** The entire old AI engine pipeline (Modules 1–7) is superseded by the new ML-based pipeline: TFA → Record → Model Training Agent → ML Model → RCA → TEA → BSA. All individual module specs in this folder are deprecated. See `TickFeatureAgent_Spec_1.0.md` for the current architecture.

**Document:** ai-engine-overview.md
**Project:** Automatic Trading System (ATS)
**Status:** Authoritative Reference

---

## Revision History

| Version | Date       | Author    | Changes                                                  |
| ------- | ---------- | --------- | -------------------------------------------------------- |
| v1.0    | 2026-04-02 | Manus AI  | Initial specification based on latest Python module source code |
| v1.1    | 2026-04-02 | Manus AI  | Cross-functionality update: Python module migration to Broker Service reclassified as refactoring task, AI Paper tab confirmed unconstrained (no discipline rules) |
| v1.2    | 2026-04-02 | Manus AI  | Made spec broker-agnostic: replaced all direct Dhan API references with Broker Service abstractions. Removed standalone WebSocket spec (now in Broker Service Spec v1.2 Step 0.7). |
| v1.3    | 2026-04-02 | Manus AI  | Split monolithic spec into per-module specs for maintainability. |
| v2.0    | 2026-04-02 | Manus AI  | Integrated v2.4 enhancements (15 new modules, dual-window momentum, equity curve protection, feedback loop). Added Session Manager and Feedback Loop specs. |

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [Module Specifications](#3-module-specifications)
4. [Inter-Module Communication](#4-inter-module-communication)
5. [Data Schemas](#5-data-schemas)
6. [Configuration Reference](#6-configuration-reference)
7. [Dashboard Integration](#7-dashboard-integration)
8. [Planned Migrations](#8-planned-migrations)
9. [Testing](#9-testing)
10. [Appendix B — File Inventory](#appendix-b--file-inventory)

---

## 1. Overview

The AI Engine is the analytical core of the Automatic Trading System. It is a 7-module Python pipeline that runs as separate long-lived processes alongside the Node.js dashboard. The pipeline ingests real-time option chain data via the **Broker Service** (see `broker-service-spec-v1.2.md`), performs multi-layered analysis (OI structure, market bias, news sentiment, IV assessment, theta risk), produces scored trade signals with complete trade setups, and optionally executes paper or live trades. The AI Engine is **broker-agnostic** — it never communicates with any broker API directly. All market data retrieval, order placement, and position management is routed through the Broker Service abstraction layer.

The system covers four instruments: **NIFTY 50**, **BANK NIFTY**, **CRUDE OIL**, and **NATURAL GAS** — spanning both NSE (equity index options) and MCX (commodity options) exchanges. Each instrument is analyzed independently in every cycle, producing a self-contained decision JSON with 45+ fields.

The pipeline's primary design principle is **modularity through file-based decoupling**. Each module reads input from JSON files written by the upstream module and writes its own output to JSON files for the downstream module. All runtime JSON output files are written to the `python_modules/output/` directory (not the module source directory), keeping source code and generated data cleanly separated. This architecture allows any module to be restarted, replaced, or tested independently without affecting the rest of the pipeline.

---

## 2. System Architecture

### 2.1 Pipeline Data Flow

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL SERVICES                                      │
│  ┌─────────────────────┐                ┌──────────────────────────────────┐    │
│  │  Broker Service      │                │  NewsData.io API                │    │
│  │  (Option Chain,      │                │  (News articles + sentiment)    │    │
│  │   Expiry List,       │                │                                  │    │
│  │   Scrip Master,      │                │                                  │    │
│  │   Orders, Positions) │                │                                  │    │
│  └──────────┬───────────┘                └──────────────┬───────────────────┘    │
│             │                                           │                        │
└─────────────┼───────────────────────────────────────────┼────────────────────────┘
              │                                           │
              ▼                                           │
  ┌───────────────────────────────────┐                    │
  │  MODULE 1: Option Chain Fetcher   │                    │
  │  (option_chain_fetcher.py)        │                    │
  │  • Broker Service auth check      │                    │
  │  • Expiry list + option chain     │                    │
  │  • Rate limiting per Broker SLA   │                    │
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
  │  • Profit Orchestrator (Sizing)   │
  │  • Execution Timing Engine        │
  │  • Momentum Engine (Dual-Window)  │
  │  • Adaptive/Profit Exit Engines   │
  │  • Pyramiding & Risk Manager      │
  └──────────────┬────────────────────┘
                 │
                 │  (New v2.4 Modules)
                 ▼
  ┌───────────────────────────────────┐
  │  MODULE 6: Session Manager        │
  │  (session_manager.py)             │
  │  • Daily Profit/Loss Caps         │
  │  • Carry Forward Engine           │
  └──────────────┬────────────────────┘
                 │
                 ▼
  ┌───────────────────────────────────┐
  │  MODULE 7: Feedback Loop          │
  │  (performance_feedback.py)        │
  │  • Trade Journal Logging          │
  │  • Daily Parameter Tuning         │
  └──────────────┬────────────────────┘
                 │
                 │  Via Broker Service REST API
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
| Option Chain Fetcher | `python3 option_chain_fetcher.py`          | ~5s + rate limit per broker | Broker Service (Option Chain, Expiry List) |
| Option Chain Analyzer| `python3 option_chain_analyzer.py`         | 5s                          | Fetcher output files                      |
| AI Decision Engine   | `python3 ai_decision_engine.py`            | 5s                          | Analyzer output files, NewsData.io API    |
| Execution Module     | `python3 execution_module.py`              | WebSocket tick-driven       | AI Decision files, WebSocket feed, Broker Service |
| Session Manager      | `python3 session_manager.py`               | Event-driven                | Execution Module, Dashboard REST API      |
| Feedback Loop        | `python3 performance_feedback.py`          | Once per day (Pre-market)   | Trade Journal, Configuration files        |
| Data Pusher          | `python3 dashboard_data_pusher.py`         | 3s                          | All output files, Dashboard REST API      |

### 2.3 Instrument Configuration

| Instrument    | Dashboard Key  | Fetcher Key    | Exchange  | Security ID    | Lot Size |
| ------------- | -------------- | -------------- | --------- | -------------- | -------- |
| NIFTY 50      | `NIFTY_50`     | `NIFTY 50`     | IDX_I (NSE) | 13 (fixed)   | 75       |
| BANK NIFTY    | `BANKNIFTY`    | `BANKNIFTY`    | IDX_I (NSE) | 25 (fixed)   | 30       |
| CRUDE OIL     | `CRUDEOIL`     | `CRUDEOIL`     | MCX_COMM  | Auto-resolved  | 100      |
| NATURAL GAS   | `NATURALGAS`   | `NATURALGAS`   | MCX_COMM  | Auto-resolved  | 1250     |

Security ID resolution (including fixed IDs for NSE indices and dynamic nearest-month contract resolution for MCX commodities) is handled entirely by the Broker Service. The AI Engine modules reference instruments by their dashboard key and rely on the Broker Service to resolve the correct security IDs internally.

---

## 3. Module Specifications

For detailed specifications of each module, refer to the individual module documents:

- **Module 1:** [Option Chain Fetcher Spec](ai-engine-fetcher-spec.md)
- **Module 2:** [Option Chain Analyzer Spec](ai-engine-analyzer-spec.md)
- **Module 3:** [AI Decision Engine Spec](ai-engine-decision-spec.md) (Includes News Sentiment, Event Calendar, and Keyword Dictionaries)
- **Module 4:** [Execution Module Spec](ai-engine-executor-spec.md) (Includes Momentum Engine, Profit Orchestrator, Exits)
- **Module 5:** [Dashboard Data Pusher Spec](ai-engine-data-pusher-spec.md)
- **Module 6:** [Session Manager Spec](ai-engine-session-spec.md) (New in v2.4)
- **Module 7:** [Performance Feedback Loop Spec](ai-engine-feedback-spec.md) (New in v2.4)

---

## 4. Inter-Module Communication

### 4.1 File-Based Communication

| Source Module | Target Module                  | File Pattern                                      | Content                |
| ------------- | ------------------------------ | ------------------------------------------------- | ---------------------- |
| Fetcher       | Analyzer, AI Engine, Executor  | `option_chain_{instrument}.json`                  | Raw option chain       |
| Analyzer      | AI Engine                      | `analyzer_output_{instrument}.json`               | 9 analysis outputs     |
| AI Engine     | Executor                       | `ai_decision_{instrument}.json`                   | Scored decision + trade setup |
| Analyzer      | Analyzer (self, persistent)    | `opening_snapshots/opening_{instrument}_{date}.json` | Opening OI snapshot |

All files are written atomically (Python's `json.dump` to a file handle) and read with error handling for empty files, invalid JSON, and missing files.

### 4.2 REST API Communication

| Source       | Target    | Endpoint                              | Direction |
| ------------ | --------- | ------------------------------------- | --------- |
| All modules  | Dashboard | `GET /api/trading/active-instruments` | Poll (every cycle) |
| Data Pusher  | Dashboard | `POST /api/trading/option-chain`      | Push      |
| Data Pusher  | Dashboard | `POST /api/trading/analyzer`          | Push      |
| Data Pusher  | Dashboard | `POST /api/trading/ai-decision`       | Push      |
| Executor     | Dashboard | `POST /api/trading/position`          | Push      |
| Executor     | Dashboard | `POST /api/trading/heartbeat`         | Push      |
| Data Pusher  | Dashboard | `POST /api/trading/heartbeat`         | Push      |

### 4.3 Timing and Ordering

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

## 5. Data Schemas

### 5.1 Option Chain Strike Data (from Broker Service)

| Field               | Type    | Description                  |
| ------------------- | ------- | ---------------------------- |
| `oi`                | integer | Current open interest        |
| `previous_oi`       | integer | Previous day's OI            |
| `volume`            | integer | Today's traded volume        |
| `last_price`        | float   | Last traded price            |
| `implied_volatility`| float   | IV percentage                |
| `greeks.delta`      | float   | Delta (-1 to +1)            |
| `greeks.theta`      | float   | Theta (negative, per day)    |
| `greeks.gamma`      | float   | Gamma                        |
| `greeks.vega`       | float   | Vega                         |

### 5.2 Position Object (Executor to Dashboard)

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
| `entryTime`   | string  | ISO timestamp of entry                         |
| `exitTime`    | string  | `null` or ISO timestamp of exit                    |
| `exitPrice`   | number  | `null` or exit price                               |
| `exitReason`  | string  | `null`, `"SL_HIT"`, or `"TP_HIT"`                 |

---

## 6. Configuration Reference

### 6.1 Module-Level Constants

| Constant              | Module       | Value                                                    | Description                    |
| --------------------- | ------------ | -------------------------------------------------------- | ------------------------------ |
| `INSTRUMENTS`         | All          | `["NIFTY_50", "BANKNIFTY", "CRUDEOIL", "NATURALGAS"]`   | Instruments to process         |
| `DATA_DIR`            | All          | `os.path.join(os.path.dirname(__file__), "output")`    | Directory for JSON output files |
| `DASHBOARD_URL`       | All          | env `DASHBOARD_URL` or `http://localhost:3000`           | Dashboard REST API base URL    |
| `POLL_INTERVAL`       | Data Pusher  | 3 seconds                                                | File change polling interval   |
| `NEWS_CACHE_EXPIRY`   | AI Engine    | 300 seconds (5 min)                                      | News API cache TTL             |
| `MAX_OI_HISTORY`      | AI Engine    | 6                                                        | OI history cycles for velocity tracking |
| `MIN_CONFIDENCE`      | Decision     | 0.65 (65%)                                               | Minimum confidence to trade (Tunable) |
| `MIN_RISK_REWARD`     | Decision     | 1.0                                                      | Minimum R:R ratio to trade     |
| `LIVE_TRADING`        | Executor     | `False`                                                  | Paper vs live trading mode     |
| `EQUITY_CURVE_RESET_DAILY` | Executor | `true`                                                  | Reset risk multiplier daily    |
| `EQUITY_CURVE_MIN_MULTIPLIER` | Executor | `0.25`                                               | Minimum risk multiplier floor  |
| `NO_TRADE_SIDEWAYS_THRESHOLD` | Decision | `3`                                                  | Signals needed to skip trade   |
| `FEEDBACK_ENABLED`    | Feedback     | `false`                                                  | Enable daily parameter tuning  |
| `FEEDBACK_LOOKBACK_DAYS` | Feedback  | `5`                                                      | Days of history to analyze     |
| `PROFIT_PARTIAL_EXIT_PCT` | Executor | `6.0` (6%)                                               | Target for partial exit (Tunable) |
| `TRADE_AGE_FORCE_EXIT` | Executor    | `10` (minutes)                                           | Max time in dead trade (Tunable) |

### 6.2 Strike Step Sizes

| Instrument    | Step Size | Example ATM (LTP=24155) |
| ------------- | --------- | ----------------------- |
| NIFTY_50      | 50        | 24150                   |
| BANKNIFTY     | 100       | 24200                   |
| CRUDEOIL      | 50        | (varies)                |
| NATURALGAS    | 5         | (varies)                |

### 6.3 Default Lot Sizes

| Instrument    | Lot Size | Exchange |
| ------------- | -------- | -------- |
| NIFTY_50      | 75       | NSE FNO  |
| BANKNIFTY     | 30       | NSE FNO  |
| CRUDEOIL      | 100      | MCX      |
| NATURALGAS    | 1250     | MCX      |

### 6.4 Scoring Weights

| Factor                 | Weight  | Score Range      |
| ---------------------- | ------- | ---------------- |
| OI Support/Resistance  | 30%     | -0.9 to +0.9    |
| OI Change Momentum     | 25%     | -1.0 to +1.0    |
| IV Level               | 15%     | -0.5 to +0.5    |
| PCR Trend              | 10%     | -0.7 to +0.7    |
| News Sentiment         | 10–15%  | -0.5 to +0.5    |
| Theta Risk             | 10%     | -0.8 to +0.3    |

### 6.5 Decision Thresholds

| Parameter               | Value  | Description                                            |
| ----------------------- | ------ | ------------------------------------------------------ |
| Direction threshold     | +/-0.15 | Total score above/below triggers GO_CALL/GO_PUT       |
| Confidence cap          | 0.95   | Maximum confidence value                               |
| Confidence floor        | 0.30   | Minimum confidence when direction is given             |
| Confidence multiplier   | 1.5    | `abs(total_score) x 1.5`                              |

---

## 7. Dashboard Integration

### 7.1 REST API Endpoints Used

| Endpoint                              | Method | Used By                | Purpose                  |
| ------------------------------------- | ------ | ---------------------- | ------------------------ |
| `/api/trading/active-instruments`     | GET    | All modules            | Get enabled instruments  |
| `/api/trading/option-chain`           | POST   | Data Pusher            | Push raw option chain    |
| `/api/trading/analyzer`               | POST   | Data Pusher            | Push analyzer output     |
| `/api/trading/ai-decision`            | POST   | Data Pusher            | Push AI decision         |
| `/api/trading/position`               | POST   | Executor               | Push position updates    |
| `/api/trading/heartbeat`              | POST   | Executor, Data Pusher  | Module health status     |
| `/api/trading/health`                 | GET    | Data Pusher            | Dashboard connectivity check |

### 7.2 Dashboard Display Mapping

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

## 8. Planned Migrations

### 8.1 WebSocket Hybrid Architecture

The current file-based data flow will be supplemented (and partially replaced) by a real-time WebSocket feed provided by the Broker Service (see `broker-service-spec-v1.2.md`, Step 0.7). The WebSocket will provide live tick data (LTP, bid/ask, volume, OI) without the 5-second polling delay. The full option chain with Greeks and IV will still be fetched via the Broker Service REST API on a slow cycle (every 60 seconds), but price updates will be near-instantaneous. This is a prerequisite for the AI Engine v2.4 enhancements (Momentum Engine, Trade Age Monitor, Execution Timing Engine).

### 8.2 Feature 22 — AI Paper Tab

A dedicated "AI Trades PAPER" tab in the Position Tracker will display all paper trades executed by the Execution Module. This will include a full trade history, aggregate statistics, and performance comparison against the user's manual trades.

---

## 9. Testing

### 9.1 Existing Test Suites

The project has three comprehensive test suites covering the Python modules, broker service endpoints, and trading store:

| Test File | Framework | Tests | Coverage |
| --- | --- | --- | --- |
| `python_modules/test_python_modules.py` | unittest | 36 | All 7 Python modules: fetcher row conversion, PCR/S-R/max-pain calculations, AI decision scoring, session P&L caps, momentum engine, env loader, performance metrics, data pusher payloads |
| `server/broker/brokerPythonEndpoints.test.ts` | Vitest | 30 | Broker service methods used by Python modules: token validation, expiry list (IDX_I/MCX_COMM), option chain parsing, MCX FUTCOM resolution, scrip lookup, order placement, positions, kill switch |
| `server/tradingRoutes.test.ts` | Vitest | 22 | Trading store functions: active instruments, option chain push, analyzer output, AI decisions (GO/WAIT/NO_GO), positions, module heartbeats, trading mode, instrument data |
| `python_modules/test_analyzer.py` | Standalone | — | Legacy test harness that validates Analyzer core functions against real option chain data files |

### 9.2 Recommended Test Categories

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

## Appendix B — File Inventory

### B.1 Source Files

| File                              | Lines | Module      | Role                                |
| --------------------------------- | ----- | ----------- | ----------------------------------- |
| `option_chain_fetcher.py`         | 241   | Fetcher     | Data acquisition via Broker Service |
| `option_chain_analyzer.py`        | 743   | Analyzer    | OI analysis and signal generation   |
| `ai_decision_engine.py`          | 1215  | AI Engine   | Scoring, trade setup, news sentiment|
| `execution_module.py`             | 658   | Executor    | Paper/live trade execution          |
| `dashboard_data_pusher.py`        | 199   | Data Pusher | File-to-REST bridge                 |
| `test_analyzer.py`                | 192   | Test        | Standalone analyzer test harness    |
| `test_python_modules.py`          | 700+  | Test        | Comprehensive unit tests (36 tests) |
| `session_manager.py`              | 400+  | Session Mgr | Daily P&L caps, carry forward       |
| `performance_feedback.py`         | 550+  | Feedback    | Trade journal, parameter tuning     |
| `momentum_engine.py`              | 330+  | Executor    | Dual-window momentum scoring        |

### B.2 Runtime Data Files

| File Pattern                                              | Written By | Read By                    | Content              |
| --------------------------------------------------------- | ---------- | -------------------------- | -------------------- |
| `output/option_chain_{instrument}.json`                   | Fetcher    | Analyzer, AI Engine, Executor | Raw option chain  |
| `output/analyzer_output_{instrument}.json`                | Analyzer   | AI Engine                  | Analysis results     |
| `output/ai_decision_{instrument}.json`                    | AI Engine  | Executor, Data Pusher      | Trade decision       |
| `output/opening_snapshots/opening_{instrument}_{date}.json` | Analyzer | Analyzer                   | Opening OI snapshot  |
| `output/trade_journal.json`                               | Feedback   | Feedback                   | Trade history log    |
| `output/feedback_adjustments.json`                        | Feedback   | Feedback                   | Parameter adjustment log |
| `output/tuned_params.json`                                | Feedback   | AI Engine, Executor        | Tuned parameters     |
| `output/session_state.json`                               | Session Mgr | Session Mgr               | Daily session state  |
| *(Security ID lookup delegated to Broker Service)*        | —          | —                          | —                    |

### B.3 External Dependencies

| Dependency       | Module      | Purpose                    |
| ---------------- | ----------- | -------------------------- |
| `requests`       | All         | HTTP client for API calls  |
| `json`           | All         | JSON serialization         |
| `math`           | AI Engine   | Mathematical operations    |
| `datetime` / `time` | All      | Timestamps, sleep, date parsing |

---

*End of specification.*
