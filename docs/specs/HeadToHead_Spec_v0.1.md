# Head-to-Head Comparison Spec — v0.1

**Document:** HeadToHead_Spec_v0.1.md
**Project:** Automatic Trading System (ATS)
**Status:** Stub (created 2026-04-30 per Phase D8). Locked decisions
should be cited; open items are flagged for resolution before
implementation begins.
**Tracker:** SPEC-110..120 (Phase D8)

---

## 1. Scope

This spec covers the **Head-to-Head (H2H) comparison view**: the UI
surface that shows AI-paper vs. AI-live (or any two accounts /
strategies) running on the same signals, side-by-side, so the
operator can detect divergence in fills, slippage, latency, and
realized P&L during the AI Live Canary window.

The H2H view is the primary decision-support tool during the 30-day
canary window defined in `AILiveCanary_Spec_v0.1.md`.

**Explicitly NOT in scope:**
- The canary activation / promotion procedure itself
  (owned by `AILiveCanary_Spec_v0.1.md`).
- Statistical significance testing of divergence — that is a
  FeedbackAgent / observability concern, deferred.
- Backtest comparison (deferred — see `IMPLEMENTATION_PLAN_v2.md` §13).

**Open framing question:** does H2H deserve its own spec, or should
it fold into `TradingDesk_Spec_v1.3.md` as a panel? See Open Items §5.

## 2. Entities

- **H2HSession** — a comparison window (e.g. one trading day, or the
  full canary window) bracketing the two accounts being compared.
- **PairedTrade** — two trades (one per account) that were triggered
  by the same upstream SEA signal; links by `signal_id`.
- **DivergenceEvent** — a delta between the two accounts on a paired
  trade exceeding a threshold (slippage, fill time, exit price, P&L).
- **H2HSummary** — aggregate metrics over the session: paired count,
  divergence count, mean slippage, P&L delta.

## 3. Endpoints / API Surface

UI-driven. Tentative shape (to be locked during implementation):

- `GET /api/h2h/session?from=&to=&accountA=&accountB=` — fetch session.
- `GET /api/h2h/paired-trades?session_id=` — list paired trades.
- `GET /api/h2h/divergence?session_id=&threshold=` — flagged deltas.
- `GET /api/h2h/summary?session_id=` — aggregates.

## 4. Decisions Locked

- The two accounts compared are typically `ai-paper` and `ai-live`
  (canary). (Source: `AILiveCanary_Spec_v0.1.md` §1 — comparison
  window is the goal.)
- Pairing is by `signal_id` from SEA. Both accounts receive the same
  signal; H2H matches the resulting trades by that key.
  (Source: `ARCHITECTURE_REFACTOR_PLAN.md` §1 — SEA is the sole signal
  producer.)
- H2H is **read-only** — no actions taken from this view.

## 5. Open Items

- **Standalone vs. fold-in:** is H2H its own panel/route, or a tab
  inside the existing TradingDesk surface? Plan recommends
  considering a fold-in. Impact: routing, navigation, spec scope.
- **Divergence thresholds:** absolute (₹) vs. percentage; per-metric
  defaults. Impact: noise level of the divergence list.
- **Real-time vs. snapshot:** does H2H tick live during the trading
  day, or only after close-of-session? Impact: WebSocket plumbing.
- **Multi-account generalization:** today A vs. B; later A vs. B vs.
  C (paper vs. ai-paper vs. ai-live vs. my-trades). Impact: data
  model.
- **Retention:** how far back does H2H show paired sessions? Impact:
  storage and aggregation cost.

## 6. Dependencies

- `AILiveCanary_Spec_v0.1.md` — primary consumer.
- `DualAccountArchitecture_Spec_v0.1.md` — account model.
- `PortfolioAgent_Spec_v1.3.md` — source of trade outcomes per
  account.
- `TradingDesk_Spec_v1.3.md` — potential host surface (see Open
  Items).
- SEA signal layer — provides `signal_id` for pairing.

## 7. Change Log

| Date       | Version | Change           |
|------------|---------|------------------|
| 2026-04-30 | v0.1    | Initial stub     |
