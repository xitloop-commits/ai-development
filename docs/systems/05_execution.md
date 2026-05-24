# 05 — Execution

## Purpose
Sole owner of broker calls. Convert approved signals into live or paper orders, route across 6 channels and 2 Dhan accounts, handle disconnects safely, manage token refresh.

## Scope
**In:** approved signals from [06 Risk & Discipline](06_risk_discipline.md) gate (originating in [04](04_signal_engine.md)).
**Out:** orders to Dhan; fills + lifecycle events → [07 Portfolio](07_portfolio_reporting.md); status to [08 UI](08_ui_desktop.md) and [09 Bot](09_control_bot.md).

## Sub-specs
- [BrokerServiceAgent_Spec_v1.9.md](../specs/BrokerServiceAgent_Spec_v1.9.md) — 6-channel architecture (ai-live / ai-paper / my-live / my-paper / testing-live / testing-sandbox), workspace × mode.
- [TradeExecutorAgent_Spec_v1.3.md](../specs/TradeExecutorAgent_Spec_v1.3.md) — singular broker caller, paper vs live split, DISCIPLINE_EXIT handling.
- [Disconnect_Safety_Spec_v0.1.md](../specs/Disconnect_Safety_Spec_v0.1.md) — position reconciliation, stale-order cleanup, manual intervention.
- [DualAccountArchitecture_Spec_v0.1.md](../specs/DualAccountArchitecture_Spec_v0.1.md) — primary + spouse accounts.
- [DHAN_TOKEN_POLICY.md](../specs/DHAN_TOKEN_POLICY.md) — startup-only refresh policy.

## Data flow
```
signal from 04 ─▶ 06 Discipline gate (Modules 1–8) ─▶ 06 RCA approval
                                                            │
                                                            ▼
                                        05 TEA (sole broker caller)
                                                            │
                                                            ▼
                                    BSA → channel routing (workspace × mode)
                                  /     |     |     |     |     \
                              ai-live ai-paper my-live my-paper testing-live testing-sandbox
                                  \     |     |     |     |     /
                                          Dhan API
                                                            │
                                                            ▼
                                              fill / reject / partial → 07 Portfolio
                                                            │
                                                            ▼
                                          ongoing RCA 1–5s monitoring loop
                                          (emits DISCIPLINE_EXIT / SL / TP / TSL)
                                                            │
                                                            ▼
                                                  05 TEA closes position
```

## 4-agent contract (from ARCHITECTURE_REFACTOR_PLAN v2.0, 2026-04-21)
SEA → Discipline (pre-trade gate Module 4 + capital protection Module 8) → RCA (approval + 1–5s monitoring) → TEA (sole broker caller) → BSA → Dhan. Discipline `MUST_EXIT` signals route directly to RCA. Portfolio records all outcomes and pushes daily P&L back to Discipline Module 8 for cap checks.

## Dual-account specifics
- **Primary** Dhan (Client `1101615161`, 2/5 WS) — UI tick + `my-live` orders.
- **Spouse** Dhan (Client `1111388877`, 5/5 WS) — 4 TFA WS + `ai-live` orders.
- `BSAAdapters.getAdapter('ai-live')` prefers `dhanAiData`, falls back to `dhanLive`.
- Tax clubbing resolved: spouse funds AI Live from own income/savings (no gift trail).
- Feed-disconnect policy: alert-only, no auto-flat.

## Status
ACTIVE. 4-agent architecture LOCKED 2026-04-21, Phases 1–5 DONE. Dual-account live since 2026-04-25. AI Live capital starts small per Head-to-Head divergence gate (V2_MASTER_SPEC §8.2/§8.3).

## Cross-refs
- [04_signal_engine.md](04_signal_engine.md) — upstream signal producer.
- [06_risk_discipline.md](06_risk_discipline.md) — gate + ongoing monitoring partner.
- [07_portfolio_reporting.md](07_portfolio_reporting.md) — fills + outcomes.
- [10_launcher_ops.md](10_launcher_ops.md) — AILiveCanary playbook, scheduled tasks.

## Open questions
- Dhan ToS confirmation for spouse-account pattern still pending (carried forward from project_dual_account_live.md).
- T15 limit-order optimization deferred until ≥200 paper fills accumulated.