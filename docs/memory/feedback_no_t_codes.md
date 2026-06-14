---
name: feedback-no-t-codes
description: "Don't lead with T-codes (T28, T37, T14, T47, etc.) when discussing tasks with Partha — use the descriptive name. T-codes only as a small parenthetical when needed for cross-reference."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 38f9990a-d102-40a0-b5ac-2e1b72cdcf7b
---

When discussing project tasks in chat, **lead with the descriptive name**, not the T-code. Partha said the T-codes "are no use to me — need to give actual names" on 2026-06-15 after I rattled off "T28, T37, T14, T17, T20".

**Why:** the T-codes index PROJECT_TODO.md but they're meaningless without a lookup. Partha is the user/decision-maker, not a developer parsing the roster — descriptive names communicate; codes don't.

**How to apply:**
- ✅ "Hyperparameter tuning (Optuna) — plumbing shipped, sweep parked."
- ✅ "Order-book depth features (levels 1–4) — shipped this session."
- ❌ "T28 PR1 SHIPPED 2026-06-13 (`faf8917`); PR2 PARKED."
- A T-code is OK as a small parenthetical when Partha needs to look it up himself (e.g. "the v2 decision gate (T29) is still open"). Never as the headline.
- This applies to chat, not to git commit messages or PROJECT_TODO.md — those still use T-codes by convention.
- Related: the [[feedback-t-roster-format]] T-roster two-table format DOES use T-codes because Partha specifically asked for that format. The rule above is about everything ELSE.
