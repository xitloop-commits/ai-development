# AI Engine v2.4 — Gap Resolution Specification

**Version:** 1.0
**Project:** Automatic Trading System (ATS)
**Author:** Manus AI
**Status:** Approved

---

## 1. Overview

This document provides the detailed specifications for four modules in the AI Engine Enhancement v2.4 that were identified as having insufficient detail for implementation. Each module has been fully defined with algorithms, scoring logic, configurable parameters, and safety bounds.

| Module | Gap Identified | Resolution |
| :--- | :--- | :--- |
| Momentum Engine | Velocity calculation undefined | Dual-window scoring with fast (30s) and slow (2-3 min) lookbacks |
| Equity Curve Protection | Risk scaling rules undefined | Multiplier-based system with reduction on losses and slow recovery on wins |
| No Trade Detection | "Sideways market" criteria undefined | 4-signal scoring for sideways + 4-signal trap detection |
| Performance Feedback Loop | Tuning parameters undefined | Bounded daily adjustments to 3 safe parameters, disabled by default |

---

## 2. Momentum Engine — Detailed Specification

### 2.1 Purpose

The Momentum Engine continuously scores the health of an active trade on a 0–100 scale using real-time WebSocket tick data. The score drives hold, add, partial exit, and full exit decisions.

### 2.2 Dual-Window Architecture

The engine uses two concurrent time windows to balance reaction speed with signal reliability. The **fast window** catches immediate momentum shifts for urgent decisions, while the **slow window** confirms sustained trends for patient decisions.

**Final Momentum Score = (Fast Score x 40%) + (Slow Score x 60%)**

This weighting gives more authority to the confirmed trend (slow window) while still allowing the fast window to trigger urgent exits when momentum collapses suddenly.

### 2.3 Factor 1: Price Velocity (30% weight)

Price velocity measures how fast the underlying or option price is moving in the trade's direction.

**Calculation:**

```
velocity = (current_LTP - LTP_at_window_start) / LTP_at_window_start x 100
average_velocity = average of all 30s velocity readings from market open to now
normalized = velocity / (average_velocity x 2)  # 2x average = score 100
score = clamp(normalized x 100, 0, 100)
```

If the velocity is in the **opposite direction** of the trade (e.g., price falling on a CALL trade), the score is 0.

| Window | Lookback | Use |
| :--- | :--- | :--- |
| Fast | 30 seconds | Detects the initial burst or sudden reversal |
| Slow | 2 minutes | Confirms the move is sustained |

### 2.4 Factor 2: Volume (25% weight)

Volume measures market participation and conviction behind the current move.

**Calculation:**

```
current_volume = total volume in the lookback window
average_volume = average volume per equivalent window from market open to now
ratio = current_volume / average_volume
score = clamp(ratio x 50, 0, 100)  # 2x average = score 100
```

| Window | Lookback | Use |
| :--- | :--- | :--- |
| Fast | 1 minute | Catches volume spikes |
| Slow | 3 minutes | Confirms volume is not fading |

### 2.5 Factor 3: OI Change (25% weight)

OI change measures whether new positions are being created (buildup) or closed (unwinding) in the held strike.

**Calculation:**

```
oi_change = current_OI - OI_at_window_start
```

**Scoring for CALL trades:**

| Condition | Interpretation | Score |
| :--- | :--- | :--- |
| CE OI increasing + PE OI decreasing | Long buildup + short covering = strongly bullish | 100 |
| CE OI increasing | Long buildup = bullish | 75 |
| PE OI decreasing | Short covering = moderately bullish | 60 |
| No significant change | Neutral | 50 |
| CE OI decreasing | Long unwinding = bearish | 20 |
| CE OI decreasing + PE OI increasing | Long unwinding + short buildup = strongly bearish | 0 |

For PUT trades, the logic is mirrored.

| Window | Lookback | Use |
| :--- | :--- | :--- |
| Fast | 1 minute | Detects fresh buildup or unwinding |
| Slow | 3 minutes | Confirms OI trend is sustained |

### 2.6 Factor 4: Candle Strength (20% weight)

Candle strength measures the quality of the current price action by building real-time candles from WebSocket ticks.

**Calculation:**

```
body = abs(close - open)
total_range = high - low
body_ratio = body / total_range if total_range > 0 else 0
direction_match = 1 if candle direction matches trade direction else 0
score = body_ratio x direction_match x 100
```

A full-body candle in the trade's direction scores 100. A doji (no body) scores 0. A full-body candle in the opposite direction scores 0.

| Window | Lookback | Use |
| :--- | :--- | :--- |
| Fast | 1-minute candle | Current candle quality |
| Slow | 3-minute candle | Pattern over a longer period |

### 2.7 Action Thresholds

| Momentum Score | Action | Description |
| :--- | :--- | :--- |
| > 70 | HOLD / ADD | Momentum is strong — hold the position or add via Pyramiding Engine |
| 50–70 | HOLD (tight SL) | Momentum is moderate — hold but tighten the stop loss |
| 30–50 | PARTIAL EXIT | Momentum is weakening — reduce exposure |
| < 30 | FULL EXIT | Momentum has collapsed — exit immediately |

---

## 3. Equity Curve Protection — Detailed Specification

### 3.1 Purpose

The Equity Curve Protection module scales position sizes based on recent trade performance to protect capital during losing streaks and gradually rebuild exposure after recovery.

### 3.2 Risk Multiplier

The system maintains a **Risk Multiplier** that scales the position size calculated by the Profit Orchestrator. The Executor applies this multiplier before placing any order.

```
actual_quantity = floor(orchestrator_quantity x risk_multiplier)
```

If the result is less than 1 lot, the system rounds up to 1 lot (minimum tradeable unit).

### 3.3 Reduction Rules (After Losses)

| Consecutive Losses | Risk Multiplier | Effect |
| :--- | :--- | :--- |
| 0 (normal) | 1.00x | Full size |
| 1 loss | 0.75x | 75% of normal |
| 2 consecutive losses | 0.50x | 50% of normal |
| 3+ consecutive losses | 0.25x | 25% of normal (minimum) |

Each consecutive loss reduces the multiplier by 0.25x, down to a floor of 0.25x.

### 3.4 Recovery Rules (After Wins)

| Consecutive Wins (from drawdown) | Multiplier Change | New Multiplier |
| :--- | :--- | :--- |
| 1 win | +0.25x | Previous + 0.25 |
| 2 consecutive wins | +0.25x | Previous + 0.25 |
| 3 consecutive wins | Back to 1.0x | 1.00x (fully recovered) |

Recovery is intentionally slower than reduction. It takes 3 consecutive wins to fully recover from a 3-loss streak. This prevents revenge trading behavior.

### 3.5 Bounds

| Parameter | Value | Rationale |
| :--- | :--- | :--- |
| Maximum multiplier | 1.0x | Never exceed the Profit Orchestrator's calculated size |
| Minimum multiplier | 0.25x (configurable) | Always trade something; complete shutdown is handled by the Daily Session Manager |

### 3.6 Configurable Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `EQUITY_CURVE_RESET_DAILY` | `true` | Reset multiplier to 1.0x at the start of each trading day |
| `EQUITY_CURVE_MIN_MULTIPLIER` | `0.25` | Minimum risk multiplier floor |

### 3.7 Hardcoded Parameters (Not Configurable)

| Parameter | Value | Rationale |
| :--- | :--- | :--- |
| Reduction per loss | -0.25x | Changing this could lead to dangerous risk behavior |
| Recovery per win | +0.25x | Must match reduction speed or be slower |
| Max multiplier | 1.0x | Must never exceed Profit Orchestrator's calculation |

---

## 4. No Trade Detection — Detailed Specification

### 4.1 Purpose

The No Trade Detection module prevents the system from entering trades during sideways or trap market conditions where the probability of a profitable outcome is low.

### 4.2 Sideways Market Detection

The system evaluates four signals before every potential trade entry. If the configured threshold of signals is met, the market is classified as sideways and the trade is skipped.

| Signal | Condition | Interpretation |
| :--- | :--- | :--- |
| **Narrow Range** | (Day High - Day Low) < 0.5% of LTP | Price is stuck in a tight range |
| **Balanced OI** | Top CE OI and top PE OI (at equidistant strikes from ATM) are within 15% of each other | Neither bulls nor bears are dominant |
| **Low Volume** | Current cumulative volume < 0.7x of the average volume at this time of day (based on historical data or intraday average) | Market participants are inactive |
| **Neutral PCR** | PCR ratio between 0.90 and 1.10 | No directional bias in the options market |

**Decision rule:** If the number of true signals >= `NO_TRADE_SIDEWAYS_THRESHOLD` (default: 3 out of 4), the market is classified as sideways. The system logs the reason and skips the trade.

### 4.3 Trap Market Detection

Trap detection runs on every AI Engine signal that passes the Trade Quality Filter. Unlike sideways detection (which requires multiple signals), a **single trap signal is sufficient** to reject a trade because traps cause immediate, sharp losses.

| Signal | Condition | Interpretation |
| :--- | :--- | :--- |
| **False Breakout** | Price broke above resistance within the last 5 minutes but is now trading back below it | Bull trap — smart money sold into the breakout |
| **False Breakdown** | Price broke below support within the last 5 minutes but is now trading back above it | Bear trap — smart money bought the dip |
| **OI Contradiction** | Price moving up but CE OI increasing heavily (call writers adding, not buyers); or price moving down but PE OI increasing heavily | Smart money is positioning against the visible move |
| **Signal-Momentum Divergence** | AI Engine says GO_CALL but Momentum Score < 30; or GO_PUT but Momentum Score < 30 | The analytical signal does not match real-time market behavior |

**Decision rule:** If **any 1** trap condition is true, the trade is rejected. The system logs which trap was detected.

### 4.4 Configurable Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `NO_TRADE_SIDEWAYS_THRESHOLD` | `3` | Number of sideways signals required to skip trading (out of 4) |

---

## 5. Performance Feedback Loop — Detailed Specification

### 5.1 Purpose

The Performance Feedback Loop tracks trade outcomes and makes small, bounded adjustments to specific system parameters at the start of each trading day. It is designed to be transparent, auditable, and safe — no black-box machine learning.

### 5.2 Trade Journal

Every closed trade is logged to `trade_journal.json` with the following fields:

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

### 5.3 Daily Analysis (Pre-Market)

At the start of each trading day, before market open, the Feedback Loop reads the last N days of journal data (configurable via `FEEDBACK_LOOKBACK_DAYS`) and calculates:

| Metric | Calculation |
| :--- | :--- |
| Win rate | Wins / Total trades |
| Average profit on wins | Mean pnl_pct where result = WIN |
| Average loss on losses | Mean pnl_pct where result = LOSS |
| Average hold time | Mean hold_time_seconds |
| Most common exit reason | Mode of exit_reason |
| Peak profit vs actual exit | Mean of (peak_profit_pct - pnl_pct) for wins |

### 5.4 Tunable Parameters (With Strict Bounds)

| Parameter | Default | Min | Max | Adjustment per Day | Tuning Logic |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `MIN_CONFIDENCE` | 0.65 | 0.60 | 0.75 | +/- 0.02 | Win rate > 60% → lower by 0.02 (take more trades). Win rate < 40% → raise by 0.02 (be more selective). |
| `PROFIT_PARTIAL_EXIT_PCT` | 6% | 4% | 8% | +/- 1% | If average peak_profit is close to 6% (within 1%) → keep. If most winners peak at 4-5% then reverse → lower to match. If winners consistently run past 10% → raise. |
| `TRADE_AGE_FORCE_EXIT` | 10 min | 7 min | 15 min | +/- 1 min | If trades hitting the time limit often recover and win within 2 more minutes → extend by 1 min. If they almost never recover → shorten by 1 min. |

### 5.5 Non-Tunable Parameters (Hardcoded for Safety)

| Parameter | Value | Rationale |
| :--- | :--- | :--- |
| Stop Loss (-5%) | Fixed | Risk management must be absolute |
| Daily Session limits (+5% / -2%) | Fixed | Capital protection is non-negotiable |
| Max trades per day (3) | Fixed | Prevents overtrading |
| Equity Curve multiplier bounds | Fixed | Prevents dangerous risk scaling |

### 5.6 Adjustment Logging

Every adjustment is logged to `feedback_adjustments.json` for full transparency:

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

### 5.7 Configurable Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `FEEDBACK_ENABLED` | `false` | Disabled by default. Must be explicitly enabled after sufficient trade history exists. |
| `FEEDBACK_LOOKBACK_DAYS` | `5` | Number of past trading days to analyze |

---

## 6. Complete Settings Summary

All new configurable parameters introduced by this specification, to be centralized in the system settings module:

| Setting | Module | Default | Type |
| :--- | :--- | :--- | :--- |
| `EQUITY_CURVE_RESET_DAILY` | Equity Curve Protection | `true` | boolean |
| `EQUITY_CURVE_MIN_MULTIPLIER` | Equity Curve Protection | `0.25` | float |
| `NO_TRADE_SIDEWAYS_THRESHOLD` | No Trade Detection | `3` | integer (1-4) |
| `FEEDBACK_ENABLED` | Performance Feedback Loop | `false` | boolean |
| `FEEDBACK_LOOKBACK_DAYS` | Performance Feedback Loop | `5` | integer |
