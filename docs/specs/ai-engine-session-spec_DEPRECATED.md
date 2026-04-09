# ⚠️ DEPRECATED: AI Engine — Module 6: Session Manager

**Document:** ai-engine-session-spec.md  
**Project:** Automatic Trading System (ATS)  
**Status:** ❌ DEPRECATED (2026-04-09)

---

## DEPRECATION NOTICE

**This specification has been deprecated as of April 9, 2026.**

All Session Manager responsibilities have been moved to **DisciplineEngine_Spec_v1.2.md (Module 8)**.

| Responsibility | Moved To | New Reference |
|---|---|---|
| Daily profit cap (+5%) | Discipline Engine Module 8 | Capital Protection |
| Daily loss cap (-2%) | Discipline Engine Module 8 | Capital Protection |
| Carry forward evaluation (15:15) | Discipline Engine Module 8 | Carry Forward Engine |
| Session halt flag | Discipline Engine Module 8 | Session Halt Flag |
| Exit signaling | Discipline Engine → RCA | Exit Signaling API |
| P&L tracking | Portfolio Agent | Daily P&L metrics |

**Timeline:**
- **Now (deprecated):** Discipline Engine Module 8 implements all functionality
- **Week 2:** RCA integration tested and working
- **Week 3:** `session_manager.py` deleted from codebase
- **Week 4:** Specification file removed from docs/specs

**Do not use this module.** Refer to **DisciplineEngine_Spec_v1.2.md (Module 8)** instead.

---

## Revision History

| Version | Date       | Author    | Changes                                                  |
| ------- | ---------- | --------- | -------------------------------------------------------- |
| v2.0    | 2026-04-02 | Manus AI  | Initial specification (New module in v2.4 enhancements)  |

---

## 1. Overview

**File:** `session_manager.py` (New in v2.4)
**Purpose:** Manage daily trading limits, track cumulative P&L, and handle end-of-day carry forward decisions.

The Session Manager operates at a higher level than individual trades. It monitors the overall health of the trading day and enforces strict capital protection rules that override all other modules.

---

## 2. Daily Session Manager

The Daily Session Manager tracks the cumulative realized P&L across all closed trades for the current trading day.

### 2.1 Capital Protection Limits

| Limit | Threshold | Action |
| ----- | --------- | ------ |
| Daily Profit Cap | +5% of account capital | Stop trading for the day |
| Daily Loss Cap | -2% of account capital | Stop trading for the day |

### 2.2 Enforcement

- Before any new trade is executed, the Executor queries the Session Manager.
- If either the profit cap or loss cap has been hit, the Session Manager returns `TRADING_HALTED`.
- The Executor rejects the trade and logs the reason.
- The dashboard displays a prominent "Trading Halted: Daily Limit Reached" banner.

---

## 3. Carry Forward Engine

The Carry Forward Engine evaluates open positions at 15:15 (3:15 PM) to determine if they should be held overnight or closed intraday.

### 3.1 Carry Forward Conditions

A position is ONLY carried forward if **all** of the following conditions are met:

1. **High Profitability:** The position is currently at >= +15% unrealized profit.
2. **Strong Trend:** The Momentum Score is > 70.
3. **Stable IV:** The IV Assessment is FAIR or CHEAP (not EXPENSIVE).
4. **No Imminent Expiry:** DTE > 2.

### 3.2 Action

- If all conditions are met: The position is marked as `CARRY_FORWARD` and remains open.
- If any condition fails: The position is forcefully closed at market price before 15:20 (3:20 PM).

---

## 4. State Persistence

The Session Manager persists its state to `output/session_state.json` (inside the `python_modules/output/` directory). This allows the session state to survive process restarts during the trading day.

---

## 5. Testing

The Session Manager's core logic (daily profit/loss caps, P&L percentage calculation, trade count tracking) is covered by the `TestSessionManager` class in `python_modules/test_python_modules.py` (5 tests).

---

*End of specification.*
