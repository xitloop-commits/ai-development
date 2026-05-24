# 01 — Data Ingestion

Single source of truth for everything between a Dhan WebSocket tick and a row landing on disk in `data/raw/<date>/<inst>.ndjson.gz`. Feature derivation, model inference, and order placement live in other system docs.

## 1. Purpose & Scope

**In scope:**
- Dhan WebSocket connection management (live + replay).
- Binary packet parsing (7 packet types, FULL packets with 5-level market depth).
- Option-chain polling + MCX near-month contract resolution.
- Recorder — per-session `.ndjson.gz` writers with cross-process locking + restart-append.
- India VIX co-subscription per instrument process.
- Dhan token lifecycle (refresh + 401 handling).
- WebSocket allocation across the two Dhan accounts.

**Out of scope:**
- Computing features from ticks → [02 Feature Engineering](02_feature_engineering.md).
- Placing or cancelling orders → [05 Execution](05_execution.md).
- Persistence of fills/positions → [07 Portfolio & Reporting](07_portfolio_reporting.md).

## 2. Architecture at a glance

```
Dhan feed API (api-feed.dhan.co)
        │
        ▼ (one direct WS per TFA process — bypasses Node)
┌──────────────────────────────────────────────────────────────┐
│ tick_feature_agent (one Python process per instrument × 4)   │
│                                                              │
│  feed/dhan_feed.py   ── WS lifecycle + reconnect backoff     │
│  feed/binary_parser  ── 7 packet types, 5-depth FULL         │
│  feed/chain_poller   ── HTTP poll for option chain + scrip   │
│                         master; runtime-resolves MCX FUT     │
│  features/india_vix  ── ~1 Hz NSE INDEX subscription         │
│                                                              │
│  recorder/                                                   │
│    session_recorder  ── on_session_open / on_expiry_rollover │
│    writer            ── NdjsonGzWriter + .lock file          │
│                                                              │
│  tick_processor      ── feature emitter (→ 02)               │
└──────────────────────────────────────────────────────────────┘
        │                          │
        ▼                          ▼
  live feature stream      data/raw/<DATE>/<INST>_*.ndjson.gz
        │                  (underlying + option + chain + vix)
        ▼
  04 Signal Engine             Replay → 02 → 03 (training)
```

The TFA Python process owns its own WebSocket to Dhan, on purpose. The Node-side broker adapter (`server/broker/adapters/dhan/websocket.ts`) exists for order-update streams and a UI tick feed, but does **not** mediate TFA's market-data subscription — that would add latency and a single point of failure.

## 3. Dual-broker WebSocket topology

Dhan caps each account at **5 concurrent WebSocket connections**. Lubas spreads the workload across two Dhan accounts:

| Account | Client ID | WS subscriptions | Used by |
|---|---|---|---|
| `dhan` (primary) | `1101615161` | 1 UI tick feed + 1 order-update = **2 / 5** | Manual trading (my-live / my-paper channels) |
| `dhan-ai-data` (spouse) | `1111388877` | 4 TFA processes + 1 order-update = **5 / 5** | AI Live / AI Paper channels |

**Headroom:** zero on `dhan-ai-data`. Any concurrent TFA on the `ui-refactoring` worktree (or a second instance on the same account) hits the cap and gets refused. The order-routing implications of dual-account live in [05 Execution](05_execution.md).

**MCX rollover handling.** `ChainPoller._resolve_near_month_contract()` queries the Dhan scripmaster on startup and on every option-chain resubscribe, so April → May → June FUT contract ID transitions don't strand the poller on a dead contract. The instrument profile JSON keeps the FUT contract as a fallback only.

## 4. Recording & Replay

**Per-session layout** under `data/raw/<DATE>/`:

| File | Contents | Typical record count |
|---|---|---|
| `<INST>_underlying_ticks.ndjson.gz` | TICKER / QUOTE / FULL packets for the futures underlying | ~200k–600k |
| `<INST>_option_ticks.ndjson.gz` | FULL packets for the 8 active option strikes (5-depth) | ~500k–2M |
| `<INST>_chain_snapshots.ndjson.gz` | Option-chain polls (HTTP, every few seconds) | ~5k–15k |
| `<INST>_vix_ticks.ndjson.gz` | India VIX ticks (NSE INDEX subscription, ~1 Hz) | ~25k |

Each TFA process writes its own 4-file set. India VIX is duplicated across instruments by design — locality matters more than disk for a small file, and self-contained per-instrument folders simplify replay.

**Writer safety.** `recorder/writer.py` (`NdjsonGzWriter`) acquires a per-file `.lock` before appending. The lock is per-file, not per-process, so two TFAs writing different instruments never contend. If TFA crashes and restarts mid-session, writers open existing files in append mode — no corruption, no loss of buffered ticks (gzip framing tolerates concatenation).

**Cross-process lock fix history.** Prior to 2026-04-21, concurrent writers caused gzip corruption (28 affected files between 2026-04-14 and 2026-04-20). The lock pattern in `NdjsonGzWriter._acquire_lock()` is the fix; apply the same pattern to any new writer that targets per-day files.

**Replay.** Raw `.ndjson.gz` files are full-fidelity (all 5 depth levels, all metadata, original `recv_ts`). The replay path in `tick_feature_agent/replay/replay_runner.py` re-emits ticks at recorded timestamps, runs them through the same feature emitter, and writes parquet rows. Target columns are emitted as NaN by live; replay backfills the 24 target cols end-of-day via `SpotTargetBuffer` (Option B per V2 design). Schema-version mismatch between recording and replay is not currently handled — older `v7` recordings cannot be replayed against the live `v8` emitter without manual schema conversion.

## 5. Token lifecycle

**Policy:** startup-only refresh. No dual-refresh races, no in-flight TOTP retries.

- Each Dhan broker (`dhan`, `dhan-ai-data`) has its own `tokenManager` instance with independent TOTP + access-token state.
- TFA fetches its access token at startup via `GET /api/broker/token?brokerId=dhan-ai-data` from the Node broker service.
- Mid-session 401 from Dhan → mark token expired, alert via yow-partha Telegram, **wait for manual restart**. No automatic refresh attempt.
- Tokens are valid ~24 h; the server is restarted often enough that the no-mid-refresh stance has zero resilience cost.

This stance was locked 2026-05-06 after a racing-refresh incident produced two simultaneous refresh attempts and orphaned a session token. The implementation lives in `server/broker/adapters/dhan/auth.ts` + `tokenManager.ts`.

## 6. Schema & configuration

**Schema version: v8** (locked 2026-05-18). 519 columns total = 377 base L1 features + 23 multi-TF + 46 brainstorm-added + 24 target columns + 49 metadata/derived. Schema registry: `config/schema_registry/v8.json` — TFA emitter is the authoritative writer (writes the registry file on startup when its compiled `LATEST_SCHEMA_VERSION` exceeds the highest existing `v<N>.json`).

**Per-instrument configuration** at `config/instrument_profiles/<inst>_profile.json`:
- Session hours (NSE 09:15–15:30 IST, MCX 09:00–23:30 IST).
- `underlying_tick_timeout_sec`, `option_tick_timeout_sec` — feed-staleness windows; ticks beyond the window get `data_quality_flag=False` and downstream features see a `stale_reason` context.
- Regime thresholds (ADX, realized-vol bands).
- FUT contract ID as fallback only — runtime resolution wins.

**Market calendar:** `config/market_holidays.json` (currently empty for 2026). `main.py:_market_closed_reason()` gates live-mode startup; Saturday / Sunday / listed holidays block boot before any WS is opened.

## 7. Operational notes

**Session lifecycle.** Live mode refuses to start outside the trading window or on a listed holiday. There is no manual override — to ingest from a stale date, run replay mode with `--date <YYYY-MM-DD>`.

**Observability.** TFA pushes Telegram alerts via `_notify_yow_partha()` on:
- Startup failure (missing token, unreachable broker, schema mismatch).
- Session-close anomaly (final tick count below the per-instrument floor).
- Token expired mid-session (401 from Dhan).

Env vars `YOW_PARTHA_BOT_TOKEN` + `YOW_PARTHA_CHAT_ID` wire the alert path. See [09 Control Bot](09_control_bot.md) for the receiving end.

**Tick monitoring.** Today the recorder logs final tick counts at session close but does not flag mid-session anomalies (drop rate > 10%, gap > 10 s, dead WebSocket without reconnect). Tracked as [PROJECT_TODO T40 [INGEST]](../PROJECT_TODO.md).

**Restart behaviour.** TFA crashes and re-launches mid-session land cleanly: writers append to existing files, parquet rows continue from the last checkpoint (per-50k-events or 5-minute chunks via `replay/replay_runner.py`).

## 8. Status

ACTIVE. Phase 4 passive accumulation runs Mon–Fri until **Day-30 = Tue 2026-06-30**; first real retrain Sat 2026-07-04. The recorder has been running continuously since 2026-05-20 (Day 1 of v8 schema).

**Known constraints / lessons learned:**
- 5-WS ceiling per Dhan account; spouse account is pegged at full capacity.
- MCX rollover requires runtime contract resolution — never cache the FUT contract ID for more than a session.
- Cross-process lock on `.ndjson.gz` writers is mandatory; without it, concurrent writes corrupt the gzip stream.
- Mid-session token refresh is forbidden by policy — restart the affected process.

## 9. Open work

- [T40 [INGEST]](../PROJECT_TODO.md) — tick-loss monitoring + alerting (new this pass).
- [T37](../PROJECT_TODO.md) — order-book depth levels 1–4 features (deferred, post-SHAP).
- [T22](../PROJECT_TODO.md) — launcher blue-tick for terminated/partial stages (deferred, has open design Qs).

## 10. Cross-refs

- [02 Feature Engineering](02_feature_engineering.md) — live-feature consumer + parquet writer.
- [05 Execution](05_execution.md) — shares Dhan WS client + token policy; owns order-routing across the two accounts.
- [07 Portfolio & Reporting](07_portfolio_reporting.md) — receives fills written by execution.
- [10 Launcher & Ops](10_launcher_ops.md) — scheduled task `Lubas-Startup` boots the recorder Mon–Fri at logon.

## 11. Code locations (when you need to read the implementation)

| What | Path |
|---|---|
| WS client + reconnect | `python_modules/tick_feature_agent/feed/dhan_feed.py` |
| Binary packet parser | `python_modules/tick_feature_agent/feed/binary_parser.py` |
| Option-chain poller (+ MCX rollover) | `python_modules/tick_feature_agent/feed/chain_poller.py` |
| Recorder lifecycle | `python_modules/tick_feature_agent/recorder/session_recorder.py` |
| Writer + cross-process lock | `python_modules/tick_feature_agent/recorder/writer.py` |
| India VIX features | `python_modules/tick_feature_agent/features/india_vix.py` |
| Replay runner | `python_modules/tick_feature_agent/replay/replay_runner.py` |
| Session-start gating | `python_modules/tick_feature_agent/main.py` (`_market_closed_reason`) |
| Telegram alerts | `python_modules/tick_feature_agent/main.py` (`_notify_yow_partha`) |
| Schema registry | `config/schema_registry/v8.json` |
| Per-instrument profiles | `config/instrument_profiles/<inst>_profile.json` |
| Dhan token manager | `server/broker/adapters/dhan/tokenManager.ts` |
| Dhan auth + 401 handler | `server/broker/adapters/dhan/auth.ts` |
