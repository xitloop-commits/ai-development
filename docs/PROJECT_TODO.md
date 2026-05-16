# Project TODO — ai-development

Single source of truth for open project tasks. Top = highest priority. Add new items at the appropriate slot; mark closed items by deleting (git history of this file = audit trail).

## ACTIVE — currently in flight

### T1 — Crudeoil multi-day replay
Crudeoil parquets have gaps (last verified May 16: 6 dates vs naturalgas's 10). Replay is launched in parallel windows but not all complete.

- **Status:** In progress (replay processes running in launcher).
- **Where to check:** Main menu Replay row in launcher — should show pending count.
- **Blocking:** Nothing — passive wait.

## P1 — design work while data accumulates

### T2 — Signal system v2 brainstorm (8 layers)
Stage-by-stage design of the perfect signal system. All layer designs land in the single source of truth `docs/V2_MASTER_SPEC.md`.

- **Status:** Consolidated 2026-05-16 into `docs/V2_MASTER_SPEC.md`. L1 IN-PROGRESS (candidates listed, 16 decisions pending in §9). L2/L3 LOCKED-CANDIDATE. L4-L8 SKETCH.
- **Layers (status header in V2_MASTER_SPEC §2.0):**
  - [x] Skeleton pass — all 8 layers consolidated
  - [x] L1 — Input features LOCKED 2026-05-16
  - [x] L2 — Target labels LOCKED 2026-05-16
  - [x] L3 — Model architecture LOCKED 2026-05-16
  - [x] L4 — Gate logic LOCKED 2026-05-16
  - [x] L5 — Trade management LOCKED 2026-05-16
  - [x] L6 — Position sizing LOCKED 2026-05-16
  - [x] L7 — Risk controls LOCKED 2026-05-16
  - [ ] L8 — Regime / meta deep dive
- **User-chosen order:** L1 → L2 → L3 first (finalize before L4-L8). Per 2026-05-16 brainstorm session.
- **Constraints (do NOT re-litigate — see V2_MASTER_SPEC §1.2):**
  - Trades live MINUTES (>5 min hold)
  - nifty50 noise floor 8 pts (TP ≥25 / SL ≥15)
  - Trends visible only at 10-30 min horizons
  - LightGBM stays
  - Wave 2 scalp stays as backup
  - Swing trades deferred to T7
- **Per-session output:** edit `docs/V2_MASTER_SPEC.md` section(s) for that layer; flip status header; commit.

### T3 — Trend-capture retrain (P1 blocker for paper trading)
The current Wave 2 model is a microstructure scalp predictor; doesn't satisfy "trades live MINUTES" mandate. Needs new target spec (10/15/30 min horizons with noise floor in labels), new multi-TF features, retrain.

- **Status:** Design captured in `docs/V2_MASTER_SPEC.md`. Implementation deferred until T2 layer locks.
- **Blocker:** Need ≥30 sessions of training data **under v2 schema** (per V2_MASTER_SPEC §3.1 Option A: existing ~10 sessions of 402-col parquets become inaccessible when v2 schema ships). Auto-recorder accumulates Mon-Fri → ~6 weeks of recording from schema cutover to first retrain. Reversible: raw .ndjson.gz files retained, can replay later if decision changes.
- **Phases (V2_MASTER_SPEC §6):**
  - [~] Phase 1: Design lock (V2_MASTER_SPEC — in progress, L1 not yet locked)
  - [ ] Phase 2: TFA feature additions (~1-2 days code)
  - [ ] Phase 3: Target additions (~1 day code)
  - [ ] Phase 4: Auto-record accumulation (~30 days passive)
  - [ ] Phase 5: Retrain all 4 with combined targets (~hours of compute)
  - [ ] Phase 6: Trend gate + smoke (~1 day code)
  - [ ] Phase 7: Paper trade ramp
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

### T16 — Confidence-weighted position sizing (upgrade L6 D2)
Promote sizing from equal allocation (L6 D2 Option D, ships with v2) to confidence-weighted (scale lots by predicted_prob / 0.5).

- **Status:** Deferred. Gated by same reliability check as Gap #1 B→D (cost-floor migration).
- **Blocked by:** first v2 retrain producing calibrated probabilities + 5-day holdout reliability-diagram check (±5% predicted-vs-actual win rate across deciles).
- **Why upgrade:** equal sizing wastes capacity on near-threshold signals. Confidence weighting puts more capital on best signals — higher sharpe IF probabilities are reliable.
- **Spec change when ready:** V2_MASTER_SPEC §2.6 — replace equal-sizing formula with weighted. Update D2 in §9 to RESOLVED.

### T15 — Limit-order optimization for execution
Investigate limit-order execution to reduce slippage cost. L5 D4 locked market orders for v1 to match sim_pnl validation assumption.

- **Status:** Deferred. Reduces real slippage by 1-3 pts/trade if fills succeed; can break sim_pnl ↔ live coherence.
- **Blocked by:** ≥200 paper fills per instrument (T3 Phase 7). Measure: % of would-have-been-limit-orders that fill within 5s at midprice.
- **Trigger to upgrade:** if fill-rate ≥70% across paper trades AND slippage savings ≥1 pt/trade on filled signals.
- **Spec change when ready:** V2_MASTER_SPEC §2.5 L5 D4 — upgrade to Option B/D. Mirror change to sim_pnl §2.3.4 to assume limit fills where applicable. Re-validate with walk-forward.

### T14 — Add 8 deferred L1 features post-paper-trade
Add 8 features deferred at L1 D2 lock (2026-05-16) if first-retrain analysis shows missing signal that these would capture.

- **Status:** Deferred. Add only if needed (most can be composed by LightGBM from accepted features).
- **Deferred features:**
  - `rsi_14_15min` (C2)
  - `ma_cross_event_5min` (C2)
  - `breakout_event_5min` (C2)
  - `momentum_deceleration` (C5)
  - `premium_acceleration_drop` (C5)
  - `active_strike_rotation_score` (C7)
  - `strike_migration_persistence` (C7)
  - `premium_vwap_cross_strength` (C8)
- **Decision criterion:** if SHAP analysis (§5.4) shows existing features that should be capturing these patterns have low importance OR show inconsistent signals, add the explicit feature.
- **Spec change when ready:** V2_MASTER_SPEC §2.1.4 — move row from DEFER to ACCEPT, bump L1 active count.

### T13 — Auto-generate feature catalog
Create `scripts/generate_feature_catalog.py` that reads `python_modules/tick_feature_agent/output/emitter.py` `_build_column_names()` + module docstrings, emits `docs/FEATURE_CATALOG.md` table (name, source module, brief description). Hook into pre-commit so any TFA change auto-updates the catalog.

- **Status:** Deferred. Low priority — does not block trading.
- **Why needed:** with 443 candidate features post-v2, no lookup tool exists today. Anyone debugging a bad signal or onboarding spends hours grepping code.
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
- **Blocked by:** First v2 retrain (T3 Phase 5). Option D requires calibrated probabilities; Wave 2 today predicts near 0.0028 (uncalibrated). Post-retrain, `scale_pos_weight` fix should produce usable 0.40–0.60 range probabilities.
- **Validation gate:** before promoting, confirm on 5-day holdout that predicted P_win matches actual win rate within ±5% across deciles (reliability diagram check).
- **Why upgrade:** Option B blocks high-probability low-magnitude trades that have positive expectancy. Option D captures the real economics — allows trades like "78% win probability × 18 pts TP − 22% × 14 pts SL = +11 pts expected" which B would reject for TP < cost-floor.
- **Spec change when ready:** V2_MASTER_SPEC §2.4 — replace the cost-floor hard veto with the EV formula. Update D17 in §9 to mark RESOLVED.

### T7 — Swing trade capability (1–3 day hold)
Add support for swing trades held 1–3 days on the 4 traded instruments (nifty50, banknifty, crudeoil, naturalgas). Deferred until v2 intraday is paper-trading-proven (after T3 completes).

- **Status:** Deferred. Add to design backlog only.
- **Blocked by:** T3 (v2 intraday paper trade ramp). Reason: extending v2 with daily-bar targets/features now would dilute focus on the noise-floor/multi-TF label fix that's the actual critical path.
- **Why it's hard:** different time horizon (6–72 hours vs 5–25 min), different features (daily OHLCV bars, FII/DII flows, sector rotation), different risk profile (overnight gap, higher margin, MCX physical settlement), different brokerage structure (delivery rates, STT-on-physical).
- **Approach when ready (Option B from 2026-05-16 brainstorm):** parallel pipeline — separate daily-bar TFA-equivalent, separate models, separate SEA loop, separate channel in BSA. Do NOT bolt 1d/2d/3d targets onto intraday v2.
- **Data required:** 6–12 months of daily OHLCV bars per instrument (different acquisition path than your tick recorder — NSE/MCX provide free daily history).
- **First doc to write when unblocked:** `docs/SWING_TRADE_SPEC.md`.

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
