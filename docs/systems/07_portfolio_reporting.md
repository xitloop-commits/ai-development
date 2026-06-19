# 07 — Portfolio & Reporting

Single source of truth for **PortfolioAgent (PA)** — the only thing that owns position state — plus the **Journal** audit log and the **Head-to-Head** ai-vs-my comparator. Together they are how Lubas knows what's open, what's closed, what it cost, and which approach is winning.

## 1. Purpose & Scope

**In scope:**
- PortfolioAgent — sole owner of position state across the 6 channels; trade-open / trade-close / position-list APIs; capital-pool model (75 / 25 trading vs reserve); 250-day-compounding day index.
- Daily P&L push to [06 Risk & Discipline](06_risk_discipline.md) Module 8 (cap-check trigger).
- Position-state queries used by SEA (`has_open_position`), RCA (monitoring), UI (TradingDesk).
- Trade-close audit trail (`exitReason`, `exitTriggeredBy`, charges, journal entry id).
- Journal write-through audit log — operator notes + cohort tag editor + Module 6 unjournaled-trade gate.
- Head-to-Head reporting — paired ai-paper vs ai-live (and ai-live vs my-live) divergence dashboard.

**Out of scope:**
- Order placement → [05 Execution](05_execution.md). PA is single-writer at the fill boundary; it never calls the broker.
- Cap evaluation / MUST_EXIT → [06 Risk & Discipline](06_risk_discipline.md). PA pushes P&L; DA decides if a cap is breached.
- Signal generation → [04 Signal Engine](04_signal_engine.md).
- UI rendering → [08 UI Desktop](08_ui_desktop.md). PA exposes tRPC + REST; UI consumes.

## 2. Architecture at a glance

```
       05 Execution (TEA)
              │
              ▼ TEA.recordFill() / TEA.recordTradeClosed()
       PortfolioAgent
       ┌─────────────────────────────────────────┐
       │  Position state (MongoDB collection):   │
       │    per-channel × per-instrument         │
       │    {qty, avg_entry, P&L, exitReason}    │
       │                                         │
       │  Capital pools (75 trade / 25 reserve)  │
       │  Day index (250-day compounding curve)  │
       │  Daily P&L rollup (realized + unrealized)│
       │  Quarterly projection (forward view)    │
       │  Broker-desync state (B4 safety)        │
       └─────────────────────────────────────────┘
              │
              ├─▶ daily P&L push ─────▶ 06 DA Module 8 (cap checks)
              │
              ├─▶ getOpenPositions() ─▶ 04 SEA (position-veto), 06 RCA (monitor scope)
              │
              ├─▶ tickHandler ────────▶ unrealized-P&L update on each price tick
              │
              ├─▶ Journal writer ─────▶ Journal audit log (operator notes + cohort tags)
              │                          │
              │                          ▼
              │                       06 DA Module 6 unjournaled-trade gate
              │
              └─▶ Head-to-Head pairing ▶ ai-paper × ai-live, ai-live × my-live
                                          │
                                          ▼
                                       08 UI dashboard
```

## 3. Position state

Stored in MongoDB `position_states` collection, one document per `(channel, instrument)` pair. The `state.ts` schema is the source of truth.

| Field | Purpose |
|---|---|
| `channel` | one of `ai-live`, `ai-paper`, `my-live`, `my-paper`, `testing-live` |
| `instrument` | nifty50 / banknifty / crudeoil / naturalgas |
| `openLots`, `avgEntryPrice` | running quantity + cost basis |
| `realizedPnlToday`, `unrealizedPnl` | P&L split |
| `dailyRealizedPnl`, `dailyRealizedPnlPercent` | rollups DA reads at 15:15 / 23:15 IST |
| `lastFillTs`, `entries[]`, `exits[]` | per-leg audit |
| `desyncInfo` | broker-desync state machine (B4 safety — flags `EXIT_FAILED` / `MODIFY_FAILED`) |
| `cohort` (planned) | scalp / trend / swing / multi-day-swing tag from T33 |

Position state is **always read from PA**. SEA's gate calls `PortfolioAgent.has_open_position(instrument, side)` before suggesting a new entry; RCA's monitoring loop scopes itself to `PortfolioAgent.getOpenPositions(channel)`.

## 4. The six channels + capital pools

The 6-channel model matches [05 Execution](05_execution.md). PA carries an **independent capital pool per channel**:

- 75 % trading capital + 25 % reserve (`compounding.ts:injectCapital()`).
- Trading capital compounds along a 250-day day-index curve; reserve is a clawback buffer.
- A workspace can be re-funded; each `injectCapital` call records into the channel's capital ledger.

Independent pools mean an `ai-live` drawdown can't bleed `my-live` capital. The 75 / 25 split is the same locked policy across all channels — single-source-of-truth, not per-channel tunable today.

## 5. Day index — 250-day compounding

`compounding.ts` owns the day-index lifecycle:

- `checkDayCompletion()` — at IST midnight, finalise yesterday's day index.
- `completeDayIndex()` — write the closing capital, advance the curve index.
- `processClawback()` — if today closed below the trading-capital floor, pull from reserve to top up.
- `calculateQuarterlyProjection()` — forward-looking estimate from the current trajectory; surfaced in the UI dashboard but not used for decisions.

The 250-day curve is the long-horizon promotion metric, not a daily gate. Daily caps live in [06 Risk & Discipline](06_risk_discipline.md) Module 8.

## 6. Trade lifecycle + audit

When TEA closes a position (manual exit, SL/TP hit, RCA trigger, DISCIPLINE_EXIT):

```
TEA.recordTradeClosed(trade) ──▶ PA.recordTradeClosed()
                                      │
                                      ├─ update position state
                                      ├─ calculate charges (calculateTradeCharges)
                                      ├─ write trade audit (exitReason, exitTriggeredBy, charges)
                                      ├─ recompute dailyRealizedPnl + dailyRealizedPnlPercent
                                      ├─ push to DA Module 8 → POST /api/discipline/recordTradeOutcome
                                      └─ write Journal entry (planned — T46)
```

Every closed trade carries:
- `exitReason` ∈ {TP, SL, TSL, TIME, MOMENTUM_FLIP, MUST_EXIT, MANUAL, DISCONNECT_HALT}
- `exitTriggeredBy` ∈ {RCA, DISCIPLINE, USER, BROKER_AUTO}
- `charges` — full breakdown (brokerage + STT + exchange + GST + slippage)
- `cohort` (planned, T33) — originating signal layer

### 6.1 Trailing stop — gated activation + breakeven floor (2026-06-12)

Paper auto-exits run in `tickHandler.updateChannel`. Trailing is a workspace-wide
switch (broker config), and it does **not** trail from entry. The model:

1. **Gate** — price must clear breakeven (entry ± round-trip charges/unit) by
   `trailingActivationGatePercent`.
2. **Hold** — that gate must hold continuously for `trailingActivationHoldSeconds`
   before the stop arms (per-trade arm/activation state lives in tickHandler
   instance Maps, not the day record).
3. **Trail** — once armed, the stop trails the peak by `trailingStopPercent` and
   is **floored at breakeven**, so a pullback can never give back charges.

`breakevenPrice` is frozen on the trade at placement (`PA.appendTrade` →
`computeBreakevenPrice`, same charges engine as the close path) and read by both
the server (floor) and the UI `TradeBar` (which draws the single real stop from
`trade.stopLossPrice`) — so the bar can never disagree with where the trade exits.
Settings: `trailingStopPercent` (gap), `trailingActivationGatePercent` (gate),
`trailingActivationHoldSeconds` (hold) — all on the Settings page.

**Day-completion close fix (2026-06-12):** when the exit that *completes* the day
advances `currentDayIndex`, `PA.recordTradeClosed` now resolves the day that
actually contains the trade (scanning back from the current index) instead of
trusting `currentDayIndex` — fixes the "No active day" error on the 2nd+ trade and
ensures the feed-release + Telegram push still run.

## 7. Daily P&L push to Discipline

**Primary** (push): after every trade close, PA calls `POST /api/discipline/recordTradeOutcome` with the latest `dailyRealizedPnl + dailyRealizedPnlPercent`. This is what triggers DA Module 8's cap-check evaluation in real time.

**Fallback** (pull): `GET /api/portfolio/daily-pnl` is exposed for the carry-forward scheduler (15:15 IST NSE / 23:15 IST MCX) — DA pulls the latest P&L snapshot when it's evaluating carry-forward conditions on still-open positions.

If the push fails silently (DA slow, network blip), the pull at carry-forward time provides a backstop. The two paths are designed to be coherent — calling the GET endpoint should return the same numbers the most recent POST would have delivered.

## 8. APIs

**tRPC** (UI consumer):
- `portfolio.getState` — full snapshot for the dashboard.
- `portfolio.getOpenPositions(channel)` — for TradingDesk.
- `portfolio.injectCapital` — operator funding event.
- `portfolio.recordOperatorAction` — manual notes / overrides.

**REST** (cross-language + scheduled tasks):
- `GET /api/portfolio/daily-pnl` — DA carry-forward read.
- `GET /api/portfolio/open-positions` — RCA monitoring scope.
- `POST /api/portfolio/fill` — TEA fill-recording (internal).

Both surfaces enforce the same single-writer rule: only TEA may submit fills.

## 9. Journal — spec'd, NOT YET BUILT

`Journal_Spec_v0.1` describes a write-through audit log keyed by `position_id`:

- One entry per closed trade.
- Fields: operator notes, SHAP-tagged top features at signal time, cohort tag (post-T33), `discipline_violation` flag if any module-1–4 rejection was overridden.
- Append-only for operator-authored fields **once a WeeklyReview is locked** (Mon-morning gate enforced by [06 DA Module 6](06_risk_discipline.md)).
- Read by DA Module 6 to enforce "no new trades if last trade is unjournaled" (logic exists in `journalCheck.ts`, blocking gate ships; the journal-entry consumer that the gate reads doesn't).

**Today no Journal code exists.** PA records the trade-close audit trail in `position_states` itself, which covers the structured fields but not the operator-authored layer or the cohort tag. Tracked as [T49 [JRNL]](../PROJECT_TODO.md).

## 10. Head-to-Head — spec'd, NOT YET BUILT

`HeadToHead_Spec_v0.1` describes pairing ai-paper vs ai-live (and ai-live vs my-live once AI Live ramps) on `signal_id` from SEA. Daily metric cards: P&L, win-rate, Sharpe, max drawdown, divergence vs counterpart. The 5 pp divergence gate from V2 §8.2 / §8.3 feeds the AI-Live capital scale-up decision.

**Today no Head-to-Head code exists.** Tracked as [T50 [H2H]](../PROJECT_TODO.md). Two prerequisites:
1. SEA must emit a stable `signal_id` per fired signal (currently the schema doesn't define one — call out as design gap).
2. Paper-trade fills need to accumulate (≥ 14 days per AI-Live canary gate 1).

## 11. Status

**ACTIVE.**
- PortfolioAgent v1.3 — position state, capital pools, day index, daily P&L push, charge recording all in code. ~3,400 LOC across `portfolioAgent.ts`, `compounding.ts`, `storage.ts`, `router.ts`.
- Broker-desync state machine (B4 safety) shipped — tracks `EXIT_FAILED` / `MODIFY_FAILED` on the position so RCA / DA / UI can see drift between PA and broker.
- Trade-close audit + charges recording live.

**Critical-path gaps:**
- [T33](../PROJECT_TODO.md) — D56 cohort tagging end-to-end (PRE-PAPER MUST; precondition for T34 / T46 / H2H attribution).
- [T34](../PROJECT_TODO.md) — per-head SHAP + reliability monitoring scripts (PRE-PAPER MUST; Journal-adjacent — reliability report reads from `predictions_<date>.parquet`).
- [T41](../PROJECT_TODO.md) — prediction → outcome join parquet (PRE-PAPER MUST; the source-of-truth table that T34 consumes).
- [T49 [JRNL]](../PROJECT_TODO.md) — Journal write-through module (operator-notes + cohort-tag layer; PRE-paper-trade SHOULD).
- [T50 [H2H]](../PROJECT_TODO.md) — HeadToHead pairing + dashboard (gated on paper-trade fills + a stable SEA `signal_id`; deferred).

## 12. Open design decisions

- **Journal writer ownership** — does PA write directly into the Journal collection in `recordTradeClosed`, or does a separate `journalWriter` consume from a queue? Spec v0.1 leaves this open. Lean toward PA-direct (one fewer service, atomicity with trade-close).
- **SEA `signal_id` schema** — H2H pairing assumes one; SEA doesn't emit one today. Add to SEA signal schema before T47.
- **Quarterly projection** — currently surfaced in the dashboard but is "advisory only". Should it become a soft-cap input (e.g., halt new entries if quarterly trajectory is below floor)? Defer until enough day-index data accumulates.

## 13. Cross-refs

- [04 Signal Engine](04_signal_engine.md) — calls `has_open_position` for position-veto; will emit `signal_id` once T47 needs it.
- [05 Execution](05_execution.md) — fill source; single-writer into PA.
- [06 Risk & Discipline](06_risk_discipline.md) — primary consumer of daily P&L; Module 6 journal-gate reader.
- [08 UI Desktop](08_ui_desktop.md) — primary read surface (TradingDesk, dashboard, Head-to-Head card once T47 ships).
- [PROJECT_TODO.md](../PROJECT_TODO.md) — T33 / T34 / T41 / T49 / T50 active.

## 14. Code locations

| What | Path |
|---|---|
| PortfolioAgent core | `server/portfolio/portfolioAgent.ts` |
| Position-state schema + types | `server/portfolio/state.ts` + `types.ts` |
| Capital pools + day index | `server/portfolio/compounding.ts` |
| MongoDB storage layer | `server/portfolio/storage.ts` |
| tRPC + REST routes | `server/portfolio/router.ts` + `portfolioRoutes.ts` |
| Charge calculator | `server/portfolio/calculateTradeCharges.ts` (or wherever `calculateTradeCharges` lives) |
| Discipline journal-gate (consumer side) | `server/discipline/journalCheck.ts` |
| Tests | `server/portfolio/__tests__/` |
| Journal collection (planned) | `server/journal/` — not yet created |
| Head-to-Head dashboard (planned) | `server/reporting/headToHead/` — not yet created |
