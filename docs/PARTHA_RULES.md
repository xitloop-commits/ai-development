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

## Rule 3 — Use plain strategy names, not version numbers (May 16 2026)

Refer to trading strategies by their actual descriptive name, not by internal version labels (Wave 1, Wave 2, v2, Phase 1, etc.). Version labels are for git commits and design docs, not conversation.

**Why:** Partha said: *"do not confuse me with wave2, v2, say actual name (trend, swing, scalping)"*. Version labels carry no meaning for him in conversation — he tracks the system by what it DOES, not what we numbered it.

**How to apply:**
- "the scalp model" / "the scalping gate" — not "Wave 2"
- "the trend system" / "the trend targets" — not "v2" or "the new spec"
- "the swing layer" — not "the 5-min target group"
- In code / file names / commits, version labels are fine (`docs/TARGET_SPEC_V2_DESIGN.md` is OK as a filename).
- In CONVERSATION, always translate: when about to type "Wave 2", stop and say "the scalp model" instead.
- If a doc has a version-name title, refer to it by what it covers ("the trend design doc") not its version slot.

## Rule 4 — Always resumable across desktop + laptop (May 17 2026)

Partha works on this project from both a desktop and a laptop simultaneously. Sessions on either machine must always pick up from where the last session (on either machine) left off.

**Why:** Partha said: *"i use desktop and laptop simultaneously for this implementation, so always i should start from where i left last time in both switching"*.

**How to apply:**
- **Session start (both machines):** `git pull --ff-only` before any work. Verify HEAD matches origin.
- **Session end:** all in-progress work goes into git — commit and push before stopping. Never leave uncommitted edits sitting on one machine; they're invisible to the other.
- **Persistent state belongs in repo files**, not transient session memory: `docs/PROJECT_TODO.md` (open tasks), `docs/V2_MASTER_SPEC.md` (design decisions), `docs/memory/MEMORY.md` (auto-loaded context), `CLAUDE.md` (session preamble). TodoWrite's in-session todo list does NOT survive a machine switch — mirror anything important into `PROJECT_TODO.md` before ending.
- **Mid-task pauses** ("we'll continue this later"): write the current state (next decision, pending question, what's about-to-happen) into `PROJECT_TODO.md` so the other machine can resume cold.
- **Conflict avoidance:** if both machines edit the same file, second-to-push has to pull+rebase first. Stay coordinated — pick one machine for active editing, use the other for reading/review.
- **When in doubt:** ask "is what I just did pushed?" before stopping a session.

## Rule 5 — Brief in four one-line statements: why / change / outcome / suggestion (May 17 2026)

Rule 1 says "explain before implementing." Rule 5 fixes the exact format. Every briefing has four sections, each a **single plain-English statement a layman can grasp**:

- **Why** — the gap or problem in the running system today.
- **Change** — what concretely gets built / modified.
- **Outcome** — what Partha will be able to do, see, or measure once it lands.
- **Suggestion** — the one concrete approach I recommend taking.

Then end with a single "Proceed?" question. Nothing else.

**Why:** Partha said *"do not show the features in the question instead show the outcome of having this and your suggestion"* during the Phase 2 TFA rollout, then clarified *"where is the outcome - just 1 line statement is required"* and *"why, change, outcome, suggestion - all in simple statement as laymen understand"*. Feature names, formulas, NaN rules, code paths, LOC counts, and spec quotes all belong in the code and spec — not in the briefing. The briefing's job is the value decision, not the engineering recap.

**How to apply:**
- Four bold headers, each followed by one sentence. No bulleted feature lists. No formula write-outs. No spec section quotes. No multi-clause sentences hiding three points.
- Plain trading / product language. If a non-coder couldn't follow it, rewrite.
- Skip the rule for trivial follow-ups already approved in the current conversation (renames, lint fixes, one-line bumps) — Rule 1's existing carve-out applies.
- Engineering detail (LOC estimate, dependencies, hot-path cost, formula choice) lives in code, docstrings, and PR descriptions — surface it only if Partha asks.
- For decisions with a real fork in approach: state the suggestion as a single recommended path, not an A/B/C menu. Mention the alternative only as a one-clause aside if it changes the trade-off.

## How to add new rules

Append at the bottom of this file with format:

```
## Rule N — short title (date)
Body text.
**Why:** quote or context.
**How to apply:** bullets.
```

Update no other file. This is the single source of truth for behavioral preferences.
