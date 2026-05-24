# 02 — Feature Engineering

## Purpose
Convert raw ticks into 446 L1 features per tick (live and replay) plus 24 L2 target columns per session (replay-only backfill). Single emitter shared between live inference and training-time parquet generation to guarantee live ↔ train coherence.

## Scope
**In:** raw tick stream from [01](01_data_ingestion.md), replay `.ndjson.gz`, India VIX feed.
**Out:** feature parquets (`data/features/<date>/<inst>_features.parquet`) → [03](03_model_training.md); live feature vectors → [04](04_signal_engine.md).

## Sub-specs
- [TickFeatureAgent_Spec_v1.7.md](../specs/TickFeatureAgent_Spec_v1.7.md) — 8 feature blocks (A–H), schema versions, alerts.
- [TickFeatureAgent_ImplementationPlan_v1.0.md](../specs/TickFeatureAgent_ImplementationPlan_v1.0.md) — module-by-module build plan (Phase 2a stateless / 2b session-state / 2c cross-day / 3 targets).
- Cross-cutting:
  - [FEATURE_HEAD_RECONCILIATION.md](../specs/FEATURE_HEAD_RECONCILIATION.md) — 446 features ↔ 84 heads lookup.
  - [V2_MASTER_SPEC.md §2.1](../V2_MASTER_SPEC.md) — design authority for L1 features.
  - [V2_MASTER_SPEC.md §2.2](../V2_MASTER_SPEC.md) — design authority for L2 targets.

## Data flow
```
ticks ─▶ tick_processor ─▶ 22 feature modules ─▶ emitter (446 cols + 24 target NaN slots)
                                                       │
                          ┌────────────────────────────┼─────────────────────────────┐
                          ▼                                                          ▼
                  live feed → 04 (signal engine)              parquet writer → 03 (training)
                                                                      │
                                                                      ▼
                                              SpotTargetBuffer end-of-day backfill (24 targets)
```

## Status
ACTIVE. Phase 2 (L1 features) COMPLETE 2026-05-18 — schema v7 → v8, 446 cols. Phase 3 (L2 targets) COMPLETE 2026-05-18 — 12 trend + 12 swing targets via replay-only backfill (Option B). Live emitter writes NaN for target cols; replay backfills end-of-day.

## Cross-refs
- [01_data_ingestion.md](01_data_ingestion.md) — input.
- [03_model_training.md](03_model_training.md) — parquet consumer.
- [04_signal_engine.md](04_signal_engine.md) — live-feed consumer.

## Open questions
- T14 (8 deferred L1 features) — add only if first-retrain SHAP shows existing features fail to capture the patterns.
- T37 (depth levels 1–4, 10–15 new cols) — gated on level-0 SHAP importance evidence. Would bump schema v8 → v9 and reset Phase 4 accumulation counter.
- Phase 2e macro-bias columns (~28–30 cols, FII/DII/US-closes/event-calendar) coupled with T7 swing — ON HOLD until v2 intraday proves edge.