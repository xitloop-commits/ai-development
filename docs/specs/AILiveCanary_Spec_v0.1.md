# AI Live Canary Launch — Spec v0.1

**Document:** AILiveCanary_Spec_v0.1.md
**Project:** Automatic Trading System (ATS)
**Status:** Draft — pre-launch checklist + activation procedure
**Date:** 2026-04-25

---

## 1. Purpose

Define the protocol for promoting the AI from `ai-paper` to `ai-live` with
real money. The promotion is **canary-style**: a deliberately small
capital pool, a hard 1-lot cap, and a 30-day comparison window against
`ai-paper` running in parallel on the same signals.

The goal is **not** to make money during the canary window. The goal is
to detect any divergence between paper and live execution
(slippage, fill behaviour, broker quirks, latency, RCA delays) before
sizing up.

---

## 2. Capital Source

| Field | Value |
|---|---|
| Source | Wife-funded canary allocation (separate from My Trades) |
| Initial funding | ₹50,000 (placeholder — set on activation day) |
| Trading Pool (75%) | ₹37,500 |
| Reserve Pool (25%) | ₹12,500 |
| Lot cap per trade | 1 lot (enforced by TEA — see TradeExecutorAgent_Spec_v1.3 §3) |

**Why wife-funded:** keeps the canary pool isolated from My Trades capital
so a canary loss doesn't bleed into the user's primary trading account.
Tax treatment: see `memory/project_dual_account_live.md` (decision: wife
funds, no clubbing) — full clarification deferred.

---

## 3. Pre-Launch Gates (all must be GREEN)

| # | Gate | Verification |
|---|------|--------------|
| 1 | `ai-paper` running for ≥ 14 calendar days | Head-to-Head view shows `tradeCount >= 50` on `ai-paper` |
| 2 | `ai-paper` win rate ≥ 45% | Head-to-Head view shows `winRate >= 0.45` |
| 3 | TEA single-writer invariant verified | `pnpm check` clean; no `broker.placeOrder` calls outside `server/executor/` |
| 4 | RCA age-exit working | At least 3 closed trades in `ai-paper` with `exitTriggeredBy === "RCA"` |
| 5 | Discipline pre-trade gate active | At least one rejected SEA signal logged with reason starting `"Discipline blocked:"` |
| 6 | 1-lot cap enforced | `tradeExecutor.test.ts` 10/10 green (covers the cap) |
| 7 | Wife's Dhan credentials provisioned | `broker_configs` doc for `dhan-ai-data` has valid `auth.{clientId, pin, totpSecret}` |
| 8 | Dhan ToS confirmation | User received written confirmation from Dhan support that auto-trading is permitted on the wife's account (memory: spec gap #4 — pending user task) |

If any gate is RED → do not activate. Either ship the missing wiring or
revise the spec.

---

## 4. Activation Procedure

1. **Allocate capital** — run capital injection on `ai-live`:
   ```
   POST /api/trpc/portfolio.inject
   { json: { channel: "ai-live", amount: 50000 } }
   ```
   Verify the 75/25 split via `portfolio.snapshot`.

2. **Verify lot cap** — submit a 2-lot test trade on `ai-live`:
   ```
   trpc.executor.submitTrade({ channel: "ai-live", quantity: 150 (NIFTY 2 lots), ... })
   ```
   MUST return `success: false`, `error` matching `/AI Live lot cap violated/`.

3. **Add `ai-live` to RCA monitor channel list** — edit
   `server/executor/tradeExecutor.ts:start()`:
   ```ts
   rcaMonitor.start({ channels: ["ai-paper", "ai-live"] });
   ```

4. **Switch SEA bridge to `ai-live`** — in
   `server/executor/tradeExecutor.ts:start()`, change:
   ```ts
   seaBridge.start("ai-paper");          // before
   seaBridge.start("ai-live");           // after
   ```
   *(Note: this routes all filtered SEA signals to live. The
   `ai-paper` channel is no longer fed — Phase 2 of the canary will
   re-introduce parallel paper/live for direct comparison.)*

5. **Verify no kill switches armed** — confirm `aiKillSwitch === false`
   in user_settings; check Head-to-Head shows `ai-live` open positions
   start updating after the first SEA signal.

---

## 5. Daily Check-in (during canary window)

Every market day at end-of-day:

1. Open Head-to-Head: `http://localhost:3000/?view=h2h`
2. Compare `ai-paper` vs `ai-live` rows on:
   - Today P&L (absolute and %)
   - Trade count (should be similar)
   - Win rate (should be similar)
   - pnlByTriggeredBy → `AI` (paper) vs the same on live
3. Flag if `ai-live` underperforms `ai-paper` by **> 10% cumulative**
   over any 5-day rolling window — indicates execution divergence.
4. Log observations in `memory/project_ai_live_canary.md` (create on
   activation day).

---

## 6. Abort Criteria

The canary aborts (manually disable SEA bridge for `ai-live`) on **any**:

| Trigger | Threshold |
|---|---|
| Cumulative drawdown | ≥ 10% of initial canary funding (≥ ₹5,000) |
| Consecutive losing days | 3 |
| Discipline circuit breaker tripped | once |
| Single-trade loss | > ₹500 (1 lot NIFTY ≈ 500 pts × 75 / 100) |
| Broker reconciliation failure | any orderSync warning of "no matching open trade" for an entry order |
| Model drift signal | SEA's `score` distribution shifts > 2σ from training baseline |

**To abort:**
```ts
seaBridge.stop();        // halts new trade entries on ai-live
// existing open trades will be auto-exited by RCA on age, or manually
// via the UI's exit button.
```

---

## 7. Success Criteria (after 30 days)

The canary is considered successful and the next sizing-up commit
(raise `AI_LIVE_LOT_CAP` to 2-5 lots) is justified when **all** are
true:

- Cumulative `ai-live` P&L within ±15% of cumulative `ai-paper` P&L
  *(execution parity verified)*
- Win rate within ±5 percentage points of `ai-paper`
- Zero unauthorised broker orders (single-writer invariant held in
  production)
- Zero stuck orders (orderSync reconciled every fill)
- No kill switch trips
- Average slippage on entry < 0.3% of intended price
- RCA age-exit triggered as expected (no stale positions)

---

## 8. Rollback Procedure

If the canary aborts or 30-day window completes with FAILURE:

1. Stop SEA bridge on `ai-live` (set channel back to `ai-paper`).
2. Exit all open `ai-live` positions via UI (or RCA age-exit will
   handle within 30 min).
3. Run `portfolio.transferFunds({ from: "ai-live", to: "my-live",
   amount: "all" })` to repatriate the wife's canary capital
   (assuming the user wants to consolidate; alternative: leave on
   `ai-live` for the next iteration).
4. Update `memory/project_ai_live_canary.md` with post-mortem notes.
5. File issues for any divergences found in the canary window — those
   inform the next AI Live spec revision.

---

## 9. References

- [PortfolioAgent v1.3](PortfolioAgent_Spec_v1.3.md) — capital pool semantics, single-writer rule
- [TradeExecutorAgent v1.3](TradeExecutorAgent_Spec_v1.3.md) — execution gateway, 1-lot cap location
- [RiskControlAgent v2.0](RiskControlAgent_Spec_v2.0.md) — exit triggers
- [DisciplineEngine v1.3](DisciplineEngine_Spec_v1.3.md) — pre-trade cap-check
- [BrokerServiceAgent v1.8](BrokerServiceAgent_Spec_v1.8.md) — multi-channel adapter routing
- [ModelTrainingAgent v0.1](ModelTrainingAgent_Spec_v0.1.md) — AI Trades mode (paper ↔ live)
- [DualAccountArchitecture v0.1](DualAccountArchitecture_Spec_v0.1.md) — wife's account setup

---

## 10. Open Questions

1. **Capital ramp** — after a successful 30-day canary, what's the
   cap-raising schedule? (e.g., 2 lots → 5 lots → 10 lots → uncapped,
   each 30-day window?)
2. **Reserve top-up** — does the wife's reserve pool get topped up if
   trading pool gets depleted, or is the canary one-shot until rollback?
3. **Tax filing** — wife's PAN handles the gains/losses; need to confirm
   ITR filing process before activation.
4. **Concurrent paper run** — Section 4 step 4 currently routes SEA
   to `ai-live` exclusively. Should we add a side-channel that
   duplicates every signal to `ai-paper` for direct execution-parity
   comparison? (Adds complexity to seaBridge.)

---

## 11. Versioning

This spec is versioned `v0.1`. Activation day records the initial
funding amount in §2. Post-canary the spec is either revised to
`v1.0` (sizing-up procedure) or marked `DEPRECATED` if the canary
fails.
