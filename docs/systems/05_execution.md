# 05 — Execution

Single source of truth for the **broker-facing trading layer**: BrokerServiceAgent (BSA), TradeExecutorAgent (TEA), dual-account routing, and disconnect-safety. Everything between a Discipline-approved signal and a Dhan order acknowledgement.

## 1. Purpose & Scope

**In scope:**
- BSA — single broker-abstraction gateway, 4 adapter slots (`dhanLive`, `dhanAiData`, `mock-ai`, `mock-my`), 5-channel routing.
- TEA — singular broker-caller; `submitTrade` / `modifyOrder` / `exitTrade` APIs; idempotency; paper-side SL/TP monitoring; DISCIPLINE_EXIT handling.
- Order-update WebSocket (broker → TEA reconciliation).
- Recovery engine for stale orders (PENDING > 60 s background poller).
- Dhan token lifecycle on the **trading side** (TOTP + startup-only refresh policy).
- Dual-account topology — primary `dhan-primary-ac` (user PAN) vs spouse `dhan-secondary-ac` (independent capital pools).
- Disconnect safety — kill-switch per workspace, exits bypass, position reconciliation.
- AI Live canary ramp gates (the execution-side promotion criteria).

**Out of scope:**
- Pre-trade gate logic, capital protection, daily-loss budget, layer caps → [06 Risk & Discipline](06_risk_discipline.md).
- Position state ownership, P&L, journal → [07 Portfolio & Reporting](07_portfolio_reporting.md).
- Dhan WS for **market data** (TFA subscriptions) → [01 Data Ingestion](01_data_ingestion.md).
- Signal generation → [04 Signal Engine](04_signal_engine.md).
- Launcher orchestration, scheduled tasks → [10 Launcher & Ops](10_launcher_ops.md).

## 2. Architecture at a glance

```
                Discipline (06) — gate / approval / MUST_EXIT
                                │
                                ▼
                          TEA (sole broker caller)
                ┌──────────────┼──────────────┐
                │              │              │
       submitTrade        modifyOrder      exitTrade
                │
                ▼
            idempotency check (executionId dedup)
                │
                ▼
            BSA.getAdapter(channel)
       ┌───────────────┼───────────────┐
       ▼          ▼          ▼          ▼
    dhanLive  dhanAiData  mock-ai  mock-my
       │          │          │         │
       │          │          └─────┬───┘
       │          │                ▼
       │          │         instant-fill paper
       ▼          ▼
   primary    spouse
   account    account
       │          │
       └────┬─────┘
            ▼
       Dhan REST API (orders) + Dhan WS (order-update stream)
            │
            ▼
       orderSync → TEA reconciles fills → 07 Portfolio.applyFill()
            │
            ▼
       recoveryEngine background poll for PENDING > 60s
```

## 3. The five channels

Channels are the product of **workspace × mode**:

| Channel | Workspace | Mode | Adapter | Purpose |
|---|---|---|---|---|
| `ai-live` | AI | Live | `dhanAiData` (spouse) | Real-money AI trades |
| `ai-paper` | AI | Paper | `mock-ai` | AI signals against simulated broker |
| `my-live` | My | Live | `dhanLive` (primary) | Partha's manual trading |
| `my-paper` | My | Paper | `mock-my` | Partha's paper testing |
| `testing-live` | Testing | Live | `dhanLive` | Manual integration testing against live broker |

`BSAAdapters.getAdapter(channel)` returns the right instance. The Dhan sandbox channel (`testing-sandbox` / `dhanSandbox`) was removed 2026-06-19 — sandbox can't exercise live Super Orders (404) and its broken lot sizing produced false DH-905 rejections.

## 4. The two Dhan accounts

| Account | Dhan Client ID | WS subscriptions | Order channels owned |
|---|---|---|---|
| `dhan-primary-ac` (primary) | `1101615161` | 1 UI tick + 1 order-update = **2 / 5** | `my-live`, `testing-live` |
| `dhan-secondary-ac` (spouse) | `1111388877` | 4 TFA (System 01) + 1 order-update = **5 / 5** | `ai-live` |

**Independent capital pools.** AI Live capital is funded from the spouse's own income/savings (no gift trail — tax-clubbing risk resolved 2026-04-25). The dual-account design is what lets the platform run real-money AI Live and Partha's manual trading on the same desk without WebSocket contention or commingled capital.

**Head-to-Head reporting** — per-workspace P&L, win-rate, Sharpe — covered in [07 Portfolio & Reporting](07_portfolio_reporting.md).

## 5. Trade Executor invariants

Three rules enforced by code, not just convention:

1. **Single-broker-caller.** TEA is the only module that calls `brokerService.placeOrder` / `modifyOrder` / `cancelOrder`. Any other call site is a bug. Comment at `tradeExecutor.ts:8-10` calls this out; PRs that violate it should fail review.
2. **Single Portfolio writer.** TEA is also the only module that updates Portfolio state from fills. SEA never touches Portfolio; Discipline never touches Portfolio. Single-writer prevents desync.
3. **Idempotency at the submit boundary.** Every TEA submission carries an `executionId`. The `idempotencyStore` deduplicates retries — same `executionId` submitted twice → second call short-circuits to the first call's result.

## 6. Paper vs live divergence

**Paper** (`mock-ai`, `mock-my`):
- Fills are instant at the touch price.
- SL / TP / TSL are monitored **locally by TEA** via a tick subscription. When a level fires, TEA closes the position itself.
- DISCIPLINE_EXIT (force-close from Discipline Module 8) runs the same code path as a normal exit — instant.

**Live** (`dhanLive`, `dhanAiData`):
- SL / TP are placed as **broker orders** alongside the entry. The broker enforces them — TEA doesn't poll, it waits for the broker's `OrderUpdate` event over WS.
- DISCIPLINE_EXIT is a high-priority market exit: skip pre-trade validation, retry-once on failure, record in Portfolio with `exitTriggeredBy: "DISCIPLINE"`.
- TSL (trailing stop) is computed by TEA (the broker doesn't support our flavour) and submitted as a `modifyOrder` on each ratchet tick.

`isPaperChannel()` / `isLiveChannel()` (in `tradeExecutor.ts:57-70`) dispatch between the two paths.

## 7. Token lifecycle (trading side)

Same policy as the data side (see [01 Data Ingestion §5](01_data_ingestion.md)):

- Each Dhan broker (`dhan-primary-ac`, `dhan-secondary-ac`) has its own `tokenManager` instance with independent TOTP + access-token state.
- Refresh **only at startup**. `tokenAge < 2 h` → skip the refresh entirely (trust the cached token across rapid restarts).
- Mid-session 401 → mark token expired, alert via yow-partha Telegram, **wait for manual restart**. No automatic retry.
- TOTP is RFC 6238 HMAC-SHA1 generated locally from the secret in MongoDB `broker_configs`.

Implementation: `server/broker/adapters/dhan/{auth.ts, tokenManager.ts}`. Decision locked by DHAN_TOKEN_POLICY 2026-05-06 after a racing-refresh incident.

## 8. Order reconciliation + recovery

`orderSync` subscribes to the Dhan order-update WebSocket and feeds every state transition into TEA, which updates Portfolio.

`recoveryEngine` runs a background loop that polls for orders stuck in `PENDING` for > 60 s. If found, it calls the Dhan REST `getOrderStatus` and reconciles. This catches orders where the WS event was dropped during a disconnect.

Both are required for live trading — paper-only deployments can leave them disabled but it's cheap to keep them on.

## 9. Disconnect safety

A `DisconnectEvent` (broker WS dies, REST returns 5xx in a row, broker IP bans the session) toggles a **per-workspace kill-switch**:

- New entries on the affected workspace → **rejected** at TEA submit boundary.
- Exits on the affected workspace → **always allowed through** (you can always close a position).
- Other workspaces are unaffected (independent kill-switches per workspace per `KillSwitchState` in `brokerService.ts:70-80`).

**On reconnect** the design (`Disconnect_Safety_Spec` §2) calls for a `DesyncReconciler` to compare broker-side positions against Portfolio Agent positions and surface any drift. **Today the reconciler is a stub** — kill-switch + alerting are wired, the position-compare logic isn't. Tracked as [T45 [BSA]](../PROJECT_TODO.md).

Auto-clear of the kill-switch on health recovery is intentionally not implemented — operator decides when to flip it back on (canary-era conservatism).

## 10. AI Live canary ramp

Eight pre-launch gates must all be GREEN before `ai-live` capital goes above ₹0:

1. `ai-paper` channel has run for ≥ 14 calendar days with no executor crashes.
2. `ai-paper` win-rate ≥ 45 % on ≥ 50 fills per instrument.
3. TEA single-broker-caller invariant validated by audit.
4. AI-Live channel hard-capped at 1 lot per trade (`AI_LIVE_LOT_CAP` setting).
5. Spouse account funded and credentialled in `broker_configs`.
6. Dhan ToS confirmation for the spouse-account pattern (tracked as [T38](../PROJECT_TODO.md)).
7. Head-to-Head dashboard live with ai-live vs my-live divergence ≤ 5 pp on the prior 14-day paper window.
8. Disconnect kill-switch tested end-to-end (manual force-disconnect drill).

Lot-cap auto-increment after the first 30-day live window is intentionally deferred — the operator promotes manually per AILiveCanary spec open question 1.

## 11. Test coverage

TypeScript test suites under `server/broker/__tests__/` and `server/executor/__tests__/`. Covers:

- BSA channel routing (every channel maps to the right adapter).
- Kill-switch isolation (one workspace tripped doesn't affect others).
- TEA submit → idempotency → broker dispatch happy path.
- TEA paper auto-exit on SL / TP.
- TEA DISCIPLINE_EXIT high-priority path.
- Recovery engine reconciliation against canned `OrderUpdate` streams.
- Mock adapters return well-formed fills.

Token refresh has unit coverage at `server/broker/adapters/dhan/auth.test.ts` (incl. the loopback bypass for the bootstrap token endpoint).

## 12. Status

**ACTIVE.** Phases 1–5 complete. Dual-account live since 2026-04-25. AI Live currently under canary discipline (1-lot cap, ₹50k cap on `ai-live`). Day-30 canary review window opens 2026-05-25.

**Known gaps (not blocking paper-trade):**
- [T45 [BSA]](../PROJECT_TODO.md) — `DesyncReconciler` position-compare logic (stub today; kill-switch + alert work, the reconcile step doesn't).
- [T38](../PROJECT_TODO.md) — Dhan ToS confirmation for the spouse-account pattern (admin task, blocks AI-Live capital scale-up).
- BSA v1.9 §11.5 — `GET /api/broker/token` unmasked-credential endpoint is spec'd but not implemented; TFA fetches credentials via an alternative path today, so non-blocking.
- BSA v1.9 §11.6 — REST `POST /api/broker/feed/{subscribe,unsubscribe}` and `GET /api/broker/feed/state` are spec'd but not implemented; browser-only consumers use tRPC which works fine — non-blocking.

**Pending paper-trade-fills-gated improvements (existing T-entries):**
- [T15](../PROJECT_TODO.md) — Limit-order optimization (gated on ≥ 200 paper fills, MCX-first per Gemini feedback).
- [T10](../PROJECT_TODO.md) — Recalibrate `slippage_pct_per_strike_distance` from real paper fills.
- [T11](../PROJECT_TODO.md) — Slippage model Option B → C (volume-conditional).

## 13. Cross-refs

- [01 Data Ingestion](01_data_ingestion.md) — shares Dhan WS client + token-refresh policy; documents the WS-allocation half of the dual-account topology.
- [04 Signal Engine](04_signal_engine.md) — upstream producer; signals come through Discipline first.
- [06 Risk & Discipline](06_risk_discipline.md) — pre-trade gate + ongoing monitor; emits MUST_EXIT signals into TEA.
- [07 Portfolio & Reporting](07_portfolio_reporting.md) — receives fills from TEA; pushes daily P&L back to Discipline.
- [10 Launcher & Ops](10_launcher_ops.md) — AI Live canary playbook + scheduled-task hosting.

## 14. Code locations

| What | Path |
|---|---|
| BSA gateway + 6-channel routing | `server/broker/brokerService.ts` |
| Channel router + kill-switch state | `server/broker/brokerService.ts` (`BSAAdapters`, `KillSwitchState`) |
| Broker config seeding | `server/broker/brokerService.ts::seedBrokerConfigs()` |
| Dhan adapter | `server/broker/adapters/dhan/index.ts` |
| Dhan TOTP + refresh | `server/broker/adapters/dhan/{auth.ts, tokenManager.ts}` |
| Mock adapters (paper) | `server/broker/adapters/mock/index.ts` |
| TEA submit / modify / exit | `server/executor/tradeExecutor.ts` |
| Idempotency store | `server/executor/idempotency.ts` |
| Order sync (broker → TEA → Portfolio) | `server/executor/orderSync.ts` |
| Recovery engine (stale PENDING orders) | `server/executor/recoveryEngine.ts` |
| Broker REST routes | `server/broker/brokerRoutes.ts` |
| Server entry + bind | `server/index.ts` (`HTTP_HOST` env, default 127.0.0.1) |
| Disconnect kill-switch handlers | `server/broker/brokerService.ts` (`KillSwitchState`) |
| Executor settings (AI_LIVE_LOT_CAP etc.) | `server/executor/settings.ts` (via `getExecutorSettings`) |
| Tests | `server/broker/__tests__/`, `server/executor/__tests__/` |