# 12 — Market Status Screen

**STATUS: SPEC — 2026-09-16. No code yet. Design agreed with Partha in session 2026-09-16.**

A Python screen showing session and market condition across four instruments, so entry and exit decisions are made against the full picture rather than a single chart.

---

## 1. Layout

2x2 grid, four equal quadrants, full screen width and height.

```
┌─────────────────────┬─────────────────────┐
│      NIFTY 50       │      BANKNIFTY      │
├─────────────────────┼─────────────────────┤
│      CRUDE OIL      │     NATURAL GAS     │
└─────────────────────┴─────────────────────┘
```

Display rule: **raw number plus colour** (green / red / grey against a threshold). Colour makes a wall of numbers scannable; the raw value stays visible so no logic is hidden. A one-line verdict per group may be layered on later — not in v1.

---

## 2. Data source

Everything comes from TFA, already running and already recording:

- **Live:** tail `data/features/<inst>_live.ndjson` — last line is the latest 576-field row. Same approach as `server/instrumentLiveState.ts:117-133`.
- **Lower latency option:** the feature socket on `127.0.0.1` — nifty50 7761, banknifty 7762, crudeoil 7763, naturalgas 7764 (`python_modules/_shared/feature_stream.py`).
- **History:** `data/features/<date>/<inst>_features.parquet` and `data/raw/<date>/<inst>_chain_snapshots.ndjson.gz`.

No new ingestion is required for v1. The expiry lifecycle view (§4) needs a backfill job.

---

## 3. Data points per quadrant

Grouped by the question each group answers.

### 3.1 Session — is it worth trading now?
`is_market_open`, `minutes_from_open`, `minutes_to_close`, `session_remaining_pct`, `lunch_session_flag`, `days_to_expiry`

### 3.2 Price and trend — which way?
`underlying_ltp`, day change %, `ma_5_1min` vs `ma_20_1min`, `ma_5_5min` vs `ma_20_5min`, `momentum_5min`, `momentum_15min`

### 3.3 Strength — is the move real or noise?
`adx_5min`, `rsi_14_5min`, `macd_histogram_5min`, `underlying_ofi_20`, `underlying_tick_imbalance_20`, `consecutive_higher_highs_5min`

### 3.4 Energy — dead market or about to move?
`regime` + `regime_confidence`, `dead_market_score`, `volatility_compression`, `breakout_readiness`, `underlying_realized_vol_20`, `india_vix` + `india_vix_change_5min`

### 3.5 Levels — where is the room and where is the wall?
`day_range_position`, `distance_to_day_high_pct` / `_low_`, `distance_to_opening_range_high_pct` / `_low_`, `dist_from_session_vwap_pct`, `distance_to_prev_day_high_pct` / `_low_`

### 3.6 Options and OI — what are the writers pricing?
`chain_pcr_atm`, `chain_oi_imbalance_atm`, `max_pain_strike` + `distance_to_max_pain_pct`, `ce_wall_strength_rel` / `pe_wall_strength_rel`, `atm_ce_iv` / `atm_pe_iv` + `iv_skew_atm`, `atm_ce_theta` / `atm_pe_theta`

### 3.7 Tradeability — can I get in and out cleanly?
ATM CE/PE `ltp`, `spread`, `bid_ask_imbalance`, `volume` (from the `opt_0_ce` / `opt_0_pe` ladder), `zone_activity_score`

### 3.8 Who controls the strikes
- **Wall map** — top 3 call-OI strikes (ceiling) and top 3 put-OI strikes (floor), each with distance from spot
- **Wall shift** — did the top wall move up or down versus yesterday? The move is the signal, not the level
- **Multi-day build** — OI at each top strike today versus 1 / 3 / 5 days ago
- **Writing vs unwinding** — OI change paired with price change: fresh selling / fresh buying / covering / unwinding
- **Concentration** — share of total OI in the top 3 strikes. High = strong pin, low = open field
- **Squeeze state** — spot trapped between walls (range) vs spot broke a wall (trend)
- **Max pain drift** — where max pain has moved over 5 days
- **Action window** — days-to-expiry countdown, loud at <= 2

All four instruments get §3.6–3.8: crude and gas **do** have option chains recorded (82 and 83 days).

---

## 4. Expiry lifecycle view

A single session tells you nothing about a build-up. The screen must show a contract's whole life.

**What we record today:** only the **nearest** expiry is polled, at ~22 s, full ladder (~230 strikes). So multi-day build-up for the near expiry is reconstructible — e.g. the 2026-09-23 gas expiry has been recorded since 2026-09-01. The monthly, while a weekly is live, is not recorded.

**What makes the full lifecycle possible:** Dhan's historical chart API accepts `oi: true` and returns an open-interest series per contract (`server/broker/adapters/dhan/index.ts:1221`). So day-by-day OI for any strike can be pulled from the contract's first day — even though we never recorded it. Rate limiter is 10 calls per 250 ms (`index.ts:154`), so a full Nifty expiry (~180 legs) backfills in roughly 5 seconds.

**Unverified — check before building:** whether Dhan serves historical data for **already-expired** contracts. If yes, past cycles become available for comparison; if no, comparison history accumulates from today forward. One test call settles it.

**Views:**

- **Strike x day OI map** — strikes down the side, days since contract open across the top
- **Footprint ranking** — which strikes gained the most OI over the life, and when the build started
- **Cycle phase** — quiet build-up → defending the level → unwind / action
- **Wall migration** — top call and put wall plotted day by day
- **Same-day-last-expiry compare** — this cycle versus the previous 3 at the same days-to-expiry
- **Today's live layer** — the 22 s snapshots on top of the daily history

**Expiries tracked per quadrant:** near + monthly (recommended). Weekly and monthly are the two the large writers actually use.

---

## 5. What is real and what is folklore

Agreed 2026-09-16. This matters because it decides what earns screen space.

**Genuinely used by institutions**
- IV versus realized vol — the core options edge
- Skew and term structure
- Gamma exposure and the gamma flip level
- Liquidity, spread, depth — they cannot get size out of a thin strike
- Event calendar and event-implied move
- OI positioning, as *their own inventory* rather than as a signal to read
- Hard risk limits

**Rarely or never used by them**
- RSI, MACD, ADX, stochastics
- VWAP crossovers as entry triggers
- Higher-high / higher-low pattern reading
- Max pain as a prediction — contested and weak
- Round numbers
- Most single-indicator entry rules

**Different players, different slices**
- Option writers / market makers: IV vs realized, skew, inventory, gamma and delta, hedging cost. Usually **no directional view at all**.
- Prop / HFT: order book microstructure, order flow, queue position. Sub-second.
- FII / DII cash desks: mandates, flows, index rebalancing. Not intraday charts.
- Vol funds: skew, calendars, dispersion, event vol.
- Discretionary / retail: the TA half of the list.

**The wall story, corrected.** Large players do not sit in a room deciding to defend a strike. They write large OI there and then **delta-hedge mechanically**; near expiry that hedging buys dips and sells rallies around the strike. The pinning is real and measurable — it is mechanics, not intent. The data is worth watching; the conspiracy framing is not needed to use it.

India-specific: retail option volume is very large, expiry-day pinning is unusually strong, and NSE publishes FII derivative positioning daily.

---

## 6. The design principle — measure, do not believe

Every data point in §3 is a **hypothesis, not a truth**.

With 78 nifty50 / 72 banknifty days of 576-field feature parquets plus ~80 days of full chain history, each one can be tested: does it separate winners from losers, on these instruments, on this timeframe?

**So the screen shows a measured hit rate next to each number.** A field that never predicted anything is greyed out or dropped. That turns the screen from "indicators somebody believed in" into "indicators that earned their place."

This is the feature that distinguishes it from every off-the-shelf market dashboard.

---

## 7. Timeframe this screen serves

For **buying options**, the constraint is cost, not signal. Bid-ask plus theta must be cleared before a rupee is made.

| Horizon | Verdict |
|---|---|
| Seconds to 1 min | Cleanest signal, **unmonetisable** buying options — spread eats it, and HFT is faster. The scalp work confirmed this: genuine prediction quality, still bled on execution and cost. |
| 1–5 min | Workable on high-volatility days only. Dead most days. |
| **15 min – 2 h** | **The sweet spot.** Move clears spread and decay; slow enough to avoid HFT; flow and OI both still informative; fits a screen a human watches. |
| Full day / overnight | Theta over a night is expensive on weeklies, plus unmanageable gap risk. Fine for futures, poor for bought options. |

**Decision cadence 1–5 min, hold 15 min – 2 h.** Adjustments: on Nifty/BankNifty expiry day everything compresses and the same edge shows in 5–30 min; crude and gas have a longer session and larger percentage swings, so 1–3 h holds are tolerable, especially around inventory releases.

This choice decides which fields matter. At a 30-minute hold the 5-min and 15-min features carry the weight, and tick-level fields become context rather than triggers.

---

## 8. Pre-entry checklist (reference)

The full list this screen is designed to answer, grouped: direction, trend quality, volatility, time, strike selection, smart money / OI, levels, risk, events and session, and exit plan. Captured in §3 above; the exit-plan group belongs to the cohort, not the screen — see [13 — Claude cohort](13_claude_cohort.md) §6.

---

## 9. Open items

| # | Item |
|---|---|
| 1 | Verify Dhan historical OI for expired contracts (one test call) |
| 2 | Decide whether to add monthly-expiry polling going forward |
| 3 | **banknifty chain + feature recording dead since 2026-09-07** — fix; 09-07 itself truncated at 10:12 |
| 4 | Build the hit-rate measurement layer (§6) — the differentiator |
| 5 | Choose the Python UI toolkit |

## 10. Related

- [13 — Claude cohort](13_claude_cohort.md) — the automated strategy over the same data
- [02 — Feature Engineering](02_feature_engineering.md) — TFA, the source of every field here
- [01 — Data Ingestion](01_data_ingestion.md) — recordings behind the lifecycle view
