# Feature ↔ Head Reconciliation

**Reference doc for T3 Phase 2–6 implementation.** Cross-checks the 446 L1 features against the 84 prediction heads against the gate/trade-mgmt logic that consumes them. Single page so a code-writer can hold the whole picture in head.

**Authority:** `docs/V2_MASTER_SPEC.md` remains the design source of truth. This doc is REFERENCE only — when in doubt, V2_MASTER_SPEC wins. Updated on the same commit that changes the underlying spec.

**Last reconciled:** 2026-05-17 against V2_MASTER_SPEC commit `00fdc8f` (§9 D1–D74).

---

## 1. The numbers at a glance

| Layer | Heads | Horizon set | Target types | Hold time | Hold goal |
|---|---|---|---|---|---|
| **Scalp** (Wave 2 legacy) | **60** per instrument | 5 windows: 60s / 120s / 180s / 240s / 300s | **12** types (CE-leg + PE-leg aware) | 30 sec – 2 min | Microstructure reversals, day-extreme bounces |
| **Trend** (v2 new) | **12** per instrument | 2 windows: 900s / 1800s | **6** types (spot-based only) | 5 – 30 min | Multi-bar continuation / breakouts |
| **Swing** (v2 new) | **12** per instrument | 2 windows: 3600s / 7200s | **6** types (spot-based only) | 30 min – 2 hr | Sustained multi-trend-window moves |
| **TOTAL** | **84** per instrument × 4 instruments = **336 LightGBM models** | | | | |

All 84 heads receive ALL 446 L1 features as input (no per-head feature filtering). LightGBM's tree splits + regularization decide which features matter for which head. Per-head SHAP reports (§5.4) surface this empirically.

---

## 2. L1 feature columns (446 active)

### 2.1 A-block — Live in parquet today (377 features)

These are the existing Wave 2 feature columns. They ship for free in Phase 2 (TFA emitter already produces them).

| Block | Count | Purpose | Example columns | Most-relevant consumer heads (educated guess pre-SHAP) |
|---|---|---|---|---|
| A0 Timestamp | 1 | Row identity | `timestamp` | All — joins, ordering |
| A1 Underlying base | 12 | Microstructure: tick-by-tick price + simple imbalance | `underlying_ltp`, `underlying_return_5ticks`, `tick_imbalance_20`, `momentum` | Scalp (tick-paced reversal signals) |
| A2 Underlying extended | 20 | Multi-window underlying stats (OFI, realized vol, tick counts at 5/10/20/50 horizons) | `underlying_ofi_50`, `underlying_realized_vol_20`, `underlying_horizon_momentum_ratio` | Scalp + trend short-horizon (900s) |
| A3 ATM context | 3 | Spot, ATM strike, strike step — context for option features | `spot_price`, `atm_strike`, `strike_step` | All (referenced by other features) |
| A4 Compression & breakout | 5 | Range tightening + breakout-readiness scoring | `volatility_compression`, `breakout_readiness` | Trend (breakout-imminent heads), C5 trend-age |
| A5 Time-to-move | 4 | Stagnation / persistence timers | `time_since_last_big_move`, `momentum_persistence_ticks` | Trend, swing (sustain-required heads) |
| A6 Option tick | 126 | 7 strike offsets × CE/PE × 9 fields (LTP, bid, ask, spread, volume, premium momentum) | `opt_0_ce_ltp`, `opt_p2_pe_premium_momentum`, `opt_m1_ce_bid_ask_imbalance` | Scalp (option microstructure heads), trade-mgmt (exit triggers) |
| A7 Option chain | 9 | Aggregated PCR + OI imbalance (global, ATM) | `chain_pcr_atm`, `chain_oi_change_call_atm`, `chain_oi_imbalance_atm` | Trend + swing (chain-pressure signals) |
| A8 Active strikes | 144 | 6 active-strike slots × 24 fields (strike level, distance, CE/PE strength, volumes, momentum) | `active_0_strike`, `active_2_call_strength_volume`, `active_5_tick_age_sec` | Scalp (strike-by-strike behavior) |
| A9 Cross-feature intel | 4 | Call-vs-put strength + divergence | `call_put_strength_diff`, `premium_divergence` | All — directional bias |
| A10 Decay & dead market | 5 | Premium decay, volume drought, dead-market score | `total_premium_decay_atm`, `dead_market_score` | Scalp (avg_decay heads), swing (time-decay aware exit triggers) |
| A11 Regime classification | 2 | Existing rule-based regime tag + confidence | `regime`, `regime_confidence` | All — L8 input |
| A12 Zone aggregation | 7 | ATM / active-zone pressure aggregates | `atm_zone_net_pressure`, `zone_activity_score` | Trend, swing |
| A13 Trading state | 4 | Trading-allowed flag, warm-up timer, stale reason | `trading_allowed`, `warm_up_remaining_sec` | Gate-side (entry suppression) |
| A14 Metadata | 9 | Exchange, instrument, security IDs, data-quality | `exchange`, `instrument`, `data_quality_flag` | Routing only — not predictive |
| A15 Wave 1 Levels | 8 | Day H/L distances, OI strike distances | `distance_to_day_high_pct`, `distance_to_max_call_oi_strike_pct` | Trend + swing (S/R-based heads) |
| A16 Wave 1 Greeks | 9 | Delta, gamma, theta, vega, IV skew at ATM | `atm_ce_delta`, `atm_gamma`, `atm_ce_theta` | Swing (long-hold convexity), exit triggers |
| A17 Wave 1 Expiry | 5 | Days-to-expiry + session-remaining | `days_to_expiry`, `session_remaining_pct`, `is_expiry_day` | All — modulates target sensitivity |

**A subtotal: 377**

### 2.2 B-block — v2-plan multi-TF + S/R additions (23 features)

New for Phase 2. Build on top of existing A-block aggregates.

| Block | Count | Purpose | Example columns | Most-relevant consumer heads |
|---|---|---|---|---|
| B1 MA structure | 5 | Moving-average ratios at 1m / 5m / 15m | `ma_5_1min`, `ma_20_5min` | Trend, swing |
| B2 Trend strength | 3 | ADX + multi-bar momentum | `adx_5min`, `momentum_5min`, `momentum_15min` | Trend (direction heads), L8 regime |
| B3 Higher-TF structure | 4 | Session-open / VWAP distance + age | `dist_from_session_open_pct`, `session_high_age_min` | Swing |
| B4 Multi-bar pattern | 3 | Consecutive HH/LL, range compression | `consecutive_higher_highs_5min`, `range_compression_ratio` | Trend (breakout-imminent), swing |
| B5 Additional S/R | 8 | Prior-day H/L, opening range, round numbers, 5-day swing | `distance_to_prev_day_high_pct`, `distance_to_opening_range_high_pct`, `distance_to_round_number_above_pct`, `distance_to_5d_swing_high_pct` | Swing (S/R-bounce heads), trend exit triggers |

**B subtotal: 23**

### 2.3 C-block — Brainstorm ACCEPT (46 features)

New for Phase 2. From the 54-candidate brainstorm; 46 ACCEPT, 8 DEFER (T14).

| Block | Count | Purpose | Example columns | Most-relevant consumer heads |
|---|---|---|---|---|
| C1 OI / S/R dynamics | 12 | OI walls, dominance streaks, multi-window OI change incl. 60-min for swing | `oi_weighted_ce_resistance_strike`, `ce_wall_strength_rel`, `pe_oi_change_60min_pct`, `oi_dominance_streak_min` | Trend, swing (OI exit triggers) |
| C2 Classic technical | 5 | RSI / MACD on 5-min bars | `rsi_14_5min`, `macd_histogram_5min` | Trend |
| C3 India VIX | 2 | Implied vol + 5-min change | `india_vix`, `india_vix_change_5min` | All — vol regime input |
| C4 Dealer hedging / GEX | 5 | Gamma exposure, dealer delta, charm, vanna | `net_gex`, `gamma_flip_distance_pct`, `charm_estimate_atm`, `vanna_estimate_atm` | Swing (convexity-heavy), expiry-day modulation |
| C5 Exhaustion / trend age | 2 | Trend age + volume-no-move | `trend_age_ticks`, `volume_no_move_score` | Trend exit triggers (exhaustion) |
| C6 Intraday time | 3 | Minutes-from-open, minutes-to-close, lunch flag | `minutes_from_open`, `lunch_session_flag` | All — time-of-day conditioning |
| C7 Strike migration | 3 | Active-strike shift direction + flow ratio | `active_strike_shift_direction`, `atm_to_otm_flow_ratio` | Scalp + trend |
| C8 Premium VWAP | 3 | Per-leg premium-vs-VWAP distance + reclaim count | `atm_ce_premium_vwap_dist`, `premium_vwap_reclaim_count` | Scalp |
| C9 IV velocity | 4 | IV changes at 1m/5m + skew velocity + IV-without-spot | `iv_change_5min`, `iv_expansion_without_spot` | Swing (vol-shift heads) |
| C10 Max Pain | 3 | Max-pain strike + distance + gravity strength | `max_pain_strike`, `distance_to_max_pain_pct` | Expiry-day trend/swing (conditional via `days_to_expiry_bucket`) |
| C11 Event calendar | 3 | Tier-2 event day flag + categorical event type + hours-to-next | `is_tier_2_event_day`, `event_type_categorical` | All — event suppression |
| C12 Expiry bucket | 1 | Categorical `days_to_expiry_bucket` ∈ {0, 1, 2, 3+} | `days_to_expiry_bucket` | All — modulates Max Pain + decay |

**C subtotal: 46 ACCEPT (8 DEFER → T14)**

**GRAND TOTAL: 377 + 23 + 46 = 446 active L1 features**

---

## 3. Head catalog (84 per instrument enumerated)

### 3.1 Scalp heads (60) — Wave 2 legacy, ships as-is

Source of truth: `python_modules/_shared/targets.py`. 12 target types × 5 lookahead windows (60s / 120s / 180s / 240s / 300s).

| # | Target name pattern | Type | What it predicts | TP/SL or gate use |
|---|---|---|---|---|
| 1 | `direction_{w}s` | binary | Was spot up at t+w (raw, no noise floor)? | Scalp gate input — `direction_60s ≥ θ_scalp_dir` |
| 2 | `direction_{w}s_magnitude` | regression | Signed spot delta at t+w | Diagnostic / not gate-fed |
| 3 | `risk_reward_ratio_{w}s` | regression | Predicted RR if trade taken | Not gate-fed (informational) |
| 4 | `max_upside_{w}s` | regression | Best CE-leg premium upside over [t, t+w] | **TP for LONG (CE) scalp signals — locked to `max_upside_60s`** per W3 |
| 5 | `max_drawdown_{w}s` | regression | Worst CE-leg premium downside over [t, t+w] | **SL for LONG scalp signals — `max_drawdown_60s × 1.3`** |
| 6 | `total_premium_decay_{w}s` | regression | Theta-burn over window | Trade-mgmt sanity check |
| 7 | `avg_decay_per_strike_{w}s` | regression | Premium decay normalized per strike | Trade-mgmt sanity check |
| 8 | `direction_persists_{w}s` | binary | Did direction hold without intra-window flip? | Scalp continuation diagnostic |
| 9 | `breakout_in_{w}s` | binary | Did spot cross day H/L within window? | Trend-aware scalp filter |
| 10 | `exit_signal_{w}s` | binary | Should an open position close (direction flip OR drawdown > 1%)? | Scalp exit trigger candidate |
| 11 | `max_upside_pe_{w}s` | regression | Best PE-leg premium upside over [t, t+w] | **TP for SHORT (PE) scalp signals — see §5 Gap 1** |
| 12 | `max_drawdown_pe_{w}s` | regression | Worst PE-leg premium downside over [t, t+w] | **SL for SHORT scalp signals — see §5 Gap 1** |

**60 = 12 × {60s, 120s, 180s, 240s, 300s}.**

### 3.2 Trend heads (12) — v2 new

12 = 6 target types × 2 horizons {900s, 1800s}. Target definitions per V2_MASTER_SPEC §2.2.2.

| # | Head name | Type | What it predicts | Consumer |
|---|---|---|---|---|
| 1 | `trend_direction_900s` | binary | Did spot move > noise_floor up in 15 min? | **`decide_action_trend` primary gate** (≥ θ_trend_dir) |
| 2 | `trend_direction_1800s` | binary | Same, 30 min | Diagnostic / continuation check |
| 3 | `trend_magnitude_900s` | regression | Signed spot delta over 15 min | **Trend TP source + bias filter magnitude guard** |
| 4 | `trend_magnitude_1800s` | regression | Signed spot delta over 30 min | Diagnostic |
| 5 | `trend_max_excursion_900s` | regression | Max spot rise over [t, t+900s] | Capture-ratio analysis |
| 6 | `trend_max_excursion_1800s` | regression | Same, 30 min | Capture-ratio analysis |
| 7 | `trend_max_drawdown_900s` | regression | Max spot fall over [t, t+900s] | **Trend SL source: `trend_max_drawdown_900s × 1.3`** |
| 8 | `trend_max_drawdown_1800s` | regression | Same, 30 min | Diagnostic |
| 9 | `trend_continues_900s` | binary | Did 15-min direction match dominant direction of [t-300s, t] AND magnitude ≥ floor? | Trend-bias filter input |
| 10 | `trend_continues_1800s` | binary | Same, 30 min | Trend-bias filter input |
| 11 | `trend_breakout_imminent_900s` | binary | Did max excursion in [t, t+900s] ≥ noise_floor × 3? | Breakout-pattern gate condition |
| 12 | `trend_breakout_imminent_1800s` | binary | Same, 30 min | Breakout-pattern gate condition |

### 3.3 Swing heads (12) — v2 new (ADDED 2026-05-17, D55)

12 = 6 target types × 2 horizons {3600s, 7200s}. Same shape as trend; longer horizons, looser noise tolerance (`breakout_imminent` scale = 6 vs trend's 3).

| # | Head name | Type | What it predicts | Consumer |
|---|---|---|---|---|
| 1 | `swing_direction_3600s` | binary | Did spot move > noise_floor up in 1 hr? | **`decide_action_swing` primary gate** (≥ θ_swing_dir, default 0.70) |
| 2 | `swing_direction_7200s` | binary | Same, 2 hr | Diagnostic / Tier-3 trail validation |
| 3 | `swing_magnitude_3600s` | regression | Signed spot delta over 1 hr | **Swing TP source + ≥ noise_floor × 6 (48 pts nifty) gate condition** |
| 4 | `swing_magnitude_7200s` | regression | Signed spot delta over 2 hr | Diagnostic |
| 5 | `swing_max_excursion_3600s` | regression | Max spot rise over [t, t+3600s] | Capture-ratio analysis |
| 6 | `swing_max_excursion_7200s` | regression | Same, 2 hr | Capture-ratio analysis |
| 7 | `swing_max_drawdown_3600s` | regression | Max spot fall over [t, t+3600s] | **Swing SL source: `swing_max_drawdown_3600s × 1.4` + ≤ 25 pts cap** |
| 8 | `swing_max_drawdown_7200s` | regression | Same, 2 hr | Diagnostic |
| 9 | `swing_continues_3600s` | binary | Did 1-hr direction match dominant direction of [t-300s, t] AND magnitude ≥ floor? | Continuation diagnostic |
| 10 | `swing_continues_7200s` | binary | Same, 2 hr | Continuation diagnostic |
| 11 | `swing_breakout_imminent_3600s` | binary | Did max excursion in [t, t+3600s] ≥ noise_floor × 6? | Breakout-pattern gate condition |
| 12 | `swing_breakout_imminent_7200s` | binary | Same, 2 hr | Breakout-pattern gate condition |

---

## 4. Runtime data flow

```
TICK (Dhan websocket, ~10/sec)
    │
    ▼
TFA emitter (Phase 2 code)
    │  computes 446 L1 features
    │  writes parquet row + emits to SEA
    ▼
SEA model_loader
    │  loads 84 heads × 4 instruments = 336 LightGBM models
    │  loads 336 calibration maps (D72)
    │  loads schema_registry/v<N>.json (D66)
    ▼
SEA predict path (per tick, per instrument)
    │
    │  1. project 446-col row → head's training-time column subset
    │     (via schema_registry lookup; D66)
    │  2. raw_prob = head.predict(projected_row)
    │  3. calibrated_prob = numpy.interp(raw_prob, x_thresholds, y_calibrated)
    │     (per D72 isotonic map)
    │
    ▼
SEA gate logic (L4)
    │
    ├─ decide_action (scalp)
    │     reads: direction_60s, max_upside_60s, max_drawdown_60s
    │     fires if: calibrated_direction_60s ≥ θ_scalp_dir
    │                AND magnitude conditions met
    │                AND cost-floor / regime / risk checks pass
    │
    ├─ decide_action_trend
    │     reads: trend_direction_900s, trend_magnitude_900s, trend_max_drawdown_900s
    │     fires if: calibrated_trend_direction_900s ≥ θ_trend_dir
    │                AND magnitude ≥ noise_floor × 3
    │                AND max_drawdown ≤ 15 pts
    │                AND L8 regime = trend
    │                AND 5-tick dwell satisfied
    │
    └─ decide_action_swing
          reads: swing_direction_3600s, swing_magnitude_3600s, swing_max_drawdown_3600s
          fires if: calibrated_swing_direction_3600s ≥ θ_swing_dir (0.70)
                     AND magnitude ≥ noise_floor × 6 (48 pts nifty)
                     AND max_drawdown ≤ 25 pts
                     AND L8 regime = trend_strong (≥ 5 min sustain)
                     AND cooldown ≥ 15 min since last swing
                     AND minutes_from_open < swing_entry_cutoff (13:30 NSE / 21:30 MCX)
    │
    ▼
L4 trend bias filter (D49)
    │  if trend_magnitude_900s ≥ noise_floor:
    │     if trend_direction_900s ≥ 0.65: BLOCK any SHORT scalp signal
    │     if trend_direction_900s ≤ 0.35: BLOCK any LONG scalp signal
    │
    ▼
L4 3-way ensemble combinator (D55, agreement-window upgrade D61/D67)
    │  Agreement matrix:
    │    all 3 agree   → FIRE with swing's TP/SL (longest horizon dominates)
    │    2 agree, 3rd silent  → FIRE with longer-horizon's TP/SL
    │    2 agree, 3rd disagrees → SKIP (log disagreement_skip)
    │    1 fires solo → FIRE with that gate's TP/SL
    │    2 opposite → SKIP
    │
    │  Agreement-window upgrade: if scalp fires solo at T,
    │    within ticks [T+1, T+6]:
    │      trend gate fires same dir AND trend_direction_900s ≥ θ_upgrade_trend_dir
    │        → replace TP, SL with trend's
    │      swing gate fires same dir AND swing_direction_3600s ≥ θ_upgrade_swing_dir
    │        → replace TP, SL with swing's (overrides trend)
    │
    ▼
L7 risk gates (concurrent caps, daily-loss budget, blackout windows)
    │
    ▼
SEA fires signal → L5 trade management
    │  TP/SL locked at entry from firing layer's magnitude + max_drawdown × safety multiplier
    │  per-position state JSON written to data/sea_state/<inst>/<position_id>.json
    │    (entry_snapshot, wall_strength_buffer, partial_taken flag — §2.5.1 D68)
    │
    ▼
Tick loop — per tick, per open position
    │  evaluate exit triggers (D70 — first wins, no priority):
    │    - TP hit                          (calculated at entry)
    │    - SL hit                          (calculated at entry)
    │    - Trail tier triggered            (per-layer: scalp/trend 2-tier, swing 3-tier)
    │    - Time-stop reached               (5 min scalp / 30 min trend / 2 hr swing)
    │    - OI exit (D62 — 5-min for scalp/trend, 60-min for swing)
    │      reads: pe_oi_change_{5,60}min_pct, ce_oi_change_{5,60}min_pct,
    │             ce_wall_strength_rel + rolling buffer for delta
    │    - Exhaustion (D63 — inline composition)
    │      reads: trend_age_ticks vs entry-snapshot delta on momentum + premium
    │    - Regime-flip protection (sustained ≥3 min flip, NOT trend_strong→trend per D71)
    │
    ▼
Position close → write logs/signals/ + sim_pnl + trade-quality cohort tag (D56)
```

---

## 5. Reconciliation findings (issues surfaced during this pass)

**Status: ALL 4 gaps RESOLVED 2026-05-17 via V2_MASTER_SPEC D75.** Original findings preserved below for audit trail; resolutions noted inline.

### Gap 1 — Scalp SHORT-signal TP/SL source not specified

**Context:** §2.5 row "Scalp" says TP from `max_upside_60s`, SL from `max_drawdown_60s × 1.3`. These are CE-leg targets (the underlying Wave 2 trains 12 types per horizon, including PE-leg versions `max_upside_pe_60s` and `max_drawdown_pe_60s`).

**The gap:** spec doesn't say what feeds TP/SL when scalp fires a SHORT signal (BUY PE). Code-writer would either (a) use CE-leg targets for both sides (wrong — PE premium dynamics differ from CE), or (b) silently improvise.

**Suggested fix:** add explicit rule to §2.5:
- LONG scalp (BUY CE) → TP from `max_upside_60s`, SL from `max_drawdown_60s × 1.3`
- SHORT scalp (BUY PE) → TP from `max_upside_pe_60s`, SL from `max_drawdown_pe_60s × 1.3`

Severity: BLOCKER for Phase 6 if SEA gate fires SHORT scalp signals. **RESOLVED 2026-05-17 via D75 — side-aware sources now locked in §2.5 footnote "Gap 1": LONG → CE-leg targets, SHORT → PE-leg targets.**

### Gap 2 — Trend/swing TP/SL is in spot points, traded position is options

**Context:** §2.5 says trend TP = `trend_magnitude_900s` (which §2.2.2 defines as `spot(t+w) − spot(t)`). But the actual position is a CE or PE option, whose premium does NOT move 1:1 with spot.

**The gap:** Code-writer has two readings:
- **Reading A:** TP/SL trigger is on SPOT. When spot moves by predicted magnitude, close the option position at whatever premium is then. (Valid strategy — uses option for leverage but exits on underlying.)
- **Reading B:** TP/SL trigger is on the OPTION PREMIUM directly, requiring a spot→premium translation via delta + gamma. (More common but requires Greek-based projection.)

Spec doesn't say which.

**Suggested fix:** lock Reading A explicitly in §2.5 (simpler, no Greek model dependency). Add one sentence: "Trend and swing TP/SL trigger on underlying SPOT movement, not option premium. When spot reaches entry ± `trend_magnitude_900s`, the option position is closed at whatever premium the broker tape shows at that moment."

Severity: BLOCKER for Phase 6 trade-management code. **RESOLVED 2026-05-17 via D75 — Option A (spot-based trigger) locked in §2.5 footnote "Gap 2". TP/SL fire on underlying spot reaching predicted magnitude; option closes at whatever broker premium shows; slippage absorbed by §7 cost_floor_buffer_pct.**

### Gap 3 — Scalp has 12 target types; trend/swing have only 6

**Context:** Wave 2 scalp inherits a 12-type target set (CE/PE-leg-aware, includes premium decay, exit_signal, breakout_in). v2 trend/swing use a simpler 6-type set (direction/magnitude/excursion/drawdown/continues/breakout).

**Is it a real gap?** No — design intent is correct asymmetry. Scalp targets the option-premium microstructure; trend/swing target the underlying. But the asymmetry should be DOCUMENTED so a future reader doesn't try to "harmonize" them.

**Suggested fix:** add one-paragraph note in V2_MASTER_SPEC §2.2 explaining the asymmetry and why it stays. Not blocking — clarity only. **RESOLVED 2026-05-17 via D75 — asymmetry note added to §2.2.2 immediately after the 24 new target columns total.**

### Gap 4 — Calibration applies to BINARY targets; regression heads don't need it

**Context:** §2.3 D72 calibration recipe (`isotonic regression on raw_prob`) only makes sense for binary heads (probability outputs). Regression heads predict magnitudes — those don't need calibration in the same sense.

**The gap:** spec says "84 heads × 4 instruments = 336 calibration maps" but a chunk of those are regression heads (magnitude, max_excursion, max_drawdown, decay, RR). Code-writer may either (a) fit isotonic on regression outputs (meaningless), (b) skip regression heads (correct but unspoken).

**Counts:**
- Scalp: 12 types × 5 horizons = 60 heads. Binary types: direction, direction_persists, breakout_in, exit_signal = 4 types × 5 = **20 binary heads**. Regression = 40.
- Trend: 6 types × 2 horizons = 12. Binary types: direction, continues, breakout_imminent = 3 × 2 = **6 binary heads**. Regression = 6.
- Swing: same as trend = **6 binary heads**. Regression = 6.
- **TOTAL: 32 binary heads × 4 instruments = 128 calibration maps** (not 336).

**Suggested fix:** narrow D72 + §5.2 check #7 + §6.1 calibration step to BINARY heads only. Regression heads ship without calibration files (or with explicit `"method": "identity"` if uniformity required). Reduces calibration compute from 336 → 128 fits per Saturday retrain.

Severity: WORTH-FIXING — would otherwise add wasted compute and likely produce code that fails on regression heads. **RESOLVED 2026-05-17 via D75 — D72 scope narrowed to binary heads only. Updated §2.3 calibration block, §5.2 check #7, §6.1 Sat 21:30 step. Correct count is 128 calibration maps (32 binary heads × 4 instruments), not 336.**

---

## 6. Quick-lookup index

**Looking for which head feeds which gate?** → §4 data flow
**Looking for what `oi_dominance_streak_min` means?** → V2_MASTER_SPEC §2.1.4 W4 footnote
**Looking for the calibration recipe?** → V2_MASTER_SPEC §2.3.1 D72 (+ Gap 4 above)
**Looking for the runtime schema reconciliation rule?** → V2_MASTER_SPEC §2.3.2 D66
**Looking for per-position state schema?** → V2_MASTER_SPEC §2.5.1 D68
**Looking for the exit-trigger precedence rule?** → V2_MASTER_SPEC §2.5 D70

---

## 7. How to keep this current

- Any change to `_shared/targets.py` (Wave 2 scalp head set) → update §3.1.
- Any new trend/swing horizon → update §3.2 / §3.3 + Table 1.
- Any new L1 feature block → update §2.x.
- Any new gate condition or exit trigger → update §4 data flow.

When T13 (auto feature catalog) ships, the §2 tables become machine-generated from `emitter.py` `_build_column_names()`. Until then, manual sync per V2_MASTER_SPEC changes.
