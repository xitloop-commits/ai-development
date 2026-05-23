# Lubas Trading System — System Specs Index

This folder holds one **thin overview spec per major system** of the Lubas trading platform. Each overview is a 1-page entry point that links to the canonical detailed specs.

## Canonical structure

- **System overviews live here** (`docs/systems/`). One file per major system.
- **Detailed specs live in `docs/specs/`** (e.g. `RiskControlAgent_Spec_v2.0.md`). Overviews link to them; never duplicate them.
- **Design authority** for the v2 signal system is [docs/V2_MASTER_SPEC.md](../V2_MASTER_SPEC.md).
- **All open work** lives in [docs/PROJECT_TODO.md](../PROJECT_TODO.md) — single source for pending/done.
- **Behavioral rules** live in [docs/PARTHA_RULES.md](../PARTHA_RULES.md).

## The 10 major systems

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