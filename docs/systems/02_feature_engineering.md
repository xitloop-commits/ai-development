# 02 — Feature Engineering

Single source of truth for the **TickFeatureAgent (TFA)** — the module that turns raw Dhan ticks into the **446 L1 feature columns + 24 L2 target columns** that drive every model and signal downstream.

## 1. Purpose & Scope

**In scope:**
- Tick buffers (50-tick underlying + 10-tick per-strike option) and bar aggregators (1m / 5m / 15m).
- All 446 L1 feature columns across blocks A (377), B (23), C (46).
- All 84 L2 target columns: 60 scalp (option-leg aware) + 12 trend + 12 swing (spot-based).
- Schema-version handoff to the model trainer (writes `config/schema_registry/v<N>.json`).
- Live emitter (one row per tick → socket + NDJSON) and replay emitter (per-session parquet).

**Out of scope:**
- WebSocket connection / recorder / binary parsing → [01 Data Ingestion](01_data_ingestion.md).
- Model training, calibration, sim-PnL → [03 Model Training](03_model_training.md).
- Per-tick inference, gate logic, trade management → [04 Signal Engine](04_signal_engine.md).

## 2. Architecture at a glance

One Python process per instrument, four in parallel (nifty50 / banknifty / crudeoil / naturalgas). Each owns its own Dhan WebSocket + its own feature pipeline + its own emitter. Single asyncio event loop runs the WS subscription, the 5-second HTTP chain poller, and per-tick feature compute.

```
Dhan WS (binary)          chain REST (5s poll)
     │                            │
     ▼                            ▼
┌────────────────────────────────────────────────┐
│ tick_buffer (50)  +  option_buffer (10 × strike) │
└────────────────────────────────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────┐
        │   33 feature modules (8 blocks)   │
        │   underlying / option_tick /   │
        │   chain / active_strikes /     │
        │   compression / decay / zone / │
        │   regime / time_to_move /      │
        │   ofi / realized_vol / bars /  │
        │   multi_tf / opening_range /   │
        │   levels / intraday_time /     │
        │   india_vix / event_calendar / │
        │   expiry / dealer_hedging /    │
        │   premium_vwap / exhaustion /  │
        │   oi_dominance / greeks / etc. │
        └──────────────────────────────┘
                       │
                       ▼
            output/emitter.py
       ┌─────────────┴───────────────┐
       ▼                             ▼
 live: socket + NDJSON      replay: parquet per session
       │                             │
       ▼                             ▼
  04 Signal Engine            03 Model Training
```

**Two modes, one code path.** `--mode live` runs ticks into the emitter and writes raw `.ndjson.gz` plus a live socket feed. `--mode replay` reads recorded `.ndjson.gz` files, runs them through the same emitter, and writes parquet for training. Same module set, same column layout — live ↔ train coherence is guaranteed by construction.

**State machine.** Each TFA carries a 4-state machine: `TRADING ↔ FEED_STALE ↔ WARMING_UP ↔ CHAIN_STALE`. A single Dhan WS carries both underlying ticks and all option ticks, so feed health gates both. Reconnect grace is 15–30 s per instrument profile.

## 3. The 446 L1 features

Three blocks, ordered by age in the spec.

### Block A — 377 columns (live since pre-v2)

| Group | Cols | Examples | Module |
|---|---|---|---|
| A0 timestamp | 1 | `tick_ts_ns` | emitter |
| A1 underlying base | 12 | `underlying_ltp`, `underlying_spread`, `momentum`, `velocity`, `returns_5/10/20/50` | `features/underlying.py` |
| A2 multi-TF extended | 20 | `momentum_5min/15min`, `velocity_5/20/50`, `realized_vol_5/20/50` | `features/underlying.py` + `realized_vol.py` |
| A3 ATM context | 3 | `atm_strike`, `strike_step`, `spot_to_atm_distance` | `features/atm.py` |
| A4 compression | 5 | `range_percent`, `volatility_compression`, `spread_tightening` | `features/compression.py` |
| A5 time-to-move | 4 | `stagnation_minutes`, `breakout_readiness`, `directional_persistence` | `features/time_to_move.py` |
| A6 option tick ATM±3 | 126 | per strike × CE/PE: `opt_X_ce_ltp`, `opt_X_ce_bid/ask`, `opt_X_ce_premium_momentum`, `opt_X_pe_*` | `features/option_tick.py` |
| A7 chain | 9 | `chain_pcr_global`, `chain_pcr_atm`, `total_ce_oi`, `total_pe_oi`, `oi_change_*` | `features/chain.py` |
| A8 active strikes | 144 | 6 slots × 24 cols (vol + OI top-3 union): `active_X_strike`, `active_X_call_strength`, `active_X_oi_concentration` | `features/active_strikes.py` |
| A9 cross-feature | 4 | `call_put_volume_diff`, `call_put_oi_diff` | `features/active_features.py` |
| A10 decay | 5 | `premium_decay`, `volume_drought`, `dead_market_score` | `features/decay.py` |
| A11 regime | 2 | `regime`, `regime_confidence` (TREND / RANGE / DEAD / NEUTRAL rule-based) | `features/regime.py` |
| A12 zone | 7 | `atm_zone_net_pressure`, `active_zone_dominance` | `features/zone.py` |
| A13 trading state | 4 | `data_quality_flag`, `is_market_open`, `state` | state machine |
| A14 metadata | 9 | `exchange`, `instrument`, `expiry_date`, `session_id` | `features/meta.py` |
| A15 levels | 8 | `day_high_distance`, `prev_day_high_distance`, `swing_5day_high` | `features/levels.py` (persisted via `state/levels_store.py`) |
| A16 Greeks | 9 | `atm_ce_delta`, `atm_gamma`, `atm_theta`, `atm_vega`, IV skew | `features/greeks.py` |
| A17 expiry | 5 | `days_to_expiry`, `session_pct_complete` | `features/expiry.py` |

### Block B — 23 columns (added Phase 2, schema v7, 2026-05-18)

Multi-timeframe context + structural levels.

- **B1 MA structure** (5 cols): `ma_5_1min`, `ma_20_1min`, `ma_5_5min`, `ma_20_5min`, `ma_5_15min` — `features/multi_tf.py`
- **B2 trend strength** (3 cols): `adx_5min`, `momentum_5min`, `momentum_15min` — `features/multi_tf.py`
- **B3 session relative** (4 cols): `dist_from_session_open_pct`, `session_high_age_min`, `session_low_age_min`, `session_range_pct` — `features/opening_range.py`
- **B4 multi-bar pattern** (3 cols): `consecutive_higher_highs`, `range_compression_5bar`, `inside_bar_count` — `features/bars.py`
- **B5 prior-day + opening range + 5-day swing** (8 cols): `distance_to_prev_day_high_pct`, `distance_to_opening_range_high_pct`, `swing_5day_*` — `features/levels.py` + cross-day state

### Block C — 46 ACCEPT + 8 DEFER (Phase 2 brainstorm, schema v7)

Locked 2026-05-17 per V2_MASTER_SPEC §2.1.4.

- **C1 OI dynamics** (12 cols): `oi_weighted_ce_resistance_strike`, `ce_wall_strength`, `pe_oi_change_60min`, `oi_dominance_streak`, `active_strike_rotation_score` — `features/oi_dominance.py` + `chain.py`
- **C2 technical** (5 cols): `rsi_14_5min`, `macd_histogram_5min`, `macd_signal_5min` — `features/technical.py`
- **C3 volatility regime** (2 cols): `india_vix`, `india_vix_change_5min` — `features/india_vix.py`
- **C4 dealer hedging** (5 cols): `net_gex`, `gamma_flip_distance_pct`, `charm_estimate_atm`, `vanna_estimate_atm` — `features/dealer_hedging.py`
- **C5 exhaustion** (2 cols): `trend_age_ticks`, `volume_no_move_score` — `features/exhaustion.py` + `time_to_move.py`
- **C6 intraday time** (3 cols): `minutes_from_open`, `lunch_session_flag`, `time_to_close_min` — `features/intraday_time.py`
- **C7 strike rotation** (3 cols): `active_strike_shift_direction`, `atm_to_otm_flow` — `features/active_strikes.py`
- **C8 premium VWAP** (3 cols): `atm_ce_premium_vwap_dist`, `atm_pe_premium_vwap_dist`, `vwap_reclaim_count` — `features/premium_vwap.py`
- **C9 IV velocity** (4 cols): `iv_change_5min`, `iv_expansion_without_spot` — `features/greeks.py`
- **C10 max pain** (3 cols): `max_pain_strike`, `distance_to_max_pain_pct`, `gravity_strength` — `features/levels.py`
- **C11 event calendar** (3 cols): `is_tier_2_event`, `event_type`, `hours_to_next_event` — `features/event_calendar.py`
- **C12 expiry bucket** (1 col): `days_to_expiry_bucket` (categorical) — `features/expiry.py`

**8 features DEFERRED** (locked at L1 D2, 2026-05-16): `rsi_14_15min`, `ma_cross_event_5min`, `breakout_event_5min`, `momentum_deceleration`, `premium_acceleration_drop`, `active_strike_rotation_score` (second variant), `strike_migration_persistence`, `premium_vwap_cross_strength`. Tracked as [T14 in PROJECT_TODO](../PROJECT_TODO.md) — add only if first-retrain SHAP shows existing features fail to capture the patterns.

## 4. The 84 L2 targets (for training only)

Live emits NaN for every target column; replay backfills end-of-day. Reason: trend/swing horizons go out to 7200 s (2 hours), so a live forward-buffer would consume too much memory.

### 60 scalp targets — option-premium aware

`features/targets.py`. 12 target types × 5 horizons (60 / 120 / 180 / 240 / 300 s):

`direction`, `magnitude`, `risk_reward`, `max_upside`, `max_drawdown`, `decay`, `direction_persists`, `breakout_in`, `exit_signal`, plus PE-leg variants (`max_upside_pe`, `max_drawdown_pe`) for SHORT trades. Side-aware because scalp trades the option premium directly: LONG (BUY CE) and SHORT (BUY PE) have different P&L geometries.

### 24 trend + swing targets — spot-based

`features/trend_swing_targets.py`. 6 types × 4 horizons:

- **Trend** (900 s / 1800 s = 15 / 30 min)
- **Swing** (3600 s / 7200 s = 1 / 2 hr)
- Types: `direction`, `magnitude`, `max_excursion`, `max_drawdown`, `continues`, `breakout_imminent`

Spot-based because the horizon is too long for option-leg fidelity (theta dominates option moves at these scales). Magnitude is normalised by per-instrument noise floor: NIFTY = 8 pts, BANKNIFTY = 25 pts, CRUDEOIL = 5 ticks, NATURALGAS = 3 ticks. Only economically-significant moves are labelled.

**Spot-based trigger semantics** (V2 D75 Gap 2): TP/SL trigger on the underlying spot reaching the predicted magnitude; the option is closed at whatever broker premium shows at that moment. Slippage is absorbed by the §7 `cost_floor_buffer_pct`. No Greek-based premium translation — keeps `sim_pnl` and live execution aligned.

### Replay-only backfill (Option B, locked 2026-05-18)

`features/trend_swing_targets.py` uses a `SpotTargetBuffer` that accumulates spot bars during replay and computes each target value once the lookahead horizon is reached. Live emitter writes NaN for all 24 target columns. The replay path in `replay/replay_runner.py` handles the end-of-day backfill before parquet write.

## 5. Key operational facts

**Session lifecycle.** Edge-triggered at 09:15 IST per instrument profile. Clears the 50-tick underlying buffer, all 10-tick option buffers, running medians, session distributions, and resets state. Pre-session ticks are processed but don't populate buffers. Saturday / Sunday / listed holidays are blocked at boot (no WS opened).

**Expiry rollover.** Detected at 14:30:00 IST when `snapshot.expiry_date == today`. Unsubscribe old expiry, subscribe next, clear all option buffers, emit `EXPIRY_ROLLOVER` alert, transition state → `FEED_STALE` briefly while new subscriptions stabilise.

**ATM detection.** `round(spot / strike_step) * strike_step`, window = `[ATM−3, ATM+3]` (7 strikes). ATM shift updates a pointer only — buffers are never cleared, because the full chain is subscribed from session start. A partial cache refresh updates the ATM-zone-dependent fields.

**Active strike selection.** Union of (volume top-3 by `call_vol_diff + put_vol_diff`) and (OI top-3 by `|delta_oi|`) yields 0–6 slots, ordered by combined strength. Tiebreaker: distance to spot, then call-side preference.

**Buffer retention.** 50-tick underlying buffer serves the 5/10/20/50-tick windows. 10-tick per-strike option buffers serve `premium_momentum_5` and `premium_momentum_10`. Both retention policies are mid-session permanent — only the session boundary and the expiry rollover clear them.

**Cross-day state persistence.** `state/levels_store.py` writes 5-day swing levels + prior-day H/L to `data/state/<inst>_levels.json` at session close, reads at session open. Survives TFA restarts without losing the rolling 5-day window.

**Schema registry.** `output/emitter.py` writes `config/schema_registry/v<N>.json` on startup if `LATEST_SCHEMA_VERSION` exceeds the highest existing version on disk. Currently `LATEST_SCHEMA_VERSION = 8` (Phase 3 added 24 target cols on top of Phase 2's 69 L1 cols on top of pre-v2's 377). Additive-only policy: new features bump the version, old models get quarantined by the schema reconciler in [03 Model Training](03_model_training.md).

**Tick atomicity.** No batching. If the broker sends 3 ticks at the same nanosecond timestamp with volumes [5, 3, 7], TFA emits 3 rows. This preserves microstructure fidelity for downstream OFI / direction features.

**Clock skew tolerance.** `chain_poller.py` accepts a ±2 s window between chain snapshot timestamp and tick time. Warnings are logged but features continue to emit.

## 6. Test coverage

**62 test files** under `python_modules/tick_feature_agent/tests/`. Coverage is wide:

- All 8 feature blocks have dedicated tests except `compression.py` and `decay.py`, which are covered implicitly via integration tests (`test_integration.py`, `test_tick_processor.py`).
- Targets: `test_targets.py` covers all 84 head outputs (scalp + trend + swing).
- Recording / replay: `test_recorder.py`, `test_replay.py`, `test_validator.py` round-trip recorded ticks → parquet.
- State machine: `test_state_machine.py` covers all 4 state transitions.
- Session boundary + expiry rollover: `test_session.py`.

Smoke replay validation: every Phase 2 / Phase 3 ship has been replay-validated end-to-end (~1600 tests as of 2026-05-18).

## 7. Status

**ACTIVE.**
- Phase 2 (L1 features: 23 B-block + 46 C-block ACCEPT) COMPLETE 2026-05-18, schema v7.
- Phase 3 (L2 targets: 12 trend + 12 swing) COMPLETE 2026-05-18, schema v8.
- Phase 4 (passive accumulation, 30 sessions) ACTIVE through Tue 2026-06-30. No code work in this phase — just time. The recorder runs Mon–Fri; replay-validation re-runs daily.

## 8. Open work

- [T14](../PROJECT_TODO.md) — 8 deferred L1 features. Add only if first-retrain SHAP shows existing features fail to capture the deferred patterns.
- [T21](../PROJECT_TODO.md) — Feature pruning via SHAP after first retrain. Drop bottom-10% features if importance is negligible. Inverse of T14.
- [T37](../PROJECT_TODO.md) — Order-book depth levels 1–4 (10–15 new cols). Code path is in `binary_parser.py` (depth is parsed and currently discarded); features module does not exist. Gated on top-of-book (level 0) showing SHAP importance first. Would bump schema v8 → v9 and reset the Phase 4 accumulation counter.
- **Phase 2e macro-bias columns** (~28–30 cols: FII/DII, US-session closes, Gift Nifty, event calendar) — ON HOLD per [T7](../PROJECT_TODO.md) until v2 intraday proves edge. Would bump schema v8 → v9.

No fresh gaps surfaced in this pass. TFA is fully aligned with V2 spec.

## 9. Cross-refs

- [01 Data Ingestion](01_data_ingestion.md) — raw tick + chain + VIX source.
- [03 Model Training](03_model_training.md) — parquet consumer; reads schema_registry/v8.json + applies the reconciler against trained models.
- [04 Signal Engine](04_signal_engine.md) — live feature-vector consumer (one row per tick via socket).
- [PROJECT_TODO.md](../PROJECT_TODO.md) — T3 (phase plan), T14 / T21 / T37 (feature decisions), T7 (macro-bias hold).

## 10. Code locations

| What | Path |
|---|---|
| Process entry + lifecycle | `python_modules/tick_feature_agent/main.py` |
| State machine | `python_modules/tick_feature_agent/state_machine.py` |
| Session edge-triggers | `python_modules/tick_feature_agent/session.py` |
| Tick buffers | `python_modules/tick_feature_agent/buffers/` |
| Feature modules (33 files) | `python_modules/tick_feature_agent/features/` |
| Cross-day state store | `python_modules/tick_feature_agent/state/levels_store.py` |
| Emitter + column layout | `python_modules/tick_feature_agent/output/emitter.py` |
| Alerts | `python_modules/tick_feature_agent/output/alerts.py` |
| Replay runner | `python_modules/tick_feature_agent/replay/replay_runner.py` |
| Target backfill | `python_modules/tick_feature_agent/features/trend_swing_targets.py` (SpotTargetBuffer) |
| Tests (62 files) | `python_modules/tick_feature_agent/tests/` |
| Shared target definitions | `python_modules/_shared/targets.py` (used by trainer too) |
| Schema registry on disk | `config/schema_registry/v8.json` |
