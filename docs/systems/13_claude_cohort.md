# 13 — Claude cohort (context-first option buying)

**STATUS: BUILT, NOT YET JUDGED — 2026-09-16. Rules + backtest + per-contract book + 32 green tests at `python_modules/claude_cohort/`. No verdict yet: the first run was invalidated by a fill-model bug (§14) and the corrected run is blocked on the option-book cache build. Nothing wired, nothing live.**

Scope: nifty50 + banknifty. Buy options only (CE/PE), never write. Paper-pinned until validated.

---

## 1. The idea in plain words

Every cohort we have run so far decided from **one narrow view**. CB2 and candleblue watched only the ATM premium tape — each leg blind to the index, to order flow, and to what the option writers were doing. The 2026-09-15 audit showed exactly what that costs: CB2 could not tell continuation from reversal (winners had +10.9 pts of pre-entry move, losers +8.9 — statistically identical), and on 20 of 72 days it held CE and PE at the same time because neither leg knew the other existed.

The Claude cohort inverts that. It decides **on the index first** — trend, order flow, levels, volatility, option-writer positioning — and only then picks a strike to express the view. The premium tape is the vehicle, never the compass.

It also starts from an honest premise: **no data predicts direction.** Data gives odds. So this cohort's job is narrower than "find the move":

1. Say when conditions are favourable versus hostile.
2. Say when to stay out — which is where most of the money is.
3. Size the bet to the confidence.

The expected shape of a good day is **zero to three trades, flat most of the day**.

---

## 2. Locked decisions (2026-09-16)

| # | Decision | Choice |
|---|---|---|
| C1 | Instruments | nifty50 + banknifty. Crude/gas later. |
| C2 | Direction | Both CE and PE. No side filter — `blast`'s PE-only was in-sample selection (findings §3 caveat 4). |
| C3 | Vehicle | Buy ATM / slightly ITM, current weekly expiry. Delta target 0.45–0.60. Never deep OTM. |
| C4 | Decision cadence | Every 1 minute, on the feature row nearest the minute boundary. |
| C5 | Hold horizon | 15 min – 2 h. Default time stop 30 min. Halved on expiry day. |
| C6 | Position rule | 1 lot. One position per instrument at a time. Exit before enter — no reversal in the same minute. |
| C7 | Rules vs learning | **Hand-written rules with swept thresholds.** Deliberately not a model — we need to see why it acted. A learned layer can come later. |
| C8 | Implementation pattern | Standalone runner (`blast` pattern), consuming the TFA feature row. **Not** an `engine.py` cohort — it does not need the locked-premium tape, and the external pattern touches ~1/3 the files. |
| C9 | Data source | `data/features/<date>/<inst>_features.parquet` for decisions; `<inst>_option_ticks.ndjson.gz` for fills. |
| C10 | Validation | Backtest first. Standing bar in §8. No paper wiring until it passes. |
| C11 | Budget | Rs 50,000 paper capital. 1 lot. See §7. |
| C12 | Name | `claude` in code, config, UI and chat. |

---

## 3. Data availability (verified 2026-09-16)

| Item | nifty50 | banknifty |
|---|---|---|
| Feature parquets (576 cols, ~27k rows/day) | **78 days** | **72 days** |
| Chain snapshots (full ladder, ~230 strikes, ~22 s) | 79 days → 09-16 | 74 days → **09-07 only** |
| Option tick recordings | yes | yes |
| Window | 2026-04-21 → 2026-09-16 | 2026-04-21 → 2026-09-07 |

Both clear the 60-day bar. **Known gap:** banknifty chain + feature recording has been dead since 2026-09-07 (that day is itself truncated at 10:12). Fix separately — tracked in PROJECT_TODO.

---

## 4. Session filters (all must pass before any setup is considered)

| Filter | Rule | Why |
|---|---|---|
| Market open | `is_market_open == 1` | — |
| Opening noise | `minutes_from_open >= 15` | Opening range is noise, spreads wide |
| Lunch dead zone | `lunch_session_flag == 0` | No follow-through |
| Closing window | `minutes_to_close >= 30` | No time for the idea to work |
| Feed health | `time_since_chain_sec < 120` | Stale chain = blind to OI |
| Event days | crude inventory (Wed), gas storage (Thu), CPI / policy days | Trade after the release or not at all |
| Day loss limit | set before the session, non-negotiable | |
| Two-loss rule | no new entries after 2 losing trades that day | |

---

## 5. The two setups

Only these. Everything else is passed.

### Setup A — Break with flow behind it

Long CE (mirror for PE):

| Condition | Field |
|---|---|
| Clears opening range high, or day high | `distance_to_opening_range_high_pct > 0` or `distance_to_day_high_pct >= 0` |
| Flow pushing the same way, not fading | `underlying_ofi_20 > 0` and `underlying_tick_imbalance_20 > 0` |
| Range expanding, not drifting | `underlying_realized_vol_20` above its own session median |
| Trending, not chopping | `adx_5min >= ADX_MIN` |
| Not already exhausted | `rsi_14_5min < RSI_MAX` |
| **Room to the wall** | nearest call-OI wall above spot is **further than the target**. If the wall is inside the target, there is no trade. |

### Setup B — Failed move (fade back)

The higher-hit-rate setup. Long PE after a failed upside break (mirror for CE):

| Condition | Field |
|---|---|
| Price poked beyond the level then came back | OR/day-high distance went positive, then negative, within `FADE_WINDOW` min |
| Flow flipped against the break | `underlying_ofi_20` sign flips |
| Writers defending the level | call OI at that strike rising over the last 15 min |
| Target | session VWAP (`dist_from_session_vwap_pct → 0`) |

Setup B is permitted in chop; Setup A is not.

### Liquidity / cost gate (both setups)

| Gate | Rule |
|---|---|
| Spread | `opt_0_<leg>_spread` <= `SPREAD_MAX_PCT` of the rupee target |
| Delta | `atm_<leg>_delta` in 0.45–0.60 |
| Depth | enough size on the bid to exit 1 lot |
| Breakeven | breakeven distance < realistic target |

---

## 6. Exits — all decided at entry, none discretionary

| Exit | Rule |
|---|---|
| **Hard stop** | On the **underlying** level, not the premium. Premium moves for reasons unrelated to the thesis. |
| Stop distance | `max(STOP_PCT, N ticks)` — **scale-invariant**. Findings bug 8: a flat 0.2% is 36 ticks on BANKNIFTY and under 1 tick on NATURALGAS. |
| Target 1 | Nearest OI wall or prior swing. **Take half off.** |
| Trail | Remainder under 5-min structure / 5 MA on 5-min. |
| Time stop | 30 min default. Not working = information; theta charges rent while you wait. |
| Flow flip | Hard `underlying_ofi_20` reversal → exit immediately, do not wait for the stop. |
| Expiry day | All hold times halved. Gamma cuts both ways. |

Never: average down, hold through lunch hoping, re-enter after two losses, buy into a known event for the vol crush.

---

## 7. Sizing and budget

Rs 50,000 paper capital.

| | nifty50 | banknifty |
|---|---|---|
| Lot size | **65** | **30** |
| ATM premium (typical) | ~200 | ~400 |
| Cost per lot | ~Rs 13,000 | ~Rs 12,000 |
| Risk per trade at stop | ~Rs 865 (measured) | ~Rs 900 |

Worst case both open ≈ Rs 25,000, leaving ~50% buffer. Risk per trade ≈ **1.7% of capital**.

**Lot sizes settled EMPIRICALLY 2026-09-16**, because the repo disagreed with
itself (`blast_model/backtest.py` said 65, `sim_pnl.py` said 75). Every `ltq` in
the recorded option ticks is an exact multiple of the lot: nifty50 2026-09-11,
35,804 ticks, GCD = 65; banknifty 2026-09-04, 38,863 ticks, GCD = 30. blast was
right. The Rs 865 risk figure is from an actual simulated stop-out, and matches
the arithmetic (23 pt stop x 0.5 delta x 65 qty + Rs 80 charges).

**Trap to avoid:** `aiModeConfig.ts` default sizing is `{mode:"lots", value:10}` — that is Rs 150,000 a trade. Must be set to **1 lot** for this cohort before anything runs.

Lot size is authoritative from the Dhan scrip master (`scripMaster.ts:553`), not hardcoded. The 75/30 figures above are from `sim_pnl.py:81-86` (marked "as of 2026-05") and must be re-verified.

---

## 8. Validation protocol

Adopted verbatim from the 2026-09-15 standing bar, plus the method lessons that caused repeated false positives.

**Bar — all five must pass before any capital:**

1. >= 60 trading days, out-of-sample, walk-forward (the rules see only prior days)
2. Profitable in the **majority of months judged independently**
3. Survives **removing the top 3 trades**
4. **No look-ahead** — every input knowable at decision time
5. Not explained by **market direction** over the window

**Look-ahead ban list.** The feature parquet contains forward labels. These are banned as inputs, no exceptions:
`max_upside_*`, `max_drawdown_*`, `risk_reward_ratio_*`, `direction_*`, `trend_*_{900,1800}s`, `swing_*_{3600,7200}s`, and any column whose value depends on data after the decision timestamp.

**Method rules:**

- Sweep thresholds on train days only; judge on held-out days never touched by tuning.
- Judge **per month**, not on the last N days — the last window (08-11 → 09-07) fell 2.7% and flatters any short-biased rule.
- Report net excluding top 1 / 3 / 5 trades, always.
- **Test Setup A and Setup B independently**, with separate verdicts. Combining them before each is proven repeats the in-sample selection trap.
- Charge-aware throughout — reuse `blast_model/backtest.py` conventions.
- Short windows lie: CB2 showed +Rs 179,742 in August alone and -Rs 571,666 over the full 72 days.

---

## 9. Why this may differ from CB2 — and why that is not a guarantee

CB2's failure was mechanical, not a tuning problem:

- Its pivot rule confirmed a swing only **after the move paused** — ~5–6 bars, structurally buying the second wind.
- The index had already moved +9.9 pts (median) before entry; median move after entry was **+0.0**.
- Neither leg saw the index, the flow, or the other leg.

This cohort enters on **flow at the level**, not on a confirmed pivot after the fact, and holds a single index-level view that both legs share, so CE and PE can never be open together. That addresses the diagnosed cause directly.

It is still only a hypothesis. Every threshold in §5 and §6 is a **starting point, not a tested truth** — the 30-minute time stop, the 10% spread rule, the 0.45–0.60 delta band. §8 decides.

---

## 10. Build order

| Step | What | Status |
|---|---|---|
| 1 | This spec | done 2026-09-16 |
| 2 | `python_modules/claude_cohort/rules.py` — pure functions, feature row in, decision out | pending |
| 3 | `python_modules/claude_cohort/backtest.py` — walk-forward, charge-aware, fills off recorded option ticks | done 2026-09-16 |
| 3b | `python_modules/claude_cohort/book.py` — per-contract option book cache (see §14) | done 2026-09-16 |
| 3c | 32 unit tests, all green | done 2026-09-16 |
| 4 | Run Setup A and Setup B independently, nifty50 then banknifty | blocked on the book cache build (~2.5 h) |
| 5 | Verdict against §8 | pending |
| 6 | **Gate** — only if passed: `live_runner.py` + cohort registration | blocked on 5 |
| 7 | Paper wiring + tracker | blocked on 6 |

## 11. Registration checklist (step 6 — do not start early)

External-runner pattern, so the file list is short:

- `server/portfolio/aiModeConfig.ts` — `CohortsConfig` field, `CohortKey` union, defaults, `sanitizeMode`, `cohortKey()`
- `server/discipline/routes.ts` — paper-pin + cohort→key map
- `client/src/lib/tradeThemes.ts` — colour + label
- `config/ai_mode_config.json` — `cohorts.claude` in all 6 blocks
- `scripts/cb2_tracker.py:22` — add `"claude"` to `COHORTS`

Not needed (external runner bypasses these): `engine.py`, `thresholds.py`, `control_client.py`, `seaControl.ts`.

## 12. Platform bugs that will corrupt any paper result

From the 2026-09-15 audit. These affect **every** cohort and are why the backtest, not the paper ledger, is the verdict:

1. Stale entry/exit price stamps, 4–8 min old
2. Feed drop on an open trade → RCA exits at the frozen price
3. `warm()` emits entries retroactively (engine cohorts only — not applicable to this one)
4. Replay silently drops data above ~2.5x and still reports COMPLETED
5. Replay executes on live `strike_lock_state.json`, not the signal
6. No sanity guard on fills — an exit price of 0 was accepted
7. Archive records carry wrong dates and merge trading days
8. `stop_buffer_pct` not scale-invariant — addressed for this cohort in §6

## 13. Related

- [12 — Market Status Screen](12_market_status_screen.md) — the human-facing view of the same data points
- [docs/COHORT_FINDINGS_2026-09-15.md](../COHORT_FINDINGS_2026-09-15.md) — the audit this spec is built on
- [04 — Signal Engine](04_signal_engine.md), [06 — Risk & Discipline](06_risk_discipline.md)


---

## 14 — Bugs found while building this (2026-09-16)

Both were mine, in this cohort's own code. Recorded because the second one is a
trap any future backtest over this data will fall into.

### 14.1 Flow-flip exit fired on noise — median hold of ONE minute

The exit rule "leave if flow flips against me" was implemented as a bare sign
change on `underlying_ofi_20`. Measured on nifty50 2026-09-11, that series
changes sign **762 times a day**, roughly every 30 seconds. Every trade was
knocked out almost immediately, against a design hold of 15 min – 2 h.

Fix: a flip now needs all three of direction, **magnitude** beyond the session's
own median `|ofi_50|` (causal and scale-free, because BANKNIFTY prints much
larger raw OFI than NIFTY), and **persistence** for `flow_flip_confirm_sec` —
plus a `min_hold_min` floor so a trade can breathe. Holds moved to a sensible
10–12 min median. Regression test:
`test_flow_flip_ignores_a_single_sign_change`.

### 14.2 FATAL — the ATM premium column splices across strikes

`opt_0_<leg>_*` in the feature parquet is the ATM **slot**, not a contract. On
nifty50 2026-09-11 the ATM strike changed **434 times in one day**, and each
change jumps the premium instantly — CE 90.40 -> 69.15 across a single row, 438
jumps over Rs 5 in the day. Holding a position while reading that column prices
the trade on a series that silently switches contract underneath it.

The error is **directional, not random**: when the underlying moves against a PE
trade the ATM rolls UP, and the higher strike's put costs more — so losing trades
print as wins.

**How it was caught:** the first full run reported **44 stop-loss exits netting
+Rs 3,391**. A stop cannot be profitable. Everything in that run was fiction and
it was discarded.

Fix: `book.py` extracts the true per-contract bid/ask series from
`data/raw/<date>/<inst>_option_ticks.ndjson.gz` (which carries `security_id`,
`strike` and `opt_type` per tick), caches one parquet per instrument-day at
1-second resolution, and every trade is priced on the contract it locked at
entry. Verified: the busiest PE contract shows **1** jump over Rs 5 in a day
versus 438 in the spliced column. After the fix, stop-outs lose money, as they
must.

Build cost ~2 min per instrument-day, ~4 MB per day, done once and cached.

**Applies to more than this cohort.** Any backtest, feature or model that reads
`opt_0_*` (or the `opt_m3..opt_p3` ladder) as a *time series* across a hold has
the same defect. Reading it at a single instant is fine — the splice only
corrupts a series. Worth auditing separately.


---

## 15 — Order flow / tape reading (Partha's 15-rule spec, 2026-09-17)

Code: `python_modules/claude_cohort/flow.py`, 27 tests in `tests/test_flow.py`.

### 15.1 What the feed can and cannot support

Rule 1 asks to classify **every** trade as bid-side or ask-side. That is not
possible on this feed, and claiming it would be dishonest.

Measured, nifty50 2026-09-11:

| | value |
|---|---|
| packets per minute | ~74 (median gap 0.81 s, p90 1.48 s) |
| contracts traded between packets | median 130 (2 lots), p90 780, max 12,935 |
| packets with no new volume | 65% |

Each packet carries the **last** print's price plus cumulative volume, so all
volume since the previous packet is attributed to that one print's side. Near
exact at the median; coarse in the tail, where a 199-lot block certainly traded
both ways.

**Survives this:** everything measured over Rule 15's 1–5 minute confirmation
windows — pressure, delta, cumulative delta, absorption, exhaustion, rejection.
**Does not:** per-trade granularity. We never claim it.

### 15.2 Where each rule lives

| Rule | Status | Where |
|---|---|---|
| 1 trade side | **already in TFA** | `underlying_trade_direction` (features/ofi.py), mirrored by `flow.classify` — tested identical |
| 2, 3 aggressive buy/sell | **already in TFA** | same field + volume delta |
| 4 price + quantity | built | `pressure().price_move` |
| 5, 6 absorption | **new** | `FlowState.absorption()` |
| 7 pressure vs response | built | `pressure().price_responded` |
| 8 delta | **already in TFA** | `underlying_ofi_5/20/50` IS delta; `pressure().delta` |
| 9 cumulative delta | **new** | `cumulative_delta()`, with divergence flag |
| 10 exhaustion | **new** | `exhaustion()` |
| 11, 12 depth / imbalance | options only in TFA | `depth_imbalance()` adds it for the underlying |
| 13 liquidity removal | **new** | `liquidity_removed()` |
| 14 rejection | **new** | `rejection()`, against levels built from the tape |
| 15 confirmation | design rule | windows 60 / 120 / 300 s; `snapshot()` returns all |

### 15.3 Rules that deliberately return no verdict

Partha's own wording, enforced by negative tests:

- Rule 8 — "Delta is an observation, not an entry signal by itself."
- Rule 12 — "Do not treat imbalance alone as a directional signal."
- Rule 7 — "Pressure without price movement needs further observation."

`pressure()` and `depth_imbalance()` return measurements only; the tests assert
no key named signal / direction / bias / verdict ever appears.

### 15.4 Everything is scale-free

Thresholds are multiples of the session's **own** distribution so far (median
trade size, median |ofi_50|), never absolute. Raw flow numbers are not
comparable between NIFTY and BANKNIFTY, and an absolute threshold silently
becomes a different rule on each instrument — the same defect as findings bug 8.

### 15.5 Calibration (nifty50 2026-09-11, 372 decision points)

| trigger | fires | read |
|---|---|---|
| cumulative-delta divergence | 36% of minutes | context only, far too common to trigger on |
| seller exhaustion | 20% | filter, not a trigger |
| buyer exhaustion | 17% | filter, not a trigger |
| buyer absorption | 3% | rare enough to be a trigger |
| seller absorption | 3% | rare enough to be a trigger |

### 15.6 Look-ahead bug found in this layer

The window helpers filtered only the **lower** time bound, so a snapshot "as of
T" included prints from after T, and `cumulative_delta` returned the
whole-session total instead of the value at T. Fixed in three places. Caught by
`test_everything_is_causal`, which replays the same instant from two different
feed lengths and requires an identical answer.

### 15.7 The rewritten setups

Originals kept as **controls** — the flow work has to beat them, not be assumed
better.

**A2 `break_with_pressure`** (rules 2,3,4,7,9,6,10) — a break is only bought when
aggressive volume is genuinely one-sided, price is *responding* to it (rule 7),
cumulative delta agrees (rule 9), the other side is not absorbing (5,6), and our
own side is not already exhausted (10).

**B2 `rejection_confirmed`** (rules 14,5,6,10) — rule 14 asks for confirmation by
the *subsequent* trades. A rejection counts only when the prints on the way back
are genuinely on the other side, the return is a real distance rather than a
tick, and something corroborates it: the level absorbing the push, or the push
exhausting.

### 15.8 Baseline the flow work must beat

nifty50, 78 days, real per-contract fills, fixed params, no sweep:

| setup | trades | net | months positive |
|---|---|---|---|
| `break_with_flow` (control) | 67 | **-Rs 6,250** | 1 of 6 |
| `failed_move` (control) | 89 | **-Rs 26,126** | 0 of 6 |

`failed_move` showed **+Rs 3,505** under the old spliced fill model and looked
like the promising one. On real contracts it loses Rs 26,126 — a Rs 29,600 swing,
and it is the worse of the two. This is why §14.2 mattered.
