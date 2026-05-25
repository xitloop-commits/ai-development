# CLAUDE.md — auto-loaded session context

This file is read automatically by Claude Code at the start of every session in this repo, on any machine (desktop, laptop, etc.). It exists to keep behavioral rules, open work, and active policies in **one place** that syncs across machines via git.

## At session start, always:

1. **Read [docs/PARTHA_RULES.md](docs/PARTHA_RULES.md)** — Partha's behavioral rules for how Claude should work in this project. Course-correct silently if a session drifts from these.
2. **Skim [docs/PROJECT_TODO.md](docs/PROJECT_TODO.md)** — current open work and priorities. Don't restart tasks already in flight.
3. **Reference [docs/systems/README.md](docs/systems/README.md)** — index of the 10 system overviews. Each one is self-contained: design + code + status + open work for that subsystem.

## The 10 system overviews

The single source of truth for every part of Lubas:

[01 Data Ingestion](docs/systems/01_data_ingestion.md) · [02 Feature Engineering](docs/systems/02_feature_engineering.md) · [03 Model Training](docs/systems/03_model_training.md) · [04 Signal Engine](docs/systems/04_signal_engine.md) · [05 Execution](docs/systems/05_execution.md) · [06 Risk & Discipline](docs/systems/06_risk_discipline.md) · [07 Portfolio & Reporting](docs/systems/07_portfolio_reporting.md) · [08 UI Desktop](docs/systems/08_ui_desktop.md) · [09 Control Bot](docs/systems/09_control_bot.md) · [10 Launcher & Ops](docs/systems/10_launcher_ops.md).

For the 250-day strategic vision: [10 Launcher & Ops §10](docs/systems/10_launcher_ops.md).
For the Dhan token policy: [01 Data Ingestion §5](docs/systems/01_data_ingestion.md) + [05 Execution §7](docs/systems/05_execution.md).
For the pre-open RUNBOOK: [10 Launcher & Ops §7](docs/systems/10_launcher_ops.md).

## What this file is NOT for

- Long narrative explanations (those live in the linked overviews)
- Code architecture notes (those live in the system overviews + code itself)
- Session-specific scratch state (use TodoWrite or transient memory)

If something belongs in here permanently, link to a system overview; if it's transient, leave it out.

## How to keep this current

- New behavioural rule? → append to `docs/PARTHA_RULES.md`.
- New TODO item? → append to `docs/PROJECT_TODO.md`.
- New design content? → update the relevant `docs/systems/XX_*.md` overview (never create parallel docs).

Single source of truth, no duplicates between machines.
