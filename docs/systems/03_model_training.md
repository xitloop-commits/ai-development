# 03 — Model Training (MTA)

## Purpose
Train 84 LightGBM heads per instrument (60 scalp + 12 trend + 12 swing per V2 spec D55), calibrate binary heads with isotonic regression, validate via walk-forward CV + sim_pnl, and promote to `LATEST_HEADS.json` for the signal engine.

## Scope
**In:** feature parquets from [02](02_feature_engineering.md), shared `MVP_TARGETS` definition in `python_modules/_shared/targets.py`.
**Out:** `models/<inst>/<ts>/*.lgbm` + `*.calibration.json` sidecars + `LATEST_HEADS.json` + manifest → consumed by [04](04_signal_engine.md).

## Sub-specs
- [MTA_ImplementationPlan_v0.1.md](../specs/MTA_ImplementationPlan_v0.1.md) — trainer CLI, walk-forward, calibration, sim_pnl, Saturday scheduler.
- Design authorities:
  - [V2_MASTER_SPEC.md §2.3](../V2_MASTER_SPEC.md) — model architecture, head count, D72 calibration.
  - [V2_MASTER_SPEC.md §5](../V2_MASTER_SPEC.md) — drift detection + reliability monitoring.
  - [V2_MASTER_SPEC.md §6](../V2_MASTER_SPEC.md) — phase plan + weekly cadence.

## Data flow
```
parquets ─▶ cal carve-out (T24a, default 5 sess) ─▶ walk-forward 5-fold (T24b)
                                                          │
                                                          ▼
              1680 fits per Saturday (84 heads × 5 folds × 4 inst) ─▶ fold aggregate metrics
                                                          │
                                                          ▼
                production .lgbm (single-split path) ─▶ isotonic calibration on cal fold ─▶ .calibration.json sidecars
                                                          │
                                                          ▼
                                          sim_pnl Option C scorecard (T26) ─▶ manifest
                                                          │
                                                          ▼
                              LATEST_HEADS.json writer (T27) ─▶ schema_version stamped from highest schema_registry/v<N>.json
                                                          │
                                                          ▼
                                              04 model_loader + schema_reconciler
```

## Status
ACTIVE. **T23–T27 ALL COMPLETE 2026-05-23.**
- T23: 84-head targets shipped.
- T24a/b: dedicated cal fold + 5-fold walk-forward CV.
- T25: isotonic calibration per binary head; SEA applies at runtime.
- T26: sim_pnl Option C harness wired into trainer post-pass.
- T27: Saturday retrain scheduler + LATEST_HEADS.json + D66 schema reconciler.

First real retrain: **Sat 2026-07-04** after Phase 4 accumulation gate (Day 30 = Tue 2026-06-30).
Pending: **T28** (Optuna hyperparameter tuning) — PRE-Day-30 SHOULD (recommended, not strict), ~2–3 days.

## Cross-refs
- [02_feature_engineering.md](02_feature_engineering.md) — input parquets.
- [04_signal_engine.md](04_signal_engine.md) — consumes models + LATEST_HEADS via model_loader + schema_reconciler.
- [10_launcher_ops.md](10_launcher_ops.md) — hosts `Lubas-Retrain-Saturday` scheduled task and `scripts/retrain_v2.bat`.

## Open questions
- T28 Optuna sweep job — pin per-head LightGBM hyperparams via `config/mta_hyperparams.json`. PRE-Day-30 SHOULD.
- T24b spec deviation noted: production `.lgbm` still trained on single-split (loses ~10% data vs spec's "all-minus-cal"); revisit if first real retrain shows edge-quality drop.