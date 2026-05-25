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
    - **Phase 2e proposal (2026-05-21, from T7 brainstorm — ON HOLD with T7):** add ~28-30 macro-bias L1 columns (FII/DII, US-session closes WTI/$INR/S&P, Gift Nifty, event calendar FOMC/RBI/EIA/OPEC/CPI/NFP) shared between v2 intraday and T7 swing models. Would bump schema **v8→v9** and reset this accumulation counter. **Hold trigger:** re-engage only after paper/live trading shows significant edge improvement. See T7 "Brainstorm progress (2026-05-21)" sub-block for full details.
  - [x] Phase 5: Retrain pipeline COMPLETE 2026-05-23 — 84 heads + walk-forward CV + isotonic calibration + sim_pnl harness + Saturday scheduler + LATEST_HEADS + D66 schema reconciler all shipped (formerly T23–T27, now closed). T28 (Optuna hyperparam tuning) remains as PRE-Day-30 SHOULD; T41 (Saturday promotion-gate script) is PRE-paper-trade MUST.
  - [ ] Phase 6: Trend gate + swing gate + 3-way combinator + smoke — **expanded into T29–T35** (audit 2026-05-22). Earlier estimate "~3-4 days code" was too low; real scope is ~13-17 days per audit.
  - [ ] Phase 7: Paper trade ramp (ai-paper channel, weeks)
- **Empirical evidence the current model is scalp-only:** 9/9 nifty50 signals on 2026-04-30 / 2026-05-11 were 5-7 pt captures at day-extreme reversals; 85-pt sustained 10:50-11:20 uptrend on 2026-05-11 produced ZERO signals.

## P1.5 — Pre-paper-trade critical path

T28 = PRE-Day-30 SHOULD (hyperparameter tuning before first real retrain). T29–T35 + T41 = PRE-PAPER MUST (must ship before Phase 7 paper-trade ramp). T23–T27 closed 2026-05-23 (training-pipeline build-out, see git log for detail).

### T28 — Hyperparameter tuning infrastructure (Optuna) 🆕
Add Optuna sweep job that runs on holdout fold, picks best LightGBM params per head, feeds into Saturday retrain. Currently `LGBM_PARAMS_BINARY`/`_REGRESSION` are hardcoded in `trainer.py:46-67` and no `config/mta_hyperparams.json` exists (T3 Plan §5.2 line 174). Typically 1-3% AUC improvement per head.

- **Status:** ⏳ PRE-Day-30 SHOULD (recommended, not strict).
- **Effort:** ~2-3 days for per-head Optuna; ~1 day if just pinning from config.
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

### T32 — L8 regime classifier (rule-based per D4) 🆕
Implement V2_MASTER_SPEC §2.8 rule-based classifier: `trend_strong` tier + 5-min sustain + benign degradation handling. Today `regime` is passed into `decide_action_v2:264` as a parameter but nothing actually writes it — the inference loop relies on the legacy 4-stage filter's `regime` output, which spec D55 deprecated.

- **Status:** ⏳ PRE-PAPER MUST.
- **Effort:** ~2 days.
- **Cross-ref:** T3 Phase 6; spec D4 / D47; later upgrade T17.

### T33 — D56 cohort tracking end-to-end 🆕
Tag every signal + fill with originating signal type (scalp/trend/swing/multi-day-swing) through the full pipeline: SEA signal log → broker fill log → reliability monitoring. Currently `cohort|signal_source|signal_layer|attribution` returns zero matches across both Python `signal_engine_agent/` and TypeScript `server/`. Without this, post-paper-trade attribution analysis (which heads/cohorts are profitable) is impossible.

- **Status:** ⏳ PRE-PAPER MUST.
- **Effort:** ~1 day.
- **Cross-ref:** T3 Phase 6; spec D56; precondition for T17/T18/T19/T20 analyses.

### T34 — Per-head SHAP report + reliability monitoring (§5.1) 🆕
Two coupled observability outputs needed before paper-trade promotion:
- **SHAP-by-instrument report:** `scripts/shap_report_weekly.py` (T3 Plan §5.8 line 113) does not exist. Needed for T14 / T21 evidence-based feature decisions.
- **§5.1 weekly reliability monitoring:** bucket signals by predicted prob, compare to actual win-rate (±5% across deciles = pass). `scripts/trade_quality_report_weekly.py` (T3 Plan line 114) does not exist. Required to validate D72 calibration on live data.

- **Status:** ⏳ PRE-PAPER MUST.
- **Effort:** ~1-2 days; blocked on T25 (calibration) + T33 (cohort tagging) being live.
- **Cross-ref:** T3 Phase 6.

### T35 — Partial-session handling + inference latency benchmark 🆕
Two edge-case items not on prior roadmap:
- **Partial-session / half-day:** `market_calendar.is_market_holiday()` only does an in-set check (`market_calendar.py:55-58`). Muhurat / half-days will be treated as full sessions, mis-labelling targets near abnormal close. Extend `market_holidays.json` schema + add `session_end_sec` lookup.
- **Inference latency benchmark:** 84 heads × 4 instruments has never been benchmarked. `scripts/benchmark_signal_persistence.py` exists but measures DB writes only. Add one-shot harness to verify live inference fits within tick cadence.

- **Status:** ⏳ PRE-PAPER MUST.
- **Effort:** ~1 day total.
- **Cross-ref:** T3 Phase 6.

### T41 — Production prediction → outcome join (feedback-loop foundation) 🆕
Persist every live head prediction (84 heads × every signal eval) to disk, then backfill the actual market outcome N seconds later from the live tick stream. Produces `predictions_<date>.parquet` per instrument joining what the model *said* with what actually *happened* — for all 84 heads, not just heads that fired.

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

## P2 — parked features (small enough to wait)

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

### T14 — Add 8 deferred L1 features post-paper-trade (+ Gemini convexity follow-up)
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

### T37 — Order-book depth features (levels 1-4)

*(Renumbered from T25 → T37 on 2026-05-23 to resolve collision with the audit-added T25 "D72 isotonic calibration" in P1.5. Original entry added 2026-05-21.)*
Currently every Dhan FULL option tick carries 5 depth levels (parsed in `binary_parser.parse_depth_levels`). Level 0 (top bid/ask price + size) already feeds features; levels 1-4 are parsed and discarded. Add ~10-15 new L1 columns built from the full 5-level book.

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

### T42 [MTA] — Saturday promotion-gate script 🆕
After the Saturday retrain produces `training_manifest.json` with `sim_pnl_*` summary keys, an external script must decide whether to update `models/<inst>/LATEST` to the new run or hold for manual review. Today the cron retrains and writes artifacts; the promotion decision is implicit-manual. Per V2_MASTER_SPEC §2.3.4 the rule is: promote iff `sim_pnl_total ≥ wave2_baseline_sim_pnl × 1.20` AND per-trade expectancy ≥ +8 pts.

- **Status:** Deferred 2026-05-24 (surfaced during System 03 doc rewrite). PRE-paper-trade MUST.
- **Effort:** ~1 day. New `scripts/saturday_promote.py` reads manifest, compares baseline, updates LATEST pointer or fires Telegram alert.
- **Cross-ref:** [systems/03_model_training.md §14](systems/03_model_training.md). Sister task to T28 (Optuna); both gate the Saturday workflow.

### T43 [SEA] — Remove deprecated legacy_filter.py + trade_filter.py 🆕
Pre-E5 4-stage filter (`legacy_filter.py` 129 LOC + `trade_filter.py` 328 LOC = 457 LOC dead code) retained behind `--filter=legacy` CLI flag for one A/B validation cycle. Phase E5 base gate has been locked + validated since 2026-04-30. Time to delete.

- **Status:** Deferred 2026-05-24 (surfaced during System 04 doc rewrite). Cleanup, not blocking.
- **Effort:** ~½ day. Remove the two files, the `--filter=legacy` flag, and any unreachable branches in `engine.py`. Verify 124-test suite still green.
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

**Sub-phases (sequential — each its own PR, each golden-file gated):**
  - [ ] **B.1 — Profile + scope** (~1–2 days): cProfile a full date, rank top 10 hot functions, lock the MUST-vectorise vs CAN-stay-scalar set in a short scope doc.
  - [ ] **B.2 — ColumnarBatcher** (~2–3 days): new `python_modules/tick_feature_agent/replay/columnar_batcher.py` that buffers `merge_streams` events into 5–10k-row Polars chunks. Adapter still scalar; this is purely a refactor that changes the source shape. Golden-file must pass byte-for-byte.
  - [ ] **B.3a — realized_vol → columnar** (~3 days): promote T48 spike to production-ready. Polars `group_by_dynamic` for the 4 rolling-std windows. Golden-file gate.
  - [ ] **B.3b — compression → columnar** (~3 days): independent PR, golden-file gated.
  - [ ] **B.3c — OI-weighted levels → columnar** (~3 days): "".
  - [ ] **B.3d — exhaustion → columnar** (~3 days): "".
  - [ ] **B.3e — OFI → columnar** (~3 days): "".
  - [ ] **B.4 — Adapter columnar entry point** (~2–3 days): `ReplayAdapter.process_chunk(df)` alongside existing `process_event(event)`. Live mode never calls `process_chunk` — paper/live trading code path untouched.
  - [ ] **B.5 — Equivalence harness + flip default** (~1–2 days): replay 5 reference dates (small / medium / large / quiet / chaotic) both ways, byte-compare parquets. Only ship when zero diffs. Then remove `--columnar` opt-in flag and make it the default.

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

### T51 [UI] — TradingDesk redesign decision + ship-or-drop 🆕
`TradingDesk_Spec_v1.3` calls for shrinking the summary bar from 10 → 6 items, the table from 15 → 10 columns, and adding row-expand on `PastRow` (click reveals per-trade detail). The redesign was approved in the spec but **never merged** — the current UI still ships the full-fat layout. Decide: ship as one PR, or formally drop the redesign and update the spec to match reality.

- **Status:** Deferred 2026-05-25 (surfaced during System 08 doc rewrite). Polish, not blocking — paper-trade ramp doesn't depend on this.
- **Effort:** ~2 days if shipping (small visual refactor + per-row expand state); 30 min if dropping (delete the redesign rows from the spec, update overview).
- **Cross-ref:** [systems/08_ui_desktop.md §4](systems/08_ui_desktop.md).

### T52 [UI] — Notifications backend (Telegram routing + email + preferences UI) 🆕
`Notifications_Spec_v0.1` describes three notification layers. **Only toast + AlertHistory are live.** Server-side Telegram path exists for token-expiry and session-close events but isn't wired for trade alerts, gate rejections, or DISCIPLINE_EXIT events. Email + preferences UI not built. Spec has 5 open decisions (provider, retention, quiet hours, de-duplication, default route table).

- **Status:** Deferred 2026-05-25 (surfaced during System 08 doc rewrite). PRE-paper-trade SHOULD; PRE-AI-Live MUST (operator needs Telegram on phone for DISCIPLINE_EXIT events when desktop UI isn't open).
- **Effort:** ~4–6 days. Email provider choice + setup (~1d), Telegram routing for trade events via yow-partha (~2d), preferences tRPC + Settings UI section (~2d), end-to-end test on a paper channel.
- **Cross-ref:** [systems/08_ui_desktop.md §8](systems/08_ui_desktop.md), [systems/09_control_bot.md](systems/09_control_bot.md).

### T50 [H2H] — Implement HeadToHead pairing + dashboard 🆕
`HeadToHead_Spec_v0.1` describes pairing ai-paper vs ai-live (and ai-live vs my-live once AI Live ramps) on a stable SEA `signal_id` — daily metric cards (P&L, win-rate, Sharpe, max drawdown, divergence). Feeds the 5 pp divergence gate from V2_MASTER_SPEC §8.2/§8.3 for AI-Live capital scale-up. Today no H2H code exists, AND SEA's signal schema doesn't define a `signal_id` field — that's a prerequisite design fix.

- **Status:** Deferred 2026-05-25 (surfaced during System 07 doc rewrite). Gated on (a) paper-trade fills accumulating ≥ 14 days per AI-Live canary gate 1, (b) SEA emitting a stable `signal_id`, (c) T49 Journal shipping (H2H reads journal entries for SHAP / cohort context).
- **Effort:** ~3–4 days. Land `server/reporting/headToHead/` module: pairing logic, daily aggregation, divergence detector, tRPC surface for the dashboard card.
- **Cross-ref:** [systems/07_portfolio_reporting.md §10](systems/07_portfolio_reporting.md), [systems/04_signal_engine.md](systems/04_signal_engine.md) (signal_id schema gap).

## Closed items (kept for one cycle as audit trail; delete on next pass)

_None yet._

---

## How to use this file

- **Adding a new TODO:** Append at the appropriate priority slot. Keep entries tight — what / status / blocker / link.
- **Marking done:** Move to "Closed items" section with a one-line outcome note. Next memory cleanup pass deletes the closed section.
- **Cross-references:** Use `docs/<FILE>.md` for design docs (they live in the repo, survive cleanly), not wikilinks to memory files (which can be deleted out from under).
