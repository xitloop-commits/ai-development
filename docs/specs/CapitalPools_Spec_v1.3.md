# Capital Management & Auto-Execution System — Spec v1.3

---

## Changelog

| Version | Date | Change |
|---------|------|--------|
| v1.0 | Original | Initial specification |
| v1.1 | 31 Mar 2026 | Added **Universal Capital Allocation Rule** — the 75/25 split applies to all incoming capital |
| v1.2 | 31 Mar 2026 | Added **Project Target** — 250 Day Index cycles from ₹1L, with projected growth milestones |
| v1.3 | 31 Mar 2026 | Refined multi-instrument common pool logic, position sizing, clawback mechanics, calendar session resets, and instrument-specific trade parameters based on Q&A |

---

## 1. System Overview

A multi-instrument automated trading system with:

- A **common Trading Pool** shared across all instruments
- Two-pool architecture (Trading + Reserve)
- Reversible compounding (Day Index cycle system)
- Rule-based execution and basic risk control (extended risk controls covered in "Disciplined Trade Controller" spec)
- Trade execution logic and instrument selection covered in "Trader Desk" spec

Multiple instruments can have open positions simultaneously, all drawing from the common Trading Pool. At the end of the journey, performance is measured per instrument to identify the highest yield.

---

## 2. Project Target

### Goal

> **Achieve 250 completed Day Index cycles starting from ₹1,00,000 initial funding, where each cycle represents a +5% profit on the Trading Capital at the start of that cycle.**

### Key Parameters

| Parameter | Value |
|-----------|-------|
| Initial Funding | ₹1,00,000 |
| Initial Trading Pool | ₹75,000 (75%) |
| Initial Reserve Pool | ₹25,000 (25%) |
| Target per Day Index Cycle | +5% of Trading Capital at start of cycle (Configurable) |
| Effective Compounding Rate (Trading) | 3.75% per cycle (75% of 5% profit retained) |
| Total Cycles | 250 |
| Approximate Timeframe | ~1 year (250 market trading days, but cycles may span multiple calendar days) |

### Projected Growth Milestones

The table below shows the projected state of both pools at key milestones, assuming every Day Index cycle achieves exactly +5% on Trading Capital with the 75/25 profit split applied.

| Day Index Cycle | Trading Pool | Reserve Pool | Total Capital | Total Growth |
|----------------:|-------------:|-------------:|--------------:|-------------:|
| 1 | ₹77,812 | ₹25,938 | ₹1,03,750 | 3.75% |
| 50 | ₹4,72,570 | ₹1,57,523 | ₹6,30,094 | 530.09% |
| 100 | ₹2,977,637 | ₹992,546 | ₹3,970,183 | 3,870.18% |
| 150 | ₹18,761,911 | ₹6,253,970 | ₹25,015,881 | 24,915.88% |
| 200 | ₹118,217,655 | ₹39,405,885 | ₹157,623,540 | 157,523.54% |
| **250** | **₹744,882,222** | **₹248,294,074** | **₹993,176,297** | **993,076.30%** |

> **Note:** These projections assume ideal conditions — every cycle achieves exactly +5%. Actual results will vary based on market conditions, losses, clawbacks, and the number of calendar days required per cycle.

---

## 3. Capital Architecture

### Initial Allocation

| Component | Amount |
|-----------|--------|
| Total Capital | ₹1,00,000 |
| Trading Account | ₹75,000 |
| Reserve Account | ₹25,000 |

### Universal Capital Allocation Rule

> **All incoming capital — regardless of source — is split 75% to Trading Account and 25% to Reserve Account.**

This rule applies uniformly to:

| Capital Source | Trading Pool (75%) | Reserve Pool (25%) |
|----------------|--------------------|--------------------|
| Initial allocation | ₹75,000 | ₹25,000 |
| Profit earned | 75% of profit | 25% of profit |
| New capital injection | 75% of new funds | 25% of new funds |

### Capital Rules

**Profit Split**

- 75% → Trading Account
- 25% → Reserve Account

**Loss Handling**

- 100% of loss deducted from Trading Account
- Reserve remains untouched

**Reserve Rules**

- No automatic debit
- No clawback
- No loss adjustment
- Only increases via profit split or new capital injection (25% share)
- Manual transfer only (Reserve → Trading)

---

## 4. Compounding Model

- Effective compounding rate: 3.75% per Day Index cycle
- Trading account compounds
- Reserve accumulates (non-compounding)

---

## 5. Day Index System (Core Logic)

### Concept

- "Day" is not a calendar day.
- "Day" = one completed profit cycle (default +5%, configurable in system settings) on the combined Trading Capital across all instruments.
- The system stays in the same Day Index cycle until the target is reached, regardless of how many calendar days it takes.

### Forward Movement

- If combined cumulative PnL ≥ target (e.g., +5%) of Trading Capital at start of cycle:
    - Move to next day (Day + 1)
    - Apply profit split (75/25)

### Backward Movement (Clawback)

- If cumulative loss ≥ −5%:
    - The loss eats into the **full profit of the previous day(s)**, but the deduction happens **only from the Trading Pool**.
    - The 25% profit that went to Reserve in previous days is permanently safe and not considered for loss adjustment.
    - Move backward (Day − 1). The previous day is nullified.
- Continue until:
    - Loss is fully absorbed by previous Trading Pool profits, or
    - Day 1 is reached.
- **Incomplete Day Recovery:** If a clawback partially eats a previous day's profit, that day is no longer complete. The system stays on that day and must earn the remaining gap to hit the original target for that day. The target does not reset; the remaining profit carries forward.

### Floor Condition

- Minimum Day = Day 1
- No backward movement below Day 1
- Unabsorbed loss remains in Trading Account

### Carry Forward Rule

- Excess profit beyond the target carries forward to the next day cycle.

---

## 6. Trade Execution Engine

### Entry

- Market Order
- Dhan is the only supported broker for now (system designed to support multiple brokers via adapters in the future).
- Dhan handles target and stop-loss execution automatically out of the box.

### Trade Parameters (Configurable per Instrument Type)

Trade parameters are configurable in system settings based on the instrument type.

| Parameter | Options (Default) | Equities/Futures (Default) |
|-----------|-------------------|----------------------------|
| Trade Target | 30% of entry price | 2% of entry price |
| Stop Loss | 2% below entry | Configurable |
| Trailing Jump | ₹5 increments | Configurable |

### Behavior

- Trailing SL updates in specified increments (e.g., ₹5).
- Fully automated trade management.

---

## 7. Position Sizing

### Available Funds Based Sizing

- **No fixed percentage logic.**
- Position sizing is based on **fund availability** in the common Trading Pool at execution time.
- The system/user controls how much capital to allocate per trade at the moment of execution.
- If there are not enough available funds (Total Trading Pool minus capital already deployed in open positions), the trade does not execute.

---

## 8. Basic Risk Management Engine

*Note: Extended and full risk controls are covered separately in the "Disciplined Trade Controller" specification.*

### Calendar Session Resets

Risk controls operate on a **calendar trading session** basis, even though the Day Index cycle spans multiple calendar days.

### Max Daily Loss (Per Calendar Session)

- Configurable (Default = 3% of Trading Capital)
- **Behavior:** If combined cumulative loss across all instruments ≥ max daily loss:
    - Stop trading for the current calendar session.
    - Enter cooldown (Configurable, Default = 15 minutes).
- **Post-Cooldown:** Trading resumes, but loss tracking continues (no reset) until the next calendar session or next Day Index cycle.

### Max Trades (Per Calendar Session)

- Configurable (Default = 5 trades combined across all instruments)
- **Behavior:** If trade count ≥ max trades:
    - Stop trading completely for the current calendar session.
    - Resume trading on the next market open, still within the same Day Index cycle.

### Stop Conditions

Stop trading for the session when:

1. Day Index Target achieved (e.g., +5%)
2. Max daily loss reached (per calendar session)
3. Max trades reached (per calendar session)

---

## 9. Data Structures (Logical)

### Capital State

- `trading_capital` (Common pool)
- `reserve_capital`

### Day State

- `current_day_index`
- `day_start_capital`
- `target_amount`

### PnL Tracking

- `cumulative_pnl` (Combined across all instruments)
- `session_loss_tracker` (Resets per calendar session)
- `session_trade_count` (Resets per calendar session)
- `instrument_pnl_tracker` (For end-of-journey performance measurement)

### Profit History (for clawback)

- List of daily profits (Full profit amount and Trading Pool share)

---

## 10. Runtime Configurations

| Parameter | Default Value | Scope |
|-----------|---------------|-------|
| Day Index Target % | 5% | System |
| Max Session Loss % | 3% | System (Calendar Session) |
| Max Session Trades | 5 | System (Calendar Session) |
| Cooldown | 15 minutes | System |
| Options Trade Target % | 30% | Instrument Type |
| Equities Trade Target % | 2% | Instrument Type |
| Stop Loss % | 2% | Instrument Type |
| Trailing Jump | ₹5 | Instrument Type |
| Capital Split Ratio | 75% Trading / 25% Reserve | System |

---

## 11. System Characteristics

### Strengths

- Capital protection via reserve
- Controlled compounding
- Reversible profit system with strict clawback rules
- Common pool efficiency for multi-instrument trading
- Uniform capital allocation across all fund sources

### Known Behaviors

- Cycle may span multiple calendar days
- Day 1 is risk floor
- Reserve not used automatically for recovery
- Risk limits (loss, trades) reset per calendar session, while profit targets persist across sessions until achieved.

---

## 12. Final Definition

A multi-instrument, common-pool, reversible compounding trading system with adaptive execution, basic session-level risk controls, universal 75/25 capital allocation, and manual capital recovery — targeting 250 Day Index cycles from ₹1,00,000 initial funding.

**Status:** This specification is complete and ready for implementation.
