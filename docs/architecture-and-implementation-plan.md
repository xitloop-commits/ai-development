# Automatic Trading System (ATS) — Architecture & Implementation Plan

**Version:** 1.0  
**Date:** April 2, 2026  
**Author:** Manus AI  
**Project:** Automatic Trading System (ATS)

---

## 1. Executive Summary

The Automatic Trading System (ATS) is a comprehensive trading dashboard and execution platform designed for Indian derivatives markets, specifically tracking NIFTY 50, BANK NIFTY, CRUDE OIL, and NATURAL GAS [1]. It provides real-time option chain analysis, AI-driven trade signals, automated and manual trade execution, a 250-day compounding Trading Desk, a full trading discipline engine, and a trade journal with P&L analytics [1].

This document outlines the current state of the system, the target architecture based on the latest specifications, and a phased implementation plan to bridge the gap between the two. The goal is to transition from the current multi-page, partially coupled architecture to a unified, single-screen command center with a robust, centralized Broker Service abstraction layer.

---

## 2. Current System State

The current implementation is a hybrid architecture consisting of a Node.js/React full-stack application and a suite of standalone Python modules [1]. While functional, it exhibits architectural drift from the latest specifications, particularly in the frontend UI shell and the Python-to-broker integration.

### 2.1 Frontend Architecture (Current)

The frontend is built with React 19 (SPA), Vite, Tailwind CSS 4, shadcn/ui, and wouter for routing [1].

- **Structure:** It currently operates as a multi-page application with distinct routes for `/`, `/tracker`, `/discipline`, `/journal`, and `/settings` [2].
- **State Management:** It utilizes React Context for Theme, Alerts, and Instrument Filtering, and relies on tRPC for server state synchronization [2].
- **UI Shell:** The layout features a sticky top status bar, navigation tabs, and a footer. However, many indicators (such as Dhan API status, WebSocket connection, and Discipline Score) are currently placeholders or are computed locally on the client rather than reflecting true backend state [2].

### 2.2 Backend Architecture (Current)

The backend is powered by Express 4 and tRPC 11, serving as the central hub for data aggregation and persistence [1].

- **Databases:** The system employs a dual-database strategy. MongoDB (via Mongoose) is used for new features like User Settings and Broker Configs, while MySQL/TiDB (via Drizzle ORM) is maintained for legacy features such as the Trade Journal and User authentication [1].
- **Integration Layer:** 
  - **REST API (`/api/trading/*`):** Provides ingestion endpoints for the Python modules to push raw data [3].
  - **In-Memory Store (`tradingStore.ts`):** Acts as a volatile runtime aggregation layer. It receives raw Python JSON payloads and normalizes them into a shared `InstrumentData` structure for the frontend [4].
  - **tRPC API (`/api/trpc/*`):** Exposes the normalized in-memory state and database mutations to the React frontend [5].

### 2.3 Python Pipeline (Current)

The data analysis and execution pipeline consists of six standalone Python scripts [1].

- **Modules:** The core modules include `option_chain_fetcher.py`, `option_chain_analyzer.py`, `ai_decision_engine.py`, `execution_module.py`, `dashboard_data_pusher.py`, and `test_analyzer.py` [1].
- **Integration:** These modules communicate with the Node.js backend primarily via the REST API, pushing data through `dashboard_data_pusher.py` and direct calls from `execution_module.py` [1].
- **Architectural Gap:** A significant architectural gap exists where Python modules currently communicate directly with the Dhan API using hardcoded credentials [6]. This bypasses the intended Broker Service abstraction layer and violates the target architecture design [1].

---

## 3. Target Architecture

The target architecture aims to unify the user experience into a single-screen command center and centralize all broker interactions through a robust Broker Service abstraction layer.

### 3.1 Frontend: Single-Screen Command Center

As defined in the Main Screen specification, the UI will transition from a multi-page app to a persistent, single-screen shell [7].

- **Layout:** The interface will consist of four vertical layers: App Bar, Summary Bar, Trading Desk, and Footer, complemented by two hidden side drawers [7].
- **Trading Desk:** This will serve as the permanent center content, featuring the 250-day compounding challenge table [7].
- **Overlays & Drawers:** All other system views will be invoked as full-screen overlays or sliding drawers via keyboard shortcuts, dismissing the need for traditional page navigation [7]:
  - `Ctrl+D`: Discipline Dashboard (Overlay)
  - `Ctrl+J`: Trade Journal (Overlay)
  - `Ctrl+S`: Settings (Overlay)
  - `Ctrl+[`: Instrument Cards (Left Drawer)
  - `Ctrl+]`: Signals & Alerts (Right Drawer)

### 3.2 Backend: Broker Service Abstraction

All broker interactions must be routed through the Broker Service to ensure modularity and security [8].

- **Adapter Pattern:** The system will utilize a unified `BrokerAdapter` interface, implemented by specific brokers (e.g., `DhanAdapter`, `MockAdapter`) [8].
- **Centralized Credentials:** Broker configurations and authentication tokens will be securely stored in MongoDB (`broker_configs`), eliminating the need for hardcoded credentials in Python scripts [8].
- **Python Migration:** The Python modules will be refactored to call the Broker Service REST endpoints for all market data and execution requests, rather than interacting with the Dhan API directly [1].

### 3.3 Capital & Discipline Engines

The system enforces strict capital management and trading discipline rules.

- **Capital Pools:** The architecture employs a two-pool system. All incoming capital and profits are subject to a universal 75/25 split between the Trading Pool and the Reserve Pool, targeting 250 Day Index cycles [9].
- **Discipline Engine:** A comprehensive risk management suite will enforce Circuit Breakers (daily loss limits), Trade Limits, Time Windows, and a mandatory Pre-Trade Gate checklist before any order execution [1].

---

## 4. Implementation Plan

The implementation is structured into prioritized phases to systematically upgrade the infrastructure, implement core trading features, enforce discipline, and polish the user experience. This plan aligns with the established priority tiers (P0 to P3) [10].

### Phase 1: Core Infrastructure & Broker Service (P0)

Establish the foundational systems required for all subsequent features, focusing on the Broker Service abstraction.

| Task | Description |
|------|-------------|
| **1.1 Broker Service Core** | Implement the `BrokerAdapter` interface, `BrokerService` singleton, and MongoDB `broker_configs` schema. |
| **1.2 Mock Adapter** | Implement the in-memory paper trading adapter for simulated execution. |
| **1.3 Dhan Adapter (Auth & Data)** | Implement token management, scrip master caching, and option chain retrieval via Dhan API. |
| **1.4 Dhan Adapter (Execution)** | Implement order placement, modification, cancellation, and position tracking. |
| **1.5 Python Migration** | Update all Python modules to use the Broker Service REST endpoints and remove hardcoded credentials. |

### Phase 2: Settings & Main Screen Foundation (P0)

Transition the UI to the target single-screen architecture and establish the configuration foundation.

| Task | Description |
|------|-------------|
| **2.1 Settings Overlay** | Implement the Settings UI as an overlay with MongoDB persistence (`user_settings`). |
| **2.2 Main Screen Shell** | Implement the App Bar, Summary Bar, and Footer with real data bindings replacing placeholders. |
| **2.3 Drawers & Overlays** | Implement the Left/Right drawers and keyboard shortcut mechanics (`Ctrl+D`, `Ctrl+J`, `Ctrl+S`, `Ctrl+[`, `Ctrl+]`). |

### Phase 3: Trading Desk & Capital Logic (P1)

Implement the core 250-day compounding challenge workspace and financial mechanics.

| Task | Description |
|------|-------------|
| **3.1 Trading Desk Table** | Build the 150/250-day table with past, today, and future rows. |
| **3.2 Trade Management** | Implement inline trade input, execution via Broker Service, and inline exit controls. |
| **3.3 Capital Logic** | Implement the 75/25 capital split, Day Index cycle progression, and clawback mechanics. |
| **3.4 Charges System** | Implement the Indian standard charges calculation engine and Net P&L display. |
| **3.5 Real-Time Data** | Integrate the Dhan WebSocket feed for live LTP and position updates. |

### Phase 4: Discipline Engine (P2)

Enforce risk management and trading rules to protect capital.

| Task | Description |
|------|-------------|
| **4.1 Circuit Breakers** | Implement daily loss limits and consecutive loss cooldowns with blocking overlays. |
| **4.2 Trade Limits & Time Windows** | Enforce max trades, max open positions, and exchange-specific time blocks. |
| **4.3 Pre-Trade Gate** | Implement the interactive checklist before order confirmation. |
| **4.4 Near Expiry Controls** | Implement instrument-specific rules and warnings for expiry days. |

### Phase 5: Polish & Enhancements (P3)

Finalize the system with advanced features, historical tracking, and UI polish.

| Task | Description |
|------|-------------|
| **5.1 Journal & Review** | Enforce trade journaling and implement the weekly performance review overlay. |
| **5.2 Streaks & Dashboard** | Implement streak protections and the comprehensive Discipline Score dashboard. |
| **5.3 AI Paper Tab** | Fully integrate the AI automated trading tab using the Mock adapter. |
| **5.4 Error Handling** | Implement robust error states for API failures and partial fills. |

---

## 5. Key Design Decisions (Locked)

The following design decisions are locked and form the immutable constraints of the architecture [1]:

- **Broker Integration:** Abstracted via Broker Service; Python modules must not call Dhan directly.
- **Database Strategy:** MongoDB for all new features; existing MySQL remains untouched.
- **Capital Model:** Shared pool, realized P&L only, day stays open if any position is open.
- **Discipline Rules:** All rules are exchange/instrument-aware and toggleable in settings.
- **UI Paradigm:** Desktop-only, single-screen command center with overlays and drawers.

---

## References

[1] `docs/ats-feature-requirements.md` - Automatic Trading System (ATS) — Complete Feature & Requirements Reference
[2] `client/src/components/AppLayout.tsx` - Top-level frontend shell component
[3] `server/tradingRoutes.ts` - Express REST ingress layer
[4] `server/tradingStore.ts` - In-memory runtime aggregation layer
[5] `server/routers.ts` - Main tRPC composition file
[6] `python_modules/execution_module.py` - Standalone Python execution script
[7] `docs/specs/MainScreen_Spec_v1.1.md` - Main Screen Specification
[8] `docs/specs/broker-service-spec-v1.1.md` - Broker Service Specification
[9] `docs/specs/CapitalPools_Spec_v1.4.md` - Capital Pools Specification
[10] `implementation-plan.md` - Implementation Plan Priority Tiers
