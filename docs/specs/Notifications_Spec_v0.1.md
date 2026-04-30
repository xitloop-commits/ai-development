# Notifications Spec — v0.1

**Document:** Notifications_Spec_v0.1.md
**Project:** Automatic Trading System (ATS)
**Status:** Stub (created 2026-04-30 per Phase D8). Locked decisions
should be cited; open items are flagged for resolution before
implementation begins.
**Tracker:** SPEC-110..120 (Phase D8)

---

## 1. Scope

This spec covers the **notification / alert system**: the routing
layer that takes events from the agents (trade fills, exits,
discipline halts, model promotion failures, broker disconnects,
canary divergence flags) and delivers them to the operator via
in-app toasts, persistent in-app inbox, Telegram (TFA bot), and
email.

**Explicitly NOT in scope:**
- The TFA bot's own command surface (covered by the existing
  `tfa_bot/` module — separate from this spec's outbound delivery).
- In-app log viewer (separate observability surface, deferred —
  see `IMPLEMENTATION_PLAN_v2.md` §13).
- Push notifications to mobile native apps (deferred).

## 2. Entities

- **Notification** — a single message with `id`, `severity`
  (`INFO|WARN|ALERT|CRITICAL`), `category`, `title`, `body`,
  `created_at`, `read_at`, `source_agent`, optional `related_id`
  (e.g. `position_id`).
- **NotificationChannel** — the delivery surface
  (`IN_APP_TOAST | IN_APP_INBOX | TELEGRAM | EMAIL`).
- **NotificationRoute** — mapping of `category × severity → channels`.
- **NotificationPreference** — operator-tunable mute / route overrides
  per category.

## 3. Endpoints / API Surface

- `POST /api/notifications/emit` — internal, called by any agent.
  Body: `{ severity, category, title, body, source_agent,
  related_id? }`.
- `GET  /api/notifications/inbox?unread=` — list.
- `POST /api/notifications/:id/read` — mark read.
- `GET  /api/notifications/preferences` — operator settings.
- `POST /api/notifications/preferences` — update.

Outbound adapters (internal, not REST):
- Telegram adapter — wraps existing TFA bot send path.
- Email adapter — provider TBD (see Open Items).
- WebSocket push to UI for live toasts.

## 4. Decisions Locked

- Telegram is the primary out-of-app channel (already in production
  via `tfa_bot/`). (Source: `IMPLEMENTATION_PLAN_v2.md` §7 — TFA bot
  is the existing operator interface.)
- `CRITICAL` severity (capital cap hit, broker disconnect during open
  position, RCA stall) is **always** routed to Telegram regardless
  of preferences. (Source: spec intent — safety floor cannot be
  muted.)
- All emitted notifications are persisted to the in-app inbox even if
  also pushed to Telegram. (Source: spec intent — operator must have
  one place to audit history.)

## 5. Open Items

- **Email provider:** SES vs. SMTP relay vs. none-in-v0. Impact:
  operational complexity, cost.
- **Inbox retention:** 30 / 90 / 365 days? Impact: storage.
- **De-duplication / coalescing:** if RCA emits 50 identical "monitor
  lag" warnings in 10s, do we coalesce? Impact: alert fatigue.
- **Quiet hours:** does the operator get to mute non-critical
  Telegram alerts overnight? Impact: preference model.
- **Default route table:** which categories go to which channels
  out-of-the-box. Impact: first-run experience.
- **Cross-account scoping:** does an `ai-live` halt notification go
  to a different operator from the `my-trades` halt? Impact:
  multi-user readiness (likely deferred).

## 6. Dependencies

- `DisciplineAgent_Spec_v1.4.md` — Module 8 emits cap-hit / halt
  events.
- `RiskControlAgent_Spec_v2.0.md` — emits exit + AI-signal-rejected
  events.
- `TradeExecutorAgent_Spec_v1.3.md` — emits fill / rejection events.
- `BrokerServiceAgent_Spec_v1.9.md` — emits disconnect / reconnect
  events (consumed via `Disconnect_Safety_Spec_v0.1.md`).
- `Disconnect_Safety_Spec_v0.1.md` — emits kill-switch events.
- TFA bot (`tfa_bot/`) — Telegram delivery surface.

## 7. Change Log

| Date       | Version | Change           |
|------------|---------|------------------|
| 2026-04-30 | v0.1    | Initial stub     |
