# 15 — NIFTY 50 Detection & Decision Engine

**STATUS: SPEC — Partha 2026-09-23. No code. Supersedes the 15-rule order-flow
list as the target design; the 15 rules become a subset (see §Mapping).**

Scope: the **25 points are written for NIFTY 50**. **TCS2 itself now covers all
four instruments** (spec 14 D4 revised 2026-09-23), so the other three do not go
dark — but three of them lack pieces this spec assumes:

| | banknifty | crudeoil | naturalgas |
|---|---|---|---|
| S1 spot index | yes | **none — futures is the underlying** | **none** |
| S3 current-week chain | **none — monthly only** | **none** | **none** |
| India VIX | borrowed, not its own | **none** | **none** |

So for those three, **point 13 (expiry migration) has two expiries, not three**,
and for crude/gas every "S1 + S2" point is S2 alone. See spec 14 D11.
**Open:** whether the 25 points run for all four or stay nifty-only.

## 1. Objective

Continuously analyse NIFTY 50 evidence to make better intraday decisions with
**fewer bad or trap entries**. The system must:

- detect direction, strength and momentum
- measure actual buyer/seller behaviour from tradable instruments
- track option positioning and strike/expiry movement
- detect support, resistance, breakout, pullback, reversal
- detect traps, absorption, exhaustion, unusual large-player footprints
- select the option strike **only after direction is established**
- determine entry timing and confirmation
- monitor an open trade for continuation, weakening or exit evidence
- produce **evidence scores and confidence, not blind binary signals**
- analyse **1m, 2m, 3m, 5m, 10m, 15m, 30m**

## 2. Data sources

| | source | status today |
|---|---|---|
| **S1** | NIFTY 50 underlying (index) ticks — price, LTP, timestamp | recorded ✅ **but see §5.1 — no volume** |
| **S2** | NIFTY current-month **futures** ticks — traded buy/sell, price, volume, OI, depth | recorded ✅ |
| **S3** | **current-week** option ticks — CE/PE price, volume, OI, depth, trades | recorded ✅ |
| **S4** | **current-month** option ticks | **NOT recorded** ❌ |
| **S5** | **next-month** option ticks | **NOT recorded** ❌ |

The system builds its **own option-chain state** from S3–S5.

## 3. The 25 analysis points

| # | point | sources | output |
|---|---|---|---|
| 1 | Market direction + strength — HH/HL, LL/LH, persistence | S1+S2 | UP / DOWN / SIDEWAYS + 0–100 |
| 2 | Momentum — speed, acceleration, persistence | S1+S2 | 0–100 |
| 3 | Buyer activity — trades at/near ask, qty, frequency, price response | S2+S3/S4/S5 | 0–100 |
| 4 | Seller / writer activity — bid executions, option price, OI, persistence | S2+S3/S4/S5 | 0–100 |
| 5 | Long build-up — option price ↑ + OI ↑ | S3/S4/S5 | per strike, then aggregated |
| 6 | Short build-up — option price ↓ + OI ↑ | S3/S4/S5 | strength |
| 7 | Long unwinding — option price ↓ + OI ↓ | S3/S4/S5 | strength |
| 8 | Short covering — option price ↑ + OI ↓ | S3/S4/S5 | strength |
| 9 | Support zones — repeated tests, rejection, absorption, holding | S1+S2 | zone + strength |
| 10 | Resistance zones — tests, rejection, failure to continue | S1+S2 | zone + strength |
| 11 | OI build-up / unwinding — ΔOI across strikes | S3/S4/S5 | OI map |
| 12 | Strike migration — OI/volume/price moving between strikes | S3/S4/S5 | candidates + strength |
| 13 | Expiry migration — across week / month / next month | S3/S4/S5 | candidates |
| 14 | Volatility state — range expansion / contraction | S1+S2+options | EXPANSION / CONTRACTION / NEUTRAL |
| 15 | Trend persistence / pullback | S1+S2 | continuation / weakening / reversal |
| 16 | Breakout readiness — evidence **before** the breakout | S1+S2+options | Not ready / Building / Ready + 0–100 |
| 17 | False breakout filter — does price sustain beyond the level | S1+S2+options | Confirmed / Suspect / False |
| 18 | Pullback strength — vs the prior directional move | S1+S2+options | Weak / Normal / Strong |
| 19 | Entry timing quality — alignment across windows | all | Poor / Acceptable / Strong |
| 20 | Entry confirmation — post-signal behaviour | all | Not confirmed / Confirming / Confirmed |
| 21 | Absorption — aggressive activity without expected continuation | S2+options | buyer/seller + strength |
| 22 | Exhaustion — activity weakening while price stops progressing | S2+options | buyer/seller + strength |
| 23 | Liquidity / liquidity removal — spread, displayed qty, level changes | S2+options | quality + removal events |
| 24 | Big-player footprint / trap — unusual size, bursts, absorption, OI shifts, migration | all | 0–100. **Never claim participant identity** |
| 25 | Trade decision context — combine everything | derived | TRADE / NO TRADE + direction + strike + confidence + reason |

## 4. Implementation principle

```
Ticks → derived evidence → 25 findings → combined market state
      → strike selection → entry confirmation → trade
      → continuous monitoring → exit evidence
```

Market understanding stays **separate from trade execution**; the system never
jumps from a tick straight to BUY/SELL.

---

## 5. Reality check (added by Claude — measured facts, not changes to the spec)

### 5.1 S1 has no volume — it cannot carry "market structure"
The NIFTY index (security id 13) is sent by Dhan in **ticker mode only**: price
and timestamp, nothing else. No volume, no OI, no bid/ask, no depth. Verified
2026-09-17.

Points 1, 2, 9, 10, 15 list "S1 + S2" for volume and structure. **All volume and
structure must come from S2 (futures).** S1's role is price, strikes and
settlement — options settle on the index and strikes are counted from it.

Also measured (2026-09-18): the futures trade **20–33 points above spot** near
expiry, up to ~88 earlier in the cycle, and **weekly options price around spot,
not futures**. So levels quoted to a human should be index levels; flow must be
futures.

### 5.2 S4 and S5 do not exist yet
TFA subscribes **only the nearest expiry**. For NIFTY that is the current week,
so:
- **S3** available for all 81 recorded days
- **S4** (current month) missing whenever a weekly is nearer — which is most days
- **S5** (next month) never recorded

Nothing in points 5–8, 11, 12, **13** can be computed historically for S4/S5.
Point 13 (expiry migration) needs all three and cannot be built or backtested
until TCS2 records them. This is TCS2 job 5.

Capacity is not the problem: 3 chains × ~472 legs ≈ 1,400 instruments, well
inside Dhan's per-connection limit.

### 5.3 Points 5–8 need an explicit options definition
The price+OI table (long build-up, short build-up, long unwinding, short
covering) is the standard reading for **futures**, where one instrument has one
direction. On an **option strike** it is ambiguous: a call premium rising with
rising OI can be new buyers *or* writers selling into demand — the same two rows
of the table describe opposite participants.

It has to be defined per leg before implementation, e.g.:
- CE price ↑ + CE OI ↑ → new call longs (bullish) **or** call writing (bearish)
- resolved by **who was aggressive** — the trade side on each print

We already have the trade side per option tick, so this is resolvable — but it
must be written down, not assumed.

**Three options, put to Partha 2026-09-23 — DEFERRED, decide later:**
- **A. The standard convention.** Infer from price direction: call price up +
  OI up = call buying; call price down + OI up = call writing. Matches every
  broker screen and website, so the numbers agree with what is seen elsewhere.
- **B. Use the actual aggressor.** We record, per trade, whether the buyer
  crossed to the offer or the seller hit the bid. No inference needed.
- **C. Both.**
- Claude's recommendation: **B with A alongside** — B is strictly better
  information, and keeping A means a disagreement with other tools reads as a
  disagreement rather than a bug. Those disagreements may be the interesting
  moments: price implying buying while the actual aggressor was the writer.

### 5.4 Scores 0–100 must describe, not predict — until measured
Measured on 77 days and 26,671 decision points (`claude_cohort/study.py`): **not
one** of the existing 15 order-flow rules beat the base rate on both direction
and reward-to-risk, at any horizon. Best was +2.6 points (inside noise); "pressure
with price responding" was the **worst** at −4.4.

So a score of 80 must mean *"this condition is strongly present"*, never
*"80% chance price rises"*, until each point has been measured the same way.

### 5.5 Point 25 must clear the standing validation bar
Rules-based directional entry has now failed three independent measurements
(spec 13 §15.8, §15.9, §16). Before point 25 sizes any capital it must clear the
standing bar: ≥60 out-of-sample days, majority of months positive judged
independently, survives removing the top 3 trades, no look-ahead, and not
explained by market direction.

### 5.6 What already exists
| spec point | existing code |
|---|---|
| 3, 4, 21, 22, 23 | `claude_cohort/flow.py` — buyer/seller activity, absorption, exhaustion, depth, liquidity removal |
| 9, 10, 17 (partly) | `flow.py` levels + rejection — **but see T187: session high/low rejection can never fire** |
| 14 (partly) | TFA features: volatility compression, breakout readiness |
| 1, 2, 15 (partly) | TFA features: ADX, momentum, pivot structure |
| display of all | `market_screen/` — 2×2 screen, 7 windows |

**Windows:** the screen has 1m, 2m, 5m, 10m, 15m, 30m. This spec adds **3m**.

**T187 applies:** six logic problems in the current rule implementations —
including one confirmed bug — should be fixed before these points are built on
top of them.

## 5.7 How the 25 map onto a screen (worked out 2026-09-23)

**19 points fit the existing table shape** — one row, a reading per window:
1, 2, 3, 4, 5-8 (as totals), 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24.

**6 points cannot be a row of arrows** — they produce something else:

| point | produces | needs |
|---|---|---|
| 9, 10 support / resistance | price levels + strength | a list of levels |
| 11 OI build-up / unwinding | a number at every strike | a strike ladder |
| 12 strike migration | "23,300 -> 23,400" | a list of moves |
| 13 expiry migration | "week -> month" | a small panel |
| 25 trade decision | TRADE/NO TRADE + direction + strike + confidence + reason | a verdict box |

Points 5-8 are both: a total on a row, plus per-strike detail on the ladder.

**Seven things on today's screen are NOT in the 25 and must be preserved:**
- **trade side, price+quantity, delta, cumulative delta** — the raw measurements
  everything else is built from. The spec uses them as inputs to points 3/4 but
  never displays them, so "buyer activity: 72" would have nothing behind it.
- **the "now" column** — what the current tick just did
- **the measured-edge column** — each rule's track record, which is what stops a
  green light looking more confident than the evidence
- **the stale warning** — missing on 2026-09-18, when the screen showed 10:00
  data for 2.5 hours

**Layout.** NIFTY-only (D4) frees three quarters of the 2x2 grid:

```
+-----------------------------+--------------------------+
|  NIFTY  price . levels      |  DECISION                |
|  19 rows x 8 windows        |  TRADE / NO TRADE        |
|  (now 1m 2m 3m 5m 10m 15m   |  direction, strike,      |
|   30m + edge + meaning)     |  confidence, reason      |
|                             +--------------------------+
|                             |  OPTION CHAIN            |
|                             |  strike ladder: OI,      |
|                             |  build-up, walls         |
+-----------------------------+--------------------------+
|  SUPPORT / RESISTANCE       |  MIGRATION               |
|  levels with strength       |  strike -> strike        |
|                             |  week -> month           |
+-----------------------------+--------------------------+
```

## 6. Open questions
- Points 5–8 leg definition (§5.3)
- What "strength 0–100" is measured against for each point
- Which points gate a trade versus inform it

## 7. Related
- [14 — TCS2](14_tcs2.md) — supplies S1–S5; this spec fixes its expiry scope
- [12 — Market Status Screen](12_market_status_screen.md) — the display surface
- [13 — Claude cohort](13_claude_cohort.md) §15–16 — the measurements cited above
- T187 — screen logic problems, parked
