# Partha's rules for working with Claude on this project

Single source of truth. Read at session start, every session, on every machine. CLAUDE.md auto-loads this file.

---

# Main rules — top priority

These take precedence over any supporting rule below on conflict.

## Main Rule 1 — Simple, short, layman English

Always explain in simple, short, layman English. Avoid heavy or overly long responses.

## Main Rule 2 — Pre-implementation checklist

Before starting any implementation or task, clearly list:

- 2.1 Why this change is needed
- 2.2 Expected outcome
- 2.3 What changes will be made
- 2.4 Whether it can break existing systems
- 2.5 Overall impact
- 2.6 Layman-friendly example or analogy that makes the change understandable to a non-coder
- 2.7 Where this fits in the system + flow using arrows (e.g. `parquet → trainer → fold pass → sim_pnl → scorecard.json`)

## Main Rule 3 — Post-implementation checklist

After implementation, ensure:

- 3.1 Relevant test cases are added or updated
- 3.2 Related specs and roster / docs are updated

## Main Rule 4 — Question format

When asking the user questions, ask only in the conversation thread (no modals) and include:

- 4.1 Why the question matters
- 4.2 Expected outcome
- 4.3 Possible options / suggestions
- 4.4 Claude's best recommendation for the best system design

## Main Rule 5 — Multi-question sequencing

If multiple questions are needed:

- 5.1 Ask only one question at a time
- 5.2 Follow Main Rule 4 for every question
- 5.3 Remember all decisions
- 5.4 Update specs / roster if needed before implementation starts

---

# Supporting rules

Original behavioral rules — still in force, but Main Rules above win on any conflict.

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

## Rule 7 — Ask design questions inline, not via modal

When you need a design choice or clarification, ask in chat as plain markdown prose with lettered options (A / B / C ...) and a one-line recommendation. Do NOT use the AskUserQuestion modal popup.

**Why:** *"ask here, not adaptive question window"* (2026-05-17) — the modal breaks conversational flow and forces a context switch.

- How to apply:
  - Default format: `**Question.**` then `A. Label — tradeoff`, `B. Label — tradeoff`, then `My recommendation: A (one-line reason).`
  - Multi-select: say so explicitly ("pick any combination").
  - Yes / no with caveats: just ask in prose.
  - AskUserQuestion is reserved for cases where the user explicitly asks for a picker, OR when 4+ visually-similar options genuinely benefit from side-by-side comparison.

## Rule 8 — T-roster format on request

When the user asks for "T-roster," "T-status," "PROJECT_TODO status," "the hierarchy," or any variant of "give me the latest" referring to project work, produce two artifacts in this exact order:

1. A 4-column markdown table: `T#` · `Title` · `Status` · `Window` (one row per T-entry in numeric order, status emoji + window emoji per the legend).
2. An ASCII hierarchy tree bucketed by window (📦 PRE-ACC / 📊 DURING-ACC / 🎯 POST-TRAIN), with POST-TRAIN further split into training event / pre-paper-trade / paper trade ramp / post-paper-trade upgrades / long-term-hold / housekeeping.

Always re-read `docs/PROJECT_TODO.md` end-to-end first; never cache the prior turn's snapshot — statuses change.

**Why:** *"remember this t entry roster and hierarchy, when i ask please give me with latest update."* (2026-05-17) + 2026-05-22 window-bucket upgrade.

- How to apply:
  - Status emojis: ✅ Complete · 🚧 Active · ⏳ Pending · 🕒 Wait-for-data / HOLD. Don't invent new ones.
  - Window emojis: 📦 PRE-ACC · 📊 DURING-ACC · 🎯 POST-TRAIN. Don't invent new ones.
  - Bold the row of the actively-in-flight task.
  - Mark newly-added items with 🆕 next to the T# in both artifacts.
  - Full format spec (effort estimates, optional "what changed" + "what's next" artifacts) lives in the per-machine memory `feedback_t_roster_format.md`.

## How to add new rules

Append at the bottom with format:

```
## Rule N — short title

Body.
**Why:** quote.
- How to apply: bullets.
```

Update no other file. This is the single source of truth.
