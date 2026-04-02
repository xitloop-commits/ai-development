# AI Engine v2.4 Implementation Plan

**Document:** ai-engine-implementation-plan.md
**Project:** Automatic Trading System (ATS)
**Status:** Approved for Implementation

---

## 1. Overview

This document outlines the step-by-step implementation plan for upgrading the AI Engine Python modules to v2.0 (incorporating the v2.4 enhancements). 

A critical architectural decision has been made: **The Python modules will NOT duplicate discipline and risk management logic.** The server-side `Discipline Engine` (`server/discipline/`) already implements daily loss limits, trade limits, position sizing, time windows, and pre-trade checks. The Python modules will act as the "brain" (analysis, momentum, exits) and will call the server-side Discipline Engine via REST API before executing any trade.

---

## 2. Phase 1: Infrastructure & Refactoring (Preparation)

Before adding new v2.4 features, the existing v1.0 Python modules must be refactored to be broker-agnostic and to communicate with the new Broker Service.

### Step 1.1: Broker-Agnostic Fetcher
- **File:** `dhan_option_chain_fetcher.py` → rename to `option_chain_fetcher.py`
- **Action:** Remove all direct Dhan API calls and Dhan authentication logic.
- **New Flow:** Call `GET /api/broker/option-chain` and `GET /api/broker/expiry-list` on the local Node.js server.

### Step 1.2: Broker-Agnostic Executor
- **File:** `execution_module.py`
- **Action:** Remove direct Dhan order placement and scrip master CSV parsing.
- **New Flow:** Call `POST /api/broker/orders` for live trades. Call `GET /api/broker/scrip-master/lookup` for security IDs.

### Step 1.3: Discipline Engine Integration
- **File:** `execution_module.py`
- **Action:** Before placing any trade (paper or live), call `POST /api/discipline/pre-trade-check` with the proposed trade setup.
- **Logic:** If the Discipline Engine rejects the trade (e.g., max trades reached, daily loss limit hit, time window closed), the Executor drops the trade and logs the rejection reason.

---

## 3. Phase 2: Core Analysis Enhancements

Implement the new analytical filters that run *before* a trade is considered.

### Step 2.1: Trade Quality Filter & No Trade Detection
- **File:** `ai_decision_engine.py`
- **Action:** Implement the sideways market detection (narrow range, balanced OI, low volume, neutral PCR).
- **Action:** Implement trap detection (false breakouts, OI contradiction).
- **Logic:** If sideways or trap conditions are met, set `trade_direction = "NEUTRAL"` and log the reason.

### Step 2.2: Bounce/Breakdown Engine
- **File:** `ai_decision_engine.py`
- **Action:** Classify every `GO_CALL` or `GO_PUT` signal as either a `BOUNCE` (reversing from support/resistance) or a `BREAKOUT` (pushing through support/resistance).
- **Logic:** Add this classification to the `ai_decision_{instrument}.json` output.

---

## 4. Phase 3: Real-Time Execution Enhancements (The "Crown Jewels")

This phase introduces the sub-second, WebSocket-driven modules.

### Step 3.1: WebSocket Feed Integration
- **File:** `websocket_feed.py` (NEW)
- **Action:** Connect to the Broker Service's Tick Bus (`ws://localhost:3000/api/broker/ticks`).
- **Logic:** Maintain an in-memory store of the latest LTP, volume, and OI for the ATM +/- 10 strikes.

### Step 3.2: Momentum Engine (Dual-Window)
- **File:** `execution_module.py` (or new `momentum_engine.py` imported by Executor)
- **Action:** Calculate the 4-factor Momentum Score (Price Velocity, Volume, OI Change, Candle Strength).
- **Logic:** Calculate both Fast (30s-1m) and Slow (2-3m) window scores. Combine for final 0-100 score.

### Step 3.3: Advanced Exits (Adaptive, Profit, Trade Age)
- **File:** `execution_module.py`
- **Action:** Implement the Trade Age Monitor (force exit if trade is dead for 10 minutes).
- **Action:** Implement the Profit Exit Engine (partial exit at +6%, full at +10%).
- **Action:** Implement the Adaptive Exit Engine (exit early if Momentum Score drops below 30).

### Step 3.4: Pyramiding Engine
- **File:** `execution_module.py`
- **Action:** If a position is in profit and Momentum Score > 80, add to the position (up to max position size allowed by Discipline Engine).

---

## 5. Phase 4: Session & Learning Enhancements

These modules run outside the core tick-by-tick loop.

### Step 4.1: Carry Forward Engine
- **File:** `session_manager.py` (NEW)
- **Action:** At 3:15 PM, evaluate open positions. If profit >= 15% and IV is stable, hold overnight. Otherwise, force close.

### Step 4.2: Performance Feedback Loop
- **File:** `performance_feedback.py` (NEW)
- **Action:** Run once pre-market. Read the last 5 days of trade journals.
- **Logic:** Adjust `MIN_CONFIDENCE`, `PROFIT_PARTIAL_EXIT_PCT`, and `TRADE_AGE_FORCE_EXIT` by small increments based on win rate and average hold time.

---

## 6. Testing & Validation

1. **Unit Tests:** Update `test_analyzer.py` to validate the new Bounce/Breakdown classifications.
2. **Integration Tests:** Run the Python pipeline against the Mock Broker Adapter to verify Discipline Engine rejections (e.g., simulate 3 trades, verify 4th is blocked).
3. **WebSocket Tests:** Feed recorded tick data into the Tick Bus and verify the Momentum Engine calculates scores correctly.
