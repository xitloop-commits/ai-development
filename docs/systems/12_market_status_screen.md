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


---

## 12 — Multi-window table (2026-09-17)

Each quadrant is now a table: the 15 rules down the side, Partha's six
confirmation windows across the top, the measured edge in the last column.

| | 1m | 2m | 5m | 10m | 15m | 30m |
|---|---|---|---|---|---|---|
| windows (sec) | 60 | 120 | 300 | 600 | 900 | 1800 |

### 12.1 Why a grid rather than one window

Rule 15 says never one tick and names 1 / 2 / 5 minutes. Putting every window
side by side answers the question a single window hides: **is this read
consistent, or does it exist in one timeframe only?**

Live sample, nifty50 2026-09-17 10:12, 1,484 ticks:

```
rule                   1m     2m     5m    10m    15m    30m   edge
 2 Aggr buying          ▲      ▲      ▲      ▲      ▲      ▲   -3.2
 4 Price + qty          ▼      ▲      ◆      ▲      ▲      ▲
 7 Pressure             ◆      ▲      ◆      ▲      ▲      ▲   -4.4
 8 Delta (obs)       +260 +11.5k +12.4k +19.0k +28.2k +25.5k
14 Rejection            ▼      ▼      ▼      ▼      ▼      ▼   -3.8
15 COMBINED             ▼      ▲      ▼      ▲      ▲      ▲
```

Rule 14 is negative on **every** window — consistent. Rule 15 flips on the
short windows and holds positive on the long ones. Neither is visible from a
single 5-minute read, and the 5-minute column alone would have shown rule 4 as
merely "watch".

### 12.2 Two views, toggled with V

- **A — table only.** The default. Scanning consistency across timeframes.
- **B — table + detail.** The same grid plus the raw numbers for the selected
  window, in a column on the right.

Keys `1`-`6` pick the detail window (default 5m); `V` toggles; `F11` fullscreen;
`Esc` quits. `--view A|B` sets the starting view.

### 12.3 Rows that deliberately break the grid

- **11 Depth and 12 Imbalance** span all six columns with a single value. They
  are the book *right now*; a 30-minute depth reading does not exist, and
  inventing one would be fabricating data.
- **1 Trade side and 8 Delta** show numbers, not arrows. Rule 8 is Partha's own
  "observation, not an entry signal by itself" — giving it an arrow would make
  it look like a call.

### 12.4 Cost

Six windows x four instruments recomputed once a second. Redraw is 1 Hz rather
than 2: the table spans 1-30 minutes, so a faster refresh would only burn CPU
re-deriving windows that cannot have meaningfully changed.


---

## 13 — "now" column, plain-English meanings, cold-window marking (2026-09-17)

Three changes after Partha saw v1 on screen.

### 13.1 A "now" column, first

| | now | 1m | 2m | 5m | 10m | 15m | 30m |
|---|---|---|---|---|---|---|---|
| seconds | 10 | 60 | 120 | 300 | 600 | 900 | 1800 |

"now" is a **10-second** look-back, not a single tick. 65% of packets carry no
new volume at all, so a literal instant would blink empty most of the time.

### 13.2 Every row says what it MEANS

The arrow gives the direction; the text gives the why, so the screen reads
without knowing which field produced it. Examples straight off the tape:

| rule | meaning |
|---|---|
| 2 | "68% of volume lifted the ask - buyers paying up" |
| 4 | "12,400 traded but price moved only +0.4 - someone is absorbing it" |
| 7 | "net selling of -325 but price is NOT following - watch" |
| 9 | "delta +9,100 but price -3.2 - they disagree, possible absorption or exhaustion" |
| 12 | "buy side shows 53% more resting size - NOT a direction signal on its own" |
| 13 | "size left the bid side - cancelled or filled, the book cannot tell which" |
| 15 | "4 rules point up, 1 down - buying is what is HAPPENING, not a forecast" |

Each row also carries **how many windows agree** — `[6/7]` versus `[2/7]`. That
is the question the grid exists to answer, so it should not need counting by eye.

View **B (table + meaning) is now the default**; `V` toggles to the compact
table. There is plenty of screen for the words.

### 13.3 Cold windows are left BLANK, and fill in as the tape arrives

Partha asked the right question: *on restart we will not have values for all the
intervals, right?*

Mostly we do — `TailSource` re-reads today's whole recording on start, so a
mid-session restart refills every window immediately. But at the open, or with
TFA not recording, a 30m window genuinely has nothing in it.

Previously that printed `·`, identical to "nothing is happening". A window
without enough history is now left **blank** — blank means "no data yet", a dot
means "nothing is happening", and those are different facts that must not share
a glyph. The meaning reads `waiting - 3m of tape so far, this window needs 5m`.
`FlowState.data_span()` reports the seconds of tape held.

**"now" is live from the first print.** It is a 10-second look-back, so making
it wait for a full 10 seconds of span would blank the column at exactly the
moment you most want to see the tape move. The rest fill in left to right:

```
     fed    span     now    1m    2m    5m   10m   15m   30m
       5    0.0m       ▼
     400    5.3m       ·     ▲     ·     ·
     900   12.3m       ·     ·     ▼     ▲     ▲
    1600   21.9m       ·     ▼     ▼     ▼     ▲     ▲
    2500   34.2m       ▼     ·     ·     ▲     ▼     ▼     ▲
```

At one tick even `now` is blank, correctly: the first packet has no predecessor
to diff cumulative volume against, so no trade has been observed yet.

This is the same class of silent failure as the security-id bug (§11.3) and the
empty relay (§2): the screen showing something plausible when it actually has
nothing. Marking it is not cosmetic.


---

## 14 — Tooltips, and why "now" is 30 seconds (2026-09-17)

### 14.1 Hover help on every rule

Hovering a rule name gives a plain-English explanation: what it watches, and —
just as important — what it does NOT mean. Rule 7's, for instance, ends with
"measured over 77 days this was the WORST of all fifteen rules, about 4 points
below a coin", because a user hovering for help deserves to be told that.

The column headers have them too: `now`, `edge` and the window columns each
explain themselves, including that blank means "no data yet" while a dot means
"nothing happening".

Shared popup, 450 ms delay (an instant tooltip flashes constantly across a
dense grid), auto-flips near the screen edges.

### 14.2 "now" is the CURRENT TICK, not a timeframe

Partha asked why the `now` column was showing dots, then corrected the premise:
**now does not mean a timeframe, it means the current tick.** The first build
had it as a short look-back, which was wrong.

`read_now()` now reports what just happened:

| rule | now shows |
|---|---|
| 1 Trade side | which side the last trade hit, and its size |
| 2, 3 | whether that trade lifted the ask or hit the bid |
| 4 | the price move on that tick against its size |
| 8 | that single trade's contribution to delta |
| 9 | the running cumulative delta right now |
| 11, 12, 13 | the book as it stands, and what left it on the latest update |
| 5, 6, 7, 10, 14, 15 | **em-dash** — one trade cannot answer these |

Live example: *"the last trade was 195 at the ask @ 23,308.00"*, *"195 traded and
price moved +3.90 on this tick"*, *"+16,575 net since the open"*.

Three distinct glyphs, three distinct facts:

| | means |
|---|---|
| blank | no data yet — the window has not filled |
| `·` | nothing is happening — the rule is not firing |
| `—` | not answerable by one trade — use a timeframe column |

Absorption, exhaustion, pressure and rejection all need size over time and a
before-and-after comparison. A single trade supplies neither, so they say so
rather than pretending.

One caveat recorded in the tooltip: about two thirds of market updates carry no
trade at all, so "the current tick" means the most recent tick that actually
traded. The book, by contrast, is genuinely current.

Keys shift accordingly: `2`-`7` select the detail timeframe (`now` is always the
first column and needs no selection).


---

## 15 — Why a row shows a dot (2026-09-17)

Partha: *the other timeframes are aggregated, so why does it say dot?*

They are aggregated — every trade in the window. A dot means the aggregate does
not meet that rule's condition. Measured at the 5m window on nifty50 today, how
often each row sat dark:

| row | dark | why |
|---|---|---|
| 4 Price + qty | 2% | almost always has something to say |
| 7 Pressure | 0% | always has a reading |
| 9 Cum delta | 2% | always has a reading |
| 15 COMBINED | 13% | |
| 10 Exhaustion | 59% | a real event, fires ~40% of the time |
| 14 Rejection | 58% | only when a level is being tested |
| **5, 6 Absorption** | **100%** | genuinely did not happen today — ~3% of minutes historically |
| 1, 8, 11, 12, 13 | n/a | these show numbers or text, never arrows |

Three separate causes, only one of which was a real problem:

**1. Rows that show values, not arrows.** Trade side, delta, depth, imbalance and
liquidity removal always print numbers. They register as "neutral" internally but
never look like a dot on screen.

**2. Rules that are simply rare.** Absorption fires on about 3% of minutes by
design — it needs size well above the session's own normal *and* a price that
refuses to move. A dark absorption row means it is not happening, which is the
correct and usual answer.

**3. The real problem: rules 2 and 3 are mirror images.** Only one side can
dominate, so one of the two rows was always a bare dot — throwing away the
information and reading as "nothing here".

**Fixed:** both now show their *share* at every window, coloured only when that
side dominates:

```
 2 Aggr buying          ·    70%    71%    66%    61%    53%    51%
 3 Aggr selling         ▼    30%    29%    34%    39%    47%    49%
```

Buying decaying from 70% at 1m to 51% at 30m is exactly the kind of thing the
grid is for, and it was invisible when one row was a dot.


---

## 16 — Trade side by COUNT, and the clip-size tell (2026-09-17)

Partha: *you show "buy" for trade side in the now column, why not for the other
timeframes?*

The obvious fix — print the dominant side — would have duplicated rules 2 and 3,
which already split the window by volume. So rule 1 shows the **count** split
instead, which is different information:

```
 1 Trade side         sell     7/5   10/21   16/25   35/33   44/44 127/117
 2 Aggr buying           ·     21%     22%     26%     43%     46%     48%
 3 Aggr selling          ▼     79%     78%     74%     57%     54%     52%
```

Rule 1 = how many trades went each way. Rules 2/3 = how much volume did.

### 16.1 Why that pairing matters

When count and volume disagree, one side is working in bigger clips — and that
is the closest thing we have to an institutional footprint. Straight off today's
tape:

| | trades that are buys | volume that is buys | reading |
|---|---|---|---|
| **nifty50** 5m | 40% | 21% | sells are the bigger clips |
| **banknifty** 5m | 40% | **69%** | buys are the bigger clips |

BankNifty is the striking one: fewer buy *trades* than sell trades, but nearly
70% of the *volume*. Somebody is accumulating in size while more numerous
smaller sellers hit the bid. Summing volume alone hides it; counting trades
alone hides it; only the pair shows it.

The explanation column states it outright — "sells are the bigger clips" —
whenever the two diverge by more than 8 points.

This is a partial answer to the print-size gap noted when reviewing what was
missing from the 15 rules. It is not full large-print detection (that needs the
distribution of `ltq`, not just the mean), but it costs nothing and surfaces the
same asymmetry.

### 16.2 Also fixed

The meaning line now accounts for trades **inside the spread**, which are
neither aggressive buys nor sells. Previously it read "69 trades - 16 hit the
ask, 25 hit the bid", which does not add up and looked like a bug. It now reads
"16 at the ask, 25 at the bid, 28 inside the spread", and the count percentage
is computed over buys+sells so it compares like-for-like with the volume share.


---

## 17 — Plain English throughout (2026-09-17)

Partha: *instead of saying x/y - which side most of them traded. And details
should be in layman english.*

### 17.1 Rule 1 names the side

`16/25` became `buy` / `sell` / `even` — the side that most trades went to. The
count detail moved into the explanation, where there is room for it to mean
something.

### 17.2 Every explanation rewritten

32 of them. Before and after:

| rule | was | now |
|---|---|---|
| 1 | "16 at the ask, 25 at the bid - 40% of TRADES vs 21% of VOLUME" | "more buys than sells - 31 against 21, but the buyers are trading in bigger lots" |
| 4 | "12,400 traded but price moved only +0.4 - someone is absorbing it" | "12,400 changed hands and the price barely moved (+0.4) - somebody large is quietly taking the other side" |
| 7 | "net buying of +5,525 and price is following it" | "buyers are pushing harder, and the price is moving with them" |
| 9 | "delta +5,720 vs price +12.0 - they disagree, possible absorption" | "the buying and the price disagree - buying is +5,720 while the price went -3.2. Someone is absorbing it, or the push is running out" |
| 12 | "buy side shows 65% more resting size - NOT a direction signal" | "more people waiting to buy than the other way (65% more). Easy to fake, so do not read direction into it" |
| 13 | "size left the bid side - cancelled or filled, the book cannot tell which" | "waiting orders vanished from the bid side (24,895 buy / 4,875 sell). Either they were filled or someone pulled them - we cannot tell which" |
| 15 | "3 rules point up, 0 down - buying is what is HAPPENING" | "3 rules say up, 0 say down. This is what IS happening, not what will happen" |

The clip-size tell survives the rewrite and is now stated in words rather than
left to be inferred from two rows: *"but the buyers are trading in bigger lots"*
appears whenever the trade count and the volume share disagree by more than 8
points.

No jargon left in the detail column: no "delta", no "resting size", no "ask" or
"bid" without saying what they mean. The tooltips still carry the technical
detail for anyone who wants it.


---

## 18 — Explanations cover every timeframe, and wrap (2026-09-17)

Partha: *details should not be for 5min - combine all the timeframes. Text
should wrap to the next line when there is no real estate.*

### 18.1 One statement across all six windows

The detail column described the selected window only, which wasted the grid it
was sitting next to. It now synthesises every timeframe:

```
 1. buys lead on 1m, 2m and 5m; sells lead on 10m, 15m and 30m
 4. price down on real volume on 5m, 15m and 30m; price up on 2m and 10m; nothing on 1m
 7. someone pushing but price stuck on 1m, 2m and 10m; sellers pushing and price
    following on 5m, 15m and 30m
15. leaning down on 5m, 15m and 30m; leaning up on 2m and 10m; split on 1m
```

Rows carrying numbers get a trajectory instead of a grouping, because "how it
moves as you zoom out" is the useful shape:

```
 2. buying share fading as you zoom out, 100% at 1m down to 49% at 30m
    (1m 100%  2m 40%  5m 35%  10m 39%  15m 45%  30m 49%)
 8. running total by timeframe: 1m +845  2m -585  5m -1.3k  10m -2.2k  15m -1.8k  30m -715
```

Two deliberate choices:

- **Neutral groups go last.** Leading with "not happening on four windows;
  buyers soaking up the selling on 1m and 2m" buries the only newsworthy half of
  the sentence.
- **Rows with no per-window story** — depth, imbalance, liquidity removal — keep
  their own single sentence. The book is only ever "now", so grouping it by
  timeframe would be meaningless.

### 18.2 Wrapping

Explanations wrap to as many lines as they need. Tkinter wraps on a pixel count
rather than on the cell, so a `<Configure>` handler recomputes the wrap width
from the space actually left after the rule name, the seven columns and the edge
column — otherwise the text overflows a narrow quadrant and stops short in a
wide one. Rule names and explanations both anchor to the top of their row so a
two-line explanation stays aligned with its label.
