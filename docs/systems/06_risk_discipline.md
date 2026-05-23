# 06 — Risk & Discipline

## Purpose
Pre-trade gate (does this signal pass risk rules?), real-time position monitoring (is this open trade still healthy?), exit decisioning (SL / TP / TSL / MUST_EXIT), and broker-cost modeling (charges).

## Scope
**In:** signals from [04 Signal Engine](04_signal_engine.md); position state + P&L from [07 Portfolio](07_portfolio_reporting.md).
**Out:** approval / rejection / exit signals → [05 Execution](05_execution.md); daily P&L feedback → Discipline Module 8.

## Sub-specs
- [RiskControlAgent_Spec_v2.0.md](../specs/RiskControlAgent_Spec_v2.0.md) — real-time approval, monitoring loop (1–5s), SL/TP/TSL management, paper/live split.
- [DisciplineAgent_Spec_v1.4.md](../specs/DisciplineAgent_Spec_v1.4.md) — 8-module engine (circuit breaker, trade limits, time windows, pre-trade gate, sizing, journal, weekly review, capital protection).
- [Charges_Spec_v0.1.md](../specs/Charges_Spec_v0.1.md) — fixed per-strike-distance slippage penalty (Option B for v2 ramp); turnover-based commission.
- Design authority: [V2_MASTER_SPEC.md §2.7](../V2_MASTER_SPEC.md) — L7 risk controls (layer cap, swing cutoff, shared daily-loss budget, event blackout).

## Data flow
```
signal from 04 ─▶ Discipline 8-module gate
                  ├─ Module 1: circuit breaker (kill switch + global pause)
                  ├─ Module 2: trade limits (per-day, per-instrument, streak)
                  ├─ Module 3: time windows (entry cutoffs, event blackouts)
                  ├─ Module 4: pre-trade gate (signal quality + position cap)
                  ├─ Module 5: sizing (lot computation per L6)
                  ├─ Module 6: journal (write-through audit)
                  ├─ Module 7: weekly review (Mon morning report)
                  └─ Module 8: capital protection (daily-loss + monthly-loss caps)
                                                  │
                                  pass             │            fail
                                  ▼                              ▼
                          RCA real-time approval           reject + journal
                                  │
                                  ▼
                          05 TEA places order
                                  │
                                  ▼ (open position)
                          RCA 1–5s monitoring loop
                                  │
            ┌──────────────────────┼─────────────────────┐
            ▼                      ▼                     ▼
        SL hit              TP hit              MUST_EXIT (Discipline-triggered)
            │                      │                     │
            └──────────────────────┴─────────────────────┘
                                  │
                                  ▼
                              05 TEA closes
                                  │
                                  ▼
                      07 Portfolio records → daily P&L → Discipline Module 8
```

## Status
ACTIVE.
- DisciplineAgent v1.4 LOCKED (Module 4 + Module 8 implemented per FINAL_VERIFICATION_TRACKER top-10 #4–5).
- RCA v2.0 LOCKED (real-time approval + monitoring loop wired).
- Charges Option B in production; T10/T11 upgrades gated on ≥100 paper fills per instrument.
- Pending **T31** PRE-PAPER MUST: V2 §2.7 layer cap + swing cutoff + shared daily-loss budget (~2–3d). Today's `server/discipline/` has generic limits but no layer-aware caps.

## Cross-refs
- [04_signal_engine.md](04_signal_engine.md) — gate consumer of L4 output.
- [05_execution.md](05_execution.md) — receives approval / rejection / exit signals.
- [07_portfolio_reporting.md](07_portfolio_reporting.md) — position state + P&L source.

## Open questions
- T31 layer-aware caps (T3 Phase 6).
- T8 cost-floor migration (TP-floor → EV-floor) gated on calibration + reliability validation.
- T10/T11 charges recalibration from real paper fills.
