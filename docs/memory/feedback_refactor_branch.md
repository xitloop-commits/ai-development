---
name: Work on the refactor branch, not main (effective 2026-04-21)
description: The user is refactoring the entire project on a dedicated branch. All future code changes in this repo must land on `refactor` (or whatever rename the user applies), not on main.
type: feedback
originSessionId: e9b47b10-0d15-43ee-b09b-d2492cad3bfb
---
Do not commit future changes to `main`. The user is doing a project-wide
refactor on a dedicated branch — `refactor` at the time this memory was
written.

**Why:** The user asked explicitly on 2026-04-21 to keep main untouched
while they reshape the codebase. Their in-progress uncommitted refactoring
work (deletions of auth/drizzle/oauth/db stuff, client & server
restructuring, new `client/src/stores/` folder) was moved onto the
`refactor` branch in that session so main stayed clean.

**How to apply:**
- At the start of a session: check `git branch --show-current`. If it's
  `main`, switch to `refactor` before making any changes.
- If the user renames the branch or creates additional feature branches
  off `refactor`, follow their cue — the constant is "not on main", not
  the specific name.
- Fixes to production bugs (like the recorder/gzip fix on 2026-04-21)
  are the one judgement call — if the user requests a clearly-scoped
  urgent fix, ask whether it should go to main or ride along on the
  refactor branch. Default to the refactor branch when ambiguous.
- When picking up an existing feature branch off origin (ai-model,
  bsa-refactoring, trade-executor-agent, etc.), don't move that work
  onto `refactor` without the user asking.
