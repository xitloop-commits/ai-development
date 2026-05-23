# 08 — UI Desktop

## Purpose
Single-screen Tauri/React desktop UI: monitor pipeline, place manual orders, configure settings, watch instrument cards, read journal, control kill switch.

## Scope
**In:** backend state via WS (positions from [07](07_portfolio_reporting.md), signals from [04](04_signal_engine.md), agent statuses, launcher state from [10](10_launcher_ops.md)).
**Out:** human input (manual orders, settings changes, kill-switch flips, instrument-card actions) → backend.

## Sub-specs
- [MainScreen_Spec_v1.3.md](../specs/MainScreen_Spec_v1.3.md) — AppBar tabs (AI / My / Testing) × mode pills (LIVE / PAPER), Trading Desk, sidebars, dialog overlays.
- [TradingDesk_Spec_v1.3.md](../specs/TradingDesk_Spec_v1.3.md) — positions / orders / P&L table; real-time updates; action menus.
- [Settings_Spec_v1.5.md](../specs/Settings_Spec_v1.5.md) — user preferences, broker configs, workspace/mode toggles, execution defaults.
- [InstrumentCard_v2_Spec_v0.1.md](../specs/InstrumentCard_v2_Spec_v0.1.md) — live IV, Greeks, OI distribution, max-pain, expiry countdown.
- [Notifications_Spec_v0.1.md](../specs/Notifications_Spec_v0.1.md) — alert catalog, Telegram + UI toast, escalation rules.

**TradingDesk redesign in-flight:** summary shrinks from 10 → 6 items; table shrinks from 15 → 10 columns; row-expand reveals per-trade detail. Ready to implement, no blockers.

## Data flow
```
backend (server/*) ──WS──▶ React/Vite client
                              │
                              ▼
                  MainScreen (AppBar tabs × mode pills)
                              │
        ┌──────────┬──────────┼──────────┬──────────────┐
        ▼          ▼          ▼          ▼              ▼
  TradingDesk  InstrumentCard Sidebars  Journal      Settings
   (positions  (live IV +     (status,  (trades +    (broker +
   + actions)  Greeks + OI)   alerts)   cohort tags) workspace)
        │
        ▼
  user input → backend HTTP / WS
```

## Status
ACTIVE.
- MainScreen v1.3 LOCKED (channel normalization 2026-04-24 added AppBar tabs + LIVE/PAPER pills).
- TradingDesk v1.3 redesign ready to implement (10→6 summary items, 15→10 cols, row-expand for trade details — see memory note).
- Settings v1.5, InstrumentCard v0.1, Notifications v0.1 all spec'd.

## Cross-refs
- [04_signal_engine.md](04_signal_engine.md) — signal feed display.
- [06_risk_discipline.md](06_risk_discipline.md) — Discipline status, kill switch.
- [07_portfolio_reporting.md](07_portfolio_reporting.md) — primary data source.
- [09_control_bot.md](09_control_bot.md) — sibling control surface (phone).
- [10_launcher_ops.md](10_launcher_ops.md) — pipeline status visualization.

## Open questions
- TradingDesk redesign: ready, no blockers — scheduling decision.
- InstrumentCard v2 — enhancement timing (post-paper-trade ramp likely fine).
