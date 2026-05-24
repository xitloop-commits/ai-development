# Phase I Runbook — Production Sign-off

**Audience:** operator running I2 / I3 / I4 on a trading day.
**When to use:** open this on the morning of a paper session (I2) or canary live day (I3). Do not use prose — checklist only.
**Source of truth:** `IMPLEMENTATION_PLAN_v2.md` §11 (acceptance criteria); `FINAL_VERIFICATION_TRACKER.md` §7 (gate).

---

## Pre-open (run by 09:00 IST — 15 min before NSE)

### 1. Server health
```bash
curl -s http://127.0.0.1:3000/ready
```
Expect: `{"ready":true,"checks":{"mongo":{"ok":true,...},"broker":{"ok":true},"tickWs":{"ok":true}}}`

If `ready:false` → fix Mongo / broker / WS before market open. **Do not start I2 until all 3 checks are ok.**

### 2. Metrics endpoint
```bash
curl -s http://127.0.0.1:3000/api/_metrics | head -3
```
Expect: Prometheus output (`# HELP ...`). HTML response = wrong path.

### 3. Dhan token
- UI: should NOT show CredentialGate popup.
- If shown: refresh token via Settings → Broker. Do not start I2 with stale token.

### 4. SEA Python feed
```bash
ls -lt data/signals/ | head -3
```
Expect: at least one file modified in the last few hours (or ready to start emitting at market open).

### 5. Channel state
- UI: switch to `ai-paper`. Confirm `currentDayIndex` is sensible (1 if first run, otherwise yesterday + 1).

### 6. Logs streaming
- Open server log tail in a separate window.
- Watch for `pino` JSON output. No exceptions, no "Connection lost", no `unhandledRejection`.

---

## Intra-day watches (during NSE 09:15–15:30 + MCX 09:00–23:30)

### Periodic curl every 30 min
```bash
curl -s http://127.0.0.1:3000/ready | jq .ready
```
Expect: `true`. If `false` mid-day → investigate immediately.

### Watch metrics deltas
```bash
curl -s http://127.0.0.1:3000/api/_metrics | grep -E "tea_(submit|exit)|broker_desync|discipline_validate"
```
Sanity check: counters should advance over the day. `broker_desync_*` should stay at 0.

### Telegram alerts
Should fire on: token refresh, BROKER_DESYNC, discipline cap-trip, kill-switch flip. Silence = good unless something specific is expected.

### Discipline cap-trip drill (I2 day 2 only)
Per spec, deliberately trip the daily-loss cap near 15:00 IST on I2 day 2 (e.g. simulate via tRPC mutation or manual override). Confirm:
1. Grace timer fires (60s default).
2. Auto-MUST_EXIT triggers all positions.
3. Positions close cleanly. No BROKER_DESYNC.
4. Settings shows kill-switch active for the channel.

---

## Day-end pass criteria

### I2 day 1 / day 2
- [ ] Zero unhandled rejections in pino output for the full session.
- [ ] Zero `BROKER_DESYNC` events.
- [ ] Zero crashes (server stayed up).
- [ ] Daily P&L matches manual recompute within **₹1**. To recompute manually: sum `(exitPrice - entryPrice) × qty - charges` for every closed trade in the channel.
- [ ] (Day 2 only) Module 8 cap + carry-forward fired as expected during the drill.

### I3 canary
- [ ] All of I2 criteria PLUS:
- [ ] Capital `₹50,000`, max **1 lot per trade** (cap enforced — `aiLiveLotCap=1`).
- [ ] Operator on standby with intervention authority for the entire session.
- [ ] Every order traces SEA → Discipline → RCA → TEA → broker → PA → Module 8 — no skipped step (verify in pino correlation IDs).
- [ ] Dhan trade book ↔ PA position state diff: **zero** at end of day. Cross-check by exporting Dhan trades and comparing with `portfolio.allDays.currentDay.trades`.

---

## Abort triggers (stop trading immediately)

Stop = flip kill-switch via Settings, then either fix or stand down for the day.

1. **Two `BROKER_DESYNC` events** within an hour → broker connectivity unstable; pause and reconcile manually.
2. **Cap fires but UI overlay doesn't surface** → known limitation (UI-122 deferred); operator must use Settings kill-switch within the 60s grace timer.
3. **Mongo disconnect** for >30s without auto-reconnect → restart server after market close.
4. **PA position diff** vs broker book at any reconciliation tick → BROKER_DESYNC; flip kill-switch immediately, do not place new orders until reconciled.
5. **Pino logs >100 errors/minute** → something's looping; investigate root cause.
6. **(I3 only)** Any single trade size >1 lot → cap was bypassed; halt + audit.

---

## Sign-off (I4)

When I2 (2 days) AND I3 (1 canary day) both pass:

```bash
# 1. Update FINAL_VERIFICATION_TRACKER.md §10 change log:
#    "| 2026-MM-DD | v1.3 — Production-grade certified by sarathisubramanian@gmail.com after I2+I3 pass |"
# 2. Update IMPLEMENTATION_PLAN_v2.md §15 change log with the same line
# 3. Tick the four §7 Sign-off checkboxes in the tracker
# 4. Tag:
git tag -a production-grade-v1 -m "Production-grade after Phase I (I1+I2+I3+I4) — see FINAL_VERIFICATION_TRACKER.md §10"
git push --tags    # only if confirmed
```

After the tag: 250-day compounding runs unattended (Module 8 caps + Discipline + RCA enforce the discipline so you don't have to babysit).

---

## Endpoints quick-reference

| Path | Purpose |
|---|---|
| `GET /ready` | Liveness: returns 503 until Mongo + adapters init, then 200 with checks |
| `GET /api/_metrics` | Prometheus metrics (auth-prefixed; not `/metrics`) |
| `POST /api/risk-control/evaluate` | RCA pre-trade gate (Discipline → here) |
| `POST /api/risk-control/discipline-request` | Discipline MUST_EXIT/PARTIAL_EXIT push |
| tRPC `discipline.acknowledgeCapGrace` | Operator action during cap-trip grace timer (mutation) |

## Files / dirs to watch on disk

| Path | What it tells you |
|---|---|
| `data/signals/` | SEA-emitted ndjson — fresh files = SEA alive |
| `data/features/*_live.ndjson` | TFA features — DO NOT delete (training/backtest data) |
| `models/<instrument>/LATEST/` | Active model — refresh only via promotion validator (post-canary) |
| Server log (pino JSON via stdout/file) | All correlation IDs propagated; grep by `tradeId` or `requestId` to follow one order end-to-end |
