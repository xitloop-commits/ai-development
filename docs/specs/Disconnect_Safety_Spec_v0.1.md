# Disconnect Safety Spec — v0.1

**Document:** Disconnect_Safety_Spec_v0.1.md
**Project:** Automatic Trading System (ATS)
**Status:** Stub (created 2026-04-30 per Phase D8). Locked decisions
should be cited; open items are flagged for resolution before
implementation begins.
**Tracker:** SPEC-110..120 (Phase D8)

---

## 1. Scope

This spec covers **disconnect-safety behavior**: what the system does
when the broker WebSocket dies, when the broker REST API stops
responding, when the Python SEA worker stalls, or when the in-process
RCA monitoring loop falls behind. The default posture is
**fail-closed**: a kill-switch blocks new entries and surfaces an
alert; existing positions are handled per the rules below.

This spec is the policy floor that anchors the
`B4 BROKER_DESYNC` mitigation in `IMPLEMENTATION_PLAN_v2.md` §4 and
the live-trading sign-off gate (Phase I §3).

**Explicitly NOT in scope:**
- The reconnect logic of the broker SDK itself
  (owned by `BrokerServiceAgent_Spec_v1.9.md`).
- The session-halt flag (owned by `DisciplineAgent_Spec_v1.4.md`
  Module 8).
- Network-level monitoring / uptime alerts
  (deferred — see `IMPLEMENTATION_PLAN_v2.md` §13).

## 2. Entities

- **DisconnectEvent** — one of:
  `BROKER_WS_DOWN`, `BROKER_REST_DOWN`, `SEA_HEARTBEAT_MISSED`,
  `RCA_LOOP_STALLED`, `BROKER_DESYNC` (positions reported by broker
  diverge from Portfolio Agent).
- **KillSwitchState** — `INACTIVE | ACTIVE | OPERATOR_OVERRIDE`.
- **SafetyDirective** — the system's response per event:
  `BLOCK_NEW_ENTRIES`, `EXIT_ALL_OPEN`, `FREEZE_MODIFICATIONS`,
  `NOTIFY_ONLY`.
- **DesyncReconciler** — process that compares broker positions vs.
  Portfolio positions on resume and surfaces discrepancies.

## 3. Endpoints / API Surface

- `GET  /api/safety/state` — current `KillSwitchState` + active
  `DisconnectEvent` list.
- `POST /api/safety/activate` — operator-triggered manual kill-switch.
- `POST /api/safety/clear-desync-block` — operator override
  (already referenced in `IMPLEMENTATION_PLAN_v2.md` §13 risk #3).
- `POST /api/safety/event` — internal, agents emit
  `DisconnectEvent` here.

Outbound:
- Notification emit on every state transition (see
  `Notifications_Spec_v0.1.md`).
- `discipline-request` to RCA when policy says EXIT_OPEN.

## 4. Decisions Locked

- The kill-switch **blocks new entries** by default on any
  `DisconnectEvent`. (Source: `IMPLEMENTATION_PLAN_v2.md` §4 B4
  acceptance — BROKER_DESYNC blocks new entries.)
- Operator override exists for `BROKER_DESYNC` via
  `POST /api/discipline/clear-desync-block` (named in
  `IMPLEMENTATION_PLAN_v2.md` §13 risk #3).
- During a disconnect, RCA stops issuing modify orders; existing
  broker-side SL/TP remain attached. (Source: `RiskControlAgent_Spec_v2.0`
  — broker manages SL/TP on live; RCA is backup.)
- Critical disconnect events route to Telegram unconditionally.
  (Source: `Notifications_Spec_v0.1.md` §4.)

## 5. Open Items

- **Auto-EXIT on disconnect:** for `ai-live` and `my-trades`, do we
  auto-exit open positions on prolonged WS loss, or rely on
  broker-side SL/TP? Impact: capital protection vs. spurious exits.
  Likely policy depends on time-of-day proximity to close.
- **Stall thresholds:** how many seconds of WS silence before
  declaring `BROKER_WS_DOWN`? RCA loop lag threshold? Impact:
  false-positive rate.
- **Reconciliation policy on resume:** if broker shows a position
  that Portfolio Agent doesn't (or vice versa), do we trust broker,
  trust Portfolio, or block until operator confirms? Impact:
  correctness floor.
- **Auto-clear:** after how long of healthy state does the
  kill-switch auto-deactivate, or is it always operator-cleared?
  Impact: operator burden.
- **Per-account vs. global:** does a `BROKER_WS_DOWN` event halt
  every account or only the affected one? (For Dhan single-broker
  today, likely global; future multi-broker — per-broker.)
- **Heartbeat mechanism for SEA:** push from SEA vs. pull from RCA?
  Impact: liveness detection latency.

## 6. Dependencies

- `BrokerServiceAgent_Spec_v1.9.md` — emits broker connectivity
  events.
- `RiskControlAgent_Spec_v2.0.md` — receives EXIT_OPEN directives.
- `DisciplineAgent_Spec_v1.4.md` — Module 8 cooperates on session
  halt; B4 mitigation lives at the boundary.
- `PortfolioAgent_Spec_v1.3.md` — provides position truth for
  desync reconciliation.
- `Notifications_Spec_v0.1.md` — delivery surface for kill-switch
  alerts.
- `AILiveCanary_Spec_v0.1.md` — kill-switch is the canary safety net.

## 7. Change Log

| Date       | Version | Change           |
|------------|---------|------------------|
| 2026-04-30 | v0.1    | Initial stub     |
