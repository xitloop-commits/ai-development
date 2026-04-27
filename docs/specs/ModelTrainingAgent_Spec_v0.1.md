# MTA (Model Training Agent) & Signal Engine Agent (SEA) — Specification v0.1

**Document:** ModelTrainingAgent_Spec_v0.1.md
**Project:** Automatic Trading System (ATS)
**Status:** Draft — Pending resolution of open items (see §11)
**Version:** 0.1
**Date:** 2026-04-13

---

## Revision History

| Version | Date | Author | Summary |
|---------|------|--------|---------|
| v0.1 | 2026-04-13 | AI Team | Initial draft — architecture, components, feature pipeline, training strategy, signal engine, artifact layout |
| v0.1.1 | 2026-04-13 | AI Team | Added two-phase delivery model: Phase 1 = signal validation only (no execution); Phase 2 = downstream execution (RCA/TEA/Discipline) only after win rate validated manually |

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Context](#2-system-context)
3. [Two Components](#3-two-components)
4. [Target Variables](#4-target-variables)
5. [Feature Preprocessing Pipeline](#5-feature-preprocessing-pipeline)
6. [Component 1 — Model Training Agent](#6-component-1--model-training-agent)
7. [Component 2 — Signal Engine Agent (SEA)](#7-component-2--signal-engine)
8. [Artifact Layout](#8-artifact-layout)
9. [Future Roadmap](#9-future-roadmap)
10. [Integration Contracts](#10-integration-contracts)
11. [Open Items](#11-open-items)
12. [Dependencies on Other Specs](#12-dependencies-on-other-specs)

---

## 1. Overview

This spec covers two tightly coupled components:

- **Model Training Agent** — offline, weekly-triggered. Reads Parquet feature files produced by TFA replay, trains 15 LightGBM models per instrument, writes versioned model artifacts.
- **Signal Engine Agent (SEA)** — online, always-running. Consumes the live TFA NDJSON tick stream, runs real-time inference using the latest trained models, and outputs trade signals for human review.

Together these components replace the deprecated AI engine modules and fulfill **Milestone D** (first trained model) from the project roadmap.

### Two-Phase Delivery

**Phase 1 — Signal Validation (current scope)**
Build Model Training Agent + Signal Engine Agent (SEA). Signal Engine Agent (SEA) outputs signals (GO_CALL / GO_PUT / WAIT + confidence + RR) to a log and dashboard only. No trade execution. User manually observes signals over multiple sessions and tracks win rate.

**Phase 2 — Execution (future scope, after Phase 1 validated)**
Only after win rate is manually verified as satisfactory: wire Signal Engine Agent (SEA) to RCA, then build RCA → TEA → Discipline Engine → Portfolio Agent. Downstream execution infrastructure is explicitly deferred until signal quality is proven.

> **All RCA/TEA/Discipline/Portfolio integration described in §7 is Phase 2 design — included for completeness but not in scope for current build.**

---

## 2. System Context

### 2.1 Full Pipeline

```
TFA (live, 4 processes)
  │
  ├──► data/raw/{date}/            (NDJSON.gz — underlying ticks, option ticks, chain snapshots)
  │         ↓  [replay_runner weekly]
  │    data/features/{date}/       (Parquet — 370-column feature vectors)
  │         ↓  [model_training_agent weekly]
  │    models/{instrument}/        (LightGBM artifacts — 15 models per instrument)
  │         ↓  [loaded at Signal Engine Agent (SEA) startup]
  │
  └──► NDJSON socket (live ticks, real-time)
             ↓  [signal_engine_agent — preprocessing + inference]
        SignalPacket (direction_prob, RR, upside_pct, decay_score ...)
             ↓  [signal_engine_agent — thresholding + trade setup construction]
        TradeSuggestion (GO_CALL | GO_PUT | WAIT + strike + entry/SL/TP)
             ↓  POST /api/risk-control/evaluate
        RCA → TEA → BSA → Dhan (ai-live) or MockAdapter (ai-paper)
             ↓
        PortfolioAgent ← TEA (records outcome)
             ↓
        DisciplineEngine (capital caps, circuit breaker, session halt)
```

### 2.2 Workspaces & Channels

The Signal Engine Agent (SEA) operates exclusively in the **AI Trades workspace**.

| Mode | Channel | Adapter | Capital Pool |
|------|---------|---------|--------------|
| Paper (default) | `ai-paper` | MockAdapter | AI Paper pool |
| Live | `ai-live` | DhanAdapter (real Dhan account) | AI Live pool |

Mode is switched from **Settings page only** — no on-screen toggle in the AI Trades workspace. Both paper and live follow the 75/25 compounding principle (PortfolioAgent_Spec_v1.3 §2.1–2.5).

### 2.3 Instrument Scope

Four instruments, each with its own isolated model set:

| Instrument | Exchange | Session |
|------------|----------|---------|
| NIFTY 50 | NSE | 09:15 – 15:30 IST |
| BANK NIFTY | NSE | 09:15 – 15:30 IST |
| CRUDE OIL | MCX | 09:00 – 23:30 IST |
| NATURAL GAS | MCX | 09:00 – 23:30 IST |

One complete model set (15 LightGBM models + feature config) is trained and maintained per instrument independently.

---

## 3. Component Boundaries

### 3.1 Responsibility Split

| Concern | MTA | Signal Engine Agent (SEA) |
|---------|-----|---------------|
| Trigger | Manual CLI ("train the model") | Always-on daemon |
| Frequency | Weekly | Per tick (real-time) |
| Input | Parquet files (`data/features/`) | TFA NDJSON socket |
| Output | Model artifacts (`models/`) | Signal log + dashboard |
| Language | Python | Python |
| Location | `python_modules/model_training_agent/` | `python_modules/signal_engine_agent/` |
| Process model | One-shot CLI per instrument | One process per instrument |
| Owns preprocessor | **Yes** — builds and locks feature config | No — imports from MTA |
| Owns model files | **Yes** — trains and writes `.lgbm` files | No — reads only |
| Owns feature config | **Yes** — creates and locks `model_feature_config.json` | No — reads only |
| Owns signal output | No | **Yes** — signal log schema, dashboard |
| Owns thresholds | No | **Yes** — GO_CALL/GO_PUT/WAIT logic |

### 3.2 What MTA Owns (writes)

MTA is the producer. Everything it writes becomes the contract that Signal Engine Agent (SEA) consumes.

```
models/{instrument}/LATEST                              ← active version pointer
models/{instrument}/{timestamp}/*.lgbm                  ← 15 model brains
models/{instrument}/{timestamp}/metrics.json            ← training quality report
models/{instrument}/{timestamp}/training_manifest.json  ← provenance
config/model_feature_config/{instrument}_feature_config.json  ← locked feature list
```

### 3.3 What Signal Engine Agent (SEA) Owns (writes)

```
logs/signals/{instrument}/{date}_signals.log   ← signal log (one file per instrument per day)
```

Signal log schema (one JSON line per signal emitted):
```json
{
  "timestamp": 1744531200.123,
  "instrument": "CRUDEOIL",
  "direction": "GO_CALL",
  "direction_prob_30s": 0.71,
  "direction_prob_60s": 0.66,
  "risk_reward_30s": 1.87,
  "upside_percentile_30s": 72.4,
  "max_upside_30s": 18.5,
  "max_drawdown_30s": 9.9,
  "atm_strike": 6900,
  "entry_price": 185.50,
  "model_version": "20260414_093022"
}
```

### 3.4 Shared Module — Preprocessor

The §9.2 feature preprocessing pipeline is used by both components but **owned by MTA**:

- **MTA** uses full pipeline (Steps 1–7): row filtering, column drops, redundancy reduction, strike tier, active strike handling, variance pruning, importance pruning. Writes locked `model_feature_config.json`.
- **Signal Engine Agent (SEA)** uses Steps 1–5 only (no pruning — config already locked). Imports preprocessor from MTA.

```python
# Signal Engine Agent (SEA) imports from MTA — do not duplicate
from model_training_agent.preprocessor import preprocess_live_tick
```

**Rule:** If the preprocessor logic changes, MTA session owns the change. Signal Engine Agent (SEA) session imports it — never copies it.

### 3.5 Interface Contract (MTA → Signal Engine Agent (SEA))

Signal Engine Agent (SEA) cannot start without these files from MTA:

| File | Required? | Notes |
|------|-----------|-------|
| `models/{instrument}/LATEST` | Yes | Points to active version folder |
| `models/{instrument}/{version}/*.lgbm` | Yes | All 15 model files must exist |
| `config/model_feature_config/{instrument}_feature_config.json` | Yes | Must be locked (not a template) |

If any of these are missing at startup, Signal Engine Agent (SEA) exits with a clear error:
```
ERROR: No trained model found for crudeoil. Run MTA first.
```

---

## 4. Target Variables

TFA produces 15 target columns per tick across two lookahead windows (30s and 60s). The model trains a separate LightGBM estimator for each target.

### 4.1 Target Tiers

**Tier 1 — Trade entry signals (primary)**

| Column | Type | Meaning |
|--------|------|---------|
| `direction_30s` | Binary (0/1) | Spot moved up (1) or down (0) in next 30s |
| `direction_60s` | Binary (0/1) | Spot direction over next 60s |
| `risk_reward_ratio_30s` | Regression | Predicted upside / drawdown over 30s |
| `risk_reward_ratio_60s` | Regression | Predicted upside / drawdown over 60s |

**Tier 2 — Sizing and confidence**

| Column | Type | Meaning |
|--------|------|---------|
| `max_upside_30s` | Regression | Max CE premium gain across active strikes in 30s (₹) |
| `max_upside_60s` | Regression | Max CE premium gain in 60s (₹) |
| `max_drawdown_30s` | Regression | Max CE premium loss in 30s (₹) |
| `max_drawdown_60s` | Regression | Max CE premium loss in 60s (₹) |
| `direction_30s_magnitude` | Regression | % magnitude of spot move in 30s |
| `direction_60s_magnitude` | Regression | % magnitude of spot move in 60s |
| `upside_percentile_30s` | Regression | Session rank of max upside (0–100) |

**Tier 3 — Premium seller signal**

| Column | Type | Meaning |
|--------|------|---------|
| `total_premium_decay_30s` | Regression | Total theta decay across active strikes in 30s (₹) |
| `total_premium_decay_60s` | Regression | Total theta decay in 60s (₹) |
| `avg_decay_per_strike_30s` | Regression | Average decay per active strike in 30s (₹) |
| `avg_decay_per_strike_60s` | Regression | Average decay per active strike in 60s (₹) |

### 4.2 LightGBM Objective per Target

| Target | Objective | Eval Metric |
|--------|-----------|-------------|
| `direction_30s`, `direction_60s` | `binary` | AUC-ROC |
| All others | `regression` | RMSE |

### 4.3 NaN Handling for Targets

Rows where a specific target column = NaN are dropped **per target** during training. This occurs for:
- Ticks near session end where T+30 or T+60 crosses the session close boundary
- Early warm-up ticks before sufficient active strike data

Different targets will have slightly different training row counts — this is expected and acceptable.

---

## 5. Feature Preprocessing Pipeline

The preprocessing pipeline is defined authoritatively in **TFA Spec §9.2**. This section summarises the implementation contract.

### 5.1 Step 1 — Row Filtering (mandatory, applied first)

| Filter | Condition | Action |
|--------|-----------|--------|
| Market hours | `is_market_open = 0` | Drop row |
| Data quality | `data_quality_flag = 0` | Drop row |
| System state | `trading_state != "TRADING"` | Drop row |

Only fully-warm, in-session, live-feed rows reach the model.

### 5.2 Step 2 — Column Category Drops (mandatory)

| Category | Columns | Action |
|----------|---------|--------|
| `identifier` | `security_id`, `chain_timestamp`, `tick_time` | Drop always |
| `filter` | `data_quality_flag`, `is_market_open` | Drop (constant after row filter) |
| `target` | All 15 target columns | Keep as labels only; exclude from feature matrix X |
| `state` | `trading_state`, `trading_allowed` | Drop (constant after row filter) |

### 5.3 Step 3 — Redundancy Reduction

| Drop | Keep | Reason |
|------|------|--------|
| `ofi_20` | `ofi_5`, `ofi_50`, `horizon_ofi_ratio` | Middle window adds marginal info; ratio normalises |
| `realized_vol_20` | `realized_vol_5`, `realized_vol_50`, `horizon_vol_ratio` | 5 and 50 bracket the range |
| `tick_up_count_10`, `tick_down_count_10`, `tick_flat_count_10` | `tick_imbalance_10` | Imbalance is the normalised signal |
| `tick_up_count_50`, `tick_down_count_50`, `tick_flat_count_50` | `tick_imbalance_50` | Same reason |

Underlying extended group reduces from 20 → ~12 features.

### 5.4 Step 4 — Option Tick Strike Tier (v1: ATM±1 only)

| Tier | Instruments | Columns | Version |
|------|------------|---------|---------|
| ATM±1 (3 strikes × CE+PE) | 6 | 102 | **v1** |
| ATM±2 (5 strikes × CE+PE) | 10 | 170 | v2 if skew/spread context needed |
| ATM±3 (7 strikes × CE+PE) | 14 | 238 | v3 only if deep OTM confirmed as signal |

TFA always outputs all 14 strike tiers — the pipeline selects which columns to use via `model_feature_config.json`. TFA output is unchanged.

### 5.5 Step 5 — Active Strike Handling (v1: zone aggregation only)

| Option | Columns | v1 Decision |
|--------|---------|-------------|
| Zone aggregation only | 7 | **Use this** — no NaN problem; aggregate already computed |
| All 144 active strike cols | 144 | Skip for v1 (50–100% NaN in slots 3–6) |
| Top-2 slots only | 48 | Consider for v2 after ablation |

### 5.6 Step 6 — Variance Pruning (one-time, offline)

Run `VarianceThreshold(threshold=0.001)` on the training set before first model fit. Lock surviving column list in `model_feature_config.json`. **Do not re-run on subsequent training runs** — config must be frozen for reproducibility.

### 5.7 Step 7 — Importance Pruning (after first training run)

1. Extract feature importances (`gain` metric, not `split` count)
2. Drop features with `gain < 0.1%` of total gain
3. Retrain on pruned set; compare validation score
4. Lock final feature set in `model_feature_config.json`

### 5.8 Expected Feature Count

| Group | Raw TFA cols | v1 model input cols |
|-------|-------------|---------------------|
| Underlying base | 12 | 10 (drop `ltp_prev`) |
| Underlying extended | 20 | 12 (Step 3 reduction) |
| ATM context | 3 | 3 |
| Compression & time-to-move | 9 | 9 |
| Option tick (ATM±1 only) | 102 | 102 |
| Option chain | 9 | 9 |
| Active strikes (144 cols) | 144 | 0 (use zone aggregation) |
| Cross-feature intelligence | 4 | 4 |
| Decay & dead market | 5 | 5 |
| Regime classification | 2 | 2 |
| Zone aggregation | 7 | 7 |
| **Pre-pruning total** | **~327** | **~163** |
| **After variance + importance pruning** | — | **~80–120** |

### 5.9 Feature Config File

The output of the preprocessing pipeline is a locked config file stored at:
```
config/model_feature_config/{instrument}_feature_config.json
```

This file is **git-tracked** (small, human-reviewable, version-controlled config — not a binary artifact).

```json
{
  "version": "1.0",
  "tfa_version": "1.8",
  "instrument": "crudeoil",
  "strike_tier": "atm_pm1",
  "active_strike_mode": "zone_aggregation_only",
  "dropped_columns": ["ofi_20", "realized_vol_20", "tick_up_count_10", "..."],
  "variance_threshold": 0.001,
  "importance_threshold_gain_pct": 0.1,
  "final_feature_count": 97,
  "final_features": ["underlying_ltp", "underlying_spread", "..."],
  "locked_at": "20260413_143022",
  "locked_by": "model_training_agent v0.1"
}
```

---

## 6. Component 1 — Model Training Agent

### 6.1 Location

```
python_modules/model_training_agent/
  __init__.py
  cli.py              ← CLI entry point (--instrument, --date-from, --date-to)
  trainer.py          ← orchestrates training of all 15 models for one instrument
  preprocessor.py     ← §9.2 Steps 1–7 pipeline (SHARED — imported by Signal Engine Agent (SEA))
  feature_config.py   ← create/read/lock model_feature_config.json
  validator.py        ← post-training quality checks, decides whether to update LATEST
  checkpoint.py       ← save/resume training_checkpoint.json
  artifacts.py        ← write metrics.json, shap_importance.json, training_manifest.json
```

### 6.2 Trigger

Manual CLI only:
```
python -m model_training_agent.cli \
  --instrument crudeoil \
  --date-from 2026-03-01 \
  --date-to   2026-04-13
```

Not automated or scheduled. User explicitly triggers weekly after reviewing validation reports.

### 6.3 Data Requirements

**Hard minimum:** 5 trading days of Parquet data. Agent refuses to train if fewer days are available and exits with a clear error message.

**Recommended:** 10+ trading days for a reliable first model.

### 6.4 Training Strategy

**Walk-forward temporal split — no shuffling, no k-fold across time.**

```
Days 1 .. N-1   → Training set
Day N           → Validation set (out-of-sample, never seen during fitting)
```

Once > 10 days available:
```
Days 1 .. N-2   → Training set
Day N-1         → Validation set
Day N           → Test set (held out, never touched during tuning)
```

### 6.5 LightGBM Hyperparameters (v1 — fixed defaults, no tuning)

```python
LGBM_PARAMS_BINARY = {
    "objective": "binary",
    "metric": "auc",
    "n_estimators": 500,
    "learning_rate": 0.05,
    "num_leaves": 63,
    "min_child_samples": 50,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "reg_alpha": 0.1,
    "reg_lambda": 0.1,
    "verbose": -1,
}

LGBM_PARAMS_REGRESSION = {
    "objective": "regression",
    "metric": "rmse",
    "n_estimators": 500,
    "learning_rate": 0.05,
    "num_leaves": 63,
    "min_child_samples": 50,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "reg_alpha": 0.1,
    "reg_lambda": 0.1,
    "verbose": -1,
}
```

Hyperparameter search (Optuna or similar) is deferred to v2.

### 6.6 Checkpoint

The training agent maintains its own checkpoint at `models/{instrument}/training_checkpoint.json`. If training is interrupted mid-run (e.g., 7 of 15 targets trained), it resumes from the next target on re-invocation with the same date range.

### 6.7 Output (per instrument, per training run)

All artifacts written to a timestamp-versioned folder:

```
models/
  {instrument}/
    {timestamp}/                  e.g. 20260413_143022/
      direction_30s.lgbm
      direction_60s.lgbm
      direction_30s_magnitude.lgbm
      direction_60s_magnitude.lgbm
      max_upside_30s.lgbm
      max_upside_60s.lgbm
      max_drawdown_30s.lgbm
      max_drawdown_60s.lgbm
      risk_reward_ratio_30s.lgbm
      risk_reward_ratio_60s.lgbm
      total_premium_decay_30s.lgbm
      total_premium_decay_60s.lgbm
      avg_decay_per_strike_30s.lgbm
      avg_decay_per_strike_60s.lgbm
      upside_percentile_30s.lgbm
      metrics.json
      shap_importance.json
      training_manifest.json
    training_checkpoint.json
    LATEST                        ← text file: name of active version folder
```

`LATEST` is only updated after a complete, validated training run. The Signal Engine Agent (SEA) reads `LATEST` at startup to determine which version to load.

**`models/` directory is gitignored** (large binary artifacts). `config/model_feature_config/` is git-tracked.

### 6.8 `metrics.json` schema

```json
{
  "version": "20260413_143022",
  "instrument": "crudeoil",
  "training_dates": ["2026-04-07", "2026-04-08", "2026-04-09", "2026-04-10"],
  "validation_date": "2026-04-13",
  "training_rows": 41230,
  "validation_rows": 10890,
  "targets": {
    "direction_30s": { "val_auc": 0.572, "train_auc": 0.601 },
    "direction_60s": { "val_auc": 0.558, "train_auc": 0.589 },
    "max_upside_30s": { "val_rmse": 12.4, "train_rmse": 11.1 },
    "..."
  },
  "trained_at": "2026-04-13T14:30:22Z",
  "agent_version": "0.1"
}
```

### 6.9 `training_manifest.json` schema

```json
{
  "version": "20260413_143022",
  "instrument": "crudeoil",
  "tfa_version": "1.8",
  "feature_config_version": "1.0",
  "feature_config_path": "config/model_feature_config/crudeoil_feature_config.json",
  "final_feature_count": 97,
  "parquet_files_used": [
    "data/features/2026-04-07/crudeoil_features.parquet",
    "..."
  ],
  "preprocessing": {
    "strike_tier": "atm_pm1",
    "active_strike_mode": "zone_aggregation_only",
    "row_filter_applied": true,
    "variance_pruning_applied": true,
    "importance_pruning_applied": false
  },
  "nan_handling": {
    "strategy": "drop_per_target",
    "note": "Rows where target = NaN dropped independently per target column"
  }
}
```

---

## 7. Component 2 — Signal Engine Agent (SEA)

The Signal Engine Agent (SEA) is a new component — it does not exist yet and will be built as part of this milestone. It replaces the deprecated AI engine modules.

### 7.1 Location

```
python_modules/signal_engine_agent/
  __init__.py
  cli.py              ← CLI entry point (--instrument)
  engine.py           ← main inference loop (connects to TFA socket, per-tick processing)
  model_loader.py     ← reads LATEST, loads 15 .lgbm files into memory
  signal_builder.py   ← assembles SignalPacket from 15 model outputs
  thresholds.py       ← GO_CALL / GO_PUT / WAIT decision logic
  signal_logger.py    ← writes signal log (Phase 1 output)
  # NOTE: no preprocessor.py here — import from model_training_agent.preprocessor
  # Phase 2 only (not built yet):
  # rca_client.py     ← POST /api/risk-control/evaluate
  # discipline_client.py ← GET /api/discipline/status
```

### 7.2 Startup Sequence

1. Read `models/{instrument}/LATEST` → get active version folder
2. Load all 15 `.lgbm` model files into memory
3. Load `config/model_feature_config/{instrument}_feature_config.json`
4. Connect to TFA NDJSON socket for this instrument
5. Begin inference loop

### 7.3 Per-Tick Inference Loop

**Phase 1 (signal validation — current scope):**
```
1. Receive tick row from TFA NDJSON socket
2. Apply preprocessing (§5 steps 1–5, using locked feature config)
   → If row filtered out: skip tick silently
3. Run all 15 LightGBM inferences (~0.1ms total)
4. Assemble SignalPacket
5. Apply thresholds → produce signal direction
6. Write to signal log file + emit to dashboard
   → Log: timestamp, instrument, direction, confidence,
          RR, upside_percentile, atm_strike, entry_price
7. Back to step 1
```

**Phase 2 (execution — future, after win rate validated):**
```
... steps 1–5 same ...
6. Query discipline status (cached, refresh every 5s)
   → If blocked: emit WAIT, skip to step 1
7. If GO_CALL or GO_PUT:
   → Build full TradeSuggestion payload
   → POST /api/risk-control/evaluate
   → Log decision with tick timestamp, signal values, and RCA response
8. Back to step 1
```

### 7.4 SignalPacket

Internal structure assembled after inference:

```python
@dataclass
class SignalPacket:
    instrument: str
    timestamp: float

    # Tier 1 — direction
    direction_prob_30s: float        # P(direction_30s == 1), range [0, 1]
    direction_prob_60s: float
    risk_reward_30s: float           # predicted risk_reward_ratio_30s
    risk_reward_60s: float

    # Tier 2 — sizing
    max_upside_30s: float            # predicted ₹ value
    max_drawdown_30s: float
    direction_magnitude_30s: float
    upside_percentile_30s: float     # 0–100

    # Tier 3 — decay
    avg_decay_per_strike_30s: float

    # Context from TFA features (pass-through, not model output)
    atm_strike: int
    atm_ce_ltp: float
    atm_pe_ltp: float
    momentum_score: float            # from TFA underlying momentum feature
    breakout_readiness: float        # from TFA compression features

    model_version: str
```

### 7.5 Thresholding Logic (v1 defaults)

All thresholds are configurable. These are starting defaults to be tuned after first paper trading run.

```python
# Entry conditions — ALL three must pass
DIRECTION_PROB_THRESHOLD  = 0.65   # P(direction) > 65%
MIN_RISK_REWARD           = 1.5    # predicted RR > 1.5
MIN_UPSIDE_PERCENTILE     = 60.0   # this tick is above 60th percentile of session

# Direction mapping
if direction_prob_30s > DIRECTION_PROB_THRESHOLD:
    direction = "GO_CALL" if direction_prob_30s > 0.5 else "GO_PUT"
else:
    direction = "WAIT"

if risk_reward_30s < MIN_RISK_REWARD:
    direction = "WAIT"

if upside_percentile_30s < MIN_UPSIDE_PERCENTILE:
    direction = "WAIT"
```

### 7.6 TradeSuggestion Payload (to RCA)

Conforms to `POST /api/risk-control/evaluate` contract defined in RiskControlAgent_Spec_v2.0 §7.1.

```json
{
  "instrument": "CRUDEOIL",
  "trade_direction": "GO_CALL",
  "trade_setup": {
    "strike": 6900,
    "entry_price": 185.50,
    "target_price": 222.60,
    "stop_loss": 148.40,
    "risk_reward": 1.87,
    "target_pct": 20.0,
    "sl_pct": 20.0
  },
  "confidence_score": 0.71,
  "discipline_status": {
    "allowed": true,
    "blocked_by": [],
    "warnings": []
  },
  "entry_timing": {
    "confirmed": true,
    "momentum_score": 68,
    "volume_spike": false,
    "price_breakout": true
  }
}
```

**`entry_price`:** ATM CE LTP (for GO_CALL) or ATM PE LTP (for GO_PUT) from current TFA tick.

**`target_price` / `stop_loss` derivation:**
- `target_pct` = `(max_upside_30s / entry_price) × 100`
- `sl_pct` = `(max_drawdown_30s / entry_price) × 100`
- `target_price` = `entry_price × (1 + target_pct / 100)`
- `stop_loss` = `entry_price × (1 - sl_pct / 100)`

**`momentum_score`:** Derived from `underlying_momentum` TFA feature, scaled 0–100.

**`volume_spike`:** `True` if `ofi_5 > 2 × ofi_50` (order flow imbalance spike).

**`price_breakout`:** `True` if `breakout_readiness > 0.7` from TFA compression features.

### 7.7 Discipline Check

Before posting any GO_CALL or GO_PUT signal, the Signal Engine Agent (SEA) queries the Discipline Engine to verify trading is allowed.

```
GET /api/discipline/status
→ { "trading_allowed": true/false, "blocked_by": [...], "warnings": [...] }
```

Response is cached for 5 seconds. If `trading_allowed = false`, emit WAIT and log the blocking reason.

The Signal Engine Agent (SEA) does **not** enforce discipline rules itself — it defers entirely to the Discipline Engine. RCA performs its own independent discipline check as well (defense in depth).

### 7.8 Process Model

One Signal Engine Agent (SEA) process per instrument, mirroring TFA's process architecture:

```
TFA nifty50     → Signal Engine Agent (SEA) nifty50     (port 55100)
TFA banknifty   → Signal Engine Agent (SEA) banknifty   (port 55101)
TFA crudeoil    → Signal Engine Agent (SEA) crudeoil    (port 55102)
TFA naturalgas  → Signal Engine Agent (SEA) naturalgas  (port 55103)
```

If a Signal Engine Agent (SEA) process crashes, the corresponding TFA process is unaffected and continues recording. The Signal Engine Agent (SEA) can be restarted independently and will reconnect to TFA's socket.

---

## 8. Artifact Layout

### 8.1 Directory Structure

```
project root/
  config/
    instrument_profiles/          ← existing (git-tracked)
      crudeoil_profile.json
      ...
    model_feature_config/         ← NEW (git-tracked — small, human-reviewable)
      crudeoil_feature_config.json
      naturalgas_feature_config.json
      nifty50_feature_config.json
      banknifty_feature_config.json

  data/                           ← gitignored — pipeline data only
    raw/{date}/
    features/{date}/
    validation/{date}/

  models/                         ← gitignored — binary artifacts
    crudeoil/
      20260413_143022/
        direction_30s.lgbm
        direction_60s.lgbm
        ... (15 files)
        metrics.json
        shap_importance.json
        training_manifest.json
      training_checkpoint.json
      LATEST
    naturalgas/
    nifty50/
    banknifty/

  python_modules/
    tick_feature_agent/           ← existing
    model_training_agent/         ← NEW
    signal_engine_agent/                ← NEW
```

### 8.2 Versioning

Model versions use timestamp format `YYYYMMDD_HHMMSS` (e.g., `20260413_143022`).

- `LATEST` file contains the folder name of the currently active version.
- `LATEST` is only updated after a complete, validated training run — never mid-run.
- Previous versions are retained (not deleted) until manual cleanup.
- The Signal Engine Agent (SEA) always loads from `LATEST` at startup.

### 8.3 Git Tracking Summary

| Path | Git-tracked? | Reason |
|------|-------------|--------|
| `config/model_feature_config/*.json` | **Yes** | Small config, human-reviewable, version-control meaningful |
| `models/` | No | Large binary artifacts |
| `data/` | No | Machine-generated pipeline data |

---

## 9. Future Roadmap

Items explicitly deferred from v1:

| Item | Target Version |
|------|---------------|
| Hyperparameter tuning (Optuna) | v2 |
| LSTM / Temporal Convolutional Network sequence model | v2 |
| Transformer-based tick encoder | v3 |
| Ensemble (LightGBM + LSTM) | v3 |
| ATM±2 strike tier in feature set | v2 |
| Individual active strike slots (top-2) | v2 |
| Online / incremental model updates | v2 |
| Regime-conditional models (separate model per vol regime) | v2 |
| Multi-instrument transfer learning | v3 |
| Automated retraining trigger (on data drift detection) | v2 |

---

## 10. Integration Contracts

### 10.1 Upstream: TFA

- Signal Engine Agent (SEA) reads the **same NDJSON socket** that TFA emits during live trading (ML consumer socket, defined in TFA Spec §9.1).
- Training Agent reads **Parquet files** from `data/features/{date}/{instrument}_features.parquet` produced by TFA replay.
- The Signal Engine Agent (SEA) does **not** modify TFA in any way. TFA is unaware of the Signal Engine Agent (SEA).

### 10.2 Downstream: RCA

- Signal Engine Agent (SEA) posts trade suggestions to `POST /api/risk-control/evaluate` (RCA Spec §7.1).
- RCA may APPROVE, REJECT, REDUCE_SIZE, or REVIEW the suggestion — Signal Engine Agent (SEA) logs the response but does not retry rejected suggestions.
- Signal Engine Agent (SEA) does **not** call TEA or BSA directly. All execution flows through RCA → TEA → BSA.

### 10.3 Discipline Engine

- Signal Engine Agent (SEA) queries `GET /api/discipline/status` before posting any trade suggestion (cached 5s).
- Signal Engine Agent (SEA) also attaches the discipline status in the TradeSuggestion payload so RCA has it in-band.
- The Signal Engine Agent (SEA) **never bypasses or overrides** Discipline Engine decisions.

### 10.4 Portfolio Agent

- Signal Engine Agent (SEA) has **no direct integration** with Portfolio Agent.
- TEA writes all trade outcomes to Portfolio Agent after execution.
- If the Signal Engine Agent (SEA) needs portfolio context in a future version (e.g., to avoid over-concentration), it would query Portfolio Agent read-only.

---

## 11. Open Items

The following decisions are explicitly deferred and must be resolved before implementation begins.

| # | Item | Options | Impact |
|---|------|---------|--------|
| **E** | **Model promotion threshold** | What val AUC/RMSE is "good enough" to update LATEST and activate for paper trading? Options: (a) fixed floor e.g. `direction_30s AUC > 0.55`; (b) must beat previous LATEST metrics; (c) manual review only | Without a floor, any model — even a harmful one — could be promoted |
| **F** | **Strike selection** | Which strike to trade: (a) always ATM; (b) ATM-1 (slightly ITM, better delta but more expensive); (c) best predicted RR across ATM±1; (d) user-configurable | Affects entry price, position sizing, and expected P&L profile |
| **G** | **SEA socket connection** | ~~RESOLVED~~ Unix Domain Socket (AF_UNIX). SEA is the server (listens on a socket file). TFA connects as client via `--output-socket /tmp/sea_{instrument}.sock`. No TCP stack, no ports. No TFA changes needed — AF_UNIX already supported in TFA emitter. Socket files: `/tmp/sea_nifty50.sock`, `/tmp/sea_banknifty.sock`, `/tmp/sea_crudeoil.sock`, `/tmp/sea_naturalgas.sock`. Start SEA before TFA. | — |

---

## 12. Dependencies on Other Specs

| Spec | Dependency |
|------|-----------|
| TickFeatureAgent_Spec_v1.7 §9.1 | NDJSON socket contract for live inference input |
| TickFeatureAgent_Spec_v1.7 §9.2 | Feature preprocessing pipeline (authoritative) |
| RiskControlAgent_Spec_v2.0 §7.1 | TradeSuggestion payload contract |
| RiskControlAgent_Spec_v2.0 §2.5 | AI signal format expected by RCA |
| BrokerServiceAgent_Spec_v1.9 §1 | ai-live / ai-paper channel architecture |
| PortfolioAgent_Spec_v1.3 §2.1–2.5 | AI Trades capital pool behavior |
| DisciplineEngine_Spec_v1.3 | Discipline status check before trade submission |
| Settings_Spec_v1.5 §3.7 | AI Trades mode switch (paper ↔ live) |

---

**Status:** Draft — 3 open items (§11) must be resolved before implementation spec is written.
**Next step:** Resolve open items E, F, G → promote to v1.0 implementation-ready spec.