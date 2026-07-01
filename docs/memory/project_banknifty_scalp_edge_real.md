---
name: project_banknifty_scalp_edge_real
description: "T68's \"scalp is a coin-flip / calibration broken\" was a measurement artifact; the scalp model is actually fine (~0.84 AUC live). Real bug = live features lack recv_ts_ns."
metadata: 
  node_type: memory
  type: project
  originSessionId: 8e27818e-f276-4aa2-bdca-9438ae2042ff
---

Verified 2026-07-01 (read-only probes, scripts in that session's scratchpad). The T68 edge-audit conclusions were **wrong** and have been corrected in `docs/PROJECT_TODO.md`.

- **Scalp direction model is genuinely good.** `direction_60s` raw booster AUC on the 6 truly out-of-sample days (tree cutoff 06-15 → 06-16/17/18/19/22/30): banknifty pooled **0.759**, nifty50 **0.777**. Live 06-30 AUC = **0.836**, proven by rebuilding every live vector through `LiveTickPreprocessor`, hashing it, and joining to the live prediction log on `feature_snapshot_hash` (35,520 preds, 100% identical, corr 1.0000).
- **Calibration is fine** — raw vs calibrated Spearman = 1.000 (monotonic). The "raw 0.43 → calib 0.08" collapse does not reproduce. `SEA_DISABLE_CALIBRATION=1` fixes a non-problem (harmless).
- **No train/serve skew.** 411/470 live features match replay; the ~56 that differ (regime one-hot all-NaN live, `active_4/5_*`, a few time/event cols) have negligible impact — patching them changes AUC by nothing.
- **Root of the mismeasurement:** the live feature ndjson has **no `recv_ts_ns`**, so `prediction_logger` stamps rows with wall-clock `time.time_ns()`. Joining wall-clock predictions to emit-time labels mispairs ticks → fake ~0.49 AUC. That artifact fooled both T68 and the first pass of the 07-01 session.

**Why:** future sessions must not retrain / refit calibration / chase "no edge" on the strength of the old T68 text. The prediction is already good — the leverage is making it pay, not making it predict.

**How to apply:** (1) real fix = emit `recv_ts_ns`/monotonic tick-id on each live feature row, key `prediction_logger` + `outcome_backfiller` off it (unblocks honest prediction↔outcome joins; explains 0% `outcome_*` backfill). (2) the ₹599/day bleed is execution/cost (≈26 tiny trades/day, ₹53 charges, TP/SL magnitude scaling), not the model — measure economics before re-enabling scalp auto-trade. Related: [[project_sea_gate_call_bias]].
