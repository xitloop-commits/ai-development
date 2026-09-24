# Lubas Trading System — System Specs Index

This folder holds one **thin overview spec per major system** of the Lubas trading platform. Each overview is a 1-page entry point that links to the canonical detailed specs.

## Canonical structure

- **System overviews live here** (`docs/systems/`). One file per major system. Each is self-contained — design + code + status + open work for that subsystem, with no links back to per-component sub-specs (those have all been absorbed and removed).
- **All open work** lives in [docs/PROJECT_TODO.md](../PROJECT_TODO.md) — single source for pending/done.
- **Behavioural rules** live in [docs/PARTHA_RULES.md](../PARTHA_RULES.md).

## The major systems

| # | System | What it does |
|---|---|---|
| 01 | [Data Ingestion](01_data_ingestion.md) | Dhan WebSocket, binary parser, recorder, .ndjson.gz pipeline |
| 02 | [Feature Engineering](02_feature_engineering.md) | TickFeatureAgent — 446 L1 features + 24 L2 targets |
| 03 | [Model Training](03_model_training.md) | MTA — 84 LightGBM heads per instrument, walk-forward CV, isotonic calibration |
| 04 | [Signal Engine](04_signal_engine.md) | SEA — per-tick inference, gate logic, trade-management state |
| 05 | [Execution](05_execution.md) | BrokerServiceAgent + TradeExecutorAgent + Disconnect Safety + Dual-account |
| 06 | [Risk & Discipline](06_risk_discipline.md) | RiskControlAgent + DisciplineAgent + Charges |
| 07 | [Portfolio & Reporting](07_portfolio_reporting.md) | PortfolioAgent + Journal + HeadToHead |
| 08 | [UI Desktop](08_ui_desktop.md) | MainScreen + TradingDesk + Settings + InstrumentCard + Notifications (Tauri) |
| 09 | [Control Bot](09_control_bot.md) | yow-partha — Telegram phone-based control surface |
| 10 | [Launcher & Ops](10_launcher_ops.md) | Lubas launcher + scheduled tasks + AI canary + RUNBOOK |
| 11 | [SMA-Model](11_sma_model.md) | Learned SMA5 leg-riding entry/exit model (SPEC DRAFT — no code yet) |
| 12 | [Market Status Screen](12_market_status_screen.md) | Python 2x2 screen — 15 order-flow rules x 7 windows, live + replay (BUILT) |
| 13 | [Claude cohort](13_claude_cohort.md) | Context-first option buying — index/flow/OI decides, strike follows (SPEC — backtest first, no code yet) |
| 14 | [TCS2](14_tcs2.md) | Tick collection service — one process per instrument (nifty/bank/crude/gas), builds the option chain from ticks (BUILT 2026-09-25, all 8 phases, 425 tests — unproven live) |
| 14b | [TCS2 live test plan](14_tcs2_live_test_plan.md) | The checks only a real session can answer — run on the first live day |
| 15 | [Detection & Decision](15_detection_decision.md) | 25 analysis points from S1-S5 to a TRADE / NO TRADE context; written for NIFTY 50 (SPEC — no code yet) |

## End-to-end data flow

```
01 Ingestion → 02 Features → 03 Training → models → 04 Signal Engine
                  │                                        │
                  └─ live features ────────────────────────┘
                                                           ▼
                  human ◀── 08 UI / 09 Bot      06 Risk & Discipline (gate)
                                ▲                          │
                                │                          ▼
                          07 Portfolio ◀── fills ──── 05 Execution → Dhan
                                                           ▲
                                          10 Launcher hosts all of the above
```

## How to use this folder

- New to the codebase? Read 01 → 10 in order.
- Working on a specific area? Open that system's overview, click into the linked sub-specs.
- Adding new design? Land it in the relevant sub-spec; update the overview's data-flow line if the contract changes.
- Adding new work? Land it as a T-entry in `docs/PROJECT_TODO.md`. Never write task lists here.