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

## Rule 5 — Three-step analysis before any task

Before touching code for ANY task (feature, refactor, bug fix, config edit, dependency bump), do these three steps in order and report them in chat first:

1. **Analyse** — read the code and find the exact changes needed.
2. **Impact / conflict** — identify any conflict, breakage, or side effect with existing systems.
3. **List** — produce a clear list of changes paired with their impact / conflict.

Then wait for "OK" before editing. This sits inside the Rule 4 plan — the three-step report is what the Why / Change / Outcome / Suggestion is based on, not a replacement for it.

**Why:** *"before touching the code, 1. analyse the code and find the changes to be done. 2. do the the impact / conflict with existing system. 3. list them changes and impact/conflict. these has to be done for every task."*

- How to apply:
  - Applies to every task, no matter how small. "I already know what to change" is not a reason to skip.
  - Read-only investigation is the FIRST tool use, before any Edit / Write.
  - Step 2 must surface every callsite, test, schema, or downstream module that could break — not just the file being edited.
  - The "List" step in chat is short bullets, not a wall of text. Pair each change with its impact in one line.

## Rule 6 — Update the roster on task completion, then persist

When any T-entry / task / sub-phase / item completes, immediately update `docs/PROJECT_TODO.md` to reflect the new status — then commit + push so the change is durable across machines (Rule 2 mechanics).

**Why:** *"on completing any item / task, update the roaster and persist it."*

- How to apply:
  - Applies at every completion boundary: task fully done, sub-phase complete, decision finalized, scope change accepted.
  - Update inline per completion — do not batch multiple completions into one roster sweep.
  - "Persist" = `git add docs/PROJECT_TODO.md && git commit && git push`. A local edit that isn't pushed doesn't count.
  - If the completion also changes design or scope (not just state), update `docs/V2_MASTER_SPEC.md` §9 D-entries as well in the same commit.
  - Show the user the diff / summary of what changed in the roster before moving to the next task.

## How to add new rules

Append at the bottom with format:

```
## Rule N — short title

Body.
**Why:** quote.
- How to apply: bullets.
```

Update no other file. This is the single source of truth.
