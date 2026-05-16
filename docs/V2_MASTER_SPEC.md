# V2 Master Spec — Signal System v2 (Single Source of Truth)

**Status:** DRAFT (consolidation pass · 2026-05-16) · sections 1, 2.1 IN-PROGRESS · sections 2.2–2.8 SKETCH · sections 3–8 PLANNED
**Supersedes:** `SIGNAL_SYSTEM_V2.md`, `TARGET_SPEC_V2_DESIGN.md`, `REFERENCE.md`, `LAYER1_CANDIDATES.md` (delete pending)
**Companion (separate, kept):** `PROJECT_TODO.md` (T2/T3/T7 references this doc), `CLAUDE.md` (links updated), `PARTHA_RULES.md`, `DHAN_TOKEN_POLICY.md`, `JOURNEY_STRATEGY.md`, `WAVE2_RESUMPTION_GUIDE.md`

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
| 6 | Larger holdout (n=5 days) | Single-day holdout is noisy. 5 days covers Mon–Fri regime variation. | Doesn't improve the model — improves our verdict reliability. |
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
| 1 | Input features | IN-PROGRESS (candidates listed; decisions pending) | §2.1 |
| 2 | Target labels | LOCKED-CANDIDATE (from TARGET_SPEC §3–4) | §2.2 |
| 3 | Model architecture | LOCKED-CANDIDATE (from TARGET_SPEC §6) | §2.3 |
| 4 | Gate logic | SKETCH | §2.4 |
| 5 | Trade management | SKETCH | §2.5 |
| 6 | Position sizing | SKETCH | §2.6 |
| 7 | Risk controls | SKETCH | §2.7 |
| 8 | Regime / meta | SKETCH | §2.8 |

Suggested deep-dive order: **4 → 5 → 7 → 6 → 8 → revisit 1–3.** Rationale: L4 unblocks paper-trade gate; L5 defines TP/SL semantics L4 depends on; L7 (risk caps) must exist before any live capital; L6 (sizing) needs L7 caps; L8 (regime) is enhancement on working baseline; L1–L3 only revisit if L4–L8 surface a gap.

---

### 2.1 Layer 1 — Input features (IN-PROGRESS)

**Goal:** lock the input feature set to be emitted by TFA per tick. Currently the v2 plan extends the existing 377-column live schema with multi-TF context + brainstorm additions, capped by feature-importance pruning post-retrain.

#### 2.1.1 Totals at a glance

| Bucket | Count |
|---|---|
| A. Live in parquet today | **377** |
| B. v2-plan multi-TF additions | **15** |
| C. Brainstorm additions | **48** |
| **All-accepted ceiling** | **440** |
| Realistic post-L1-lock + 40% pruning | **~265–295** |

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

#### 2.1.4 C — Brainstorm additions (48, candidates)

| Group | Count | Features | Why new |
|---|---|---|---|
| C1 OI / S/R dynamics | 10 | `oi_weighted_{ce_resistance,pe_support}_strike`, `{ce,pe}_wall_strength_rel`, `{ce,pe}_oi_change_{5,15}min_pct`, `oi_dominance_streak_min`, `pcr_intraday_slope_30min` | Existing OI features are snapshot/per-tick only — windowed deltas + weighted strikes + streak duration are gaps |
| C2 Classic technical | 8 | `rsi_14_{5,15}min`, `macd_5min`, `macd_signal_5min`, `macd_histogram_5min`, `volume_price_divergence_5min`, `ma_cross_event_5min`, `breakout_event_5min` | Not in existing 370. RSI/MACD on bar-aggregated data is genuinely new |
| C3 India VIX (conditional) | 2 | `india_vix`, `india_vix_change_5min` | Requires Dhan India VIX subscription |
| C4 Dealer hedging / gamma exposure | 5 | `net_gex`, `gamma_flip_distance_pct`, `dealer_net_delta`, `charm_estimate_atm`, `vanna_estimate_atm` | Highest-edge addition for Indian indices. `gamma_flip_distance_pct` likely a major regime predictor. Fully computable from existing chain + greeks |
| C5 Exhaustion / trend age | 4 | `trend_age_ticks`, `momentum_deceleration`, `premium_acceleration_drop`, `volume_no_move_score` | State-tracking features (trend_age, absorption) genuinely missing; supports L5 exits |
| C6 Intraday time structure | 3 | `minutes_from_open`, `minutes_to_close`, `lunch_session_flag` | Trivial cost, missing today (only normalized `session_remaining_pct` exists) |
| C7 Strike migration intelligence | 5 | `active_strike_shift_direction`, `active_strike_shift_velocity`, `active_strike_rotation_score`, `atm_to_otm_flow_ratio`, `strike_migration_persistence` | Current `active_*` block is snapshot only; doesn't track rotation |
| C8 Premium VWAP intelligence | 4 | `atm_ce_premium_vwap_dist`, `atm_pe_premium_vwap_dist`, `premium_vwap_cross_strength`, `premium_vwap_reclaim_count` | Premium VWAP diverges from spot VWAP due to IV + theta — directly relevant for option trades |
| C9 IV expansion velocity | 4 | `iv_change_{1,5}min`, `iv_skew_velocity`, `iv_expansion_without_spot` | Current IV is snapshot only; missing time-derivative |
| C10 Max Pain | 3 | `max_pain_strike`, `distance_to_max_pain_pct`, `max_pain_gravity_strength` | Approved 2026-05-16. Important for 4 traded instruments around expiry. L4 weights conditionally when `days_to_expiry ≤ 2` |

**C subtotal: 48**

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

1. Noise-floor per instrument: nifty50=8 locked; **banknifty / crudeoil / naturalgas placeholders** (25 pts / 5 INR / 3 INR proposed)
2. Accept / defer / reject each of 48 brainstorm candidates
3. Confirm B-block 15 features as-is or modify
4. Scaling: `(spot − feature) / spot` ratio for prices/MAs/VWAP; raw [0,100] for ADX/RSI
5. Replay backfill: re-replay all 10 sessions to populate new columns (hours of one-time compute)
6. Feature-importance pruning post-retrain: drop bottom-40% by gain + SHAP clustering + correlation clustering + temporal importance stability testing (mandatory — 437-ceiling needs aggressive prune)
7. Per-instrument config location: `config/instrument_profiles/<inst>.json` vs new `config/feature_flags/<inst>.json`
8. Whether to drop the 10-min trend target (600s) → would reduce 13 horizons to 12

#### 2.1.8 Compute / latency / storage cost

| Resource | Impact |
|---|---|
| Per-row storage (parquet) | +20% vs today (377 → ~440 input cols + 18 trend targets) |
| TFA hot-path latency | Profile after each feature group; if > 50ms/tick, defer |
| Replay backfill (one-time) | Hours of compute to re-populate existing parquets |
| Bar buffers TFA maintains | 4 tick buffers + 3 bar buffers (1m/5m/15m) + 1 session buffer = 8 buffer types |

---

### 2.2 Layer 2 — Target labels (LOCKED-CANDIDATE)

**v2 direction:** keep existing 60 Wave-2 heads (60/300s scalp). Add **18 trend targets = 6 types × 3 horizons** {600s, 900s, 1800s}. Critical: directions labeled positive only when `|Δspot| ≥ noise_floor`.

#### 2.2.1 Trend horizons

| Window | Use case |
|---|---|
| 600s (10 min) | Quick trend trade (entry on momentum confirmation) — candidate to drop per §2.1.7 |
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

**Total new target columns: 6 × 3 = 18** (if all 3 trend horizons kept).

#### 2.2.3 Why the noise floor in labels

Current `direction_60s` labels any positive move as "1." A +2 pt and a +50 pt move both train as "up" → model predicts near base rate. Adding `noise_floor=8 pts` (per instrument) labels only **economically significant** moves. Model learns "real move vs nothing" instead of "drift up vs drift down."

#### 2.2.4 Open items

- Per-instrument noise-floor calibration (only nifty50=8 locked; others TBD)
- Whether to add 60-min horizon if 30-min trends look promising
- Whether to drop 600s (10-min) horizon

---

### 2.3 Layer 3 — Model architecture (LOCKED-CANDIDATE)

**v2 direction:** keep LightGBM. Add `scale_pos_weight = n_neg / n_pos` per target. Validation metric becomes `val_auc + simulated-PnL on holdout after fees`. Holdout grows from `last_n=1` to `last_n=5` (full week reserved).

#### 2.3.1 Training methodology changes

| Item | Wave 2 (current) | v2 (proposed) |
|---|---|---|
| LightGBM `scale_pos_weight` | not set (defaults to 1.0) | Set per target = `n_neg / n_pos` of training set |
| Cost-aware scoring | none | Post-hoc: simulate slippage 1–2 pts per fill in training metric report |
| Min training data | 9 sessions | ≥30 sessions (block retrain until reached) |
| Holdout strategy | `last_n_per_instrument, n=1` | `last_n_per_instrument, n=5` (full trading week) |
| Validation metric | `val_auc` only | `val_auc + simulated-PnL` on holdout (after fees) |

#### 2.3.2 Model heads

- Wave 2: 60 heads per instrument (unchanged)
- v2 trend: 18 new heads per instrument
- **Total: 78 heads × 4 instruments = 312 LightGBM models**

#### 2.3.3 Open items

- Single multi-output booster vs 78 separate boosters (compute trade-off)
- Feature-importance-based pruning policy (see §2.1.7)
- Walk-forward retrain cadence (every 2 weeks once paper trading starts)
- LightGBM at 500-feature scale: trivial (~1.5 GB train memory, sub-ms inference) — no concern

---

### 2.4 Layer 4 — Gate logic (SKETCH)

**What it is:** per-tick decision function in SEA that converts the 18 trend-head predictions into "emit a trade signal now / don't" — with TP/SL.

**v2 sketch:** AND-gate `decide_action_trend(predictions, regime)` emits only when **all** of:
- `trend_direction_900s` prob ≥ θ_dir (per-instrument)
- `trend_magnitude_900s` ≥ 25 pts
- `trend_max_drawdown_900s` ≤ 15 pts (predicted SL below cap)
- Cooldown since last signal ≥ 5 min
- Regime from L8 is "trend-permissive"

TP/SL come from predicted magnitude / max-drawdown, not fixed levels.

Per-instrument config opt-in: `gate_mode: "wave2"` (legacy) / `"trend"` (v2 only) / `"wave2+trend"` (ensemble).

**Open for deep dive:**
- θ_dir tuning (precision-at-K vs F1 vs simulated-PnL)
- Dwell-time (must signal persist N ticks?)
- Priority when both Wave 2 and trend gates fire on same tick
- What predictions feed TP/SL (point estimates vs quantile heads)
- Max Pain weighting: only when `days_to_expiry ≤ 2`
- Brokerage + STT cost floor must be incorporated in TP target (Charges_Spec §3.X — TP must clear cost+slippage)

---

### 2.5 Layer 5 — Trade management (SKETCH)

**What it is:** what happens between signal-emit and position-close — TP/SL, trailing, time-stops, partials.

**v2 sketch — Hybrid static + time + trail:**
- Entry: static TP from `trend_magnitude_900s`, static SL from `trend_max_drawdown_900s`
- Time-stop at `min(predicted_horizon, 1800s)` regardless of P&L
- After 50% of TP distance reached, activate per-minute trailing stop at `entry + 50% × magnitude_remaining_to_TP`
- No partial profit-taking in v1 — full position out at TP / SL / time / trail-stop

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

**Open for deep dive:**
- Trail trigger formula precision
- Lock TP/SL at entry vs recalculate from rolling predictions
- Re-entry rules after stop-out on still-strong signal
- Broker fill-quality assumptions (limit vs market)

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

**Open for deep dive:**
- `daily_risk_budget` composition with account equity (% of equity vs fixed INR)
- Signal-confidence weighting (size up on high-prob predictions?)
- Portfolio-level concurrent-position risk aggregation
- Whether to size differently for `wave2` vs `trend` gate outputs

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

**Event-driven blackout windows:**
- RBI policy days (calendar-based)
- Major macro release days (CPI, GDP, Fed FOMC, US NFP)
- Earnings of index-heavy stocks (only if material to index — defer)

All limits checked **before** L6 sizing → tripped limit blocks trade entirely.

**Two-account architecture interaction:**
- L7 risk controls must respect per-channel budgets (`my-live`, `ai-live`, `ai-paper` have separate capital pools)
- AI live: 1-lot cap per trade until 30-day head-to-head positive vs `my-live`

**Open for deep dive:**
- Kill-switch event hooks (Slack/email on halt)
- Reset cadence (daily / weekly / manual)
- Max drawdown over rolling N days as halt trigger
- Paper vs live limit divergence
- Expiry-day special handling (dealer hedging dominates)

---

### 2.8 Layer 8 — Regime / meta (SKETCH)

**What it is:** classifies current market state, gates which signals are allowed in which states.

**v2 sketch — 3-state classifier `{trend, range, chop}` from rules first:**
- `trend` if ADX-5min ≥ 25 AND `consecutive_higher_highs_5min ≥ 3` (or symmetric down)
- `chop` if `range_compression_ratio < 0.6` AND ADX < 15
- `range` otherwise

L4 gate reads this — only emits trend signals in `trend` regime (initially). Wave 2 scalp can run in `range` or `chop` as future ensemble.

**Categorical "market controller" tag** (derived from existing bull/bear scores):
- `bulls_in_control` if `call_put_oi_diff` bullish sign for ≥10 min AND `pe_wall_strength_rel > ce_wall_strength_rel`
- `bears_in_control` mirror
- `contested` otherwise

L4 gate respects this: hard veto on counter-trend signals (no LONG when `bears_in_control`; no SHORT when `bulls_in_control`).

**Expiry-day regime modulator:** C4 GEX features matter most on expiry days (Thursday for NIFTY, monthly for others). L8 should up-weight GEX inputs to L4 on those days.

Rule-based first because labels for a learned regime classifier are circular (you'd label them using the same trend definition).

**Open for deep dive:**
- Thresholds tuning
- Time-of-day regime priors (open volatility vs midday range vs close)
- Look-ahead avoidance
- Whether to add second LightGBM head trained on hand-labeled regime windows
- How regime transitions interact with open positions (close on regime change?)

---

## 3. Schema impact

| Layer | Before | After (all accepted) |
|---|---|---|
| Input cols | 377 | 440 |
| Wave 2 target cols (default 2 windows, 12 types incl. Wave 2) | 25 | 25 (unchanged) |
| Trend target cols (3 windows × 6 types from L2) | 0 | 18 |
| **Total parquet width** | 402 | ~483 |
| Per-row storage | baseline | +20% |
| LightGBM models per instrument | 60 | 78 (60 Wave 2 + 18 trend) |
| LightGBM models total (× 4 instruments) | 240 | 312 |

---

## 4. Component spec deltas

### 4.1 TickFeatureAgent (current: v1.7 → bump v1.8)

- +15 multi-TF features (B block §2.1.3)
- +48 brainstorm features (C block §2.1.4)
- Bar buffers: 1-min, 5-min, 15-min OHLCV (rolling 14–30 bars each)
- Tick buffers (existing): 5, 10, 20, 50
- Session buffer (premium VWAP, high/low age tracker)
- Output schema: 440 input cols (was 377)
- Affected file: `python_modules/tick_feature_agent/output/emitter.py` `_build_column_names()`

### 4.2 ModelTrainingAgent (current v0.1 → bump v0.2)

- +18 trend target heads
- `scale_pos_weight = n_neg / n_pos` per target
- Holdout `last_n = 5`
- Validation metric: AUC + simulated-PnL on holdout after fees
- Total heads 60 → 78 per instrument

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
| Journal_Spec_v0.1 | Record `gate_mode` per trade for head-to-head analysis |
| HeadToHead_Spec_v0.1 | Wave2 vs trend gate vs ensemble comparison rows |

---

## 6. Implementation phases (T3 in PROJECT_TODO)

| Phase | Description | Code time | Wall time |
|---|---|---|---|
| 1 | Design lock (this doc) | 0 | ~brainstorm sessions per layer |
| 2 | TFA feature additions (B + C blocks) | 1–2 days | 2 days |
| 3 | Target additions (18 trend targets) | 1 day | 1 day |
| 4 | Auto-record accumulation (≥30 sessions) | 0 | ~30 days passive |
| 5 | Retrain all 4 with combined targets (78 heads each) | 4 hours | 1 day |
| 6 | Trend gate + smoke + L7 risk controls + L6 sizing | 2–3 days | 2–3 days |
| 7 | Paper trade ramp (ai-paper channel) | 0 | weeks |
| 8 | AI Live transition (per canary spec) | 0 | per head-to-head result |

**Total active work: ~6–9 days · Wall time: ~30+ days including data wait**

---

## 7. Per-instrument numbers (placeholders, TBD)

| Instrument | Noise floor | Lot size | Daily loss limit | Max signals/day |
|---|---|---|---|---|
| nifty50 | **8 pts** (LOCKED) | 75 | TBD | TBD |
| banknifty | 25 pts (proposed) | 30 | TBD | TBD |
| crudeoil | 5 INR (proposed) | 100 | TBD | TBD |
| naturalgas | 3 INR (proposed) | (TBD) | TBD | TBD |

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

---

## 9. Pending decisions (consolidated)

| # | Decision | Resolves in |
|---|---|---|
| D1 | Banknifty / crudeoil / naturalgas noise floors | L1 lock |
| D2 | Accept/defer/reject each of 48 brainstorm L1 candidates | L1 lock |
| D3 | Drop 600s (10-min) trend target? | L2 lock |
| D4 | θ_dir threshold per instrument | L4 lock |
| D5 | Dwell-time requirement for signal | L4 lock |
| D6 | Trail trigger formula | L5 lock |
| D7 | Lock TP/SL at entry vs recalculate | L5 lock |
| D8 | `daily_risk_budget` formula | L6 lock |
| D9 | Daily-loss-limit per instrument | L7 lock |
| D10 | Max concurrent positions cap | L7 lock |
| D11 | Regime thresholds (ADX, range-compression) | L8 lock |
| D12 | Whether to drop Wave 2 entirely after v2 proves out | Post-paper-trade |
| D13 | Walk-forward retrain cadence | L3 lock |
| D14 | Feature-importance pruning thresholds | Post-retrain |
| D15 | Cross-instrument correlation features | Post-v2 (T7 swing or new task) |
| D16 | India VIX subscription decision | L1 lock |
