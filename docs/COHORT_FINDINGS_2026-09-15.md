# Cohort findings — CB2, candleblue, blast (2026-09-05 → 2026-09-15)

Measured against raw tick recordings in `data/raw/<date>/`, **not** against the
live paper ledger (see "Platform bugs" — the ledger is not trustworthy yet).

Method: recorded ticks → the real detector class → outcomes priced off the tape.
No server, no executor, no replay.

---

## 1. CB2 (candleblue v2) — NO EDGE. Recommend OFF.

Offline backtest, NIFTY50, **236 trades over 72 days** (2026-04-21 → 2026-09-04),
tape prices, CB2's own exits, no platform bugs involved:

| metric | value |
|---|---|
| win rate | 38% |
| avg win / avg loss | **1.18** (needs >1.63 at that win rate) |
| gross pts/trade | **-3.199** (breakeven +0.53) |
| net | **-Rs 571,666** |
| months negative | **4 of 6** (June -404k, July -340k) |

Other instruments, same method:
- NATURALGAS: 97 trades / 17 dates → **-0.052 pts/trade gross** (negative *before* costs)
- BANKNIFTY: 54 trades / 14 dates → -1.645 pts/trade, -Rs 56,271

### Why it cannot work (mechanism, not tuning)

- Its pivot rule `b > a and c <= b` only confirms a swing **after the move pauses**.
  It needs ~5-6 bars (25-30 min) and at least two stutters before it can fire.
  It structurally buys the second wind, never the start.
- Measured: index had **already moved +9.9 pts (median)** in the 15 min before entry;
  median index move in the 15 min *after* entry was **+0.0**. Continuation 48/52.
- Winners had +10.9 pts of pre-entry move, losers +8.9 — **statistically identical**.
  The entry signal cannot distinguish continuation from reversal.
- On **20 of 72 days it held CE and PE simultaneously** (27 overlaps) — each leg
  tracks its own premium; neither knows the other, or the index, exists.

### Things tried that did NOT rescue it (all failed out-of-sample)

- entry-quality filters (bar >=10 ticks, close 50-85%) — **inverted** OOS
- index-trend alignment — the 70%-win version used **look-ahead**; causal version -Rs 383,155
- tick-aware stop / range-position ceiling — no effect on the core problem

Live record for reference: 48 trades, 29% win, -Rs 102,230.

---

## 2. candleblue v1 — UNTESTED offline, worse live record. Recommend OFF pending test.

Live: **294 trades, 33% win, -Rs 247,753.** avg win Rs 8,608 / avg loss Rs 5,425
(ratio 1.59 → needs **38.6%** win rate to break even; has 33%).

Same core logic as CB2 — identical legs, pivots, HH+HL entry, lower-high exit.
Only differences: 2-min candles (vs 5) and no range-position gate. Expect the
same defect. **Not yet run through the offline harness.**

---

## 3. blast_model — PROMISING. Keep the paper gate running.

Qualitatively different from the above: **positive gross edge and a positive
median trade.** The others were broken at the signal level.

b10w10 backtest, 52 OOS days, PE-only (matches live `SIDE_FILTER`):

| metric | value |
|---|---|
| trades / win | 96 / **52%** |
| gross / charges | +Rs 14,534 / Rs 5,590 |
| net | **+Rs 8,944** (+Rs 93/trade) |
| median trade | **+Rs 74** (CB2's was -Rs 2,358) |
| months profitable | 3 of 4 |

Label sweep (`label_sweep.py`, judge = last 15 days, untouched by tuning):

- **b8w5 is rank 1**: JUDGE +Rs 12,149, 62 trades, 47% win, worst day +Rs 83
- Its winning combo `e0.60 x0.50 h20 side=PE` **is exactly the live runner config**
  (`live_runner.py`: ENTER_FLOOR 0.60, EXIT_FLOOR 0.50, MAX_HOLD_MIN 20, SIDE_FILTER PE)
- **7 of 9 label variants positive** on judge → a plateau, not a lucky spike
- `side=PE` wins in **8 of 9** variants → the CE/PE asymmetry is consistent

### Caveats — do not size up yet

1. The judge window (2026-08-11 → 09-07) **fell -676 pts (-2.7%), 10 of 14 days down.**
   A puts-only strategy is flattered there. The +Rs 12,149 is not clean.
2. Concentration: removing the **top 5 of 96** trades takes b10w10 PE to -Rs 63.
3. Thin where it matters: August 3 trades, September 3 trades.
4. `side=PE` was chosen after seeing CE lose (-Rs 10,541) — in-sample selection.
5. 432 combinations searched — some will look good by chance.

### Evidence it is NOT just market beta (this check mattered and passed)

- NIFTY was flat over the wider window (+150 pts, +0.6%, 32 up / 26 down days)
- PE was profitable in **June and July, when NIFTY rose**
- Split by day direction: **UP days +Rs 53/trade, DOWN days +Rs 126/trade** — positive in both

### Why it trades only 0-2x/day (by design, not broken)

PUTs only; needs `p_enter >= 0.60` while the median score is 0.03-0.16; one
position at a time; and the label itself (+8% in 5 min) is a rare event. On
**2 of 6 live days the score never crossed 0.60 at all**. At ~0.7 trades/day,
60 live trades is about 4.5 months — **validate offline, not by waiting.**

---

## Platform bugs (independent of any strategy — fix regardless)

Found while auditing CB2 trades against the tape. **These corrupt every
measurement the platform produces.**

1. **Stale entry/exit price stamps (4-8 min old).** 10 of 40 CB2 losses mis-priced,
   Rs 63,007 of error. The signal carried the correct price; the executor wrote an old one.
2. **Feed drops on an open trade, then RCA exits at the frozen price.**
   `server/risk-control/index.ts` stale-exit keys off `trade.lastTickAt` and closes
   at the frozen `ltp`. One trade booked **-Rs 1,949 that was really +Rs 6,800**
   (tape 1036.20 vs recorded 1007.00) — the recorder had 2,935 ticks in that window;
   only the engine's view froze. Open trades likely do not hold their own
   subscription ref, so the ATM window's unsubscribe drops them.
3. **`warm()` emits entries retroactively.** On relock, `candleblue2_signal.warm()`
   returns LONG if the replay ends in-position → entry fired **8.5 min late, 15.6 pts worse**.
4. **Replay silently drops data it cannot keep up with, and still reports COMPLETED.**
   At 60x only **34 of 797** chain snapshots (4.3%) reached the pipeline; the run
   record showed `tradeCount: 0` with no warning. Sustainable rate measured ~**2.5x**.
5. **Replay executes on the live `strike_lock_state.json`, not the signal.**
   Signalled 23850 CE @210.70; actually traded 25700 CE @0.50 (expiry 2026-09-08).
6. **No sanity guard on fills.** An exit price of **0** was accepted → -Rs 828,730
   on Rs 100,000 opening capital, recorded without complaint.
7. **Archive records carry wrong dates and merge trading days.** Record labelled
   `2026-08-31` holds only 09-01 trades; `2026-09-01` holds **09-02 AND 09-03**.
   Anything reporting by that `date` field attributes trades to the wrong day.
8. **`stop_buffer_pct` is not scale-invariant.** The same 0.2% is **36 ticks on
   BANKNIFTY and 0.49-0.95 ticks on NATURALGAS** (below one tick → the stop sits
   *on* the swing low and any wick takes it). Fix: `max(pct, N ticks)`.

---

## Method lessons (these caused repeated false positives)

Every one of these produced a result that looked excellent and then died:

1. **Short windows lie.** August alone showed CB2 at **+Rs 179,742**; the full 72 days
   showed **-Rs 571,666**. August was 1 of only 2 positive months in 6.
2. **In-sample filter selection inverts.** Filters fitted on 58 trades (bar >=10 ticks,
   close 50-85%) were *worse* than the trades they excluded when applied to 97 fresh
   ones. The band that looked best in-sample (close 50-70%) was the **worst** OOS.
3. **Look-ahead hides in "which trend was this in".** Classifying an entry by the leg
   containing it uses that leg's *end*, which is unknown at entry. That fabricated a
   70%-win / +Rs 432,594 effect. The causal version: -Rs 383,155.
4. **Always run the concentration check.** Report net excluding the top 1/3/5 trades.
   CB2's August result and blast's b10w10 both hinge on a handful.

### Standing validation bar before any cohort gets capital

- >= 60 trading days, out-of-sample (walk-forward; the model sees only prior days)
- profitable in the **majority of months judged independently**
- survives **removing the top 3 trades**
- **no look-ahead** — every input must be knowable at decision time
- check whether the result is explained by **market direction** over the window

---

## Reusable tooling

- `python_modules/blast_model/backtest.py` — charge-aware, walk-forward, verdict in rupees.
  `simulate()` accepts a `side_filter` that the CLI does not expose.
- `python_modules/blast_model/label_sweep.py` — label grid + tune/judge protocol.
  Judges on the **last** N days; for a direction-neutral read, judge per month instead.
- CB2/candleblue offline harness (scratch, 2026-09-05): derive the locked legs from the
  first chain snapshot (`ATM -/+ offset`, validated 3/3 against live locks), extract those
  contracts from `<inst>_option_ticks.ndjson.gz`, and feed `CandleBlue2Leg` directly.
  Recordings can be truncated or corrupt — catch `EOFError` **and** `zlib.error`.
- Windows note: printing the rupee sign crashes under cp1252. Use `PYTHONIOENCODING=utf-8`.
