# Project TODO — ai-development

Single source of truth for open project tasks. Top = highest priority. Add new items at the appropriate slot; mark closed items by deleting (git history of this file = audit trail).

## ACTIVE — currently in flight

### T0 — Resume point for next session (2026-05-17 EOD)
**Spec fully implementation-ready. All internal audit findings closed + external ChatGPT/Gemini review integrated.** Last commit `8d75ddf` on origin/main.

Today's work (19 commits):
- **Morning session (commits 6004b18 → 198bc41):** finalized L8 lock, swing layer added to v2 (D55, was T7), spec re-locked across L2/L4/L5/L7/L8 after swing addition, 4-batch internal audit (drift fixes + I9/I7/I8/I14/I10 design fixes), launcher hardening bundle A+B+C+D plus Round 2 audit.
- **Afternoon session (commits 196aacb → d0a7ef6):** fresh-eyes audit found 9 residual findings; all closed (D65–D71). Launcher Round 3 audit + Lubas rebrand (f2c0f75 — separate parallel work).
- **Evening session (commit 8d75ddf):** ChatGPT + Gemini external feedback integrated — 3 items added to v2 lock (D72 probability calibration, D73 Phase 7 sub-phases, D56 cohort tracking extension), 5 items added to PROJECT_TODO (T18 adaptive thresholds, T19 no-trade classifier, T20 meta-ensemble, T14 + T15 extended).

**Net spec state (V2_MASTER_SPEC):**
- 8 layers all LOCKED / RE-LOCKED 2026-05-17
- 73 decisions tracked in §9 (D1–D73), all resolved or scheduled for post-paper-trade tuning
- 446 L1 features (377 base + 23 B-block + 46 C-block ACCEPT)
- 84 model heads per instrument (60 scalp + 12 trend + 12 swing)
- Probability calibration pipeline (D72) unblocks T8 + T16 future upgrades

**Next-session entry point: T3 Phase 2 (TFA feature additions, ~1-2 days code).** Spec defines exactly what to build:
- 446-feature L1 emitter (377 base + 23 B-block + 46 C-block ACCEPT — schema_version bumps the registry per D66)
- 12 trend target columns + 12 swing target columns (Phase 3)
- New per-position state schema for inline composition exits (§2.5.1, I7/I8 + D68 fixes)
- LATEST_HEADS.json per-head schema metadata + isotonic calibration map per head (I10 + D72)
- Schema registry at `config/schema_registry/v<N>.json` (D66 runtime reconciliation)

Spec sections to read first when resuming: §0 architecture diagram, §2.1 L1 features, §2.2 L2 targets, §2.3 model architecture (calibration added), §6 phase plan (Phase 7 now has 7a/7b/7c sub-phases).

## P1 — design work while data accumulates

### T2 — Signal system v2 brainstorm (8 layers) — **COMPLETE 2026-05-17**
Stage-by-stage design of the perfect signal system. All layer designs land in the single source of truth `docs/V2_MASTER_SPEC.md`.

- **Status:** All 8 layers LOCKED. Audit complete (4 batches). 64 decisions tracked. Spec implementation-ready.
- **Layers (status header in V2_MASTER_SPEC §2.0):**
  - [x] Skeleton pass — all 8 layers consolidated (2026-05-16)
  - [x] L1 — Input features LOCKED 2026-05-17 (multi-touch: B5 S/R + 1hr OI for swing); 446 active features
  - [x] L2 — Target labels RE-LOCKED 2026-05-17 (12 swing targets added)
  - [x] L3 — Model architecture LOCKED 2026-05-16 (head count grew 60→84 per instrument for swing)
  - [x] L4 — Gate logic RE-LOCKED 2026-05-17 (decide_action_swing + 3-way ensemble + agreement-window upgrade + bias filter magnitude guard)
  - [x] L5 — Trade management RE-LOCKED 2026-05-17 (swing-specific exits + per-layer stop counter + inline exhaustion/wall-break composition)
  - [x] L6 — Position sizing LOCKED 2026-05-16 (formula scales to swing naturally)
  - [x] L7 — Risk controls RE-LOCKED 2026-05-17 (layer cap + swing entry cutoff + shared daily-loss budget)
  - [x] L8 — Regime / meta RE-LOCKED 2026-05-17 (trend_strong tier + 5-min sustain for swing + benign degradation handling)
- **2026-05-17 additions over 2026-05-16 baseline:**
  - 7-change architecture brainstorm (separate `docs/REFERENCE.md` consolidated into spec)
  - Audit pass → Batch 1 (mechanical drift) + Batch 2 (I9 ensemble fix) + Batch 3 (I7/I8/I14 real bugs) + Batch 4 (I10 per-head schema)
  - Swing layer added to v2 (was deferred to T7)
- **Audit findings closed:** all CRITICAL (C1-C5) + IMPORTANT (I1-I14) + DESIGN issues resolved. MINOR items folded into mechanical sweep.

### T3 — Trend-capture retrain (P1 blocker for paper trading)
Current Wave 2 model is a microstructure scalp predictor; v2 adds trend (10-30 min) + swing (30 min - 2 hr) layers. New target spec with noise floor in labels, new multi-TF features, retrain.

- **Status:** Design complete (V2_MASTER_SPEC LOCKED 2026-05-17). Phase 2 implementation ready to start.
- **Blocker:** Need ≥30 sessions of training data **under v2 schema** (per V2_MASTER_SPEC §3.1 Option A: existing ~10 sessions of 402-col parquets become inaccessible when v2 schema ships). Auto-recorder accumulates Mon-Fri → ~6 weeks of recording from schema cutover to first retrain. Reversible: raw .ndjson.gz files retained, can replay later if decision changes.
- **Phases (V2_MASTER_SPEC §6):**
  - [x] Phase 1: Design lock (V2_MASTER_SPEC LOCKED 2026-05-17 — all 8 layers)
  - [ ] Phase 2: TFA feature additions — IN PROGRESS
    - [x] Phase 2a/2b/2c — 22 feature modules + ~500 tests + schema bump to v7 (commits `50d9bec` → `aa36c34`)
    - [ ] Phase 2d — tick_processor wiring: VIX feed subscription, caller-side history buffers (VIX, PCR, OI, IV, spot, ATM delta, active strikes), per-instrument stateful trackers (Bar/Session/OpeningRange/PremiumVwap/Exhaustion/OiDominance), per-tick orchestration into `assemble_flat_vector()`, and end-to-end smoke replay validation. Without 2d, replay parquets carry the 69 new column NAMES but all NaN VALUES ← **NEXT UP**
  - [ ] Phase 3: Target additions (12 trend + 12 swing = 24 new targets, ~1.5 days code)
  - [ ] Phase 4: Auto-record accumulation (≥30 sessions, ~30 days passive)
  - [ ] Phase 5: Retrain all 4 with combined targets (84 heads each, ~5 hrs compute)
  - [ ] Phase 6: Trend gate + swing gate + 3-way combinator + smoke (~3-4 days code)
  - [ ] Phase 7: Paper trade ramp (ai-paper channel, weeks)
- **Empirical evidence the current model is scalp-only:** 9/9 nifty50 signals on 2026-04-30 / 2026-05-11 were 5-7 pt captures at day-extreme reversals; 85-pt sustained 10:50-11:20 uptrend on 2026-05-11 produced ZERO signals.

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

- **Status:** Deferred. Add to design backlog only.
- **Blocked by:** T3 (v2 intraday paper trade ramp). Reason: extending v2 with daily-bar targets/features now would dilute focus on the noise-floor/multi-TF label fix that's the actual critical path.
- **Why it's hard:** different time horizon (1–3 days vs intra-session), different features (daily OHLCV bars, FII/DII flows, sector rotation), different risk profile (overnight gap, higher margin, MCX physical settlement), different brokerage structure (delivery rates, STT-on-physical).
- **Approach when ready (Option B from 2026-05-16 brainstorm):** parallel pipeline — separate daily-bar TFA-equivalent, separate models, separate SEA loop, separate channel in BSA. Do NOT bolt 1d/2d/3d targets onto intraday v2.
- **Data required:** 6–12 months of daily OHLCV bars per instrument (different acquisition path than the tick recorder — NSE/MCX provide free daily history).
- **First doc to write when unblocked:** `docs/SWING_OVERNIGHT_SPEC.md`.

## INFRA — passive, no action needed

### T5 — Auto-recorder Mon-Fri 08:55 → midnight
BIOS RTC + Windows auto-login + scheduled tasks. Tested working 2026-05-16.

- **Status:** Live, autonomous.
- **What it does:** Each weekday 08:55 → 00:00, records ticks for all 4 instruments to `data/raw/<DATE>/`.
- **Manual override:** Run `Disable-ScheduledTask -TaskName 'ATS-Startup'` to pause.

## HOUSEKEEPING — small chores

### T6 — Locked `.claude/worktrees/angry-aryabhata-e93cfa` directory
Worktree directory survived removal because something has an open file handle. Disk space only — git no longer tracks it. Removable after closing the application holding the lock or after next reboot.

- **Status:** Deferred — harmless until next system reboot or manual cleanup.
- **How to clean later:** Either find + close the locking process (Resource Monitor → CPU → Associated Handles), or schedule deletion via `MoveFileEx` for next boot.

## Closed items (kept for one cycle as audit trail; delete on next pass)

_None yet._

---

## How to use this file

- **Adding a new TODO:** Append at the appropriate priority slot. Keep entries tight — what / status / blocker / link.
- **Marking done:** Move to "Closed items" section with a one-line outcome note. Next memory cleanup pass deletes the closed section.
- **Cross-references:** Use `docs/<FILE>.md` for design docs (they live in the repo, survive cleanly), not wikilinks to memory files (which can be deleted out from under).
