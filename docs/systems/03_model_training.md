# 03 — Model Training (MTA)

Single source of truth for the **Model Training Agent**: walk-forward CV, isotonic calibration, sim-PnL validation, and the Saturday weekly retrain that produces every model the signal engine consumes.

## 1. Purpose & Scope

**In scope:**
- Per-instrument trainer that fits **84 LightGBM heads** (60 scalp + 12 trend + 12 swing) per run.
- 5-fold walk-forward cross-validation + a dedicated calibration fold.
- Isotonic calibration sidecars for the 32 binary heads per instrument (128 maps total across 4 instruments).
- Sim-PnL Option C validation harness on the val set.
- Per-head `LATEST_HEADS.json` writer with schema-version stamping.
- Saturday weekly retrain scheduler + per-instrument loop.
- Training manifest emission (audit trail + Saturday promotion-gate input).

**Out of scope:**
- Feature engineering / target backfill → [02 Feature Engineering](02_feature_engineering.md).
- Per-tick inference, calibration *apply*, gate logic → [04 Signal Engine](04_signal_engine.md).
- Backtest scoring / replay scorecards → separate scripts under `scripts/`.

## 2. Data flow

```
data/features/<date>/<inst>_features.parquet
                │
                ▼
        load + filter to allowed dates (holdout guard)
                │
                ▼
   calibration carve-out: most-recent 5 sessions ──────┐
                │                                       │
                ▼                                       │
   walk-forward planner: 5 evenly-spaced 1-week folds   │
                │                                       │
                ▼                                       │
   per fold × 84 heads → _fit_one() = 420 fits/inst    │
   per fold metrics → manifest["folds"]                 │
   aggregate → manifest["fold_aggregate"]               │
                │                                       │
                ▼                                       │
   production .lgbm = single-split fit on (train ∪ val) │
   (spec deviation: loses ~10% data vs spec's           │
    "all-minus-cal"; acceptable today, revisit if       │
    edge-quality drops post first real retrain)         │
                │                                       │
                ▼                                       │
   per-head calibration pass ◄──────────────────────────┘
       binary heads only (32/84):
         load .lgbm → predict on cal fold →
         fit IsotonicRegression(out_of_bounds='clip') →
         write <head>.calibration.json sidecar
                │
                ▼
   sim_pnl harness (direction-only v1 gate)
       entry at ask, exit at bid, time-stop 60s,
       ₹125 placeholder charges →
       sim_pnl_scorecard.json + manifest["sim_pnl_*"]
                │
                ▼
   LATEST_HEADS.json writer
       per head: head_type, objective, lookahead_seconds,
       lgbm_path, calibration_path, schema_version
       schema_version read from highest config/schema_registry/v<N>.json
                │
                ▼
   training_manifest.json
                │
                ▼
   models/<inst>/<timestamp>/   (full artifact tree)
   models/<inst>/LATEST_HEADS.json   (loader-visible)
                │
                ▼
                04 Signal Engine model_loader + schema_reconciler
```

## 3. The 84-head target set

| Layer | Count | Horizons | Code |
|---|---|---|---|
| Scalp | 60 (12 types × 5 horizons) | 60 / 120 / 180 / 240 / 300 s | `python_modules/_shared/targets.py` |
| Trend | 12 (6 types × 2 horizons) | 900 s, 1800 s | `python_modules/_shared/targets.py` |
| Swing | 12 (6 types × 2 horizons) | 3600 s, 7200 s | `python_modules/_shared/targets.py` |

Every head carries `head_type ∈ {scalp, trend, swing}` and `objective ∈ {binary, regression}`. The trainer iterates `MVP_TARGETS` dynamically — no hardcoded `60` or `84` constants anywhere in `trainer.py`.

## 4. Walk-forward CV + calibration fold

**Calibration fold carve-out.** The most-recent `cal_days` (default 5) sessions are peeled off before any train/val split is computed. They're recorded in `manifest["calibration_dates"]` and never seen by the trainer. CLI flag `--cal-days <N>`. Trainer auto-skips with WARN when total available < `cal_days + 2`.

**Walk-forward folds.** After the calibration carve-out, `_plan_walk_forward_folds()` plans `n_folds` (default 5) evenly-spaced 1-trading-week holdouts. Each fold trains all 84 heads via `_fit_one()` on (everything except the fold's week), scores them on the fold's val week, and discards the models. CLI flags `--n-folds`, `--fold-week-size`. Auto-skips with WARN when sessions < `n_folds × fold_week_size`.

**Fold metrics surfaced.** `manifest["fold_aggregate"]` holds `mean_<metric>` + `worst_<metric>` per head. Per-fold detail lives at `manifest["folds"]`. Trainer test suite verifies even spacing, threshold behaviour, and short-data fallback.

**Production model path.** The shipped `.lgbm` still comes from the single-split path (train on all-minus-val, validate on most-recent block). Known spec deviation per V2 §6 — losing ~10% training data vs "all-minus-cal" — accepted as-is until the first real retrain shows edge-quality drop.

**Single-day fallback.** If only one date is loaded (dev mode / v0 stopgap), the trainer falls back to a random 80/20 split. Loud WARN in logs so it can't be confused with a real run.

## 5. Isotonic calibration (D72)

Per V2_MASTER_SPEC §2.3 D72 — narrowed by D75 Gap 4 to binary heads only:

- After production fit completes, `python_modules/model_training_agent/calibration.py::fit_isotonic_for_head()` loads each binary head's `.lgbm`, predicts on the held-out calibration fold, and fits `sklearn.isotonic.IsotonicRegression(out_of_bounds='clip')`.
- Each fit serializes to `<head>.calibration.json` next to the model (just `x_thresholds_` + `y_thresholds_` as lists — SEA reconstructs with `numpy.interp`, no sklearn dependency at runtime).
- Manifest counters: `manifest["calibration_fit_count"]` and `manifest["calibration_skipped"]`.
- Regression heads (magnitude, max_upside, max_drawdown, etc.) ship without sidecars; calibration is meaningless on point-estimate outputs.

**Total maps:** 32 binary heads × 4 instruments = 128 sidecars per Saturday retrain.

SEA's runtime apply lives in [04 Signal Engine](04_signal_engine.md).

## 6. Sim-PnL harness (Option C)

`python_modules/model_training_agent/validation/sim_pnl.py`. Pure module: `compute_scorecard()` aggregator + `simulate_trades()` orchestrator with a `signal_action_fn` seam.

**v1 simplifications (all logged in module docstring):**
- Gate is direction-only: calibrated `direction_60s ≥ 0.65` → LONG_CE; `≤ 0.35` → LONG_PE. The real `decide_action_v2` needs the T29 multi-head router; swap by changing `signal_action_fn`.
- Exit is time-stop only (60 s horizon); the TP / SL ladder from V2 §2.5 is the upgrade path.
- Charges are ₹125 placeholder constant (V2 §7 worked-example value); real Charges_Spec wiring is deferred.
- Required val columns: `opt_atm_ce_bid/ask`, `opt_atm_pe_bid/ask`, `tick_ts_ns`. Missing any → harness skips gracefully with logged reason; trainer continues.

**Outputs.** `sim_pnl_scorecard.json` (next to manifest) + the 8 `sim_pnl_*` summary keys on the manifest itself, so the Saturday automation can read them without parsing the larger scorecard.

## 7. Saturday weekly retrain

**Scheduler.** Windows Task Scheduler entry `Lubas-Retrain-Saturday`:
- Trigger: weekly, Saturday 02:00 IST.
- `-WakeToRun` brings the machine out of sleep.
- 16-hour execution time limit.
- Registered via `startup/install-scheduled-tasks.ps1` (one elevated install run per machine activates it).

**Runner.** `scripts/retrain_v2.bat` loops the MTA CLI sequentially across `crudeoil → naturalgas → nifty50 → banknifty`. Per-instrument failures don't abort the others; `OVERALL_RC=1` if any fail, so the scheduled task surfaces a clean fail/pass at the task-history level. Wide window: `DATE_FROM=2026-01-01` (the data-loader filters out anything not yet on disk).

**Gate.** First real retrain runs **Sat 2026-07-04** — after the 30-session Phase 4 accumulation gate (Day 30 = Tue 2026-06-30). Trainer prints a non-blocking WARN when `len(loaded) < 30` so v0-stopgap runs are visible in logs.

**Saturday-skip in the live-trading task is deliberate.** The `Lubas-Startup` (logon, Mon–Fri) and `Lubas-Stop` (15:35, Mon–Fri) tasks both skip Saturday because there is no live trading on Saturday — the retrain task is a separate, independent entry.

## 8. LATEST_HEADS.json + schema reconciliation (D66)

After each successful run the trainer writes `models/<inst>/LATEST_HEADS.json` next to the existing plaintext `LATEST` pointer.

**Per-head payload:**
```json
{
  "version": 1,
  "schema_version": 8,
  "timestamp": "2026-05-23T17:31:08+05:30",
  "heads": {
    "direction_60s": {
      "head_type": "scalp",
      "objective": "binary",
      "lookahead_seconds": 60,
      "lgbm_path": "models/nifty50/2026-05-23T17-31-08/direction_60s.lgbm",
      "calibration_path": "models/nifty50/2026-05-23T17-31-08/direction_60s.calibration.json",
      "schema_version": 8
    },
    ...
  }
}
```

**Schema version source.** `_read_current_schema_version()` reads the highest-numbered `config/schema_registry/v<N>.json`. Falls back to `0` with WARN if no registry exists. TFA emitter is the authoritative writer of the registry (per D66) — the trainer is a read-only consumer.

**Runtime reconciliation.** Lives in `python_modules/signal_engine_agent/schema_reconciler.py`. SEA loads `.lgbm` + sidecars, then calls `reconcile_loaded_heads()` which compares each head's stamped `schema_version` against the registry. Mismatched heads are popped from `LoadedModels.models` + `.calibrations` — the engine's `_pred` then returns NaN, gates fail open.

**Conservative on uncertainty.** Missing `LATEST_HEADS.json`, missing `schema_registry/`, `schema_version=0`, or an unsupported file format → **no quarantine**. The reconciler is meant to catch real drift, not to fight ambient missing-state.

## 9. Hyperparameters

Currently **hardcoded** in `trainer.py:56-77`:
- **Binary heads:** `num_leaves=63, max_depth=5, min_child_samples=50, lambda_l2=1.0, learning_rate=0.05, n_estimators=500`.
- **Regression heads:** same except `max_depth=6, min_child_samples=30`.

These are the conservative pre-set defaults from V2_MASTER_SPEC §2.3.3 L3 D2 Option D. They are good enough for v0 stopgap and the Day-30 first real retrain, but per-head tuning will lift quality 1-3 % AUC. Tracked as `T28 [MTA]` — Optuna sweep + `config/mta_hyperparams.json` plumbing, PRE-Day-30 SHOULD.

## 10. Training manifest

`models/<inst>/<timestamp>/training_manifest.json` is the canonical audit trail for every run. Key fields:

- `instrument`, `timestamp`, `date_from`, `date_to`.
- `train_dates`, `val_dates`, `calibration_dates`.
- `feature_count`, `targets`, `trained_count`, `skipped_targets`.
- `calibration_fit_count`, `calibration_skipped`.
- `folds` (per-fold val metrics), `fold_aggregate` (mean + worst per head).
- `sim_pnl_*` (n_signals, n_wins, total_pnl, expectancy_inr, max_drawdown_inr, win_rate, etc.) — the Saturday automation reads these.

## 11. Test coverage

**75+ tests** under `python_modules/model_training_agent/tests/`:
- `test_trainer.py` — split planning, fold execution, end-to-end runs, manifest assertions, LATEST_HEADS payload.
- `test_calibration.py` — fit + apply + sidecar round-trip + path resolution.
- `test_sim_pnl.py` — `Trade` semantics, `Scorecard` aggregation, orchestrator routing, graceful skip on missing option cols.
- `test_schema_reconciler.py` — happy-path quarantine + every conservative-on-uncertainty path + end-to-end loader integration (lives under SEA tests; cross-tested here).

One pre-existing parallel test is excluded — joblib-loky / Python 3.14 environment quirk, unrelated to trainer logic.

## 12. Operational notes

**Holdout-leak guard.** `cli.py:_check_holdout()` refuses to train if any date in `config/holdout_dates.json` (`enabled: true`) falls inside the train window. CLI override: `--override-holdout` (logged loudly). Holdout is currently `disabled` until paper-trade kicks off — see [T36 in PROJECT_TODO](../PROJECT_TODO.md).

**Feature-config locking.** First successful run per instrument writes `config/model_feature_config/<inst>_feature_config.json` (column names + dtypes). Subsequent runs read it; mismatches fail loud. Prevents silent column-set drift between training and inference.

**Parallel training.** `--n-jobs <N>` enables joblib parallelism across heads (LightGBM inner threads are then pinned to 1 to avoid CPU oversubscription). The Saturday batch runs serial (`--n-jobs 1`) by design — keeps Saturday-night CPU usage predictable.

**Sim-PnL graceful skip.** If the val parquet lacks `opt_atm_ce_bid/ask` or `opt_atm_pe_bid/ask`, the harness skips with a logged reason and the trainer continues. Manifest then carries `sim_pnl_skipped=True` and no `sim_pnl_*` summary keys; the Saturday promotion gate must treat this as "no signal" and fall back to the operator.

## 13. Status

**ACTIVE.** T23–T27 all completed 2026-05-23 (84-head expansion, walk-forward CV, calibration, sim_pnl, LATEST_HEADS + reconciler + Saturday scheduler). First real retrain: **Sat 2026-07-04**.

## 14. Open work

- [T28 [MTA]](../PROJECT_TODO.md) — Optuna hyperparameter tuning + `config/mta_hyperparams.json`. PRE-Day-30 SHOULD.
- [T41 [MTA]](../PROJECT_TODO.md) — Saturday promotion-gate script. Trainer writes sim_pnl summary to the manifest; no script yet decides whether to update the LATEST pointer or hold for manual review. Currently the Saturday cron retrains and produces artifacts; promotion is implicit-manual.

## 15. Cross-refs

- [02 Feature Engineering](02_feature_engineering.md) — input parquets + schema registry source.
- [04 Signal Engine](04_signal_engine.md) — model + calibration consumer; runs the schema reconciler at load time.
- [PROJECT_TODO.md](../PROJECT_TODO.md) — T28 / T36 / T41 active.

## 16. Code locations

| What | Path |
|---|---|
| Trainer entry + CLI | `python_modules/model_training_agent/cli.py` |
| Main training loop + walk-forward + LATEST_HEADS | `python_modules/model_training_agent/trainer.py` |
| Isotonic calibration (fit + sidecar I/O) | `python_modules/model_training_agent/calibration.py` |
| Sim-PnL harness | `python_modules/model_training_agent/validation/sim_pnl.py` |
| Target definitions (shared with TFA) | `python_modules/_shared/targets.py` |
| Tests | `python_modules/model_training_agent/tests/` |
| Saturday runner | `scripts/retrain_v2.bat` |
| Scheduled task registration | `startup/install-scheduled-tasks.ps1` (Lubas-Retrain-Saturday block) |
| Schema reconciler (reader side) | `python_modules/signal_engine_agent/schema_reconciler.py` |
| Schema registry | `config/schema_registry/v<N>.json` (TFA-owned) |
| Holdout guard config | `config/holdout_dates.json` |
| Per-instrument feature config | `config/model_feature_config/<inst>_feature_config.json` |
