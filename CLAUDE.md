# CLAUDE.md — auto-loaded session context

This file is read automatically by Claude Code at the start of every session in this repo, on any machine (desktop, laptop, etc.). It exists to keep behavioral rules, open work, and active policies in **one place** that syncs across machines via git.

## At session start, always:

1. **Read [docs/PARTHA_RULES.md](docs/PARTHA_RULES.md)** — Partha's behavioral rules for how Claude should work in this project. Course-correct silently if a session drifts from these.
2. **Skim [docs/PROJECT_TODO.md](docs/PROJECT_TODO.md)** — current open work and priorities. Don't restart tasks already in flight.
3. **Reference [docs/JOURNEY_STRATEGY.md](docs/JOURNEY_STRATEGY.md)** — the 250-day strategic plan that every trading-related decision must reconcile with.
4. **Reference [docs/DHAN_TOKEN_POLICY.md](docs/DHAN_TOKEN_POLICY.md)** — active production policy. Don't reintroduce dual-refresh patterns.

## Important active design docs

- [docs/specs/YowPartha_Spec_v0.1.md](docs/specs/YowPartha_Spec_v0.1.md) — yow-partha v0.1 design (buttons-only Telegram bot, full launcher control from phone). Read before implementing the listener.
- [docs/specs/YowPartha_Migration_From_TfaBot.md](docs/specs/YowPartha_Migration_From_TfaBot.md) — `tfa_bot/` was removed on 2026-05-19; replaced by **yow-partha** (Telegram control bot, full-product scope). Older docs reference `tfa_bot/bot.py` — treat those as historical, route equivalent work to yow-partha.
- [docs/V2_MASTER_SPEC.md](docs/V2_MASTER_SPEC.md) — Single source of truth for Signal System v2. 8 layers + schema + component spec deltas + phase plan + pending decisions. **Blocks paper trading until layers lock.** Supersedes the former `SIGNAL_SYSTEM_V2.md`, `TARGET_SPEC_V2_DESIGN.md`, `REFERENCE.md`, `LAYER1_CANDIDATES.md` (consolidated 2026-05-16).
- [docs/FEATURE_HEAD_RECONCILIATION.md](docs/FEATURE_HEAD_RECONCILIATION.md) — Single-page reference: 446 L1 features ↔ 84 heads ↔ gate consumers ↔ runtime data flow. Read this when implementing T3 Phase 2–6; design questions still go to V2_MASTER_SPEC.
- [docs/T3_IMPLEMENTATION_PLAN.md](docs/T3_IMPLEMENTATION_PLAN.md) — Module-by-module implementation plan for T3 Phases 2/3/5/6/7. Complete module touch list, dependency graph, parallelization opportunities, open questions per phase. Read before starting any phase.
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
