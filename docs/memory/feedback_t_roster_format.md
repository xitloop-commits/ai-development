---
name: feedback-t-roster-format
description: "When Partha asks for \"T-entry roster\", \"T-status\", \"PROJECT_TODO status\", or \"hierarchy\", produce two artifacts in this exact format — re-read PROJECT_TODO.md each time, never cache. Updated 2026-05-22 to include timeline-window classification."
metadata:
  node_type: memory
  type: feedback
  originSessionId: cb6a3369-fbcd-4914-ab7c-44c312f28f37
---

When Partha asks for "T-entry roster," "T-status," "PROJECT_TODO status," "the hierarchy," or any variation of "give me the latest" referring to project work tracking, produce these two artifacts in this exact order and format.

**Why:** Partha explicitly asked on 2026-05-17 EOD: "remember this t entry roster and hierarchy, when i ask please give me with latest update." On 2026-05-22 he upgraded the format to include a timeline-window column + window-bucketed hierarchy after a system audit revealed pre-Day-30 / post-training work splits.

**How to apply:** when asked, ALWAYS first read `c:\Users\Admin\ai-development\ai-development\docs\PROJECT_TODO.md` end-to-end. Never cache the state from a prior conversation turn — phases may have shipped, statuses change daily. Pull live status from the TODO file + any cross-checks against `docs/V2_MASTER_SPEC.md` §9 D-entries if needed for sub-phase status.

---

## Artifact 1 — T-entry roster (4-column markdown table)

Columns (in order): `T#` · `Title` · `Status` · `Window`

Rows: every T-entry currently present in PROJECT_TODO.md, in numeric order. Include closed entries with strikethrough (`~~T1~~`) and a "(closed in prior pass)" note if their absence from current TODO would confuse the reader. Bold the row of the actively-in-flight task (currently T3).

**Status emoji legend (always use these):**
- ✅ Complete
- 🚧 Active (currently in flight, or partial)
- ⏳ Pending / Housekeeping (not yet started)
- 🕒 Wait-for-data / Wait-for-paper / Out-of-scope

**Window emoji legend (always use these — added 2026-05-22):**
- 📦 PRE-ACC — foundation work, completed before data accumulation began
- 📊 DURING-ACC — during the 30-session accumulation window (Day 1=2026-05-20 → Day 30=2026-06-30), HARD DEADLINE = Day 30 (first auto-retrain Sat 2026-07-04)
- 🎯 POST-TRAIN — after training fires; further split into "pre-paper-trade" (gates Phase 7), "paper trade ramp" itself, and "post-paper-trade upgrades" (need fill data)

When a T-entry has phases (like T3), show only the top-level status in this table — the phase breakdown lives in Artifact 2. Mark newly-added items with 🆕 next to the T# (e.g., `T23 🆕`).

---

## Artifact 2 — Hierarchy diagram, organized by window

ASCII tree organized as three top-level branches (📦 PRE-ACC / 📊 DURING-ACC / 🎯 POST-TRAIN) instead of strict numeric order. Within POST-TRAIN, further sub-bucket into: training event / pre-paper-trade / paper trade ramp / post-paper-trade upgrades / long-term-hold / housekeeping.

Structure:

```
TIMELINE (today = <YYYY-MM-DD>)
│
├── 📦 PRE-ACC — Foundation (complete, no action) ────────────
│   ├── T2  ──── ✅ <status>
│   ├── T3 Phase 1: <name>                    ✅  <date>
│   ├── T3 Phase 2: <name>                    ✅  <date + commits>
│   ├── T3 Phase 3: <name>                    ✅  <date + commits>
│   └── T5  ──── ✅ <status>
│
├── 📊 DURING-ACC — Day 1=<date> → Day 30=<date> ─────────────
│   │  HARD DEADLINE: <Day 30 date> (training fires Sat <date>)
│   │  Effort: ~<X-Y> engineering days
│   │
│   ├── T3 Phase 4: <name>                    🚧  ACTIVE (passive)
│   ├── T<N> 🆕 <name>                        ⏳  MUST/SHOULD (~<effort>)
│   └── ...
│
└── 🎯 POST-TRAIN — From Sat <training date> onwards ──────────
    │
    ├── ── Training event ─────────────────────────
    │   └── T3 Phase 5: <name>                ⏳  Sat <date>
    │
    ├── ── Pre-paper-trade (gates Phase 7) ────────
    │   │  Effort: ~<X-Y> days; can start parallel to DURING-ACC
    │   ├── T<N> 🆕 <name>                    ⏳  MUST (~<effort>)
    │   ├── ...
    │   └── T3 Phase 6: <name>                ⏳  After T<N>-T<M>
    │
    ├── ── Paper trade ramp ───────────────────────
    │   └── T3 Phase 7: <name>                ⏳  Wall-clock weeks
    │
    ├── ── Post-paper-trade upgrades ──────────────
    │   ├── T<N> <name>                       🕒  <trigger condition>
    │   └── ...
    │
    ├── ── Long-term parallel (HOLD) ──────────────
    │   └── T<N> <name>                       🕒  HOLD <condition>
    │
    └── ── Low priority / housekeeping ────────────
        ├── T<N> <name>                       ⏳  <status>
        └── ...
```

For phases that have shipped, include the date + commit range in parentheses inline with the phase line (e.g. `(2026-05-18, commits 50d9bec → 54fa8b0)`). For the actively-running phase, include a one-line description of what's happening.

---

## Artifact 3 (optional) — "What changed since last update"

If you have visibility into a prior status snapshot from earlier in the conversation OR can compare against git history since the last commit you remember, include a brief "What changed" section before the artifacts. Format as a 2-3 row table: `Change` · `Impact`.

Only include this if there ARE meaningful changes. If nothing has moved since the last status report, skip.

---

## Artifact 4 (optional) — "What's next"

Two-sentence max. State the next genuine action (which phase / which task / which open question) and whether it's code-bound (a session of work) or wall-clock-bound (waiting for data / external trigger).

Only include if the user is asking in a "what should I do next?" frame. If they're asking purely for a status snapshot, skip.

---

**Format invariants (never change):**
- Status emojis are exactly the 4 listed above. Don't invent new ones.
- Window emojis are exactly the 3 listed above. Don't invent new ones.
- T-entries in Artifact 1 are listed in numeric order; T-entries in Artifact 2 are bucketed by window (not numeric).
- Don't add design opinions to the roster. It's a state report, not a recommendation.
- Cross-reference V2_MASTER_SPEC §9 D-entry numbers when phases have constraints (e.g. "schema v7 per D66").
- Mark newly-added items with 🆕 next to the T# in BOTH artifacts.
- For Group A items (DURING-ACC MUST) and Group B items (POST-TRAIN pre-paper MUST), show the effort estimate inline.

Cross-refs: [[user-role]] [[feedback-questions-inline]] (also a working-style preference).