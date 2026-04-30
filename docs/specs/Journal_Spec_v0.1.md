# Journal Spec — v0.1

**Document:** Journal_Spec_v0.1.md
**Project:** Automatic Trading System (ATS)
**Status:** Stub (created 2026-04-30 per Phase D8). Locked decisions
should be cited; open items are flagged for resolution before
implementation begins.
**Tracker:** SPEC-110..120 (Phase D8)

---

## 1. Scope

This spec covers the **Trade Journal** feature: the structured record
of every trade taken (paper, ai-paper, ai-live, my-trades), the
operator-authored notes attached to each trade, and the weekly /
monthly review surfaces that read from the journal. The journal is the
authoritative human-readable history of "what happened and why,"
complementing the machine record owned by Portfolio Agent.

**Explicitly NOT in scope:**
- The raw trade outcome record (owned by `PortfolioAgent_Spec_v1.3`).
- The discipline streak / cooldown logic (owned by `DisciplineAgent_Spec_v1.4`
  Modules 6 & 7).
- Backtest result storage (deferred — see `IMPLEMENTATION_PLAN_v2.md` §13).
- Auto-generated trade narratives from AI (deferred to FeedbackAgent
  per `ARCHITECTURE_REFACTOR_PLAN.md` Phase 7).

## 2. Entities

- **JournalEntry** — one per closed trade; references `position_id`,
  carries operator notes, screenshots, tags, post-trade rating.
- **JournalTag** — categorical labels (e.g. `breakout`, `stop-hunt`,
  `discipline-violation`, `tilt`).
- **WeeklyReview** — aggregate over a calendar week; references the
  journal entries within the window.
- **JournalAttachment** — chart screenshot or external file linked to
  an entry.

## 3. Endpoints / API Surface

UI-driven. Tentative shape (to be locked during implementation):

- `GET  /api/journal/entries?from=&to=&account=` — list.
- `GET  /api/journal/entry/:position_id` — fetch one.
- `POST /api/journal/entry/:position_id` — create or update notes /
  rating / tags for a closed position.
- `GET  /api/journal/weekly-review?week=YYYY-WW` — aggregate.
- `POST /api/journal/attachment` — upload screenshot.

## 4. Decisions Locked

- Journal entries are **per closed position**, keyed by `position_id`
  from Portfolio Agent. (Source: `ARCHITECTURE_REFACTOR_PLAN.md` §5,
  Portfolio Agent owns position state.)
- The journal is **append-only** for the operator-authored fields once
  a `WeeklyReview` is locked. (Source: `DisciplineAgent_Spec_v1.4`
  Module 6 framing — weekly review is a discipline checkpoint.)
- Discipline Module 6 (Journal & Weekly Review) is the consumer of
  this surface. (Source: `ARCHITECTURE_REFACTOR_PLAN.md` §2.)

## 5. Open Items

- **Storage backend:** Mongo collection vs. flat-file per week.
  Impact: backup/restore story, query latency.
- **Attachment storage:** local disk vs. S3-style object store. Impact:
  multi-device access, deployment complexity.
- **Editing window:** how long after close can notes be edited before
  they lock for the weekly review? (Default proposal: until 23:59 of
  the same trading day, then read-only.) Impact: user workflow.
- **Tag taxonomy:** free-form vs. controlled vocabulary. Impact:
  searchability, downstream ML feasibility.
- **Account scoping:** does Journal show all accounts in one view, or
  is it filtered by active account from `DualAccountArchitecture_Spec_v0.1`?
  Impact: UI complexity, privacy.
- **Export format:** CSV/PDF for tax / audit. Impact: serialization
  layer.

## 6. Dependencies

- `PortfolioAgent_Spec_v1.3.md` — provides `position_id` and trade
  outcome data.
- `DisciplineAgent_Spec_v1.4.md` — consumer (Module 6 weekly review).
- `DualAccountArchitecture_Spec_v0.1.md` — account scoping for
  multi-account view.
- `MainScreen_Spec_v1.3.md` — UI hosts the journal panel.

## 7. Change Log

| Date       | Version | Change           |
|------------|---------|------------------|
| 2026-04-30 | v0.1    | Initial stub     |
