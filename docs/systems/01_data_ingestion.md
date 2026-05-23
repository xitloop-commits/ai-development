# 01 — Data Ingestion

## Purpose
Pull live ticks from Dhan, record raw `.ndjson.gz` per session, and expose a feature-ready stream + replayable archive for downstream training and inference.

## Scope
**In:** Dhan WebSocket subscriptions (4 instruments — crudeoil, naturalgas, nifty50, banknifty), binary packet parser (5 depth levels), recorder with cross-process lock, India VIX feed, token refresh policy.
**Out:** feature derivation (→ 02), persistence to DB (→ 07), broker order channels (→ 05).

## Sub-specs
- [DHAN_TOKEN_POLICY.md](../DHAN_TOKEN_POLICY.md) — startup-only refresh, no dual-refresh races (active production policy).

## Data flow
```
Dhan WS → binary_parser (FULL packets, depth×5) → recorder (lock + gzip) → data/raw/<date>/<inst>.ndjson.gz
                                                                                    │
                                                                                    ▼
                                                                               02 (replay or live)
```

## Status
ACTIVE. Schema v8 since 2026-05-18. Phase 4 passive accumulation runs Mon-Fri until 2026-06-30 (Day-30 gate).

**Known constraints + lessons learned:**
- **Recorder uses cross-process lock** for `.ndjson.gz` writes (fix shipped 2026-04-21). Without it, concurrent processes targeting the same per-day file caused gzip corruption.
- **MCX rollover handling:** `ChainPoller` resolves `underlying_security_id` at runtime, not once at startup. Stale IDs caused a near-month rollover break in April 2026.
- **Dhan WS ceiling = 5 connections per account.** Primary account uses 2 (UI tick + order-update); spouse account uses 4 (TFA × 4 instruments). The `ui-refactoring` worktree cannot run concurrent TFA on the same account. See [05_execution.md](05_execution.md) for dual-account topology.
- **Path layout:** raw ticks at `data/raw/<date>/<inst>.ndjson.gz`; features at `data/features/<date>/<inst>_features.parquet`. Note `nifty` vs `nifty50` filename inconsistency was fixed earlier; if it resurfaces during replay, use the profile key, not a lowercased instrument name.

## Cross-refs
- [02_feature_engineering.md](02_feature_engineering.md) — primary consumer (live + replay).
- [05_execution.md](05_execution.md) — shares Dhan WS client + token policy.
- [10_launcher_ops.md](10_launcher_ops.md) — scheduled task `Lubas-Startup` triggers recorder.

## Open questions
- No dedicated tick-recorder spec; memory notes carry the load. Promote to `docs/specs/Recorder_Spec_v1.md` if recorder gains complexity.
- 20-level depth feed deferred — gated on T37 SHAP evidence ([PROJECT_TODO T37](../PROJECT_TODO.md)).