# CLAUDE.md — auto-loaded session context

This file is read automatically by Claude Code at the start of every session in this repo, on any machine (desktop, laptop, etc.). It exists to keep behavioral rules, open work, and active policies in **one place** that syncs across machines via git.

## At session start, always:

1. **Read [docs/PARTHA_RULES.md](docs/PARTHA_RULES.md)** — Partha's behavioral rules for how Claude should work in this project. Course-correct silently if a session drifts from these.
2. **Skim [docs/PROJECT_TODO.md](docs/PROJECT_TODO.md)** — current open work and priorities. Don't restart tasks already in flight.
3. **Reference [docs/JOURNEY_STRATEGY.md](docs/JOURNEY_STRATEGY.md)** — the 250-day strategic plan that every trading-related decision must reconcile with.
4. **Reference [docs/DHAN_TOKEN_POLICY.md](docs/DHAN_TOKEN_POLICY.md)** — active production policy. Don't reintroduce dual-refresh patterns.

## Important active design docs

- [docs/TARGET_SPEC_V2_DESIGN.md](docs/TARGET_SPEC_V2_DESIGN.md) — v2 target spec for trend-capture retrain. **Blocks paper trading until done.**
- [docs/WAVE2_RESUMPTION_GUIDE.md](docs/WAVE2_RESUMPTION_GUIDE.md) — Wave 2 model state + how to resume work on it.

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
