# MTA (Model Training Agent) — Implementation Plan v0.1

**Spec Reference:** ModelTrainingAgent_Spec_v0.1.md
**Status:** Ready for implementation
**Language:** Python 3.11+
**Location:** `python_modules/model_training_agent/`

---

## 1. Overview

MTA is an offline, CLI-triggered Python module that:
1. Reads Parquet feature files from `data/features/`
2. Applies the §9.2 preprocessing pipeline
3. Trains 15 LightGBM models per instrument
4. Writes versioned model artifacts to `models/{instrument}/{timestamp}/`
5. Locks the feature config in `config/model_feature_config/{instrument}_feature_config.json`

**Key constraint:** `preprocessor.py` is shared with Signal Engine Agent (SEA) — Signal Engine Agent (SEA) imports it directly. Never break its public API without coordinating with the Signal Engine Agent (SEA) session.

---

## 2. File Structure

```
python_modules/
└── model_training_agent/
    ├── __init__.py
    ├── cli.py                  ← CLI entry point
    ├── trainer.py              ← orchestrates training of all 15 models
    ├── preprocessor.py         ← §9.2 pipeline (SHARED — Signal Engine Agent (SEA) imports this)
    ├── feature_config.py       ← create / read / lock model_feature_config.json
    ├── validator.py            ← post-training quality checks + LATEST promotion
    ├── checkpoint.py           ← save / resume training_checkpoint.json
    ├── artifacts.py            ← write metrics.json, shap_importance.json, training_manifest.json
    └── tests/
        ├── test_preprocessor.py
        ├── test_trainer.py
        ├── test_feature_config.py
        ├── test_validator.py
        ├── test_checkpoint.py
        └── test_artifacts.py
```

---

## 3. Phases

### Phase 1 — Preprocessor (build first, Signal Engine Agent (SEA) depends on it)

**File:** `preprocessor.py`

This is the most critical file — Signal Engine Agent (SEA) imports it. Must be stable before Signal Engine Agent (SEA) session starts.

**Public API (do not change without coordinating):**

```python
def preprocess_for_training(
    df: pd.DataFrame,
    feature_config: dict | None,   # None = first run, derive config from data
    target_col: str,               # which target column to keep as label
) -> tuple[pd.DataFrame, pd.Series, dict]:
    """
    Apply §9.2 Steps 1–7 for training.
    Returns: (X_features, y_labels, feature_config_dict)
    feature_config_dict is populated on first run, reused on subsequent runs.
    """

def preprocess_live_tick(
    row: dict,
    feature_config: dict,          # must be locked config, not None
) -> np.ndarray | None:
    """
    Apply §9.2 Steps 1–5 to a single live tick dict.
    Returns feature vector as numpy array, or None if row should be filtered out.
    Used by Signal Engine Agent (SEA) on every tick.
    """
```

**Steps to implement:**

| Step | Logic |
|------|-------|
| Step 1 — Row filter | Drop `is_market_open=0`, `data_quality_flag=0`, `trading_state != "TRADING"` |
| Step 2 — Column drops | Drop identifier, filter, state, target columns from feature matrix |
| Step 3 — Redundancy | Drop `ofi_20`, `realized_vol_20`, raw tick counts (keep imbalance) |
| Step 4 — Strike tier | Keep ATM±1 option tick columns only (drop ATM±2, ATM±3) |
| Step 5 — Active strikes | Drop 144 active strike cols, keep 7 zone aggregation cols |
| Step 6 — Variance pruning | `VarianceThreshold(0.001)` — training only, first run only |
| Step 7 — Importance pruning | Drop features with gain < 0.1% — after first model fit |

**Tests:** `test_preprocessor.py`
- Row filter drops correct rows
- Column drops leave correct columns
- Strike tier selection is correct
- `preprocess_live_tick` returns None for filtered rows
- `preprocess_live_tick` returns correct shape array for valid row
- Both functions produce consistent feature column order

---

### Phase 2 — Feature Config

**File:** `feature_config.py`

Manages `config/model_feature_config/{instrument}_feature_config.json`.

```python
def load_feature_config(instrument: str) -> dict | None:
    """Load locked config. Returns None if not yet created."""

def save_feature_config(instrument: str, config: dict) -> None:
    """Write config to disk. Called once after variance pruning."""

def is_locked(instrument: str) -> bool:
    """True if config exists and has final_features populated."""
```

**Config is locked after Step 6 (variance pruning).** Once locked, `preprocess_for_training` and `preprocess_live_tick` both use it — columns are never re-derived.

**Tests:** `test_feature_config.py`
- Save / load round-trip
- `is_locked` returns False when file absent
- `is_locked` returns True after save

---

### Phase 3 — Trainer

**File:** `trainer.py`

Orchestrates training of all 15 models for one instrument across a date range.

```python
def train_instrument(
    instrument: str,
    date_from: str,      # "YYYY-MM-DD"
    date_to: str,
    output_dir: Path,    # models/{instrument}/{timestamp}/
) -> dict:              # metrics dict
```

**Internal flow:**

```
1. Load all Parquet files in [date_from, date_to]
   → Fail if fewer than 5 trading days found
   → Concatenate into single DataFrame

2. Temporal split
   → Training: all days except last
   → Validation: last day

3. Load or create feature config
   → If not locked: run Steps 1–6 on training set, save config
   → If locked: use existing config

4. For each of 15 targets:
   a. Check checkpoint → skip if already trained
   b. preprocess_for_training(df_train, config, target_col) → X_train, y_train
   c. preprocess_for_training(df_val, config, target_col) → X_val, y_val
   d. Drop rows where y = NaN (per-target)
   e. Fit LightGBM with early stopping on val set
   f. Save model to output_dir/{target}.lgbm
   g. Record val metric in metrics dict
   h. Update checkpoint

5. Run importance pruning (Step 7) on direction_30s model
   → Update feature config if pruning changes column set
   → Retrain pruned targets that changed

6. Return metrics dict
```

**LightGBM training call:**

```python
import lightgbm as lgb

model = lgb.LGBMClassifier(**LGBM_PARAMS_BINARY)   # binary targets
model = lgb.LGBMRegressor(**LGBM_PARAMS_REGRESSION) # regression targets

model.fit(
    X_train, y_train,
    eval_set=[(X_val, y_val)],
    callbacks=[lgb.early_stopping(50), lgb.log_evaluation(100)],
)
model.booster_.save_model(str(output_dir / f"{target}.lgbm"))
```

**Tests:** `test_trainer.py`
- Fails with clear error if < 5 trading days
- Trains all 15 models and produces 15 `.lgbm` files
- Temporal split is correct (validation = last day only)
- Checkpoint skips already-trained targets on resume
- NaN rows dropped per target (different row counts per target)

---

### Phase 4 — Checkpoint

**File:** `checkpoint.py`

```python
def load_checkpoint(instrument: str) -> dict:
    """Load training_checkpoint.json. Returns empty dict if not found."""

def save_checkpoint(instrument: str, completed_targets: list[str], timestamp: str) -> None:
    """Save progress after each target completes."""

def clear_checkpoint(instrument: str) -> None:
    """Called after successful full run."""
```

Checkpoint stored at `models/{instrument}/training_checkpoint.json`:
```json
{
  "timestamp": "20260414_093022",
  "completed_targets": ["direction_30s", "direction_60s", "max_upside_30s"],
  "date_from": "2026-04-07",
  "date_to": "2026-04-14"
}
```

If re-invoked with same `date_from`/`date_to`, resumes from next incomplete target.
If invoked with different dates, checkpoint is ignored (fresh run).

**Tests:** `test_checkpoint.py`
- Save / load round-trip
- Resume skips completed targets
- Different date range ignores checkpoint

---

### Phase 5 — Artifacts

**File:** `artifacts.py`

Writes the three JSON metadata files after training completes.

```python
def write_metrics(output_dir: Path, instrument: str, metrics: dict) -> None:
    """Write metrics.json"""

def write_shap_importance(output_dir: Path, models: dict, feature_names: list) -> None:
    """Compute SHAP importance for each model, write shap_importance.json"""

def write_training_manifest(output_dir: Path, instrument: str, manifest: dict) -> None:
    """Write training_manifest.json"""
```

**Tests:** `test_artifacts.py`
- All three files written with correct schema
- `metrics.json` has entry for all 15 targets
- `shap_importance.json` has top-20 features per target

---

### Phase 6 — Validator + LATEST Promotion

**File:** `validator.py`

Decides whether a completed training run is good enough to promote to `LATEST`.

```python
def validate_run(output_dir: Path, metrics: dict) -> tuple[bool, list[str]]:
    """
    Returns (passed, reasons).
    passed = True means safe to update LATEST.
    """
```

**Open item E** — promotion threshold is not yet decided. For now:
- If no previous LATEST exists → always promote (first run)
- If previous LATEST exists → promote only if `direction_30s` val AUC >= previous val AUC
- User can override with `--force-promote` CLI flag

```python
def update_latest(instrument: str, timestamp: str) -> None:
    """Write timestamp to models/{instrument}/LATEST"""
```

**Tests:** `test_validator.py`
- First run always promotes
- New run with better AUC promotes
- New run with worse AUC does not promote (without --force)
- `--force-promote` always promotes regardless

---

### Phase 7 — CLI

**File:** `cli.py`

```
python -m model_training_agent.cli \
  --instrument crudeoil \
  --date-from 2026-04-07 \
  --date-to   2026-04-14 \
  [--force-promote]

Options:
  --instrument      One of: nifty50, banknifty, crudeoil, naturalgas
  --date-from       Start date (inclusive), YYYY-MM-DD
  --date-to         End date (inclusive), YYYY-MM-DD
  --force-promote   Update LATEST even if metrics regressed
```

**Exit codes:**
- `0` — success, LATEST updated
- `1` — training complete but not promoted (metrics regressed, use --force-promote)
- `2` — failed (insufficient data, file error, etc.)

---

## 4. Build Order

Build in this exact sequence — each phase depends on the previous:

```
Phase 1: preprocessor.py + tests     ← FIRST (Signal Engine Agent (SEA) depends on this)
Phase 2: feature_config.py + tests
Phase 3: trainer.py + tests          ← core training logic
Phase 4: checkpoint.py + tests
Phase 5: artifacts.py + tests
Phase 6: validator.py + tests
Phase 7: cli.py                      ← wire everything together
```

---

## 5. Dependencies

```
lightgbm >= 4.0
pandas >= 2.0
pyarrow >= 14.0
numpy >= 1.26
scikit-learn >= 1.4    (VarianceThreshold)
shap >= 0.44           (SHAP importance)
```

Add to `python_modules/requirements.txt`.

---

## 6. Test Strategy

- One test file per module
- All tests use synthetic Parquet data (no dependency on real market data)
- Test data generator: create a helper `tests/fixtures.py` that produces a minimal valid DataFrame matching TFA's 370-column schema
- No mocking of LightGBM — train on tiny synthetic data (50 rows, 5 features) for speed
- All tests must pass before CLI is built

---

## 7. Definition of Done

- [ ] All 6 modules implemented
- [ ] All tests passing
- [ ] `preprocessor.preprocess_live_tick()` public API stable and documented
- [ ] End-to-end CLI run completes: reads Parquet → trains 15 models → writes artifacts → updates LATEST
- [ ] Signal Engine Agent (SEA) session can `from model_training_agent.preprocessor import preprocess_live_tick` successfully

---

## Appendix: Implementation Deviations (as of 2026-04-17)

> This section tracks differences between the spec and the actual implementation.
> It will be merged into the spec body when the code stabilises.

- **MVP subset implemented (2026-04-16).** Full spec deferred until 1 month of clean data is collected.
- Only 3 of 15 targets trained: `direction_30s` (binary, AUC eval), `max_upside_30s` (regression, RMSE), `max_drawdown_30s` (regression, RMSE).
- Preprocessing: only Steps 1–3 implemented (row filter, column drops, redundancy reduction). Steps 4–7 (strike tier, active strikes, variance pruning, importance pruning) deferred.
- Training split: MVP uses smallest day as validation (not temporal last-day split) to maximise training rows with limited data. Single-day fallback uses random 80/20 split.
- Checkpoint, SHAP importance, training manifest validator, and LATEST promotion logic: not yet implemented. LATEST is always updated (no quality gate).
- `feature_config.json` is locked after first run and reused on subsequent runs (per spec).
- Location: `python_modules/model_training_agent/` with `preprocessor.py`, `trainer.py`, `cli.py`.
- Launcher wrappers: `startup/train-auto.bat`, `startup/train-model.bat`.
