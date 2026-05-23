# 07 — Portfolio & Reporting

## Purpose
Own the canonical position state (all open + closed trades, fills, P&L). Provide audit-grade Journal for every trade. Power Head-to-Head ai-live vs my-live comparison once paper-trade ramps.

## Scope
**In:** fills + lifecycle events from [05 Execution](05_execution.md).
**Out:** position state → [06 Risk & Discipline](06_risk_discipline.md); daily P&L → Discipline Module 8; journal data → [08 UI](08_ui_desktop.md) + [09 Bot](09_control_bot.md); head-to-head metrics → UI.

## Sub-specs
- [PortfolioAgent_Spec_v1.3.md](../specs/PortfolioAgent_Spec_v1.3.md) — position state owner; tracks fills, P&L, outcomes; feeds Discipline / RCA / Journal.
- [Journal_Spec_v0.1.md](../specs/Journal_Spec_v0.1.md) — trade log, fills, per-trade P&L, cohort tagging, SHAP insights.
- [HeadToHead_Spec_v0.1.md](../specs/HeadToHead_Spec_v0.1.md) — ai-vs-my side-by-side performance, daily metric cards.

## Data flow
```
fill / lifecycle event from 05 ─▶ Portfolio.applyFill()
                                          │
                                          ▼
                                  position state updated
                                          │
                          ┌───────────────┼────────────────────────┐
                          ▼               ▼                        ▼
                  06 (gate inputs)   Journal writes        Daily P&L aggregator
                                     trade + cohort                │
                                     (T33 D56)                     ▼
                                          │              06 Discipline Module 8
                                          ▼                        │
                                  SHAP insights                    ▼
                                                          Cap-check / global pause
                                          │
                                          ▼
                                  Head-to-Head comparator
                                  (ai-live vs my-live %)
                                          │
                                          ▼
                                  08 UI + 09 Bot displays
```

## Status
ACTIVE.
- Portfolio v1.3 LOCKED — position-state owner contract clear.
- Journal v0.1 spec drafted; cohort tagging end-to-end blocked by **T33 D56** (PRE-PAPER MUST, ~1d). Today: `cohort | signal_source | signal_layer | attribution` grep returns zero across `signal_engine_agent/` + `server/`.
- HeadToHead v0.1 spec drafted; activates after paper-trade phase produces comparable fill data.

## Cross-refs
- [05_execution.md](05_execution.md) — fill source.
- [06_risk_discipline.md](06_risk_discipline.md) — P&L feedback + position-state consumer.
- [08_ui_desktop.md](08_ui_desktop.md) — primary visualization surface.
- [09_control_bot.md](09_control_bot.md) — read-side summary for phone.

## Open questions
- T33 cohort tagging end-to-end (PRE-PAPER MUST).
- T34 per-head SHAP report + reliability monitoring (PRE-PAPER MUST; blocked on T25 ✅ + T33).
- HeadToHead promotion gate: defined as paper-vs-live divergence ≤5pp per V2_MASTER_SPEC §8.2/§8.3 — needs first paper-trade data.
