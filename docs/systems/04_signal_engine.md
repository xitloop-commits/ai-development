# 04 — Signal Engine (SEA)

## Purpose
Per-tick inference across 84 heads per instrument; gate logic deciding LONG_CE / LONG_PE / SHORT_CE / SHORT_PE / WAIT with SL + TP + confidence; trade-management state across tick lifetime; emit signal to execution layer.

## Scope
**In:** live feature vectors from [02](02_feature_engineering.md), trained models + calibration sidecars + LATEST_HEADS.json from [03](03_model_training.md).
**Out:** signal payloads (direction, entry, SL, TP, confidence, entry_timing, cohort tag) → [05 Execution](05_execution.md) via [06 Risk & Discipline](06_risk_discipline.md) gate.

## Sub-specs
- [SEA_ImplementationPlan_v0.1.md](../specs/SEA_ImplementationPlan_v0.1.md) — per-tick inference, gate, trade mgmt, sizing.
- Design authorities (V2_MASTER_SPEC layers):
  - [§2.2 L2 targets](../V2_MASTER_SPEC.md) — head-type semantics (scalp/trend/swing).
  - [§2.4 L4 gate logic](../V2_MASTER_SPEC.md) — per-head decide_action + 3-way ensemble + bias filter.
  - [§2.5 L5 trade management](../V2_MASTER_SPEC.md) — inline composition exits (D67) + per-position state (D68).
  - [§2.6 L6 sizing](../V2_MASTER_SPEC.md) — equal allocation (D2) for v2 ramp.
  - [§2.7 L7 risk controls](../V2_MASTER_SPEC.md) — layer cap, swing cutoff, daily-loss budget.
  - [§2.8 L8 regime classifier](../V2_MASTER_SPEC.md) — trend_strong tier + 5-min sustain.
- Wave 2 legacy gate (disabled by default, `gate_mode='current'` per `config/sea_thresholds/`) — to be retired after v2 retrain ships.

## Data flow
```
live tick ─▶ feature vector (446 cols) ─▶ 84-head inference (LightGBM predict)
                                                  │
                                                  ▼
                          calibration.json sidecars applied per head (D72)
                                                  │
                                                  ▼
                  schema_reconciler quarantines heads whose schema_version mismatches LATEST (D66)
                                                  │
                                                  ▼
              L4 gate per head_type ─▶ decide_action_scalp / _trend / _swing (T29)
                                                  │
                                                  ▼
                      3-way ensemble combinator + agreement window + bias filter
                                                  │
                                                  ▼
                          L5 trade-mgmt: position state + inline exits (T30)
                                                  │
                                                  ▼
                         L6 sizing → L7 risk filter → L8 regime tag → signal
                                                  │
                                                  ▼
                                  signal + cohort tag (T33) → 05 execution
```

## Status
ACTIVE. T27 schema reconciler shipped. T25 calibration apply wired. 
**Pending pre-paper-trade (all MUST):**
- T29 — L4 v2 gate + head-type routing (~3–4d). Largest gap; current `decide_action_v2` is Wave-1 logic.
- T30 — L5 D67 inline composition exits + D68 per-position state (~3–4d).
- T33 — D56 cohort tagging end-to-end (~1d). Precondition for paper-trade attribution.
- T35 — partial-session handling + inference latency benchmark (~1d).

## Cross-refs
- [02_feature_engineering.md](02_feature_engineering.md) — feature input.
- [03_model_training.md](03_model_training.md) — model + reconciler partner.
- [05_execution.md](05_execution.md) — downstream consumer.
- [06_risk_discipline.md](06_risk_discipline.md) — pre-trade gate + exit signal partner.

## Open questions
- T29 v2 gate is the critical path for paper-trade promotion.
- Wave 2 legacy gate disabled today (`gate_mode='current'`); flip to `gate_mode='wave2'` per-instrument after first real retrain, then retire entirely once T29 v2 gate stable.