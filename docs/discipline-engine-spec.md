# Discipline Engine — Technical Specification

**Version:** 1.0  
**Date:** April 1, 2026  
**Status:** Pending Implementation (Features 14–20)  
**Dependencies:** Feature 4 (Settings Page), Feature 5 (Position Tracker Core), Feature 11 (Market Hours)  
**Mockup:** `mockups/discipline-mockup/index.html` (8 tabs, full UI reference)

---

## Table of Contents

1. [Purpose & Philosophy](#1-purpose--philosophy)
2. [Architecture Overview](#2-architecture-overview)
3. [Data Model](#3-data-model)
4. [Module 1: Circuit Breaker & Loss Limits (Feature 14)](#4-module-1-circuit-breaker--loss-limits)
5. [Module 2: Trade Limits & Cooldowns (Feature 15)](#5-module-2-trade-limits--cooldowns)
6. [Module 3: Time Windows (Feature 16)](#6-module-3-time-windows)
7. [Module 4: Pre-Trade Gate (Feature 17)](#7-module-4-pre-trade-gate)
8. [Module 5: Position Size & Exposure (Feature 18)](#8-module-5-position-size--exposure)
9. [Module 6: Journal & Weekly Review (Feature 19)](#9-module-6-journal--weekly-review)
10. [Module 7: Streaks & Dashboard (Feature 20)](#10-module-7-streaks--dashboard)
11. [Discipline Score Algorithm](#11-discipline-score-algorithm)
12. [Settings Schema & Defaults](#12-settings-schema--defaults)
13. [API Surface](#13-api-surface)
14. [UI Components](#14-ui-components)
15. [Testing Strategy](#15-testing-strategy)
16. [Implementation Order](#16-implementation-order)

---

## 1. Purpose & Philosophy

The Discipline Engine exists to protect the trader from their own worst impulses. Trading losses are inevitable, but catastrophic losses are preventable. The engine enforces a set of configurable rules that physically block dangerous trading behavior — not through advice or warnings alone, but through hard gates that prevent order placement when rules are violated.

The core philosophy is **"guard first, trade second."** Every trade must pass through a pipeline of checks before it reaches the Broker Service. The pipeline evaluates loss limits, cooldown timers, time windows, position sizing, exposure limits, emotional state, and journal compliance. If any hard check fails, the trade is rejected at the application layer before it ever reaches the broker API.

Every rule has three properties: an **enabled/disabled toggle**, one or more **configurable parameters**, and a **severity level** (hard block vs soft warning). Hard blocks physically prevent the trade. Soft warnings display an amber banner but allow the user to override with acknowledgment. The user can tighten or loosen all parameters through the Settings page, and all changes are logged with timestamps in MongoDB for audit.

The Discipline Engine operates across both exchanges (NSE and MCX) with exchange-aware time calculations. Loss limits and trade counts are combined across exchanges (one shared pool), while time windows are configured separately per exchange due to different market hours.

---

## 2. Architecture Overview

### System Position

The Discipline Engine sits between the frontend trade confirmation and the Broker Service. It is a server-side module that evaluates every trade request against the current rule state.

```
User clicks "Place Trade"
        │
        ▼
┌─────────────────────────┐
│   Pre-Trade Gate (UI)   │  ← Frontend checklist (emotional state, plan alignment)
│   Feature 17            │
└────────────┬────────────┘
             │ tRPC mutation: discipline.validateTrade
             ▼
┌─────────────────────────┐
│   Discipline Engine     │  ← Server-side rule evaluation
│   (server/discipline/)  │
│                         │
│  ┌───────────────────┐  │
│  │ Circuit Breaker   │  │  Check daily loss limit, consecutive losses
│  │ (Feature 14)      │  │
│  └────────┬──────────┘  │
│           ▼             │
│  ┌───────────────────┐  │
│  │ Trade Limits      │  │  Check max trades/day, max open positions
│  │ (Feature 15)      │  │
│  └────────┬──────────┘  │
│           ▼             │
│  ┌───────────────────┐  │
│  │ Cooldown Check    │  │  Check revenge cooldown timer, consecutive loss cooldown
│  │ (Feature 15)      │  │
│  └────────┬──────────┘  │
│           ▼             │
│  ┌───────────────────┐  │
│  │ Time Windows      │  │  Check market open/close blocks, lunch pause
│  │ (Feature 16)      │  │
│  └────────┬──────────┘  │
│           ▼             │
│  ┌───────────────────┐  │
│  │ Position Sizing   │  │  Check max position %, max exposure %
│  │ (Feature 18)      │  │
│  └────────┬──────────┘  │
│           ▼             │
│  ┌───────────────────┐  │
│  │ Journal Check     │  │  Check unjournaled trade count
│  │ (Feature 19)      │  │
│  └────────┬──────────┘  │
│           ▼             │
│  ┌───────────────────┐  │
│  │ Streak Adjustments│  │  Apply auto-reduced limits if on losing streak
│  │ (Feature 20)      │  │
│  └────────┬──────────┘  │
│           ▼             │
│  PASS / BLOCK + reason  │
└────────────┬────────────┘
             │
             ▼ (if PASS)
┌─────────────────────────┐
│   Broker Service        │  ← Order placement via adapter
│   (server/broker/)      │
└─────────────────────────┘
```

### File Structure

```
server/
  discipline/
    index.ts              ← DisciplineEngine class (singleton, orchestrator)
    types.ts              ← All discipline types and interfaces
    circuitBreaker.ts     ← Daily loss limit + consecutive loss tracking
    tradeLimits.ts        ← Max trades/day, max open positions, cooldowns
    timeWindows.ts        ← Market open/close blocks, lunch pause
    preTrade.ts           ← Pre-trade gate check evaluation
    positionSizing.ts     ← Max position %, max exposure %
    journalCheck.ts       ← Unjournaled trade enforcement
    streaks.ts            ← Winning/losing streak detection + auto-adjustments
    score.ts              ← Discipline score calculation engine
    violations.ts         ← Violation logging and retrieval
    settings.ts           ← Settings CRUD (MongoDB)
    disciplineRouter.ts   ← tRPC procedures
  discipline.test.ts      ← Vitest test file
```

### Core Interface

```typescript
interface TradeValidationRequest {
  instrument: string;           // "NIFTY_50" | "BANKNIFTY" | "CRUDEOIL" | "NATURALGAS"
  exchange: "NSE" | "MCX";     // Derived from instrument
  transactionType: "BUY" | "SELL";
  optionType: "CE" | "PE";
  strike: number;
  entryPrice: number;
  quantity: number;
  estimatedValue: number;       // entryPrice × quantity
  aiConfidence?: number;
  aiRiskReward?: number;
  emotionalState?: "calm" | "anxious" | "revenge" | "fomo" | "greedy" | "neutral";
  planAligned?: boolean;
  checklistDone?: boolean;
}

interface TradeValidationResult {
  allowed: boolean;
  blockedBy: string[];          // Rule IDs that blocked the trade
  warnings: string[];           // Soft warnings (non-blocking)
  adjustments: string[];        // Auto-adjustments applied (e.g., reduced position size)
  details: {
    circuitBreaker: { passed: boolean; reason?: string; dailyLoss?: number; dailyLossPercent?: number };
    tradeLimits: { passed: boolean; reason?: string; tradesUsed?: number; positionsOpen?: number };
    cooldown: { passed: boolean; reason?: string; remainingSeconds?: number; cooldownType?: string };
    timeWindow: { passed: boolean; reason?: string; blockedUntil?: string; exchange?: string };
    positionSize: { passed: boolean; reason?: string; positionPercent?: number; exposurePercent?: number };
    journal: { passed: boolean; reason?: string; unjournaledCount?: number };
    preTrade: { passed: boolean; reason?: string; failedChecks?: string[] };
    streaks: { active: boolean; type?: "winning" | "losing"; length?: number; adjustments?: string[] };
  };
}
```

---

## 3. Data Model

### MongoDB Collections

**Collection: `discipline_settings`**

Stores per-user discipline configuration. Each setting has an `enabled` toggle and configurable parameters. All changes are appended to a `history` array for audit.

```typescript
interface DisciplineSettings {
  _id: ObjectId;
  userId: string;                    // Owner's openId
  updatedAt: Date;

  // Module 1: Circuit Breaker
  dailyLossLimit: {
    enabled: boolean;                // default: true
    thresholdPercent: number;        // default: 3
  };
  maxConsecutiveLosses: {
    enabled: boolean;                // default: true
    maxLosses: number;               // default: 3
    cooldownMinutes: number;         // default: 30
  };

  // Module 2: Trade Limits
  maxTradesPerDay: {
    enabled: boolean;                // default: true
    limit: number;                   // default: 5
  };
  maxOpenPositions: {
    enabled: boolean;                // default: true
    limit: number;                   // default: 3
  };
  revengeCooldown: {
    enabled: boolean;                // default: true
    durationMinutes: number;         // default: 15 (options: 10, 15, 30)
    requireAcknowledgment: boolean;  // default: true
  };

  // Module 3: Time Windows
  noTradingAfterOpen: {
    enabled: boolean;                // default: true
    nseMinutes: number;              // default: 15
    mcxMinutes: number;              // default: 15
  };
  noTradingBeforeClose: {
    enabled: boolean;                // default: true
    nseMinutes: number;              // default: 15
    mcxMinutes: number;              // default: 15
  };
  lunchBreakPause: {
    enabled: boolean;                // default: false
    startTime: string;               // default: "12:30"
    endTime: string;                 // default: "13:30"
  };

  // Module 4: Pre-Trade Gate
  preTradeGate: {
    enabled: boolean;                // default: true
    minRiskReward: {
      enabled: boolean;              // default: true
      ratio: number;                 // default: 1.5
    };
    emotionalStateCheck: {
      enabled: boolean;              // default: true
      blockStates: string[];         // default: ["revenge", "fomo"]
    };
  };

  // Module 5: Position Sizing
  maxPositionSize: {
    enabled: boolean;                // default: true
    percentOfCapital: number;        // default: 10
  };
  maxTotalExposure: {
    enabled: boolean;                // default: true
    percentOfCapital: number;        // default: 30
  };

  // Module 6: Journal
  journalEnforcement: {
    enabled: boolean;                // default: true
    maxUnjournaled: number;          // default: 3
  };
  weeklyReview: {
    enabled: boolean;                // default: true
    disciplineScoreWarning: number;  // default: 70
    redWeekReduction: number;        // default: 3 (consecutive red weeks)
  };

  // Module 7: Streaks
  winningStreakReminder: {
    enabled: boolean;                // default: true
    triggerAfterDays: number;        // default: 5
  };
  losingStreakAutoReduce: {
    enabled: boolean;                // default: true
    triggerAfterDays: number;        // default: 3
    reduceByPercent: number;         // default: 50
  };

  // Change history
  history: Array<{
    changedAt: Date;
    field: string;
    oldValue: any;
    newValue: any;
  }>;
}
```

**Collection: `discipline_state`**

Tracks the current intraday state of the discipline engine. Reset daily at market open.

```typescript
interface DisciplineState {
  _id: ObjectId;
  userId: string;
  date: string;                      // "2026-04-01" (IST date)
  updatedAt: Date;

  // Circuit breaker state
  dailyRealizedPnl: number;         // Running total of realized P&L today (net)
  dailyLossPercent: number;          // dailyRealizedPnl / openCapital × 100
  circuitBreakerTriggered: boolean;  // Latched true when limit hit
  circuitBreakerTriggeredAt?: Date;

  // Trade counters
  tradesToday: number;               // Count of trades placed today
  openPositions: number;             // Count of currently open positions
  consecutiveLosses: number;         // Running count of back-to-back losses (resets on win)

  // Cooldown state
  activeCooldown?: {
    type: "revenge" | "consecutive_loss";
    startedAt: Date;
    endsAt: Date;
    acknowledged: boolean;           // For "I accept the loss" requirement
    triggerTrade?: string;           // Trade ID that triggered cooldown
  };

  // Journal state
  unjournaledTrades: string[];       // Trade IDs not yet journaled

  // Streak state (carried across days)
  currentStreak: {
    type: "winning" | "losing" | "none";
    length: number;                  // Number of consecutive days
    startDate: string;
  };

  // Auto-adjustments currently active
  activeAdjustments: Array<{
    rule: string;                    // e.g., "losing_streak_reduce"
    description: string;
    originalValue: number;
    adjustedValue: number;
    appliedAt: Date;
  }>;

  // Weekly review state
  weeklyReviewCompleted: boolean;    // Reset every Monday
  weeklyReviewDueAt?: Date;

  // Violations log
  violations: Array<{
    ruleId: string;
    ruleName: string;
    severity: "hard" | "soft";
    description: string;
    timestamp: Date;
    overridden: boolean;             // True if user acknowledged a soft warning
  }>;
}
```

**Collection: `discipline_daily_scores`**

One document per day, persisted at end of day for historical tracking.

```typescript
interface DisciplineDailyScore {
  _id: ObjectId;
  userId: string;
  date: string;                      // "2026-04-01"
  score: number;                     // 0–100
  breakdown: {
    circuitBreaker: number;          // Points earned (max weight)
    tradeLimits: number;
    cooldowns: number;
    timeWindows: number;
    positionSizing: number;
    journal: number;
    preTradeGate: number;
  };
  violationCount: number;
  tradesToday: number;
  dailyPnl: number;
  dailyPnlPercent: number;
  streakType: "winning" | "losing" | "none";
  streakLength: number;
}
```

---

## 4. Module 1: Circuit Breaker & Loss Limits

### 4.1 Daily Loss Limit

The daily loss limit is the most critical discipline rule. When the cumulative realized loss for the day reaches the configured threshold (default 3% of opening capital), all trading is immediately and irrevocably disabled for the rest of the day.

**Trigger condition:** `|dailyRealizedPnl| >= (openCapital × thresholdPercent / 100)` where `dailyRealizedPnl < 0`.

**Behavior when triggered:**

The system sets `circuitBreakerTriggered = true` in the discipline state. This flag is latched — it cannot be unset until the next trading day. A full-screen red overlay appears on the Position Tracker page with the following elements:

- A lock icon and the title "DAILY LOSS LIMIT REACHED"
- The message "Trading is disabled for today. Your capital is protected."
- Three statistics: Today's Loss (absolute), Loss % (of capital), Trades Taken (count)
- A timer: "Trading resumes tomorrow at 9:15 AM" (or 9:00 AM for MCX-only days)

The overlay uses a red-tinted semi-transparent backdrop (`rgba(255, 59, 92, 0.12)`) with `backdrop-filter: blur(6px)` to obscure the underlying table while keeping it faintly visible. The border is solid red (`#FF3B5C`).

**Scope:** The daily loss limit is **combined across NSE and MCX**. A loss on NIFTY and a loss on CRUDEOIL both count toward the same 3% threshold. This is a locked design decision.

**P&L tracking:** Only **realized P&L** (closed trades) counts toward the limit. Unrealized P&L on open positions does not trigger the circuit breaker. However, if the circuit breaker triggers while positions are still open, those positions remain open — the user can still close them but cannot open new ones.

### 4.2 Max Consecutive Losses

After N consecutive losing trades (default 3), a forced cooldown activates. This is separate from the revenge trade cooldown — it is cumulative across all trades, not just the most recent one.

**Trigger condition:** `consecutiveLosses >= maxLosses` (where a "loss" is any trade closed with negative realized P&L).

**Reset condition:** The counter resets to 0 after any trade that closes with positive realized P&L.

**Behavior when triggered:**

A cooldown of configurable duration (default 30 minutes) activates. The UI shows a card with the last N losing trades listed (instrument, P&L), the message "N consecutive losses detected," and a lock icon with the cooldown timer. The new trade button is disabled with the message "Extended cooldown: 30 minutes. Step away from the screen."

---

## 5. Module 2: Trade Limits & Cooldowns

### 5.1 Max Trades Per Day

A hard limit on the total number of trades that can be placed in a single day (default 5). This is **combined across NSE and MCX** — a locked design decision.

**Tracking:** The `tradesToday` counter in `discipline_state` increments by 1 each time a trade is successfully placed (order confirmed by broker). Cancelled or rejected orders do not count.

**UI indicator:** A progress bar in the Position Tracker summary area shows "N trades taken / M max" with color coding: green (0–60%), yellow (60–80%), red (80–100%). When the limit is reached, the bar is fully red with the message "Trade limit reached. No more trades today." and the new trade button is disabled.

### 5.2 Max Open Positions

A hard limit on the number of simultaneously open positions (default 3).

**Tracking:** The `openPositions` counter in `discipline_state` increments when a trade is opened and decrements when a trade is closed (fully, not partially).

**UI indicator:** Same progress bar pattern as max trades. When maxed out, the message reads "Close a position before opening a new one."

### 5.3 Revenge Trade Cooldown

A mandatory cooldown period after any stop-loss hit (default 15 minutes, configurable to 10, 15, or 30 minutes).

**Trigger condition:** A trade is closed because the stop-loss was hit (exit reason = "SL").

**Behavior:**

1. If `requireAcknowledgment` is enabled (default ON), the system first shows an acknowledgment prompt: "Type 'I accept the loss' to start the cooldown timer." The user must type the exact phrase. The cooldown timer does not begin until the acknowledgment is received.

2. Once acknowledged (or immediately if acknowledgment is disabled), the cooldown timer starts. The new trade (+) button is replaced with a locked button showing the countdown: "New Trade (locked for 14:22)."

3. A cooldown card appears showing: the trigger event ("SL Hit on NIFTY 50 B CE"), the loss amount and percentage, a circular countdown ring with the remaining time, and a calming message ("Take a breath. Review what happened before your next trade.").

4. The cooldown ends when the timer reaches zero. The new trade button is re-enabled.

**Interaction with consecutive loss cooldown:** If a revenge cooldown is active and the consecutive loss threshold is also hit, the longer cooldown takes precedence. They do not stack additively.

---

## 6. Module 3: Time Windows

### 6.1 No Trading After Market Open

Blocks trading during the first N minutes after the market opens (default 15 minutes). This prevents impulsive trades during the high-volatility gap-open period.

**Exchange-specific timing:**

| Exchange | Market Open | Block Ends (default 15 min) |
|----------|------------|----------------------------|
| NSE | 9:15 AM IST | 9:30 AM IST |
| MCX | 9:00 AM IST | 9:15 AM IST |

The block is applied per exchange. If the user is trading NIFTY (NSE), the block applies from 9:15–9:30 AM. If trading CRUDEOIL (MCX), the block applies from 9:00–9:15 AM. Both blocks can be active simultaneously during the overlap period (9:15–9:30 AM blocks NSE instruments while MCX instruments are already unblocked).

**UI:** An amber banner appears at the top of the Position Tracker: "Market open volatility — Trading blocked for [INSTRUMENT]. Resumes in [MM:SS]." The banner includes a countdown timer.

### 6.2 No Trading Before Market Close

Blocks trading during the last N minutes before market close (default 15 minutes).

| Exchange | Block Starts (default 15 min) | Market Close |
|----------|-------------------------------|-------------|
| NSE | 3:15 PM IST | 3:30 PM IST |
| MCX | 11:15 PM IST | 11:30 PM IST |

Same per-exchange logic as the open block. Same amber banner UI with countdown.

### 6.3 Lunch Break Pause

An optional block during the lunch period (default OFF). When enabled, trading is blocked from 12:30 PM to 1:30 PM IST. This applies **only to NSE instruments** — MCX has no lunch break concept.

**UI:** A yellow-tinted banner: "Lunch break pause active. Trading resumes at 1:30 PM."

### 6.4 Timeline Visualization

The Time Windows section of the Discipline Dashboard includes a horizontal timeline bar showing the full trading day. The bar is divided into segments:

- **Red hatched** segments for blocked periods (market open, market close)
- **Green** segments for active trading windows
- **Yellow hatched** segments for lunch pause (if enabled)
- A **cyan "NOW" marker** showing the current position in the timeline

The timeline is rendered separately for NSE and MCX when both have different configurations.

---

## 7. Module 4: Pre-Trade Gate

The Pre-Trade Gate is an inline checklist that appears in the frontend after the user clicks the confirm button on a new trade. It is the last checkpoint before the order is sent to the Discipline Engine's server-side validation.

### 7.1 Gate Checks

The gate evaluates seven checks in order. Each check has a pass/fail/pending state with visual indicators (green checkmark, red cross, blue question mark).

| # | Check | Type | Blocking | Source |
|---|-------|------|----------|--------|
| 1 | Trade aligned with plan? | Manual | No (soft) | User confirms |
| 2 | Pre-Entry Checklist completed? | Auto | No (soft) | Links to existing InstrumentCard checklist |
| 3 | R:R ratio acceptable? | Auto | **Yes (hard)** | Compares trade R:R against `minRiskReward` setting |
| 4 | Position size within limits? | Auto | **Yes (hard)** | Compares `estimatedValue / capital` against `maxPositionSize` |
| 5 | Total exposure within limits? | Auto | **Yes (hard)** | Compares `(currentExposure + estimatedValue) / capital` against `maxTotalExposure` |
| 6 | Emotional state? | Manual | **Yes (hard)** | User selects: Calm / Anxious / Revenge / FOMO / Greedy / Neutral. Blocks if Revenge or FOMO. |
| 7 | Checklist done? | Manual | No (soft) | User confirms |

### 7.2 Gate Outcomes

**All checks pass:** The "PLACE TRADE" button is green and enabled. Clicking it sends the trade to the server-side Discipline Engine for the remaining checks (circuit breaker, trade limits, cooldowns, time windows, journal).

**Any hard check fails:** The "PLACE TRADE" button is replaced with a locked button: "TRADE BLOCKED — Fix issues above." The failing checks are highlighted in red with specific details (e.g., "R:R = 1:0.8 — BELOW MINIMUM 1:1.5"). The trade cannot proceed.

**Only soft checks fail:** The "PLACE TRADE" button remains enabled but shows an amber warning. The user can proceed but the soft failure is logged as a violation.

### 7.3 Gate Display

The gate appears as a card overlay within the trade input row of the Position Tracker. It shows the trade details at the top ("NIFTY 50 B CE 24500 @ 142.00") and the checklist below. Each item has a colored indicator (green/red/blue circle), a label, and a detail line with the specific values.

The entire Pre-Trade Gate can be toggled off in Settings for experienced mode. When off, trades go directly to server-side validation without the frontend checklist.

---

## 8. Module 5: Position Size & Exposure

### 8.1 Max Position Size

Rejects any single trade where `entryPrice × quantity > maxPositionSize% × currentCapital`.

**Example:** Capital = 1,34,000. Max position size = 10%. A trade worth 14,250 (10.6% of capital) is blocked. The UI shows a red warning: "Position size 14,250 = 10.6% of capital — EXCEEDS 10% LIMIT."

### 8.2 Max Total Exposure

Blocks new trades when the sum of all open position values exceeds `maxTotalExposure% × currentCapital`.

**Example:** Capital = 1,34,000. Max exposure = 30%. Current open positions total 38,200 (28.5%). A new trade of 5,000 would bring total to 43,200 (32.2%), which exceeds 30%. The trade is blocked.

**UI indicator:** An exposure bar in the Position Tracker summary shows current exposure as a percentage. Color coding: green (<20%), yellow (20–28%), red (>28%). When near or at the limit, the message reads "Near limit — reduce exposure before new trades."

### 8.3 Streak-Adjusted Limits

When a losing streak auto-reduction is active (Module 7), the effective max position size and max exposure are reduced by the configured percentage (default 50%). For example, if the base max position size is 10% and the reduction is 50%, the effective limit becomes 5%. The UI shows both the original and adjusted values.

---

## 9. Module 6: Journal & Weekly Review

### 9.1 Trade Journal Enforcement

After every closed trade, the system requires a journal entry before the user can open new trades (if the unjournaled count exceeds the threshold).

**Journal entry fields:**
- Why did you enter this trade? (free text, required)
- Why did you exit? (free text, required)
- What did you learn? (free text, required)
- Emotional state during trade (pill selector: Calm / Anxious / Revenge / FOMO / Greedy / Neutral, required)

**Blocking behavior:** When `unjournaledTrades.length >= maxUnjournaled` (default 3), the new trade button is disabled with the message "Complete N journal entries first." A list of unjournaled trades is shown with their details (instrument, P&L, time).

**Journal popup:** After a trade is closed, a journal entry form slides in. The user can dismiss it temporarily, but the unjournaled counter increments. The form shows the trade details at the top for reference.

### 9.2 Weekly Performance Review

Every Monday at 9:00 AM IST, a mandatory review screen appears before trading can begin for the week.

**Review screen contents:**
- Week number and date range
- Four key stats: Win Rate (%), Week P&L (absolute), Average R:R, Discipline Score
- A verdict badge: "GOOD WEEK" (green, if profitable + discipline > 70%), "NEEDS IMPROVEMENT" (yellow), or "RED WEEK" (red, if losing)
- An acknowledgment button: "I've reviewed my week — Start Trading"

**Warning variant:** If the discipline score is below the warning threshold (default 70%) or if there are 3 consecutive red weeks, the review screen shows additional warnings:

- An amber header: "WARNING — 3rd consecutive losing week"
- Auto-adjustments for the coming week: reduced max position size, reduced max trades/day, increased revenge cooldown
- The acknowledgment button changes to: "I acknowledge and accept reduced limits"

**Blocking behavior:** The `weeklyReviewCompleted` flag in `discipline_state` is set to `false` every Monday at midnight. Until the user completes the review, no trades can be placed. The review screen is the first thing shown when navigating to the Position Tracker on Monday.

### 9.3 Discipline Score Warning

If the current day's discipline score drops below the configured threshold (default 70%), an amber warning banner appears: "Discipline score is [N] — below the 70% threshold. Review your violations." The user must click "I acknowledge" to dismiss the banner, but it reappears if the score drops further.

### 9.4 Red Week Reduction

If 3 consecutive weeks end with negative P&L ("red weeks"), the system automatically applies reduced limits for the following week:

| Parameter | Original | Reduced |
|-----------|----------|---------|
| Max position size | 10% | 5% |
| Max trades per day | 5 | 3 |
| Revenge cooldown | 15 min | 30 min |

These adjustments are logged in `activeAdjustments` and shown in the weekly review screen. They persist for the entire week and are re-evaluated at the next Monday review.

---

## 10. Module 7: Streaks & Dashboard

### 10.1 Winning Streak Reminder

After N consecutive profitable days (default 5), a green notification card appears: "5-Day Winning Streak! But remember — overconfidence is the enemy. Don't increase position sizes. Stick to your plan." The card shows the streak days as colored boxes (green for wins) and a tip about consistency.

This is a **soft warning** — it does not block trading. It is logged as a notification and appears once per streak milestone (at 5, 10, 15 days, etc.).

### 10.2 Losing Streak Auto-Reduce

After N consecutive losing days (default 3), the system automatically reduces trading limits:

- Max position size reduced by the configured percentage (default 50%)
- Max trades per day reduced proportionally (e.g., 5 → 3)
- A suggestion to "consider taking a day off"

The reduction is applied as an `activeAdjustment` in the discipline state. It persists until the streak is broken by a profitable day.

**UI:** A red notification card appears: "3-Day Losing Streak. The market isn't going anywhere. Protect your capital. Auto-reducing position size by 50% until streak breaks." The card shows the streak days as colored boxes (red for losses, green for previous wins).

### 10.3 Discipline Dashboard Page

The Discipline Dashboard is a dedicated page (route: `/discipline`) showing:

**Row 1 — Three cards:**
1. **Today's Discipline Score** — A circular gauge (0–100) with color coding: green (>80), yellow (60–80), red (<60). The number is large and centered.
2. **Rules Broken Today** — A list of violations with colored dots (red for hard violations, yellow for soft/overridden), description, and timestamp.
3. **Monthly Discipline Trend** — A bar chart showing weekly average discipline scores for the past 8 weeks. Bars are colored green (>80), yellow (60–80), red (<60).

**Row 2 — Full-width card:**
4. **Discipline Score vs P&L — Last 7 Days** — A correlation table showing each day's discipline score and P&L side by side, with dual horizontal bars for visual comparison. A summary insight at the bottom: "Pattern: High discipline (>80) correlates with profitable days. Low discipline (<60) correlates with losses."

---

## 11. Discipline Score Algorithm

The discipline score is a weighted average of adherence to all enabled rules. The score ranges from 0 to 100.

### Weight Distribution

| Category | Weight | Max Points | Scoring Logic |
|----------|--------|------------|---------------|
| Circuit Breaker | 20% | 20 | Full points if daily loss < 50% of limit. Linear reduction to 0 at limit. 0 if triggered. |
| Trade Limits | 15% | 15 | Full points if trades < 60% of limit. Linear reduction. 0 if limit hit. |
| Cooldowns | 15% | 15 | Full points if no cooldowns triggered. -5 per cooldown event. |
| Time Windows | 10% | 10 | Full points if no time window violations. 0 if any violation. |
| Position Sizing | 15% | 15 | Full points if all trades < 80% of max. Linear reduction. 0 if any exceeded. |
| Journal | 10% | 10 | Full points if all trades journaled same day. -3 per unjournaled trade. |
| Pre-Trade Gate | 15% | 15 | Full points if all gate checks passed. -3 per soft override. -5 per hard block overridden (if possible). |

**Disabled rules:** If a rule is disabled in settings, its weight is redistributed proportionally among the remaining enabled rules. This ensures the score always uses a 100-point scale regardless of which rules are active.

### Calculation Timing

The score is recalculated after every trade event (open, close, journal entry) and at the end of each trading day. The end-of-day score is persisted to `discipline_daily_scores` for historical tracking.

---

## 12. Settings Schema & Defaults

All discipline settings are exposed in the Settings page under the "Discipline" section. The UI uses a two-column grid of setting groups, each with a header, toggle rows, and sub-setting rows for configurable parameters.

### Complete Default Values

| Setting | Default | Type | Range |
|---------|---------|------|-------|
| Daily loss limit enabled | true | toggle | — |
| Daily loss limit threshold | 3% | number | 1–10% |
| Max consecutive losses enabled | true | toggle | — |
| Max consecutive losses count | 3 | number | 2–10 |
| Max consecutive losses cooldown | 30 min | number | 10–120 min |
| Max trades per day enabled | true | toggle | — |
| Max trades per day limit | 5 | number | 1–20 |
| Max open positions enabled | true | toggle | — |
| Max open positions limit | 3 | number | 1–10 |
| Revenge cooldown enabled | true | toggle | — |
| Revenge cooldown duration | 15 min | select | 10 / 15 / 30 min |
| Require loss acknowledgment | true | toggle | — |
| No trading after open enabled | true | toggle | — |
| No trading after open (NSE) | 15 min | number | 5–60 min |
| No trading after open (MCX) | 15 min | number | 5–60 min |
| No trading before close enabled | true | toggle | — |
| No trading before close (NSE) | 15 min | number | 5–60 min |
| No trading before close (MCX) | 15 min | number | 5–60 min |
| Lunch break pause enabled | false | toggle | — |
| Lunch break start | 12:30 | time | — |
| Lunch break end | 13:30 | time | — |
| Pre-trade gate enabled | true | toggle | — |
| Min R:R check enabled | true | toggle | — |
| Min R:R ratio | 1.5 | number | 1.0–5.0 |
| Emotional state check enabled | true | toggle | — |
| Max position size enabled | true | toggle | — |
| Max position size % | 10% | number | 1–50% |
| Max total exposure enabled | true | toggle | — |
| Max total exposure % | 30% | number | 10–100% |
| Journal enforcement enabled | true | toggle | — |
| Max unjournaled trades | 3 | number | 1–10 |
| Weekly review enabled | true | toggle | — |
| Discipline score warning threshold | 70 | number | 50–90 |
| Red week reduction trigger | 3 weeks | number | 2–5 weeks |
| Winning streak reminder enabled | true | toggle | — |
| Winning streak trigger | 5 days | number | 3–10 days |
| Losing streak auto-reduce enabled | true | toggle | — |
| Losing streak trigger | 3 days | number | 2–7 days |
| Losing streak reduction | 50% | number | 25–75% |

---

## 13. API Surface

### tRPC Procedures (Frontend)

All procedures are under the `discipline` router and require authentication (`protectedProcedure`).

| Procedure | Type | Description |
|-----------|------|-------------|
| `discipline.getSettings` | query | Get current discipline settings for the authenticated user |
| `discipline.updateSettings` | mutation | Update one or more discipline settings (with history logging) |
| `discipline.getState` | query | Get current intraday discipline state (counters, cooldowns, violations) |
| `discipline.validateTrade` | mutation | Validate a trade request against all discipline rules; returns `TradeValidationResult` |
| `discipline.acknowledgeLoss` | mutation | Submit "I accept the loss" acknowledgment to start cooldown timer |
| `discipline.submitJournalEntry` | mutation | Submit a journal entry for a closed trade |
| `discipline.getJournalEntries` | query | Get journal entries with optional filters (date range, instrument) |
| `discipline.completeWeeklyReview` | mutation | Mark the weekly review as completed |
| `discipline.getWeeklyReviewData` | query | Get last week's stats for the review screen |
| `discipline.getDailyScore` | query | Get today's discipline score and breakdown |
| `discipline.getScoreHistory` | query | Get discipline score history (daily scores for charting) |
| `discipline.getViolations` | query | Get today's violations list |
| `discipline.getStreakStatus` | query | Get current streak type, length, and any active adjustments |
| `discipline.getCorrelationData` | query | Get discipline score vs P&L data for the last 7 days |
| `discipline.resetDailyState` | mutation | Admin-only: manually reset daily state (for testing) |

### REST Endpoints (Python Modules)

Python modules do not interact with the Discipline Engine directly. All discipline enforcement happens at the dashboard/frontend layer. The Python execution module places trades through the Broker Service REST endpoints, which do not enforce discipline rules (discipline is a user-facing feature, not an AI-facing one).

---

## 14. UI Components

### Component Inventory

| Component | Location | Description |
|-----------|----------|-------------|
| `CircuitBreakerOverlay` | Position Tracker | Full-screen red overlay when daily loss limit triggered |
| `CooldownCard` | Position Tracker | Countdown timer card after SL hit or consecutive losses |
| `LossAcknowledgment` | Position Tracker | "I accept the loss" input prompt |
| `PreTradeGate` | Position Tracker (inline) | 7-check confirmation checklist before trade placement |
| `TradeLimitBars` | Position Tracker summary | Progress bars for trades/day, open positions, exposure |
| `TimeWindowBanner` | Position Tracker header | Amber countdown banner during blocked time periods |
| `TimelineVisualization` | Discipline Dashboard | Horizontal timeline showing trading windows |
| `DisciplineScoreGauge` | Discipline Dashboard | Circular 0–100 gauge with color coding |
| `ViolationsList` | Discipline Dashboard | Today's rule violations with timestamps |
| `MonthlyTrendChart` | Discipline Dashboard | Weekly bar chart of discipline scores |
| `CorrelationTable` | Discipline Dashboard | Score vs P&L side-by-side comparison |
| `WeeklyReviewScreen` | Position Tracker (blocking) | Monday morning review with stats and acknowledgment |
| `JournalEntryForm` | Position Tracker (slide-in) | Post-trade journal entry with emotion selector |
| `JournalBlockNotice` | Position Tracker | Blocked state showing unjournaled trades |
| `StreakCard` | Discipline Dashboard | Winning/losing streak notification with day boxes |
| `DisciplineSettingsPanel` | Settings page | Two-column grid of all configurable parameters |

### Color Palette (from mockup)

| Element | Color | Hex |
|---------|-------|-----|
| Hard block / loss / danger | Red | `#FF3B5C` |
| Warning / cooldown / caution | Amber | `#FFB800` |
| Pass / profit / success | Green | `#00FF87` |
| Info / neutral highlight | Cyan | `#00D4FF` |
| Disabled / dim text | Gray | `#5a6a7a` |
| Primary text | Light gray | `#C5CDD8` |
| Card background | Dark | `#0D1117` |
| Page background | Darkest | `#0A0E14` |
| Border | Subtle | `#1a2332` |

---

## 15. Testing Strategy

### Test Categories

| Category | Test Count (estimated) | Description |
|----------|----------------------|-------------|
| Circuit Breaker | 8 | Daily loss calculation, trigger threshold, latch behavior, reset on new day |
| Trade Limits | 6 | Max trades counter, max positions counter, limit reached blocking |
| Cooldowns | 10 | Revenge cooldown start/end, acknowledgment flow, consecutive loss cooldown, cooldown overlap |
| Time Windows | 8 | NSE/MCX separate windows, lunch pause, boundary conditions, disabled rules |
| Pre-Trade Gate | 8 | Each check pass/fail, hard vs soft blocking, gate disabled mode |
| Position Sizing | 6 | Max position %, max exposure %, streak-adjusted limits |
| Journal | 6 | Unjournaled counter, block threshold, journal submission, counter reset |
| Streaks | 8 | Winning streak detection, losing streak detection, auto-adjustments, streak break |
| Score | 6 | Weight calculation, disabled rule redistribution, boundary scores |
| Settings | 6 | CRUD operations, history logging, default seeding |
| Integration | 8 | Full validation pipeline, multiple rules interacting, edge cases |
| **Total** | **~80** | |

### Test File

All tests in `server/discipline.test.ts` using Vitest. Tests use a mock discipline state (no MongoDB dependency) for unit tests, and a test MongoDB instance for integration tests.

---

## 16. Implementation Order

The Discipline Engine spans Features 14–20. The recommended implementation order follows the dependency chain and builds from the most critical (capital protection) to the least critical (analytics).

| Step | Feature | Description | Dependencies |
|------|---------|-------------|-------------|
| 1 | 14 | Circuit Breaker & Loss Limits | Feature 4 (Settings), Feature 5 (Position Tracker) |
| 2 | 15 | Trade Limits & Cooldowns | Step 1 |
| 3 | 16 | Time Windows | Feature 11 (Market Hours) |
| 4 | 18 | Position Size & Exposure | Step 2 |
| 5 | 17 | Pre-Trade Gate | Steps 1–4 (needs all checks available) |
| 6 | 19 | Journal & Weekly Review | Step 5, Feature 9 (Trade Journal already built) |
| 7 | 20 | Streaks & Dashboard | Steps 1–6 (needs score data) |

Each step should include: MongoDB schema, server module, tRPC procedures, UI components, and vitest tests before moving to the next step.

---

## Appendix A: Exchange-Instrument Mapping

| Instrument | Exchange | Market Open | Market Close | Expiry |
|------------|----------|------------|-------------|--------|
| NIFTY 50 | NSE | 9:15 AM IST | 3:30 PM IST | Weekly (Thursday) |
| BANK NIFTY | NSE | 9:15 AM IST | 3:30 PM IST | Weekly (Wednesday) |
| CRUDE OIL | MCX | 9:00 AM IST | 11:30 PM IST | Monthly (19th) |
| NATURAL GAS | MCX | 9:00 AM IST | 11:30 PM IST | Monthly (25th) |

The Discipline Engine uses this mapping to determine which exchange's time windows apply to a given instrument. The mapping is defined in `shared/const.ts` and shared across frontend and backend.

---

## Appendix B: Mockup Reference

The complete UI mockup for all Discipline Engine components is available at:

```
mockups/discipline-mockup/index.html
```

The mockup has 8 navigable tabs:
1. **Loss Limit & Cooldown** — Circuit breaker overlay, revenge cooldown card, consecutive loss card
2. **Pre-Trade Gate** — Pass and fail variants of the 7-check confirmation
3. **Limits & Time Windows** — Progress bars for trades/positions/exposure, timeline visualization
4. **Discipline Dashboard** — Score gauge, violations list, monthly trend, P&L correlation
5. **Weekly Review** — Good week and warning week variants with acknowledgment
6. **Journal Enforcement** — Journal entry form and blocked state with unjournaled trade list
7. **Streak Protection** — Winning streak reminder and losing streak auto-reduce cards
8. **Settings** — Complete settings grid with all toggles and configurable parameters
