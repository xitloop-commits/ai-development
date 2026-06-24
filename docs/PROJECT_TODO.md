# Project TODO — ai-development

Single source of truth for open project tasks. Top = highest priority. Add new items at the appropriate slot; mark closed items by deleting (git history of this file = audit trail).

## P1 — design work while data accumulates

### T3 — Trend-capture retrain (P1 blocker for paper trading)
Current Wave 2 model is a microstructure scalp predictor; v2 adds trend (10-30 min) + swing (30 min - 2 hr) layers. New target spec with noise floor in labels, new multi-TF features, retrain.

- **Status:** Design complete (V2_MASTER_SPEC LOCKED 2026-05-17). Phase 2 implementation ready to start.
- **Blocker:** Need ≥30 sessions of training data **under v2 schema** (per V2_MASTER_SPEC §3.1 Option A: existing ~10 sessions of 402-col parquets become inaccessible when v2 schema ships). Auto-recorder accumulates Mon-Fri → ~6 weeks of recording from schema cutover to first retrain. Reversible: raw .ndjson.gz files retained, can replay later if decision changes.
- **Phases (V2_MASTER_SPEC §6):**
  - [x] Phase 1: Design lock (V2_MASTER_SPEC LOCKED 2026-05-17 — all 8 layers)
  - [x] Phase 2: TFA feature additions — COMPLETE 2026-05-18 (commits `50d9bec` → `54fa8b0`). 22 feature modules + 69 new L1 columns + schema v7 + tick_processor + replay wiring + India VIX feed + shared `feature_pipeline` module + 1600+ tests + smoke-replay-validated.
  - [x] Phase 3: Target additions — COMPLETE 2026-05-18 (commits `60ee991` → `60ee991`). 12 trend + 12 swing target columns + schema v8 + replay-only backfill via `SpotTargetBuffer` (Option B) + 1631 tests + smoke-replay-validated. Live emits NaN for the 24 target cols; replay pipeline backfills end-of-day from recorded raw.
  - [ ] Phase 4: Auto-record accumulation (≥30 sessions, ~30 days passive) ← **ACTIVE — no code work, just time. T5 auto-recorder runs Mon–Fri capturing raw ticks under the new v8 schema.**
    - **Training lifecycle locked 2026-05-19 (V2_MASTER_SPEC D76):**
      1. **v0 stopgap** trained NOW on pre-v8 data (8 sessions nifty as of 2026-05-19) — sanity check + pipeline validation only; not for paper / live.
      2. **30-session gate** — no new retrain runs until ≥30 v8-schema sessions accumulated. Day 1 = Wed 2026-05-20 (first full v8+VIX session). Assuming no NSE/MCX holidays in the window (`config/market_holidays.json` is currently empty for 2026), Day 30 = Tue 2026-06-30 and the first Saturday retrain runs Sat 2026-07-04. Auto-recorder fills the window passively. Each NSE/MCX holiday that lands in this window pushes the dates one trading day later — populate `market_holidays.json` for accurate forecasting.
      3. **Weekly Saturday retrain** kicks in after day-30; runs on full accumulated dataset per §6.1.
      4. Trainer prints a non-blocking WARN if `len(loaded) < 30` so v0-style runs are obvious in logs.
    - **First v11-schema training — nifty50 (COMPLETED 2026-06-21 01:05 IST):**
      - Model: `models/nifty50/20260620_235104/` (LATEST). 84/84 heads trained.
      - Features: 470 (incl. `regime_TREND/RANGE/NEUTRAL/DEAD` one-hot; bonus 1 shipped 2026-06-20). Schema v11 / 560 cols.
      - Dates covered: **29 of 29 available** = 22 train (2026-04-21 → 06-10) + 3 val (06-11, 06-12, 06-15) + 4 calibration held-out (06-16 → 06-19). 1 session short of the 30-gate; trainer's auto-shrink (`cal_days 5→4`) let walk-forward CV (5×5) still fit.
      - banknifty equivalent: NOT YET TRAINED — parallel-launcher bug delayed it (see commits `d2532a2`, `b96d1ee`, `d705dba`). Operator can re-trigger via `--instruments nifty50,banknifty` for next run.
      - Suspicious early val_auc (~0.93-0.98 on `direction_60s`, `breakout_in_60s` first fold). Worth a SHAP pass before treating as production-ready — possible target leakage from a `*_persists_*` head or fold-1 val window being unusually predictable. Not a blocker for the pipeline-validation milestone this run was about.
    - **Phase 2e proposal (2026-05-21, from T7 brainstorm — ON HOLD with T7):** add ~28-30 macro-bias L1 columns (FII/DII, US-session closes WTI/$INR/S&P, Gift Nifty, event calendar FOMC/RBI/EIA/OPEC/CPI/NFP) shared between v2 intraday and T7 swing models. Would bump schema **v8→v9** and reset this accumulation counter. **Hold trigger:** re-engage only after paper/live trading shows significant edge improvement. See T7 "Brainstorm progress (2026-05-21)" sub-block for full details.
  - [x] Phase 5: Retrain pipeline COMPLETE 2026-05-23 — 84 heads + walk-forward CV + isotonic calibration + sim_pnl harness + Saturday scheduler + LATEST_HEADS + D66 schema reconciler all shipped (formerly T23–T27, now closed). T28 (Optuna hyperparam tuning) remains as PRE-Day-30 SHOULD; T41 (Saturday promotion-gate script) is PRE-paper-trade MUST.
  - [ ] Phase 6: Trend gate + swing gate + 3-way combinator + smoke — **expanded into T29–T35** (audit 2026-05-22). Earlier estimate "~3-4 days code" was too low; real scope is ~13-17 days per audit.
  - [ ] Phase 7: Paper trade ramp (ai-paper channel, weeks)
- **Empirical evidence the current model is scalp-only:** 9/9 nifty50 signals on 2026-04-30 / 2026-05-11 were 5-7 pt captures at day-extreme reversals; 85-pt sustained 10:50-11:20 uptrend on 2026-05-11 produced ZERO signals.

## P1.5 — Pre-paper-trade critical path

T28 = PRE-Day-30 SHOULD (hyperparameter tuning before first real retrain). T29–T35 + T41 = PRE-PAPER MUST (must ship before Phase 7 paper-trade ramp). T23–T27 closed 2026-05-23 (training-pipeline build-out, see git log for detail).

### T28 — Hyperparameter tuning infrastructure (Optuna) 🚧 PR1 SHIPPED
Add Optuna sweep job that runs on holdout fold, picks best LightGBM params per head, feeds into Saturday retrain. Currently `LGBM_PARAMS_BINARY`/`_REGRESSION` are hardcoded in `trainer.py:46-67` and no `config/mta_hyperparams.json` exists (T3 Plan §5.2 line 174). Typically 1-3% AUC improvement per head.

**Two-PR plan (2026-06-13):**

**PR1 — Config + read path (shipped 2026-06-13):** Pure plumbing, no behaviour change.
- `config/mta_hyperparams.json` — new file with empty `heads` block + schema doc. Empty config = identical to pre-T28 behaviour.
- `python_modules/model_training_agent/trainer.py`:
  - `_load_hyperparams_overrides(path)` — reads + parses the config, returns `{head_name: override_dict}`. Missing / malformed / wrong-shape config → empty dict + WARN, never raises.
  - `_resolve_lgbm_params(target, objective, overrides)` — merges per-head override onto the hardcoded base (binary or regression). Per-head keys win; unspecified keys inherit. New keys from Optuna (e.g. `min_data_in_leaf`, `lambda_l2`) accepted.
  - `_fit_one` signature extended with `hyperparam_overrides: dict | None = None`. Default None preserves pre-T28 behaviour.
  - `train_instrument` loads the config ONCE per call and threads the parsed dict through both serial + joblib parallel + walk-forward validation paths (passing parsed dict, not path, avoids joblib workers re-reading the file each fit).
- 14 new unit tests in `tests/test_hyperparams_config.py` covering: missing file, malformed JSON, empty/missing/wrong-type heads block, base-verbatim fallback, per-head merge correctness, isolation between heads, accepts new-key Optuna params.

**PR2 — Optuna sweep + tuned config (pending) — ⚠️ RUN BEFORE FIRST REAL RETRAIN:**
- New `scripts/tune_hyperparams.py` runs Optuna per head on the calibration fold, picks best per-head params, writes them into `config/mta_hyperparams.json`. Saturday retrain then picks them up automatically via PR1's read path.
- ~1-2 days build + the sweep itself runs ~hours-to-overnight per instrument.
- Partha-decision 2026-06-13: park PR2; **remind before the 1st real model training cycle** (the one that actually feeds paper trade). Until then the hardcoded defaults in `LGBM_PARAMS_BINARY/_REGRESSION` are used and the plumbing falls through as a no-op.
- Cadence after first build: re-tune every few months OR whenever enough new sessions are accumulated to make a re-sweep worthwhile.

- **Status:** 🚧 PR1 ✅ IMPLEMENTED 2026-06-13 (`faf8917`); PR2 ⏳ parked — REMIND-BEFORE-FIRST-TRAINING.
- **Effort remaining:** ~1-2 days for PR2.
- **Cross-ref:** T3 Phase 5.

### T29 — L4 v2 gate + head-type routing 🆕
**Largest gap.** Implement V2_MASTER_SPEC §2.4 properly: `decide_action_scalp` / `decide_action_trend` / `decide_action_swing` separate decision paths + 3-way ensemble combinator + agreement window + bias-filter magnitude guard. Today `thresholds.py:257` `decide_action_v2` is labelled "Wave 1 gate" in its own docstring — Wave-1 logic + 3 deterministic guards, NOT v2 D55. Engine has no head-type routing (`scalp|trend|swing` grep returns zero in signal_engine_agent).

- **Status:** ⏳ PRE-PAPER MUST.
- **Effort:** ~3-4 days.
- **Cross-ref:** T3 Phase 6; spec D55.

### T30 — L5 D67 inline composition exits + D68 per-position state 🆕
Implement V2_MASTER_SPEC §2.5.1 inline exhaustion/wall-break composition exits + per-position state schema. Exhaustion exists as a TFA FEATURE today but the L5 gate-side ACTION (exit-on-detection) is unimplemented. `wall_break|inline_composition` returns zero matches anywhere.

- **Status:** ⏳ PRE-PAPER MUST.
- **Effort:** ~3-4 days.
- **Cross-ref:** T3 Phase 6; spec D67 + D68.

### T31 — L7 v2 risk controls 🆕
Implement V2_MASTER_SPEC §2.7: layer cap, swing entry cutoff, shared daily-loss budget, event blackout. Currently `server/discipline/` has generic limits (cooldowns, streaks, tradeLimits) but no layer-aware caps. `layer_cap|swing_cutoff|max_concurrent|positions_per_layer` returns zero matches.

- **Status:** ⏳ PRE-PAPER MUST.
- **Effort:** ~2-3 days.
- **Cross-ref:** T3 Phase 6.

### T32 — L8 regime classifier (rule-based per D4) ✅ IMPLEMENTED
Implement V2_MASTER_SPEC §2.8 rule-based classifier: `trend_strong` tier + 5-min sustain + benign degradation handling.

**Implementation (shipped 2026-05-30):**
- `python_modules/tick_feature_agent/features/regime.py` — `compute_regime_features` gains an `adx_5min` arg + new `TREND_STRONG` tier (ADX(14) ≥ 30 AND TREND signals); priority slots between DEAD and TREND. NaN ADX degrades gracefully (falls through to TREND).
- `RegimeClassifier` (new class in same file) — stateful 5-min sustain wrapper. First valid instant reading accepted immediately; transitions held in a candidate slot until `sustain_sec` of continuous agreement; **benign degradation**: `instant=None` (warmup / missing signals) does NOT reset state or flip confirmed. `reset()` on session_start / rollover.
- `tick_feature_agent/replay/replay_adapter.py` + `tick_feature_agent/tick_processor.py` — both adapters instantiate `RegimeClassifier(sustain_sec=…)` in `__init__`; inline-compute `multi_tf` to grab `adx_5min` immediately before the regime call (cheap on cached 5-min bars); call `self._regime_classifier.update(...)` instead of direct `compute_regime_features`; `reset()` on session_start.
- 12 new tests in `tests/test_regime_t32.py`; 24 pre-existing regime tests still pass; full project 2005/2005.
- T41's `regime_tag` column now flows through naturally because TFA's `regime` row column emits `TREND_STRONG` / `TREND` / `RANGE` / `DEAD` / `NEUTRAL`; SEA's existing `row.get("regime")` → log_eval already routes it.

- **Status:** ✅ IMPLEMENTED 2026-05-30.
- **Cross-ref:** T3 Phase 6; spec D4 / D47; later upgrade T17.

#### T32-FU1 — Replace consecutive-sustain with rolling-window majority ✅ IMPLEMENTED
T32's `RegimeClassifier.update` requires **5 minutes of UNINTERRUPTED same-candidate ticks** before flipping the confirmed regime ([regime.py:300-326](python_modules/tick_feature_agent/features/regime.py#L300-L326)). Real intraday data flaps between TREND/RANGE every few ticks; the candidate timer keeps resetting, so the classifier locks into whichever regime won the first 5-min stretch. Surfaced 2026-06-04 when validator's `statistical.regime` check WARNed on the newly-merged 2026-05-22 banknifty parquet ("always 'TREND'").

**Evidence — per-(date, instrument) regime distribution across the 2026-05-20/21/22 banknifty + nifty50 parquets:**

| date | instrument | distribution |
|---|---|---|
| 2026-05-20 | banknifty + nifty50 | 100% NEUTRAL |
| 2026-05-21 | banknifty | 96% TREND + 4% RANGE |
| 2026-05-21 | nifty50 | 100% NEUTRAL |
| 2026-05-22 | banknifty | 100% TREND |
| 2026-05-22 | nifty50 | 95% TREND + 5% NEUTRAL |

**Also surfaced:** `TREND_STRONG` never fires (despite ADX up to 50 on 05-21 banknifty); `DEAD` never fires. Both worth a separate look once sustain is fixed.

**Why it matters:** SEA's Wave-1 gate consumes `regime` for the regime guard; SEA's signal payload + T41's `regime_tag` carry it forward; T33's cohort mapping reads from the same column. A regime that locks into one value per day degenerates regime-conditioned analyses across the whole stack.

**V2_MASTER_SPEC §2.8 D4** says "5-min sustain" — the spec wording is ambiguous between *consecutive* (what's shipped) and *majority-over-5-min* (more robust to noise). The data confirms consecutive is too strict.

**Three fix options (recommendation: option 1):**
1. **Rolling-window majority** — maintain a 5-min ring buffer of instant regimes; promote the candidate when it's the majority (≥70%) over the window. Robust to noise, matches the spec's usual reading.
2. **Tolerate brief excursions** — keep the consecutive logic but allow up to N (~10) opposing ticks before resetting the timer. Smaller code change.
3. **Reduce `sustain_sec`** — same logic with a 60s window. Still flap-prone but less stuck.

**Validation plan once fixed:**
- Re-run replay on 2026-05-22 banknifty (the date that triggered the WARN).
- Confirm validator's `statistical.regime` check returns PASS (multiple regimes present).
- Confirm regime distribution shows realistic transitions (not single-regime lock-in).
- Spot-check that 2026-05-21 banknifty (the only date that DID flip out of TREND with the current logic) still shows reasonable transitions, not over-flipping.

**Implementation (shipped 2026-06-13):**
- `python_modules/tick_feature_agent/features/regime.py` — `RegimeClassifier.update` now maintains a `collections.deque` of `(ts, instant_regime)` tuples for the last `sustain_sec` (default 300s). On every update it appends + age-prunes the window. To promote a non-confirmed regime, the leading non-confirmed regime in the window must hold `≥ majority_threshold` (default 70%) share AND the window must contain `≥ min_window_ticks` (default 10) entries. Public API unchanged (same `update(...)` signature; same `confirmed_regime` / `confirmed_confidence` / `candidate_regime` properties). `candidate_regime` is now derived from the window (most-counted non-confirmed regime), not from a stored timer.
- Same-regime updates refresh confidence in place without scanning the window — cheap path preserved.
- Benign degradation (instant=None) still skipped without entering the window.
- `python_modules/tick_feature_agent/tests/test_regime_t32.py` — 5 sustain tests rewritten to majority semantics + 3 new tests: `test_classifier_brief_excursion_does_not_promote` (50/50 flap stays at confirmed), `test_classifier_flapping_majority_eventually_flips` (the regression test for this bug — 8-out-of-9 RANGE eventually promotes despite constant flap interruptions), `test_classifier_old_entries_fall_out_of_window` (age-prune verification).

**Validation:** Full TFA test suite 1668/1668. The regression test reproduces the exact scenario that broke production: a single TREND tick every 9th update would have prevented promotion under the old consecutive logic; the new majority logic promotes RANGE correctly.

- **Status:** ✅ IMPLEMENTED 2026-06-13.
- **Cross-ref:** parent task T32; bundled with T32-FU3 in same commit; depends on operator re-running replay to regenerate regime-affected columns (`regime`, `regime_confidence`, `breakout_readiness`, `breakout_readiness_extended`, `trend_age_ticks`).

#### T32-FU3 — Fix `_TREND_TAGS` case mismatch in exhaustion.py ✅ IMPLEMENTED
`python_modules/tick_feature_agent/features/exhaustion.py:69` held `_TREND_TAGS = frozenset({"trend", "trend_strong"})` (lowercase). But the regime classifier emits UPPERCASE labels (`"TREND"`, `"TREND_STRONG"`). The membership test on lines 116-117 never matched in production → `trend_age_ticks` was a dead feature (NaN before the first state update, 0.0 forever after) across every replay parquet since T32 shipped.

**Why it matters:** `trend_age_ticks` is a maturity-of-current-trend counter. Fresh trends behave differently from late-stage exhausted ones; a working counter feeds trend-conditioned heads (`exit_signal_*`, `direction_persists_*`, `trend_continues_*`) a real signal instead of a constant. Conservative estimate: 1-2% AUC bump on those heads once parquets are regenerated AND models retrained.

**Implementation (shipped 2026-06-13):** one-line fix in `exhaustion.py:69` — change frozenset contents to UPPERCASE `{"TREND", "TREND_STRONG"}`. Plus a regression test (`test_lowercase_regime_tag_no_longer_counts_as_trend`) that pins the casing contract so a future "let's lowercase the regime tags" change has to update both producer + consumer.

- **Status:** ✅ IMPLEMENTED 2026-06-13.
- **Cross-ref:** discovered during T32-FU1 impact analysis on 2026-06-13; bundled with T32-FU1 in the same commit. Realising the predictive value requires re-running replay (now produces correct `trend_age_ticks`) + retraining the affected heads.

### T33 — D56 cohort tracking end-to-end ✅ PYTHON SIDE IMPLEMENTED
Tag every signal + fill with originating signal type (scalp/trend/swing/multi-day-swing) through the full pipeline: SEA signal log → broker fill log → reliability monitoring. Without this, post-paper-trade attribution analysis (which heads/cohorts are profitable) is impossible.

**Python side shipped 2026-05-28:**
- `python_modules/signal_engine_agent/cohort.py` — window-based classifier (`classify_window_seconds`, `classify_head`, `build_head_type_map`). Boundaries match `features/trend_swing_targets.py` constants (scalp ≤300s, trend 900–1800s, swing 3600–7200s, multi-day-swing >7200s).
- `signal_engine_agent/engine.py` — head→cohort map built once at startup from `_HEAD_PREDS`, passed to `prediction_logger.log_eval(head_types=...)` on every eval (T41's `head_type` column now populates instead of staying NULL). Emitted signal JSON carries a `cohort` field (currently always `"scalp"` since all production gates consume scalp-window heads; will diversify when T29's head-type routing lands trend/swing gate paths).
- 17 new cohort tests + 220/220 SEA suite pass.

**Out of scope this implementation (deferred):**
- TypeScript `server/` side: broker fill log carrying the cohort through to executions + portfolio attribution. The Python signal log now contains the field; TS server work is the natural follow-up.

- **Status:** ✅ PYTHON SHIPPED 2026-05-28. ⏳ TS server side still PRE-PAPER MUST.
- **Cross-ref:** T3 Phase 6; spec D56; precondition for T17/T18/T19/T20 analyses; T34 consumes the populated `head_type` column.

### T34 — Per-head SHAP report + reliability monitoring (§5.1) ✅ IMPLEMENTED
Two coupled observability outputs needed before paper-trade promotion:
- **SHAP-by-instrument report:** `scripts/shap_report_weekly.py` (T3 Plan §5.8 line 113) does not exist. Needed for T14 / T21 evidence-based feature decisions.
- **§5.1 weekly reliability monitoring:** bucket signals by predicted prob, compare to actual win-rate (±5% across deciles = pass). `scripts/trade_quality_report_weekly.py` (T3 Plan line 114) does not exist. Required to validate D72 calibration on live data.

**Implementation (shipped 2026-05-30):**

*Reliability (§5.1):*
- `python_modules/_shared/reliability.py` — pure functions: `is_binary_classifier_head` (filters `direction_*`, `direction_persists_*`, `breakout_in_*`, `exit_signal_*`; excludes `direction_NNs_magnitude` regressors); `score_head_calibration` (sorts by `calibrated_prob`, splits into 10 deciles, computes `|mean_predicted − actual_positive_rate|` per decile, PASS when max ≤ 5%); `score_all_heads` (multi-head sweep); `render_markdown_summary` (per-head verdicts + per-cohort table + FAIL drill-down).
- `scripts/trade_quality_report_weekly.py` — CLI: `--days 7 --end-date YYYY-MM-DD --predictions-root data/predictions --output-dir data/reports --tolerance 0.05 --instrument <inst>`. Reads T41's daily parquets, writes `reliability_weekly_<date>.md` + `.csv`. Exits non-zero only when no data found (FAILing heads surface in the report, not in exit code).
- Heads skipped (insufficient outcomes) listed in the summary so silent gaps don't hide.

*Feature importance (§5.8):*
- `python_modules/_shared/feature_importance.py` — uses LightGBM gain-importance (`importance_type="gain"`) rather than true SHAP — answers the actual T14/T21 question ("which features drive each head, ranked, per instrument?") without pinning the ~20 MB `shap` package. Public API mirrors a real-SHAP wrapper so swap is mechanical if per-row attribution is ever needed. `resolve_latest_model_dir` handles all three on-disk layouts (LATEST symlink, LATEST text file with timestamp string, fallback to manifest timestamp).
- `scripts/shap_report_weekly.py` — CLI: `--instruments nifty50,banknifty --models-root models --top-n 20 --head-filter ...`. Auto-discovers instruments from `<models_root>/<inst>/LATEST_HEADS.json`. Writes `feature_importance_<date>.md` (per-instrument per-head top-N + cross-instrument concordance section) + `.csv` (one row per (instrument, head, ranked feature) for downstream join with reliability CSV).
- Filename kept as `shap_report_weekly.py` per V2 spec §5.8 even though metric is gain — methodology documented in module docstring.

**Validation:**
- 20 reliability unit + CLI tests, 17 feature-importance unit + CLI tests — all green.
- Live smoke against real `models/nifty50/` + `models/banknifty/`: 168/168 (instrument, head) pairs scored, 0 missing.

- **Status:** ✅ IMPLEMENTED 2026-05-30.
- **Cross-ref:** Consumes T41's per-(prediction, outcome) parquet; reliability output validates D72 calibration; feature-importance output feeds T14 / T21 evidence-based feature decisions.

### T35 — Partial-session handling + inference latency benchmark ✅ IMPLEMENTED
Two edge-case items not on prior roadmap:
- **Partial-session / half-day:** `market_calendar.is_market_holiday()` only does an in-set check (`market_calendar.py:55-58`). Muhurat / half-days will be treated as full sessions, mis-labelling targets near abnormal close. Extend `market_holidays.json` schema + add `session_end_sec` lookup.
- **Inference latency benchmark:** 84 heads × 4 instruments has never been benchmarked. `scripts/benchmark_signal_persistence.py` exists but measures DB writes only. Add one-shot harness to verify live inference fits within tick cadence.

**Implementation (shipped 2026-05-31):**

*Partial-session calendar:*
- `config/market_holidays.json` gains a top-level `partial_sessions` block: `{ "YYYY-MM-DD": { session_end_sec: int, reason: str, exchanges?: ["NSE"|"MCX"] } }`. Backward-compatible — old `2026: [...]` per-year arrays still drive `is_market_holiday()`.
- `python_modules/market_calendar.py`: `get_session_end_sec(date, exchange="NSE")` returns the abnormal close (seconds-since-midnight IST) for a partial-session day, OR `NSE_DEFAULT_END_SEC=55800` (15:30) / `MCX_DEFAULT_END_SEC=84600` (23:30) otherwise. `is_partial_session_day(date, exchange=None)` checks membership with optional exchange filter. `get_partial_session_reason(date)` returns the human-readable reason for logging.
- Malformed entries (missing/non-int/out-of-range `session_end_sec`, wrong shape) skipped with stderr WARN — fail-open mirrors the existing holiday-loader.
- 19 unit tests covering: legacy holiday-set behaviour, partial_sessions key NOT leaking into holiday-set, NSE/MCX defaults, no-exchange-filter vs `exchanges:["NSE"]`-scoped entries, all four malformed-entry shapes, and `partial_sessions` as wrong-type (list instead of dict).
- **Wiring into target-labelling deferred** — this T35 ships the lookup API only, per spec. Downstream callers (MTA / SEA target computation) need a follow-up to clamp lookahead windows at `get_session_end_sec(date)` rather than the hard-coded 15:30. Tracked as a follow-up below.

*Inference latency benchmark:*
- `scripts/bench_inference_latency.py` — one-shot harness loading every head listed in `models/<inst>/LATEST_HEADS.json`, running N synthetic evals through each, reporting per-head + per-instrument total latency (mean/p50/p95/p99/max). Heads sharing a feature-count share the same synthetic matrix to keep memory bounded. Per-eval-total p50/p95/p99 are computed on the SUM of per-head times for the same eval index — a realistic "all heads for one tick" number.
- CLI: `--instruments` (auto-discover by default), `--n-evals 1000`, `--warmup 100` (not counted), `--head-filter`, `--output-json` (structured) + `--output-md`. Markdown also goes to stdout.
- 9 unit + CLI tests using a synthetic LGBM bundle fixture; pinned `feature-seed` for determinism. Tests assert shape (`p50 ≤ p95 ≤ p99 ≤ max`, totals = sum of per-head means) rather than absolute latencies (CI machines vary).
- **Live result (2026-05-31, 200 evals, 20 warmup, banknifty + nifty50 LATEST bundles, 84 heads each):**
  - banknifty: total mean 5.94 ms/eval, p95 6.26 ms, p99 6.68 ms.
  - nifty50: total mean 5.72 ms/eval, p95 5.76 ms, p99 5.87 ms.
  - Conclusion: full 84-head sweep fits comfortably inside ~10 ms even under p99, and ~24 ms for 4 instruments concurrently — well under any reasonable tick cadence (~100 ms+). No model-side performance work needed before paper trade.
- crudeoil + naturalgas had no `LATEST_HEADS.json` at time of run; bench auto-skipped them. Pre-existing state.

- **Status:** ✅ IMPLEMENTED 2026-05-31.
- **Cross-ref:** T3 Phase 6. Follow-up below covers target-labelling consumers.

#### T35-FU1 — Wire `get_session_end_sec` into TFA session-boundary computation ✅ IMPLEMENTED
T35 ships the calendar API but did NOT yet make TFA clamp its session_end_sec at the abnormal close. Until that wiring lands, labels on Muhurat Diwali days etc. were computed against post-close NULL/stale prices.

**Scope correction during implementation:** the actual target-labelling code lives in `python_modules/tick_feature_agent/features/targets.py` + `trend_swing_targets.py` (NOT MTA/SEA as originally written). They already accept `session_end_sec` as a parameter; the gap was in how the **callers** (replay_adapter + live main.py) computed that value — they used `_session_boundary_sec(date_str, profile.session_end)` which is just the profile's hard-coded `"15:30"` / `"23:30"`.

**Implementation (shipped 2026-05-31):**
- `python_modules/market_calendar.py` gains `effective_session_end_epoch(date_str, *, exchange, default_hhmm, tzinfo=None) -> float`. Logic: if the date is in `partial_sessions` for the exchange → use the partial value (Muhurat 19:15 IST is LATER than 15:30 default, MCX morning-only 17:00 is EARLIER than 23:30; both handled by trusting the JSON entry); otherwise use `default_hhmm` from the profile. Direct epoch math, no double-conversion bugs.
- `python_modules/tick_feature_agent/replay/replay_adapter.py:279` — `_session_end_sec` now flows through the new helper. Imported via `sys.path` shim because `market_calendar` lives in `python_modules/` root, not under `tick_feature_agent/`.
- `python_modules/tick_feature_agent/main.py` — two live-mode call sites: `_on_session_open()` (sets the processor's session_end at session-open) and `_session_end_enforcer()` (the wall-clock force-stop safety net at session_end + 10s). Both swapped from `_session_boundary_sec(today, profile.session_end)` to `effective_session_end_epoch(...)`.
- Session **start** computation deliberately NOT changed — partial-session entries cover end-of-session only. Muhurat session start (18:15 IST vs default 09:15) is a deeper change requiring a parallel `session_start_sec` field in the JSON; tracked separately as **T35-FU2** below.
- 6 new helper tests added to `test_market_calendar.py` (25 total in that file): normal-day NSE + MCX, Muhurat later-close, MCX morning-only earlier-close, exchange-scoping doesn't leak across exchanges, missing partial-sessions block falls back gracefully.

**Validation:** full project test suite (excluding the 4 pre-existing date-sensitive TFA tests) re-runs green after the replay_adapter + main.py edits.

- **Status:** ✅ IMPLEMENTED 2026-05-31.
- **Cross-ref:** Completes the partial-session loop end-to-end. Closes the labelling-corruption risk on Muhurat / half-session days for replay AND live ingestion.

#### T35-FU2 — Partial-session START handling (Muhurat-only) 🆕
T35-FU1 covers session END. Muhurat days also have a non-default session START (typically 18:15 IST vs profile default 09:15). For target labelling this isn't critical (ticks only arrive during the actual session anyway, so a target tick at 18:30 is well within any sensible window). But for the `_is_market_open` predicate + the launcher's pre-open countdown, the start matters.
- Scope: add `session_start_sec` to partial-session JSON entries (optional); add `effective_session_start_epoch` helper; wire into replay_adapter + main.py.
- Effort: ~½ day. Low priority — only matters if someone replays a Muhurat day OR if the launcher tries to schedule pre-open for one. Both are edge cases.

### T41 — Production prediction → outcome join (feedback-loop foundation) ✅ IMPLEMENTED
Persist every live head prediction (84 heads × every signal eval) to disk, then backfill the actual market outcome N seconds later from the live tick stream. Produces `predictions_<date>.parquet` per instrument joining what the model *said* with what actually *happened* — for all 84 heads, not just heads that fired.

**Implementation (shipped 2026-05-28, commit `c991b0d`):**
- `python_modules/_shared/prediction_schema.py` — 16-col frozen schema (`ARROW_SCHEMA`, `PredictionRow`, `parse_lookahead_seconds`, `feature_snapshot_hash`, `build_arrow_table`).
- `python_modules/signal_engine_agent/prediction_logger.py` — `PredictionLogger` write side; buffered in-memory queue + chunk flush every 50k rows OR 5 min; atomic `.tmp`+rename per chunk; `finalise()` merges chunks into `<inst>_predictions.parquet` on shutdown; scans existing chunks on construction so process restart continues the prediction_id sequence.
- `python_modules/signal_engine_agent/outcome_backfiller.py` — post-session pass with CLI (`py -m signal_engine_agent.outcome_backfiller --instrument <i> --date <d>`); loads underlying-tick stream as sorted (ts_ns, spot) numpy arrays; binary-search per row for spot_at_t0 + window; computes outcome_direction/magnitude/excursion/drawdown; idempotent (skips already-filled rows unless `--force`).
- `python_modules/signal_engine_agent/engine.py` — `_pred_raw_cal` shared by `_gather_predictions` and new `_gather_predictions_raw_cal`; one `_HEAD_PREDS` tuple is single source of truth for head list. `run()` constructs `PredictionLogger` at startup, calls `log_eval(...)` after each gate decision (every eval, both fired + not-fired heads), `finalise()` in try/finally.
- 14 schema+logger tests + 7 backfiller tests pass; full project suite 1976/1976.
- **head_type** + **regime_tag** columns NULL until T33 + T32 land; schema is forward-compatible (Partha-approved option 1).

Schema per row: `prediction_id, ts_ns, instrument, head_name, head_type, raw_prob, calibrated_prob, gate_decision, regime_tag, feature_snapshot_hash, lookahead_seconds, outcome_direction, outcome_magnitude, outcome_max_excursion, outcome_max_drawdown, outcome_filled_ts_ns`. Outcome columns NaN at write time, backfilled by a tail-consumer process after each head's lookahead window elapses.

**Why this is pre-paper-trade MUST:**
- Without this, paper-trade fills produce only a P&L curve — no per-head reliability evidence to build confidence on.
- T34 §5.1 weekly reliability report assumes this source data exists. T34 builds the *report*; T41 builds the *source table*.
- Champion/challenger promotion (future T27 enhancement), recency-weighted retraining, regime-aware retraining, and any future RL / online-learning path all depend on `(prediction, outcome)` tuples.
- If skipped to launch faster, the first month of paper-trade data is unrecoverable for feedback-loop purposes.

- **Status:** ⏳ PRE-PAPER MUST. Added 2026-05-24.
- **Effort:** ~2-3 days. New `signal_engine_agent/prediction_logger.py` + `signal_engine_agent/outcome_backfiller.py` + parquet writer + unit + integration tests.
- **Files expected to touch:** `signal_engine_agent/prediction_logger.py` (new), `signal_engine_agent/outcome_backfiller.py` (new), `signal_engine_agent/engine.py` (`_pred` hook to emit), `python_modules/_shared/prediction_schema.py` (new), tests under each module.
- **Cross-ref:** T27 (Saturday retrain — future champion/challenger needs this), T33 (cohort tagging — must tag prediction rows too), T34 (weekly reliability report — direct downstream consumer), T8/T16/T18 (any threshold/sizing/calibration tuning needs outcome data), [much later] RL / online-learning prerequisites.

### T44 — Per-day per-instrument trade-chart HTML report + launcher menu 🆕
Self-contained Plotly HTML report per (date, instrument) showing every trade overlaid on the spot price curve. One file per pair at `data/reports/<YYYY-MM-DD>/<inst>_trades.html`, generated automatically at session-end after `tick_processor` flushes the day's parquets (matches T5 auto-recorder's "ready by morning" pattern). No web server, no extra project — just static HTML opened by the default browser.

**Visual elements required on each chart:**
- Spot price line (1-min OHLC candles from the day's parquet).
- **Entry markers** (green ▲ for LONG_CE / red ▼ for LONG_PE) at entry tick + entry price label.
- **Exit markers** (X) at exit tick + exit price label.
- **SL line** (dotted red) and **TP line** (dotted green) drawn from entry tick to exit tick.
- **Exit-trigger tag** at each exit: `SL` / `TP` / `TIME_STOP` / `INLINE_EXHAUSTION` / `WALL_BREAK` / `MANUAL` / `EOD_SQUARE_OFF` (sourced from L5 exit reason — T30).
- **Points gained label** at exit (`+5.2` green / `-3.1` red).
- **Hover tooltip per trade:** `entry_ts`, `exit_ts`, qty, entry_px, exit_px, points, ₹ P&L, cohort/head (from T33), regime tag (from T32).
- Day-summary header bar: total trades, wins / losses, net points, net ₹, max drawdown.

**TUI launcher integration:**
- New top-level menu entry **"View Trade Charts"** in `startup/launcher_v2.py`.
- Drill: **instrument submenu** (crudeoil / naturalgas / nifty50 / banknifty) → **date submenu** (most-recent-first list of dates that have a generated report) → enter → `webbrowser.open()` on the HTML file.
- Mirror the existing instrument→date drill pattern already used by the replay/backtest menus.

- **Status:** ⏳ PRE-PAPER MUST. Added 2026-05-24.
- **Effort:** ~3-4 days. Plotly generator (~2 days) + launcher menu (~1 day) + session-end auto-trigger hook + tests (~0.5 day).
- **Files expected to touch:** `python_modules/_shared/trade_chart.py` (new — Plotly builder), `scripts/build_trade_chart.py` (new — CLI entry), `python_modules/tick_feature_agent/output/session_end_hook.py` (new or extend existing — invokes chart builder per instrument), `startup/launcher_v2.py` (new menu + submenus), tests under `python_modules/_shared/tests/`.
- **Data sources:** spot OHLC = day's `<inst>_features.parquet` (1-min resample of `spot` col); trades = broker fill log (TS server-side) + L5 exit-reason log + signal log with cohort tag (T33).
- **Cross-ref:** T33 (cohort/exit-reason tags must be present in fill log), T30 (L5 exit-reason source), T32 (regime tag in tooltip), T34 (shares the `data/reports/<date>/` directory pattern — same generator infra). Prerequisites in priority order: T33 → T30 → T32 → T44.

### T45 — BrokerId rename + LTP source unification ✅ IMPLEMENTED
Broker-infra cleanup paired with the UI bug-fix that motivated it.

- **Rename:** `dhan` → `dhan-primary-ac`, `dhan-ai-data` → `dhan-secondary-ac`. Every reference (server code, all 60 test files, scripts, Python TFA `--broker-id` default, repo docs `systems/05`/`08`/`10`, startup `.bat`) now reads "what + who" at a glance. Startup auto-migration in `server/broker/brokerService.ts` rewrites the two legacy `broker_configs` docs on boot — idempotent, removable after every machine has booted once. Log-tag derivation simplified: existing regex `brokerId.replace(/^dhan-/, "")` now yields `primary-ac` / `secondary-ac` uniformly.
- **LTP source unification:** every LTP shown in the trading desk reads from one stream keyed by `(exchange, contractSecurityId)`, paper-vs-live agnostic. (1) Server `ensureOptionLtpSubscription` routes paper-channel option subscribes through `dhanLive` (primary `dhan-primary-ac`) so paper trades see real market LTPs in the browser tick bus. (2) `NewTradeForm.tsx` and `QuickOrderPopup.tsx` read `getTick(exchange, contractSecurityId)` first; option-chain snapshot is the cold fallback. (3) Both surfaces subscribe the selected option leg via `broker.feed.subscribe` on strike-selection and unsubscribe on change/unmount.
- **Trade history wiped** via new `scripts/reset-trade-history.mjs` so no stale `position_state.brokerId="dhan"` records survive. `broker_configs`, `usersettings`, `executorsettings`, `disciplinesettings` left untouched.
- **Status:** ✅ IMPLEMENTED 2026-05-30 (commits `2a590ed`, `bc45785`, `df29e5f`). All 895 tests pass.
- **Open follow-ups:**
  - ~~Refcounted unsubscribe in `SubscriptionManager`~~ ✅ shipped 2026-05-31 (commit `19a3196`): refCount on each subscription entry, WS sub created on first subscribe and torn down only when refCount hits 0; `tradeExecutor.exitTrade` + `recordAutoExit` now call the matching `unsubscribeLTP` after `recordTradeClosed`. 8 unit tests pin the contract.
  - Live in-market verification of LTP flow (deferred — markets closed Saturday).

### T46 — testing-sandbox channel wired to Dhan sandbox API + Settings token panel ✅ IMPLEMENTED · ❌ REMOVED 2026-06-19
> **REMOVED 2026-06-19:** the entire `testing-sandbox` channel + `dhanSandbox` adapter + `DHAN_SANDBOX_API_BASE` + `sandboxMode`/`metadataSource` plumbing + the Settings "Sandbox Token" panel were deleted. Reasons: sandbox can't validate the live order-protection work (Dhan Super Orders 404 on the sandbox host), it has no real funds path, and its borrowed lot-size resolution fell back to `1` and produced false `DH-905` rejections. Testing is now **live-only** (`testing-live` on the primary account). Mongo `testing-sandbox` data + the `dhan-sandbox` broker config were purged via `scripts/cleanup-sandbox-data.mjs`. The history below is kept as a record.

The `testing-sandbox` channel was historically half-built — `connect()` short-circuited without loading credentials, so every order on the channel rejected with `No Dhan access token configured`. Now it's a real integration test bed.

- **Backend:** new `DHAN_SANDBOX_API_BASE = "https://sandbox.dhan.co/v2"` constant. `dhanRequest` / `validateDhanToken` / `updateDhanToken` accept optional `{ baseUrl }`. DhanAdapter gets `_baseUrl` getter (sandbox host when `sandboxMode=true`) + two private wrappers (`_dhanRequest` / `_validateToken`) that auto-inject `this.accessToken` + `this._baseUrl` — all 17 callsites rewritten via mechanical refactor. `connect()` sandbox branch rewritten to load creds from Mongo + validate token against the sandbox host + skip TOTP refresh (sandbox tokens are pasted manually) + skip WebSocket (sandbox has none). Read-only metadata (option chain / scrip master / WS subscriptions) delegate to the primary live adapter via a new `setMetadataSource(adapter)` hook on DhanAdapter, wired in `brokerService.initBrokerService` right after construction.
- **Credentials:** `scripts/dhan-update-credentials.mjs` gains `--accessToken <JWT>` flag for direct-set tokens (bypasses TOTP); `--show` now also prints `credentials.accessToken` / `credentials.clientId`. Empirically confirmed: live JWT is rejected by sandbox host (`DH-906 "Invalid Token"`) — sandbox needs its own token from `developer.dhanhq.co`.
- **Expiry alerts:** sandbox added to `config/subscriptions.json` (`renewalDayOfMonth: 30`) so the existing subscription-alert pipeline pings Telegram on the 25th-30th of every month, 5 days before each expected expiry.
- **Settings UI:** new `SandboxCredentialsSection` in `client/src/pages/Settings.tsx` (sidebar entry "Sandbox Token") — info box linking to `developer.dhanhq.co`, status row (apiStatus / stored clientId / last updated), masked current token preview, Client ID + JWT inputs with clipboard-paste button, save wired to `broker.token.update` with `brokerId="dhan-sandbox"`. The mutation now accepts optional `brokerId` to target a specific adapter; `broker.config.get` accepts optional `{ brokerId }` so the panel queries the sandbox doc independently of the active broker.
- **Status:** ✅ IMPLEMENTED 2026-05-31 (commits `1ce9f51` backend, `06a2bde` alert config, `930f3fd` Settings panel, `898e37a` Test Connection button, `d08a9ae` SecondaryBrokerBanner). All 908 tests pass.
- **Follow-ups shipped same day:**
  - Test Connection button in the Sandbox panel — probes `sandbox.dhan.co/v2/fundlimit` and toasts the validated clientId, lets the operator verify a freshly-pasted token without restarting the server.
  - SecondaryBrokerBanner — non-blocking amber strip below AppBar when `dhan-secondary-ac` apiStatus is degraded (only when credentials are configured). Sandbox is intentionally excluded (testing-only channel; expiry covered by the subscription-alert pipeline). CredentialGate keeps the hard-block primary-only (every channel's critical path).
- **Still open:**
  - Live in-UI verification Monday: open Settings (F2) → Sandbox Token → confirm status reads "CONNECTED", then place an option trade on `testing-sandbox` and confirm it fills at ₹100 (Dhan sandbox quirk) and shows up in positions.
  - Quirk to document operator-side: Dhan sandbox fills every order at ₹100 regardless of market; capital resets to ₹10,00,000 daily — useful for API-shape validation, not for P&L realism.

## P2 — parked features (small enough to wait)

### TradingDesk trade-entry bars — ✅ SHIPPED 2026-06-06 (gap-audit fixes 2026-06-14)

Replaced `NewTradeForm` with always-on per-instrument `InstrumentBar` bars (`StrikeBar` ready / `TradeBar` open-closed) + click-to-place entry-marker → executor placement; `PastRow` expand-to-show-trades; TradingDesk freeze/leak/repaint hardening (past-day normalize cache, per-instrument `useInstrumentTick`, tickStore TTL); dev `MOCK` feed toggle for offline testing; `broker.feed.ohlc` endpoint. Full design + status in [08 UI Desktop §4](systems/08_ui_desktop.md).

**Shipped 2026-06-14 (TradeBar enhancements + gap-audit fixes):**
- TradeBar reward zone broken into measured E→TSL→LTP→TP gaps; green TSL→LTP buffer band; secured-₹ on the E→TSL chip (only after TSL arms); TSL marker lifted above all layers (z-index).
- Mock feed now also ticks Crude Oil + Natural Gas underlyings (was NIFTY/BANKNIFTY only) + open paper trades' option contracts — all 4 bars and open TradeBars move offline.
- Per-instrument fallback strike-step (`FALLBACK_STRIKE_STEP`: BANKNIFTY 100 etc.) — no longer hard-50 when `instrumentLiveState` is stale.
- Single `optionExchangeFor()` helper replaces 4 inline copies of the "Crude/Gas → MCX else NSE" rule.
- Net/Gross P&L toggle in the desk header is now live (was frozen on Net).
- Pending-TSL tooltip now states the hold-seconds so "pending" doesn't look armed before the server arms it.
- Removed dead `summaryBg` prop from the day-summary banner.
- Removed the hotkey Quick-Order popup (`QuickOrderPopup` + `useHotkeyListener` + 1/2/3/4 hotkeys) and its dedicated `defaultQty` setting — instrument bars are the sole manual-entry path. Shared sizing + SL/TP settings kept; unused `defaultQty` left in the server schema (no DB migration).

**Open gaps (from 2026-06-14 audit):**
- [ ] Stuck "waiting for live data…" — if an underlying tick never arrives, the ready bar / option preview never resolves (no timeout / error / retry). `useOptionPreview` + `InstrumentBarRow`.
- [ ] Frozen trade price — an open trade missing `contractSecurityId` silently shows a stale price (no live subscription, no warning). `TodayTradeRow`.
- [ ] WS-drop polling fallback isn't reactive — `wsConnected` is a module var, so the 2s snapshot fallback won't auto-engage if the socket drops (WS auto-reconnects every 1s, so low risk). `useTickStream`.
- [ ] Thin error / empty UX — contract-not-resolved shows only faint amber text; locked TP/SL click no-ops silently; status badges have no tooltip.
- [ ] Header big-P&L number ignores the new Net/Gross toggle (table P&L columns respect it; header stays net).
- Cross-refs (tracked elsewhere): HeadToHead backend stub (T50); per-event notification toggles UI (T52); InstrumentCard "News Sentiment" placeholder ([08 UI §5](systems/08_ui_desktop.md)).

Carried over:
- [ ] Verify entry-marker → paper placement end-to-end at market open (so far only offline-tested via the dev MOCK toggle).
- [ ] Pre-existing `DhanAdapter.exitAll` unit test fails (predates this work, unrelated) — fix or quarantine.

### T4 — Replay in-date progress + chunked resume (PARTIALLY DONE 2026-05-16)

Show events_done / events_total_est / rate / ETA AND survive power cuts without losing all in-flight work.

- **Status:**
  - [x] TFA side: chunked parquet writes every 50k events OR 5 min, atomic `<inst>_features_progress.json`, warmup-based restart logic, final merge into single `<inst>_features.parquet` (shipped 2026-05-16, see `python_modules/tick_feature_agent/replay/replay_runner.py`).
  - [x] Replay stdout heartbeat now shows `X% done · ETA Ym` based on raw-file-size estimate.
  - [ ] Launcher `act_replay` reads `<inst>_features_progress.json` and surfaces progress in the running-replay row's status_hint (not yet wired).
- **What's already wired:**
  - Worst-case wasted work on power cut / crash: ~5 minutes (was: entire date).
  - Multi-terminal parallel replay (one terminal per (date, instrument)) — each terminal writes to its own per-date chunks, no contention.
  - On restart, the existing terminal command picks up where it left off automatically when relaunched for the same (date, instrument).
- **What's still TODO:**
  - Launcher reads progress.json and shows e.g. `crudeoil 05-13: 43% · ETA 6m` on the replay row.
- **Out of scope:** pre-counting events (rejected — too slow), adding to Train/Backtest (Partha excluded).

### T36 — Re-enable holdout reservation when paper-trade window starts

*(Renumbered from T24 → T36 on 2026-05-23 to resolve collision with the audit-added T24 "Walk-forward CV" in P1.5. Original entry added 2026-05-20.)*
The holdout reservation gate in `config/holdout_dates.json` is set to `"enabled": false` as of 2026-05-20. Every date is currently available for replay and training — no reserved-for-backtest dates. This was deliberately disabled during the Phase 4 accumulation window so we don't lose any of the 30-session minimum to the holdout reservation.

- **Status:** Deferred 2026-05-20.
- **Trigger to re-enable:** when Phase 7a paper-trade kicks off (~Mon 2026-07-06 per `docs/T3_TIMELINE.md`). Before promoting the first real-retrain candidate to LATEST_HEADS, flip `"enabled": true` and bump `"n"` from 1 to 5 (one full trading week reserved per V2_MASTER_SPEC §2.3.1 walk-forward holdout strategy).
- **Change required:** edit `config/holdout_dates.json`:
  - Set `"enabled": true`
  - Bump `"n": 5` (or whatever holdout fold size the spec settles on at that point)
- **Why disabled now:** Phase 4 is pure data accumulation. Reserving the most-recent date(s) would shrink the trainable set when we only have ~30 sessions to work with. Re-enabling is mandatory before paper trade so we have true out-of-sample dates the live model has never seen.
- **Verification when re-enabled:** launcher's `[R]` magenta tags reappear on reserved dates; trainer's holdout-leak check raises if any reserved date sneaks into training.

### T22 — Launcher blue-tick for terminated/partial pipeline stages
Add a 4th color state to the main-screen pipeline status table at [startup/launcher_v2.py:2406](startup/launcher_v2.py#L2406) (`_render_status_table`): **BLUE ✓ when a stage was started but did NOT fully complete** (process died, crashed, killed by power-cut, etc.). Currently the table shows 3 states per stage cell: green (done) / yellow (loading) / dim (none) — missing the "terminated mid-flight" signal.

- **Status:** Deferred 2026-05-18 — user wants this, but 3 design choices need to be resolved first.
- **Trigger to revisit:** any time the user wants to pick this up; no dependency on other tasks.
- **Detection rules (proposed defaults):**
  - **Raw stage:** `.lock` file exists for the date+instrument + no `.ndjson.gz` data file + no live TFA process. (Recorder started, never wrote data.)
  - **Rep stage:** `<inst>_features_progress.json` exists with mtime > 60s + no final `<inst>_features.parquet` + no live replay process. (Chunked replay crashed before merge.) Inverse of existing `_read_replay_progress` at [launcher_v2.py:2260](startup/launcher_v2.py#L2260).
  - **SBT stage:** backtest run dir exists at `data/backtests/<inst>/<version>/<date>/` + no `scorecard.json` inside + dir mtime > 1 hour. (Backtester started but didn't write scorecard.)
  - **Trn stage:** [OPEN — see Q1 below]
- **Code change scope:**
  - 1 helper function per stage (Raw/Rep/SBT terminated detectors)
  - Add `"terminated"` state to the state dict in `_render_status_table` (lines 2448-2477)
  - Add `BLUE("✓")` branch to `_tick()` helper at [launcher_v2.py:2500-2503](startup/launcher_v2.py#L2500-L2503)
  - Update legend / docstring at line 2412
  - `BLUE` color helper already exists at [launcher_v2.py:65](startup/launcher_v2.py#L65) — no ANSI work needed
  - Total: ~80 LOC + 3 unit tests

- **Open questions before coding (3):**

  **Q1 — Train terminated semantics.** Train is multi-date per run; manifest is committed atomically, so a crashed train leaves dates that look identical to "never attempted" from the per-date view. Three options:
  - **A. Skip Trn terminated entirely** (3-state stays — done / loading / none). Simplest. My pick.
  - **B. Scan for orphan timestamp dirs** (`models/<inst>/<ts>/` without `training_manifest.json` AND no train proc) + parse their `args.json` to find which dates were attempted, mark those Trn cells blue. Most accurate, requires verifying trainer writes an `args.json`.
  - **C. Approximate via mtime** (latest timestamp dir without manifest + mtime > 1 hr → mark ALL parquet-but-not-trained dates for that instrument blue). Fuzzy; can spam blue across never-attempted dates.

  **Q2 — Backtest loading state.** SBT has no `kind="backtest"` in `running_processes()` today, so cells can only be done / terminated / none — never yellow.
  - **X. Leave SBT loading unimplemented** for this task. Add terminated only. My pick.
  - **Y. Also add backtest process tracking** (extend `running_processes()` to detect `backtest-scored.bat` via command-line parse). Wider scope.

  **Q3 — Stale-mtime thresholds.** Proposed defaults: replay `progress.json` = 60s, backtest run dir = 1 hour. Reasonable? Or different per stage?

- **Decision needed:** answer Q1 / Q2 / Q3 inline; then ~1 session to code + test + commit.
- **Why deferred:** the memory-leak fix (8e956cb) was the urgent task; this is UX polish that doesn't block any pipeline work. Trivial to pick up later.

### T21 — Feature pruning via SHAP after first retrain + paper-trade data
Reduce L1 feature count from 446 by dropping features that SHAP analysis shows are low-importance across all 84 heads. Pairs with T14 (which ADDS deferred features if SHAP shows need); T21 is the inverse — DROP features that prove unhelpful.

- **Status:** Deferred (added 2026-05-17 from user question "do we need all these features?").
- **Why deferred:** L1 D2 + Gap #24 Option D (LOCKED 2026-05-16) commits to "no pre-prune, no post-train re-train — single training pass on all 446 features, trust LightGBM regularization to ignore junk." External review (ChatGPT) explicitly agrees: "446 features are already sufficient... gains now come from calibration, execution, risk structure, regime adaptation. NOT more indicators." Pre-pruning is guessing without SHAP evidence; LightGBM `min_child_samples ≥ 50` + `lambda_l2 ≥ 1.0` already suppress junk features at near-zero cost.
- **Trigger condition:** AFTER first v2 retrain (T3 Phase 5) produces per-head SHAP report (§5.4 SHAP-by-instrument table) AND ≥1 month of paper-trade results exist. Decision rule:
  - Bottom 10% of features by aggregated abs(SHAP) across all 84 heads → drop candidate.
  - Validate: re-train without those features, compare sim_pnl + per-head AUC. If degradation ≤ 1pp per head, ship the pruned set.
  - Iterate one prune-cycle per Saturday retrain at most (avoid over-trimming on noisy SHAP).

**Pre-identified candidates from 2026-05-17 reduction analysis (verify with SHAP, do NOT drop blindly):**

| Candidate | Block | Features dropped | Risk of dropping |
|---|---|---|---|
| **A8 deep strikes** | Drop slots 4 + 5 of active strikes (keep top 4) | 48 features | MEDIUM — may miss attention-rotation patterns |
| **A6 far OTM offsets** | Drop m3 + p3 strikes (keep m2/m1/0/p1/p2) | 36 features | MEDIUM — far-strike behavior signals tail-risk pricing |
| **A14 metadata as training input** | Keep in parquet for routing, exclude from training features | 9 features | LOW — these are IDs, not predictive |
| **Momentum/velocity redundancy** | Keep only one of `momentum` vs `velocity` | 1 feature | LOW — highly correlated |

Max aggressive prune: 446 → 352 (~21% reduction). Realistic SHAP-validated prune: probably 446 → 380-400.

- **Concrete savings if pruned:**
  - Storage: ~12% smaller parquet rows
  - Training compute: ~12% faster per LightGBM fit, ~2.4 hrs/Saturday saved at full 1,680-fit cycle
  - Inference latency: negligible (already sub-ms per head)
  - Maintenance: smaller surface for schema drift + simpler SHAP reports

- **Why pruning re-opens L1:** every locked decision downstream (target alignment, schema_version, schema_registry/v<N>.json, sim_pnl baselines) currently assumes 446. Dropping features requires:
  - New `LATEST_SCHEMA_VERSION` bump (e.g., v7 → v8)
  - New `config/schema_registry/v8.json` written by emitter (per D66 additive-only policy — WAIT, this VIOLATES additive-only since we'd REMOVE features)
  - Forces FULL retrain of all 84 heads (additive-only protects from this; remove-only requires it)
  - Wave 2 legacy heads on v7 schema get quarantined automatically per D66

- **Cross-references:**
  - L1 D2 / Gap #24 Option D — the "no pre-prune" policy this would explicitly revisit
  - T14 — the inverse task (add deferred features post-SHAP)
  - D66 — additive-only schema policy; T21 is the documented exception
  - §5.4 SHAP-by-instrument report — the evidence source

- **Spec change when ready:**
  - V2_MASTER_SPEC §2.1.1 — drop feature count
  - V2_MASTER_SPEC §2.1.2 / §2.1.3 / §2.1.4 — mark dropped rows
  - V2_MASTER_SPEC §2.1.5 — move dropped features to "explicitly skipped" with SHAP-driven rationale
  - V2_MASTER_SPEC §9 — add D-entry noting which features dropped, the SHAP evidence
  - L1 D2 status: amend from "LOCKED no-prune" to "PRUNED via T21 after SHAP evidence ..."

### T20 — Meta-ensemble model (replace rule-based 3-way combinator)
Replace current rule-based combinator (longest horizon dominates / disagreement skips / agreement-window upgrade) with a learned meta-model.

- **Status:** Deferred (added 2026-05-17 from ChatGPT feedback, Missing #5).
- **Trigger condition:** rule-based combinator hits a clear P&L ceiling — e.g., §5.1 weekly report shows 3-of-3 agreement trades win 70% but only 5% of total trade count, while solo cohort trades win 45% across 60% of trade count. That's a meta-model opportunity (learn which combination patterns predict which outcomes).
- **Work required:** new LightGBM head per instrument with inputs `{scalp_prob, trend_prob, swing_prob, regime, india_vix, minutes_from_open, disagreement_pattern}` → output calibrated trade probability. Train on paper-trade outcomes from ≥6 months of D56 cohort data. ~2 weeks work.
- **Spec change when ready:** V2_MASTER_SPEC §2.4 — replace rule-based ensemble with learned head. Update D3/D55/D61 in §9.
- **Why deferred:** rule-based first is the right call — explainable, debuggable, ships now. Meta-model promotion is justified only if rule-based proves inadequate on real data.

### T19 — Trade-environment-quality "no-trade" classifier
Dedicated model scoring "is the current market regime worth trading at all?" Complements L8 chop suppression and L7 blackout windows with a unified session-quality signal.

- **Status:** Deferred (added 2026-05-17 from ChatGPT feedback, Missing #6).
- **Trigger condition:** paper-trade analysis shows ≥15% of total losses come from identifiable bad-session conditions that L8 chop tag + L7 blackout windows didn't catch. Examples: surprise low-volume drift days, post-news whipsaw windows, expiry-eve premium decay traps.
- **Work required:** hand-label ~50 historical sessions as good/bad based on trade-quality outcomes + train LightGBM regression head producing `trade_environment_quality_score ∈ [0, 1]`. Add new L7 hard-block: skip all gates if `score < 0.4`. ~1 week work.
- **Spec change when ready:** V2_MASTER_SPEC §2.7 — add session-quality gate. Update D in §9.
- **Why deferred:** L8 chop + L7 blackouts already cover most "don't trade" cases. Adding a third don't-trade layer is only worth it if data shows we're still losing in identifiable bad sessions.

### T18 — Volatility-adaptive thresholds
Every fixed threshold in v2 (noise_floor, θ_dir, dwell, cooldown, ADX 30, etc.) gets a static default PLUS an adaptive multiplier scaled by current volatility.

- **Status:** Deferred (added 2026-05-17 from ChatGPT feedback, Missing #4 + Conflict 3).
- **Trigger condition:** §5.1 weekly trade-quality report shows systematic threshold mismatch — either too many false fires in high-vol weeks (thresholds too loose) or too many missed setups in calm weeks (thresholds too tight). 4 weeks of paper data minimum to detect the pattern.
- **Work required:** define volatility regime metric per instrument (likely `ATR_15m_now / ATR_15m_30d_baseline`). For each threshold, decide multiplier function (linear scaling, bucketed, etc.) + safety bounds. ~1 week work + extensive walk-forward re-validation since every threshold change ripples into sim_pnl.
- **Spec change when ready:** V2_MASTER_SPEC §2.4 + §2.5 + §7 — add adaptive-multiplier columns alongside static defaults. Update D40/D47/D57/D59 in §9.
- **Why deferred:** real future edge but BIG redesign that would re-open multiple locked layers. Needs paper-trade evidence that fixed thresholds are actually leaving money on the table. Markets ARE non-stationary, but LightGBM trees with `realized_vol`/`adx`/`india_vix` features may already learn the conditional behavior implicitly. Validate the gap exists before paying the cost.

### T17 — Learned regime classifier (upgrade L8 D4)
Train LightGBM regime classifier head alongside rule-based L8 classifier when rule-based proves inadequate.

- **Status:** Deferred.
- **Trigger condition:** §5.1 trade-quality weekly report shows ≥20% of losing trades exit on regime-mis-tagged conditions (e.g., entered as `trend`, exited because regime was actually `chop`) over a 4-week rolling window. OR ADX baselines per instrument show systematic mismatch with default 25/15 thresholds.
- **Work required:** hand-label ~100 regime windows from holdout data (estimated 8 hrs focused work) + train 4th LightGBM head per instrument + integrate into L8 classifier (rules + learned ensemble).
- **Spec change when ready:** V2_MASTER_SPEC §2.8 — add learned classifier alongside rule-based. Update D47 in §9 to RESOLVED.

### T16 — Confidence-weighted position sizing (upgrade L6 D2)
Promote sizing from equal allocation (L6 D2 Option D, ships with v2) to confidence-weighted (scale lots by predicted_prob / 0.5).

- **Status:** Deferred. Gated by same reliability check as T8 (cost-floor migration).
- **Blocked by:** first v2 retrain producing calibrated probabilities + reliability-diagram check (±5% predicted-vs-actual win rate across deciles). **Calibration mechanism added 2026-05-17 via V2_MASTER_SPEC D72** (isotonic regression per head, applied at runtime) — the reliability check is now actionable instead of being a circular gate.
- **Why upgrade:** equal sizing wastes capacity on near-threshold signals. Confidence weighting puts more capital on best signals — higher sharpe IF probabilities are reliable.
- **Spec change when ready:** V2_MASTER_SPEC §2.6 — replace equal-sizing formula with weighted. Update D2 in §9 to RESOLVED.

### T15 — Limit-order optimization for execution
Investigate limit-order execution to reduce slippage cost. L5 D4 locked market orders for v1 to match sim_pnl validation assumption.

- **Status:** Deferred. Reduces real slippage by 1-3 pts/trade if fills succeed; can break sim_pnl ↔ live coherence.
- **Blocked by:** ≥200 paper fills per instrument (T3 Phase 7). Measure: % of would-have-been-limit-orders that fill within 5s at midprice.
- **Trigger to upgrade:** if fill-rate ≥70% across paper trades AND slippage savings ≥1 pt/trade on filled signals.
- **MCX-first priority (added 2026-05-17 per Gemini feedback + V2_MASTER_SPEC §7 warning):** crude/natgas books are thin; market-order self-impact may exceed even the 35%/40% cost-floor buffers under fast moves. When 100+ paper fills accumulate per MCX instrument, prioritize T15 implementation for crude/natgas BEFORE nifty50/banknifty. Trigger to escalate earlier: if observed MCX slippage regularly exceeds `cost_floor_buffer_pct` in §5.1 weekly report.
- **Spec change when ready:** V2_MASTER_SPEC §2.5 L5 D4 — upgrade to Option B/D. Mirror change to sim_pnl §2.3.4 to assume limit fills where applicable. Re-validate with walk-forward.

### T14 — Add 8 deferred L1 features post-paper-trade (+ Gemini convexity follow-up) 🚧 SCOPE F SHIPPED

**Scope F (2026-06-13, shipped):** of the 8 deferred features, only 2 land features that LightGBM provably cannot compose from existing snapshot-row features — both stateful (second derivative / persistence counter). Shipped:
  - `premium_acceleration_drop_atm_ce` + `_pe` — second derivative of ATM premium momentum. When premium WAS rising fast (prev momentum > 0) and slowed/reversed, emit the magnitude of the drop. NaN before first valid prev; 0 when prev ≤ 0 or current ≥ prev.
  - `strike_migration_persistence_ticks` — counter of how many consecutive ticks the active-strike shift direction has stayed the same sign. 0 on no-shift ticks; resets to 1 on sign flip; held across NaN inputs so warmup blips don't wipe state.

**Implementation:**
- New compute modules in `python_modules/tick_feature_agent/features/`: `premium_acceleration.py` (PremiumAccelerationState) and `strike_migration_persistence.py` (StrikeMigrationPersistenceState). Both reset on session_start / expiry rollover.
- Wired into `replay_adapter.py` + `tick_processor.py` via the same pattern as RegimeClassifier (state on adapter, reset in flush_all, .update() called per emit).
- Emitter gains `t14_feats` kwarg + 3 new column names appended after the trend/swing target block. Schema **v9 → v10**.
- 19 new unit tests covering all edge cases (NaN inputs, sign flips, reset, extended runs, drop semantics).
- Full TFA suite 1700/1700.

**Skipped (no lift expected — LightGBM can compose from existing features):** `rsi_14_15min`, `ma_cross_event_5min`, `breakout_event_5min`, `premium_vwap_cross_strength`.

**Skipped (overlap with existing features):** `active_strike_rotation_score` (covered by `active_strike_shift_velocity` + `active_strike_shift_direction`), `momentum_deceleration` (covered by existing `momentum_persistence_ticks` + `underlying_velocity`).

**Skipped (Gemini follow-up):** `moneyness_velocity_atm` — original deferral criterion (wait for SHAP evidence that existing A16 Greeks + C4 dealer-hedging don't capture convexity) still applies.

---
**Original deferral rationale preserved below.**
Add 8 features deferred at L1 D2 lock (2026-05-16) if first-retrain analysis shows missing signal that these would capture. Plus 1 additional feature from 2026-05-17 Gemini review (Greek-acceleration / moneyness velocity) if SHAP shows A16+C4 don't capture convexity.

- **Status:** Deferred. Add only if needed (most can be composed by LightGBM from accepted features).
- **Deferred features (L1 D2 2026-05-16):**
  - `rsi_14_15min` (C2)
  - `ma_cross_event_5min` (C2)
  - `breakout_event_5min` (C2)
  - `momentum_deceleration` (C5)
  - `premium_acceleration_drop` (C5)
  - `active_strike_rotation_score` (C7)
  - `strike_migration_persistence` (C7)
  - `premium_vwap_cross_strength` (C8)
- **Gemini follow-up candidate (added 2026-05-17):**
  - `moneyness_velocity_atm` — captures Greek-acceleration as a strike moves toward/away from ATM, normalized by `hours_to_expiry`. Gemini's claim: LightGBM can't compose Greek convexity over 2-hour swing windows from existing features. **Counter-evidence:** we already have A16 Greeks (`atm_ce_delta`, `atm_gamma`, `atm_theta`, etc.) + C4 dealer-hedging (`net_gex`, `gamma_flip_distance_pct`, `charm_estimate_atm`, `vanna_estimate_atm`) which directly capture convexity dynamics. Only add this explicit feature if SHAP analysis post-first-retrain shows A16/C4 importance is LOW on swing-horizon heads despite presence of strong convexity moves in the data.
- **Decision criterion:** if SHAP analysis (§5.4) shows existing features that should be capturing these patterns have low importance OR show inconsistent signals, add the explicit feature.
- **Spec change when ready:** V2_MASTER_SPEC §2.1.4 — move row from DEFER to ACCEPT, bump L1 active count.

### T37 — Order-book depth features (levels 1-4) ✅ IMPLEMENTED

*(Renumbered from T25 → T37 on 2026-05-23 to resolve collision with the audit-added T25 "D72 isotonic calibration" in P1.5. Original entry added 2026-05-21.)*
Currently every Dhan FULL option tick carries 5 depth levels (parsed in `binary_parser.parse_depth_levels`). Level 0 (top bid/ask price + size) already feeds features; levels 1-4 are parsed and discarded. Add ~10-15 new L1 columns built from the full 5-level book.

**Implementation (shipped 2026-06-13):**
- `python_modules/tick_feature_agent/buffers/option_buffer.py` — extended `OptionTick` NamedTuple with 16 new fields (`l1_*..l4_*` price + qty for both sides). All default to 0/0.0 so legacy callers (test fixtures, synthetic ticks) keep constructing unchanged. New helper `depth_levels_to_kwargs(depth: list[dict])` maps the recorded depth array into the kwarg shape.
- `python_modules/tick_feature_agent/replay/replay_adapter.py` + `tick_processor.py` — both option-tick handoffs now read `data["depth"]` from the recorded packet and feed it through the helper into the OptionTick. Raw `.ndjson.gz` already carries the full depth array (verified on `data/raw/2026-05-20/banknifty_option_ticks.ndjson.gz`) so this works on existing recorded sessions.
- `python_modules/tick_feature_agent/features/option_depth.py` (new, ~210 LOC) — computes **13 depth-derived features** per option leg from L1-L4: bid+ask qty sums, imbalance, total qty, qty-weighted prices + spread, wall detection (max qty + level), depth slope. Returns all-NaN for None / synthetic / illiquid ticks; never crashes.
- `python_modules/tick_feature_agent/features/option_tick.py` — `compute_option_tick_features` merges the depth dict into the per-(strike, opt_type) feature dict. `_NULL_FEATURES` sentinel extended with the same keys so callers see a consistent schema regardless of `tick_available`.
- `python_modules/tick_feature_agent/output/emitter.py` — schema **bumped v8 → v9**. Added 26 ATM-only depth columns (`opt_0_ce_depth_*` + `opt_0_pe_depth_*`, 13 keys per side). Far-OTM strikes don't emit depth columns — would mostly be NaN and triple the schema width for marginal signal. `_build_column_names()` appends them after the existing option-tick block; `assemble_flat_vector` writes them via a dedicated ATM block keyed by `_DEPTH_FIELD_NAMES` imported from the depth module.

**Schema counts:**
- 2-window legacy MVP: 495 → **521** (+26)
- Canonical 4-window: 519 → **545** (+26)
- Schema registry: `config/schema_registry/v9.json` auto-written on next emitter boot.

**Validation:** Full TFA test suite 1681/1681 passes (was 1666; +15 net = 13 new depth-compute + 2 emitter-shape tests). 13 emitter / replay_adapter / tick_processor tests had hardcoded column counts updated from 495 → 521 (or 519 → 545 / 497 → 523 for the tick_processor +2 metadata case). The `test_real_repo_registry_v8_present` test was renamed `test_real_repo_registry_latest_present` and now references `LATEST_SCHEMA_VERSION` so future bumps stay a one-line edit.

**Predictive value:** small per-column lift; stacks across all 84 heads once next training cycle consumes the new columns. Realising the gain requires (a) re-running replay on the affected dates so the new columns populate in the parquets, then (b) the next model retrain.

- **Status:** ✅ IMPLEMENTED 2026-06-13.
- **Realistic lift:** 2-5% win-rate (not a silver bullet — more data + label quality + D72 calibration remain the bigger levers).
- **Cost paid:** schema bump v8→v9, **resets the 30-session Phase 4 accumulation counter** per the original cost note.
- **Not in scope (separate task if ever needed):** 20-level depth feed via Dhan `SUBSCRIBE_DEPTH` (RequestCode 23). Marginal value — levels 6-20 sparse on Indian options books, likely separate Dhan data tier. Revisit only if these 5-level features show high SHAP importance AND we see evidence of losing trades on deep-book moves.

---
**Original planning notes preserved below for archive — superseded by the implementation above.**

- **Status:** Deferred 2026-05-21. Brainstormed as part of "ways to increase win-rate"; depth data is already on the wire — no Dhan subscription change, no rate-budget cost.
- **Realistic lift:** 2-5% win-rate (not a silver bullet — more data + label quality + D72 calibration remain the bigger levers).
- **Trigger to engage:** AFTER first v9 retrain (T3 Phase 5) when SHAP shows top-of-book features (`bid_size`, `ask_size`, `bid`, `ask` from level 0) land in the upper half of head importance — confirms book microstructure is signal-bearing for our heads. If level-0 features are low-SHAP, deeper levels are noise too — skip.
- **Cost:** schema bump v8→v9, **resets the 30-session Phase 4 accumulation counter**. If Phase 2e macro-bias is also approved, ship both together in one v9 bump to avoid two resets.
- **Candidate features (10-15):**
  - `book_imbalance_top5` — (Σbid_qty − Σask_qty) / (Σbid_qty + Σask_qty) across all 5 levels
  - `total_bid_size_top5`, `total_ask_size_top5` — sum of qty across 5 levels
  - `bid_price_gap_1_2`, `ask_price_gap_1_2` — gap between best and 2nd-best price
  - `avg_bid_size_levels`, `avg_ask_size_levels` — mean qty per level (depth uniformity proxy)
  - `bid_orders_total`, `ask_orders_total` — sum of order counts (Dhan's `bid_orders`/`ask_orders` fields)
  - `book_skew_top5` — weighted price imbalance (qty-weighted bid VWAP vs ask VWAP)
  - `liquidity_cliff_bid`, `liquidity_cliff_ask` — biggest single-level qty drop across the 5 levels
- **Implementation:**
  - New feature module: `python_modules/tick_feature_agent/features/depth.py` reads `depth[1..4]` from each option packet.
  - Per-strike emission (8 active strikes × 10-15 features = 80-120 option-side L1 columns).
  - Wire into emitter, bump `schema_registry/v9.json`, update `FEATURE_HEAD_RECONCILIATION.md`, ~600 LOC + tests.
  - V2_MASTER_SPEC §2.1.2-§2.1.4 — add new columns; §9 add D-entry recording trigger evidence.
- **Not in scope (separate task if ever needed):** 20-level depth feed via Dhan `SUBSCRIBE_DEPTH` (RequestCode 23). Marginal value — levels 6-20 sparse on Indian options books, likely separate Dhan data tier. Revisit only if 5-level features show high SHAP importance AND we see evidence of losing trades on deep-book moves.

### T13 — Auto-generate feature catalog
Create `scripts/generate_feature_catalog.py` that reads `python_modules/tick_feature_agent/output/emitter.py` `_build_column_names()` + module docstrings, emits `docs/FEATURE_CATALOG.md` table (name, source module, brief description). Hook into pre-commit so any TFA change auto-updates the catalog.

- **Status:** Deferred. Low priority — does not block trading.
- **Why needed:** with 446 active features post-v2 (377 base + 23 B-block + 46 C-block ACCEPT), no lookup tool exists today. Anyone debugging a bad signal or onboarding spends hours grepping code.
- **Effort:** ~50 LOC script + 1 pre-commit hook line.
- **Upgrade path:** per-feature importance + provenance (Gap #22 Option D) — see D35.

### T12 — Drift-triggered auto-retrain (gated)
Promote drift detection from alert-only (Gap #14 Option C, ships with v2) to auto-trigger retrain when drift threshold breached (Option D).

- **Status:** Deferred. Risky — auto-retrain unattended could ship a worse model.
- **Blocked by:** Need confidence in (1) walk-forward validation discipline + (2) regression test plan (Gap #7) preventing bad model deploys.
- **Why upgrade:** alert-only requires human watching Telegram. Drift on weekends/vacations = lost weeks. Auto-retrain pipelined through regression tests = self-healing system.
- **Spec change when ready:** V2_MASTER_SPEC §5.3 — add auto-trigger pathway gated on regression-test pass. Update D25 in §9 to consider auto-retrain gating threshold.

### T11 — Upgrade slippage model Option B → C (volume-conditional)
Promote slippage model from fixed per-strike-distance penalty (Option B, ships with v2) to volume-conditional dynamic penalty (Option C).

- **Status:** Deferred. Add to design backlog only.
- **Blocked by:** Paper-trade liquidity-pattern data — need to observe how `opt_X_volume` correlates with actual fill quality across 100+ paper fills per instrument.
- **Why upgrade:** Option B applies a uniform per-strike-distance penalty regardless of momentary liquidity. Mornings/afternoons differ; days with news differ. Option C applies penalty only when `opt_X_volume < threshold`, capturing intraday liquidity variation.
- **Spec change when ready:** V2_MASTER_SPEC §2.3.4 — replace strike-distance penalty with volume-conditional formula. Update D20 in §9 to RESOLVED.

### T10 — Recalibrate slippage_pct_per_strike_distance from real fills
Tune the per-instrument `slippage_pct_per_strike_distance` defaults (0.3/0.5/1.0/1.5%) using actual paper-trade fill data.

- **Status:** Deferred. Calibration task, no spec rewrite.
- **Blocked by:** 100 paper fills per instrument (T3 Phase 7).
- **Method:** for each fill, compute `actual_slippage = abs(fill_price - mid_price) / premium`. Group by strike_distance. Set `slippage_pct_per_strike_distance` = mean across all observations for that instrument.
- **Spec change:** update V2_MASTER_SPEC §7 numbers in place. Mark D19 in §9 RESOLVED.

### T9 — Upgrade Sim-PnL metric from Option C → Option D (multi-scenario)
Promote validation metric from single bid/ask-slippage replay (Option C, ships with v2 first retrain) to multi-scenario {best, expected, worst} reporting (Option D).

- **Status:** Deferred. Add to design backlog only.
- **Blocked by:** Paper trade ramp (T3 Phase 7) producing 50+ real broker fills across all 4 instruments.
- **Why upgrade:** Option C uses worst-case bid/ask fills uniformly — too pessimistic for instruments/times when limit orders inside spread fill. Option D's "expected" scenario calibrates from actual fill data, "best" and "worst" frame the uncertainty envelope so decision-maker sees full picture.
- **Validation gate:** before promoting, accumulate ≥50 paper fills per instrument; compute distribution of (actual_fill_price − mid_price) / spread; use mean/p25/p75 as expected/best/worst slippage assumptions.
- **Spec change when ready:** V2_MASTER_SPEC §2.3.4 — extend formula to report 3 scenarios; decision threshold uses "expected" but flags if "worst" goes negative. Update D18 in §9 to RESOLVED.

### T8 — Migrate gate cost-floor from TP-floor (B) to EV-floor (D)
Promote L4 gate cost-floor from "TP must clear costs" (Option B, ships with v2 paper trade) to "expected value must clear costs" (Option D — `(P_win × TP) − ((1 − P_win) × SL) > min_expectancy`).

- **Status:** Deferred. Add to design backlog only.
- **Blocked by:** First v2 retrain (T3 Phase 5) + reliability validation on calibrated probs. **Calibration mechanism is now spec'd** (V2_MASTER_SPEC D72, added 2026-05-17 from ChatGPT feedback): isotonic regression per head, fit on dedicated 1-week calibration fold, applied at runtime before threshold compare. `scale_pos_weight` alone does NOT calibrate — it balances training. D72 is what makes EV-floor probabilities trustable.
- **Validation gate:** before promoting, run the §5.1 weekly reliability monitoring (bucket signals by predicted prob, compare to actual win-rate). Pass = ±5% deviation across deciles.
- **Why upgrade:** Option B blocks high-probability low-magnitude trades that have positive expectancy. Option D captures the real economics — allows trades like "78% win probability × 18 pts TP − 22% × 14 pts SL = +11 pts expected" which B would reject for TP < cost-floor.
- **Spec change when ready:** V2_MASTER_SPEC §2.4 — replace the cost-floor hard veto with the EV formula. Update D17 in §9 to mark RESOLVED.

### T7 — Multi-day swing trade capability (1–3 day overnight hold)
Add support for swing trades held 1–3 days (overnight) on the 4 traded instruments. **Scope narrowed 2026-05-17:** intra-session swing (30 min – 2 hr hold, square-off before close) is now part of v2 (D55). This task covers only the multi-day overnight case.

- **Status (2026-05-21):** **HOLD — re-engage only after paper/live trading shows significant edge improvement.** Brainstorm progress (Q1-Q3 + rules + Phase 2e proposal) preserved below for resumption.
- **Trigger to re-engage:** v2 intraday (scalp + trend + intra-session swing) demonstrates meaningful, sustained edge in paper trading and/or live trading. Until that signal exists, no further T7 design work or spec writing.
- **Blocked by:** T3 (v2 intraday paper trade ramp). Reason: extending v2 with daily-bar targets/features now would dilute focus on the noise-floor/multi-TF label fix that's the actual critical path.
- **Why it's hard:** different time horizon (1–3 days vs intra-session), different features (daily OHLCV bars, FII/DII flows, sector rotation), different risk profile (overnight gap, higher margin, MCX physical settlement), different brokerage structure (delivery rates, STT-on-physical).
- **Approach when ready (Option B from 2026-05-16 brainstorm):** parallel pipeline — separate daily-bar TFA-equivalent, separate models, separate SEA loop, separate channel in BSA. Do NOT bolt 1d/2d/3d targets onto intraday v2.
- **Data required:** 6–12 months of daily OHLCV bars per instrument (different acquisition path than the tick recorder — NSE/MCX provide free daily history).
- **First doc to write when unblocked:** `docs/SWING_OVERNIGHT_SPEC.md`.

#### Brainstorm progress (2026-05-21) — ON HOLD

Active brainstorm walked through 6 design questions to lock the spec; **paused at Q4** pending paper/live evidence trigger. Below is the captured state for whenever T7 re-engages.

**Locked picks:**
- **Q1 horizon:** 1-3 days strict (theta beyond 3 days hurts; matches weekly index expiry cycle).
- **Q2 instruments:** all 4 (nifty50, banknifty, crude, natgas).
- **Q3 vehicle:** long CE/PE only (no futures, no spreads). Spreads deferred as post-paper-trade upgrade.
- **Rule set layered on top:**
  - Mandatory exit by Friday 15:25 (no weekend hold).
  - MCX: no entries within 10 days of commodity expiry.
  - NSE indices: no entries on expiry day (Thursdays).
  - Indices use next-week or next-month expiry contracts (avoids weekly-expiry trap on Mon/Tue entries that would otherwise span Thursday).

**Pending (resume here next session):**
- **Q4 data source:** proposed — bhavcopy daily history as model input, ticks for execution only (clean train↔live consistency). Awaiting OK.
- **Q5 decision cadence:** proposed — 15:25 decide, 15:29 entry (full session structure seen + 1-min Lubas/bot override window). Awaiting OK.
- **Q6 risk sleeve:** proposed — separate capital sleeve (~30%), independent daily-loss budget. Awaiting OK.

**Bottlenecks identified (in order of severity):**
1. **MCX overnight slippage** — unverifiable until ~3 months of real swing fills accumulate. Mitigation: seed at 3-4× intraday observed slippage, human-confirmed first 50 fills, hard absolute premium cap per trade.
2. **NSE/MCX scraper fragility** — exchange bot detection breaks libraries every few months. Mitigation: freshness checks + dual-source where possible.
3. **Overnight gap risk on commodities** — crude/natgas can gap 30%+ on weekend/event news. Mitigation: hard premium cap, mandatory event blackouts, defined-risk via long-option-only.
4. **Strike-level IV edge cases** — deep OTM near expiry settles at 0.05 floor → garbage IV. Mitigation: filter settle <0.1, use ATM IV as fill.
5. **Compounded timeline** — T3 Phase 4 (~6 wks) → T3 Phase 5-7 (~2-3 mo) → T7 P1-P6 (~18-21 days) → T7 P7 (~1-3 mo) = ~7-9 months wall time to first real swing capital.
6. **Capital fragmentation** across 4 swing instruments. Mitigation: max 1 open swing position per instrument.
7. **Event calendar maintenance** — RBI/FOMC dates drift, OPEC dates political. Manual upkeep unavoidable.

**Coupled decision — Phase 2e (v2 + T7 shared macro-bias feature expansion):**

The data fetchers needed for T7 (daily bhavcopy, US closes, FII/DII, event calendar, Gift Nifty) produce features that would also benefit v2 intraday models (especially L8 regime classifier + trend layer). Recommendation: build the fetcher pipeline once, share between v2 + T7.

Add ~28-30 new L1 macro-bias columns to v2 schema (bumps **v8→v9**):
- **FII/DII daily flow** (~8-12 cols) — cash market net (today/5d/10d/20d), F&O participant net, long/short ratio.
- **US-session closes** (~8-10 cols) — WTI overnight % + 5d + 20d + realized vol, $INR overnight + 5d, S&P futures overnight + 5d + realized vol.
- **Gift Nifty** (~2-3 cols) — overnight % change, 9:00am IST gap size, 5-day overnight trend.
- **Event calendar** (~8-12 cols) — hours-to-FOMC/RBI/EIA/OPEC/CPI/NFP, is-event-today/tomorrow, in-pre-event-blackout-window, in-post-event-window.

Cost: schema bump v8→v9; **T3 Phase 4 accumulation counter resets when schema ships**. LightGBM scaling: confirmed comfortable at ~475 columns total (headroom to ~2,000 features at our ~660k row count per instrument).

**Data sources required (all free, no paid feeds):**
- NSE daily bhavcopy — `archives.nseindia.com/products/content/sec_bhavdata_full_<DDMMYYYY>.csv` via `nsepython` or `jugaad-data`.
- NSE F&O bhavcopy — `archives.nseindia.com/content/historical/DERIVATIVES/...` via same libraries.
- MCX daily bhavcopy — `mcxindia.com/market-data/bhavcopy` (custom scraper ~50 LOC).
- NSE FII/DII flow — `nseindia.com/api/fiidiiTradeReact` via `nsepython.fii_dii_data()`.
- US-session closes — `yfinance` library, tickers `CL=F` (WTI), `USDINR=X`, `ES=F` (S&P futures).
- Gift Nifty — NSE IX site or Yahoo Finance.
- Event calendar — `investpy` library or scrape `investing.com/economic-calendar` directly.
- Strike-level IV — computed locally via `py_vollib` (Black-Scholes inversion), no external source.

**Development roster for T7 (post-brainstorm-lock):**
- **P1 Spec lock:** write `docs/SWING_OVERNIGHT_SPEC.md` covering all 6 Qs + rule set + feature list + risk wiring + validation gate — 2-3 days.
- **P2 Data fetcher layer:** 7 fetchers (NSE cash bhavcopy, NSE F&O bhavcopy, MCX bhavcopy, FII/DII, US closes via `yfinance`, Gift Nifty, event calendar) + local IV computation — ~4 days code + 2 days validation.
- **P3 Feature + target emitter:** ~28-30 new daily-bar L1 cols + 12 swing targets (1d/2d/3d × 4 instr), backfill 3+ yrs from bhavcopy archive — ~3 days.
- **P4 Training pipeline:** separate daily-bar trainer (not tick-fed), 48 swing heads (12 × 4) with isotonic calibration per head, walk-forward CV — 3-4 days.
- **P5 Gate + decision logic:** 15:25 decision, 15:29 entry, swing extension of 3-way combinator, Lubas/bot alert + 1-min override — 3 days.
- **P6 Risk + execution wiring:** separate capital sleeve, per-instrument sub-cap, MCX expiry-distance hard block (≥10 days), NSE expiry-day block, Friday mandatory-exit time-stop, event-blackout calendar, 09:15 gap-handler with auto-exit if SL gapped through — 3 days.
- **P7 Validation + paper:** walk-forward 2024-2025 holdout with 2× conservative slippage, then ≥1 month signal-only paper, then real capital ramp — passive, 1-3 months wall time.

Total code work ≈ 18-21 days; total wall time to live ≈ 4-5 months once T3 Phase 7 unblocks T7.

## HOUSEKEEPING — small chores

### T6 — Locked `.claude/worktrees/angry-aryabhata-e93cfa` directory
Worktree directory survived removal because something has an open file handle. Disk space only — git no longer tracks it. Removable after closing the application holding the lock or after next reboot.

- **Status:** Deferred — harmless until next system reboot or manual cleanup.
- **How to clean later:** Either find + close the locking process (Resource Monitor → CPU → Associated Handles), or schedule deletion via `MoveFileEx` for next boot.

### T38 — Dhan ToS confirmation for spouse-account AI Live pattern 🆕
Confirm with Dhan customer support that the spouse-account pattern (Client `1111388877` holding 4 TFA WebSocket subscriptions + `ai-live` orders, funded from spouse's own income/savings) complies with their Terms of Service. Without confirmation, AI Live runs paper-only.

- **Status:** Deferred 2026-05-23 (admin task, not engineering). Carried forward from archived `docs/memory/project_dual_account_live.md` (originally surfaced 2026-04-25).
- **Blocker for:** Phase 8 (AI Live real-capital ramp).
- **How to act:** ticket Dhan support with the dual-account topology described in [systems/05_execution.md §4](systems/05_execution.md); attach client IDs (primary `1101615161` + spouse `1111388877`).
- **Cross-ref:** [systems/05_execution.md](systems/05_execution.md), [systems/10_launcher_ops.md](systems/10_launcher_ops.md).

### T39 — yow-partha graceful-stop refactor (direct-spawn architecture) 🆕
Refactor the yow-partha Telegram bot so Lubas spawns it as a direct child process (not via a separate polling daemon). Cleaner process lifecycle, better stop-signal propagation, no orphan listeners on Lubas restart.

- **Status:** Deferred 2026-05-23 (carried forward from per-machine auto-memory `project_yow_partha_resume.md`).
- **Effort:** ~1 day; design notes already captured in the resume memory.
- **Cross-ref:** [systems/09_control_bot.md](systems/09_control_bot.md).

### T40 [INGEST] — Tick-loss monitoring + alerting 🆕
Add mid-session anomaly detection to the recorder: trigger Telegram alert when (a) tick drop rate exceeds 10% of the per-instrument baseline, or (b) a feed gap exceeds 10 s without a Dhan reconnect, or (c) a WebSocket disconnects without resubscribing within 30 s. Today TFA only logs final tick counts at session-close; mid-session degradation goes unnoticed until the daily review.

- **Status:** Deferred 2026-05-24 (surfaced during System 01 doc rewrite).
- **Effort:** ~1–2 days. Add a `tick_health_monitor` task inside `tick_processor.py`; emit via existing `_notify_yow_partha` path.
- **Cross-ref:** [systems/01_data_ingestion.md §7](systems/01_data_ingestion.md). Pair with [T22](#t22--launcher-blue-tick-for-terminatedpartial-pipeline-stages) on the launcher-side display.

### T42 [MTA] — Saturday promotion-gate script ✅ IMPLEMENTED
After the Saturday retrain produces `training_manifest.json` with `sim_pnl_*` summary keys, an external script must decide whether to update `models/<inst>/LATEST` to the new run or hold for manual review. Today the cron retrains and writes artifacts; the promotion decision is implicit-manual. Per V2_MASTER_SPEC §2.3.4 the rule is: promote iff `sim_pnl_total ≥ baseline_sim_pnl × 1.20` AND per-trade expectancy ≥ ₹8.

**Implementation (shipped 2026-05-31):**

- `python_modules/_shared/promotion_gate.py` — pure decision functions:
  - `decide_promotion(*, candidate_manifest, baseline_manifest, multiplier=1.20, min_expectancy_inr=8.0)` → `PromotionDecision(verdict ∈ {PASS, FAIL, SKIP}, reason, …)`. Handles all edge cases inline (no-baseline first run → PASS+note, candidate==LATEST → SKIP, candidate older than LATEST → SKIP, `sim_pnl_skipped=True` → SKIP w/ reason, `sim_pnl_signals==0` → SKIP, baseline ≤ 0 → PASS on expectancy floor alone, expectancy below floor → FAIL even on large absolute total).
  - `list_dated_bundles`, `newest_bundle`, `load_manifest`, `resolve_current_latest_bundle`, `update_latest_pointer` (atomic via `.tmp` + os.replace).
  - `format_decision_for_telegram` — compact multi-line summary with PASS/FAIL/SKIP icon, candidate + baseline timestamps, both metric blocks.

- `scripts/saturday_promote.py` — CLI:
  - `--instruments`, `--models-root`, `--multiplier 1.20`, `--min-expectancy-inr 8.0`, `--no-promote` (alert-only), `--no-telegram` (local-only), `--dry-run` (implies --no-telegram).
  - Default behaviour (Partha 2026-05-31): **dynamic baseline = current LATEST's `sim_pnl_total_inr`**; **auto-promote on PASS, alert on FAIL/SKIP** ("silence is success"); alerts route to **yow-partha** via the same env-var pattern as `tick_feature_agent.main._notify_yow_partha`.
  - Exit code: 0 = at least one PASS or all SKIPs; 1 = ≥1 FAIL (operator review); 2 = no instruments / fatal.
  - Forces UTF-8 on stdio so the ₹ symbol doesn't crash on Windows cp1252.

**Validation:**
- 29 unit + CLI tests (`python_modules/_shared/tests/test_promotion_gate.py`): all PASS/FAIL/SKIP branches, atomic LATEST update, dry-run no-side-effects, --no-promote keeps LATEST on PASS, exit codes, explicit `--instruments` filter, Telegram format.
- Live `--dry-run` against real `models/` correctly produced SKIP for all three instruments (banknifty + nifty50 = already-LATEST, crudeoil = missing manifest — pre-existing state).

**Operator workflow:** the Saturday cron `Lubas-Retrain-Saturday` (02:00) should be followed by `py scripts/saturday_promote.py` ~02:30. Adding it to `startup/install-scheduled-tasks.ps1` is the natural next step (deferred — install-scheduled-tasks edits land via the launcher work cycle, not the MTA cycle).

- **Status:** ✅ IMPLEMENTED 2026-05-31.
- **Cross-ref:** [systems/03_model_training.md §14](systems/03_model_training.md). Sister task to T28 (Optuna); both gate the Saturday workflow.

#### T42-FU1 — Wire `saturday_promote.py` into the Saturday Windows task ✅ IMPLEMENTED
T42 shipped the script + tests but did NOT initially append it to the `Lubas-Retrain-Saturday` cron. Until wiring landed, the script ran manually only — the auto-promotion benefit wasn't realised.

**Implementation (shipped 2026-05-31):**
- Chose to chain inside `scripts/retrain_v2.bat` rather than register a separate scheduled task. Reason: retrain can run for ~5 hours at Day 30+ per the existing 16-hour ExecutionTimeLimit; a parallel 02:30 task would risk firing while retrain is still writing the bundle. Sequential chain guarantees retrain → promote ordering, no time-budget guessing.
- `scripts/retrain_v2.bat` — after the per-instrument retrain loop, unconditionally invokes `"%PYTHON_CMD%" "%~dp0saturday_promote.py"`. Runs unconditionally so instruments that trained successfully get auto-promoted even if a sibling instrument failed (failed siblings produce SKIP "no readable training_manifest.json" — no LATEST change, but a Telegram alert so operator sees both issues at once).
- Final task exit code = `max(retrain_rc, promote_rc)` — Windows Task Scheduler history surfaces either failure type.
- `startup/install-scheduled-tasks.ps1` — updated the top-banner doc, the section comment ("retrains + auto-promotion gate"), and the registered task `-Description` so future reinstalls see the promote step is part of the same task.

**Env-var note:** `YOW_PARTHA_BOT_TOKEN` + `YOW_PARTHA_CHAT_ID` need to be in the Windows user-level environment for the scheduled task to see them (the `dotenv/config` loader BSA uses doesn't apply to BAT scripts). If a future Saturday alert silently fails, check the user-level env first.

- **Status:** ✅ IMPLEMENTED 2026-05-31.
- **Cross-ref:** T42 in this doc. Net change: ~25 added LOC in retrain_v2.bat + ~5 LOC of comment refresh in install-scheduled-tasks.ps1.

### T43 [SEA] — Remove deprecated legacy_filter.py + trade_filter.py ✅ IMPLEMENTED
Pre-E5 4-stage filter (`legacy_filter.py` 129 LOC + `trade_filter.py` 328 LOC = 457 LOC dead code) retained behind `--filter=legacy` CLI flag for one A/B validation cycle. Phase E5 base gate has been locked + validated since 2026-04-30. Time to delete.

**Implementation (shipped 2026-05-31):**
- Deleted `python_modules/signal_engine_agent/legacy_filter.py` (regime-aware action router shim).
- Deleted `python_modules/signal_engine_agent/trade_filter.py` (4-stage sustained/confidence/consensus pipeline).
- Deleted `python_modules/signal_engine_agent/tests/test_trade_filter.py` (the Phase E10 PR2 lock — no longer locking anything that exists).
- `python_modules/signal_engine_agent/engine.py` cleanup:
  - Removed `from signal_engine_agent import legacy_filter` import.
  - Removed `run()` parameters: `filter_mode`, `sustained_n`, `avg_prob_thresh`, `filter_cooldown_sec`. Promoted the gate-mode body out of the `if filter_mode == "gate":` block.
  - Removed `--filter`, `--sustained-n`, `--avg-prob-thresh`, `--filter-cooldown` CLI args.
  - Removed inner-loop `else: # Legacy path — regime router + 4-stage filter` branch (3-cond/wave1/wave2 gates promoted out).
  - Removed `else: # Legacy path: 4-stage filter → trade recommendation` filtered-output branch.
  - Removed `filter_mode` field from the emitted signal dict (gate_mode remains).
  - Removed legacy stats print in the `finally` block.
- `backtest_scored.py` cleanup (mirror of engine.py — same dead surface in the offline backtest runner):
  - Removed `from signal_engine_agent import legacy_filter` + `TradeFilter` imports.
  - Removed `run_scored_backtest()` legacy params.
  - Removed dual `if filter_mode == "gate" / else` branches in the inner loop + filtered-output section.
  - Removed `_compute_filtered_metrics()` (orphaned).
  - Removed `--filter`, `--sustained-n`, `--avg-prob-thresh`, `--filter-cooldown` CLI args.
  - Output dir suffix kept as `gate/` (preserves cross-scorecard tooling paths).
- `python_modules/signal_engine_agent/tests/test_engine.py` cleanup: replaced `test_decide_via_gate_is_a_module_attribute` + `test_engine_imports_thresholds_and_legacy_filter` (which asserted the legacy_filter module attr) with gate-only equivalents.
- Stale docstring updates in `sustain.py` + `thresholds.py` removing the "retained behind --filter=legacy for one cycle" prose.

**Validation:** SEA test suite passes 162/162; full project suite passes (excluding the 4 pre-existing date-sensitive TFA fails). Net deletion ~520 LOC.

- **Status:** ✅ IMPLEMENTED 2026-05-31.
- **Cross-ref:** [systems/04_signal_engine.md §9](systems/04_signal_engine.md).

### T45 [BSA] — Wire DesyncReconciler position-compare logic 🆕
On reconnect after a broker disconnect, the design (Disconnect_Safety_Spec §2) calls for comparing broker-side open positions against Portfolio Agent state and surfacing any drift as `BROKER_DESYNC` events. Today the `DesyncReconciler` is a **stub** — kill-switch toggling + Telegram alerts work; the position-compare step doesn't. Risk: silent position desync after a long disconnect blob.

- **Status:** Deferred 2026-05-25 (surfaced during System 05 doc rewrite). PRE-paper-trade SHOULD; PRE-AI-Live MUST.
- **Effort:** ~1–2 days. On `Reconnect` event, fetch broker-side open positions via Dhan REST, diff against `portfolioAgent.getOpenPositions(channel)`, emit `BROKER_DESYNC` for any mismatch; quarantine the workspace until operator resolves.
- **Cross-ref:** [systems/05_execution.md §9](systems/05_execution.md), [systems/07_portfolio_reporting.md](systems/07_portfolio_reporting.md).

### T46 [TFA] — GPU-accelerated feature math for replay (Phase C of replay-parallelism plan) 🆕
Offload heavy windowed feature math (rolling std / EMA / percentile bands / regime-window stats) to GPU via CuPy. Stacks on top of Phase A (CPU fan-out across dates) and Phase B (per-date event batching), both planned in conversation 2026-05-25. Per-event control flow stays on CPU; only large-array math touches GPU. CuPy → NumPy fallback when CUDA absent.

- **Status:** Deferred 2026-05-25 — current GPU is **NVIDIA T1000 (4 GB VRAM, ~2.5 TFLOPS)**. On this card, expected gain over Phase A+B is only **~15–25%** at meaningful engineering cost (CuPy dep, per-worker GPU memory management, CUDA-driver contention across 16 workers, fallback path). Not worth shipping today.
- **Trigger to revisit:** GPU upgraded to a ≥8 GB VRAM compute card (RTX 4060 / 4070 / 4080 or equivalent). At that point C unlocks roughly 4–8× more headroom than on the T1000.
- **Effort:** ~3–4 days when triggered. CuPy adapter for the 5–8 heaviest feature classes + cross-worker GPU contention design (single queue, or 2–4 GPU workers + N CPU workers) + golden-file byte-equality test vs CPU output + NumPy fallback.
- **Expected speedup once shipped on a real GPU:** +50–100% on top of A+B for batch jobs (i.e., today's serial baseline → ~45–60× faster vs ~25–35× with A+B alone).
- **Prerequisite:** Phase A and Phase B must ship first (they expose the batching API that C plugs into).
- **Cross-ref:** T47 (Phase A — must ship first; exposes the worker-fan-out API), T48 (Phase B.0 spike — must complete + green-light before B.1–B.5 unlock the columnar batching API that C plugs into), [systems/02_feature_engineering.md](systems/02_feature_engineering.md) (replay-parallelism design context).

### T47 [TFA] — Replay parallelism Phase A: CPU fan-out across dates + multi-worker progress dashboard ✅ IMPLEMENTED
Replace the serial `for date_str in dates_iter` loop in `replay/replay_runner.py` with a `ProcessPoolExecutor`-based fan-out so one CLI call can replay N dates in parallel on the i9-13900K's 24 cores. Pair with a `rich`-based multi-worker progress dashboard — top row: aggregate `X / Y dates done · Elapsed · ETA`; per-worker rows: visual bar + events processed + events/sec + per-date ETA + chunk M/N progress (yellow during warmup re-feed on resume); a "Warnings & errors" section between per-date table and tally that lists every WARN/FAIL date with the validator's non-PASS check reasons (or exception text on stream/parquet/worker failure); bottom row: running pass/warn/fail/skip tally. Live `tick_processor` path **untouched** — replay-only change. Each worker still writes its own `<inst>_features_progress.json` so yow-partha and the launcher can poll the same files (closes T4's deferred launcher wire-up).

- **Status:** ✅ IMPLEMENTED 2026-05-25 across commits `ee39da7` (initial) → `c47f584` (warmup-aware heartbeat + Warnings & errors section + `Console(force_terminal=True)` + `Live(screen=True)` render-tearing fix). Smoke-tested 3 workers × 3 nifty50 dates against `data/raw`; dashboard rendered cleanly. 31/31 replay tests pass. PROJECT_TODO entry kept for one cleanup cycle before deletion.
- **Follow-ups (2026-06-14):** `cc1016a` — graceful Ctrl+C drain: workers ignore SIGINT and let the parent cancel pending futures + flush in-flight via `as_completed`; dashboard walks RUNNING → STOPPING (red) → EXITED (green) per date, then waits for a keypress before tearing down (LUBAS_HEADLESS=1 bypasses). `f22b541` — unified single + multi-date paths: deleted the `if n_workers == 1:` serial branch, extracted `_resolve_dates_to_process()` pure helper, stripped ~135 lines of legacy `\r` heartbeat / print fallbacks in `run_one_date` (every invocation now runs through the pool + dashboard; worker-exception → fail-verdict now applies to single-date runs too). `71d437d` — Ctrl+C actually stops in-flight workers via a cooperative `__stop__` sentinel polled at the 50k-event heartbeat (SIGINT-ignore alone wasn't enough — `shutdown(cancel_futures=True)` only cancels pending); banner moved INTO the ProgressDashboard's alt-screen frame so the primary screen stays clean after tear-down; KeyboardInterrupt no longer re-raised out of `replay()` → no spurious `Exception ignored on threading shutdown` traceback. **Next commit** — PASS-only checkpoint advance + `--date X` always-replay: WARN/FAIL no longer advance the pointer (they get auto-retried on next range run instead of silently skipped); explicit `--date X` now routes through the include_dates branch so it bypasses the checkpoint (operator typed the date → operator gets the date replayed).
- **Previously:** ⏳ PRE-paper-trade SHOULD. Planned 2026-05-25.
- **Effort:** ~3–4 days, one PR.
- **Expected speedup:** ~12–15× on a 30-day batch replay. Single-date latency unchanged (A is per-date parallelism only).
- **Locked design defaults (decided 2026-05-25 against confirmed hardware: i9-13900K 24c/32t, 31.7 GB RAM, NVMe PCIe 4):**
  - `--workers` default = `min(num_dates, 16)`; hard cap 20 (leaves 8+ cores for OS / recorder / yow-partha / bot; saturates NVMe before saturating CPU).
  - Concurrency model = `concurrent.futures.ProcessPoolExecutor` (process per worker, no GIL, no shared mutable state).
  - Per-worker env: `OPENBLAS_NUM_THREADS=2`, `MKL_NUM_THREADS=2` (prevents thread oversubscription once T48/B-full lands BLAS-backed columnar trackers).
  - Checkpoint write safety: `portalocker` file-lock around `ReplayCheckpoint.mark_complete()` (workers finish out of order; lock prevents corrupt JSON).
  - Progress lib: **`rich`** — `rich.live.Live` + `rich.table.Table`, refresh ~10 Hz, fed from a `multiprocessing.Manager` dict that every worker writes to.
  - Single-date / single-worker runs collapse to one worker row + overall row (still useful).
  - Live single-process mode keeps today's `\r` heartbeat — zero change there.
  - Ctrl+C: propagates to all workers; each flushes its own chunk via the existing per-date `KeyboardInterrupt` path → fully resumable.
- **Files expected to touch:** `python_modules/tick_feature_agent/replay/replay_runner.py` (rewrite `replay()` body), `python_modules/tick_feature_agent/replay/checkpoint.py` (add filelock), `python_modules/tick_feature_agent/replay/progress_dashboard.py` (new, ~150 LOC), `python_modules/tick_feature_agent/tests/test_replay.py` (extend), `requirements.txt` (add `rich`, `portalocker`), `startup/start-replay.bat` (passthrough `--workers`).
- **Cross-ref:** T4 (launcher per-date progress wire-up — the per-worker JSON files this task writes are exactly what T4 was waiting on), T48 (Phase B.0 spike — blocks on T47 shipping for measured baseline), T46 (Phase C — plugs into the same worker pool once GPU is upgraded), [systems/02_feature_engineering.md](systems/02_feature_engineering.md).

### T48 [TFA] — Replay parallelism Phase B.0: realized_vol vectorisation spike ✅ IMPLEMENTED
Convert ONLY the `realized_vol` feature class (rolling std over 3 windows: 5/20/50 ticks) from per-event scalar updates to Polars `rolling_std` columnar processing. Measure per-date speedup + verify byte-equality vs scalar to decide whether to commit ~5–6 weeks to Phase B-full (T50).

**Spike result (2026-05-25):** scalar 11.2 min / Polars 134.5 ms / **4988× speedup** on 2M-tick synthetic stream; 0 mismatches across 600 sampled rows × 3 windows, max float diff 1.16e-15. **Decision gate cleared by ~1600× → T50 GREEN-LIGHT.**

- **Status:** ✅ IMPLEMENTED 2026-05-25. Files: `python_modules/tick_feature_agent/features/realized_vol_columnar.py` (new), `python_modules/tick_feature_agent/tests/test_realized_vol_columnar.py` (5 equivalence tests, all pass), `scripts/bench_realized_vol_spike.py` (new benchmark), `requirements.txt` (added `polars==1.41.0`). Scalar `realized_vol.py` untouched; spike is opt-in via direct import.
- **Honest caveat on the 5000× number:** that's `realized_vol` in isolation. Real replay runs ~30 trackers per event, so whole-date speedup once all hot trackers are vectorised (T50) lands in the originally-planned **3–5×** range. The 5000× proves the approach works and Polars is fast enough; total replay speed becomes bound by the still-scalar trackers + IO until they too are converted.
- **Effort:** ~3–5 days.
- **Decision gate at end of spike (commit upfront, no re-litigating):**
  - **≥3× on `realized_vol`** → green-light B.1–B.5 (rewrite top 5 trackers as columnar; ~5–6 weeks; target ~3–5× per date, ~45–75× on 30-day batches when combined with T47).
  - **1.5–2×** → reconsider; trackers likely aren't the bottleneck; ~2× ceiling without a deeper rewrite.
  - **<1.5×** → **abort B-full**. Bottleneck is elsewhere (likely IO / parquet write / merge_streams). Re-plan around that, don't keep pushing on trackers.
- **Why this risks the rest:** TFA pipeline is fundamentally stateful — every event mutates ~10 trackers; `feature_pipeline.py:31` explicitly says *"Threading: single-threaded."* Mistakes are silent: wrong feature value → wrong model input → wrong predictions in live trading. Golden-file diff on every PR is non-negotiable, and live mode never gets touched by B.
- **Files expected to touch:** `python_modules/tick_feature_agent/features/realized_vol.py`, `python_modules/tick_feature_agent/replay/columnar_batcher.py` (new), `python_modules/tick_feature_agent/tests/test_realized_vol_columnar.py` (new — includes golden-file harness), `requirements.txt` (add `polars`).
- **Cross-ref:** T47 (must ship first ✅), [systems/02_feature_engineering.md](systems/02_feature_engineering.md), T46 (Phase C plugs into the columnar API this task introduces, once a real GPU is in the box), T50 (B-full umbrella — only kicks off if this spike returns ≥3×).

### T50 [TFA] — Replay parallelism Phase B-full: tracker columnarisation umbrella 🆕
Convert TFA's per-event stateful trackers (the hot ones) to Polars columnar `update_chunk(df)` so every replay date runs **3–5× faster** per worker. Combined with T47's CPU fan-out, a 5-date batch drops from ~30–40 min to **~6–10 min** for Partha's typical workload. Live `tick_processor` path remains scalar (untouched) — replay-only refactor.

**T48 result (2026-05-25):** 4988× speedup on `realized_vol` alone, 0 equivalence mismatches → **GREEN-LIGHT**. T50 is now active.

- **Status:** 🟢 ACTIVE 2026-05-25 (T48 green-lit). Sub-phase B.1 (profile + scope) is the next concrete step.
- **Total effort:** ~5–6 weeks.
- **Expected speedup vs today:** 3–5× per date; 5-date batch ~30–40 min → ~6–10 min.

**Sub-phases (sequential — each its own PR, each golden-file gated). B.3 list locked 2026-05-25 against profile data on 2026-04-28 (pre-v8) + 2026-05-22 (v8 schema) — both rankings agreed.**
  - [x] **B.1 — Profile + scope** (DONE 2026-05-25): Profiled 500k events on 2026-04-28 and 2026-05-22. Top hot trackers (by tottime / call frequency): `levels.compute_max_pain_features` (34.8s), `targets.compute_targets` (31.0s), `compute_side_strengths` (10.0s), `dealer_hedging` + `bs_greeks` (~7s combined), `_c7_center_of_mass` + `compute_strike_rotation_features` (~6s combined), `compute_oi_weighted_levels` (2.5s). **`realized_vol` is NOT in the top 30** — the T48 5000× win on it accounts for <1% of total replay time; kept the columnar code but deprioritised in the sequence. Reports at `docs/T50_PROFILING_REPORT.md` + `docs/T50_PROFILING_REPORT_v8.md`.
  - [ ] **B.2 — ColumnarBatcher** (~2–3 days): new `python_modules/tick_feature_agent/replay/columnar_batcher.py` that buffers `merge_streams` events into 5–10k-row Polars chunks per event type. Adapter still scalar; this is purely a refactor that changes the source shape. Golden-file must pass byte-for-byte.
  - [x] **B.3a — `compute_max_pain_features` → columnar** (DONE 2026-05-26): O(N) prefix-sum algorithm + per-date pre-compute cache + adapter monkey-patch (replay-only, scoped to `run_one_date`). End-to-end on 500k events: **1.54× wall-time speedup**, byte-identical parquet output (0 mismatches on 3 max-pain cols + 50 sampled others). Per-function spike on real chain data: 126×. Shipped across commits 894d9fc → 4129990 → 7245e03 → e86717e. `TFA_LEGACY_MAX_PAIN=1` env var = one-flip rollback.
  - [x] **B.3b — `targets.compute_targets` + `trend_swing_targets.compute_targets` → columnar** (DONE 2026-05-27): Both replay-only target backfill functions vectorised via Polars. `targets_columnar.compute_targets_batch_spot` covers the 5 spot-based families (direction, magnitude, persists, breakout_in, exit_signal); `compute_targets_batch_per_strike` covers the 7 per-strike families (max_upside CE/PE, max_drawdown CE/PE, risk_reward_ratio, total_premium_decay, avg_decay_per_strike). `trend_swing_targets_columnar` covers all 24 trend+swing columns. Adapter wire-in via new `replay/targets_cache.py` module: batched flush_all + _flush_pending paths with `TFA_LEGACY_TARGETS=1` env-var rollback. End-to-end on 500k events of 2026-05-22: **B.3a + B.3b combined = 1.92× wall-time speedup** vs full-scalar baseline (98.80s → 51.40s); byte-identical parquet output. Shipped across commits `1420cc3` → `cdff319` → `e68308c` → `05a4586`.
  - [x] **B.3c — `active_features.py` cluster → columnar** (DONE 2026-05-27): `compute_side_strengths_batch` Polars-vectorised in `features/active_features_columnar.py` — shift(1).over(strike) for per-strike vol_diff lookback, group_by(snapshot_id).min/max for within-snapshot normalisation; 8 equivalence tests pass including the strikes-drift-in/out edge case. Wired via `max_pain_cache.install_side_strengths` (cache build via Polars batch then per-snapshot dict materialisation). `_c7_center_of_mass` + `compute_strike_rotation_features` not attempted (history-deque based).
  - [x] **B.3d — `dealer_hedging` + `greeks.bs_greeks` cluster → columnar** (DONE 2026-05-27): `compute_dealer_hedging_features_vec` in `features/dealer_hedging_columnar.py` — numpy-vectorised Black-Scholes pass over all strikes (scipy.special.erf for norm_cdf with math.erf fallback). Drop-in replacement, same signature + output dict; per-call ~10× faster than scalar's Python BS loop. 8 equivalence tests pass. Wired via `max_pain_cache.install_dealer_hedging` (no cache — pure function replacement, per-emit spot makes caching uneconomic).
  - [x] **B.3e — `chain.py` cluster → columnar** (DONE 2026-05-27 — `oi_weighted_levels` + `wall_strength`): Polars `compute_oi_weighted_levels_batch` + `compute_wall_strength_batch` in `features/chain_columnar.py`. 7 synthetic equivalence tests. Wired into `max_pain_cache.install_chain_features` (shared chain-snapshot parse with B.3a). End-to-end on 500k events: **A+B+E = 1.96× speedup** (97.93s → 49.99s scalar→cached), byte-identical parquet. Marginal contribution +0.04× on top of A+B (was 1.92×). `compute_oi_change_deltas` not attempted (history-deque based).
  - [~] **B.4 — Adapter columnar entry point** (OBSOLETE 2026-05-27): The original plan was to add `ReplayAdapter.process_chunk(df)` alongside `process_event(event)`. B.3a–e instead wired via `feature_pipeline.*` monkey-patches inside `run_one_date` — same isolation guarantee (replay-only) without a parallel event loop. Pursuing B.4 now would be pure refactor with no wall-time win and real bug risk in a working hot path. **Superseded by the monkey-patch architecture; no separate B.4 work planned.**
  - [ ] **B.5 — Equivalence harness across multiple reference dates** (~½ day): expand `scripts/validate_b3a_end_to_end.py` to iterate a list of reference dates (pre-v8 + v8, small + large + recent). Per-date scalar-vs-cached parquet diff; aggregate PASS only when every date is byte-identical. Safety gate for future T50 sub-phases (B.3c+d Polars refactor, the hypothetical _c7_center_of_mass / strike_rotation / oi_change_deltas history-deque ports, etc.).

**Measured speedup (all 5 B.3 sub-phases live, 500k events of 2026-05-22):**
- B.3a alone:               **1.54×** (99.66s → 64.71s).
- B.3a + B.3b combined:     **1.92×** (98.80s → 51.40s).
- A+B+E (B.3e added):       **1.96×** (97.93s → 49.99s).
- A+B+C+D+E (all live):     **1.90×** (97.21s → 51.18s) — within ±0.06× run-to-run noise.
- The marginal wins from B.3c + B.3d are masked at the 500k-event slice because cache builds run on the FULL chain stream regardless of `--max-events`. At full-date scale projected **~2.1–2.2×** per-date wall-time speedup, byte-identical parquet across all measurements.
- For Partha's 5-date batch: today ~17 min → after all 5 sub-phases live ~8–9 min wall.

**Remaining T50 work:** B.4 (adapter columnar entry point — refactor only, no new speedup) + B.5 (cross-date golden-file harness — safety gate).

**Risk-mitigation rules (non-negotiable):**
- **Live trading never touched.** Every B-phase change is replay-only; shared `feature_pipeline.py` gets a new `update_columnar()` alongside `update()`. Live code keeps calling `update()`.
- **Golden-file test on every PR.** Replay 1 reference date pre-merge, byte-compare parquet output to baseline. Any diff = block merge.
- **One tracker per PR.** No "rewrite 3 trackers in one go" PRs.
- **Backout via env var.** Every tracker conversion keeps the scalar implementation reachable via `TFA_LEGACY_TRACKERS=1`. One env-var flip = full rollback.

- **Files expected to touch (across all sub-phases):** `python_modules/tick_feature_agent/replay/columnar_batcher.py` (new), `python_modules/tick_feature_agent/replay/replay_adapter.py`, `python_modules/tick_feature_agent/features/realized_vol.py`, `…/compression.py`, `…/chain.py` (OI-weighted levels), `…/exhaustion.py`, `…/ofi.py`, golden-file harness under `python_modules/tick_feature_agent/tests/test_columnar_equivalence.py` (new), `requirements.txt` (add `polars`).
- **Cross-ref:** T48 (decision gate), T47 (CPU fan-out — combined gives the headline 5-date wall-time win), T46 (Phase C plugs into the columnar API this task introduces), [systems/02_feature_engineering.md](systems/02_feature_engineering.md).

### T49 [JRNL] — Implement write-through Journal module 🆕
`Journal_Spec_v0.1` describes a write-through audit log (operator notes, SHAP-tagged top features at signal time, cohort tag, `discipline_violation` flag) keyed by `position_id`. Discipline Module 6 enforces "no new trades if last trade is unjournaled" but the journal-entry consumer the gate is supposed to read doesn't exist — today the gate effectively no-ops on the operator-notes layer. PA stores the structured trade-close audit on `position_states`; the operator-authored layer is missing.

- **Status:** Deferred 2026-05-25 (surfaced during System 07 doc rewrite). PRE-paper-trade SHOULD; gated on T33 cohort tags shipping.
- **Effort:** ~2–3 days. Land `server/journal/` module: collection schema, write-through hook in `PA.recordTradeClosed`, append-only enforcement on operator-authored fields once `WeeklyReview` locks the entry, tRPC `journal.list/edit/get` surfaces for the UI.
- **Cross-ref:** [systems/07_portfolio_reporting.md §9](systems/07_portfolio_reporting.md), [systems/06_risk_discipline.md §3 Module 6](systems/06_risk_discipline.md).

### T52 [UI] — Notifications backend (Telegram routing for trade events + AlertHistory retention) ✅ IMPLEMENTED
Extend the existing server-side Telegram path (today wired only for token-expiry + session-close) to cover every operator-facing trading event. Email layer dropped from scope — Telegram + in-app cover every need on a single phone.

**5 open decisions LOCKED 2026-05-31:**

1. **Default route table** — Telegram for time-sensitive events; in-app toast for everything; Telegram for summaries (no email channel). Routes:
   - Trade fill (entry) → Telegram + in-app
   - Trade exit (TP / SL / manual) → Telegram + in-app
   - Pre-trade gate rejection → Telegram + in-app
   - DISCIPLINE_EXIT (circuit-breaker auto-close) → Telegram + in-app
   - Daily NSE session-close summary (~15:30 IST) → Telegram (NIFTY + BANKNIFTY total trades, wins/losses, net ₹/%, best/worst trade, current capital)
   - Daily MCX session-close summary (~23:30 IST) → Telegram (CRUDEOIL + NATURALGAS, same format)
   - Token expiry warnings → Telegram (already shipped — keep)
   - Broker disconnect / WS error → Telegram + in-app
   - Test / debug events → in-app only
2. **Email provider** — DROPPED. No email layer.
3. **AlertHistory retention** — 30 days (Telegram itself keeps the chat history; this is the in-app AlertHistory drawer only).
4. **Quiet hours** — none. Push 24/7 (MCX runs till 23:30 IST anyway; Telegram per-chat mute is the operator's escape hatch).
5. **De-duplication** — 30-second window. Identical event signature + content within 30 s collapses to one push (catches bug-storms without hiding legitimately rapid distinct events — different trade IDs produce different signatures).

- **Status:** ✅ IMPLEMENTED 2026-05-31 — same day as decisions locked. All 5 subslices shipped (fill/exit wording later refined to plain English 2026-06-01 — fill = "bought {qty} {instrument} at Rs.{price}"; exit by reason: TP "target achieved", SL "loss hit", DISCIPLINE_EXIT "closed by risk rule", else sell "gained/lost"; shared "{pct} {rs} from {instrument}" tail, magnitude only; same string drives Telegram + in-app drawer; gate-reject and broker-disconnect also restyled to plain English — gate-reject = "blocked {qty} {instrument} — {reason}", broker-disconnect = "{broker} token expired / feed gave up / feed error — {reason}" + restart hint; tests rewritten, 13 pass):
  - Session-close P&L summaries (NSE 15:30 IST + MCX 23:30 IST) → commit `5f1c480`.
  - Server-side AlertHistory persistence (Mongo model + tRPC router + 30-day nightly purge @ 03:00 IST) → commit `b2aa864`.
  - Client AlertContext hydration + push-on-dispatch + markAllRead sync → commit `c29c290`.
  - Trade-event Telegram routing (fill / exit / auto-exit / DISCIPLINE_EXIT / gate rejection) via new `server/_core/tradeEventNotifier.ts` with try/catch wrappers and fire-and-forget call pattern → commit `769ef71`.
- **Deferred** (not blocking): 30 s same-event dedup window (each tradeId is unique so signatures differ naturally; dedup only matters for bug-storms that haven't happened). Add when the first bug-storm justifies it.
- **Effort spent:** ~1 day end-to-end (was estimated ~3d after email dropped — landed faster because the existing schedulers + notifyPartha utility were reusable).
- **Cross-ref:** [systems/08_ui_desktop.md §8](systems/08_ui_desktop.md), [systems/09_control_bot.md](systems/09_control_bot.md).

### T50 [H2H] — Implement HeadToHead pairing + dashboard 🆕
`HeadToHead_Spec_v0.1` describes pairing ai-paper vs ai-live (and ai-live vs my-live once AI Live ramps) on a stable SEA `signal_id` — daily metric cards (P&L, win-rate, Sharpe, max drawdown, divergence). Feeds the 5 pp divergence gate from V2_MASTER_SPEC §8.2/§8.3 for AI-Live capital scale-up. Today no H2H code exists, AND SEA's signal schema doesn't define a `signal_id` field — that's a prerequisite design fix.

- **Status:** Deferred 2026-05-25 (surfaced during System 07 doc rewrite). Gated on (a) paper-trade fills accumulating ≥ 14 days per AI-Live canary gate 1, (b) SEA emitting a stable `signal_id`, (c) T49 Journal shipping (H2H reads journal entries for SHAP / cohort context).
- **Effort:** ~3–4 days. Land `server/reporting/headToHead/` module: pairing logic, daily aggregation, divergence detector, tRPC surface for the dashboard card.
- **Cross-ref:** [systems/07_portfolio_reporting.md §10](systems/07_portfolio_reporting.md), [systems/04_signal_engine.md](systems/04_signal_engine.md) (signal_id schema gap).

### T53 [UI/DISCIPLINE] — Discipline controls for sim/testing channels 🆕
Surfaced 2026-06-01 while testing order flow. Two related gaps: (a) discipline behavioural gates (timeWindow, weeklyReview, journal, cooldown, …) block paper test trades one-by-one — only `timeWindow` is currently bypassed for sim channels (my-paper, ai-paper) via `isSimulationChannel`; (b) the Monday `weeklyReview` gate can only be cleared through the `discipline.completeReview` tRPC mutation — there is **no UI button** to complete it, so it hard-blocks trading with no in-app way out.

- **Status:** ⏳ Open (2026-06-01). Stopgap: `weeklyReviewCompleted` flipped directly in Mongo for the 2 sim channels, **2026-06-01 only** (the flag is per-day and the gate is Monday-only, so it returns next Monday).
- **Scope:**
  1. **Settings toggle(s)** to enable/disable discipline checks per sim channel (paper) — design pending: master per-channel switch (recommended) vs per-rule granularity. Needs a discipline-settings schema field + `validateTrade` read + a Settings UI control.
  2. **"Complete weekly review" button** in the UI (discipline panel) wired to `discipline.completeReview` — the proper fix for the missing UI.
- **Effort:** ~1 day (schema field + validateTrade gate + 2 Settings controls + 1 button).
- **Cross-ref:** [systems/06_risk_discipline.md](systems/06_risk_discipline.md); `server/discipline/index.ts` (`validateTrade`, `isSimulationChannel`), `server/discipline/disciplineRouter.ts` (`completeReview`).

### T54 [DATA] — Automate `config/event_calendar.json` updates 🆕
Surfaced 2026-06-14 while wiring the AppBar market-events tag. The macro-event calendar (FOMC, RBI, India CPI/GDP, US NFP/CPI/PCE, monthly expiry, budget) is **hand-maintained** — nothing in the repo writes `config/event_calendar.json`; the TFA (`tick_feature_agent/features/event_calendar.py`) and the new UI tag only read it. It currently ends at 2026-06-25, so it goes empty without manual top-ups.

- **Status:** ⏳ Open (2026-06-14). Today: edit the JSON by hand from official sources.
- **Goal:** a scheduled job that fetches/refreshes upcoming tier-1/2 events into `event_calendar.json` (IST `ts_ist`, existing schema), append-only + dedup, so both the TFA features and the UI tag stay current automatically.
- **Sources (per the file's own `_note`):** RBI policy calendar; FOMC schedule (federalreserve.gov); MoSPI (India CPI/GDP); US BLS (NFP/CPI/PCE); NSE/MCX monthly expiries. Times = release moment in IST (+05:30).
- **Open design qs:** scrape vs an economic-calendar API (offline-first prefers a small curated fetcher); cadence (weekly?); where it runs (launcher scheduled task, like the yow-partha auto-start); how to validate rows before writing so a bad fetch can't corrupt the file the TFA reads on session start.
- **Effort:** ~1–2 days. Keep writes atomic + schema-validated; never let an automated write break the TFA's morning read.
- **Cross-ref:** `config/event_calendar.json`, `python_modules/tick_feature_agent/features/event_calendar.py`, [systems/02_feature_engineering.md](systems/02_feature_engineering.md); AppBar market-events tag (this session).

### T55 [BSA] — Dhan WS feed self-heal (staleness watchdog + slow-retry) 🆕
Surfaced 2026-06-15 debugging "MCX live price not in instrument bar." Diagnosed via a temporary tick log: MCX ticks WERE arriving server-side (ticker mode, valid LTP) — the feed had silently gone stale during the day and a **server restart** fixed it. Root gaps in `server/broker/adapters/dhan/websocket.ts`:
1. **No tick-staleness watchdog.** Socket *drops* self-heal (`resubscribeAll` on reconnect), but if Dhan keeps the socket OPEN while silently stopping an instrument's feed (per-segment lapse — MCX's pattern), nothing detects it → no reconnect → feed dead until restart.
2. **Reconnect gives up permanently** after `maxReconnectAttempts` (line ~615) — once exhausted only a restart recovers.

- **Status:** ⏳ Open (2026-06-15). Workaround: restart the server when a feed goes silent.
- **Fix:** (a) staleness watchdog — while market open + subscriptions exist, if no tick for ~60–90s force a reconnect (which resubscribes); generous threshold + market-hours gate so quiet markets don't false-fire. (b) after the fast-retry burst, keep a slow retry (~60s) instead of giving up.
- **Risk:** touches the live Dhan WS adapter — test carefully (mock + logs); must not false-trigger.
- **Cross-ref:** `server/broker/adapters/dhan/websocket.ts` (`scheduleReconnect`, `resubscribeAll`, `handleBinaryMessage`); related `1006` expiry warning already present.

### T56 [UI] — Merge ENTER into the LONG/SHORT toggle (instrument bars) 🆕
Proposed 2026-06-16 (Partha to confirm). Idea: drop the separate Ctrl-ENTER button on the floating instrument bars; instead move the LONG/SHORT toggle to the right and make it double as the entry trigger — plain click picks direction (and arms the entry-marker); **Ctrl+hover** flips that button's label to "ENTER" (green LONG / red SHORT); **Ctrl+click** enters at the live premium in *that* button's direction. Implementation note: the place call must use the clicked button's direction, not the previously-selected one (pass direction through `onEnter`).

- **Status:** ✅ Done 2026-06-17. Separate ENTER button removed; LONG/SHORT toggle moved right and now doubles as the entry trigger (Ctrl+hover → "ENTER", Ctrl+click enters in that button's direction). Direction is threaded through `onEnter(direction)` → `placeFromMarker(price, dirOverride)`. Typecheck clean.
- **Cross-ref:** `client/src/components/InstrumentBar.tsx`, `InstrumentBarItem.tsx`, `useInstrumentBar.ts`.

### T57 [UI/Perf] — Trading-desk render-storm fixes (root cause of slow Save / place clicks)
Done 2026-06-18. Symptom: clicking Save (order settings) / placing a trade felt slow and no request hit the server immediately — the click sat queued behind constant re-renders (the whole app repainting on every tick + every 2-3s poll). Fixed the wasteful re-renders so clicks dispatch promptly.

- **Changes:**
  1. `useTickStream.ts` — split `useTickFeed()` (connection + polling fallback, no tick subscription) from `useTickStream()`; `MainScreen` + `useTradingDeskData` now use `useTickFeed` (read on demand via `getTickFromStore`) so the shell/desk no longer re-render on every tick. Removed the now-dead global listener machinery + reactive `useTickStream` hook (per-key `useInstrumentTick` is the only reactive path).
  2. `CapitalContext.tsx` — `placeTrade.onSuccess` now `void invalidateAll()` (non-blocking) so `placeTradePending` clears on broker return, not after the 4-query refetch. Provider value memoized. **Split `ChannelContext` + `useChannel()`** (channel-only, no P&L churn).
  3. `TodayTradeRow.tsx` — removed dead `day` prop; custom `React.memo` comparator (trade by value, ignores handler identity) → closed rows stop re-rendering on polls/ticks.
  4. `AppBar.tsx` — `memo`'d + stable callbacks from `MainScreen`; day badge extracted to its own component; `ChannelModeToggle`/`ChannelTabs` use `useChannel`; mock-feed poll relaxed `refetchInterval:5000` → `refetchOnWindowFocus`.
  5. **Option-feed subscribe/unsubscribe storm fixed.** Each instrument bar's two `useOptionPreview` (CE+PE) used to dynamically (un)subscribe their ATM contract, which flapped (contract resolves/de-resolves as `spot` flickers) and amplified via a `feed.state` invalidation on every change. Now: `useOptionPreview` is read-only; `useInstrumentBar` subscribes a **stable ATM ± 1 window** (≈6 contracts) once via new `useFeedSubscriptions` (diff-based, ignores transient-empty so it never flaps, releases on unmount); dropped the `feed.state` invalidation amplifier in `useFeedControl`. Server WS log went quiet (only an initial batch + occasional single add/drop on strike roll).
  6. **Live-feed health banner** — new `useFeedHealth` + `FeedStatusBanner` (under AppBar): shows amber "feed stalled — no ticks for Ns" / red "disconnected" when market is open but no tick in 15s; auto-clears on resume; gated to trading hours. Surfaces silent feed stalls (pairs with T55). Added `getLastTickAt()`/`isFeedConnected()` to `useTickStream`, `anyOpen` to `useMarketOpen`.
- **Verified:** Save click dispatches promptly; AppBar (x23) + closed rows (x34) cool in React Profiler; subscribe/unsubscribe storm gone. Remaining orange (TodayPnlBar, live StrikeBars, open rows) is legitimate live data.
- **Open follow-up (optional):** extend the stable context to the *action* functions (stabilise callbacks to depend on `mutation.mutate`) so `Settings` Order-Execution section + `SignalsFeed` stop re-rendering every poll too.
- **Cross-ref:** `client/src/hooks/useTickStream.ts`, `useTradingDeskData.ts`, `contexts/CapitalContext.tsx`, `components/{MainScreen,AppBar,ChannelTabs,TodayTradeRow,TodaySection}.tsx`.

### T58 [UI/Perf] — Replace polling with WebSocket push / client-side derivation 🆕
Planned for the weekend of **2026-06-20/21** (Partha). Today the dashboard stays fresh by polling ~a dozen `useQuery` hooks on timers (allDays 2s, state 3s, signals/modules/instruments/moduleStatuses 3s, brokerStatus 5s, discipline 10s, + per-instrument-bar live-state 2s ×4 and option-chain 5s ×4), so the Network tab shows 15-20 tRPC requests every few seconds. The WS infra already exists (`/ws/ticks` pushes ticks + `chainUpdate`/`chainSnapshot`).

- **Slice 1 (do first — easy, low risk):** push the *event-driven* data over WS instead of polling — `trading.signals`, `trading.moduleStatuses`, `instruments.list`, `discipline.getDashboard`, `broker.status`. These change on discrete events, not every 3s; server emits on change, client updates the query cache via `setQueryData`. Keep a snapshot-on-reconnect resync (already the pattern for ticks).
- **Slice 2 (trickier):** kill the live-P&L polling (`portfolio.state` / `allDays` today row / `instrumentLiveState`) by **deriving values client-side from the tick stream the browser already receives** (open-trade MTM = qty × (ltp − entry)), instead of asking the server every 2-3s. Server stays the source of truth on trade open/close (invalidate then).
- **Quick interim win (can do anytime):** drop `refetchIntervalInBackground: true` on the cosmetic polls so background tabs stop polling — but KEEP the `useTradingDeskData` 2s LTP→server sync (paper-trade bookkeeping depends on it).
- **Cost/risk:** server must emit on every state change (miss one → stale UI; polling is self-healing); needs reconnect→resync. Do in slices, verify each.
- **Cross-ref:** `server/broker/tickWs.ts` (WS push), `client/src/hooks/useTickStream.ts` (WS client + cache ingest), `client/src/components/MainScreen.tsx` (the polling hub), `contexts/CapitalContext.tsx`.

### T59 [Execution] — Trailing take-profit (TSL-gated) + exit-sync diagnostics
Done 2026-06-18 (server-side, paper/sandbox only). Two pieces:

- **Trailing TP:** when the trailing stop is ON, the target now trails **1.5% above the LTP's high-water mark**, ratcheting in the favorable direction only (never retreats on a pullback). Lets a winner run — the TSL books the exit on reversal; the TP only fires on a single-tick gap past it. With TSL off, TP is unchanged (fixed exit). `tickHandler.ts`: `TP_TRAIL_PERCENT = 1.5`, a TSL-gated ratchet block before the TP-hit check, **and a persist-merge fix** (the merge previously copied `ltp/peakLtp/stopLossPrice` but NOT `targetPrice`, so a trailed TP would never reach Mongo/client — now copied). Verified: typecheck + all 10 `tickHandler.tsl.test.ts` pass.
- **Exit-sync diagnostics (`[XSYNC]`, TEMP — remove after confirming):** server `tickHandler` logs `TSL-ACTIVATED / TSL-TRAIL / TP-TRAIL / TP-HIT / SL-HIT(tsl=…)`; TEA `recordAutoExit` logs `CLOSED <reason> exit pnl`; client `TodayTradeRow` logs `predict SL/TP-HIT`, `STOP-MOVED`, `CLOSED`. Line up by trade id + timestamp to confirm client⇄server agree on TSL activation, trailing, and exits. **Only paper/sandbox** trigger these (live uses the broker bracket). Needs ticks → mock feed on while the live Dhan token is expired.
- **Known display nuance (not a bug):** the bar shows the TSL→LTP gap as % of *entry*, while the trail is % of *peak* — a high premium reads as >1% of entry. And the server-computed stop reaches the bar on the 2s poll while LTP is live, so during fast moves the gap visibly lags until the poll lands (the bar intentionally shows the server's real stop, not a client sim). T58's client-side derivation would remove that lag.
- **Cross-ref:** `server/portfolio/tickHandler.ts`, `server/executor/tradeExecutor.ts`, `client/src/components/TodayTradeRow.tsx`.

### T60 [Execution] — Live Dhan SL/TSL/TP protection (Hybrid: Super Order + server leg-modifies) 🆕
In progress 2026-06-19. Plan: `~/.claude/plans/how-the-integration-is-synthetic-blum.md`. Root problem: live trades were **unprotected** — plain `/orders` entry with no SL/TP, and `tickHandler` skipped live exits. Hybrid fix = broker-enforced Super Order (survives app/feed outage) + a few server-driven leg-modifies for the gated-TSL + trailing-TP behavior. **Gated OFF by default** (`useSuperOrderForLive`); Super Orders are **live-only (404 on sandbox)** so untestable until a fresh token + 1-lot live run.

- **Done + typecheck + tests green** (paper untouched; 23/23 tickHandler-TSL + applyBrokerOrderEvent incl. 3 new leg-fill cases):
  - **Phase 0:** TradeRecord fields (`superOrderId`, `slLegOrderId`, `tpLegOrderId`, `legModifyCount`, `tslArmedOnBroker`, `lastBrokerTp*`); super-order types; order-update WS now forwards `legNo`/`entryOrderId`.
  - **Phase 1:** Dhan adapter `placeSuperOrder`/`modifySuperOrderLeg`/`cancelSuperOrder`; live entry routes to Super Order when `useSuperOrderForLive` + SL&TP present; leg-fill reconciliation in `applyBrokerOrderEvent` (match by `superOrderId == entryOrderId`) → close via the paper auto-exit seam; `exitTrade` cancels legs then flattens.
  - **Phase 2:** tickHandler live block runs gated-TSL detection → emits `brokerTslArm` → TEA `armBrokerTsl` modifies STOP_LOSS_LEG to breakeven + native `trailingJump` (arm-once, cap-guarded).
  - **Phase 3:** TP ratchet → throttled `brokerTpRatchet` (30s emit throttle) → TEA `ratchetBrokerTp` modifies TARGET_LEG with step% + time throttle + `25 - margin` modify budget.
- **DEFERRED:** recovery-engine super-order leg reconciliation via `SUPER_ORDER_BOOK` (backstop for a WS event missed while down). Needs the real Dhan super-order-book response shape → build during live validation.
- **Live validation runbook (live-only — Super Orders 404 on sandbox; 1 lot, cheapest viable option, market open, one test at a time):**
  - **Pre-flight:** (1) **Token** — Dhan mints it on server startup via stored TOTP (refresh-on-startup-only policy; no manual/runtime refresh). If the **feed banner is green**, the token is valid → proceed; if red/stale, **restart the server** to re-mint. (2) `LOG_LEVEL=debug` to see `[ORDER→/←Dhan]`. (3) Enable `useSuperOrderForLive` in Settings. (4) Kill switch within reach; start on `testing-live`.
  - **T1 Placement:** place → `[ORDER→Dhan] SUPER place` → `[ORDER←Dhan] SUPER placed`; confirm **3 legs** in the Dhan app; our trade has `superOrderId`, flips OPEN on entry fill.
  - **T2 Broker SL fill (critical):** tight SL → stop leg fills at Dhan → WS → `[XSYNC-SVR] CLOSED SL_HIT` → our record closes. (Tight TP → `TP_HIT` likewise.)
  - **T3 Gated TSL arm:** hold past the gate → `TSL-ACTIVATED(live)` → `BROKER-TSL-ARMED` → `SUPER modify STOP_LOSS_LEG` (stop→breakeven + `trailingJump`); then Dhan trails natively with **no further modify calls**; a reversal → `CLOSED SL_HIT (tsl=true)`.
  - **T4 TP ratchet:** sustained favorable move → `BROKER-TP-RATCHET` + `SUPER modify TARGET_LEG`, ≥30s apart, `legModifyCount` under ~22.
  - **T5 Manual exit:** exit → `SUPER cancel` legs → flatten → record closes; verify **no orphan legs / flat position** in Dhan.
  - **Abort:** kill switch (halt new) · toggle `useSuperOrderForLive` OFF (instant revert to plain) · manual square-off in Dhan if `BROKER_DESYNC`.
  - **Known gaps:** `cancelSuperOrder` square-off-vs-cancel semantics unverified (we flatten anyway); `trailingJump` is a fixed-rupee step (not %-of-peak); recovery backstop deferred → don't restart the server mid-trade (a leg fill while down won't auto-reconcile yet).
- **Cross-ref:** `server/broker/adapters/dhan/{index,types,constants}.ts`, `server/broker/{types,brokerConfig,brokerRouter}.ts`, `server/executor/tradeExecutor.ts`, `server/portfolio/{tickHandler,portfolioAgent,state,types}.ts`.

### T61 [Execution] — Wire SEA signals → ai-paper auto-trade (+ cohort tagging) 🆕
Done 2026-06-23 (paper only; **off by default**). The model emits wave-2 signals but `submit_new_trade()` was never called — signals never became trades. Now the SEA POSTs each emitted signal (both **scalp** and the new **trend** gate) to `/api/discipline/validateTrade` → DA → RCA → TEA.

- **Python** (`signal_engine_agent/engine.py`): `_maybe_submit_ai_trade()` at both emit points; gated by env `SEA_AUTO_TRADE=<channel>` (unset = off), lots via `SEA_AUTO_TRADE_LOTS` (default 1); try/except so it never crashes the inference loop.
- **Server thin-AI path** (`discipline/routes.ts`): when `quantity` omitted, the server **sizes** (`lots × scrip-master lot size`), **sources** capital/exposure from the channel portfolio, and enforces **one open position per instrument** (rejects re-emits while one is open). `validateTradeSchema` gains optional `lots` + `cohort`; `quantity`/`estimatedValue`/`currentCapital`/`currentExposure` now optional.
- **Cohort end-to-end:** `signal → validateTrade → RCA → TEA → buildTradeRecord → TradeRecord.cohort`, persisted in day-record + position_state, exposed on the client type, and shown as a badge on the instrument card. Lets P&L group by scalp/trend/swing.
- **Enable:** set `SEA_AUTO_TRADE=ai-paper` (+ optional `SEA_AUTO_TRADE_LOTS`) on the SEA processes; Node reachable at `BROKER_URL` with matching `INTERNAL_API_SECRET`. ai-paper = mock adapter (instant-fill, no real money).
- **Verified:** tsc clean · py_compile clean · 58 server tests green. **Not yet run live in-market.**
- **Cross-ref:** `python_modules/signal_engine_agent/{engine,risk_control_client}.py`, `server/discipline/routes.ts`, `server/risk-control/index.ts`, `server/executor/{types,tradeExecutor}.ts`, `server/portfolio/{state,storage,portfolioAgent}.ts`, `client/src/{lib/tradeTypes.ts,components/InstrumentCard.tsx}`.

### T62 [UI] — Per-instrument colour system (user-editable, single source) ✅ DONE 2026-06-24
Each instrument now has ONE base colour that drives every instrument-specific surface (pill, instrument cards, signal cards, expiry-control cards), and the user can change it from Settings → Instruments. Replaces three separate, inconsistent hard-coded colour maps (`tradeThemes.INSTRUMENT_COLORS` blue/purple/amber/emerald, `Settings.instrumentColors` cyan/green/…, `InstrumentCard.INST_ACCENT` + `SignalsFeed.INST_*` cyan/green/amber/red). New user-added instruments used to fall back to grey — now auto-assigned the next palette colour.

- **Storage:** `InstrumentConfig.color` (hex) added to the Mongo model + the 4 default instruments seeded to their legacy pill colours (NIFTY `#3B82F6`, BANKNIFTY `#A855F7`, CRUDE `#F59E0B`, GAS `#10B981`), so day-one looks identical. Idempotent backfill in `seedDefaultInstruments` colours any pre-existing doc. `addInstrument` auto-assigns via `pickNextColor` (12-swatch palette); `setInstrumentColor` + `instruments.setColor` tRPC mutation for edits.
- **Colours stored as hex + applied as inline styles, NOT Tailwind classes** — Tailwind purges classes absent at build time, so a runtime-picked colour as a class would silently not render. `tradeThemes.ts` gains the palette, `normalizeInstrumentKey` (collapses every label form — `NIFTY 50`/`NIFTY_50`/`nifty50`/`NIFTY` → one key), `withAlpha`, `instrumentStyleFromHex` (derives pill/cardBg/border/text from one hex via alpha), `resolveInstrumentHex`. New `useInstrumentColors()` hook binds the live `instruments.list` (tRPC-cached) to a `styleOf`/`hexOf` resolver.
- **Picker:** `InstrumentColorPicker.tsx` — 12 preset swatches + a custom-hex / native colour input (option C). Saving invalidates the instruments query → whole app re-colours at once.
- **Verified:** `tsc --noEmit` clean; 28 server instrument tests (incl. 8 new colour/backfill/pickNextColor) + 8 new client `tradeThemes.test.ts` all green.
- **Cross-ref:** `server/{instruments,routers,tradingRoutes}.ts`, `client/src/lib/{tradeThemes,useInstrumentColors}.ts`, `client/src/components/{InstrumentTag,InstrumentCard,SignalsFeed,InstrumentColorPicker}.tsx`, `client/src/pages/Settings.tsx`.

## Closed items (kept for one cycle as audit trail; delete on next pass)

_None yet._

---

## How to use this file

- **Adding a new TODO:** Append at the appropriate priority slot. Keep entries tight — what / status / blocker / link.
- **Marking done:** Move to "Closed items" section with a one-line outcome note. Next memory cleanup pass deletes the closed section.
- **Cross-references:** Use `docs/<FILE>.md` for design docs (they live in the repo, survive cleanly), not wikilinks to memory files (which can be deleted out from under).
