---
name: project_sea_gate_call_bias
description: SEA wave2 gate is structurally call-only — upside_percentile filter blocks all puts
metadata:
  type: project
---

Confirmed 2026-06-25 from 23-06 prediction logs (data/predictions/2026-06-23): the SEA wave2 gate emits **only GO_CALL / LONG_CE, never LONG_PE**, even on strong down days (NIFTY 32/32 calls, BANKNIFTY 13 call / 1 put while both indices fell ~165–500 pts).

**Root cause is the gate, not the model.** The direction head `direction_prob_60s` is balanced (~50/50 up/down). But gate condition **C3 `upside_percentile_60s >= 60`** is an upside-only, direction-blind metric applied to both sides. Put candidates (where downside is wanted) have low upside percentile (mean 24.7 vs 67.3 for calls) → pass C3 only ~2.9% vs ~65% for calls. Combined gate pass: puts 0/6109 (0%), calls 573/6273 (9%). C2 risk_reward_ratio_60s is also CE-upside-oriented (puts mean 18 vs calls 55) but both clear rr_min so C3 is the binding constraint.

`decide_action_wave2` (python_modules/signal_engine_agent/thresholds.py ~371) switches TP/SL to PE legs (max_upside_pe/max_drawdown_pe) AFTER passing, but the **decision conditions C2/C3 stay on the CE upside heads** for both directions. There is currently **no PE-side percentile head** in the trainer/TFA (only max_upside_pe/max_drawdown_pe exist).

**Why:** make C2/C3 leg-aware — compute PE-leg RR from max_upside_pe/max_drawdown_pe for puts; for C3 either add a PE/downside percentile (trainer retrain) or interim-drop the upside-percentile requirement for the put side.

**How to apply:** before "fixing the model" for the call bias, fix the GATE first — it is the actual blocker. Surfaced via the new signal chart overlay ([[project... signal chart]]). Re-verify on a down day that LONG_PE now fires. Do not touch TFA's Dhan WS path ([[feedback_tfa_do_not_touch]]).