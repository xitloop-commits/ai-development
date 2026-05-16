# Target Spec v2 — Trend Capture Design

**Status:** DESIGN (not implemented)
**Author:** Claude + Sarathi
**Date:** 2026-05-15
**Supersedes (partially):** the Wave 2 target spec (`project_phase1_target_spec_lock`)
**Linked memory:** [trend-capture-required](.../memory/project_trend_capture_required.md)

## 1. Why this exists

The Wave 2 model (targets at 60-300s, magnitude ~5-9 INR) is verified to be a microstructure scalp predictor. Validated empirically 2026-05-15:

- 9/9 scalp signals on 2026-04-30 / 2026-05-11 were directionally correct
- BUT 5-7 pt captures are within nifty50's normal noise (8-15 pt wicks per minute)
- The 85-pt sustained move 10:50-11:20 on 2026-05-11 produced ZERO signals
- 180s gate variant achieved 40-55% win rate — statistical noise, no real edge

User mandate: **trades must live MINUTES with TP/SL above the noise floor (>20 pts).**
Current model architecture cannot satisfy this — targets are too short and too small.

## 2. Success criteria for the v2 model

A v2 model is acceptable for paper trading if:

- 2-5 trend signals per instrument per session
- Hold time: 5-25 minutes
- Predicted magnitude: ≥25 INR points (above noise)
- Win rate ≥55% across 100+ trades on out-of-sample data
- Per-trade expectancy (after slippage estimate): ≥+8 INR points
- Holdout-protected validation across at least 4 weeks of unseen sessions

## 3. New target horizons

Replace short horizons with mid-to-long horizons. KEEP the existing Wave 2 targets — they're a valid secondary scalp layer; we are adding, not replacing.

### Trend horizons (NEW)
| Window | Use case |
|---|---|
| 600s (10 min) | Quick trend trade (entry on momentum confirmation) |
| 900s (15 min) | Standard trend trade |
| 1800s (30 min) | Sustained-trend trade (rare, high conviction) |

### Why these and not others
- 5 min was already tested as `direction_300s` — magnitude maxes at ~9 pts. Too short.
- 60 min crosses session-half boundaries (lunch dip, close volatility), labels get noisy.
- 10/15/30 are the windows actual intraday traders watch on charts.

## 4. New target types per window

For each `{600,900,1800}s` window, emit:

| Target name | Type | Definition |
|---|---|---|
| `trend_direction_{w}s` | binary | 1 if `spot(t+w) > spot(t) + noise_floor`, else 0 (noise_floor=8 pts) |
| `trend_magnitude_{w}s` | regression | `spot(t+w) - spot(t)` (signed) |
| `trend_max_excursion_{w}s` | regression | `max(spot(t..t+w)) - spot(t)` (CE-leg style, but on spot) |
| `trend_max_drawdown_{w}s` | regression | `spot(t) - min(spot(t..t+w))` |
| `trend_continues_{w}s` | binary | 1 if direction at `t+w` matches dominant direction of `[t-300s, t]` window AND magnitude ≥ noise floor |
| `trend_breakout_imminent_{w}s` | binary | 1 if max excursion in `[t, t+w]` ≥ 25 pts (above noise floor) |

That's **6 targets × 3 windows = 18 new model heads** per instrument.

### Why a noise floor in the labels

Current `direction_60s` labels any positive move as "1." A +2 pt move and a +50 pt move both train as "up." That's why the model predicts near base rate — labels don't differentiate signal from noise.

Adding `noise_floor=8 pts` (tuned per instrument) labels only **economically significant** moves. The model now learns to distinguish "real move vs nothing" instead of "any drift up vs any drift down."

## 5. New input features (multi-timeframe context)

The current 370 features are tick-level. To predict 10-30 min trends, the model needs to see what humans see on a chart:

### MA structure (5 new features per timeframe)
- `ma_5_1min`, `ma_20_1min` — 1-minute candle MAs
- `ma_5_5min`, `ma_20_5min` — 5-minute candle MAs
- `ma_5_15min` — 15-minute fast MA
- Each as `(spot - ma) / spot` ratio (scale-invariant)

### Trend strength (3 new features)
- `adx_5min` — 14-period ADX on 5-min candles
- `momentum_5min` — close[now] / close[5min ago]
- `momentum_15min` — close[now] / close[15min ago]

### Higher-timeframe structure (4 new features)
- `dist_from_session_open_pct`
- `dist_from_session_vwap_pct`
- `session_high_age_min` — minutes since current session high
- `session_low_age_min` — minutes since current session low

### Multi-bar pattern (3 new features)
- `consecutive_higher_highs_5min` — count
- `consecutive_higher_lows_5min` — count
- `range_compression_ratio` — current 5-min range / avg 20-bar 5-min range

**Total: ~15 new input features** added to TFA's tick processor. Existing 370 stay.

## 6. Training methodology changes

| Item | Wave 2 (current) | v2 (proposed) |
|---|---|---|
| LightGBM `scale_pos_weight` | not set (defaults to 1.0) | Set per target = `n_neg / n_pos` of training set |
| Cost-aware scoring | none | Post-hoc: simulate slippage 1-2 pts per fill in training metric report |
| Min training data | 9 sessions (current) | ≥30 sessions (block retrain until reached) |
| Holdout strategy | last_n_per_instrument, n=1 | last_n_per_instrument, n=5 (full trading week) |
| Validation metric | val_auc only | val_auc + simulated-PnL on holdout (after fees) |

## 7. Schema impact

### TFA writes
- 15 new input feature columns → parquet schema grows from ~370 to ~385
- 18 new target columns → parquet grows by 18 cols
- Total parquet column count: ~440 (was ~400 with Wave 2)
- Per-row size up ~12%. Storage cost negligible.

### MTA writes
- 18 new `.lgbm` model files per instrument (78 total vs current 60)
- Model storage: ~5-7 MB per instrument total (was 4-5 MB). Negligible.

### SEA reads
- `_gather_predictions` extends to include new keys
- New gate function `decide_action_trend` lives alongside `decide_action_wave2`
- Per-instrument config `sea_thresholds/<inst>.json` adds a `"trend"` block

### Launcher
- No changes needed — auto-detects new targets via parquet schema
- Pending counts could surface trend-stage progress but optional

## 8. Migration path (don't break existing scalp)

Phased, reversible:

### Phase 1 — Design lock (now, no code)
- THIS document reviewed
- Noise-floor values picked per instrument
- Success criteria signed off

### Phase 2 — TFA feature additions (1-2 days code)
- Add the 15 new input features to `tick_feature_agent`
- Keeps existing 370 untouched
- Live TFA emits new columns AND old ones to live.ndjson
- Replay backfills new features into existing parquets (replay-only change, no retrain yet)
- Existing Wave 2 model still works (ignores new columns it wasn't trained on)

### Phase 3 — Target additions (1 day code)
- Add the 18 new target columns to `targets.py`
- Re-replay all parquets to populate them
- Existing 60 Wave 2 targets stay populated

### Phase 4 — Auto-record accumulation (~30 days, no code)
- Mon-Fri scheduler already runs (validated 2026-05-15)
- Live tick collection accumulates ~5-6 sessions/week
- Wait until ≥30 sessions exist before retraining

### Phase 5 — Retrain with combined targets (hours of code, hours of compute)
- MTA gains `scale_pos_weight` flag
- Trains all 78 heads (60 Wave 2 + 18 trend) per instrument
- Holdout: last 5 days reserved (n=5)

### Phase 6 — Trend gate + smoke (1 day code)
- `decide_action_trend` in SEA
- Smoke validates on holdout days using the chart-inspection method from 2026-05-15
- Per-instrument config opt-in: `gate_mode: "trend"` or `"wave2+trend"` for ensemble

### Phase 7 — Paper trade
- Combined Wave 2 (scalp, backup) + v2 (trend, primary)
- Per `[project_journey_strategy]` — small position size first, scale based on actual performance

## 9. Risks and what we don't know yet

| Risk | Mitigation |
|---|---|
| 30 sessions still too thin for 30-min trends (rare events) | If retrain shows AUC < 0.55 on trend targets, wait longer; or use synthetic augmentation |
| Multi-TF features don't add signal (model ignores them) | Feature importance analysis post-train; remove low-importance to reduce overfitting |
| Trend gate also produces ~50% win rate | Try class weights more aggressively; revisit noise-floor threshold; consider regime classifier |
| Live distribution shifts from training distribution | Walk-forward retrain every 2 weeks once paper trading starts |

## 10. What this design EXPLICITLY does not do

- Does **not** drop the existing Wave 2 scalp model. Keep it as a backup signal layer.
- Does **not** add regime classification (separate P3 work — Phase 7+).
- Does **not** add position sizing logic (separate P3 work).
- Does **not** add ensembling with other model architectures (separate P4 work).
- Does **not** change the LightGBM choice — same tooling, same training loop, just better targets and params.

## 11. Effort estimate

| Phase | Code time | Wall time |
|---|---|---|
| 1. Design lock | 0 (this doc) | ~2 hours review |
| 2. TFA features | 1-2 days | 2 days |
| 3. Target additions | 1 day | 1 day |
| 4. Data accumulation | 0 | ~30 days (passive) |
| 5. Retrain | 4 hours | 1 day |
| 6. Trend gate + smoke | 1 day | 1 day |
| 7. Paper trade ramp | 0 | weeks |
| **Total active work** | **~5-7 days** | **~30 days incl. data wait** |

## 12. Next action

If this design is accepted: start Phase 2 (TFA feature additions). All new features can be added to the existing schema without breaking Wave 2 model loading.

If parts need revision: edit this doc and reconsider before any code changes.