---
name: Work directly on main (effective 2026-04-24, supersedes earlier branch-only rule)
description: The earlier "don't commit to main; use the refactor branch" rule no longer applies. ui-refactoring was merged into main and the user has confirmed work continues directly on main.
type: feedback
---
Commit refactor and feature work directly to `main`.

**Why:** On 2026-04-21 the user asked to keep main untouched while reshaping the
codebase on a dedicated branch (`ui-refactoring`). On 2026-04-24 that branch was
merged into main (commit `9fc0bf8 Merge ui-refactoring → main`), main moved
forward with new commits, and the user explicitly confirmed: "lets continue on
main only." The earlier branch-quarantine rule is retired.

**How to apply:**
- Default branch for new work is `main`. Don't switch off main without an
  explicit instruction.
- Existing feature branches on origin (`ai-model`, `bsa-refactoring`,
  `trade-executor-agent`, `codex-manual-paper-trade`) are not part of this — do
  not move their work onto main without the user asking.
- If the user later asks for a new dedicated refactor branch again, follow that
  cue. The constant is "follow the user's current branching cue," not any
  specific branch name.