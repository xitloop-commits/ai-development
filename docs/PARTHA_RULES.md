# Partha's rules for working with Claude on this project

Single source of truth for behavioral preferences. Read first at session start. Add new rules at the bottom with a date stamp.

## Rule 1 — Explain before implementing (May 3 2026)

For any non-trivial task or sub-task in a multi-task plan, pause **before** implementing and brief in 3-8 lines:

1. **Why it's needed** — the concrete problem it solves in *this* codebase / for *this* user. Not generic library benefits.
2. **What changes after** — what Partha will be able to do, see, or measure that he can't today. Concrete examples beat abstract claims.
3. **What it costs** — dependencies added, lines of code, surface area, runtime overhead.

Then wait for "go" / "proceed" / "ok" before writing code.

**Why:** Partha evaluates value before approving work and may redirect or skip tasks. Learned during Phase F when he asked "tell me why it is needed, what is the benefits" before approving F7 (prom-client `/metrics`). After a good explanation he approved immediately, then generalized: do this for *every* task.

**How to apply:**
- For a multi-task plan (Phase X, multi-PR work): brief each task individually as you arrive at it. Don't dump all explanations upfront.
- Tight format: 3-8 lines covering need / outcome / cost, then a single "proceed?" question.
- For trivial follow-ups (renames, lint fixes, one-line bumps confirmed in conversation): skip the briefing.
- If Partha has already approved a class of work in this conversation ("go on each F task"), don't re-brief every commit. Brief at task boundaries, not edit boundaries.

## Rule 2 — Short, crisp responses (May 10 2026)

Default to short, crisp answers. Skip explanations unless asked.

**Why:** Partha said: *"always give me short and crispy answer, when i need explanation, i will ask you. do not generate large output, it is very hard to grasp quickly, and not interested to read all."*

**How to apply:**
- One-screen-or-less answers by default
- No multi-section breakdowns / large tables / long bullet lists unless asked
- For decisions: state the decision + 1-line reason. Skip the comparison matrix, the pros/cons, the recommendation paragraph.
- For findings: state the finding + the number that proves it. Skip the methodology recap and the "implications" section.
- Only escalate to detailed explanation when Partha asks "why", "explain", "details", "compare options".
- Tool-call summaries: result first, mechanics last (or omitted).

## How to add new rules

Append at the bottom of this file with format:

```
## Rule N — short title (date)
Body text.
**Why:** quote or context.
**How to apply:** bullets.
```

Update no other file. This is the single source of truth for behavioral preferences.
