# 09 — Control Bot (yow-partha)

## Purpose
Phone-based control surface for the full Lubas product. Buttons-only Telegram bot — when laptop isn't open, Partha can still pause/resume/inspect from anywhere.

## Scope
**In:** same backend state stream as [08 UI](08_ui_desktop.md) — positions, signals, agent statuses.
**Out:** Telegram button presses → HTTP commands → backend (start/stop launcher stages, view summary, force-exit positions, toggle channel modes).

## Sub-specs
- [YowPartha_Spec_v0.1.md](../specs/YowPartha_Spec_v0.1.md) — buttons-only design, full launcher control from phone.
- [YowPartha_Migration_From_TfaBot.md](../specs/YowPartha_Migration_From_TfaBot.md) — 8 patterns lifted from the deleted `tfa_bot/` (removed 2026-05-19).
- [YowPartha_v0.1_Roster.md](../specs/YowPartha_v0.1_Roster.md) — usernames, Telegram IDs, permissions.
- Auto-memory references (per-machine, not in repo):
  - `project_yow_partha_bot.md` — Telegram bot full-product scope.
  - `project_yow_partha_resume.md` — v0.1 resume point (graceful-stop refactor pending).
  - `project_yow_partha_autostart.md` — `Lubas-YowPartha-Daily` scheduled task (8:55 Mon–Fri).

## Data flow
```
backend HTTP API ─▶ yow-partha listener
                            │
                            ▼
                    Telegram bot API
                            │
                            ▼
                  user sees button menu on phone
                            │
                            ▼
                    button press ─▶ Telegram → listener
                            │
                            ▼
                    HTTP POST to backend command endpoint
                            │
                            ▼
                    backend executes (start/stop, query, force-exit)
```

## Status
ACTIVE.
- v0.1 live, supersedes the removed `tfa_bot/`.
- Auto-start via `Lubas-YowPartha-Daily` scheduled task wakes laptop and launches bot at 8:55 Mon–Fri (created 2026-05-20).
- Graceful-stop refactor (direct-spawn architecture) pending — resume point captured in auto-memory `project_yow_partha_resume.md`.

## Cross-refs
- [08_ui_desktop.md](08_ui_desktop.md) — sibling control surface.
- [10_launcher_ops.md](10_launcher_ops.md) — bot hosts launcher commands; scheduled task lives there.

## Open questions
- Graceful-stop refactor — promote to a T-entry in [PROJECT_TODO.md](../PROJECT_TODO.md) before next session if you intend to ship it.
