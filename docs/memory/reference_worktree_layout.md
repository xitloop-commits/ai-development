---
name: Repo worktree layout — main (running programs) vs ui-refactoring (dev)
description: Primary workspace stays on `main` so the always-on TFA/API server read stable code; active development happens in a sibling git worktree pinned to `ui-refactoring`.
type: reference
originSessionId: e9b47b10-0d15-43ee-b09b-d2492cad3bfb
---
Two worktrees share the same `.git` repository:

- **`c:/Users/Admin/ai-development/ai-development/`** → branch `main`
  - This is the path the running programs (TFA, API server, launcher/bat
    scripts) read from. Keep it stable. Don't `git checkout` a different
    branch here unless the user says so — switching this working tree flips
    what the running programs see.
  - Data dirs (`data/`, `logs/`, `models/`) and the populated
    `node_modules/` + `.env` all live here.

- **`c:/Users/Admin/ai-development/ai-development-ui-refactoring/`** → branch `ui-refactoring`
  - Created 2026-04-21 as a `git worktree add` sibling.
  - The active development workspace. Safe to break things here — it
    doesn't affect anything the running processes read.
  - Starts with NO `.env`, NO `node_modules`, and NO `data/` (all
    gitignored). The user copies/installs what they need for testing.

**How to apply:**
- If the user's cwd / tool-calls reference the primary path, assume they
  want main-branch behaviour (running-programs context).
- If they reference the `-ui-refactoring` path, they're in dev mode and
  want ui-refactoring branch.
- When the user says "switch branch" without naming a worktree, ask
  which worktree — do not silently flip the primary.
- `git worktree list` inside either directory shows the current layout;
  use that if the arrangement looks stale or different.
