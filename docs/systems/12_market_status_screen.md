# 12 — Market Status Screen

**STATUS: v1 BUILT 2026-09-17 — `python_modules/market_screen/`. 2x2 live order-flow screen over all four instruments, with each rule's MEASURED track record on screen. Live + replay. The option-chain / expiry-lifecycle panels (§3.6-3.8, §4) are still spec only.**

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


---

## 11 — v1 build (2026-09-17)

`python_modules/market_screen/` — `app.py` (2x2 Tkinter), `verdicts.py` (rules ->
POSITIVE / NEGATIVE / WATCH), `source.py` (live + replay).

**From the launcher (normal route):** root menu -> **`D`  Screen  (market status
— 2x2 order flow)**. It offers `live`, or any of the last 8 recorded days that
have **all four** instruments — a day missing one would replay with an empty
quadrant, which reads as "no flow" rather than "no data", so incomplete days are
not offered. Replay launches at 120x.

Directly:

    startup\market-screen.bat                          # live
    startup\market-screen.bat --replay 2026-09-04
    startup\market-screen.bat --replay latest --speed 120

    # or, from python_modules/
    python -m market_screen.app --replay latest --speed 120 --fullscreen

### 11.1 What it shows

All 15 of Partha's order-flow rules per quadrant, each with a light, the live
numbers behind it, and **its measured track record**. Rule 15 is the combined
read at the bottom of each quadrant.

### 11.2 Where the ticks come from

**Live:** tails TFA's own recordings under `data/raw/<date>/`.

This is not the obvious choice, and the obvious choice is wrong. The server
relays raw Dhan frames at `ws://localhost:3000/ws/ticks`, but **only for what
the SERVER has subscribed to**, which is driven by an open trading desk.
Measured live 2026-09-17 10:05, market open, TFA recording normally:

```json
{"wsConnected": true, "totalSubscriptions": 0, "instruments": []}
```

The relay carried nothing and the screen sat empty **with no error** — it
connected fine and simply had no data. TFA holds its own direct Dhan connection
and records continuously through the session, so its files always have it.

The recorder appends independent gzip members and flushes, so re-reading yields
everything written so far; the trailing partial member raises `EOFError`, which
is caught and what was read is kept. Measured: 31 ms for 945 ticks, so the 1 s
poll is comfortable. Verified live — nifty50 819 ticks and banknifty 1,086
ticks, both reading correctly at 10:07.

The relay is still available with `--source ws`, useful when a desk IS
subscribed and as a cross-check.

**Replay:** any recorded day from `data/raw/`, all instruments merged in
timestamp order so the quadrants advance together. 71 days have all four.
Needed because the screen must be testable while the market is shut.

### 11.3 Bug found while building: the security-id map

Neither the instrument profile nor `metadata.json` can be used to map
security id -> instrument. Both record `underlying_security_id` = **13** for
NIFTY, which is the SPOT index. Dhan sends the spot index in **ticker mode
only** — price and nothing else, no volume, no book. The ticks actually carry
the resolved near-month FUTURES contract (**68407**).

Mapping by metadata would have produced a screen that connected successfully,
showed a price, and reported no order flow at all — a silent failure with no
error. The map is now derived from the recordings themselves:

| instrument | contract id |
|---|---|
| nifty50 | 68407 |
| banknifty | 68390 |
| crudeoil | 565899 |
| naturalgas | 568245 |

### 11.4 The measured track record is on screen, deliberately

Each rule displays its edge from §16 of the cohort spec — 77 nifty days, 26,671
decision points. Anything inside +/-3pp is labelled "noise" in the UI itself.

This is the §6 principle made literal. A green light means *aggressive buying is
happening*, not *price will rise*. Rule 7 shows POSITIVE and carries "-4.4pp"
next to it, because that is what it measured. The screen is not allowed to look
more confident than the evidence.

**How to read it:** the one thing order flow demonstrably does is stop you
taking bad trades — it moved a setup from a 25% win rate (far worse than a coin)
to 46% (near random). So this screen is a reason to STAY OUT, not a reason to
enter.

### 11.5 Not yet built

- Option-chain panels (§3.6, §3.7) and the who-controls-the-strikes panel (§3.8)
- The expiry lifecycle view (§4) and its Dhan historical-OI backfill
- Per-instrument flow thresholds (currently the shared scale-free defaults)
- Option-leg flow — the book cache stores bid/ask/ltp but not per-contract
  volume, which rules 2-3 need on the premium tape
