# T3 — V2 Signal System Implementation Plan

Complete module-by-module implementation plan for T3 Phases 2, 3, 5, 6, 7. Phase 1 is design (already complete via V2_MASTER_SPEC). Phase 4 is data accumulation (no code).

**Authority hierarchy:**
- `docs/V2_MASTER_SPEC.md` (§9 D1–D75 LOCKED 2026-05-17) — design source of truth
- `docs/FEATURE_HEAD_RECONCILIATION.md` — feature/head/runtime reference; consult when coding
- This doc — engineering plan; what to build where, in what order

Updated 2026-05-17 against V2_MASTER_SPEC commit `09e01c8`.

---

## Phase 2 — TFA feature emitter (69 NEW features)

Implements L1 layer: extend live parquet schema from 377 → 446 columns.

**Sub-phased by state complexity (parallelizable across sessions — only `_build_column_names()` ordering is shared):**

### Phase 2a — Stateless features (22 features) — ship first

| Features | Block | Module | Notes |
|---|---|---|---|
| `india_vix`, `india_vix_change_5min` | C3 | NEW `features/india_vix.py` | Dhan VIX subscription; NaN on MCX (open question) |
| `net_gex`, `gamma_flip_distance_pct`, `dealer_net_delta`, `charm_estimate_atm`, `vanna_estimate_atm` | C4 | NEW `features/dealer_hedging.py` | GEX formula on MCX unclear (open question) |
| `max_pain_strike`, `distance_to_max_pain_pct`, `max_pain_gravity_strength` | C10 | EXTEND `features/levels.py` | Conditional via C12 `days_to_expiry_bucket` |
| `days_to_expiry_bucket` | C12 | EXTEND `features/expiry.py` | Categorical {0, 1, 2, 3+} |
| `is_tier_2_event_day`, `event_type_categorical`, `hours_to_next_tier_1_or_2_event` | C11 | NEW `features/event_calendar.py` | Reads NEW `config/event_calendar.json` |
| `rsi_14_5min`, `macd_5min`, `macd_signal_5min`, `macd_histogram_5min`, `volume_price_divergence_5min` | C2 | NEW `features/technical.py` | Stateless given the 5-min bars from 2b |
| `oi_weighted_ce_resistance_strike`, `oi_weighted_pe_support_strike`, `pcr_intraday_slope_30min` | C1 subset | EXTEND `features/chain.py` | Rolling 30-min PCR ring |

### Phase 2b — Session-state features (39 features) — ship after 2a

| Features | Block | Module | State |
|---|---|---|---|
| `ma_5_1min`, `ma_20_1min`, `ma_5_5min`, `ma_20_5min`, `ma_5_15min` | B1 | NEW `features/bars.py` + `features/multi_tf.py` | 1m/5m/15m bar deques |
| `adx_5min`, `momentum_5min`, `momentum_15min` | B2 | `features/multi_tf.py` | 5-min OHLC ring (14 bars for ADX) |
| `dist_from_session_open_pct`, `dist_from_session_vwap_pct`, `session_high_age_min`, `session_low_age_min` | B3 | NEW `features/session.py` | session open + VWAP accumulator + H/L+ts |
| `consecutive_higher_highs_5min`, `consecutive_higher_lows_5min`, `range_compression_ratio` | B4 | `features/multi_tf.py` | 5-min H/L bar ring |
| `distance_to_opening_range_{high,low}_pct` | B5 | NEW `features/opening_range.py` | 09:15-09:29 IST NSE / 09:00-09:14 IST MCX (D74 B3); NaN until window close |
| `minutes_from_open`, `minutes_to_close`, `lunch_session_flag` | C6 | NEW `features/intraday_time.py` | session-open ts |
| `active_strike_shift_direction`, `active_strike_shift_velocity`, `atm_to_otm_flow_ratio` | C7 | EXTEND `features/active_features.py` | Last-N ATM strike ring (~20 ticks) |
| `atm_ce_premium_vwap_dist`, `atm_pe_premium_vwap_dist`, `premium_vwap_reclaim_count` | C8 | NEW `features/premium_vwap.py` | Per-leg VWAP accumulator + reclaim counter |
| `iv_change_1min`, `iv_change_5min`, `iv_skew_velocity`, `iv_expansion_without_spot` | C9 | EXTEND `features/greeks.py` | 1-min + 5-min IV rings |
| `trend_age_ticks`, `volume_no_move_score` | C5 | NEW `features/exhaustion.py` | Reset-on-regime-change counter per W5 |
| `ce_wall_strength_rel`, `pe_wall_strength_rel`, `ce_oi_change_5min_pct`, `pe_oi_change_5min_pct` | C1 5-min | EXTEND `features/chain.py` | 5-min chain snapshot ring |
| `oi_dominance_streak_min` | C1 | NEW `features/oi_dominance.py` | Signed minute counter ±240 cap per W4 |
| `ce_oi_change_15min_pct`, `pe_oi_change_15min_pct` | C1 | EXTEND `features/chain.py` | 15-min chain ring |

### Phase 2c — Cross-day-state features (8 features) — ship last

| Features | Block | Module | State |
|---|---|---|---|
| `distance_to_prev_day_{high,low}_pct` | B5 | EXTEND `features/levels.py` | NEW `data/state/<inst>_levels.json` at session close (D74/§2.1.7 9d) |
| `distance_to_round_number_{above,below}_pct` | B5 | EXTEND `features/levels.py` | Per-instrument step (D52): nifty/banknifty=100, crude=5, natgas=1 |
| `distance_to_5d_swing_{high,low}_pct` | B5 | EXTEND `features/levels.py` | 5-day rolling max/min from `<inst>_levels.json` |
| `ce_oi_change_60min_pct`, `pe_oi_change_60min_pct` | C1 D62 | EXTEND `features/chain.py` | **60-min chain snapshot ring — biggest memory delta** |

### Phase 2 schema-version artifacts

- **CREATE** `LATEST_SCHEMA_VERSION = 7` constant in `python_modules/tick_feature_agent/output/emitter.py` (doesn't exist today)
- **CREATE** `config/schema_registry/v7.json` writer in `Emitter.__init__` per D74 B1 — TFA emitter is authoritative writer, writes on startup if missing
- **MODIFY** `_build_column_names()` to append B (23) then C (46) then new trend/swing target cols, preserving 377 existing column order

Full feature list with exact column names + consumer heads: see `FEATURE_HEAD_RECONCILIATION.md` §2.

---

## Phase 3 — Trend + swing target labels (24 NEW columns, 1 new module)

All 24 ship in NEW `python_modules/tick_feature_agent/features/trend_swing_targets.py` (mirror of existing `features/targets.py` pattern).

**12 trend targets** = 6 types × 2 horizons {900s, 1800s}.
**12 swing targets** = 6 types × 2 horizons {3600s, 7200s}.

**Critical implementation detail:** extends `TargetBuffer._PendingRow` retention from 300s → **7200s** (24× memory growth on pending-row buffer; profile before merging).

Target type definitions: `direction`, `magnitude`, `max_excursion`, `max_drawdown`, `continues`, `breakout_imminent` per §2.2.2. Per-layer noise-floor multiplier (D69): scalp=1×, trend=3×, swing=6×.

Full target list: see `FEATURE_HEAD_RECONCILIATION.md` §3.2 and §3.3.

---

## Phase 5 — Retrain pipeline (MTA + scripts)

### §5.1 — `_shared/targets.py` extension

| Item | Decision |
|---|---|
| Structure | **Extend** `MVP_TARGETS` 60 → 84 by adding 24 `TargetSpec` rows. Trainer iterates `MVP_TARGETS.items()`; a flat 84-row tuple slots in with zero call-site change |
| New metadata field | Add `head_type: Literal["scalp","trend","swing"]` to TargetSpec. Backfill existing 60 with `"scalp"`. Needed by Phase 5.3 calibration (filters binary heads) and Phase 5.4 regression block |
| Validation guards | Bump asserts: `len == 84`; `{head_type} == {scalp,trend,swing}`; binary=32 / regression=52 |
| Touch sites | `trainer.py` L39 import + L314 loop OK + L430-431 manifest target list OK; `model_loader.py` L22 import + L60 loop OK; `engine.py._gather_predictions` L76 absorbs 24 more keys |

### §5.2 — `trainer.py` changes for the Saturday retrain

| Step | Module + function | New code | Dependencies |
|---|---|---|---|
| 1. Cron trigger 02:00 IST | NEW `scripts/retrain_v2.sh` invokes `python -m model_training_agent.cli --mode walk-forward --instrument <inst>` for each of 4 instruments | NEW shell + cli.py `--mode walk-forward` flag | Cron entry under existing auto-recorder |
| 2. 1680 LightGBM fits | EXTEND `trainer.py` with `train_instrument_walk_forward(inst, dates_window)` — builds 5 holdout folds × 84 heads × 4 inst = 1680 fits | NEW function alongside existing `train_instrument` | Phase 2 schema_registry/v7.json |
| 2a. Walk-forward fold builder | NEW `model_training_agent/walk_forward.py` → `build_5_folds(all_dates, holdout_utils)` returns 5 fold pairs + 1 calibration fold (most recent unused week) | NEW module | `holdout_utils.py` reused |
| 2b. `scale_pos_weight` per binary head | EXTEND `_fit_one` (trainer.py L129) to compute and pass `scale_pos_weight = n_neg/n_pos` from `y_train.value_counts()` | ~5 lines | LGBM_PARAMS_BINARY extended per §2.3.3 |
| 2c. Hyperparam pinning | EXTEND `trainer.py` L46-67 with §2.3.3 LOCKED defaults read from NEW `config/mta_hyperparams.json` | NEW config + ~10 line loader | L3 D2 |
| 3. Sim-PnL compute | NEW `model_training_agent/validation/sim_pnl.py` per §2.3.4 — `compute_sim_pnl(signals, tick_replay_data, charges_spec)` | NEW module (~250 LOC) | `Charges_Spec` (§4.8 — location to verify), Phase 5.3 calibration first |
| 4. Per-head sim_pnl compare | NEW `model_training_agent/promotion.py` → `compare_sim_pnl(new_per_head_mean, prior_baseline)` | NEW module | Existing LATEST_HEADS pointer |
| 5. Regression block | Same `promotion.py` → `apply_regression_block(deltas, threshold=-0.05)` returns `(accepted, blocked_with_reasons)` | Function | Threshold from `config/mta_hyperparams.json` |
| 6. CANDIDATE staging | `promotion.py` → `stage_candidate_heads(...)` writes `models/<inst>/CANDIDATE_HEADS.json` per D72 + D64 format | Function | Phase 5.3 `.calibration.json` already produced |
| 7. Pre-market gate Mon 08:50 | NEW `scripts/pre_market_check.py` + NEW `scripts/promote_candidates.py` | NEW scripts | §6.1 Mon 08:50 row |

### §5.3 — Probability calibration (D72 + D75 Gap 4)

**Binary heads requiring calibration: 32 per instrument × 4 = 128 maps**

| Layer | Binary types | Horizons | Count |
|---|---|---|---|
| Scalp | `direction`, `direction_persists`, `breakout_in`, `exit_signal` | 60/120/180/240/300s | 4 × 5 = **20** |
| Trend | `trend_direction`, `trend_continues`, `trend_breakout_imminent` | 900/1800s | 3 × 2 = **6** |
| Swing | `swing_direction`, `swing_continues`, `swing_breakout_imminent` | 3600/7200s | 3 × 2 = **6** |

| Item | Decision |
|---|---|
| Module | NEW `python_modules/model_training_agent/calibration.py` (~150 LOC) |
| `fit_isotonic_per_head(raw_probs, y_true)` | `sklearn.isotonic.IsotonicRegression`. Returns None on degenerate fold (`<2` classes) |
| `serialize_calibration_map(iso, path, n_samples, trained_at)` | Per D74 B2: `{method, x_thresholds: iso.X_thresholds_.tolist(), y_calibrated: iso.y_thresholds_.tolist(), trained_at, n_samples}` |
| `serialize_identity_map(path)` | No-op map (`x=y=[0,1]`) for Wave 2 legacy heads. Used by `scripts/migrate_wave2_calibration.py` once at first deploy |
| `fit_all_binary_heads_for_instrument(inst, fold_df, ts_dir)` | Loops MVP_TARGETS filtering `target_type=='binary'`; per head: head.predict → fit → serialize |

**Calibration-fold logistics:**
- `walk_forward.build_5_folds` returns `(folds, calibration_dates)` — most recent week unused by sim_pnl folds becomes calibration fold
- Assertion: `set(calibration_dates) & union(fold_val_dates) == empty`
- Holdout dates (per `config/holdout_dates.json`) excluded from both training AND calibration
- Edge case: <6 weeks of clean data → trainer logs WARNING + skips calibration → pre-market check #7 fails CRITICAL → operator decision

### §5.4 — Regression block (Gap #7 D7)

| Item | Decision |
|---|---|
| Module | Function in `promotion.py` |
| Signature | `apply_regression_block(candidate_heads, prior_baseline, threshold=-0.05) -> (accepted, blocked_reasons)` |
| Logic | `delta_pct = (new - prior) / abs(prior)`; reject if `delta_pct < threshold`. First-ever heads (prior == 0) always pass |
| Output | Logged to `models/<inst>/<ts>/promotion_audit.json` + INFO Telegram per blocked head |
| Threshold source | `config/mta_hyperparams.json.regression_threshold = -0.05` (per-head override per D31 follow-up, deferred) |

### §5.5 — CANDIDATE staging + migration scripts

| Script | Status | Purpose |
|---|---|---|
| NEW `scripts/migrate_latest_to_heads.py` | NEW (D64) | One-time: convert existing `models/<inst>/LATEST` (single timestamp text) → `LATEST_HEADS.json` with per-head metadata. Calibration files default to identity maps for binary scalp heads |
| NEW `scripts/promote_candidates.py` | NEW | Mon AM: if `CANDIDATE_APPROVED.touch` exists (Sun human review), archive current `LATEST_HEADS.json` → `HEADS_HISTORY/<date>.json` and move `CANDIDATE_HEADS.json` → `LATEST_HEADS.json` |
| LATEST_HEADS.json entry format | per D64 + D72 + D75 Gap 4 | `{head_name: {trained_at, schema_version, feature_count, head_type, calibration_file: "<head>.calibration.json"|null}}` — `null` for regression heads |

### §5.6 — Pre-market check (`scripts/pre_market_check.py`)

NEW script. 7 checks per §5.2:

| # | Check | Module call | Pass criterion | RED action |
|---|---|---|---|---|
| 1 | Model file integrity (336 heads) | For each LATEST_HEADS entry: `lgb.Booster(...).num_feature() == feature_count` EXACTLY (D74 W1) | All match | CRITICAL Telegram; trading_allowed=0 |
| 2 | Scaler / feature_config | All 4 `config/model_feature_config/<inst>_feature_config.json` exist + parse | All present | CRITICAL |
| 3 | Prediction sanity | Replay last hour of yesterday's parquet through all heads; check no-all-NaN, no-constant, mean within ±3σ of historical baseline | All within bounds | WARN per head; CRITICAL if >3 heads fail in same instrument |
| 4 | Dhan token age | `token_age_hours < 14` for `dhan` + `dhan-ai-data` | <14h | CRITICAL |
| 5 | Chain feed age | Per-instrument: most recent chain snapshot <24h | <24h | CRITICAL |
| 6 | Last training timestamp | `max(trained_at)` <14 days | <14d | WARN |
| 7 | **Calibration map presence (D75 Gap 4 scope: 128 binary maps)** | For binary heads only: `.calibration.json` exists + parses with `{method, x_thresholds, y_calibrated}` | All 128 valid | CRITICAL per missing |

| Implementation | Decision |
|---|---|
| Output | Telegram via `tfa_bot/bot.py` `send_message` helper; log to `logs/pre_market_check/<date>.log` |
| Cron | Existing auto-recorder cron 08:50 IST |
| Exit code | 0 green; 1 RED → caller disables `ai-live` channel via `data/channel_state/ai-live.json.trading_allowed = 0` (D24) |

### §5.7 — Drift detection (`scripts/drift_check.py`)

NEW script. Cron: 20:00 IST daily post-session.

| Step | Action |
|---|---|
| 1 | Load `logs/signals/<inst>/<date>_signals.log` + realized targets from parquet |
| 2 | Per-head metric: binary → AUC; regression → `current_rmse / baseline_rmse` |
| 3 | Rolling 5-day ring stored in NEW `data/drift/per_head_metric_history.json` |
| 4 | Compare 5-day mean against `models/<inst>/<ts>/baseline_auc.json` (written by trainer) |
| 5 | Alert per-head if `(baseline - 5day_mean) / baseline > 10%` (D25 configurable) |

### §5.8 — SHAP reporting (§5.4)

| Item | Decision |
|---|---|
| Per-signal capture | EXTEND `signal_engine_agent/engine.py` — after gate fire, call `models.models[firing_head].predict(X, pred_contrib=True)`. Extract top-5 by `abs(shap)`. Append to signal log JSON as `top_5_shap_contributors` |
| Helper module | NEW `signal_engine_agent/shap_explainer.py` → `compute_top_n_shap(booster, X, feature_names, n=5)` (~40 LOC) |
| Cost | ~1ms per call per spec §5.4 |
| Weekly report | NEW `scripts/shap_report_weekly.py` — Sunday EOD aggregates by winner/loser/instrument/feature stability → `docs/reports/shap_weekly_<YYYY-WW>.md` |

---

## Phase 6 — SEA gate + trade management + risk controls

### §6.1 — Layer-by-layer module breakdown (L4–L8)

#### L4 — Gate logic (§2.4)

| Component | Module | Function summary | D-entries |
|---|---|---|---|
| `decide_action` (scalp) — touch-up | EXTEND `signal_engine_agent/thresholds.py` | Side-aware TP/SL per Gap 1: LONG uses `max_upside_60s` / `max_drawdown_60s × 1.3`; SHORT uses `max_upside_pe_60s` / `max_drawdown_pe_60s × 1.3`. Lock 60s window (no 300s ladder) per W3 | D75 Gap 1, D74 W3 |
| `decide_action_trend` — NEW | NEW function in `thresholds.py` (or split into `gates_trend.py` if >150 LOC) | AND-gate: `trend_direction_900s ≥ θ_trend_dir` AND `|trend_magnitude_900s| ≥ 25 pts` AND `trend_max_drawdown_900s ≤ 15 pts` AND `cooldown ≥ 5min` AND L8 regime ∈ {trend, trend_strong}. 5-tick dwell. TP/SL on SPOT per Gap 2 | D75 Gap 2, L4 D2 |
| `decide_action_swing` — NEW | NEW function `gates_swing.py` (or same as trend) | AND-gate: `swing_direction_3600s ≥ 0.70` AND `|swing_magnitude_3600s| ≥ noise_floor × 6` AND `swing_max_drawdown_3600s × 1.4 ≤ 25 pts` AND `cooldown ≥ 15min` AND `L8.regime == trend_strong AND sustain ≥ 5min` AND `trend_age_ticks < exhaustion_threshold` AND `now < swing_entry_cutoff` (13:30 NSE / 21:30 MCX) | D55, L8 Q1, L7 swing cutoff |
| 3-way ensemble combinator — NEW | NEW `signal_engine_agent/ensemble_combinator.py` (~120 LOC) | Implements §2.4 agreement matrix: all-3 → swing params; 2-agree → longer-horizon; 2-disagree → skip; opposite-2 → skip; solo → that gate. Tags `cohort_type` ∈ {solo_scalp, solo_trend, solo_swing, 2_agree, 3_agree, disagreement_skip} | D55, D56, I9 fix |
| Trend bias filter — NEW | Function in `ensemble_combinator.py` | Magnitude guard `|trend_magnitude_900s| ≥ noise_floor` per I14; θ_bias_bullish=0.65, θ_bias_bearish=0.35 from `config/sea_thresholds/<inst>.json` | D49, D50, I14 |
| Agreement-window upgrade — NEW | NEW `signal_engine_agent/upgrade_window.py` (~100 LOC) | 6-tick state machine; on trend/swing same-direction fire AND `trend_direction_900s ≥ θ_upgrade_trend_dir` (D67), replace open position's TP/SL via `position_state.update_tp_sl`. One-shot per position | D61, D67 |

#### L5 — Trade management (§2.5 + §2.5.1)

| Component | Module | Function summary | D-entries |
|---|---|---|---|
| Per-position state | NEW `signal_engine_agent/position_state.py` (~250 LOC) | dataclass `PositionState` matching §2.5.1 JSON; `write_state_atomic`, `load_open_positions_on_restart`, `archive_to_closed` | D68 |
| TP/SL lock at entry | `position_state.py` → `lock_tp_sl_at_entry(predictions, side, layer, entry_tick)` | Side-aware scalp (Gap 1); spot-based trigger for trend/swing (Gap 2) | L5 D2, D75 Gap 1 + Gap 2 |
| Trail tier evaluators | NEW `signal_engine_agent/trail_evaluator.py` | `evaluate_trail_scalp/trend` (2-tier: BE 0.33×TP, trail 0.66); `evaluate_trail_swing` (3-tier: BE 0.25, partial 50% at 0.5, trail 0.75) | D71 |
| Exit triggers | NEW `signal_engine_agent/exit_triggers.py` (~300 LOC) | `check_tp/sl/time_stop/trail_tier/oi_exit_5min/oi_exit_60min/exhaustion/regime_flip_protection`. First match wins per D70 | D70 |
| OI exits | `exit_triggers.py` | 5-min thresholds (-15% / +20%) for scalp/trend; 60-min thresholds (-20% / +25%) for swing per D62. Wall-break via inline rolling buffer (D63) | D62, D63 |
| Inline wall-strength delta | `position_state.py` | `update_wall_strength_buffer` (per-min sample, ring of 60); `wall_strength_delta(buffer, window_min)` | D63, Batch 3 Q2 Option B |
| Inline exhaustion | `exit_triggers.py` → `check_exhaustion` reads `state.entry_snapshot` (frozen) vs row_now for trend_age_ticks, momentum, premium momentum, volume_no_move | Per-position state | D63 |
| Regime-flip protection | `exit_triggers.py` → `check_regime_flip_protection` | Fires on regime != entry_snapshot.regime AND new regime held ≥3min AND new regime ∉ {benign}. `trend_strong → trend` is benign per D71 — no fire | Gap #8, D71 |
| Per-(inst,side,layer) stop-out counter | NEW `signal_engine_agent/stopout_tracker.py` (~80 LOC) | `record_stopout`, `is_locked_out`, `reset_on_winner`, `reset_on_session_start`. Persists to `data/sea_state/stopout_counters.json` | L5 D3 + Q1 |
| Partial-fill mechanics (swing Tier 2) | EXTEND TEA (§4.4) | Two sequential market orders: first at partial trigger (50% qty), second at TP/trail/SL (remaining 50%). `state.partial_taken` tracks across | L5 Q2 |

#### L6 — Position sizing (§2.6)

| Component | Module | Function | D-entries |
|---|---|---|---|
| `daily_risk_budget` hybrid floor | NEW `signal_engine_agent/sizing.py` (~80 LOC) | `daily_risk_budget(channel_equity, l7_limit) = min(l7_limit, channel_equity * 0.05)` | L6 D1 |
| `lots = floor(...)` | `sizing.py` → `compute_lots(daily_budget, max_signals_per_day, predicted_drawdown_pts, contract_multiplier)`. Floor at 1, skip if 0 | L6 D2 / D4 |
| Portfolio at-risk cap | `sizing.py` → `check_portfolio_cap` sums `at_risk = lots × sl_distance × multiplier` across open positions; reject if `(total + candidate) > 2.5 × max(L7.daily_loss_limit)` | L6 D3 |
| Lot floors per instrument | Read `config/instrument_profiles/<inst>_profile.json.lot_size` (naturalgas=1250 per D74 B4 — currently absent, add) | D74 B4 |

#### L7 — Risk controls (§2.7)

| Component | Module | Function | D-entries |
|---|---|---|---|
| Layer-aware concurrent cap | NEW `signal_engine_agent/risk_gate.py` (~200 LOC) | `check_layer_concurrent_cap(inst, layer, open_positions)` — max 1 scalp + 1 trend + 1 swing per inst. Always enforced | L7 D7 |
| Swing entry cutoff | `risk_gate.py` → `check_swing_cutoff(now_ist, exchange)` — block new swing after 13:30 NSE / 21:30 MCX. Soft (`risk_limits_enabled` gated) | §2.7 |
| Shared daily-loss budget | `risk_gate.py` → `check_daily_loss(inst, realized_pnl_today)` reads `config/risk_limits/<inst>.json` | L7 Q1 |
| Blackout windows | `risk_gate.py` → `check_blackouts(now, inst)` — lunch, last 5 min, maintenance, warm-up | §2.7 |
| Tier-1 event blackouts | `risk_gate.py` → `check_tier1_events` reads NEW `config/event_calendar.json` (D28). Always enforced | §2.7, D28 |
| Swing +2/day signal cap | `risk_gate.py` → `check_signal_caps` — scalp+trend share `max_signals_per_day`; swing has separate `swing_max_signals_per_day = 2` | L7 Q2 |
| Consecutive-loser auto-pause | EXTEND existing `risk_control_client.py` | `check_consecutive_loser_pause(channel)` per L7 D2 | L7 D2 |
| Rolling DD halt (5d, 10d) | `risk_gate.py` → `check_rolling_dd_halt(channel, dd_history)` 2-tier | L7 D3 |
| `risk_limits_enabled` toggle | `risk_gate.py` — soft checks read toggle; always-enforced list ignores | L7 D4, D44 |
| Expiry 14:30 entry cutoff | `risk_gate.py` → `check_expiry_cutoff(now, inst, days_to_expiry)`. Always enforced | L7 D5 |

#### L8 — Regime / meta (§2.8)

| Component | Module | Function | D-entries |
|---|---|---|---|
| 4-state classifier | NEW `signal_engine_agent/regime_classifier.py` (~150 LOC) | `classify(row, history) -> Regime`. `trend_strong` (adx≥30 AND HH≥5), `trend` (adx≥25 AND HH≥3), `chop` (range_comp<0.6 AND adx<15), `range` otherwise | L8 D1 |
| 5-min sustain for swing | `regime_classifier.py` → `regime_sustain_min(regime, history)` returns consecutive minutes regime held | L8 Q1 |
| Benign degradation | Used by `check_regime_flip_protection`: `trend_strong → trend` benign (no fire) | L8 Q2, D71 |
| Market-controller categorical | `regime_classifier.py` → `classify_market_controller(row, history)` reads `call_put_oi_diff` sign over 10min + wall strength compare | §2.8 |
| Regime-flip definition | 3-min sustained via `regime_history` ring (5 min × 1-sec snapshots) | §2.8 |
| No-lookahead enforcement | NEW `tests/test_exit_trigger_no_lookahead.py` per D65 | D65 |

### §6.2 — Schema reconciliation runtime (D66)

| Item | Decision |
|---|---|
| Module | NEW `python_modules/signal_engine_agent/schema_reconciler.py` (~120 LOC) |
| `load_schema_registry(path)` | At SEA startup; scans `config/schema_registry/v*.json` → `{version: column_list}` |
| `project_row_for_head(row, head_schema_version, registry)` | Project current 446-col row down to head's expected column subset in strict order |
| `quarantine_head_on_break(head_name, reason)` | In-memory set; CRITICAL Telegram on entry; head stays out until next retrain |
| Touchpoint into `engine._gather_predictions` | Call `project_row_for_head` BEFORE `head.predict(X)`. Quarantined heads return NaN |

### §6.3 — Calibration runtime (D72 + D75 Gap 4)

| Item | Decision |
|---|---|
| Module | EXTEND `signal_engine_agent/model_loader.py` |
| Loader change | After each `.lgbm` load, if `calibration_file != null`, load JSON, store `(x_thresholds, y_calibrated)` on `LoadedModels.calibration_maps[head_name]` |
| Apply function | `apply_calibration(raw_prob, head_name) -> float`: if head not in maps → return raw (regression head); else `np.interp(np.clip(raw_prob, 0, 1), x, y)` per D74 B2 |
| Engine touchpoint | EXTEND `engine._gather_predictions` — wrap `_pred(...)` for binary heads: `calibrated = apply_calibration(raw, head_name)`. Gate threshold compares against CALIBRATED |
| Identity-map fallback | Wave 2 legacy binary heads ship with identity maps (one-time migration) |
| No sklearn dep in SEA | `numpy.interp` only |

### §6.4 — Per-position state persistence (D68)

| Item | Decision |
|---|---|
| Module | NEW `position_state.py` (~250 LOC) |
| Dataclass | `PositionState` matching §2.5.1 JSON exactly |
| `write_state_atomic` | `.tmp` then `os.replace` to final path on every mutation |
| `load_open_positions_on_restart` | Scan `data/sea_state/<inst>/*.json` (excl. CLOSED/); age-check vs wall-clock; force-close if >layer max-hold (5/30/120 min); else resume |
| `archive_to_closed(state)` | On close: move state file to `data/sea_state/<inst>/CLOSED/<date>/<position_id>.json` |
| Wall-strength buffer recovery | NaN-pad samples for gap window; wall-break trigger skipped on any NaN-containing lookup |
| Resume alert | INFO Telegram per resumed position via tfa_bot |

### §6.5 — Configuration extensions

| Config | Status | Keys |
|---|---|---|
| `config/sea_thresholds/<inst>.json` × 4 | EXTEND | `gate_mode: "wave2+trend+swing"`, `θ_trend_dir`, `θ_swing_dir`, `θ_upgrade_<layer>_dir` (default = `θ_<layer>_dir`), `θ_bias_bullish/bearish`, dwell_ticks per layer, cost_floor_buffer_pct, slippage_pct, sl_safety_multiplier per layer, `exit_triggers_enabled` (D73) |
| `config/risk_limits/<inst>.json` × 4 | **NEW FILE + NEW DIR** (per L1 D5 split) | `daily_loss_limit`, `max_signals_per_day`, `swing_max_signals_per_day` (2), `max_concurrent_positions`, `swing_entry_cutoff_ist`, `blackout_windows[]`, `n_consecutive_loser_pause_threshold`, `risk_limits_enabled`, `layer_concurrent_caps` |
| `config/instrument_profiles/<inst>_profile.json` | EXTEND | `lot_size` (naturalgas=1250 per D74 B4), `round_number_step` (D52), `opening_range_window_min`, `noise_floor_{scalp,swing}_pts` |
| `config/mta_hyperparams.json` | **NEW** | §2.3.3 LightGBM defaults + `regression_threshold` |
| `config/event_calendar.json` | **NEW** | Tier-1 + Tier-2 events per D28 |

---

## Phase 7 — Paper trade ramp

### §7.1 — Sub-phase config orchestration (D73)

| Sub-phase | `exit_triggers_enabled` | SEA behavior |
|---|---|---|
| 7a Minimum | `["tp","sl","trail","time","regime_flip"]` | OI / exhaustion log `trigger_disabled` and skip |
| 7b +OI | 7a + `"oi_buildup","oi_unwind","wall_break"` | Exhaustion still skipped |
| 7c +Exhaustion | 7a + 7b + `"trend_tiring","premium_decel","volume_absorption"` | All triggers active |

| Item | Decision |
|---|---|
| SEA read | `exit_triggers.py` reads `config.exit_triggers_enabled` at startup (snapshot — restart between sub-phases). Each `check_*` early-returns `(no_exit, reason="trigger_disabled")` if its key absent |
| Migration | Operator edits config + restarts SEA. No code deploy |
| A/B compare | NEW `scripts/exit_trigger_ab_compare.py` reads signal logs + cohort tags + exit_reason. Aggregates per-trigger P&L. Outputs to `docs/reports/exit_trigger_ab_<sub_phase>_<date>.md` |
| Failure path | If 7b or 7c contribution ≤ 0, leave that trigger class permanently disabled in production config. Spec unchanged |

### §7.2 — Trade journaling (extends §5.1)

| Item | Decision |
|---|---|
| Cohort tags | Signal log entry gains `cohort_type` ∈ {solo_scalp, solo_trend, solo_swing, 2_agree, 3_agree}. Source: `ensemble_combinator.combine_three_way`. Logged via `SignalLogger.log` |
| Per-trigger fire reason | Extend `exit_reason` allowed values: `oi_unwind, oi_buildup, wall_break, exhaustion_trend_age, exhaustion_premium, volume_absorption, trigger_disabled` |
| Weekly report | NEW `scripts/trade_quality_report_weekly.py` (Phase 5 introduces; Phase 7 extends) |
| New sections | (1) per-cohort P&L distribution per D56; (2) per-trigger fire count + P&L attribution per D73; (3) reliability diagram per binary head (D72 calibration drift, ±5pp alarm); (4) SHAP feature stability |
| Calibration drift alarm | Any bucket on any binary head deviates >5pp → WARN Telegram + log to `logs/calibration_drift/<date>.log` → triggers ad-hoc recalibration |
| Cohort comparison | Per D56: track 3-of-3 agreement frequency (target ≥1/day); flag if <1/day AND solo cohort also unprofitable |

---

## Complete module touch list (across all phases)

| Path | Status | Phase | Purpose | LOC |
|---|---|---|---|---|
| **Phase 2 — TFA** | | | | |
| `python_modules/tick_feature_agent/output/emitter.py` | EXTEND | 2 | `_build_column_names()`, `assemble_flat_vector`, `LATEST_SCHEMA_VERSION`, schema_registry writer | M |
| `python_modules/tick_feature_agent/features/india_vix.py` | NEW | 2a | C3 features | S |
| `python_modules/tick_feature_agent/features/dealer_hedging.py` | NEW | 2a | C4 GEX + dealer features | M |
| `python_modules/tick_feature_agent/features/levels.py` | EXTEND | 2a + 2c | C10 max pain + B5 prior-day/round/5d-swing | S |
| `python_modules/tick_feature_agent/features/expiry.py` | EXTEND | 2a | C12 days_to_expiry_bucket | S |
| `python_modules/tick_feature_agent/features/event_calendar.py` | NEW | 2a | C11 event features | S |
| `python_modules/tick_feature_agent/features/technical.py` | NEW | 2a | C2 RSI/MACD | S |
| `python_modules/tick_feature_agent/features/chain.py` | EXTEND | 2a + 2b + 2c | C1 OI dynamics (5/15/60min) | M |
| `python_modules/tick_feature_agent/features/bars.py` | NEW | 2b | 1m/5m/15m bar aggregator | S |
| `python_modules/tick_feature_agent/features/multi_tf.py` | NEW | 2b | B1 MAs, B2 ADX, B4 patterns | M |
| `python_modules/tick_feature_agent/features/session.py` | NEW | 2b | B3 session features | S |
| `python_modules/tick_feature_agent/features/opening_range.py` | NEW | 2b | B5 opening range with NSE/MCX clocks | S |
| `python_modules/tick_feature_agent/features/intraday_time.py` | NEW | 2b | C6 time features | S |
| `python_modules/tick_feature_agent/features/active_features.py` | EXTEND | 2b | C7 strike migration | S |
| `python_modules/tick_feature_agent/features/premium_vwap.py` | NEW | 2b | C8 premium VWAP | S |
| `python_modules/tick_feature_agent/features/greeks.py` | EXTEND | 2b | C9 IV velocity | S |
| `python_modules/tick_feature_agent/features/exhaustion.py` | NEW | 2b | C5 trend_age + volume_no_move | S |
| `python_modules/tick_feature_agent/features/oi_dominance.py` | NEW | 2b | C1 oi_dominance_streak_min | S |
| `python_modules/tick_feature_agent/features/trend_swing_targets.py` | NEW | 3 | 24 new target columns; extends `_PendingRow` to 7200s retention | M |
| `python_modules/tick_feature_agent/tests/test_*.py` | NEW × 12 | 2 + 3 | Unit tests per new module | S each |
| `python_modules/tick_feature_agent/tests/test_no_lookahead.py` | **NEW (doesn't exist today)** | 2 + 5 | L1+L8 batch-feature scope per D65 | S |
| `python_modules/tick_feature_agent/tests/test_schema_registry.py` | NEW | 2 | Emitter writes v7.json on first start; refuses overwrite | S |
| **Phase 5 — MTA** | | | | |
| `python_modules/_shared/targets.py` | EXTEND | 5 | 60→84 + head_type | S |
| `python_modules/model_training_agent/trainer.py` | EXTEND | 5 | scale_pos_weight, walk-forward, hyperparam pinning | M |
| `python_modules/model_training_agent/walk_forward.py` | NEW | 5 | 5-fold + calibration-fold builder | S |
| `python_modules/model_training_agent/validation/sim_pnl.py` | NEW | 5 | §2.3.4 sim_pnl formula | M |
| `python_modules/model_training_agent/calibration.py` | NEW | 5 | Isotonic fit + serialization | S |
| `python_modules/model_training_agent/promotion.py` | NEW | 5 | Regression block + CANDIDATE staging | S |
| `python_modules/model_training_agent/cli.py` | EXTEND | 5 | `--mode walk-forward` flag | S |
| `python_modules/model_training_agent/tests/test_no_lookahead.py` | EXTEND | 5 | Cover trend/swing targets | S |
| `scripts/retrain_v2.sh` | NEW | 5 | Sat 02:00 cron wrapper | S |
| `scripts/pre_market_check.py` | NEW | 5 | 7 checks per §5.2 | M |
| `scripts/drift_check.py` | NEW | 5 | Daily 20:00 per-head AUC | M |
| `scripts/shap_report_weekly.py` | NEW | 5 | Weekly SHAP aggregation | S |
| `scripts/trade_quality_report_weekly.py` | NEW | 5 + extended Phase 7 | §5.1 + cohort + A/B + reliability | M |
| `scripts/exit_trigger_ab_compare.py` | NEW | 7 | 7a/7b/7c contribution measurement | S |
| `scripts/migrate_latest_to_heads.py` | NEW | 5 | One-time LATEST → LATEST_HEADS.json | S |
| `scripts/migrate_wave2_calibration.py` | NEW | 5 | One-time identity maps for Wave 2 binary heads | S |
| `scripts/promote_candidates.py` | NEW | 5 | Mon AM CANDIDATE → LATEST | S |
| **Phase 6 — SEA** | | | | |
| `python_modules/signal_engine_agent/engine.py` | EXTEND | 6 | Wire calibration + schema_reconciler + combinator + SHAP | M |
| `python_modules/signal_engine_agent/thresholds.py` | EXTEND | 6 | `decide_action_trend`, `decide_action_swing`, side-aware scalp | M |
| `python_modules/signal_engine_agent/ensemble_combinator.py` | NEW | 6 | 3-way combinator + bias filter + cohort tagging | M |
| `python_modules/signal_engine_agent/upgrade_window.py` | NEW | 6 | Agreement-window TP/SL upgrade | S |
| `python_modules/signal_engine_agent/position_state.py` | NEW | 6 | §2.5.1 schema + persistence + recovery | M |
| `python_modules/signal_engine_agent/trail_evaluator.py` | NEW | 6 | 2-tier scalp/trend + 3-tier swing | S |
| `python_modules/signal_engine_agent/exit_triggers.py` | NEW | 6 | All exit triggers (D70 first-wins) | M |
| `python_modules/signal_engine_agent/stopout_tracker.py` | NEW | 6 | Consecutive stop-out counter | S |
| `python_modules/signal_engine_agent/risk_gate.py` | NEW | 6 | L7 controls (layer cap, daily-loss, blackouts, swing cutoff, caps, DD halt) | M |
| `python_modules/signal_engine_agent/regime_classifier.py` | NEW | 6 | L8 4-state + sustain + controller | S |
| `python_modules/signal_engine_agent/schema_reconciler.py` | NEW | 6 | D66 column projection + quarantine | S |
| `python_modules/signal_engine_agent/model_loader.py` | EXTEND | 6 | Read LATEST_HEADS.json + load calibration maps | S |
| `python_modules/signal_engine_agent/shap_explainer.py` | NEW | 6 | top-N SHAP via `pred_contrib=True` | S |
| `python_modules/signal_engine_agent/sizing.py` | NEW | 6 | L6 D1/D2/D3/D4 sizing | S |
| `python_modules/signal_engine_agent/risk_control_client.py` | EXTEND | 6 | Consecutive-loser pause via new threshold | S |
| `python_modules/signal_engine_agent/tests/test_*.py` | NEW × 6 | 6 | Unit tests per new module | S each |
| **Phase 6 — configs** | | | | |
| `config/sea_thresholds/<inst>.json` × 4 | EXTEND | 6 | Trend/swing/upgrade/bias + `exit_triggers_enabled` | S |
| `config/risk_limits/<inst>.json` × 4 | **NEW (dir + 4 files)** | 6 | L7 risk limits per L1 D5 split | S |
| `config/instrument_profiles/<inst>_profile.json` × 4 | EXTEND | 6 | lot_size, round_number_step, opening_range_window_min | S |
| `config/schema_registry/v7.json` | NEW (written by Phase 2 emitter) | 2 (created) + 6 (read) | Schema-version column lists | — |
| `config/mta_hyperparams.json` | NEW | 5 | §2.3.3 LightGBM defaults | S |
| `config/event_calendar.json` | NEW | 6 | Tier-1/Tier-2 events per D28 | S |

S = <100 LOC; M = 100–500; L = 500+.

---

## Cross-phase dependency graph + critical path

**Blocking dependencies:**

1. **Phase 2 → Phase 3:** Phase 3 target columns append AFTER Phase 2 feature columns in `_build_column_names()`. Phase 3 can't merge until Phase 2 column order is locked.
2. **Phase 2/3 → Phase 4:** Phase 4 (data accumulation) starts only after emitter ships 446 cols + 24 targets. Need ≥30 sessions before Phase 5 can retrain.
3. **Phase 2 → Phase 6:** SEA `schema_reconciler` needs `config/schema_registry/v7.json` which TFA emitter writes on first startup.
4. **Phase 5.1 (`_shared/targets.py`) → all of Phase 5/6:** trainer + SEA both depend on the 84-target list with head_type metadata.
5. **Phase 5.5 (`migrate_latest_to_heads.py`) → Phase 6 SEA modifications:** `model_loader.py` rewrite consumes LATEST_HEADS.json; won't fall back to old LATEST text file.
6. **Phase 5.3 (calibration writer) → Phase 6.3 (calibration runtime):** runtime needs the JSON format committed.
7. **Phase 5.6 check #7 → Phase 5.5 `migrate_wave2_calibration.py`:** identity maps must exist or check fires CRITICAL on every binary head.
8. **Phase 5.2 sim_pnl → Phase 5.4 regression block:** block runs on sim_pnl deltas.
9. **Phase 6 `position_state.py` → `exit_triggers.py` + `trail_evaluator.py` + `upgrade_window.py`:** all mutate state.
10. **Phase 6 `regime_classifier.py` → `exit_triggers.check_regime_flip_protection` + `decide_action_swing`:** sustain requirement.
11. **Phase 6 → Phase 7:** sub-phase configs (`exit_triggers_enabled`) require all of Phase 6 active.

**Parallelization opportunities:**

- **Phase 2:** 2a, 2b, 2c can be coded in parallel by 3 sessions; only `_build_column_names()` merge is shared.
- **Phase 5:** `sim_pnl.py`, `calibration.py`, `promotion.py`, `walk_forward.py` are independent; 4 parallel sessions.
- **Phase 6:** L6 sizing, L7 risk_gate, L8 regime_classifier independent of L4/L5 trade-mgmt; 3 parallel sessions.
- **Phase 6 tests:** `test_thresholds_trend`, `test_thresholds_swing`, `test_ensemble_combinator` parallelize trivially.
- **Scripts:** `pre_market_check.py`, `drift_check.py`, `shap_report_weekly.py`, `trade_quality_report_weekly.py` are independent.

**Critical path (longest blocking chain):**

`_shared/targets.py (5.1)` → `trainer.py (5.2)` → `validation/sim_pnl.py (5.3)` → `promotion.py (5.4-5.6)` → first retrain → `model_loader.py (6.3)` → `engine.py (6.1-6.5 wire-up)` → first SEA cold-start → Phase 7a → 7b A/B → 7c A/B → AI Live transition.

Wall time ~30+ days dominated by Phase 4 data accumulation, ~10–13 days active coding.

---

## Risks specific to Phases 5/6/7 (Phase 2/3 risks listed in FEATURE_HEAD_RECONCILIATION)

1. **Sim-PnL replay correctness.** sim_pnl uses spot-based trigger semantics (Gap 2). If trainer's sim_pnl logic and SEA's runtime exit logic diverge on TP/SL semantics, Saturday retrain optimizes for a different metric than live behavior.
   - **Mitigation:** share a single `position_state.lock_tp_sl_at_entry` + `exit_triggers.check_tp/check_sl` between trainer's sim_pnl module and SEA runtime. Trainer becomes runtime-coupled; acceptable trade.

2. **Calibration fold leak.** If calibration-fold dates overlap with sim_pnl folds (or with holdout), sim_pnl numbers are biased upward.
   - **Mitigation:** explicit assertion in `walk_forward.build_5_folds`: `set(calibration_dates) & union(fold_val_dates) == empty`.

3. **LATEST_HEADS.json migration race.** During migration, some heads may have schema_version absent → SEA's `schema_reconciler` quarantines them.
   - **Mitigation:** run `migrate_latest_to_heads.py` BEFORE first Phase 6 SEA startup; pre-market check #1 catches stragglers.

4. **Per-position state corruption on SEA crash mid-mutation.**
   - **Mitigation:** write-tmp + rename atomicity (D68); recovery ignores temp files; force-close on age-exceeded.

5. **Configuration sprawl.** Each instrument now has 4 config files. Operator can desync.
   - **Mitigation:** pre-market check validates presence + cross-references key consistency.

6. **Agreement-window upgrade state lifecycle.** If two scalp signals fire in rapid succession on same (inst, side), state-machine semantics ambiguous.
   - **Mitigation:** explicit "one-shot per position_id" — keyed off position_id, not (inst, side). Test in `test_upgrade_window.py`.

7. **Sub-phase 7 promotion bias.** A/B compare on overlapping signals only — if 7b enables more signals (different fire conditions), comparison becomes apples-to-oranges.
   - **Mitigation:** A/B compare script enforces overlap by signal-fire timestamp + cohort tag; tracks "signals 7a-would-have-fired in 7b" separately.

---

## Open questions (flag for decision before relevant phase starts)

**Pre-Phase 2:**
1. **C4 GEX formula on MCX** — `net_gex`, `charm_estimate_atm`, `vanna_estimate_atm` need a dealer-positioning model. Does Dhan provide enough chain Greek data on MCX (crude/natgas)? Decide: emit NaN on MCX, or approximate from available data?
2. **C3 India VIX on MCX** — VIX is NSE-only. Decide: emit NaN on crude/natgas, or use a per-instrument vol proxy (e.g., 30-day realized vol)?

**Pre-Phase 5:**
3. **Trade-quality report owner module location.** Spec specifies contents but doesn't say which module produces it. Plan creates `scripts/trade_quality_report_weekly.py` — alternative location candidates (e.g., `python_modules/reporting/`)?
4. **`tfa_bot` send-message helper API.** `tfa_bot/bot.py` is currently RX-only (Telegram → action). The TX path for system-initiated alerts isn't shown. Verify or add small helper module.
5. **`Charges_Spec` module location.** §2.3.4 cost-floor logic depends on `Charges_Spec.compute_total_cost(...)`. Spec §4.8 says v0.1 read-only but doesn't path it. Phase 5 sim_pnl + Phase 6 cost-floor veto both need it.

**Pre-Phase 6:**
6. **TEA partial-fill double-submit path.** L5 Q2 specifies two sequential market orders for swing Tier 2 partial. TEA spec §4.4 isn't explicit on re-entrancy or how second close knows remaining qty. Plan assumes SEA's PositionState tracks `partial_taken` + remaining qty; TEA called with explicit qty each time. Need TEA-side confirmation.
7. **`baseline_pred_distribution.json` source.** Pre-market check #3 needs historical baseline mean+std per head for ±3σ sanity check. Plan extends trainer to emit this at retrain end; first-retrain has no baseline → check #3 degrades to "no all-NaN, no constant" sanity only.
8. **`risk_limits_enabled` toggle storage location.** Plan locates this at `config/risk_limits/<inst>.json`; but L7 D4 says "channel config" — same instrument might be on `ai-paper` (toggle false) and `ai-live` (toggle true) simultaneously. Likely channel-config not instrument-config.
9. **Backwards-compat with existing `gate_mode` enum.** Current `thresholds.load_thresholds_full` accepts `gate_mode ∈ {"current", "wave1", "wave2"}`. Phase 6 needs `"wave2+trend"`, `"trend"`, `"swing"`, `"wave2+trend+swing"`. Extend enum + add 3-way branch in `engine.py`.

---

## How to use this plan

- **Starting a phase?** Read the relevant §Phase block + verify no upstream blocker is incomplete via the dependency graph.
- **Picking a session task?** Pick from parallelization list; one module per session is good cadence.
- **Open question hits you?** Stop, raise it (Telegram or comment in PROJECT_TODO), get decision before coding around it.
- **Spec contradicts this plan?** Spec wins. Update this doc in same commit.
- **All phases complete?** Move T3 from ACTIVE → Closed items in PROJECT_TODO; archive this plan to `docs/archive/` for next major work item.
