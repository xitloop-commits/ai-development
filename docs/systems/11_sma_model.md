# 11 — SMA-Model (learned SMA5 leg-riding model)

**STATUS: SPEC DRAFT — brainstormed & decided 2026-08-07, awaiting Partha's line-by-line review. NO CODE EXISTS YET. Nothing in this spec touches the existing 84-head model, its trainer, or the live pointers.**

## 1. The idea in plain words

On the 1-minute NIFTY chart, price rides one side of the SMA5 line for a leg, crosses it, then rides the other side. The rule-based `sma5` cohort (T152) already trades those crossings mechanically — and loses money on the bounces: crossings that snap right back.

The **sma-model** replaces the mechanical rule with a learned judge. It watches the same SMA5 line, but at each 1-minute candle close it decides for itself, using everything hiding in the raw tick recordings:

- **When flat:** "a candle closed above (or below) the line — is this a real leg worth boarding, or a bounce?" → enter CALL / enter PUT / stay out.
- **When in a trade:** candles on our side of the line = hold, no decision needed. A candle closing on the *wrong* side = "is this a shake-out that will snap back, or is the leg over?" → hold / exit.

No hand-written thresholds anywhere — flat-line avoidance, bounce detection, shake-out detection are all learned from history.

## 2. Locked decisions (brainstorm 2026-08-07)

| # | Decision | Choice |
|---|---|---|
| D1 | Existing live model | Untouched. sma-model is brand-new and fully separate. |
| D2 | Instrument | nifty50 only (first version). |
| D3 | Chart | 1-minute **Heikin-Ashi** candles + **SMA5 on HA closes**, built from **futures ticks** (see §3). |
| D4 | Directions | Both: CALL on up-legs, PUT on down-legs. Symmetric. |
| D5 | Decision cadence | Once per 1-minute candle close. Right-side candles in a trade = automatic hold. |
| D6 | Leg size | Every wiggle counts, even 3–6 pt mini-legs. Only true no-go: flat SMA5 — **learned**, not a rule. |
| D7 | Rules vs learning | **No hand-written rules.** All evidence (slope, ticks, flow) goes in as features; the model weighs them. |
| D8 | Grading (labels) | **Rupees after real costs**: pretend-trade each historical decision through recorded option bid/ask, subtract real charges. Profit → GOOD. |
| D9 | Vehicle | **ATM strike, current weekly expiry** — same rule for training and live. |
| D10 | Position rule | One trade at a time, 1 lot, exit before enter (no same-candle reversal in v1). |
| D11 | Promotion | Three gates: (1) full-history backtest positive ₹ after costs → (2) ~2 weeks paper matching backtest behaviour → (3) only then discuss live with 1 lot. |
| D12 | Indicators | Start lean (see §5). Add more later only if needed (Partha 2026-08-07: "if need we add it later"). |
| D13 | Name | **sma-model** (chat/UI/docs). No version codes in chat per Rule 1. |

## 3. The chart: futures ticks, not spot, not premiums

**Finding (2026-08-07):** our tick-by-tick "underlying" recording is the **near-month NIFTY futures** (TFA resolves the FUTIDX contract at startup; e.g. Aug 6 = id 58072), not the spot index shown on TradingView. Spot appears only in chain snapshots (~every 22 s, `spotPrice`). On Aug 6 the futures ran 71–122 pts above spot (avg ~88).

**Decision:** build the model's HA candles + SMA5 from **futures ticks**, because:
- We have them every second for all recorded days; spot we only have every ~22 s.
- Futures make the same legs at the same times as spot (glued by arbitrage), and carry evidence spot cannot have: volume, order book, buyer/seller totals, OI.
- The futures–spot gap itself breathes intraday and becomes a feature (§5).

**Why not ATM option premiums as the chart** (asked & agreed 2026-08-07): premiums decay all day by design (weekly theta), swell/crush with IV while nifty stands still, the "current ATM" contract changes as spot walks (spliced chart), and moves are half-size with relatively wider spreads. Premiums are **evidence** (§5), not the compass.

**HA caution (backtest-trap guard):** HA candles are synthetic averages — nobody trades HA prices. The model *reads* HA; all money math (entry fills, exit fills, labels) uses **real** tick prices: option ask at entry, option bid at exit.

## 4. Decision engine

State machine per instrument: `FLAT | IN_CALL | IN_PUT`, evaluated once per 1-minute HA candle close.

| State | Candle vs SMA5 | Question to model | Actions |
|---|---|---|---|
| FLAT | closes above line | entry head: real up-leg or bounce? | ENTER_CALL / stay flat |
| FLAT | closes below line | entry head: real down-leg or bounce? | ENTER_PUT / stay flat |
| IN_CALL | closes above line | none — automatic | HOLD |
| IN_CALL | closes below line | exit head: shake-out or reversal? | HOLD / EXIT |
| IN_PUT | mirror of IN_CALL | mirror | mirror |

- Model outputs a confidence (0–1); the acting threshold is tuned on the backtest (Gate 1), not hand-picked.
- After an EXIT, the engine is FLAT; the next candle close may trigger a fresh entry question (possibly the opposite side) — that is the D10 "exit before enter" rule.
- v2 candidates (out of scope now): same-candle flip, multi-lot scaling, intra-candle exits.

## 5. Inputs (features) — start lean

All computed at candle close, per D7 as evidence only:

1. **Line & candle anatomy** — SMA5 slope + distance of price from line; HA candle body/wick shape, streak length on current side.
2. **Recent-leg memory** — length/size of the last few legs, time since last flip (teaches trending-day vs whipsaw-day rhythm).
3. **VWAP distance** and **RSI (1m)** — the only two classic indicators in v1 (D12).
4. **Futures microstructure** — order-book imbalance (5 levels), bid/ask pressure, volume burst, buyer-vs-seller totals, tick velocity inside the candle.
5. **Option flow at ATM ± nearby strikes** — premium velocity, aggressive buying/selling on CE vs PE side, option order-book thinning.
6. **Chain snapshots** — OI + OI-change tilt around ATM, IV level/change.
7. **Context** — India VIX level/change, futures–spot gap and its drift, time of day.

After first training, run the existing SHAP-report tooling to see what the model actually uses; prune deadweight and only then consider additions (D12).

## 6. Labels & grading (D8)

Every historical candle-close decision point becomes a training example, graded in **rupees after costs**:

- **Entry examples:** simulate ENTER (buy 1 lot ATM weekly CE/PE at recorded **ask**), ride per the SMA5 hold rule to the leg's end (exit-cross close), sell at recorded **bid**, subtract real charges → net ₹ label.
- **Exit examples** (wrong-side candle while in a trade): compare "exit now at bid" vs "hold to actual leg end" through recorded prices → label = which choice made more ₹.
- **Charges must be real** — the ₹125 placeholder from the old sim harness is NOT acceptable here: mini-legs (3–6 pts ≈ ₹100–200 premium move per lot) live or die on exact charge math. Use the production Charges module rates (System 06), verified against a real Dhan contract note before Gate 1 is trusted.
- Known risk to verify in Gate 1: the smallest legs may be structurally breakeven after charges; the rupee labels will teach the model to skip them if so.

## 7. Training plan

- Data: all recorded nifty50 sessions (2026-04-21 → today, 57+ days, growing daily). Raw `.ndjson.gz` only — this model does NOT consume the v8 feature parquets; it has its own lean candle-close feature builder (new, standalone).
- Validation: walk-forward by day (train on earlier days, validate on later days), same discipline as the existing trainer but a **separate, new pipeline** — it must not import from or write to the 84-head MTA paths, `models/<inst>/LATEST`, or `LATEST_HEADS.json`.
- Artifacts land under their own root (e.g. `models/sma_model/nifty50/<timestamp>/`) — final layout decided at implementation planning, but never inside the existing per-instrument model folders.
- Likely architecture: gradient-boosted trees (LightGBM) over the candle-close feature vector — same family we already operate — but this is an implementation choice, not a spec commitment.

## 8. Promotion ladder (D11)

1. **Gate 1 — backtest:** replay all recorded days; demand positive total ₹ after real charges, and per-leg stats Partha reviews (win rate, avg ₹/trade, worst day).
2. **Gate 2 — paper:** run as a new SEA cohort in paper for ~2 weeks; demand behaviour roughly matching backtest (trade count, win rate, ₹/trade in range).
3. **Gate 3 — live discussion:** only after Gates 1–2, revisit with 1 lot. No auto-promotion; Partha decides.

## 9. Explicitly out of scope / untouched

- The 84-head scalp/trend/swing model, its trainer, calibration, LATEST pointers, Saturday retrain — all untouched.
- The rule-based `sma5` cohort (T152) keeps running as-is; sma-model is its learned sibling, not a replacement (yet).
- TFA recording pipeline untouched. (Optional future addition, separate task: subscribe spot-index ticks like we do VIX, so future models can also see spot every second. Not required for v1.)
- banknifty/crudeoil/naturalgas versions — after nifty proves out.

## 10. Open items (to settle at implementation planning, after spec sign-off)

- Exact charge formula verification against a real Dhan contract note.
- Confidence-threshold tuning method on Gate 1 output.
- Warm-up handling (first ~5 candles of the day have no SMA5; 09:15 open volatility policy).
- Expiry-day behaviour (Tue weekly expiry: trade the expiring contract or next week's?).
- Where the live decision engine runs (inside SEA as a cohort vs standalone process).

## 11. Cross-refs

- [01 Data Ingestion](01_data_ingestion.md) — the raw `.ndjson.gz` recordings this model trains on.
- [04 Signal Engine](04_signal_engine.md) — T152 rule-based `sma5` cohort (the mechanical predecessor).
- [06 Risk & Discipline](06_risk_discipline.md) — Charges module used for rupee grading.
- [docs/PROJECT_TODO.md](../PROJECT_TODO.md) — T154 tracks this work.
