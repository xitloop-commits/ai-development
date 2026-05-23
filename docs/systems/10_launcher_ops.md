# 10 — Launcher & Ops

## Purpose
Local control plane for the whole Lubas platform on Windows. Start/stop processes (TFA, MTA, SEA, bot, recorder), drive replays + trainings, schedule autonomous tasks, run the AI-Live canary ramp, host the dual-account ops, and follow the daily runbook.

## Scope
**In:** human commands from the Lubas TUI launcher; calendar triggers from Windows Task Scheduler.
**Out:** child processes that host every other system (01–09); status table; scheduled task outcomes.

## Sub-specs
- [AILiveCanary_Spec_v0.1.md](../specs/AILiveCanary_Spec_v0.1.md) — 1-week NIFTY-only canary playbook, metrics, promotion criteria.
- [DualAccountArchitecture_Spec_v0.1.md](../specs/DualAccountArchitecture_Spec_v0.1.md) — primary + spouse account topology.
- [RUNBOOK_PHASE_I.md](../RUNBOOK_PHASE_I.md) — pre-open checklist (server health, metrics, Dhan token, SEA feed).
- Operational references (auto-memory, per-machine):
  - `project_launcher_windows_only.md` — cross-platform rejected 2026-05-17.
  - `project_launcher_name_lubas.md` — full ATS → Lubas rebrand 2026-05-17.
  - `project_yow_partha_autostart.md` — Lubas-YowPartha-Daily scheduled task.
- Code: `startup/launcher_v2.py`, `startup/install-scheduled-tasks.ps1`, `scripts/retrain_v2.bat`.

## Data flow
```
human ─▶ launcher_v2.py TUI ─▶ child processes
                                    ├─ TFA (live + record)
                                    ├─ TFA replay (one per (date, instrument))
                                    ├─ MTA train
                                    ├─ SEA inference
                                    └─ yow-partha bot
                                          │
                                          ▼
                                  status table (Raw / Rep / SBT / Trn)

Windows Task Scheduler ─▶ 4 tasks
  ├─ Lubas-Startup           Mon–Fri @ logon  (TFA recorder)
  ├─ Lubas-YowPartha-Daily   Mon–Fri 08:55    (bot)
  ├─ Lubas-Stop              Mon–Fri 15:35    (graceful stop)
  └─ Lubas-Retrain-Saturday  Sat 02:00        (retrain_v2.bat → MTA × 4 instruments)
```

## T3 phase timeline (the next 4 months)
- **Phase 4 — accumulation** — Day 1 = Wed 2026-05-20, Day-30 gate = Tue 2026-06-30. Auto-recorder only, no training.
- **Phase 5 — first real retrain** — Sat 2026-07-04 via `Lubas-Retrain-Saturday`.
- **Phase 6 — pre-paper-trade work** — T29–T35 must ship before Phase 7 (~13–17 engineering days).
- **Phase 7 — paper-trade ramp** — sub-phases 7a (min-exits: TP/SL/trail/time/regime) → 7b (OI exits) → 7c (exhaustion / wall-break composition).
- **Phase 8 — AI Live** — canary 1-week NIFTY-only → scaled per Head-to-Head divergence ≤5pp per V2_MASTER_SPEC §8.2/§8.3.

Each NSE/MCX holiday in the window pushes dates one trading day later — keep `config/market_holidays.json` populated.

## Status
ACTIVE.
- Lubas launcher (Windows-only by design, 2026-05-17 rebrand).
- All 4 scheduled tasks defined in `startup/install-scheduled-tasks.ps1`. `Lubas-Retrain-Saturday` registered as part of T27 — one elevated install run on each machine activates it.
- Dual-account live since 2026-04-25. AI Live canary playbook drafted, gated on paper-trade ramp completion.

## Cross-refs
- ALL systems (launcher hosts processes for 01–09).
- [05_execution.md](05_execution.md) — dual-account topology lives there.
- [03_model_training.md](03_model_training.md) — Saturday retrain task is owned here, scoped there.

## Open questions
- **T22** launcher blue-tick (terminated-state indicator) — 3 design questions (Trn semantics / Backtest loading / stale-mtime thresholds) deferred. See [PROJECT_TODO T22](../PROJECT_TODO.md).
- Dhan ToS confirmation for spouse-account pattern outstanding (also in [05](05_execution.md)).
