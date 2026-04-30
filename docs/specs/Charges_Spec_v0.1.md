# Broker Charges Spec — v0.1

**Document:** Charges_Spec_v0.1.md
**Project:** Automatic Trading System (ATS)
**Status:** Stub (created 2026-04-30 per Phase D8). Locked decisions
should be cited; open items are flagged for resolution before
implementation begins.
**Tracker:** SPEC-110..120 (Phase D8)

---

## 1. Scope

This spec covers the **broker charges model**: the formula, table,
and code path that estimates the all-in cost of a trade (brokerage,
STT/CTT, exchange transaction fee, GST, SEBI fee, stamp duty) so the
realized P&L shown to the operator and recorded by Portfolio Agent
matches what the broker actually deducts.

Charges modeling is **critical for P&L correctness on small lot
sizes** — Dhan's flat brokerage plus statutory charges can be a
material fraction of edge on a single 1-lot canary trade.

**Explicitly NOT in scope:**
- Tax treatment / clubbing of household funds (see
  `DualAccountArchitecture_Spec_v0.1.md`).
- Margin / collateral modeling.
- Annual P&L reports for tax filing (deferred).

## 2. Entities

- **ChargeRateCard** — a versioned table of broker + statutory rates,
  segmented by segment (`EQ`, `FNO`, `CDS`) and trade type (intraday
  vs. delivery, buy vs. sell).
- **ChargeBreakdown** — per-trade itemized list:
  `brokerage`, `stt`, `exchange_fee`, `sebi_fee`, `gst`,
  `stamp_duty`, `total_charges`.
- **ChargeEstimator** — pure function `estimate(trade, rate_card) →
  ChargeBreakdown`. Used for pre-trade cost preview AND post-trade
  reconciliation.

## 3. Endpoints / API Surface

Internal service surface (no public REST in v0.1):

- `chargeEstimator.estimate(tradeInput) → ChargeBreakdown` — sync,
  pure.
- Persistence: charge breakdown stored alongside the trade outcome
  record on close (Portfolio Agent fields).

Possible UI endpoints (deferred):

- `GET /api/charges/rate-card?effective=YYYY-MM-DD` — fetch active
  card.
- `GET /api/charges/estimate?instrument=&qty=&price=&side=` — preview.

## 4. Decisions Locked

- Charges are computed at `submitTrade` time (preview) and again at
  trade close (final, against actual fill prices). (Source: spec
  intent — pre-trade preview informs sizing; post-trade reconcile
  informs Portfolio P&L.)
- The `ChargeBreakdown` is stored on the closed-trade record. (Source:
  `PortfolioAgent_Spec_v1.3.md` — Portfolio owns trade outcomes.)
- Statutory components (STT/CTT, exchange fee, SEBI fee, GST, stamp
  duty) are non-negotiable inputs; brokerage is broker-specific.

## 5. Open Items

- **Source of truth for rates:** hardcoded constants vs. config file
  vs. fetch-on-startup from broker docs. Impact: how rate changes
  are deployed.
- **Effective-dating:** government rate changes mid-day are rare but
  happen — does the rate card support `effective_from` boundaries
  within a trading day? Impact: query model.
- **Reconciliation:** when broker reports a different total than our
  estimator, do we trust the broker (overwrite) or flag for review?
  Impact: P&L correctness vs. transparency.
- **Multi-broker:** today Dhan only; future-proofing for additional
  brokers. Impact: rate-card identity.
- **Slippage modeling:** is slippage a "charge" surfaced through this
  spec, or a separate metric? Impact: P&L decomposition UI.

## 6. Dependencies

- `PortfolioAgent_Spec_v1.3.md` — stores `ChargeBreakdown` on close.
- `TradeExecutorAgent_Spec_v1.3.md` — emits the trade events that
  trigger estimation.
- `BrokerServiceAgent_Spec_v1.9.md` — source of broker-reported
  charges for reconciliation.

## 7. Change Log

| Date       | Version | Change           |
|------------|---------|------------------|
| 2026-04-30 | v0.1    | Initial stub     |
