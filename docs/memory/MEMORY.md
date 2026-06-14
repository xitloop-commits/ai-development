**FIRST ACTION EVERY SESSION:** open `docs/PARTHA_RULES.md` and apply every rule to every chat reply for the entire session. Two tiers:

- **Main Rules 1–5** (top of file) — TOP PRIORITY, override supporting rules on conflict. M1 = simple short layman English. M2 = pre-implementation checklist (why / outcome / changes / breakage / impact). M3 = post-implementation checklist (tests + roster updated). M4 = questions go inline with why / outcome / options / recommendation. M5 = one question at a time, remember decisions, update specs before implementation.
- **Supporting Rules 1–8** (below) — still in force. R1 plain names. R2 git pull / push. R3 ≤5 sentences. R4 plan first (Why / Change / Outcome / Suggestion + OK). R5 three-step analysis. R6 update roster + commit on task completion. R7 inline questions. R8 T-roster two-artifact format.

Drift is the default failure mode — re-check `docs/PARTHA_RULES.md` mid-session if a reply starts ballooning.

All persistent project context now lives in the repo so it syncs across machines via git:

- [CLAUDE.md](../../../../../ai-development/ai-development/CLAUDE.md) — session-start entry point. Auto-loaded by Claude Code on every session in this repo.
- [docs/PARTHA_RULES.md](../../../../../ai-development/ai-development/docs/PARTHA_RULES.md) — behavioral rules.
- [docs/PROJECT_TODO.md](../../../../../ai-development/ai-development/docs/PROJECT_TODO.md) — open work, single source of truth.
- [docs/systems/README.md](../../../../../ai-development/ai-development/docs/systems/README.md) — index of 10 self-contained system overview docs (01 Data Ingestion → 10 Launcher & Ops). This is the single source of truth for every part of the platform — design + code + status all inline.

Doc landscape after the 2026-05-23 → 2026-05-25 cleanup pass: `docs/` = PARTHA_RULES + PROJECT_TODO + `systems/` (10 overviews + README). `docs/archive/`, `docs/benchmarks/`, `docs/memory/`, `docs/specs/`, and the standalone `docs/V2_MASTER_SPEC.md` are all gone — their content was either folded into the relevant system overview (design + ops + 250-day journey) or merged into PROJECT_TODO (pending tasks). When in doubt about where something belongs: pending work → PROJECT_TODO; design + status → the matching `docs/systems/XX_*.md` overview.

Local-only design decisions (not in repo docs):
- [Launcher Windows-only by design](project_launcher_windows_only.md) — cross-platform considered & rejected 2026-05-17.
- [Launcher renamed to Lubas](project_launcher_name_lubas.md) — full ATS → Lubas / Lucky Basker rebrand 2026-05-17.
- [Project bot named yow-partha](project_yow_partha_bot.md) — Telegram, full-product control surface; supersedes narrow tfa_bot (2026-05-19).
- [yow-partha v0.1 resume point](project_yow_partha_resume.md) — bot live, graceful-stop refactor pending (direct-spawn arch); resume here next session (2026-05-19 EOD).
- [yow-partha auto-start at 8:55am Mon–Fri](project_yow_partha_autostart.md) — Windows Task "Lubas-YowPartha-Daily" wakes laptop & launches bot; created 2026-05-20.

Working-style preferences:
- [Ask design questions inline, not via modal](feedback_questions_inline.md) — Partha prefers chat-prose options over the AskUserQuestion popup.
- [Don't lead with T-codes](feedback_no_t_codes.md) — chat replies use descriptive task names ("hyperparameter tuning") not codes ("T28"). T-codes only as small parenthetical for cross-reference.
- [T-roster + hierarchy format on request](feedback_t_roster_format.md) — When asked for "T status / roster / hierarchy / latest update," produce the fixed two-table format; re-read PROJECT_TODO each time, never cache.
- Briefing format (why / change / outcome / suggestion, one-line each) → [Rule 4 in docs/PARTHA_RULES.md](../../../../../ai-development/ai-development/docs/PARTHA_RULES.md).
- [TFA + its Dhan WS connection are off-limits](feedback_tfa_do_not_touch.md) — never propose refactors that touch TFA's spouse-account WebSocket path.
- [BrokerId rename in progress](project_broker_id_rename.md) — `dhan` → `dhan-primary-ac`, `dhan-ai-data` → `dhan-secondary-ac`. Code first, MongoDB migration LAST.

This auto-memory directory intentionally kept minimal so that nothing important lives in a per-machine location.

If a new project insight surfaces that should persist across machines, append it to the appropriate doc above (not to this directory).
