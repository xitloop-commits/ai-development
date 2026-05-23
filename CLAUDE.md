# CLAUDE.md — auto-loaded session context

This file is read automatically by Claude Code at the start of every session in this repo, on any machine (desktop, laptop, etc.). It exists to keep behavioral rules, open work, and active policies in **one place** that syncs across machines via git.

## At session start, always:

1. **Read [docs/PARTHA_RULES.md](docs/PARTHA_RULES.md)** — Partha's behavioral rules for how Claude should work in this project. Course-correct silently if a session drifts from these.
2. **Skim [docs/PROJECT_TODO.md](docs/PROJECT_TODO.md)** — current open work and priorities. Don't restart tasks already in flight.
3. **Reference [docs/JOURNEY_STRATEGY.md](docs/JOURNEY_STRATEGY.md)** — the 250-day strategic plan that every trading-related decision must reconcile with.
4. **Reference [docs/DHAN_TOKEN_POLICY.md](docs/DHAN_TOKEN_POLICY.md)** — active production policy. Don't reintroduce dual-refresh patterns.

## Important active design docs

**Start here:** [docs/systems/README.md](docs/systems/README.md) — index of the 10 major-system overview specs. Each overview is a thin 1-page entry point that links to the detailed sub-specs in [docs/specs/](docs/specs/). Read the overview for the area you're working in, then click into the sub-specs from there.

The 10 systems: [01 Data Ingestion](docs/systems/01_data_ingestion.md) · [02 Feature Engineering](docs/systems/02_feature_engineering.md) · [03 Model Training](docs/systems/03_model_training.md) · [04 Signal Engine](docs/systems/04_signal_engine.md) · [05 Execution](docs/systems/05_execution.md) · [06 Risk & Discipline](docs/systems/06_risk_discipline.md) · [07 Portfolio & Reporting](docs/systems/07_portfolio_reporting.md) · [08 UI Desktop](docs/systems/08_ui_desktop.md) · [09 Control Bot](docs/systems/09_control_bot.md) · [10 Launcher & Ops](docs/systems/10_launcher_ops.md).

**Cross-cutting design authorities** (read alongside the system overviews):
- [docs/V2_MASTER_SPEC.md](docs/V2_MASTER_SPEC.md) — Single source of truth for Signal System v2. 8 layers + schema + component spec deltas + phase plan + 73 D-decisions. **Blocks paper trading until layers lock.**
- [docs/FEATURE_HEAD_RECONCILIATION.md](docs/FEATURE_HEAD_RECONCILIATION.md) — 446 L1 features ↔ 84 heads ↔ gate consumers ↔ runtime data flow lookup.
- [docs/RUNBOOK_PHASE_I.md](docs/RUNBOOK_PHASE_I.md) — pre-open checklist for paper/live trading days.

## What this file is NOT for

- Long narrative explanations (those live in the linked docs)
- Code architecture notes (those live in code + per-module docs)
- Session-specific scratch state (use TodoWrite or transient memory)

If something belongs in here permanently, link to a doc; if something is transient, leave it out.

## How to keep this current

- New behavioral rule? → append to `docs/PARTHA_RULES.md`.
- New TODO item? → append to `docs/PROJECT_TODO.md`.
- New active design doc? → create under `docs/` and link from this file.

Single source of truth, no duplicates between machines.
