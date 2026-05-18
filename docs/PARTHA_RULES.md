# Partha's rules for working with Claude on this project

Single source of truth. Read at session start.

## Rule 1 — Plain strategy names, never version labels

Refer to trading strategies by what they DO: "the scalp model", "the trend layer", "the swing system". Not "Wave 2" or "v2" or "Phase 5." Version labels are fine in code, commits, and filenames — never in chat.

**Why:** *"do not confuse me with wave2, v2, say actual name (trend, swing, scalping)"*.

## Rule 2 — Resume across desktop + laptop

I work from desktop AND laptop. Sessions must always pick up from where the last commit on either machine left off.

- Session start (both machines): `git pull --ff-only` before any work.
- Session end: commit + push every in-flight change. Never leave uncommitted edits sitting on one machine.
- Persistent state lives in repo docs (`PROJECT_TODO.md`, `V2_MASTER_SPEC.md`, `CLAUDE.md`). TodoWrite is in-session only — mirror anything important into `PROJECT_TODO.md` before stopping.
- When in doubt: ask *"is what I just did pushed?"* before stopping.

## Rule 3 — Short layman English, always

Every chat answer is short, plain English, and a non-coder can follow it.

- Default ≤ 5 short sentences. Aim for less.
- No code blocks, multi-row tables, or nested bullets unless I ask for them.
- No section headers, no jargon piles. Translate each technical term to one short plain sentence.
- If a question genuinely needs more, ask *"want more detail?"* first.
- Source code, commit messages, and spec docs keep their existing conventions — this rule is about chat prose.

**Why:** *"always give me short and crispy answer"* + *"do not generate heavy text output, explain the user with simple layman english, simple statement not lengthy, technical statements are fine but keep them simple."*

## Rule 4 — Plan before touching anything, then wait

Any change to the running system (feature, refactor, **bug fix**, config edit, dependency bump) gets a short plan in chat FIRST. Wait for "ok" / "go" / "proceed" before editing files or running state-changing commands.

**Plan format (Rule 3 applies — short layman English, no code blocks, no walkthroughs):**
- **Why** — the gap or problem, one sentence.
- **Change** — what gets touched, one sentence.
- **Outcome** — what changes for me, one sentence.
- **Suggestion** — the single recommended approach, one sentence.
- Then "OK?"

**Allowed without a plan (read-only):** grep, file inspection, `git log`, test runs, replay-runner — anything that doesn't modify state.

**Skipping the plan:** only for trivial follow-ups already greenlit in this conversation (one-line bumps inside an approved slice). When in doubt, plan.

**Why:** *"for any bug fix/enhancements/new development going forward, give me your plan first before touching the system / code base in simple laymen english in short. wait for my confirmation and continue."* Plus historical: explain before implementing, brief in why/change/outcome/suggestion.

## How to add new rules

Append at the bottom with format:

```
## Rule N — short title

Body.
**Why:** quote.
- How to apply: bullets.
```

Update no other file. This is the single source of truth.
