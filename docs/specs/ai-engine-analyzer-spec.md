# AI Engine — Module 2: Option Chain Analyzer

**Document:** ai-engine-analyzer-spec.md
**Project:** Automatic Trading System (ATS)
**Status:** Authoritative Reference

---

## Revision History

| Version | Date       | Author    | Changes                                                  |
| ------- | ---------- | --------- | -------------------------------------------------------- |
| v1.0    | 2026-04-02 | Manus AI  | Initial specification based on latest Python module source code |
| v2.0    | 2026-04-02 | Manus AI  | Split from monolithic spec into standalone module spec   |

---

## 1. Overview

**File:** `option_chain_analyzer.py` (743 lines)
**Purpose:** Analyze raw option chain data to produce structured signals, S/R levels, market bias, and intraday OI tracking.

The Option Chain Analyzer is the second module in the AI Engine pipeline. It reads the raw option chain data produced by the Fetcher and performs 9 distinct analysis functions to extract actionable insights.

---

## 2. State Management

The Analyzer maintains two categories of state:

**In-Memory State** (`previous_option_chain_data`): A dictionary keyed by instrument name, storing the previous cycle's option chain data. This enables cycle-over-cycle comparison for OI change, volume change, and price change calculations. On the first cycle for any instrument, the current data is stored as "previous" and no signals are generated.

**Persistent State** (`opening_oi_snapshots`): The Opening OI Snapshot system captures the first option chain data of each trading day and persists it to disk in the `opening_snapshots/` directory. Files are named `opening_{instrument}_{date}.json`. This survives process restarts and enables intraday OI change tracking relative to market open.

---

## 3. Analysis Functions

The Analyzer runs 9 analysis functions sequentially for each active instrument. Each function receives the current and previous option chain data and returns structured results.

### 3.1 Active Strikes (`identify_active_strikes`)

Identifies the most significant strikes by finding the intersection of three top-N lists for both calls and puts:

1. Top N strikes by absolute OI
2. Top N strikes by absolute OI change (vs previous cycle)
3. Top N strikes by volume

The default `top_n` is 3. A strike must appear in all three lists to qualify as "active." This intersection approach filters out strikes that are merely high-OI (legacy positions) without current activity, and strikes with high volume but low OI (speculative noise).

**Output:** `{"call": [24000, 24100], "put": [23900, 23800]}`

### 3.2 Support and Resistance Levels (`identify_support_resistance`)

Identifies the top 5 support and resistance levels using OI-based analysis:

**Resistance** is determined by Call OI. All strikes with CE data are collected with their OI, OI change, and distance from LTP. The strike with the highest absolute Call OI becomes `main_resistance`. The top 5 are ranked by a composite sort: primary key is OI (descending), secondary is OI change (descending), tertiary is distance from LTP (ascending, i.e., closer to LTP ranks higher).

**Support** follows the same logic using Put OI. The strike with the highest absolute Put OI becomes `main_support`.

**Output:** `main_support`, `main_resistance`, `support_levels[5]`, `resistance_levels[5]`

### 3.3 Market Bias (`identify_market_bias`)

Computes the aggregate Call OI vs Put OI across all strikes:

| Condition                              | Bias         |
| -------------------------------------- | ------------ |
| Total Call OI > Total Put OI x 1.2     | Bearish (heavy call writing = resistance) |
| Total Put OI > Total Call OI x 1.2     | Bullish (heavy put writing = support)     |
| Otherwise                              | Range-bound  |

This interpretation follows the option-writing perspective: high Call OI means writers are selling calls (expecting price to stay below), which is bearish. High Put OI means writers are selling puts (expecting price to stay above), which is bullish.

**Output:** `"Bullish"` | `"Bearish"` | `"Range-bound"`

### 3.4 OI Change Signals (`analyze_signals`)

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

### 3.5 S/R Strength Assessment (`assess_sr_strength`)

Tracks whether existing support and resistance levels are strengthening or weakening over time by comparing OI changes at those specific strikes:

For each support level, it checks Put OI change: increasing = "strengthening," decreasing = "weakening." For each resistance level, it checks Call OI change: increasing = "strengthening," decreasing = "weakening."

**Output:** Array of strings like `"Support at 24000 is strengthening (Put OI increased by 15000)"`

### 3.6 Entry Strategy Signals (`analyze_entry_strategy`)

Generates directional entry signals when price is near a key S/R level with confirming OI conditions:

**CALL BUY Entry** (near support): Triggered when price is within 0.5% of `main_support` AND total Put OI is increasing (support holding) AND total Call OI is decreasing (resistance weakening). This combination suggests the price will bounce off support.

**PUT BUY Entry** (near resistance): Triggered when price is within 0.5% of `main_resistance` AND total Call OI is increasing (resistance holding) AND total Put OI is decreasing (support weakening). This combination suggests the price will reject from resistance.

**Output:** Array of entry signal strings with OI change values.

### 3.7 Real-Time Breakout/Breakdown Signals (`analyze_real_time_signals`)

Detects strong directional moves when price crosses a key S/R level with confirming OI shifts:

**Strong Bullish Breakout:** Price is above `main_resistance` AND Call OI at resistance is decreasing (writers exiting/covering) AND total Put OI is increasing (new support being built above old resistance). This is the classic "resistance becomes support" breakout pattern.

**Strong Bearish Breakdown:** Price is below `main_support` AND Put OI at support is decreasing (writers exiting/covering) AND total Call OI is increasing (new resistance being built below old support).

**Output:** Array of breakout/breakdown signal strings.

### 3.8 Exit Strategy Signals (`analyze_exit_strategy`)

Detects potential exit conditions based on aggregate OI shifts:

| Condition                                | Signal                              |
| ---------------------------------------- | ----------------------------------- |
| Total Put OI up AND Total Call OI down   | Bearish shift — exit long positions |
| Total Call OI up AND Total Put OI down   | Bullish shift — exit short positions|

This is a simplified implementation. The spec notes that a more sophisticated version would track OI change direction flips, volume drops, and price stagnation.

**Output:** Array of exit signal strings.

### 3.9 Smart Money Tracking (`analyze_smart_money_tracking`)

Detects coordinated OI and price movements that suggest institutional activity:

**Strong Bullish Setup:** Total Put OI increasing (put writing = support) AND Total Call OI decreasing (call unwinding = resistance weakening) AND Price moving up. All three conditions must be true simultaneously — this is the highest-conviction bullish signal.

**Strong Bearish Setup:** Total Call OI increasing (call writing = resistance) AND Total Put OI decreasing (put unwinding = support weakening) AND Price moving down.

**Output:** Array of smart money signal strings with OI change and price change values.

---

## 4. Opening OI Snapshot System

The Opening OI Snapshot captures the first option chain data of each trading day and enables intraday OI change tracking. This is critical for understanding how the market structure has evolved since the open.

### 4.1 Capture Logic (`capture_opening_snapshot_if_needed`)

On each cycle, the system checks:

1. **In-memory cache**: If a snapshot for today's date exists in `opening_oi_snapshots`, return it.
2. **Disk persistence**: If a file `opening_{instrument}_{date}.json` exists in the `opening_snapshots/` directory with today's date, load and cache it.
3. **New capture**: If no snapshot exists and the current time is between 9:00 AM and 4:00 PM IST, capture the current data as the opening snapshot, save to disk, and cache in memory.

The snapshot stores the full option chain data, the capture timestamp, the date, and the opening LTP.

### 4.2 Intraday OI Change Computation (`compute_intraday_oi_changes`)

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

### 4.3 Activity Classification (`classify_oi_activity`)

OI changes are classified into human-readable labels based on the magnitude and direction of change:

| Change % | OI Direction | Call Label           | Put Label            |
| -------- | ------------ | -------------------- | -------------------- |
| < 2%     | Any          | Holding Steady       | Holding Steady       |
| > 10%    | Increasing   | Heavy Call Writing   | Heavy Put Writing    |
| > 0%     | Increasing   | Sellers Entering     | Sellers Entering     |
| < -10%   | Decreasing   | Short Covering       | Short Covering       |
| < 0%     | Decreasing   | Sellers Exiting      | Sellers Exiting      |

These labels are displayed in the dashboard's S/R Strength Line component.

---

## 5. Output Schema

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

*End of specification.*
