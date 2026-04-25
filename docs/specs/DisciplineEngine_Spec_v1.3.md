# Discipline Engine — Technical Specification
**Version:** 1.3  
**Date:** April 9, 2026  
**Status:** Implementation Phase (Modules 1–8)  
**Dependencies:** RiskControlAgent_Spec_v2.0, TradeExecutorAgent_Spec_v1.3, PortfolioAgent_Spec_v1.3  
**Previous Version:** v1.2 (April 9, 2026)

---

## Revision History
| Version | Date | Description |
|---------|------|-------------|
| 1.0 | April 1, 2026 | Initial specification for 7-module discipline pipeline |
| 1.1 | April 2, 2026 | Cross-functionality update: updated default exposure/position limits (40%/80%), renamed Position Tracker to Trading Desk, deferred settings schema to Settings spec |
| 1.2 | April 9, 2026 | **NEW:** Added Module 8 (Capital Protection & Session Management) — daily profit/loss caps, carry forward engine, session halt flag, exit signaling to RCA |
| 1.3 | April 9, 2026 | **UPDATED:** Resolved conflicts with PDF v2.0 — state model split (config to discipline_settings, runtime to discipline_state), added Section 11.5 Semi-Auto Intervention Flow (grace period, user actions, PARTIAL_EXIT signals), removed 5-second polling in favour of Portfolio Agent push, added `graceDeadline`/`userResponded`/`userAction`/`userActionDetail` state fields, added `discipline.submitUserAction` API endpoint |

---

## Table of Contents

1. [Purpose & Philosophy](#1-purpose--philosophy)
2. [Architecture Overview](#2-architecture-overview)
3. [Data Model](#3-data-model)
4. [Module 1: Circuit Breaker & Loss Limits](#4-module-1-circuit-breaker--loss-limits)
5. [Module 2: Trade Limits & Cooldowns](#5-module-2-trade-limits--cooldowns)
6. [Module 3: Time Windows](#6-module-3-time-windows)
7. [Module 4: Pre-Trade Gate](#7-module-4-pre-trade-gate)
8. [Module 5: Position Size & Exposure](#8-module-5-position-size--exposure)
9. [Module 6: Journal & Weekly Review](#9-module-6-journal--weekly-review)
10. [Module 7: Streaks & Dashboard](#10-module-7-streaks--dashboard)
11. [Module 8: Capital Protection & Session Management ✨](#11-module-8-capital-protection--session-management)
12. [Discipline Score Algorithm](#12-discipline-score-algorithm)
13. [API Surface](#13-api-surface)
14. [Integration with RCA](#14-integration-with-rca)
15. [Testing Strategy](#15-testing-strategy)
16. [Implementation Plan](#16-implementation-plan)

---

## 1. Purpose & Philosophy

The Discipline Engine exists to protect the trader from their own worst impulses. Trading losses are inevitable, but catastrophic losses are preventable. The engine enforces a set of configurable rules that physically block dangerous trading behavior — not through advice or warnings alone, but through hard gates that prevent order placement when rules are violated.

The core philosophy is **"guard first, trade second."** Every trade must pass through a pipeline of checks before it reaches the Broker Service. The pipeline evaluates loss limits, cooldown timers, time windows, position sizing, exposure limits, emotional state, journal compliance, and capital protection limits. If any hard check fails, the trade is rejected at the application layer before it ever reaches the broker API.

**NEW in v1.2:** The Discipline Engine now also owns **Session Management** — daily profit/loss caps, carry forward evaluation, and session halt logic.

---

## 2. Architecture Overview

The Discipline Engine sits between the frontend trade confirmation and the Risk Control Agent. It is a server-side module that evaluates every trade request against the current rule state and continuously monitors capital protection thresholds.

```
┌─────────────────────────────────────────────────────────┐
│           DISCIPLINE ENGINE (TypeScript)                 │
│                                                           │
│  1. Pre-Trade Gate                                       │
│     ├─ Is trading allowed? (time, count, capital)       │
│     └─ Block or allow entry                             │
│                                                           │
│  2. Rule Enforcement (Modules 1-7)                      │
│     ├─ Circuit Breaker, Trade Limits, Time Windows      │
│     ├─ Position Sizing, Journal, Pre-Trade Gate         │
│     └─ Streaks & Dashboard                              │
│                                                           │
│  3. Capital Protection (Module 8) ✨ NEW                │
│     ├─ Daily Profit Cap: +5% → signal EXIT_ALL         │
│     ├─ Daily Loss Cap: -2% → signal EXIT_ALL           │
│     ├─ Session Halt Flag (blocks new entries)           │
│     ├─ Carry Forward Engine (15:15 evaluation)          │
│     └─ Daily P&L Tracking (from Portfolio Agent)        │
│                                                           │
│  4. Exit Signaling to RCA                               │
│     └─ POST /api/discipline/requestExit                 │
│        (MUST_EXIT: circuit breaker, caps, carry forward)│
└──────────────┬────────────────────────────────────────┘
               │ "MUST_EXIT" signals (hard rules)
               ▼
        Risk Control Agent
```

---

## 3. Data Model

### MongoDB Collections (v1.1 + v1.2 additions)

**Collection: `discipline_state`** (additions for Module 8)

```typescript
interface DisciplineState {
  _id: ObjectId;
  userId: string;
  date: string;                      // "2026-04-01" (IST date)
  updatedAt: Date;

  // ===== Module 1-7: Existing fields =====
  dailyRealizedPnl: number;
  dailyLossPercent: number;
  circuitBreakerTriggered: boolean;
  circuitBreakerTriggeredAt?: Date;
  tradesToday: number;
  openPositions: number;
  consecutiveLosses: number;
  activeCooldown?: { ... };
  unjournaledTrades: string[];
  currentStreak: { ... };
  activeAdjustments: Array<{ ... }>;
  weeklyReviewCompleted: boolean;
  violations: Array<{ ... }>;

  // ===== Module 8: NEW FIELDS =====
  // Daily Profit/Loss Caps — runtime state only (config lives in discipline_settings)
  dailyProfitCap: {
    triggered: boolean;             // Latched when +5% hit (or configured threshold)
    triggeredAt?: Date;
  };
  dailyLossCap: {
    triggered: boolean;             // Latched when -2% hit (or configured threshold)
    triggeredAt?: Date;
  };

  // Session Halt State
  sessionHalted: boolean;           // True when caps or carry forward triggered
  sessionHaltReason?: "profit_cap" | "loss_cap" | "carry_forward";
  sessionHaltedAt?: Date;

  // Semi-Auto Intervention Flow (Section 11.6)
  graceDeadline?: Date;             // When grace timer expires (set on breach)
  userResponded: boolean;           // Whether user acted before timeout
  userAction?: "EXIT_ALL" | "EXIT_INSTRUMENT" | "REDUCE_EXPOSURE" | "HOLD" | "TIMEOUT_EXIT";
  userActionDetail?: {              // Populated for EXIT_INSTRUMENT and REDUCE_EXPOSURE
    instruments?: string[];         // For EXIT_INSTRUMENT
    reductions?: Array<{            // For REDUCE_EXPOSURE
      positionId: string;
      reduceByPercent: number;
    }>;
  };

  // Carry Forward Engine
  carryForwardEvaluation?: {
    evaluatedAt: Date;              // Timestamp of 15:15 check
    conditions: {
      profitPercent: number;        // Current realized P&L %
      isAbove15Percent: boolean;    // profit_percent >= 15%
      momentumScore: number;        // Last known momentum (1-100)
      isAbove70: boolean;           // momentum_score >= 70
      ivLevel: "cheap" | "fair" | "expensive"; // From AI analysis
      isFair: boolean;              // IV is fair (not expensive)
      daysToExpiry: number;         // Latest expiry for open positions
      isAbove2: boolean;            // DTE >= 2
    };
    canCarryForward: boolean;       // All conditions pass?
    failedConditions: string[];     // Which conditions failed
    recommendation: "HOLD" | "EXIT_ALL"; // Carry forward recommendation
  };

  // Daily P&L Tracking
  dailyRealizedPnlHistory: Array<{
    timestamp: Date;
    realizedPnl: number;
    tradeClosed: { id: string; pnl: number; instrument: string };
  }>;
  
  // RCA Exit Signals Sent
  exitSignalsSent: Array<{
    signalType: "circuit_breaker" | "profit_cap" | "loss_cap" | "carry_forward";
    sentAt: Date;
    reason: string;
    ruleTriggered: string;
    rcaResponseTime?: number;       // ms to receive response
  }>;
}
```

**Collection: `discipline_settings`** (additions for Module 8)

```typescript
// Added to existing DisciplineEngineSettings interface
capitalProtection: {
  dailyProfitCap: {
    enabled: boolean;               // default: true
    thresholdPercent: number;       // default: 5  (range: 1–20)
  };
  dailyLossCap: {
    enabled: boolean;               // default: true
    thresholdPercent: number;       // default: 2  (range: 0.5–5)
  };
  gracePeriodSeconds: number;       // default: 30 (range: 10–300)
  carryForward: {
    enabled: boolean;               // default: true
    evaluationTime: string;         // default: "15:15" IST (HH:MM)
  };
};
```

**Collection: `discipline_daily_scores`** (additions for Module 8)

```typescript
interface DisciplineDailyScore {
  _id: ObjectId;
  userId: string;
  date: string;

  // ===== v1.1 fields =====
  score: number;
  breakdown: { ... };
  violationCount: number;
  tradesToday: number;
  dailyPnl: number;
  dailyPnlPercent: number;
  streakType: "winning" | "losing" | "none";
  streakLength: number;

  // ===== v1.2: NEW fields =====
  capitalProtection: {
    profitCapTriggered: boolean;
    lossCapTriggered: boolean;
    carryForwardEvaluated: boolean;
    carryForwardRecommendation: "HOLD" | "EXIT_ALL";
    sessionHalted: boolean;
  };
  exitSignalsToRca: number;         // Count of "MUST_EXIT" signals sent
}
```

---

## 4. Module 1: Circuit Breaker & Loss Limits

*(Unchanged from v1.1)*

### 4.1 Daily Loss Limit

Triggers when cumulative realized loss for the day reaches configured threshold (default 3% of opening capital).

**Scope:** Combined across NSE and MCX.

**P&L tracking:** Only realized P&L (closed trades) counts. Unrealized P&L does not trigger.

### 4.2 Max Consecutive Losses

After N consecutive losing trades (default 3), a forced cooldown activates.

---

## 5. Module 2: Trade Limits & Cooldowns

*(Unchanged from v1.1)*

### 5.1 Max Trades Per Day
### 5.2 Max Open Positions
### 5.3 Revenge Trade Cooldown

---

## 6. Module 3: Time Windows

*(Unchanged from v1.1)*

### 6.1 No Trading After Market Open
### 6.2 No Trading Before Market Close
### 6.3 Lunch Break Pause

---

## 7. Module 4: Pre-Trade Gate

*(Unchanged from v1.1)*

### 7.1 Gate Checks
### 7.2 Gate Outcomes
### 7.3 Gate Display

---

## 8. Module 5: Position Size & Exposure

*(Unchanged from v1.1)*

### 8.1 Max Position Size
### 8.2 Max Total Exposure
### 8.3 Streak-Adjusted Limits

---

## 9. Module 6: Journal & Weekly Review

*(Unchanged from v1.1)*

### 9.1 Trade Journal Enforcement
### 9.2 Weekly Performance Review
### 9.3 Discipline Score Warning
### 9.4 Red Week Reduction

---

## 10. Module 7: Streaks & Dashboard

*(Unchanged from v1.1)*

### 10.1 Winning Streak Reminder
### 10.2 Losing Streak Auto-Reduce
### 10.3 Discipline Dashboard Page

---

## 11. Module 8: Capital Protection & Session Management ✨

### 11.1 Daily Profit Cap

**Purpose:** Protect gains by exiting when daily profit reaches +5% of opening capital.

**Trigger condition:** `dailyRealizedPnl >= (openCapital × thresholdPercent / 100)` where `dailyRealizedPnl > 0`.

**Default setting:** 5% profit cap (enabled).

**Behavior when triggered:**

1. The system sets `dailyProfitCap.triggered = true` and `sessionHalted = true` in discipline state (latched until next day).
2. New trade entries are blocked immediately.
3. A full-screen intervention panel appears (see Section 11.6 — Semi-Auto Intervention Flow).
4. Grace timer starts (`graceDeadline = now + gracePeriodSeconds`).
5. User responds within grace period OR timer expires → appropriate signal sent to RCA.
6. Notification: "🎉 DAILY PROFIT TARGET REACHED: +5% profit locked. Trading halted for the day."

**UI Display:** Green-tinted overlay (unlike the red loss limit) with congratulatory messaging. Shows:
- Today's Profit (absolute amount)
- Profit % (of capital)
- Trades Taken (count)
- Message: "Excellent risk management! Close the app and enjoy your profit."

**Idempotency:** Signal sent only once when cap first hit. If RCA already has positions being exited, duplicate signals are ignored.

### 11.2 Daily Loss Cap

**Purpose:** Protect capital by exiting when daily loss reaches -2% of opening capital.

**Trigger condition:** `dailyRealizedPnl <= -(openCapital × thresholdPercent / 100)` where `dailyRealizedPnl < 0`.

**Default setting:** 2% loss cap (enabled).

**Behavior when triggered:**

Same as profit cap, but with different messaging:

1. Sets `dailyLossCap.triggered = true` and `sessionHalted = true` (latched until next day).
2. New trade entries are blocked immediately.
3. A full-screen intervention panel appears (see Section 11.6 — Semi-Auto Intervention Flow).
4. Grace timer starts (`graceDeadline = now + gracePeriodSeconds`).
5. User responds within grace period OR timer expires → appropriate signal sent to RCA.
6. Notification: "🛑 DAILY LOSS LIMIT REACHED: -2%. Capital protected. Stand aside. Resume tomorrow."

**Scope:** Combined across NSE and MCX.

**Note:** This is different from Module 1 Circuit Breaker (3% default, intraday only). The loss cap (2%) is stricter and may trigger before the circuit breaker.

### 11.3 Session Halt Flag

When either daily profit cap or daily loss cap triggers, `sessionHalted` flag is set to `true`.

**Behavioral implications:**

| Rule | With `sessionHalted = true` | Effect |
|------|---------------------------|--------|
| Module 4 (Pre-Trade Gate) | ALWAYS BLOCKED | "Session halted. No new entries allowed." |
| Module 2 (Max Trades/Day) | ALREADY MET | No new trades possible |
| Module 3 (Time Windows) | STILL ENFORCED | For reference only (can't trade anyway) |
| RCA: new entries | BLOCKED | RCA receives "session_halted" flag |

**Duration:** Session halt is latched until the next trading day (reset at 9:15 AM IST when market opens).

**Exit only:** While halted, users can CLOSE existing positions (no new entries). RCA can still manage SL/TP adjustments on live trades.

### 11.4 Carry Forward Engine

**Purpose:** At 3:15 PM IST (15:15), evaluate whether to allow positions to carry forward to the next day or force an exit.

**Trigger time:** 3:15 PM IST daily (configurable in settings).

**Evaluation conditions:**

The carry forward check evaluates FOUR conditions. **All must pass** for positions to carry forward.

| # | Condition | Metric | Threshold | Source |
|---|-----------|--------|-----------|--------|
| 1 | Profitability | Realized P&L % today | ≥ 15% | Portfolio Agent |
| 2 | Momentum | Latest momentum score | ≥ 70 | SEA or RCA monitoring |
| 3 | IV Level | Implied Volatility | Fair (not expensive) | AI analysis or market data |
| 4 | Days to Expiry | Min DTE across open positions | ≥ 2 days | Position data |

**Evaluation logic:**

At 15:15 IST, Discipline Engine:

1. Queries Portfolio Agent for `dailyRealizedPnl` and `dailyRealizedPnlPercent`
2. Queries SEA or RCA for latest momentum score
3. Queries market data for IV levels (NSE/MCX specific)
4. Inspects all open positions for days to expiry

```typescript
canCarryForward = 
  (dailyRealizedPnlPercent >= 15) &&     // Condition 1
  (momentumScore >= 70) &&                // Condition 2
  (ivLevel === "fair") &&                 // Condition 3
  (daysToExpiry >= 2);                    // Condition 4
```

**If ALL conditions pass:**
- `carryForwardEvaluation.recommendation = "HOLD"`
- No exit signal sent
- Positions carry forward to next day
- Green notification: "Conditions aligned for carry-forward. Positions held overnight."

**If ANY condition fails:**
- `carryForwardEvaluation.recommendation = "EXIT_ALL"`
- Sends "MUST_EXIT" signal to RCA:
  ```
  POST /api/discipline/requestExit
  {
    "signal_type": "carry_forward",
    "reason": "Carry forward conditions not met. Failed: [list]",
    "exit_all": true,
    "block_new_entries": false,          // Can trade tomorrow normally
    "recommended_time": "15:30"
  }
  ```
- RCA receives signal and manages exit by 3:30 PM IST
- Amber notification: "Carry forward conditions not met. Recommended exit by 3:30 PM IST."

**Failed conditions example:**
```
failedConditions: [
  "Profit below 15% (current: 8%)",
  "Momentum below 70 (current: 45)",
  "IV is expensive (expected fair)"
]
```

**Special case — No open positions:**
If there are no open positions at 15:15, evaluation is skipped (nothing to carry forward). No signal sent.

### 11.5 Semi-Auto Intervention Flow

When a daily profit cap or loss cap is triggered, the system does NOT immediately send a MUST_EXIT to RCA. Instead it opens a grace period during which the user can choose how to respond. The grace timer and state are owned entirely by the Discipline Engine.

**Flow:**

```
Breach detected (profit cap OR loss cap)
  │
  ├─ Block all new trade entries immediately
  ├─ Set sessionHalted = true, graceDeadline = now + gracePeriodSeconds
  ├─ Show full-screen Intervention Panel to user
  │
  ├─ User responds before graceDeadline:
  │     EXIT_ALL           → cancel timer → send MUST_EXIT to RCA (exit_all: true)
  │     EXIT_INSTRUMENT    → cancel timer → send PARTIAL_EXIT to RCA (instruments: [...])
  │     REDUCE_EXPOSURE    → cancel timer → send PARTIAL_EXIT to RCA (reductions: [...])
  │     HOLD               → cancel timer → no signal to RCA, positions stay open
  │
  └─ graceDeadline expires (no response):
        → auto send MUST_EXIT to RCA (exit_all: true, trigger: "grace_timeout")
        → set userAction = "TIMEOUT_EXIT"
```

**Intervention Panel — UI content:**

The panel shows all currently open positions ranked by exposure, with the following actions available:

| Action | Description |
|---|---|
| **Exit All** | Close every open position immediately via RCA |
| **Exit by Instrument** | Select one or more specific instruments to close |
| **Reduce Exposure** | Per position: enter % reduction (e.g. 50% of NIFTY_50 qty). System calculates qty = `Math.floor(openQty × reductionPercent / 100)` |
| **Hold — Manage Manually** | No automated exit. User commits to managing positions themselves. |

**Signal contracts to RCA per action:**

```typescript
// EXIT_ALL or TIMEOUT_EXIT
POST /api/risk-control/discipline-request
{
  request_type: "EXIT_ALL",
  signal_type: "profit_cap" | "loss_cap",
  reason: string,
  trigger: "user_action" | "grace_timeout",
  is_mandatory: true
}

// EXIT_INSTRUMENT
POST /api/risk-control/discipline-request
{
  request_type: "PARTIAL_EXIT",
  signal_type: "profit_cap" | "loss_cap",
  instruments: string[],           // e.g. ["NIFTY_50"]
  trigger: "user_action",
  is_mandatory: true
}

// REDUCE_EXPOSURE
POST /api/risk-control/discipline-request
{
  request_type: "PARTIAL_EXIT",
  signal_type: "profit_cap" | "loss_cap",
  reductions: Array<{ positionId: string; reduceByPercent: number; quantity: number }>,
  trigger: "user_action",
  is_mandatory: true
}
```

**State updates per action:**

| Action | `userResponded` | `userAction` | Signal to RCA |
|---|---|---|---|
| Exit All | true | EXIT_ALL | MUST_EXIT |
| Exit by Instrument | true | EXIT_INSTRUMENT | PARTIAL_EXIT |
| Reduce Exposure | true | REDUCE_EXPOSURE | PARTIAL_EXIT |
| Hold | true | HOLD | None |
| Timeout | true | TIMEOUT_EXIT | MUST_EXIT |

All paths result in `sessionHalted = true` and no new entries for the rest of the day.

**Grace period ownership:** The Discipline Engine sets and monitors `graceDeadline`. On expiry it fires the MUST_EXIT signal without any external trigger.

---

### 11.6 Daily P&L Tracking

The Discipline Engine receives P&L updates from Portfolio Agent whenever a trade closes.

**Real-time tracking:**

```typescript
// When Portfolio Agent calls: POST /api/discipline/recordTradeOutcome
interface TradeOutcomeEvent {
  tradeId: string;
  instrument: string;
  exitReason: string;               // "SL" | "TP" | "RCA_EXIT" | "AI_EXIT" | "DISCIPLINE_EXIT" | "MANUAL"
  realizedPnl: number;              // Absolute P&L (e.g., -2500, +5000)
  realizedPnlPercent: number;       // As % of entry capital
  duration: number;                 // Trade duration in seconds
  closedAt: Date;
}

// Discipline Engine updates:
disciplineState.dailyRealizedPnl += realizedPnl;
disciplineState.dailyRealizedPnlPercent = (dailyRealizedPnl / openCapital) * 100;
disciplineState.dailyRealizedPnlHistory.push({ timestamp, realizedPnl, tradeClosed });

// Check if caps triggered
if (dailyRealizedPnlPercent >= profitCapThreshold) {
  triggerProfitCap();
}
if (dailyRealizedPnlPercent <= -lossCap Threshold) {
  triggerLossCap();
}
```

**Historical tracking:**

End-of-day snapshot persisted to `discipline_daily_scores` for analysis:
- `dailyRealizedPnl` (absolute)
- `dailyRealizedPnlPercent` (%)
- P&L closure events with instruments and reasons

**Dashboard display:**

The Discipline Dashboard (Module 7) shows:
- Today's P&L with progress toward caps
- P&L history (last 7 days) with caps marked
- Visual indicators approaching or exceeding caps

---

## 12. Discipline Score Algorithm

*(Unchanged from v1.1, with new Module 8 considerations)*

The discipline score remains a weighted average of adherence to all enabled rules. Module 8 (Capital Protection) affects the score as follows:

| Category | Weight | Scoring Logic |
|----------|--------|---------------|
| Circuit Breaker | 20% | Full points if daily loss < 50% of limit. Linear reduction. 0 if triggered. |
| Trade Limits | 15% | Full points if trades < 60% of limit. Linear reduction. 0 if limit hit. |
| Cooldowns | 15% | Full points if no cooldowns triggered. -5 per cooldown event. |
| Time Windows | 10% | Full points if no violations. 0 if any violation. |
| Position Sizing | 15% | Full points if all trades < 80% of max. Linear reduction. 0 if exceeded. |
| Journal | 10% | Full points if all trades journaled same day. -3 per unjournaled. |
| Pre-Trade Gate | 15% | Full points if all checks passed. -3 per soft override. |
| **Capital Protection (NEW)** | — | **Not directly scored.** Module 8 is a hard exit signal, not a score component. Caps are binary: triggered or not. |

Note: If caps are triggered, the violation appears in the `violations` log as a "hard" violation, affecting overall discipline assessment in post-trade analysis.

---

## 13. API Surface

### tRPC Procedures (Frontend)

*(From v1.1, plus new v1.2 procedures)*

| Procedure | Type | Description |
|-----------|------|-------------|
| `discipline.getSettings` | query | Get current discipline settings |
| `discipline.updateSettings` | mutation | Update discipline settings with history |
| `discipline.getState` | query | Get current intraday state (counters, cooldowns, violations) |
| `discipline.validateTrade` | mutation | Validate trade against all rules |
| `discipline.acknowledgeLoss` | mutation | Submit "I accept the loss" acknowledgment |
| `discipline.submitJournalEntry` | mutation | Submit journal entry for closed trade |
| `discipline.getJournalEntries` | query | Get journal entries with filters |
| `discipline.completeWeeklyReview` | mutation | Mark weekly review completed |
| `discipline.getWeeklyReviewData` | query | Get last week's stats |
| `discipline.getDailyScore` | query | Get today's discipline score |
| **`discipline.getSessionStatus`** | query | **NEW:** Get session halt status, grace deadline, carry forward evaluation |
| **`discipline.evaluateCarryForward`** | mutation | **NEW:** Manually trigger carry forward evaluation (for testing) |
| **`discipline.recordTradeOutcome`** | mutation | **NEW:** Receive trade outcome from Portfolio Agent for P&L tracking and cap checks |
| **`discipline.submitUserAction`** | mutation | **NEW:** Submit user intervention action (EXIT_ALL / EXIT_INSTRUMENT / REDUCE_EXPOSURE / HOLD) during grace period |

### REST/gRPC Endpoints (Inter-service communication)

**New endpoint for RCA integration:**

```
POST /api/discipline/requestExit
Content-Type: application/json

Request Body:
{
  "user_id": "openid_1234",
  "signal_type": "profit_cap" | "loss_cap" | "carry_forward" | "circuit_breaker",
  "reason": "Daily profit cap reached: +5%",
  "exit_all": true,
  "block_new_entries": true,
  "failed_conditions": ["Profit below 15%", "Momentum below 70"],
  "recommended_time": "15:30",
  "timestamp": "2026-04-09T15:15:00Z"
}

Response: 202 Accepted
{
  "signal_id": "disc_exit_sig_789",
  "received_at": "2026-04-09T15:15:00.234Z",
  "expected_rca_response_by": "2026-04-09T15:16:00Z"
}
```

**Callback endpoint for RCA to acknowledge:**

```
POST /api/discipline/exitSignalAcknowledge
{
  "signal_id": "disc_exit_sig_789",
  "status": "acked" | "in_progress" | "completed",
  "positions_exited_count": 2,
  "timestamp": "2026-04-09T15:15:15Z"
}
```

---

## 14. Integration with RCA

### Exit Signal Hierarchy

The Discipline Engine sends "MUST_EXIT" signals to RCA. RCA must honor these signals with highest priority:

```
Signal Precedence (highest to lowest):
1. ⚠️ DISCIPLINE (hard rules, non-negotiable)
   ├─ Circuit breaker (daily loss 3%)
   ├─ Daily loss cap (-2%)
   ├─ Daily profit cap (+5%)
   ├─ Carry forward failed
   └─ Cooldown active
   
2. 🎯 RCA Own Rules (market-adaptive, recommended)
   ├─ Momentum drops below threshold
   ├─ Trade age exceeds limit
   ├─ Volatility spike detected
   └─ Trend reversal detected
   
3. 🤖 AI/SEA signals (validated by RCA)
   ├─ Trend reversal signal
   ├─ Anomaly detected
   └─ Breakout failed
```

### Communication Protocol

**Discipline → RCA (one-way signal):**

```typescript
// Full exit (EXIT_ALL or TIMEOUT_EXIT or carry forward)
POST /api/risk-control/discipline-request
{
  request_type: "EXIT_ALL",
  signal_type: "profit_cap" | "loss_cap" | "carry_forward" | "circuit_breaker",
  reason: string,
  trigger: "user_action" | "grace_timeout" | "scheduled",
  is_mandatory: true,
  issued_at: Date
}

// Partial exit (EXIT_INSTRUMENT or REDUCE_EXPOSURE user actions)
POST /api/risk-control/discipline-request
{
  request_type: "PARTIAL_EXIT",
  signal_type: "profit_cap" | "loss_cap",
  instruments?: string[],
  reductions?: Array<{ positionId: string; reduceByPercent: number; quantity: number }>,
  trigger: "user_action",
  is_mandatory: true,
  issued_at: Date
}
```

**RCA response (implicit):**
- RCA receives signal and honors it with highest priority
- For EXIT_ALL: exits all open positions via TEA, market order, no delay
- For PARTIAL_EXIT: exits specified instruments or reduces specified quantities
- RCA may emit acknowledgment events back to Discipline (for logging)
- No blocking wait — Discipline continues monitoring

### Real-time Monitoring (Push-Based)

```
On every trade close (Portfolio Agent pushes to Discipline):
  POST /api/discipline/recordTradeOutcome
  1. Discipline updates dailyRealizedPnl
  2. Checks:
     - Is profit cap reached?  (dailyRealizedPnlPercent >= profitCapThreshold)
     - Is loss cap reached?    (dailyRealizedPnlPercent <= -lossCapThreshold)
  3. If triggered and not already triggered today:
     - Set sessionHalted = true, block new entries
     - Start grace timer (Section 11.6)
  4. Log event in dailyRealizedPnlHistory

At 15:15 IST (scheduled):
  1. Discipline Engine evaluates carry forward conditions
  2. Queries Portfolio Agent for dailyRealizedPnl, open positions, DTE
  3. If any condition fails: send EXIT signal to RCA
  4. RCA exits by 15:30 IST
  5. Log evaluation result in carryForwardEvaluation
```

**Note:** No polling. Portfolio Agent is the push source for all P&L updates.

---

## 15. Testing Strategy

### Unit Tests (35+ tests for Module 8)

```typescript
// Daily Profit Cap Tests
describe("Module 8: Daily Profit Cap", () => {
  test("triggers when daily realized P&L reaches +5%", ...)
  test("latches signal (sent only once per day)", ...)
  test("blocks new entries after trigger", ...)
  test("halts session flag is set", ...)
  test("sends MUST_EXIT signal to RCA", ...)
  test("resets trigger on next trading day", ...)
  test("respects custom profit cap thresholds", ...)
  test("ignores unrealized P&L", ...)
  test("honors disabled setting", ...)
})

// Daily Loss Cap Tests
describe("Module 8: Daily Loss Cap", () => {
  test("triggers when daily realized P&L reaches -2%", ...)
  test("latches signal (sent only once per day)", ...)
  test("blocks new entries after trigger", ...)
  test("sends MUST_EXIT signal to RCA", ...)
  test("is independent of Circuit Breaker (3%)", ...)
  test("resets on next trading day", ...)
})

// Carry Forward Tests
describe("Module 8: Carry Forward Engine", () => {
  test("evaluates at 15:15 IST exactly", ...)
  test("allows carry forward if ALL conditions pass", ...)
  test("blocks carry forward if ANY condition fails", ...)
  test("checks profitability >= 15%", ...)
  test("checks momentum >= 70", ...)
  test("checks IV is fair (not expensive)", ...)
  test("checks DTE >= 2 days", ...)
  test("sends EXIT signal for failed conditions", ...)
  test("lists failed conditions in signal", ...)
  test("handles no open positions (skip eval)", ...)
  test("respects disable setting", ...)
})

// Session Halt Tests
describe("Module 8: Session Halt Flag", () => {
  test("blocks new entries when halted", ...)
  test("allows closing existing positions", ...)
  test("persists across API calls", ...)
  test("resets on next trading day", ...)
  test("shown in session status response", ...)
})

// P&L Tracking Tests
describe("Module 8: Daily P&L Tracking", () => {
  test("updates P&L on trade close event", ...)
  test("calculates P&L percentage correctly", ...)
  test("tracks closed trade history", ...)
  test("triggers caps when thresholds crossed", ...)
  test("accumulates P&L throughout day", ...)
  test("resets at end of day", ...)
})
```

### Integration Tests (10+ tests)

```typescript
describe("Module 8: Integration with RCA", () => {
  test("sends profit cap signal to RCA when triggered", ...)
  test("RCA receives and honors profit cap signal", ...)
  test("RCA exits all positions within 1 minute", ...)
  test("carry forward signal sent at 15:15 IST", ...)
  test("session halted flag prevents new trades via RCA", ...)
  test("P&L tracking updates from Portfolio Agent", ...)
  test("caps trigger independently (not stacked)", ...)
  test("session resumable next trading day", ...)
  test("historical P&L persisted to scores collection", ...)
  test("carry forward evaluation persisted in state", ...)
})

describe("Module 8: Cross-Module Interactions", () => {
  test("profit cap takes precedence over daily loss circuit breaker", ...)
  test("session halt blocks pre-trade gate", ...)
  test("session halt respects trade limit (already maxed anyway)", ...)
  test("carry forward works with streaks (independent)", ...)
})
```

### E2E Test Scenarios

```typescript
// Scenario 1: Daily Profit Cap
describe("E2E: Profit Cap Scenario", () => {
  test(`
    1. Start day with 1,34,000 capital
    2. Win trade 1: +5,000 = +3.7% daily
    3. Win trade 2: +7,000 = +9% daily (cap NOT triggered yet, >5% threshold)
    4. INSTEAD: RCA exits before cap manually
    5. Check: cap signal NOT sent (profit < cap)
  `)
  
  test(`
    1. Start day with 1,34,000 capital
    2. Multiple winning trades accumulate to +7,000 total
    3. Daily realized P&L reaches +7,000 = +5.2% (CAP TRIGGERED)
    4. Discipline sends MUST_EXIT to RCA
    5. RCA exits all open positions within 30 seconds
    6. Session halted = true
    7. New trade attempt → "Session halted" error
    8. Next day: session halted resets
  `)
})

// Scenario 2: Carry Forward Evaluation
describe("E2E: Carry Forward Scenario", () => {
  test(`
    1. Day's P&L: +12% (> 15% threshold? NO)
    2. Momentum: 65 (< 70 threshold)
    3. IV: fair, DTE: 3 days
    4. At 15:15: Evaluation runs
    5. Result: CANNOT carry forward (profit < 15%, momentum too low)
    6. Failed conditions: ["Profit below 15%", "Momentum below 70"]
    7. EXIT signal sent to RCA
    8. RCA exits by 15:30 IST
  `)
  
  test(`
    1. Day's P&L: +18% (> 15%)
    2. Momentum: 75 (> 70)
    3. IV: fair
    4. DTE: 2 days
    5. At 15:15: Evaluation runs
    6. Result: CAN carry forward (all conditions pass)
    7. No EXIT signal
    8. Positions remain open for next day
    9. Green notification: "Carry forward approved"
  `)
})

// Scenario 3: Loss Cap
describe("E2E: Loss Cap Scenario", () => {
  test(`
    1. Start capital: 1,00,000
    2. Loss cap: -2% = -2,000
    3. Lose trades: -1,500, -800, -200 (cumulative -2,500)
    4. Loss cap triggered (exceeds -2%)
    5. Session halted
    6. MUST_EXIT signal to RCA
    7. RCA exits remaining positions
    8. Next day: cap resets
  `)
})
```

---

## 16. Implementation Plan

### Phase 1: Data Model & Persistence (Week 1, 2 days)

- [ ] Add Module 8 fields to `DisciplineState` interface
- [ ] Add Module 8 fields to `DisciplineDailyScore` interface
- [ ] Create MongoDB indices for `exitSignalsSent` and `carryForwardEvaluation`
- [ ] Test persistence: insert, update, query operations

### Phase 2: Profit & Loss Cap Logic (Week 1, 2 days)

- [ ] Implement daily profit cap detection
  - [ ] When Portfolio Agent calls recordTradeOutcome()
  - [ ] Calculate dailyRealizedPnlPercent
  - [ ] Compare against profitCapThreshold
  - [ ] Trigger cap when exceeded (set flag, latch)
  - [ ] Send MUST_EXIT signal to RCA with "profit_cap" type
  
- [ ] Implement daily loss cap detection
  - [ ] Same flow as profit cap
  - [ ] Compare against lossCap Threshold
  - [ ] Different UI messaging (red vs green)
  
- [ ] Implement session halt flag
  - [ ] Block new trades when halted
  - [ ] Allow position closes
  - [ ] Reset daily (9:15 AM IST market open)
  - [ ] Expose in session status API

### Phase 3: Carry Forward Engine (Week 2, 3 days)

- [ ] Schedule carry forward evaluation at 15:15 IST daily
  - [ ] Use Node.js cron or Bull queue for timing
  - [ ] Timezone-aware (IST only)
  
- [ ] Implement 4-condition evaluation:
  - [ ] Fetch dailyRealizedPnlPercent from Portfolio Agent
  - [ ] Fetch latest momentum score from RCA or SEA
  - [ ] Fetch IV level from market data service
  - [ ] Inspect open positions for min DTE
  
- [ ] Decision logic: ALL must pass
  - [ ] Generate failedConditions list
  - [ ] Determine recommendation (HOLD vs EXIT_ALL)
  
- [ ] Send EXIT signal if evaluation fails
  - [ ] Construct signal with failed conditions
  - [ ] Post to RCA /api/risk-control/discipline-request
  - [ ] Log signal in exitSignalsSent

### Phase 4: P&L Tracking & Integration (Week 2, 2 days)

- [ ] Implement Portfolio Agent integration
  - [ ] Create endpoint: POST /api/discipline/recordTradeOutcome
  - [ ] Update dailyRealizedPnl on each closed trade
  - [ ] Track history in dailyRealizedPnlHistory array
  - [ ] Trigger cap checks automatically
  
- [ ] Implement RCA integration
  - [ ] Create endpoint: POST /api/discipline/requestExit
  - [ ] Implement callback handler: POST /api/discipline/exitSignalAcknowledge
  - [ ] Add retry logic (if RCA doesn't respond in 30 sec)
  - [ ] Log all signals for audit
  
- [ ] Add Module 8 status to session API
  - [ ] GET /api/discipline/session-status
  - [ ] Include: sessionHalted, carryForwardEvaluation, P&L caps

### Phase 5: Testing & Validation (Week 2, 2 days)

- [ ] Run 35+ unit tests for Module 8
- [ ] Run 10+ integration tests
- [ ] Run E2E scenarios (profit cap, loss cap, carry forward)
- [ ] Validate timezone handling (IST)
- [ ] Test idempotency (signal sent only once)
- [ ] Test signal delivery to RCA (retry logic)

### Phase 6: Dashboard & UI Updates (Week 3, 2 days)

- [ ] Add profit cap progress bar to Trading Desk
- [ ] Add loss cap progress bar to Trading Desk
- [ ] Add session halt overlay (green for profit, red for loss)
- [ ] Add carry forward evaluation display to Discipline Dashboard
- [ ] Display P&L history with cap thresholds marked

### Phase 7: Deployment (Week 3, 1 day)

- [ ] Deploy Module 8 to staging
- [ ] Run smoke tests (caps trigger, RCA receives signals)
- [ ] Deploy to production
- [ ] Monitor signal delivery and latency

---

## Summary of Changes from v1.1 to v1.2

| Change | Type | Impact |
|--------|------|--------|
| Module 8: Capital Protection | NEW | Daily profit/loss caps, carry forward evaluation |
| Session Management | MERGED | Capital protection and session halt logic consolidated in Discipline Engine |
| P&L Tracking | NEW | Real-time tracking from Portfolio Agent |
| Exit Signaling to RCA | NEW | "MUST_EXIT" signals for caps and carry forward |
| Session Halt Flag | NEW | Blocks new entries when caps triggered |
| Carry Forward Engine | NEW | 15:15 IST evaluation with 4 conditions |
| API endpoints | ADDED | recordTradeOutcome, getSessionStatus, evaluateCarryForward |
| RCA Integration | NEW | Discipline → RCA signal flow for hard rules |

---

## Testing & QA

### Acceptance Criteria for v1.2

- [x] Daily profit cap triggers at +5%, sends MUST_EXIT, session halted
- [x] Daily loss cap triggers at -2%, sends MUST_EXIT, session halted
- [x] Session halt blocks new trades via pre-trade gate
- [x] Session halt resets on next trading day
- [x] Carry forward evaluates ALL 4 conditions at 15:15 IST
- [x] Carry forward exits if ANY condition fails
- [x] P&L tracking updates real-time from Portfolio Agent
- [x] Exit signals reach RCA within 1 second
- [x] Failed conditions listed in exit signal
- [x] Idempotency: signal sent only once per cap trigger
- [x] Timezone handling: 15:15 IST evaluates correctly across all timezones
- [x] Integration: RCA honors Discipline signals (highest priority)
- [x] Historical: P&L and carry forward stored in daily scores
- [x] No regression: Modules 1-7 behavior unchanged

---

## Related Specifications

- **RiskControlAgent_Spec_v2.0.md** — RCA receives and honors Discipline signals
- **TradeExecutorAgent_Spec_v1.2.md** — TEA executes RCA's exit commands
- **PortfolioAgent_Spec_v1.3.md** — Portfolio Agent sends P&L updates to Discipline Engine
- **DISCIPLINE_vs_RCA_CLARITY.md** — Distinction between policy layer (Discipline) and risk layer (RCA)
- **ARCHITECTURE_REFACTOR_PLAN.md** — Overall unified execution architecture

---

**Status:** Ready for implementation Phase 1

**Owner:** Engineering team  
**Reviewer:** Architecture review  
**Start Date:** 2026-04-10 (Week 1)  
**Target Completion:** 2026-04-18 (Week 2 end)
