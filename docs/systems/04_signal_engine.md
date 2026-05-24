# 04 — Signal Engine (SEA)

Single source of truth for the **Signal Engine Agent** — per-tick inference across 84 heads, gate decisions, trade-management signal emission, and the handoff to risk + execution.

## 1. Purpose & Scope

**In scope:**
- Per-tick inference loop (84 LightGBM heads × current feature vector).
- Calibration apply at runtime (read `.calibration.json` sidecars, interp via `numpy.interp`).
- Schema reconciliation at load time (D66 quarantine of heads whose recorded schema_version drifts from the current registry).
- Gate logic — three coexisting paths (3-condition canonical, Wave 1 deterministic, Wave 2 model-driven). The v2 multi-head gate is pending.
- Per-tick sustained-direction filter (Wave 1 only).
- Signal emission to log + delivery to the Discipline gate (System 06).
- Regime consumption (TFA emits, SEA reads).

**Out of scope:**
- Raw tick ingestion → [01 Data Ingestion](01_data_ingestion.md).
- Feature derivation (including regime emission) → [02 Feature Engineering](02_feature_engineering.md).
- Model training / calibration fit / LATEST_HEADS writing → [03 Model Training](03_model_training.md).
- Order placement → [05 Execution](05_execution.md).
- Discipline pre-trade gate + risk caps → [06 Risk & Discipline](06_risk_discipline.md).
- Position state, fills, P&L → [07 Portfolio & Reporting](07_portfolio_reporting.md).

## 2. Data flow

```
TFA live emitter (data/features/<inst>_live.ndjson)
                          │
                          ▼
                 engine.run() — tail file
                          │
                          ▼
        model_loader.load_models()      (at startup)
        ├─ read models/<inst>/LATEST_HEADS.json
        ├─ load 84 .lgbm files
        ├─ load .calibration.json sidecars (binary heads)
        └─ schema_reconciler quarantines version-mismatched heads
                          │
                          ▼
              per tick: _gather_predictions()
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
   raw probabilities          .apply_calibration() → calibrated probs
              │                       │
              └─────────┬─────────────┘
                        │
                        ▼
                   gate dispatch (config gate_mode)
              ┌─────────┼──────────┬─────────────┐
              ▼         ▼          ▼             ▼
        current(3-cond) wave1   wave2     (future) v2 multi-head router (T29)
              │                                   │
              └────────────────┬──────────────────┘
                               │
                               ▼
              SignalAction { action, gate_passed, gate_reasons, ... }
                               │
                               ▼
              sustain.SustainFilter (Wave 1 only — 10-tick window)
                               │
                               ▼
              signal_logger.write()  →  logs/signals/<inst>_<date>_signals.log
                               │
                               ▼
              risk_control_client.submit_new_trade()
                               │
                               ▼
              POST /api/discipline/validateTrade → 06 Risk & Discipline
```

## 3. The three gates

Three gate code-paths coexist, selected per-instrument via `config/sea_thresholds/<inst>.json` field `"gate_mode"`.

### 3.1 Canonical 3-condition gate (base, Phase E5 LOCKED)

Per spec D4 (Phase D4, locked 2026-04-30):
- `calibrated_prob ≥ 0.65` AND
- `risk_reward ≥ 1.5` AND
- `upside_percentile ≥ 60`

Code: `thresholds.py:decide_action()`. Returns a `SignalAction` with `action ∈ {LONG_CE, LONG_PE, WAIT}`, `gate_passed: bool`, `gate_reasons: list[str]`. Per-instrument tuning loaded from `config/sea_thresholds/<inst>.json` with sensible defaults in `default.json`.

This is the foundation — both Wave 1 and Wave 2 sit on top of it.

### 3.2 Wave 1 deterministic gate (CURRENTLY ACTIVE)

`thresholds.py:decide_action_v2()`. Stacks three deterministic guards on top of the 3-condition base:
- **C4 regime check** — block trades in `dead` / `chop`; allow `trend` / `range` per side rules.
- **C5 momentum persistence** — short-window momentum must agree with intended side.
- **C6 S/R clearance** — entry not within X% of a recent S/R level on the wrong side.

Plus `sustain.SustainFilter` — a 10-tick rolling window that requires N consecutive matching ticks before emission (`engine.py` wires this only when `gate_mode == "wave1"`).

This is the production gate today (default config). Wave-1 logic, not v2 — the docstring at `thresholds.py:decide_action_v2:269` explicitly labels itself "Wave 1 gate."

### 3.3 Wave 2 model-driven gate (CODE PRESENT, DISABLED)

`thresholds.py:decide_action_wave2()`. Replaces the deterministic guards with four model-driven conditions sourced from additional heads:
- `direction_persists_60s ≥ threshold`
- `direction_persists_300s ≥ threshold`
- `exit_signal_60s_max < threshold` (NOT an exit signal forming)
- `breakout_in_60s_min < threshold` (NOT pending breakout against the trade)

Tested in `test_thresholds_wave2.py`. Disabled by default — pre-v2 artifact that will be retired once T29 (true v2 gate) ships.

### 3.4 v2 multi-head router (PENDING — T29)

V2 design (V2_MASTER_SPEC §2.4 D55) replaces all of the above with three head-type-specific decision functions (`decide_action_scalp`, `decide_action_trend`, `decide_action_swing`) plus a 3-way ensemble combinator with agreement-window upgrade rule and bias-filter magnitude guard. **Largest pending engineering gap before paper-trade ramp.** See [PROJECT_TODO T29](../PROJECT_TODO.md).

## 4. Model loading + calibration apply

`model_loader.py:load_models()` at startup:

1. Read `models/<inst>/LATEST` pointer → resolve to `models/<inst>/<timestamp>/`.
2. Read `LATEST_HEADS.json` — per-head metadata including `schema_version`.
3. Load 84 `.lgbm` files. Missing files → log warning, return NaN downstream (gate fails open per head).
4. Load `.calibration.json` sidecars (binary heads only — regression heads skip).
5. Call `schema_reconciler.reconcile_loaded_heads()` — pop any head whose recorded `schema_version` doesn't match the highest `config/schema_registry/v<N>.json`. The reconciler is **conservative on uncertainty**: missing `LATEST_HEADS.json`, missing `schema_registry/`, `schema_version=0`, or unsupported file → no quarantine. The reconciler is meant to catch real drift, not fight missing-state.

At inference time, `engine._pred()` calls `models.apply_calibration(target, raw_prob)` for every head. Sidecar-less heads are a no-op (regression outputs or skipped binary fits).

## 5. Signal emission + cooldown

`signal_logger.py` writes one NDJSON record per emitted signal to `logs/signals/<inst>_<date>_signals.log`. Filtered (gated-out) signals go to a separate `<date>_filtered_signals.log` so we can debug why ticks didn't fire.

`engine.run()` enforces a **30-second raw-signal cooldown** (`COOLDOWN_SEC`): consecutive identical signals (same action) within 30 s are suppressed unless they're a new direction. Prevents spam to the UI when a setup re-confirms tick-to-tick.

## 6. Risk-gate delegation

SEA does NOT enforce position caps, daily-loss limits, or layer caps. Those live in the Discipline agent on the Node side ([06 Risk & Discipline](06_risk_discipline.md)). SEA's job is to emit signals; Discipline's job is to validate them.

`risk_control_client.py` is the HTTP client:
- `submit_new_trade()` → POST `/api/discipline/validateTrade` returns `{decision, blockedBy[], tradeId}`.
- `notify_ai_signal()` → POST `/api/risk-control/ai-signal` for ongoing tracking signals.
- INTERNAL_API_SECRET auth header on every call.

Discipline replies APPROVE → signal proceeds to TEA (System 05). Discipline replies REJECT → signal is logged as `gated_by_discipline` with `blockedBy[]` reasons.

## 7. Regime — read-only consumer

Spec D4 / D47 places the regime classifier in TFA (System 02). SEA reads `row.get("regime")` from the live feature stream and passes it through to `decide_action_v2()` for the C4 regime check. The v2 upgrade — `trend_strong` tier (ADX ≥ 30) + 5-min sustain + benign-degradation handling — is a **TFA-side change** tracked as [PROJECT_TODO T32](../PROJECT_TODO.md) (mis-described as SEA work in the T-entry; lives in `python_modules/tick_feature_agent/features/regime.py`).

## 8. Test coverage

**124 tests passing as of 2026-05-23** (post-T25/T27 ship). Files under `python_modules/signal_engine_agent/tests/`:

- `test_thresholds.py` — 8 corner cases for the 3-condition base, edge-of-threshold semantics, missing-prediction fail-closed.
- `test_thresholds_v2.py` — Wave 1 deterministic guards (C4 / C5 / C6).
- `test_thresholds_wave2.py` — Wave 2 model-driven conditions.
- `test_engine.py` — `_pred()`, `_gather_predictions()`, calibration-applied path, NaN fallback.
- `test_model_loader.py` — LATEST pointer parsing, feature_config loading, missing-file errors, calibration sidecar wiring.
- `test_schema_reconciler.py` — happy-path quarantine + every conservative-on-uncertainty path + end-to-end loader integration (9 tests).
- `test_sustain.py` — N-tick window logic.
- `test_signal_logger.py` — NDJSON write, date rotation.
- `test_risk_control_client.py` — HTTP wiring, auth header, error paths.

Integration tests are not present by design — `engine.run()` is an infinite loop and is exercised via end-to-end smoke tests (replay → SEA → signal log).

## 9. Status

ACTIVE. Phase E5 base gate locked; calibration apply (T25) + schema reconciler (T27) shipped 2026-05-23.

**Pending pre-paper-trade work (all in PROJECT_TODO §P1.5):**
- [T29 [SEA]](../PROJECT_TODO.md) — L4 v2 gate + head-type routing (~3–4d). The biggest gap. Replaces the Wave 1 deterministic gate.
- [T30 [SEA]](../PROJECT_TODO.md) — L5 D67 inline composition exits + D68 per-position state (~3–4d). Per-position trail logic, regime-flip protection, partial exits — none in SEA today.
- [T33 [SEA]](../PROJECT_TODO.md) — D56 cohort tagging end-to-end (~1d). Currently signals carry no head-type / layer tag; post-paper-trade attribution impossible without this.
- [T34 [SEA]](../PROJECT_TODO.md) — per-head SHAP report + §5.1 reliability monitoring (~1–2d).
- [T35 [SEA]](../PROJECT_TODO.md) — partial-session handling + inference latency benchmark (~1d).
- [T41 [SEA]](../PROJECT_TODO.md) — production prediction → outcome join (~2–3d). Persists every head prediction; the source-of-truth table for T34 reliability + future feedback-loop work.

**Deprecated code (scheduled for removal):**
- `legacy_filter.py` (129 LOC) + `trade_filter.py` (328 LOC) — pre-E5 regime router + sustained-direction + multi-model consensus + cooldown. Retained behind `--filter=legacy` CLI flag for one A/B validation cycle, then deleted. Tracked as [T43 [SEA]](../PROJECT_TODO.md).
- `thresholds.decide_action_wave2()` — Wave 2 model-driven gate (disabled). Retire once T29 v2 gate is live and validated.

## 10. Cross-refs

- [02 Feature Engineering](02_feature_engineering.md) — feature stream + regime emission.
- [03 Model Training](03_model_training.md) — model + calibration sidecar + LATEST_HEADS provider.
- [05 Execution](05_execution.md) — downstream order-placement (via Discipline approval).
- [06 Risk & Discipline](06_risk_discipline.md) — pre-trade gate + ongoing risk monitoring.
- [PROJECT_TODO.md](../PROJECT_TODO.md) — T29 / T30 / T33 / T34 / T35 / T41 / T43 active.

## 11. Code locations

| What | Path |
|---|---|
| Inference loop + gate dispatch | `python_modules/signal_engine_agent/engine.py` |
| Model + calibration loader | `python_modules/signal_engine_agent/model_loader.py` |
| Schema reconciliation (D66) | `python_modules/signal_engine_agent/schema_reconciler.py` |
| 3-condition gate | `python_modules/signal_engine_agent/thresholds.py::decide_action()` |
| Wave 1 deterministic | `python_modules/signal_engine_agent/thresholds.py::decide_action_v2()` |
| Wave 2 model-driven (disabled) | `python_modules/signal_engine_agent/thresholds.py::decide_action_wave2()` |
| Sustained-direction filter | `python_modules/signal_engine_agent/sustain.py` |
| Signal log writer | `python_modules/signal_engine_agent/signal_logger.py` |
| Discipline HTTP client | `python_modules/signal_engine_agent/risk_control_client.py` |
| Deprecated 4-stage filter | `python_modules/signal_engine_agent/{legacy_filter.py, trade_filter.py}` |
| Per-instrument thresholds | `config/sea_thresholds/<inst>.json` + `default.json` |
| Tests (124 passing) | `python_modules/signal_engine_agent/tests/` |
