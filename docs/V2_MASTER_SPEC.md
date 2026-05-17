# V2 Master Spec — Signal System v2 (Single Source of Truth)

**Status:** LOCKED 2026-05-17 — all 8 layers locked (see §2.0 status table). Ready for T3 Phase 2 implementation. Re-opens permitted via §9 D-entry per §10 rules.
**Supersedes:** `SIGNAL_SYSTEM_V2.md`, `TARGET_SPEC_V2_DESIGN.md`, `REFERENCE.md`, `LAYER1_CANDIDATES.md` (delete pending)
**Companion (separate, kept):** `PROJECT_TODO.md` (T2/T3/T7 references this doc), `CLAUDE.md` (links updated), `PARTHA_RULES.md`, `DHAN_TOKEN_POLICY.md`, `JOURNEY_STRATEGY.md`, `WAVE2_RESUMPTION_GUIDE.md` (Wave 2 operational guide — referenced by §8.4 retirement policy)

## 0. Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Live Tick (Dhan WS)                                                    │
│  └─→ TFA (per instrument, 4 processes)                                  │
│      ├─ Tick buffers (5/10/20/50) + Bar buffers (1m/5m/15m) + Session   │
│      └─→ Emit row = L1 features (444 cols, see §2.1.1)                  │
│                       │                                                 │
│                       ├─→ data/features/<date>/<inst>_features.parquet  │
│                       │       │                                         │
│                       │       └─→ MTA (offline retrain Sat 02:00)       │
│                       │           ├─ L2 targets (72 heads/inst)         │
│                       │           ├─ L3 LightGBM training               │
│                       │           ├─ 5-fold walk-forward holdout        │
│                       │           ├─ Sim-PnL (§2.3.4) decision threshold│
│                       │           └─→ models/<inst>/<ts>/<head>.lgbm    │
│                       │                + LATEST_HEADS.json (per-head)   │
│                       │                                                 │
│                       └─→ data/features/<inst>_live.ndjson (live)       │
│                               │                                         │
│                               └─→ SEA (per-tick inference)              │
│                                   ├─ Load each head per LATEST_HEADS    │
│                                   ├─ L4 gate (cost-floor, position-veto)│
│                                   │   reads L8 regime tag               │
│                                   ├─ Emit signal → logs/signals/        │
│                                   ├─ L5 trade mgmt (TP/SL/trail/time/   │
│                                   │   OI exits/exhaustion/regime-flip)  │
│                                   ├─ L6 sizing (vol-scaled)             │
│                                   └─→ TEA → BSA → Dhan order            │
│                                                  │                      │
│                                                  └─→ PA (positions, P&L)│
│                                                                         │
│  ┌─ Cross-cutting safety / observability ──────────────────────────┐    │
│  │  L7 risk-control: daily-loss / max-pos / blackout / event-day   │    │
│  │  Pre-market sanity check (§5.2, Mon 08:50)                      │    │
│  │  Drift detection (§5.3, daily 20:00, per-head AUC)              │    │
│  │  Trade-quality scorecard (§5.1, weekly Sun)                     │    │
│  │  SHAP per signal (§5.4) + Trade journal                         │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

**Data flow:** L1 features → L2 targets → L3 models → L4 gate (incorporating L8 regime + L7 risk + Charges/cost-floor) → L5 exits + L6 sizing → execution.

**Cross-cutting layers (5.x):** independent monitors that don't affect signal flow but gate deployment + catch silent failures.

---

## 1. Why v2 — locked constraints + 7 changes rationale

### 1.1 Why this exists

The Wave 2 model (targets at 60–300s, magnitude ~5–9 INR) is verified to be a microstructure scalp predictor. Empirical evidence 2026-05-15:
- 9/9 scalp signals on 2026-04-30 / 2026-05-11 were directionally correct
- BUT 5–7 pt captures are within nifty50's normal noise (8–15 pt wicks per minute)
- The 85-pt sustained move 10:50–11:20 on 2026-05-11 produced ZERO signals
- 180s gate variant achieved 40–55% win rate — statistical noise, no real edge

**User mandate:** trades must live MINUTES with TP/SL above the noise floor (>20 pts).

### 1.2 Locked constraints (do not re-litigate)

- Trades must live MINUTES (>5 min hold).
- Noise floor for nifty50 ≈ 8 pts; TP ≥25 pts, SL ≥15 pts.
- Real trends visible only at 10–30 min horizons.
- LightGBM stays — no transformer/LSTM pivot this iteration.
- Wave 2 scalp model stays as a **backup** signal layer (do not delete).
- Holdout-protected validation, ≥30 sessions before retrain.
- Swing-trade capability (1–3 day hold) is deferred to T7 in PROJECT_TODO — DO NOT bolt onto v2.

### 1.3 Success criteria for v2 model

| Criterion | Target |
|---|---|
| Trend signals per instrument per session | 2–5 |
| Hold time | 5–25 minutes |
| Predicted magnitude | ≥25 INR points (above noise) |
| Win rate | ≥55% across 100+ trades on out-of-sample data |
| Per-trade expectancy (after slippage) | ≥+8 INR points |
| Holdout validation | ≥4 weeks of unseen sessions |

### 1.4 The 7 changes — mechanism + expected impact

| # | Change | Mechanism | Expected impact |
|---|---|---|---|
| 1 | Longer target horizons (10/15/30 min vs 60/300s) | Model predicts where price will be in 15 min, not 60s. Better S/N at minute-scale than tick-scale. | Direction AUC 0.57 → 0.60–0.65. Win rate 50% → 55–60%. |
| 2 | Noise floor in labels (≥8 pts = "1") | Current labels treat +0.5 pt and +50 pt the same. Adding floor separates economically meaningful moves from drift. | **Single biggest change.** Predictions move from clustered-near-0.5 (uninformative) to a meaningful distribution. |
| 3 | Multi-TF context features (~15+ new inputs) | Model sees 1m/5m/15m chart structure (MAs, ADX, VWAP dist) — what a chart-watching trader sees. | +5–15 percentage points to AUC of long-horizon targets. Probably second-biggest after labels. |
| 4 | `scale_pos_weight` in LightGBM | With 5% positive class and default weights, model predicts near 5% for everything. `scale_pos_weight = n_neg/n_pos` pushes top predictions into actionable range. | Doesn't change AUC much, but makes predictions **usable** for fixed-threshold gates (0.054 → 0.42 same input). |
| 5 | More training data (≥30 sessions) | 9 sessions × 25k rows = 225k → 30 sessions × 25k = 750k. ~3.3× more. | +5–10 percentage points to AUC just from sufficient positive examples. Critical for Change 2. |
| 6 | Walk-forward holdout (5 × 1-week rolling holdouts) + concrete Sim-PnL formula | Single-window holdout (last-5-days) gives biased verdict if those days happen to be expiry/news/dull week. 5 independent holdouts across dataset → mean verdict + worst-fold flag. Sim-PnL = replay-simulated open-to-close per signal with bid/ask slippage and Charges_Spec costs (see §2.3.4 for formula). | Doesn't improve the model — improves our verdict reliability. 5× retrain compute per validation cycle (~20 hours). Conservative-by-design (~10–15%) so we under-promise vs live. |
| 7 | New trend gate + ensemble | `decide_action_trend` runs alongside `decide_action_wave2`. Trend gate catches 10:50–11:20 type moves; scalp gate keeps the 9/9 day-extreme captures. | Trade frequency 2–3 → 5–10/day per instrument. Per-trade capture 5 → 15–30 pts. |

### 1.5 Honest probability of hitting target outcomes

| Outcome | Probability |
|---|---|
| New system reaches "barely profitable after costs" (Changes 2+3+5 work) | **70%** |
| Hits the daily PnL targets in §1.6 table (all 7 changes working) | **40%** |
| Failure to learn (data too thin, labels too rare, regime too unstable) | **15%** |

### 1.6 Combined expected change in signal strength

| Metric | Today (Wave 2 scalp) | After all changes (realistic) |
|---|---|---|
| Direction AUC at 15-min | N/A (no target) | 0.60–0.65 |
| Top-1% prediction value | 0.0028 (collapsed) | 0.40–0.60 (usable) |
| Win rate on trend signals | N/A | 55–60% |
| Trade frequency / instrument / day | 2–3 (scalp only) | 5–10 (scalp + trend) |
| Per-trade target capture | ~5 pts | 15–30 pts |
| Per-trade expectancy after slippage | ~+2 pts (marginal) | +6 to +12 pts |
| Daily expected PnL per instrument | ~+5 to +15 pts | +30 to +80 pts |

### 1.7 What v2 explicitly does NOT do

- Does NOT drop Wave 2 scalp — kept as backup layer.
- Does NOT change LightGBM choice.
- Does NOT introduce ML position sizing (Kelly etc.) in v1.
- Does NOT introduce ML regime classification in v1 — rules first.
- Does NOT commit to swing trades — see T7 in PROJECT_TODO.

---

## 2. The 8 layers

### 2.0 Status table

| # | Layer | Status | Source section |
|---|---|---|---|
| 1 | Input features | **RE-LOCKED 2026-05-17 by Partha** — B5 added (8 features), all sub-decisions D51/D52/D48b-d resolved; 444 active features | §2.1 |
| 2 | Target labels | **LOCKED 2026-05-16 by Partha** (12 trend targets locked; 600s dropped per L1 D6) | §2.2 |
| 3 | Model architecture | **LOCKED 2026-05-16 by Partha** (all 4 L3 decisions resolved: booster topology, hyperparameters, early stopping, per-instrument training) | §2.3 |
| 4 | Gate logic | **LOCKED 2026-05-16 by Partha** (6 decisions resolved; L1+L2 now locked, dependency satisfied) | §2.4 |
| 5 | Trade management | **LOCKED 2026-05-16 by Partha** (4 decisions: 2-tier trail, TP/SL lock at entry, 2-stop-out lockout, market fills) | §2.5 |
| 6 | Position sizing | **LOCKED 2026-05-16 by Partha** (5 decisions: hybrid risk budget, equal sizing v1, portfolio cap 2.5×, uniform formula, naturalgas lot=1250) | §2.6 |
| 7 | Risk controls | **LOCKED 2026-05-16 by Partha** (6 decisions: hooks, reset cadence, rolling DD, paper/live toggle, expiry handling, per-instrument numbers) | §2.7 |
| 8 | Regime / meta | **LOCKED 2026-05-16 by Partha** (4 decisions: thresholds, time-of-day via L1 features, look-ahead test, learned classifier deferred) | §2.8 |

Suggested deep-dive order: **4 → 5 → 7 → 6 → 8 → revisit 1–3.** Rationale: L4 unblocks paper-trade gate; L5 defines TP/SL semantics L4 depends on; L7 (risk caps) must exist before any live capital; L6 (sizing) needs L7 caps; L8 (regime) is enhancement on working baseline; L1–L3 only revisit if L4–L8 surface a gap.

---

### 2.1 Layer 1 — Input features (IN-PROGRESS)

**Goal:** lock the input feature set to be emitted by TFA per tick. Currently the v2 plan extends the existing 377-column live schema with multi-TF context + brainstorm additions, capped by feature-importance pruning post-retrain.

#### 2.1.1 Totals at a glance

| Bucket | Count |
|---|---|
| A. Live in parquet today | **377** |
| B. v2-plan multi-TF + S/R additions | **23** (15 original ACCEPT + **8 B5 added 2026-05-17 per §9 D48**) |
| C. Brainstorm additions | **52** candidates → **44 ACCEPT, 8 DEFER → T14** (L1 D2 reviewed 2026-05-16) |
| **Active L1 feature count post-lock** | **444** (= 377 + 23 + 44) |
| Realistic post-L1-lock + LightGBM regularization | ~444 (Gap #24 D = no manual prune; trust regularization) |

#### 2.1.2 A — Live in parquet today (377 input features)

Source: `python_modules/tick_feature_agent/output/emitter.py` `_build_column_names()`. Order matches parquet column order.

| Block | Count | Features |
|---|---|---|
| A0 Timestamp | 1 | `timestamp` |
| A1 Underlying base | 12 | `underlying_ltp/bid/ask/spread/return_5ticks/return_20ticks/momentum/velocity/tick_up_count_20/tick_down_count_20/tick_flat_count_20/tick_imbalance_20` |
| A2 Underlying extended | 20 | `underlying_trade_direction`, `underlying_ofi_{5,20,50}`, `underlying_realized_vol_{5,20,50}`, `underlying_return_{10,50}ticks`, `underlying_tick_{up,down,flat}_count_{10,50}`, `underlying_tick_imbalance_{10,50}`, `underlying_horizon_{momentum,vol,ofi}_ratio` |
| A3 ATM context | 3 | `spot_price`, `atm_strike`, `strike_step` |
| A4 Compression & breakout | 5 | `range_20ticks`, `range_percent_20ticks`, `volatility_compression`, `spread_tightening_atm`, `breakout_readiness` |
| A5 Time-to-move | 4 | `time_since_last_big_move`, `stagnation_duration_sec`, `momentum_persistence_ticks`, `breakout_readiness_extended` |
| A6 Option tick (7 offsets × 2 sides × 9 fields) | 126 | `opt_{m3,m2,m1,0,p1,p2,p3}_{ce,pe}_{tick_available,ltp,bid,ask,spread,volume,bid_ask_imbalance,premium_momentum,premium_momentum_10}` |
| A7 Option chain | 9 | `chain_pcr_{global,atm}`, `chain_oi_total_{call,put}`, `chain_oi_change_{call,put,call_atm,put_atm}`, `chain_oi_imbalance_atm` |
| A8 Active strikes (6 slots × 24 fields) | 144 | `active_{0..5}_{strike,distance_from_spot,tick_available,call_strength_{volume,oi},call_strength,call_{ltp,bid,ask,spread,volume,bid_ask_imbalance,premium_momentum},put_strength_{volume,oi},put_strength,put_{ltp,bid,ask,spread,volume,bid_ask_imbalance,premium_momentum},tick_age_sec}` |
| A9 Cross-feature intelligence | 4 | `call_put_strength_diff`, `call_put_volume_diff`, `call_put_oi_diff`, `premium_divergence` |
| A10 Decay & dead market | 5 | `total_premium_decay_atm`, `momentum_decay_20ticks_atm`, `volume_drought_atm`, `active_strike_count`, `dead_market_score` |
| A11 Regime classification | 2 | `regime`, `regime_confidence` |
| A12 Zone aggregation | 7 | `atm_zone_{call,put,net}_pressure`, `active_zone_{call,put}_count`, `active_zone_dominance`, `zone_activity_score` |
| A13 Trading state | 4 | `trading_state`, `trading_allowed`, `warm_up_remaining_sec`, `stale_reason` |
| A14 Metadata | 9 | `exchange`, `instrument`, `underlying_symbol`, `underlying_security_id`, `chain_timestamp`, `time_since_chain_sec`, `chain_available`, `data_quality_flag`, `is_market_open` |
| A15 Wave 1 Levels (S/R) | 8 | `distance_to_day_{high,low}_pct`, `distance_to_prev_close_pct`, `day_range_position`, `max_{call,put}_oi_strike`, `distance_to_max_{call,put}_oi_strike_pct` |
| A16 Wave 1 Greeks | 9 | `atm_{ce,pe}_iv`, `iv_skew_atm`, `atm_{ce,pe}_delta`, `atm_gamma`, `atm_{ce,pe}_theta`, `atm_vega` |
| A17 Wave 1 Expiry | 5 | `days_to_expiry`, `hours_to_expiry`, `is_expiry_day`, `is_monthly_expiry`, `session_remaining_pct` |

**A subtotal: 377**

#### 2.1.3 B — v2-plan multi-TF additions (15, candidate)

| Block | Count | Features |
|---|---|---|
| B1 MA structure | 5 | `ma_5_1min`, `ma_20_1min`, `ma_5_5min`, `ma_20_5min`, `ma_5_15min` — each as `(spot − ma) / spot` ratio |
| B2 Trend strength | 3 | `adx_5min` (14-period ADX on 5-min candles), `momentum_5min` (close_now / close_5min_ago), `momentum_15min` |
| B3 Higher-timeframe structure | 4 | `dist_from_session_open_pct`, `dist_from_session_vwap_pct`, `session_high_age_min`, `session_low_age_min` |
| B4 Multi-bar pattern | 3 | `consecutive_higher_highs_5min`, `consecutive_higher_lows_5min`, `range_compression_ratio` |
| B5 Additional S/R levels (added 2026-05-17 per §9 D48) | 8 | `distance_to_prev_day_{high,low}_pct`, `distance_to_opening_range_{high,low}_pct`, `distance_to_round_number_{above,below}_pct`, `distance_to_5d_swing_{high,low}_pct` |

#### 2.1.4 C — Brainstorm additions (48, candidates)

All tagged ACCEPT / DEFER per L1 D2 review 2026-05-16. 44 accept, 8 defer (→ PROJECT_TODO T14).

| Group | Cnt | Status | Accepted features | Deferred features |
|---|---|---|---|---|
| C1 OI / S/R dynamics | 10 | **10 ACCEPT** | all 10: `oi_weighted_{ce_resistance,pe_support}_strike`, `{ce,pe}_wall_strength_rel`, `{ce,pe}_oi_change_{5,15}min_pct`, `oi_dominance_streak_min`, `pcr_intraday_slope_30min` | — |
| C2 Classic technical | 8 | **5 ACCEPT, 3 DEFER** | `rsi_14_5min`, `macd_5min`, `macd_signal_5min`, `macd_histogram_5min`, `volume_price_divergence_5min` | `rsi_14_15min` (redundant with 5min), `ma_cross_event_5min` (LightGBM composes from MAs), `breakout_event_5min` (LightGBM composes from distance) |
| C3 India VIX | 2 | **2 ACCEPT** | `india_vix`, `india_vix_change_5min` (Dhan subscription confirmed by user 2026-05-16) | — |
| C4 Dealer hedging / GEX | 5 | **5 ACCEPT** | all 5: `net_gex`, `gamma_flip_distance_pct`, `dealer_net_delta`, `charm_estimate_atm`, `vanna_estimate_atm` | — |
| C5 Exhaustion / trend age | 4 | **2 ACCEPT, 2 DEFER** | `trend_age_ticks`, `volume_no_move_score` | `momentum_deceleration` (LightGBM composes from existing momentum heads), `premium_acceleration_drop` (pure subtraction of existing features) |
| C6 Intraday time | 3 | **3 ACCEPT** | all 3: `minutes_from_open`, `minutes_to_close`, `lunch_session_flag` | — |
| C7 Strike migration | 5 | **3 ACCEPT, 2 DEFER** | `active_strike_shift_direction`, `active_strike_shift_velocity`, `atm_to_otm_flow_ratio` | `active_strike_rotation_score` (correlates with shift_velocity), `strike_migration_persistence` (LightGBM composes from time-series) |
| C8 Premium VWAP | 4 | **3 ACCEPT, 1 DEFER** | `atm_ce_premium_vwap_dist`, `atm_pe_premium_vwap_dist`, `premium_vwap_reclaim_count` | `premium_vwap_cross_strength` (derivable from dist × premium_momentum) |
| C9 IV velocity | 4 | **4 ACCEPT** | all 4: `iv_change_1min`, `iv_change_5min`, `iv_skew_velocity`, `iv_expansion_without_spot` | — |
| C10 Max Pain | 3 | **3 ACCEPT** | all 3: `max_pain_strike`, `distance_to_max_pain_pct`, `max_pain_gravity_strength` (conditional via L4 D5 `days_to_expiry_bucket`) | — |
| C11 Event calendar | 3 | **3 ACCEPT** | all 3: `is_tier_2_event_day`, `event_type_categorical`, `hours_to_next_tier_1_or_2_event` (locked Sugg #12) | — |
| C12 Expiry-bucket | 1 | **1 ACCEPT** | `days_to_expiry_bucket` (locked L4 D5) | — |

**C subtotal: 52 total, 44 ACCEPT, 8 DEFER → T14**

#### 2.1.5 D — Explicitly skipped (do not implement)

| Item | Reason |
|---|---|
| Liquidity-vacuum depth features (`bid_depth_near_price`, etc.) | Dhan top-of-book only; no L2 depth |
| Multi-TF alignment block in `missing_layers_entry_exit.md` §6 | Duplicate of B |
| Relative-strength-vs-history features | Storage + lookup latency on TFA hot path; defer until v2 proves out |
| `wick_rejection_strength` | Needs candle aggregation; TFA is tick-level |
| `post_news_cooldown`, `opening_drive_strength` | Event-calendar dependent; defer to L7 |
| Fundamentals (earnings, guidance) | Irrelevant for intraday index/MCX |
| RBI / macro release blackouts | Belongs in L7 risk controls, not L1 features |
| Sub-second wall-clock buffers (1s/3s/5s) | We use tick-paced (information-paced) for micro layer |
| 2-min / 3-min bars | Redundant with 1-min and 5-min |
| Cross-instrument correlation features | Architectural change (inter-process channel); defer until v2 proves |
| Sequence models / transformers / state-space | Violates locked constraint (LightGBM stays) |
| 50/200-day MAs, fundamentals, macro signals | Swing/positional indicators, not 5–25 min trades |
| Max Pain outside last 2 days to expiry | Noise most days — conditionally weighted only when `days_to_expiry ≤ 2` |

#### 2.1.6 Horizon set (12 distinct windows)

| Layer | Horizons |
|---|---|
| Micro (tick-paced) | 5, 10, 20, 50 ticks |
| Scalp targets | 30s, 60s |
| Mid-scalp target | 300s |
| Bars (chart-aligned) | 1m, 5m, 15m |
| Trend targets | 900s, 1800s (drop 600s — between scalp and trend, redundant) |
| Slow positioning | 30-min PCR slope |
| Session | Whole day (VWAP, high/low age) |

#### 2.1.7 Decisions still required for L1 lock

1. Noise-floor per instrument: **LOCKED 2026-05-16** — nifty50=8, banknifty=25, crudeoil=5, naturalgas=3 (all in §7).
2. Accept / defer / reject each of 52 brainstorm candidates: **LOCKED 2026-05-16** — 44 ACCEPT, 8 DEFER → PROJECT_TODO T14. See §2.1.4.
3. Confirm B-block 23 features (15 original + 8 B5 added 2026-05-17): **LOCKED 2026-05-17.**
4. **Scaling convention (LOCKED 2026-05-16 — L1 D4 Option F):** LightGBM is tree-based; no global normalization helps. Apply targeted transforms only where they help split quality:
   - **Price-based** (MAs, VWAP dist, day_high/low dist, distance_to_max_pain_pct): `(spot − feature) / spot × 100` (percent)
   - **Counts** (volume, OI absolute values, oi_dominance_streak_min, chain_oi_total_*): `log1p(value)` — fixes long-tail bias in tree splits
   - **Ratios** (PCR, IV ratios, momentum ratios, horizon_*_ratio): raw
   - **Bounded indicators** (RSI [0,100], ADX [0,100], capture_ratio): raw
   - **Categoricals** (`event_type_categorical`, `days_to_expiry_bucket`, `regime`, `is_expiry_day`, `lunch_session_flag`, all booleans): declared via LightGBM `categorical_feature` parameter at train time
   - **Missing data**: emitter writes NaN; MTA must NOT impute. LightGBM uses NaN as a separate "missing" branch signal.

   Cost: trivial (one `log1p` call per affected feature; one training-time param for categoricals).
5. ~~Replay backfill: re-replay all 10 sessions to populate new columns~~ → **RESOLVED §3.1 (Option A: ignore old parquets, accumulate fresh)**
6. **Feature-importance pruning policy (LOCKED 2026-05-16 — Gap #24 Option D):** **NO pre-prune, NO post-train re-train.** Single training pass on all 443 features. Trust LightGBM regularization (`max_depth`, `min_child_samples`, `lambda_l1`, `lambda_l2`) to ignore junk features. Rationale: clean slate (no old models to derive pre-prune scores from); two-stage approach (A) would double compute cost for marginal gain. Risk accepted: at 443 features × ~30 sessions of data, regularization is the only defense against overfit — must tune LightGBM hyperparameters aggressively (`min_child_samples ≥ 50`, `lambda_l2 ≥ 1.0`). Post-paper-trade if model overfits, revisit per D34.
7. **Per-instrument config layout (LOCKED 2026-05-16 — L1 D5 Option B):** split by reading agent:
   - `config/instrument_profiles/<inst>_profile.json` — TFA reads (broker_id, security_ids, lot_size, exchange, target_windows_sec)
   - `config/sea_thresholds/<inst>.json` — SEA reads (θ_dir, dwell_time_ticks per gate, cost_floor_buffer_pct, slippage_pct_per_strike_distance, gate_mode, sl_safety_multiplier)
   - **`config/risk_limits/<inst>.json`** (NEW) — DA reads (daily_loss_limit, max_signals_per_day, max_concurrent_positions, blackout_windows, n_consecutive_loser_pause_threshold)
   - `config/model_feature_config/<inst>_feature_config.json` — MTA + SEA read (locked feature column list, schema_version)

   Rationale: each config file owned by exactly one agent. No cross-agent ownership = no drift, easy per-agent audit.
8. **600s (10-min) trend target (LOCKED 2026-05-16 — L1 D6 Option B):** DROPPED. Keep only `{900s, 1800s}` for trend horizons. Rationale: 600s sits between 300s scalp and 900s trend with no distinct trade profile; LightGBM can interpolate from neighbors. Saves 33% trend-retrain compute (12 trend heads instead of 18).

9. **B5 sub-decisions (LOCKED 2026-05-17 by Partha):**
   a. **Opening range window length:** **N = 15 minutes** (NSE-traditional first quarter-hour). One value across all instruments. Resolves D51.
   b. **Round number step per instrument:** nifty50 = **100 pts**, banknifty = **100 pts**, crudeoil = **5 INR**, naturalgas = **1 INR**. Coarser steps preferred (fewer near-round-number false positives; reduces noise on minor strike-tick boundaries). Resolves D52.
   c. **5-day swing lookback:** **simple max/min** of 5 prior session highs/lows. Faster + deterministic; revisit pivot-based per §9 D48 follow-up only if model SHAP shows the feature under-used.
   d. **State storage:** opening range computed live from session ticks (no prior-day dependency). 5-day swing state persisted to **`data/state/<inst>_levels.json`** at every session close; TFA reads on session start. Resolves restart-safety question.

#### 2.1.8 Compute / latency / storage cost

| Resource | Impact |
|---|---|
| Per-row storage (parquet) | +20% vs today (377 → 444 input cols + 12 trend targets) |
| TFA hot-path latency | Profile after each feature group; if > 50ms/tick, defer |
| Replay backfill (one-time) | **NOT APPLICABLE** per §3.1 (Option A: throw away old parquets, accumulate 30 sessions under new schema). Raw .ndjson.gz retained for reversibility |
| Bar buffers TFA maintains | 4 tick buffers + 3 bar buffers (1m/5m/15m) + 1 session buffer = 8 buffer types |

---

### 2.2 Layer 2 — Target labels (LOCKED-CANDIDATE)

**v2 direction:** keep existing 60 Wave-2 heads (60/300s scalp). Add **12 trend targets = 6 types × 2 horizons** {900s, 1800s} (600s dropped per L1 D6). Critical: directions labeled positive only when `|Δspot| ≥ noise_floor`.

#### 2.2.1 Trend horizons

| Window | Use case |
|---|---|
| ~~600s (10 min)~~ | **DROPPED** (L1 D6 lock 2026-05-16 — redundant between 300s scalp and 900s trend) |
| 900s (15 min) | Standard trend trade |
| 1800s (30 min) | Sustained-trend trade (rare, high conviction) |

#### 2.2.2 Six target types per window

| Target name | Type | Definition |
|---|---|---|
| `trend_direction_{w}s` | binary | 1 if `spot(t+w) > spot(t) + noise_floor`, else 0 |
| `trend_magnitude_{w}s` | regression | `spot(t+w) − spot(t)` (signed) |
| `trend_max_excursion_{w}s` | regression | `max(spot(t..t+w)) − spot(t)` |
| `trend_max_drawdown_{w}s` | regression | `spot(t) − min(spot(t..t+w))` |
| `trend_continues_{w}s` | binary | 1 if direction at `t+w` matches dominant direction of `[t-300s, t]` AND magnitude ≥ noise floor |
| `trend_breakout_imminent_{w}s` | binary | 1 if max excursion in `[t, t+w]` ≥ 25 pts |

**Total new target columns: 6 × 2 = 12** (L1 D6 dropped 600s horizon; only `{900s, 1800s}` retained).

#### 2.2.3 Why the noise floor in labels

Current `direction_60s` labels any positive move as "1." A +2 pt and a +50 pt move both train as "up" → model predicts near base rate. Adding `noise_floor=8 pts` (per instrument) labels only **economically significant** moves. Model learns "real move vs nothing" instead of "drift up vs drift down."

#### 2.2.4 Open items — all resolved

- Per-instrument noise-floor calibration → **RESOLVED 2026-05-16** — all 4 in §7 (nifty/banknifty/crude/natgas = 8/25/5/3)
- Whether to add 60-min horizon if 30-min trends look promising → **DEFERRED post-paper-trade** — revisit only if §5.1 trade-quality report shows trends sustaining beyond 30-min cap. No D-entry until paper data exists
- Whether to drop 600s (10-min) horizon → **RESOLVED 2026-05-16 L1 D6 Option B** — DROPPED. See §2.1.7 item 8

---

### 2.3 Layer 3 — Model architecture (LOCKED-CANDIDATE)

**v2 direction:** keep LightGBM. Add `scale_pos_weight = n_neg / n_pos` per target. Validation metric becomes `val_auc + simulated-PnL on holdout after fees`. Holdout grows from `last_n=1` to `last_n=5` (full week reserved).

#### 2.3.1 Training methodology changes

| Item | Wave 2 (current) | v2 (proposed) |
|---|---|---|
| LightGBM `scale_pos_weight` | not set (defaults to 1.0) | Set per target = `n_neg / n_pos` of training set |
| Cost-aware scoring | none | Post-hoc: simulate slippage 1–2 pts per fill in training metric report |
| Min training data | 9 sessions | ≥30 sessions (block retrain until reached) |
| Holdout strategy | `last_n_per_instrument, n=1` | **Walk-forward: 5 × 1-week rolling holdouts** spread across dataset (LOCKED 2026-05-16 — Sugg #5 Option B). Verdict = mean sim_pnl across 5 folds; worst-fold flagged separately. |
| Validation metric | `val_auc` only | `val_auc + simulated-PnL` on holdout (after fees) |

#### 2.3.2 Model heads

- Scalping model: 60 heads per instrument (unchanged)
- Trend model: 12 new heads per instrument (after L1 D6 dropped 600s horizon — was 18)
- **Total: 72 heads × 4 instruments = 288 LightGBM models** (was 312)

**Per-head version registry (LOCKED 2026-05-16 — Gap #10 Option B):** Replace single-file `models/<inst>/LATEST` (current text pointer to one timestamp) with `models/<inst>/LATEST_HEADS.json` (72 entries per instrument after L1 D6):

```json
{
  "trend_direction_900s": "20260516_020000",
  "trend_magnitude_900s": "20260509_020000",
  "direction_60s": "20260502_020000",
  "...": "..."
}
```

SEA loads each head independently per the map. Saturday retrain (§6.1) compares per-head sim_pnl; only updates `LATEST_HEADS.json` entries for heads that beat current. Rollback = restore any prior `LATEST_HEADS.json` from `models/<inst>/HEADS_HISTORY/<date>.json` (auto-archived on every change).

**Why B over A:** Indian markets shift one instrument at a time (e.g., OPEC change hits crude only; RBI hits indices). Per-head rollback preserves 77 good improvements when fixing 1 regression. Critical for high-iteration retrain cadence (§6.1).

**Upgrade path:** audit-trail (Option C) deferred — see D30.

**Model file naming (LOCKED 2026-05-16 — Gap #23 Option D):** flat structure under `models/<inst>/<timestamp>/`. Wave 2 heads use existing names (`direction_60s.lgbm`, `max_upside_30s.lgbm`, etc.). v2 trend heads use `trend_` prefix (`trend_direction_900s.lgbm`, `trend_magnitude_1800s.lgbm`, etc.). No subfolder split — distinction lives in the filename, routing handled by `LATEST_HEADS.json`. Also written per timestamp dir: `baseline_auc.json` (drift detector input). Archived Wave 2 heads on retirement (§8.4) move to `models/<inst>/ARCHIVED/wave2_<date>/`.

#### 2.3.3 Architecture decisions

**Booster topology (LOCKED 2026-05-16 — L3 D1 Option A):** 72 separate LightGBM boosters per instrument (288 total × 4 instruments). Multi-output booster rejected because it breaks per-head rollback (Gap #10) and per-head regression-block (Gap #7), and forces a single `scale_pos_weight` across heads with very different positive rates.

LightGBM at 500-feature scale: trivial (~1.5 GB train memory, sub-ms inference) — no concern.

**Hyperparameter defaults (LOCKED 2026-05-16 — L3 D2 Option D):** conservative pre-set split by head type. Library defaults rejected (overfit risk at 444 features × ~30 sessions). Hyperparameter search rejected (20-50× retrain compute for marginal gain that may not survive walk-forward variance).

```
binary heads (direction, persists, breakout, exit_signal, trend_direction_*,
              trend_continues_*, trend_breakout_imminent_*):
  objective:          binary
  num_leaves:         15
  max_depth:          5
  min_child_samples:  50
  learning_rate:      0.05
  n_estimators:       500
  early_stopping_rounds: 50
  lambda_l1:          0.1
  lambda_l2:          1.0
  feature_fraction:   0.7
  bagging_fraction:   0.8
  scale_pos_weight:   per-target (n_neg / n_pos)  # critical for class imbalance

regression heads (max_upside, max_drawdown, magnitude, decay, RR,
                  trend_magnitude_*, trend_max_excursion_*, trend_max_drawdown_*):
  objective:          regression
  num_leaves:         31
  max_depth:          6
  min_child_samples:  30
  learning_rate:      0.03
  n_estimators:       800
  early_stopping_rounds: 50
  lambda_l1:          0.1
  lambda_l2:          1.0
  feature_fraction:   0.7
  bagging_fraction:   0.8
```

Stored in `config/mta_hyperparams.json` (single file, applies to all instruments by head-type). Per-instrument override allowed but discouraged — calibrate per-instrument only if walk-forward shows systematic overfitting on one instrument. Add to D41 for post-paper-trade tuning.

**Early stopping (LOCKED 2026-05-16 — L3 D3 Option C):** two-stage validation.
- **Stage 1 (during tree building):** library-default cheap metric for early_stopping_rounds=50. AUC for binary heads, RMSE for regression heads. Selects "best tree count" per LightGBM convention.
- **Stage 2 (final model selection):** sim_pnl (§2.3.4) across 5 walk-forward folds. Decides go/no-go for paper-trade promotion.

Rationale: sim_pnl inside early-stopping inner loop is impractical (5-10× training time). AUC/RMSE is a cheap, well-calibrated proxy for ranking quality during tree building; sim_pnl gates the final decision after training completes.

**Training granularity (LOCKED 2026-05-16 — L3 D4 Option A):** per-instrument independent training (288 models total = 72 heads × 4 instruments). NO cross-instrument or per-asset-class sharing.

Rationale: NSE indices (NIFTY, BANKNIFTY) and MCX commodities (CRUDEOIL, NATURALGAS) have fundamentally different microstructure — different strike grids, liquidity profiles, volatility regimes, tick rates. A shared model would average over these and underperform per-instrument on each. 4× compute cost (offline Sat retrain) is acceptable trade for specialization.

**All L3 open items resolved. §2.3 status promoted LOCKED-CANDIDATE → LOCKED 2026-05-16 by Partha.**

#### 2.3.4 Sim-PnL formula (LOCKED 2026-05-16 — Option C)

The single number that decides "is the new model better than the old one." Implemented in `model_training_agent/validation/sim_pnl.py` (to be created).

**Definition:** For each fired signal in the holdout window, replay-simulate entry and exit using actual recorded tick data with bid/ask slippage, subtract Charges_Spec costs.

```
sim_pnl_per_signal =
    realized_exit_price - realized_entry_price - charges_total

where:
    realized_entry_price =
        bid_at_signal_tick      if action = LONG_CE  (we buy CE at ask, but score against bid for round-trip)
        ask_at_signal_tick      if action = LONG_PE
        (mirror for SHORT)

    Actually: we BUY at ask, SELL at bid, so:
    For LONG (buy now, sell later):
        entry = ask_at_signal_tick
        exit  = bid_at_exit_tick
    For SHORT (sell now, buy back later):
        entry = bid_at_signal_tick
        exit  = ask_at_exit_tick

    exit_tick = first of {TP hit, SL hit, time-stop hit} based on actual realized spot/option path
    charges_total = Charges_Spec.compute_total_cost(instrument, strike, side, qty)

    + Additional slippage penalty (LOCKED 2026-05-16 — Option B):
      strike_distance = abs(traded_strike - atm_strike) / strike_step
      extra_slippage = strike_distance × slippage_pct_per_strike_distance × premium
      → subtract from sim_pnl_per_signal on top of bid/ask
      → defaults: nifty50=0.3%, banknifty=0.5%, crudeoil=1.0%, naturalgas=1.5% (see §7)

sim_pnl_total = Σ(sim_pnl_per_signal across all signals in holdout)
```

**Worked example** (NIFTY long CE 24300 strike, predicted TP=30 pts on spot, predicted SL=15 pts):
- Signal fires at t=0; spot=24280, ATM CE 24300 bid=185, ask=187
- Entry price = 187 (we pay the ask)
- Replay actual ticks: spot reaches 24310 at t=8min → exits at TP
- Exit tick: ATM CE 24300 bid=212, ask=214
- Exit price = 212 (we sell at the bid)
- Gross PnL = 212 − 187 = 25 pts × 75 lot = ₹1875
- Charges (Charges_Spec): ₹125 (brokerage + STT + GST + exchange + SEBI)
- sim_pnl_per_signal = ₹1750

**Properties:**
- Deterministic — same holdout, same model, same number every time.
- Conservative — assumes worst-case fill (ask on buy, bid on sell) every time.
- Uses real recorded tick data — no synthetic prices.
- Live trades may beat this metric (sometimes get inside-spread fills) — that's the desired safety margin.

**Decision threshold (walk-forward, Sugg #5 Option B):** model promoted to paper trade if **mean across 5 walk-forward holdouts** satisfies `sim_pnl_total ≥ wave2_baseline_sim_pnl × 1.20` AND per-trade expectancy ≥ +8 pts (per §1.3). Worst-fold sim_pnl reported separately as a sanity check; if worst-fold < 0, escalate before promotion.

**Walk-forward setup:** 5 holdout windows, each 1 trading week (5 sessions), spaced evenly across the dataset. Training set for fold N = all sessions except that week's holdout. Total compute per validation cycle: 72 heads × 4 instruments × 5 folds = **1440 LightGBM trainings** (~18 hours after L1 D6 dropped 600s).

**Upgrade path:** Migrate to Option D (multi-scenario best/expected/worst) once paper trading produces real fill data — see PROJECT_TODO T9.

---

### 2.4 Layer 4 — Gate logic (SKETCH)

**What it is:** per-tick decision function in SEA that converts the 12 trend-head predictions into "emit a trade signal now / don't" — with TP/SL.

**v2 sketch:** AND-gate `decide_action_trend(predictions, regime)` emits only when **all** of:
- `trend_direction_900s` prob ≥ θ_dir (per-instrument)
- `trend_magnitude_900s` ≥ 25 pts
- `trend_max_drawdown_900s` ≤ 15 pts (predicted SL below cap)
- Cooldown since last signal ≥ 5 min
- Regime from L8 is "trend-permissive"

TP/SL come from predicted magnitude / max-drawdown, not fixed levels.

Per-instrument config opt-in: `gate_mode: "wave2"` (legacy) / `"trend"` (v2 only) / `"wave2+trend"` (ensemble).

**Cost-floor hard veto (LOCKED 2026-05-16):** Signal blocked if `predicted_TP_pts < cost_floor_pts`. SEA implements `compute_cost_floor(instrument, strike, side, qty)` which calls Charges_Spec to compute `(brokerage + STT + exchange_fee + GST + estimated_slippage) × (1 + cost_floor_buffer_pct)`. Per-instrument `cost_floor_buffer_pct` values are LOCKED in §7 (nifty50 20% / banknifty 25% / crudeoil 35% / naturalgas 40%) — see L4 D6.

This is "Option B" from Gap #1 fix — TP-floor with dynamic costs. Migration to "Option D" (expected-value floor) is a deferred task (see PROJECT_TODO T8) — requires calibrated probabilities from first v2 retrain.

**Position-aware hard veto (LOCKED 2026-05-16 — Sugg #13 Option B):** Before fire, SEA gate calls `PortfolioAgent.has_open_position(instrument, side)`. If returns `True`, signal is blocked and logged with reason `duplicate_position`. This is independent of and stricter than the 5-min cooldown — covers the case where a fresh predicted setup appears on the same instrument+side mid-cooldown. Prevents over-positioning and capital waste especially relevant under 1-lot AI Live cap. Upgrade path to richer position-context features (Option C) deferred — see D29.

**θ_dir tuning (LOCKED 2026-05-16 — L4 D1 Option D):** at every Saturday retrain (§6.1), per instrument, sweep `θ_dir ∈ [0.55, 0.60, 0.65, 0.70, 0.75, 0.80]` on the walk-forward holdout. Pick the value maximizing sim-PnL (§2.3.4) subject to `mean_signals_per_day ≥ 2`. Stored in `config/sea_thresholds/<instrument>.json` and updated per retrain. Constraint prevents degenerate "0 signals = 0 losses" solution.

**Dwell-time (LOCKED 2026-05-16 — L4 D2 Option D):** per-gate debounce requirement.
- Scalping gate: 3 consecutive ticks above θ_dir before firing (~0.3s)
- Trend gate: 5 consecutive ticks above θ_dir before firing (~0.5s)
Rationale: scalping setups can be lost in 1 second, so debounce stays tight. Trend trades have minutes of room — 0.5s of confirmation removes per-tick noise without missing the move.

**Ensemble combinator (LOCKED 2026-05-16 — L4 D3 Option D):** when `gate_mode=wave2+trend` (default per §8.4), per-tick logic:
- Both gates agree on direction (e.g., both LONG_CE) → fire with parameters from the gate that fired first by dwell (smaller dwell wins → scalping)
- Gates disagree on direction (e.g., LONG_CE vs SHORT_CE) → **skip** (both gates blocked, log as `disagreement_skip`)
- Only one gate fires (other says WAIT) → fire on the one that fired, no veto

Rationale: agreement across two independent timeframes is a stronger signal than either alone. Disagreement skip eliminates the worst losers (cases where short-term and long-term tell different stories — usually noise). Expected 30-40% reduction in total signal count, win-rate boost on remaining signals.

**TP/SL prediction source (LOCKED 2026-05-16 — L4 D4 Option C):** point estimates from existing target heads, with safety multiplier on SL.
- TP = entry + `trend_magnitude_{horizon}s` prediction
- SL = entry − `trend_max_drawdown_{horizon}s` prediction × **1.3** (safety factor)
Rationale: model's predicted drawdown often under-estimates worst adverse move. 1.3× buffer reduces stop-out rate (especially false stop-outs on noise wicks) at small TP-distance cost. No new model heads required. Quantile heads (Option B) deferred — see D37.

**Max Pain weighting (LOCKED 2026-05-16 — L4 D5 Option D):** add 1 categorical feature `days_to_expiry_bucket` ∈ `{0, 1, 2, 3+}` to L1 §2.1.4. Existing continuous `days_to_expiry` retained. LightGBM splits on this categorical to apply Max-Pain features conditionally — model self-learns when Max Pain matters (last 2 days) vs when it's noise (3+ days). No gate-level logic; no hand-tuned boost multipliers.

**Per-instrument `cost_floor_buffer_pct` (LOCKED 2026-05-16 — L4 D6 Option C):** per-instrument tuned defaults reflecting noise-wick width; recalibrate post-paper-trade from real fill data (D39).

| Instrument | Buffer % | Reasoning |
|---|---|---|
| nifty50 | 20% | Most liquid; tight noise wicks |
| banknifty | 25% | Liquid but ~3× nifty wick size |
| crudeoil | 35% | MCX thinner books; wider noise |
| naturalgas | 40% | Thinnest of the 4; widest noise wicks |

Stored in `config/sea_thresholds/<instrument>.json` alongside θ_dir. Confidence-tiered tuning (Option D) deferred until probability calibration validated post-first-retrain.

**All L4 open items resolved + L1+L2 LOCKED 2026-05-16 by Partha → §2.4 now fully LOCKED.**

**Trend bias filter (ADDED 2026-05-17 per §9 D49 — OPEN sub-decisions):** asymmetric pre-combinator filter giving the trend layer veto power over scalp signals (not vice-versa). Runs BEFORE the ensemble combinator (L4 D3).

Logic per tick:
```
trend_prob_long = predictions["trend_direction_900s"]
if trend_prob_long >= θ_bias_bullish:    # default 0.65
    block any SHORT signal from scalp regardless of scalp confidence
    (log reason: "trend_bias_veto_bullish")
elif trend_prob_long <= θ_bias_bearish:  # default 0.35
    block any LONG signal from scalp regardless of scalp confidence
    (log reason: "trend_bias_veto_bearish")
# else: neutral bias → no filtering, combinator runs as normal
```

**What this catches:** the case where the trend model is directionally confident but its own gate doesn't fire (e.g., magnitude below threshold, or dwell-time not satisfied) — the bias still vetoes counter-direction scalp signals. Asymmetric because trend has wider information horizon than scalp (15-min vs 60s).

**Asymmetry rationale:** scalp setups are reversal-at-extreme plays (e.g., bounces off day-low). They WORK against the prevailing direction by design when at extremes. But "scalp says LONG_CE while trend is bearish at 0.20" is a low-quality setup — the bounce is likely a dead-cat. Trend bias kills these.

**Sub-decisions (LOCKED 2026-05-17 by Partha — D50 resolved):**
- a. `θ_bias_bullish = 0.65`, `θ_bias_bearish = 0.35` (symmetric around 0.5). Recalibrate per-instrument after first month of paper data — see D50 follow-up in §9.
- b. **Asymmetric only** — trend bias vetoes scalp, scalp does NOT veto trend. Trend dominates by design.
- c. Bias filter activated whenever `trend_direction_900s` is outside the neutral band — **no magnitude floor required**. The directional confidence threshold itself is the noise filter.

**Cost:** ~15 lines in SEA `decide_action_*` dispatch. No new model heads. No new features. Activates only when both scalp + trend gates exist (`gate_mode = wave2+trend`).

---

### 2.5 Layer 5 — Trade management (SKETCH)

**What it is:** what happens between signal-emit and position-close — TP/SL, trailing, time-stops, partials.

**v2 trade management — Hybrid static + time + 2-tier trail:**
- Entry: static TP from `trend_magnitude_900s`, static SL from `trend_max_drawdown_900s × 1.3` (per L4 D4 safety multiplier)
- Time-stop at `min(predicted_horizon, 1800s)` regardless of P&L
- **2-tier trailing (LOCKED 2026-05-16 — L5 D1 Option E):**
  - Tier 1 (break-even lock): when price reaches `entry + 0.33 × (TP − entry)`, move SL to entry
  - Tier 2 (trailing stop): when price reaches `entry + 0.66 × (TP − entry)`, activate trail at `SL = current_price − 0.5 × (TP − current_price)`
  - Trail updates per-minute (not per-tick — reduces compute + prevents noise-wick flipping)
- No partial profit-taking in v1 — full position out at TP / SL / time / trail-stop / OI exits / exhaustion / regime-flip

**TP/SL lock at entry (LOCKED 2026-05-16 — L5 D2 Option A):** TP and SL are computed once at entry tick from `trend_magnitude_900s` and `trend_max_drawdown_900s × 1.3`, then **never updated** for the life of the trade. Reasons: operator-trustable (screen shows the exit plan), trade-quality report (§5.1) gets clean capture-ratio data, trail already handles "signal strengthening" implicitly. Dynamic TP/SL deferred — see D42.

**Re-entry rules after stop-out (LOCKED 2026-05-16 — L5 D3 Option E):** track per-instrument per-side consecutive stop-out counter (resets on session start or any winner). Rules:
- After 1 stop-out on `(instrument, side)`: normal gate logic applies — cooldown (5 min) + dwell-time (per L4 D2) already block immediate re-fire. No additional block.
- After 2 consecutive stop-outs on same `(instrument, side)`: **block all re-entries for that (instrument, side) for the rest of the session**. Log `consecutive_stops_lockout`.

Rationale: accept that the signal isn't working for that (instrument, side) today; switch attention. Counter resets at session start (next day fresh) OR after any winning trade. Protects against serial revenge trading.

**Broker fill assumptions (LOCKED 2026-05-16 — L5 D4 Option A):** market orders for both entry and all exits (TP / SL / trail / time / OI / exhaustion / regime-flip). Matches sim_pnl validation assumption (Gap #3 Option C bid/ask fills). Limit-order optimization deferred — see PROJECT_TODO T15.

**All L5 open items resolved. §2.5 promoted SKETCH → LOCKED 2026-05-16 by Partha.**

**OI-driven exit triggers** (genuinely new — system currently has zero OI-based exits):
- Support-unwinding: Long + `pe_oi_change_5min_pct` ≤ −15% → exit
- Resistance-building: Long + `ce_oi_change_5min_pct` ≥ +20% above current spot → exit
- Wall-break: Spot crosses support/resistance strike + wall strength drops ≥30% in 5 min → exit
- Symmetric mirrors for shorts
- Composed with existing exit ladder (TP / SL / time / trail) — first trigger wins

**Exhaustion-based exit triggers:**
- Exit when `trend_age_ticks` ≥ N AND `momentum_deceleration` < threshold (trend tiring)
- Exit when `premium_acceleration_drop` < threshold while position open
- Exit on `volume_no_move_score` spike (absorption — likely reversal)

**Regime-flip protection (LOCKED 2026-05-16 — Gap #8 Option C):** When L8 regime flips AWAY from the entry regime AND new regime has sustained ≥3 min (debounce against L8 noise), do NOT force exit. Instead:
- Move SL to entry price (lock break-even on the trade)
- Reduce TP to `current_price + (remaining_TP_distance × 0.5)` (take half what's left)
- All other exit triggers (TP/SL/time/trail/OI/exhaustion) continue to compete — first wins

Rationale: regime flip is partial information. Forcing exit (Option B) whipsaws on a noisy L8 classifier; ignoring it (Option A) leaves you exposed to reversal. Locking break-even + halving the target captures gains while staying in for partial follow-through.

**All originally-open items now LOCKED:**
- Trail trigger formula precision → L5 D1 (2-tier trail, LOCKED 2026-05-16)
- Lock TP/SL at entry vs recalculate → L5 D2 (lock at entry, LOCKED 2026-05-16)
- Re-entry rules after stop-out → L5 D3 (2-stop-out session lockout, LOCKED 2026-05-16)
- Broker fill-quality assumptions → L5 D4 (market orders v1, LOCKED 2026-05-16; limit-order upgrade tracked as PROJECT_TODO T15)

---

### 2.6 Layer 6 — Position sizing (SKETCH)

**What it is:** how many lots per signal.

**v2 sketch — Volatility-scaled with hard caps:**
```
lots = floor(per_trade_risk_INR / (predicted_drawdown_pts × contract_multiplier))
where per_trade_risk_INR = daily_risk_budget / max_signals_per_day
```
Cap by per-instrument exposure limit (L7 config). Floor at 1 lot (skip signal if calculated = 0). No Kelly-fraction in v1.

**Lot size hard constraints (Indian market):**
| Instrument | Lot |
|---|---|
| NIFTY | 75 |
| BANKNIFTY | 30 |
| CRUDEOIL | 100 |
| NATURALGAS | (TBD — confirm current MCX lot) |

Small accounts can't trade NIFTY at low conviction (1 lot = ₹7,500–15,000 risk minimum).

**`daily_risk_budget` composition (LOCKED 2026-05-16 — L6 D1 Option C):** hybrid floor — `daily_risk_budget = min(L7.daily_loss_limit, channel_equity_for_instrument × 0.05)`. Scales with growth (compounding) but never exceeds L7's hard cap. Auto-defensive when equity drops (smaller trades on shrinking account).

**Signal-confidence weighting (LOCKED 2026-05-16 — L6 D2 Option D):** equal sizing v1, upgrade post-calibration. All signals get `lots = floor(daily_risk_budget / max_signals_per_day / (predicted_drawdown_pts × contract_multiplier))`. Confidence-weighted sizing (multiplying by predicted_prob ratio) deferred until reliability-diagram check passes post-first-retrain (gated by same condition as Gap #1 B→D in PROJECT_TODO T8). See T16.

**Portfolio-level concurrent-position risk cap (LOCKED 2026-05-16 — L6 D3 Option B):** before firing any signal, SEA computes total at-risk across all currently-open positions on that channel:

```
total_at_risk = sum(open_position_potential_loss)  // sum of SL distances × lots × multiplier
candidate_at_risk = signal_lots × signal_SL_distance_pts × contract_multiplier

block fire if (total_at_risk + candidate_at_risk) > 2.5 × max(L7.daily_loss_limit across instruments)
```

With current §7 numbers: cap = `2.5 × ₹3000 (banknifty) = ₹7,500`. Allows 2-3 concurrent instruments without exposing multi-instrument black-swan day.

Correlation-aware aggregation (Option C) deferred — see D46.

**Sizing per gate type (LOCKED 2026-05-16 — L6 D4 Option A):** same formula applies uniformly to scalp and trend signals. The drawdown-driven sizing self-adjusts — scalp's smaller `predicted_drawdown_pts` naturally yields more lots within the per-trade budget; trend's wider drawdown yields fewer. No per-gate split or boost. Keeps sizing logic single-path, debuggable, and free of arbitrary multipliers.

**All L6 open items resolved. §2.6 promoted SKETCH → LOCKED 2026-05-16 by Partha.**

---

### 2.7 Layer 7 — Risk controls (SKETCH)

**What it is:** hard kill-layer that overrides gate output regardless of model conviction.

**v2 sketch — static config-driven hard limits:**
- Daily-loss-limit (halt trading for the day if hit)
- Max concurrent positions (per instrument and total)
- Max signals/day per instrument
- Blackout windows: lunch 12:30–13:30, last 5 min before close, broker maintenance
- Session-warmup blackout (first 15 min, no trading)
- Broker WS budget caps (already implemented — see DualAccountArchitecture_Spec)
- N-consecutive-losers auto-pause (resume requires manual re-enable)

**Event-driven blackout windows (LOCKED 2026-05-16 — Sugg #12 Option D blackout half):**

| Category | Action | Examples |
|---|---|---|
| **Tier-1 (hard blackout)** | `trading_allowed=0` for the affected instrument(s) on the event day | RBI policy day, Union Budget day, general election counting day, Fed FOMC release day (for crude/naturalgas), index F&O lot-size change announcements |
| **Tier-2 (feature-flag, no blackout)** | Model sees `is_tier_2_event_day`, `event_type_categorical`, `hours_to_next_tier_1_or_2_event` (§2.1.4 C11) and learns event-specific patterns | GDP/CPI release (IN), OPEC meetings (crude/naturalgas), US NFP, monthly expiry day (crude/naturalgas) |
| Earnings of index-heavy stocks | Deferred (only if material to index — needs evidence) | — |

Source: `config/event_calendar.json` (new file, manually maintained quarterly — see D28).

All limits checked **before** L6 sizing → tripped limit blocks trade entirely.

**Two-account architecture interaction:**
- L7 risk controls must respect per-channel budgets (`my-live`, `ai-live`, `ai-paper` have separate capital pools)
- AI live: 1-lot cap per trade until 30-day head-to-head positive vs `my-live`

**Kill-switch event hooks (LOCKED 2026-05-16 — L7 D1 Option E):** severity-tiered notifications via existing `tfa_bot` Telegram infra. No new infrastructure.

| Severity | Triggers | Action |
|---|---|---|
| **INFO** | Per-head drift alert (§5.3), regression-block per head (§6.1) | Telegram + log to `logs/risk/INFO_YYYY-MM-DD.log` |
| **WARN** | Consecutive-loser pause, pre-market check red on non-critical item, ensemble disagreement-skip rate spike | Telegram + log + auto-create journal entry with reason |
| **CRITICAL** | AI-Live halt (§8.5), daily-loss-limit hit, pre-market check red on model integrity (file corrupt / scaler missing), broker WS limit exceeded, kill-switch manual trigger | Telegram with `🚨` + log + journal + sound alert (if operator UI open) |

Severity is part of the alert payload; operator filters by severity in Telegram bot view. Daily green summary line ("All 4 instruments OK, 0 risk events") still fires at 20:00 IST even on quiet days.

**Reset cadence (LOCKED 2026-05-16 — L7 D2 Option A):**

| Counter | Reset rule |
|---|---|
| `daily_loss_limit` | Daily at session start (08:55 IST) |
| `max_signals_per_day` | Daily at session start |
| `consecutive_loser_pause` | After any winning trade OR weekly Monday AM (whichever sooner) |
| AI-Live halt (§8.5) | **Manual only** + requires post-mortem journal entry |
| `(instrument, side) stop_lockout` (L5 D3) | Daily at session start |

Rationale: daily counters reset naturally with sessions; AI-Live halt is "something broke" — needs human review before re-arming. Consecutive-loser pause resets on first winner so a winning streak unblocks; weekly fallback prevents indefinite lockout.

**Rolling drawdown halt (LOCKED 2026-05-16 — L7 D3 Option D):** two-tier rolling DD trigger to catch slow-bleed (which daily-loss-limit misses):

| Window | Threshold | Action |
|---|---|---|
| 5-day cumulative PnL | < −2 × `daily_loss_limit` | Halt `ai-live` channel (same mechanism as §8.5) |
| 10-day cumulative PnL | < −3 × `daily_loss_limit` | Halt `ai-live` channel |

Either trigger sets `trading_allowed=0` on `ai-live`. CRITICAL severity Telegram alert. Manual reset + post-mortem required (same workflow as §8.5).

Rationale: 5-day catches near-term bleed fast (regime shift, recent code change). 10-day catches sustained slow-bleed even when individual days look OK. Both are at channel level (per-instrument tracking deferred — D43).

**Per-channel risk-limit toggle (LOCKED 2026-05-16 — L7 D4 Option F user-driven):** each channel has a `risk_limits_enabled` boolean. When `false`, L7 soft limits do NOT apply — model + execution behave freely so paper-trade measures raw model behavior.

| Channel | `risk_limits_enabled` default | Rationale |
|---|---|---|
| `ai-paper` | **false** | Raw model measurement — see full P&L curve unencumbered by halts |
| `ai-live` | **true** (always) | Capital protection mandatory |
| `my-live` | **true** (always) | Same |
| `testing-live`, `testing-sandbox` | configurable | Operator chooses per session |

Toggle stored in channel config; DA reads at signal-evaluation time.

**Always-enforced (cannot be disabled regardless of toggle):**
- Tier-1 event blackouts (RBI, Budget, election, FOMC) — §2.7 D5
- Broker WS connection cap — per `DualAccountArchitecture_Spec`
- Pre-market sanity-check fail (`ai-live` only)

Soft limits gated by toggle: daily_loss_limit, max_signals_per_day, consecutive_loser_pause, rolling_dd_halt (5-day, 10-day), session-warmup blackout, lunch/EOD blackout.

Optional usage: enable `risk_limits_enabled=true` on `ai-paper` for the final 2 weeks before ai-live activation to dress-rehearse the full halt machinery.

**Expiry-day special handling (LOCKED 2026-05-16 — L7 D5 Option C):** on any day where `is_expiry_day=1` for an instrument, new entries for that instrument blocked after **14:30 IST**. Existing positions exit via normal L5 ladder (TP/SL/trail/time/regime/OI/exhaustion). Closing 60 min before 15:30 IST avoids the last-hour gamma scramble where stops cluster and slippage spikes.

Earlier hours (09:15 – 14:30) trade normally — model uses `is_expiry_day`, `days_to_expiry_bucket`, and Max Pain features (C10) to adapt. Earlier hours often have legitimate trend setups before scramble.

L7 D5 also applies when `risk_limits_enabled=false` for `ai-paper` — it's safety, not soft limit. Added to D44 always-enforced list.

---

### 2.8 Layer 8 — Regime / meta (SKETCH)

**What it is:** classifies current market state, gates which signals are allowed in which states.

**3-state classifier thresholds (LOCKED 2026-05-16 — L8 D1 Option A):**
- `trend` if `adx_5min ≥ 25` AND `consecutive_higher_highs_5min ≥ 3` (or symmetric down: `consecutive_higher_lows_5min ≥ 3` reversed)
- `chop` if `range_compression_ratio < 0.6` AND `adx_5min < 15`
- `range` otherwise

Defaults from standard literature (ADX 25 = classic trending threshold; 15 = clear ranging). Per-instrument override available if paper data shows one instrument's ADX baseline systematically differs — see D47.

**Time-of-day priors (LOCKED 2026-05-16 — L8 D2 Option C):** L8 classifier uses ONE set of thresholds across the session. Time-of-day variance handled downstream by L4 gate using existing L1 time features (`minutes_from_open`, `minutes_to_close`, `lunch_session_flag` — C6). LightGBM trees in the gate compose time-aware behavior automatically — splits on time feature × regime tag combinations.

Rationale: keeps L8 simple (rule produces one tag); pushes time-conditional logic to the layer that already has it (L4 gate). No L8 rule fragility from per-time-bucket threshold tables.

**Look-ahead avoidance (LOCKED 2026-05-16 — L8 D3 Option C):** all L8 regime features (and by policy, every L1 feature) computed using ONLY data available at time `t` (no future bars). Enforced by:

1. **Convention:** all rolling/streak features use bars ending at or before `t` — lagged by at least 1 bar.
2. **Automated test (mandatory):** new `python_modules/model_training_agent/tests/test_no_lookahead.py` runs every retrain. For each feature in L1+L8:
   - Build "point-in-time" version (compute at `t` using only data with timestamp ≤ `t`)
   - Build "full-history" version (typical batch compute)
   - Assert equal across N sample timestamps
   - Fails the retrain pipeline if any feature peeks forward.

Look-ahead leakage is the hardest ML failure mode to debug after the fact. Test is non-negotiable safety check — any failure blocks model promotion.

**Learned regime classifier (LOCKED 2026-05-16 — L8 D4 Option C):** v1 ships rule-based only. Defer learned LightGBM regime classifier until paper-trade data proves rules are inadequate. **Trigger condition:** if §5.1 trade-quality report shows ≥20% of losers exit on regime-mis-tagged conditions over a 4-week window. At that point, hand-label regime windows from holdout data + train a 4th LightGBM head (alongside the 72 trade-prediction heads) to predict regime classification. See PROJECT_TODO T17.

**All L8 open items resolved. §2.8 promoted SKETCH → LOCKED 2026-05-16 by Partha.**

L4 gate reads this — only emits trend signals in `trend` regime (initially). Wave 2 scalp can run in `range` or `chop` as future ensemble.

**Categorical "market controller" tag** (derived from existing bull/bear scores):
- `bulls_in_control` if `call_put_oi_diff` bullish sign for ≥10 min AND `pe_wall_strength_rel > ce_wall_strength_rel`
- `bears_in_control` mirror
- `contested` otherwise

L4 gate respects this: hard veto on counter-trend signals (no LONG when `bears_in_control`; no SHORT when `bulls_in_control`).

**Regime flip definition (LOCKED 2026-05-16 — supports Gap #8 mid-trade policy):** a regime "flip" is recognized only when the new regime has been sustained for **≥3 consecutive minutes**. This debounces against momentary L8 oscillation and prevents whipsaw exits on per-tick noise.

**Expiry-day regime modulator:** C4 GEX features matter most on expiry days (Thursday for NIFTY, monthly for others). L8 should up-weight GEX inputs to L4 on those days.

Rule-based first because labels for a learned regime classifier are circular (you'd label them using the same trend definition).

**All originally-open items now LOCKED:**
- Thresholds tuning → L8 D1 (ADX/range thresholds, LOCKED 2026-05-16)
- Time-of-day regime priors → L8 D2 (time-of-day via existing L1 features `minutes_from_open` / `lunch_session_flag`, LOCKED 2026-05-16)
- Look-ahead avoidance → L8 D3 (LOCKED 2026-05-16)
- Learned regime classifier → L8 D4 (deferred to PROJECT_TODO T17 via §9 D47 trigger condition)
- Regime transitions vs open positions → L5 Gap #8 Option C (lock break-even + halve TP, LOCKED 2026-05-16)

---

## 3. Schema impact

| Layer | Before | After (all accepted) |
|---|---|---|
| Input cols | 377 | 444 (377 base + 23 B-block including B5 + 44 C accept) |
| Scalping target cols (default 2 windows, 12 types) | 25 | 25 (unchanged) |
| Trend target cols (2 windows × 6 types per L1 D6) | 0 | 12 |
| **Total parquet width** | 402 | ~473 |
| Per-row storage | baseline | +18% |
| LightGBM models per instrument | 60 | 72 (60 scalping + 12 trend) |
| LightGBM models total (× 4 instruments) | 240 | 288 |

### 3.1 Schema evolution policy (LOCKED 2026-05-16 — Option A)

**Policy:** MTA reads only parquets matching the current `LATEST_SCHEMA_VERSION`. Older-schema parquets are **ignored** at training time, not deleted.

**Implications:**
- Existing ~10 sessions of 402-col parquets become inaccessible to MTA when v2 schema ships.
- First v2 retrain requires accumulating ≥30 sessions from scratch under new schema.
- Calendar cost: ~6 weeks of recording (Mon–Fri × 5 sessions/week) vs ~4 weeks under Option C backfill.
- **Reversible:** raw `.ndjson.gz` files retained. Can re-run replay later to backfill old sessions if decision changes.

**Why Option A over C:** user chose simplicity over 2-week schedule acceleration on 2026-05-16. Trade-off accepted: 2 extra weeks of waiting in exchange for zero replay-pipeline complexity and no parquet bulk-rewrite.

**Implementation:**
- Emitter exposes `LATEST_SCHEMA_VERSION` constant — bump on every schema-affecting change.
- Parquet metadata includes `schema_version` written at emit time.
- MTA filters out parquets where `schema_version != LATEST_SCHEMA_VERSION` at training-time, logs ignored count.
- No `--mode=schema-upgrade` replay flag needed.
- If user later reverses decision: re-run `replay_runner.py` on old `.ndjson.gz` to regenerate parquets at current schema.

---

## 4. Component spec deltas

### 4.1 TickFeatureAgent (current: v1.7 → bump v1.8)

- +23 multi-TF + S/R features (B block §2.1.3, includes B5 added 2026-05-17)
- +44 brainstorm features ACCEPT (C block §2.1.4)
- Bar buffers: 1-min, 5-min, 15-min OHLCV (rolling 14–30 bars each)
- Tick buffers (existing): 5, 10, 20, 50
- Session buffer (premium VWAP, high/low age tracker, opening range, 5-day swing state)
- Output schema: 444 input cols (was 377)
- Affected file: `python_modules/tick_feature_agent/output/emitter.py` `_build_column_names()`

### 4.2 ModelTrainingAgent (current v0.1 → bump v0.2)

- +12 trend target heads (after L1 D6 dropped 600s horizon)
- `scale_pos_weight = n_neg / n_pos` per target
- Holdout `last_n = 5`
- Validation metric: AUC + simulated-PnL on holdout after fees
- Total heads 60 → 72 per instrument

### 4.3 SignalEngineAgent (SEA_ImplementationPlan_v0.1.md → v0.2)

- New `decide_action_trend` gate (§2.4)
- Per-instrument `gate_mode` config: `wave2 | trend | wave2+trend`
- Cooldown enforcement (5-min default)
- Regime veto from L8
- TP/SL from predicted magnitude/drawdown (not fixed levels)

### 4.4 TradeExecutorAgent (current v1.3 → v1.4)

- Accept dynamic TP/SL per trade from SEA (was fixed config)

### 4.5 RiskControlAgent (current v2.0 → v2.1)

- OI-based exit triggers (§2.5)
- Exhaustion exit triggers (§2.5)
- First-trigger-wins composition with existing TP/SL/time/trail

### 4.6 DisciplineAgent (current v1.4 → v1.5)

- Daily-loss halt
- Max signals/day enforcement
- Blackout windows (lunch, EOD, warmup)
- RBI/macro event-day blackouts (calendar-based)
- N-consecutive-loser auto-pause

### 4.7 PortfolioAgent (current v1.3 → v1.4)

- Volatility-scaled sizing
- Per-instrument lot floor + cap
- Per-channel budget aggregation

### 4.8 Charges_Spec (read-only, v0.1)

- Feeds L4 TP target floor (TP must clear cost + slippage)
- Feeds L3 simulated-PnL validation metric
- No spec change required

### 4.9 DualAccountArchitecture_Spec (read-only, v0.1)

- ai-paper then ai-live channels carry v2 model
- Per-channel `maxLotsPerTrade=1` for `dhan-ai-data` enforced by DA
- No spec change required

### 4.10 AILiveCanary_Spec (read-only, v0.1)

- Canary rollout rules govern v2 paper → live transition
- 30-day head-to-head comparison gate before ai-live capital scaling
- No spec change required

---

## 5. UI / Journal impact

| Spec | Change |
|---|---|
| TradingDesk_Spec_v1.3 | Filtered-signals view shows `gate_mode` field per signal |
| MainScreen_Spec_v1.3 | Show regime tag from L8 (trend/range/chop + bulls/bears/contested) |
| InstrumentCard_v2_Spec_v0.1 | Per-instrument `gate_mode` display |
| Journal_Spec_v0.1 | Record `gate_mode` per trade for head-to-head analysis + trade-quality fields (see §5.1) |
| HeadToHead_Spec_v0.1 | Wave2 vs trend gate vs ensemble comparison rows |

### 5.1 Trade-quality scorecard (LOCKED 2026-05-16 — Sugg #7 Option C)

**At every trade close, journal records these fields:**

| Field | Source | Purpose |
|---|---|---|
| `predicted_tp_pts` | SEA signal | What model thought target was |
| `predicted_sl_pts` | SEA signal | What model thought max risk was |
| `actual_capture_pts` | Realized exit price − entry price | What we got |
| `capture_ratio` | `actual_capture_pts / predicted_tp_pts` | 1.0 = TP hit; <0 = SL hit; 0–1 = partial |
| `exit_reason` | RCA exit decision | One of: `TP`, `SL`, `time_stop`, `trail_stop`, `regime_flip`, `oi_unwind`, `oi_buildup`, `wall_break`, `exhaustion_trend_age`, `exhaustion_premium`, `volume_absorption`, `manual` |
| `gate_mode_at_entry` | SEA gate config | `wave2` / `trend` / `wave2+trend` |
| `regime_at_entry` | L8 snapshot | `trend` / `range` / `chop` + bull/bear/contested |
| `regime_at_exit` | L8 snapshot | Same set |
| `time_in_trade_sec` | RCA | Hold duration |
| `instrument`, `strike`, `side` | TEA | For per-instrument segmentation |

**Weekly batch report** (auto-generated Sunday EOD, `docs/reports/trade_quality_YYYY-MM-DD.md`):

| Section | Content |
|---|---|
| Headline | Total trades, win rate, mean capture, mean capture ratio |
| By gate_mode | Win rate + mean capture for `wave2` vs `trend` vs ensemble |
| By exit_reason | Distribution: what % exit on TP / SL / regime_flip / etc. Flag any reason ≥30% of exits |
| By regime drift | % of trades where `regime_at_entry ≠ regime_at_exit`. Of those, win rate split. Identifies "regime-flip kills us" pattern |
| By time-in-trade bucket | <2min, 2-10min, 10-25min, >25min — which holds are profitable |
| Worst 5 trades | Full row dump for case-by-case review |
| Best 5 trades | Same — find patterns to amplify |

**Why C and not B (single score):** a single 0–100 quality score hides WHICH dimension failed. C gives you "20% of SHORT trades exit on regime-flip" — actionable. B gives you "Tuesday score: 47/100" — not actionable.

**Feedback loop:** report findings flow back into L4 gate tuning (e.g., "regime-flip exits dominate `wave2+trend` ensemble → tighten ensemble priority" → V2_MASTER_SPEC §2.4 open item θ tuning).

### 5.2 Pre-market sanity check (LOCKED 2026-05-16 — Sugg #8 Option D)

**Cron:** 08:50 IST Mon-Fri (scheduled via existing auto-recorder infra).
**Script:** `scripts/pre_market_check.py` (to be created in T3 Phase 6).

**Checks per run (red on any failure):**

| # | Check | Pass criterion |
|---|---|---|
| 1 | Model file integrity (all 72 per instrument × 4 = 288) | Every `.lgbm` loads without exception; expected feature count matches LATEST_SCHEMA_VERSION |
| 2 | Scaler / feature_config presence | `config/model_feature_config/<inst>_feature_config.json` exists for each instrument |
| 3 | Prediction sanity | Predict on last hour of yesterday's chain snapshots. Verify per head: no all-NaN, no all-0, no all-1, prediction distribution within ±3σ of historical baseline |
| 4 | Dhan token freshness (both accounts) | `token_age_hours < 14` for `dhan` (primary) and `dhan-ai-data` (spouse) |
| 5 | Chain feed last-update per instrument | `last_chain_snapshot_age_hours < 24` for each of 4 instruments |
| 6 | Last training timestamp | `models/<inst>/LATEST` timestamp < 14 days old (concept drift safety) |

**Output:**
- Telegram message (TFA bot): green ✓ "All 4 instruments ready" or red ✗ with failing check IDs and which instrument/head
- Optional auto-disable: on red, set `ai-live` channel `trading_allowed=0` until manual reset (see D24)
- Log to `logs/pre_market_check/<date>.log` for audit

**Rationale Option D over B/C:** B+C catch the problems but require operator to check screen at 08:50. D pushes the result to phone — operator wakes up at 06:00, sees ✓ at 09:00, knows system is healthy without opening laptop. On red, hits "Disable AI Live" on the bot before market opens. Zero implementation cost over C (Telegram bot already exists per `tfa_bot/`).

### 5.3 Concept drift detection (LOCKED 2026-05-16 — Gap #14 Option C)

**Cron:** 20:00 IST daily (post-session, after parquet write).
**Script:** `scripts/drift_check.py` (to be created in T3 Phase 6).

**Per-head AUC tracking:**

| Step | Logic |
|---|---|
| 1 | Load today's predictions from `logs/signals/<instrument>/YYYY-MM-DD_signals.log` and today's realized outcomes from `data/features/<date>/<instrument>_features.parquet` |
| 2 | For each of 72 model heads × 4 instruments = 288 heads, compute today's per-head AUC vs realized target |
| 3 | Maintain rolling 5-day mean AUC per head (state file `data/drift/per_head_auc_history.json`) |
| 4 | Compare 5-day mean to baseline AUC recorded at last retrain (stored alongside model in `models/<inst>/<timestamp>/baseline_auc.json`) |
| 5 | Alert (Telegram) per-head if `(baseline_auc − 5day_mean_auc) / baseline_auc > 10%` |

**Why C (per-head granularity) and not B (aggregate AUC):**
- Aggregate AUC masks: 77 heads steady + 1 head broken → average looks fine, but that 1 head firing bad signals
- Per-head tells you which head to investigate: "trend_direction_900s for crudeoil is broken" → check if crude microstructure shifted (e.g., oil-price cap change, expiry rule change)
- Surfaces *which* models to manually retrain in isolation vs full system retrain

**Output:**
- Telegram: `[DRIFT] crudeoil/trend_direction_900s AUC 0.61 → 0.54 (−11.5%) over 5d, baseline 0.61` per failing head
- Log to `logs/drift_check/<date>.log`
- Daily summary line even on green: total 312 heads, 0 drift, all clean

**Auto-retrain decision (D not adopted):** keep human in loop. Auto-retrain risks shipping a worse model unattended. Alert → human reviews → manual trigger of T3 Phase 5 retrain for the affected instrument(s). See PROJECT_TODO T12 for the gated auto-retrain proposal (deferred).

### 5.4 Per-trade SHAP explainability (LOCKED 2026-05-16 — Gap #15 Option C)

**At every signal fire, SEA computes and logs SHAP values:**

| Step | Logic |
|---|---|
| 1 | LightGBM has built-in SHAP via `predict(..., pred_contrib=True)`. Returns per-feature contribution to the prediction (~1ms per call). |
| 2 | For the gating head (e.g., `trend_direction_900s`), extract top 5 features by `abs(shap_value)` |
| 3 | Append to signal log: `top_5_shap_contributors`: `[{"feature": "net_gex", "value": +0.18, "feature_value": 4823}, ...]` |
| 4 | Mirror to Journal_Spec on trade close — full top-5 stays with the trade record |
| 5 | Storage: ~10 KB per signal × ~20 signals/day total × 250 days = ~50 MB/year. Trivial. |

**Weekly trade-quality report extension (extends §5.1):**

| Section | Content |
|---|---|
| SHAP-by-outcome | For winners: top 10 features by aggregated abs(SHAP) across all winning trades that week. Same for losers. |
| SHAP-by-instrument | Per-instrument: which features dominate decisions. If e.g. `chain_pcr_atm` shows in 80% of losers and 20% of winners → flag as candidate for pruning |
| SHAP feature stability | Compare top-10-by-SHAP this week vs last week. Big shifts indicate model relying on different features → drift indicator |

**Feedback loop:**
- Losers driven by features → those features candidate for pruning at next retrain (feeds §2.1.7 pruning policy)
- Stable winners driven by 3-4 features consistently → that's your real edge → protect those features from pruning
- Gives Partha a "second opinion" on every signal: "model fired because GEX = +24% over yesterday, breakout_event_5min triggered, regime trend-permissive" — debuggable, trustable

**Rationale C over D:** D adds real-time UI display per signal — operator pretty UI is nice but doesn't compound into edge. C's aggregated weekly view IS where insight emerges. UI is a follow-up after paper-trade workflow stabilizes.

---

## 6. Implementation phases (T3 in PROJECT_TODO)

| Phase | Description | Code time | Wall time |
|---|---|---|---|
| 1 | Design lock (this doc) | 0 | ~brainstorm sessions per layer |
| 2 | TFA feature additions (B + C blocks) | 1–2 days | 2 days |
| 3 | Target additions (12 trend targets) | 1 day | 1 day |
| 4 | Auto-record accumulation (≥30 sessions) | 0 | ~30 days passive |
| 5 | Retrain all 4 with combined targets (72 heads each) | 4 hours | 1 day |
| 6 | Trend gate + smoke + L7 risk controls + L6 sizing | 2–3 days | 2–3 days |
| 7 | Paper trade ramp (ai-paper channel) | 0 | weeks |
| 8 | AI Live transition (per canary spec) | 0 | per head-to-head result |

**Total active work: ~6–9 days · Wall time: ~30+ days including data wait**

### 6.1 Retrain cadence (LOCKED 2026-05-16 — Gap #5 Option C)

**Schedule:** Weekly, Saturday 02:00 IST.

**Why Saturday:** markets closed Friday EOD → fresh weekly data baked in by Sat morning. Full Sunday for human review of metrics before Monday deployment. Avoids any conflict with live trading on weekdays.

**Process per cycle:**

| Step | Time | Action |
|---|---|---|
| Sat 02:00 | Cron trigger | `scripts/retrain_v2.sh` runs |
| Sat 02:00–20:00 | ~18 hr | 72 heads × 4 instruments × 5 walk-forward folds = 1440 LightGBM trainings |
| Sat 22:00 | Per-head sim_pnl compare | For each of 72 heads × 4 instruments, compute `sim_pnl_delta_pct = (new − prior) / abs(prior)` |
| Sat 22:30 | Regression block (Gap #7 Option B) | Reject any head where `sim_pnl_delta_pct < -5%` (`regression_threshold`) even if absolute new sim_pnl is positive. Emit summary: "X heads improved, Y unchanged, Z regressed (blocked)" |
| Sat 23:00 | Stage per-head CANDIDATE | Build `models/<inst>/CANDIDATE_HEADS.json` containing entries for ONLY heads that won AND passed regression block. Non-winners and regressed heads stay on existing LATEST_HEADS entry. If zero heads qualified, log "no promotion" and exit |
| Sun (anytime) | Human review | Trade-quality report (§5.1) + drift report (§5.3) + CANDIDATE metrics |
| Mon 08:50 | Pre-market check (§5.2) | Runs on whichever of LATEST_HEADS/CANDIDATE_HEADS is active. If CANDIDATE_HEADS approved by human, archive current LATEST_HEADS → `HEADS_HISTORY/`, then promote CANDIDATE_HEADS → LATEST_HEADS; else keep LATEST_HEADS. |

**Telegram notifications:** "Sat retrain started" / "Sat retrain CANDIDATE ready: NIFTY +18 pts vs prod, BANKNIFTY −3 pts (worst-fold negative, escalate)" / "Sat retrain no-go: all instruments below threshold."

**Compute cost:** ~20 hours weekly. Acceptable on offline GPU/CPU; doesn't affect live trading.

**Why C over D (event-driven):** event-driven requires confidence in drift detection (Gap #14) AND a clean automation pipeline. Start with deterministic weekly cadence — predictable, debuggable. Upgrade to D after 1 month proves drift detector is reliable (see D26).

---

## 7. Per-instrument numbers (placeholders, TBD)

| Instrument | Noise floor | Lot size | Daily loss limit | Max signals/day | Slippage %/strike | Cost-floor buffer % |
|---|---|---|---|---|---|---|
| nifty50 | **8 pts** (LOCKED) | 75 | **₹2,500** (LOCKED) | **5** (LOCKED) | **0.3%** (LOCKED) | **20%** (LOCKED) |
| banknifty | **25 pts** (LOCKED) | 30 | **₹3,000** (LOCKED) | **5** (LOCKED) | **0.5%** (LOCKED) | **25%** (LOCKED) |
| crudeoil | **5 INR** (LOCKED) | 100 | **₹2,500** (LOCKED) | **4** (LOCKED) | **1.0%** (LOCKED) | **35%** (LOCKED) |
| naturalgas | **3 INR** (LOCKED) | **1,250** (LOCKED — MCX standard; verify against Dhan profile) | **₹2,000** (LOCKED) | **4** (LOCKED) | **1.5%** (LOCKED) | **40%** (LOCKED) |

Noise-floor applies **same across both trend horizons** (900s / 1800s — 600s dropped per L1 D6) — minimum tradeable move doesn't scale with how long it took (L1 D1 + §2.2 decision, 2026-05-16). Recalibrate per D40 post-first-retrain.

`slippage_pct_per_strike_distance` defaults from Gap #4 fix (2026-05-16). To be recalibrated from real fill data — see PROJECT_TODO T10.
`cost_floor_buffer_pct` defaults from L4 D6 fix (2026-05-16). To be recalibrated from real fill data — see D39.
`daily_loss_limit` + `max_signals_per_day` defaults from L7 D6 fix (2026-05-16). Sized ~5% of assumed ₹50k operating capital per instrument. To be recalibrated from first month of paper PnL distributions — see D45.

To be filled during L7 lock session.

---

## 8. Acceptance criteria + canary rollout

### 8.1 v2 model acceptable for paper trading if:
- See §1.3 success criteria

### 8.2 v2 acceptable for AI Live (small capital):
- 30+ paper-trade sessions on ai-paper channel
- Net expectancy positive after charges
- Per AILiveCanary_Spec v0.1 — 1-lot cap, wife-funded capital

### 8.3 v2 acceptable for AI Live scaling:
- 30-day head-to-head: ai-live % gain ≥ my-live % gain on same signal set
- Per HeadToHead_Spec v0.1

### 8.4 Scalp + Trend models coexist permanently (REVISED 2026-05-16 — supersedes Gap #18)

**Decision (Gap #28 Option X):** Both Scalp model (Wave 2) and Trend model (v2) run together permanently across all 4 instruments. Neither retires regardless of relative performance.

**Why:**
- Scalp model catches day-extreme reversal opportunities (verified 9/9 directionally on tested days). Trend model misses these — different setup.
- Trend model catches sustained moves (10-30 min). Scalp model misses these — different setup.
- Together they cover more setups than either alone. Removing one creates a coverage gap that the other cannot fill.

**Default `gate_mode`:** `wave2+trend` for every instrument, permanently. Per-instrument config can override to `wave2` or `trend` only if user explicitly opts out (e.g., for diagnostic testing); not driven by automated retirement.

**Replaces:** prior Gap #18 retirement criteria (30-day 10pp win-rate gap trigger). That logic is removed. Tracking of per-gate would-have-fired decisions still useful for ensemble combinator tuning + trade-quality report (§5.1), but no longer drives retirement.

**Operational reference:** see `docs/WAVE2_RESUMPTION_GUIDE.md` for Scalp model operational procedures — applies indefinitely.

**Ensemble combinator design** (open): how `wave2+trend` resolves conflicts (e.g., scalp says LONG_CE, trend says SHORT_CE on same tick) is an L4 deep-dive open item — see §2.4 open items.

### 8.5 AI-Live halt rule (LOCKED 2026-05-16 — Gap #28 rollback half)

Since Scalp + Trend coexist permanently (§8.4), there's no "revert to Scalp" rollback. Instead the halt rule protects capital when the ensemble itself underperforms:

**Trigger:** if `ai-live` channel weekly PnL is negative for **4 consecutive weeks** (rolling), automatically set `ai-live` channel `trading_allowed=0`. Telegram alert. Manual reset required after post-mortem.

**Why 4 weeks, not faster:** single losing week is statistical noise. 2-3 weeks could be regime mismatch (model trained on dull period, market enters trending period). 4 weeks of consistent negative = something structural broke.

**Post-mortem checklist when triggered:**
- Check §5.1 trade-quality report — which exit_reason dominates losers?
- Check §5.3 drift report — which heads' AUC dropped?
- Check §5.4 SHAP — which features drove the losing trades?
- Decide: re-tune gate thresholds / retrain immediately / disable one of Scalp/Trend / revisit L1 features

### 8.6 Per-instrument decision ownership (LOCKED 2026-05-16 — Gap #28 ownership half)

All per-instrument numbers in §7 (`noise_floor`, `lot_size`, `daily_loss_limit`, `max_signals/day`, `slippage_pct_per_strike_distance`, and any future additions) are owned by **Partha**. Changes require explicit decision recorded in §9 with date-stamp. No spec edit may change a §7 value without a corresponding §9 entry.

---

## 9. Pending decisions (consolidated)

| # | Decision | Resolves in |
|---|---|---|
| D1 | Banknifty / crudeoil / naturalgas noise floors | **RESOLVED 2026-05-17** — §7 locks all four (nifty50=8 / banknifty=25 / crude=5 / natgas=3) |
| D2 | Accept/defer/reject each of 52 brainstorm L1 candidates | **RESOLVED 2026-05-16** — 44 ACCEPT, 8 DEFER → T14. See §2.1.4 |
| D3 | Drop 600s (10-min) trend target? | **RESOLVED 2026-05-16 L1 D6 Option B** — DROPPED. Keep {900s, 1800s} only. See §2.1.7 item 8 |
| D4 | θ_dir threshold per instrument | **RESOLVED 2026-05-16 L4 D1 Option D** — swept per retrain from {0.55..0.80}. See §2.4 |
| D5 | Dwell-time requirement for signal | **RESOLVED 2026-05-16 L4 D2** — scalp 3 ticks / trend 5 ticks. See §2.4 |
| D6 | Trail trigger formula | **RESOLVED 2026-05-16 L5 D1 Option E** — 2-tier (break-even at 0.33×TP, trail at 0.66×TP). See §2.5 |
| D7 | Lock TP/SL at entry vs recalculate | **RESOLVED 2026-05-16 L5 D2 Option A** — lock at entry. See §2.5 |
| D8 | `daily_risk_budget` formula | **RESOLVED 2026-05-16 L6 D1** — hybrid risk budget. See §2.6 |
| D9 | Daily-loss-limit per instrument | **RESOLVED 2026-05-16 L7 D6** — see §7 (nifty/banknifty ₹2.5k/₹3k, crude ₹2.5k, natgas ₹2k) |
| D10 | Max concurrent positions cap | **RESOLVED 2026-05-16 L7** — see §2.7 |
| D11 | Regime thresholds (ADX, range-compression) | **RESOLVED 2026-05-16 L8 D1** — see §2.8 |
| D12 | ~~Whether to drop Wave 2 entirely after v2 proves out~~ | **RESOLVED 2026-05-16 — Gap #28 Option X SUPERSEDES Gap #18. Scalp + Trend coexist permanently. See §8.4. No automated retirement** |
| D13 | Walk-forward retrain cadence | **RESOLVED 2026-05-16** — 5-fold walk-forward (L3); weekly Saturday cadence (§6.1) |
| D14 | Feature-importance pruning thresholds | **RESOLVED 2026-05-16 Gap #24 Option D** — NO pre-prune, trust regularization. See §2.1.7 item 6 |
| D15 | Cross-instrument correlation features | Post-v2 (T7 swing or new task) |
| D16 | India VIX subscription decision | **RESOLVED 2026-05-16** — Dhan subscription confirmed by user; C3 ACCEPTED. See §2.1.4 |
| D17 | Migration trigger from TP-floor (Option B) to EV-floor (Option D) | After first v2 retrain — validate probability calibration on 5-day holdout, then promote |
| D53 | Replay backfill policy (was duplicate D2 — renumbered 2026-05-17) | **RESOLVED 2026-05-16 — Option A** (throw away old parquets, accumulate 30 sessions under new schema). Raw .ndjson.gz retained; reversible if decision changes. See §3.1 |
| D18 | Sim-PnL upgrade Option C → D (multi-scenario best/expected/worst) | After paper trading produces real fill data — calibrate "expected" slippage scenario from actual broker fills, then add best/worst envelope reporting. See PROJECT_TODO T9 |
| D19 | Recalibrate `slippage_pct_per_strike_distance` from real fills | After 100 paper fills per instrument. See PROJECT_TODO T10 |
| D20 | Upgrade slippage model Option B → C (volume-conditional) | After paper-trade liquidity patterns emerge. See PROJECT_TODO T11 |
| D21 | Upgrade walk-forward to stratified-by-regime (Sugg #5 Option C) | After L8 regime classifier is locked. Stratify holdouts to ensure mix of expiry/news/dull weeks across folds rather than random temporal slicing |
| D22 | Tune regime-flip debounce window (currently 3 min) and TP-reduction factor (currently 0.5) | After paper-trade data on how often regime flips reverse vs persist. May raise debounce to 5 min if L8 too noisy, or reduce factor to 0.3 if half-TP is too aggressive |
| D23 | Auto-feed trade-quality findings back to L4 gate tuning (§5.1 weekly report → θ_dir adjustments) | After 4-week paper-trade data accumulates and report patterns stabilize. Could be auto-suggestion or human-reviewed change |
| D24 | Pre-market check failure → auto-disable AI Live channel | If red on any check, should `ai-live` channel auto-set `trading_allowed=0` until manual reset, OR alert-only? Decide after paper-trade infrastructure stable |
| D25 | Tune per-head drift threshold (currently 10% AUC drop over 5d) | Per-head may need different thresholds — `trend_direction_*` is critical (tighter, e.g. 7%), `trend_breakout_imminent_*` rarer (looser, e.g. 15%). Calibrate after first month of drift_check data |
| D26 | Upgrade retrain cadence from weekly (C) to event-driven (D) | After 1 month of weekly retrains + drift detector proven reliable. Event-driven = retrain on (drift alarm OR major event OR weekly fallback) |
| D27 | Add real-time SHAP UI display per signal (upgrade Gap #15 C → D) | Operator-facing UI showing top-3 SHAP contributors per fired signal in the TradingDesk filtered-signals view. Cosmetic improvement after paper-trade workflow stable |
| D28 | `config/event_calendar.json` maintenance ownership + automation | Today maintained manually quarterly. Could auto-pull from NSE/MCX/SEBI/Fed/OPEC websites. Decide post-paper-trade based on miss rate of manual updates |
| D29 | Upgrade position-awareness Option B → C (full position-context features in L1) | When scaling beyond 1-lot AI Live cap, model needs to see "we're long N lots at strike X for Y minutes" as features — TFA + SEA refactor to push PortfolioAgent state into the feature pipeline |
| D30 | Upgrade model registry Option B → C (per-head audit trail) | Every promotion logged with reason, sim_pnl delta, promoter (human/auto). Weekly trade-quality report (§5.1) partially does this; promote to first-class audit log when retrain cadence stabilizes |
| D31 | Tune per-head regression threshold (currently uniform −5%) | Per-head thresholds may need calibration — critical heads (`trend_direction_*`) tighter (e.g. −3%), noisy heads (`trend_breakout_imminent_*`) looser (e.g. −10%). Calibrate after first month of retrain data showing typical week-over-week sim_pnl variance per head |
| D32 | Daily PnL reconciliation broker vs internal (Gap #16) | DEFERRED post-paper-trade phase. Implement after model + prediction + data collection + paper trading + retraining cycle stabilizes. Per-trade reconciliation (Option C) catches missed fills, commission errors, broker-internal drift |
| D33 | ~~Tune Wave 2 retirement threshold~~ | **OBSOLETE 2026-05-16 — Retirement logic removed by Gap #28 Option X (§8.4 revision). Scalp + Trend coexist permanently** |
| D34 | Revisit pruning if v2 model overfits | Gap #24 locked Option D (no pre-prune, trust regularization). If first-retrain shows train-AUC >> holdout-AUC at any head, escalate to two-stage A approach |
| D35 | Upgrade feature catalog Option C → D (per-feature importance + provenance) | After first v2 retrain, augment auto-generated catalog with per-feature importance scores + which models use each feature. Requires `scripts/extract_feature_importance.py` parser of `.lgbm` model_dump |
| D37 | Add quantile heads for TP/SL distribution (L4 D4 Option B) | If point-estimate SL × 1.3 multiplier proves insufficient or too conservative post-paper, train 15 quantile heads (25/50/75 percentile × 3 horizons) and switch SL to 25-percentile, TP to 50-percentile. Adds 60 model files (×4 instruments), ~25% more retrain compute |
| D38 | Tune SL safety multiplier (currently 1.3×) | Per-instrument calibration after first month of paper trade — actual drawdown vs predicted drawdown ratio per signal informs whether 1.3 too tight/loose |
| D39 | Recalibrate `cost_floor_buffer_pct` per instrument from real fills | After 100 paper fills per instrument. Compare actual minute-wick width vs the buffer assumption; tighten if buffer over-protects, loosen if noise wicks break "winners" |
| D40 | Recalibrate noise-floor per instrument from accumulated data | After ≥30 sessions accumulated, compute 95th-percentile of 1-min wick size per instrument; adjust noise-floor if defaults are mis-tuned. Same recalibration triggers L2 target relabeling |
| D41 | Per-instrument LightGBM hyperparameter override | If walk-forward shows systematic overfitting on one instrument (train AUC > holdout AUC by >0.10), tune per-instrument override of L3 D2 defaults. Only after first month of paper trade |
| D42 | Dynamic TP/SL (recalculate from rolling predictions) | If trade-quality report (§5.1) shows static TP/SL leaves significant edge on table (e.g., trends keep running after TP hit), upgrade L5 D2 from static to hybrid (static SL + dynamic TP) |
| D43 | Per-instrument rolling DD halt | If channel-level rolling DD halts too often due to one bad instrument dragging others, add per-instrument rolling DD tracking + per-instrument halt |
| D44 | Always-enforced safety list (cannot be disabled by L7 D4 toggle) | Locked initial list: tier-1 event blackouts, broker WS cap, pre-market sanity-check fail, **expiry-day 14:30 IST entry cutoff (L7 D5)**. Add to list if discovered post-paper that other limits must always apply regardless of channel |
| D45 | Recalibrate `daily_loss_limit` + `max_signals_per_day` per instrument | After first month of paper PnL: set `daily_loss_limit` to ~2× the 90th percentile of daily losses observed; set `max_signals_per_day` to 1.5× median observed |
| D46 | Correlation-aware portfolio aggregation (upgrade L6 D3 B → C) | After 3 months of paper data, compute pairwise correlation of daily returns (NIFTY-BANKNIFTY likely high; MCX commodities lower). Adjust portfolio cap formula to weight correlated pairs |
| D47 | Per-instrument L8 threshold override + learned regime classifier | If paper data shows (a) one instrument's ADX baseline systematically differs from default 25/15 thresholds, OR (b) §5.1 trade-quality report shows ≥20% of losers exit on regime-mis-tagged conditions over 4 weeks → add per-instrument thresholds AND/OR train learned LightGBM regime head. See T17 |
| D36 | Doc role separation: V2_MASTER_SPEC vs PROJECT_TODO | **RESOLVED 2026-05-16 — Non-issue. V2_MASTER_SPEC is active design+dev plan (§2.0 layer status). PROJECT_TODO is parking lot for deferred tasks (T-list). Distinct purposes by design — no mirroring needed. During v2 design work, anything decided to be done later → add to PROJECT_TODO as new T-entry** |
| D54 | Revisit single-pass pruning (Gap #24 D) if overfit observed (was duplicate D34 — renumbered 2026-05-17; also overlaps with D34 above) | If first model's training AUC ≫ holdout AUC (e.g., gap > 0.10), pivot to Option A (post-train prune + retrain) and tighten regularization further. NOTE: this restates D34; both kept until next cleanup pass to preserve cross-references |
| D48 | B5 Additional S/R features (added 2026-05-17) | **RESOLVED 2026-05-17 by Partha — L1 RE-LOCKED.** 8 features added (prior-day H/L, opening range H/L, round number above/below, 5-day swing H/L). §2.1.7 item 9 sub-decisions all locked. Expected: +3-5pp AUC on long-horizon targets |
| D49 | Trend bias filter (added 2026-05-17 §2.4) | **RESOLVED 2026-05-17 by Partha.** Asymmetric pre-combinator filter added to §2.4. D50 sub-decisions resolved with defaults. Expected: 2-3pp win-rate boost on filtered trades |
| D50 | Trend bias filter sub-decisions (sub of D49) | **RESOLVED 2026-05-17 by Partha.** `θ_bias_bullish=0.65`, `θ_bias_bearish=0.35`, asymmetric (trend vetoes scalp only), no magnitude floor on activation. **Follow-up:** validate thresholds after first month of paper trade; if too restrictive raise to 0.70/0.30, if too permissive narrow to 0.60/0.40 |
| D51 | Opening range window length (B5 sub-decision) | **RESOLVED 2026-05-17 by Partha.** N=15 minutes (NSE-traditional). One global value across all instruments |
| D52 | Round number step per instrument (B5 sub-decision) | **RESOLVED 2026-05-17 by Partha.** nifty50=100 pts, banknifty=100 pts, crudeoil=5 INR, naturalgas=1 INR. Coarser steps preferred (fewer near-round-number false positives) |

---

## 10. Layer lock definitions

Each layer goes from sketch → IN-PROGRESS → LOCKED. **LOCKED** requires:

1. **All open items resolved** — every "Open for deep dive" / "Decisions still required" bullet in the layer's section has a concrete decision recorded.
2. **Per-instrument numbers filled** — §7 row complete for that layer's contribution (noise_floor, slippage%, daily_loss_limit, max_signals/day, etc. as applicable). No "(TBD)" or "(proposed)" placeholders.
3. **Acceptance/defer/reject explicit** — for layers with feature candidate tables (e.g., §2.1.4 C blocks), every row tagged ACCEPT / DEFER (→ T-task ID) / REJECT (→ §2.1.5 skipped reason).
4. **Cross-layer dependency check** — any numbers the layer borrows from sibling layers (e.g., L1 noise floors used by L2 labeling) are also at LOCKED status, not IN-PROGRESS.
5. **Date-stamped sign-off** — layer's status header reads `Status: LOCKED YYYY-MM-DD by <approver>` (e.g., `LOCKED 2026-05-30 by Partha`). Audit trail for "what was decided when."

A layer cannot ship to code implementation (T3 phases) until LOCKED.

A layer can be re-opened (LOCKED → IN-PROGRESS) only by explicit decision recorded in §9 (new D-entry) with reason for re-opening.

This template applies to all 8 layers identically.
