---
name: ML Training Pipeline Architecture
description: Full pipeline from data recording to model training — component responsibilities, boundaries, and current implementation status
type: project
originSessionId: 76596a3c-288e-48bc-b661-77b101f6c7b0
---
## Full pipeline

```
TFA (live + record) → data/raw/{date}/ (NDJSON.gz)
       ↓
TFA Replay → data/features/{date}/ (Parquet, 384 cols with 4 target windows)
       ↓
Feature Validator → data/validation/ (JSON reports, dynamic column count)
       ↓
MTA (Model Training Agent) → models/{instrument}/LATEST/ (29 .lgbm files per instrument)
       ↓
SEA (Signal Engine Agent) → raw signals + 4-stage filtered trade recommendations
       ↓
Scored Backtest → data/backtests/ (predictions + signals + filtered + scorecard)
```

## Component status (as of 2026-04-18)

| Milestone | Status |
|-----------|--------|
| TFA live recording (all 4 instruments) | Working |
| TFA replay → Parquet features | Working (skip-on-fail for corrupt gzip) |
| MTA 29-target training (4 windows: 30s/60s/5min/15min) | DONE |
| SEA with 4-stage trade filter | DONE |
| Scored backtest with filter metrics | DONE |
| UI signal feed shows filtered trade recommendations | DONE |
| 4 instruments trained with 15 models each (30s/60s only) | DONE (2026-04-18) |
| Re-replay + retrain with 29 targets (adding 5min/15min) | PENDING |

## Target windows: [30, 60, 300, 900]

- 30s/60s: fast direction confirmation (filter Stage 1 uses direction_30s)
- 300s (5min): entry timing + scalp TP/SL
- 900s (15min): main swing TP/SL (meaningful profit after brokerage)
- SEA _decide() uses 15min→5min→30s fallback for TP/SL

## 4-Stage Trade Filter

1. **Sustained Direction**: same action for N consecutive ticks (default 5)
2. **Confidence Gate**: avg conviction prob >= 0.65, min >= 0.55
3. **Multi-Model Consensus**: score >= 4/6 (direction, upside, RR, regime, magnitude)
4. **Direction Change**: only emit on BULLISH↔BEARISH flip (prevents repeated same-direction)

Results on nifty50 Apr 16: 1710 raw → 34 filtered at 97.1% precision
Results on naturalgas Apr 16: 3030 raw → 57 filtered at 86.0% precision

## Scored Backtest

- `backtest_scored.py`: runs SEA inline on parquet, scores predictions vs ground truth
- `backtest_compare.py`: side-by-side comparison of two model versions
- Output: data/backtests/{instrument}/{model_version}/{date}/scorecard.json

## Feedback Loop (planned, not yet built)

Phase 3: FeedbackTracker (prediction accuracy, signal outcomes)
Phase 4: Feature pipeline integration (15 fb_ columns in emitter)
Phase 5: Wire into engine + backtest
Phase 6: Validation
Meta-model gatekeeper (future)

## Raw data integrity (2026-04-18)

Most raw gzip files have truncated/corrupt endings (TFA killed before gzip close).
Replay handles this gracefully — reads whatever lines are valid, marks checkpoint, continues.
Clean files: crudeoil Apr 17, naturalgas Apr 17, nifty50/banknifty Apr 16.

## Key architectural decisions

- TFA runs as 4 isolated processes (one per instrument)
- target_windows_sec is dynamic — profiles, emitter, validator all use the tuple
- Column count varies: 370 for [30,60], 384 for [30,60,300,900]
- Old 370-column hardcoded assertions removed, replaced with dynamic checks
- Models per instrument: 29 (one per target in MVP_TARGETS)
- SEA raw signals still logged for UI feed; filtered signals logged separately (_filtered_signals.log)
- UI auto-detects filtered signals when available
