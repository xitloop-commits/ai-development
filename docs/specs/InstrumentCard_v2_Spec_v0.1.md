# Instrument Card v2 Spec — v0.1

**Document:** InstrumentCard_v2_Spec_v0.1.md
**Project:** Automatic Trading System (ATS)
**Status:** Stub (created 2026-04-30 per Phase D8). Locked decisions
should be cited; open items are flagged for resolution before
implementation begins.
**Tracker:** SPEC-110..120 (Phase D8)

---

## 1. Scope

This spec covers the **Instrument Card v2**: the per-instrument
display block surfaced on the TradingDesk and MainScreen views,
showing live quote, depth, OI snapshot, AI confidence, current
position state (if any), and recent SEA signal history. v2
supersedes the v1 informal layout used during the Python monolith
era.

**Explicitly NOT in scope:**
- The chart rendering library / candle stream (covered separately by
  the chart panel, future spec).
- Placement of the cards inside the screen layout
  (owned by `MainScreen_Spec_v1.3.md` and `TradingDesk_Spec_v1.3.md`).
- Order entry forms triggered from the card (owned by TradingDesk).

## 2. Entities

- **InstrumentCardModel** — the view-model bound to one card:
  `instrument_id`, `ltp`, `bid/ask`, `oi_summary`, `ai_confidence`,
  `position_state`, `last_signal`.
- **CardStateBadge** — the visual indicator showing whether the
  instrument is `IDLE`, `WATCHED`, `IN_POSITION`, or `BLOCKED`
  (Discipline halt).
- **CardActionMenu** — overflow menu for quick actions (pin,
  watch-list toggle, jump-to-chart). Action wiring is host-screen
  responsibility.

## 3. Endpoints / API Surface

UI-only — composes existing endpoints.
Read sources (no new endpoints introduced by this spec):

- Live quotes: existing broker WebSocket / quote service.
- OI summary: existing TickFeatureAgent stream.
- AI confidence: latest SEA signal for the instrument.
- Position state: `GET /api/portfolio/positions`.
- Discipline status: `GET /api/discipline/status`.

## 4. Decisions Locked

- One card per instrument; instrument identity comes from the
  centralized instrument registry. (Source: existing
  `TickFeatureAgent_Spec_v1.7.md` instrument keying.)
- Position state on a card is read from Portfolio Agent only — never
  inferred from broker WebSocket directly. (Source:
  `ARCHITECTURE_REFACTOR_PLAN.md` §5 — Portfolio is single source of
  position truth.)
- Cards do NOT call broker APIs. (Source:
  `ARCHITECTURE_REFACTOR_PLAN.md` Key Principle #1.)

## 5. Open Items

- **Information density:** "compact" vs. "detailed" layout — both,
  with a toggle, or a single fixed layout? Impact: design system,
  responsiveness.
- **AI confidence display:** numeric (0-1) vs. badge (LOW/MED/HIGH)
  vs. both. Impact: user-perceived precision.
- **Refresh cadence:** push (WebSocket) vs. pull (1s poll) for OI and
  AI confidence — different from price tick. Impact: backend load.
- **Action menu contents:** which actions belong on the card vs. on
  the parent screen toolbar. Impact: discoverability.
- **Card state transitions:** animation? color flash on signal? or
  silent. Impact: UX, accessibility.
- **Multi-leg / option-chain instruments:** does an option strike get
  its own card, or does the underlying card host all strikes
  inline? Impact: layout complexity.

## 6. Dependencies

- `MainScreen_Spec_v1.3.md` — host surface.
- `TradingDesk_Spec_v1.3.md` — host surface.
- `TickFeatureAgent_Spec_v1.7.md` — OI / feature data.
- `PortfolioAgent_Spec_v1.3.md` — position state.
- `DisciplineAgent_Spec_v1.4.md` — block state.

## 7. Change Log

| Date       | Version | Change           |
|------------|---------|------------------|
| 2026-04-30 | v0.1    | Initial stub     |
