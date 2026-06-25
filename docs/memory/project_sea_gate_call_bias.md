---
name: project_sea_gate_call_bias
description: SEA call-bias FIXED — wave2 gate now skips the CE upside-percentile (C3) for puts so GO_PUT can fire
metadata:
  type: project
---

**FIXED 2026-06-25** (commit `5b294e1`). The SEA wave2 gate used to emit **only GO_CALL / LONG_CE, never LONG_PE**, even on strong down days — not because the model is call-biased (`direction_prob_60s` is ~50/50) but because gate condition **C3 `upside_percentile_60s >= 60`** is a CE/UPSIDE session-rank applied to both directions. Bearish (PUT) setups score low on CE upside (mean pctile 24.7 vs 67.3 for calls) → cleared C3 only ~2.9% vs ~65%, so 0/6109 put candidates passed the full gate (calls 573/6273).

**The fix** (`decide_action_wave2`, python_modules/signal_engine_agent/thresholds.py): C3 is now **leg-aware — skipped for PUT candidates** (puts are still gated by C1 conviction, C2 RR, and the W-conditions, same as calls). Behind `Wave2Thresholds.leg_aware_quality_gate` (default true; set false in `config/sea_thresholds/<inst>.json` `wave2` block to restore legacy call-only). C2 (`risk_reward_ratio_60s`) left on both legs — the PE magnitude heads give RR≈1 and over-block; a real PE-RR is follow-up.

**Validated** by replaying the 2026-06-23 NIFTY prediction log through the gate: legacy 573 CALL / 0 PUT → fixed 573 CALL / **260 PUT** (calls unchanged).

**Remaining (not blockers, separate tasks):** (1) W4 `breakout_in_60s>=0.30` still favours calls ~2x (10% vs 5% pass) — a mild residual lean, not the dominant bias. (2) No PE-side percentile head exists; adding a downside-percentile feature (TFA — NOT its Dhan WS path, [[feedback_tfa_do_not_touch]]) would give C3 true symmetry instead of skip-for-puts. Restart SEA to load the fix.