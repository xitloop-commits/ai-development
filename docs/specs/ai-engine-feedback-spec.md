# ⚠️ DEPRECATED — AI Engine — Module 7: Performance Feedback Loop (v2.4)

> **DEPRECATED (2026-04-13):** The old Python feedback loop (`performance_feedback.py`) is in `python_modules/deprecated/`. Trade outcome feedback will be handled by Portfolio Agent → Discipline Engine in the new architecture. A future Feedback Agent (TypeScript) is planned per `ARCHITECTURE_REFACTOR_PLAN.md`.

**Document:** ai-engine-feedback-spec.md
**Project:** Automatic Trading System (ATS)
**Status:** Authoritative Reference

---

## Revision History

| Version | Date       | Author    | Changes                                                  |
| ------- | ---------- | --------- | -------------------------------------------------------- |
| v2.0    | 2026-04-02 | Manus AI  | Initial specification (New module in v2.4 enhancements)  |

---

## 1. Overview

**File:** `performance_feedback.py` (New in v2.4)
**Purpose:** Track trade outcomes and make small, bounded adjustments to specific system parameters at the start of each trading day.

The Performance Feedback Loop is designed to be transparent, auditable, and safe — no black-box machine learning. It uses historical trade data to optimize the system's performance over time.

---

## 2. Trade Journal

Every closed trade is logged to `output/trade_journal.json` (inside the `python_modules/output/` directory) with the following fields:

| Field | Type | Description |
| :--- | :--- | :--- |
| `date` | string | Trading date (YYYY-MM-DD) |
| `instrument` | string | e.g., NIFTY_50 |
| `direction` | string | GO_CALL or GO_PUT |
| `entry_price` | float | Entry price of the option |
| `exit_price` | float | Exit price of the option |
| `pnl_pct` | float | Profit/loss percentage |
| `result` | string | WIN or LOSS |
| `hold_time_seconds` | int | Duration from entry to exit |
| `exit_reason` | string | SL_HIT, TP_HIT, TRADE_AGE_TIMEOUT, MOMENTUM_EXIT, PARTIAL_EXIT, MANUAL |
| `confidence_at_entry` | float | AI Engine confidence when the trade was taken |
| `momentum_at_entry` | float | Momentum Score when the trade was executed |
| `peak_profit_pct` | float | Maximum unrealized profit during the trade |

---

## 3. Daily Analysis (Pre-Market)

At the start of each trading day, before market open, the Feedback Loop reads the last N days of journal data (configurable via `FEEDBACK_LOOKBACK_DAYS`) and calculates:

| Metric | Calculation |
| :--- | :--- |
| Win rate | Wins / Total trades |
| Average profit on wins | Mean pnl_pct where result = WIN |
| Average loss on losses | Mean pnl_pct where result = LOSS |
| Average hold time | Mean hold_time_seconds |
| Peak profit vs actual exit | Mean of (peak_profit_pct - pnl_pct) for wins |

---

## 4. Tunable Parameters (With Strict Bounds)

| Parameter | Default | Min | Max | Adjustment per Day | Tuning Logic |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `MIN_CONFIDENCE` | 0.65 | 0.60 | 0.75 | +/- 0.02 | Win rate > 60% → lower by 0.02 (take more trades). Win rate < 40% → raise by 0.02 (be more selective). |
| `PROFIT_PARTIAL_EXIT_PCT` | 6% | 4% | 8% | +/- 1% | If average peak_profit is close to 6% (within 1%) → keep. If most winners peak at 4-5% then reverse → lower to match. If winners consistently run past 10% → raise. |
| `TRADE_AGE_FORCE_EXIT` | 10 min | 7 min | 15 min | +/- 1 min | If trades hitting the time limit often recover and win within 2 more minutes → extend by 1 min. If they almost never recover → shorten by 1 min. |

---

## 5. Non-Tunable Parameters (Hardcoded for Safety)

| Parameter | Value | Rationale |
| :--- | :--- | :--- |
| Stop Loss (-5%) | Fixed | Risk management must be absolute |
| Daily Session limits (+5% / -2%) | Fixed | Capital protection is non-negotiable |
| Max trades per day (3) | Fixed | Prevents overtrading |
| Equity Curve multiplier bounds | Fixed | Prevents dangerous risk scaling |

---

## 6. Adjustment Logging

Every adjustment is logged to `output/feedback_adjustments.json` for full transparency:

```json
{
  "date": "2026-04-03",
  "lookback_days": 5,
  "metrics": {
    "win_rate": 0.55,
    "avg_profit_pct": 7.2,
    "avg_loss_pct": -3.8,
    "total_trades": 12
  },
  "adjustments": [
    {
      "parameter": "MIN_CONFIDENCE",
      "previous": 0.65,
      "new": 0.63,
      "reason": "Win rate 55% > 50% threshold, reducing confidence to take more trades"
    }
  ]
}
```

---

## 7. Configurable Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `FEEDBACK_ENABLED` | `false` | Disabled by default. Must be explicitly enabled after sufficient trade history exists. |
| `FEEDBACK_LOOKBACK_DAYS` | `5` | Number of past trading days to analyze |

---

## 8. Testing

The Feedback Loop's core metrics (win rate, average P&L, max drawdown, risk-reward ratio, empty journal handling) are covered by the `TestPerformanceFeedback` class in `python_modules/test_python_modules.py` (5 tests).

---

*End of specification.*
