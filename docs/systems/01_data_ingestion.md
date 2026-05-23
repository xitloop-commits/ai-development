# 01 — Data Ingestion

## Purpose
Pull live ticks from Dhan, record raw `.ndjson.gz` per session, and expose a feature-ready stream + replayable archive for downstream training and inference.

## Scope
**In:** Dhan WebSocket subscriptions (4 instruments — crudeoil, naturalgas, nifty50, banknifty), binary packet parser (5 depth levels), recorder with cross-process lock, India VIX feed, token refresh policy.
**Out:** feature derivation (→ 02), persistence to DB (→ 07), broker order channels (→ 05).

## Sub-specs
- [DHAN_TOKEN_POLICY.md](../DHAN_TOKEN_POLICY.md) — startup-only refresh, no dual-refresh races (active production policy).
- Memory references (operational notes, no formal spec yet):
  - [docs/memory/project_recorder_corruption_fix.md](../memory/project_recorder_corruption_fix.md) — 2026-04-21 cross-process lock fix.
  - [docs/memory/project_dhan_ws_limit.md](../memory/project_dhan_ws_limit.md) — 5-connection ceiling constraint.
  - [docs/memory/project_mcx_rollover_fix.md](../memory/project_mcx_rollover_fix.md) — ChainPoller stale `underlying_security_id` fix.
  - [docs/memory/reference_paths_and_naming.md](../memory/reference_paths_and_naming.md) — `data/raw/<date>/<inst>.ndjson.gz` layout.

## Data flow
```
Dhan WS → binary_parser (FULL packets, depth×5) → recorder (lock + gzip) → data/raw/<date>/<inst>.ndjson.gz
                                                                                    │
                                                                                    ▼
                                                                               02 (replay or live)
```

## Status
ACTIVE. Recorder + replay path stable. Schema v8 since 2026-05-18. WS ceiling = 5 per Dhan account; primary account holds 2 (UI tick + order), spouse account holds 4 (TFA × 4 instruments) — see [05_execution.md](05_execution.md) for dual-account specifics. Phase 4 passive accumulation runs Mon-Fri until 2026-06-30 (Day-30 gate).

## Cross-refs
- [02_feature_engineering.md](02_feature_engineering.md) — primary consumer (live + replay).
- [05_execution.md](05_execution.md) — shares Dhan WS client + token policy.
- [10_launcher_ops.md](10_launcher_ops.md) — scheduled task `Lubas-Startup` triggers recorder.

## Open questions
- No dedicated tick-recorder spec; memory notes carry the load. Promote to `docs/specs/Recorder_Spec_v1.md` if recorder gains complexity.
- 20-level depth feed deferred — gated on T37 SHAP evidence ([PROJECT_TODO T37](../PROJECT_TODO.md)).