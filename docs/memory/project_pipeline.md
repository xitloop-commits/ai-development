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
TFA Replay → data/features/{date}/ (Parquet)
       ↓
Feature Validator → data/validation/ (JSON reports)
       ↓
Model Training Agent → trained model
       ↓
Decision Engine (live trading)
```

## Component status (as of 2026-04-14)

| Milestone | Date |
|-----------|------|
| Data collection start (TFA live, all 4 instruments) | 2026-04-14 (planned) |
| MTA + Signal Engine Agent (SEA) build | 2026-04-14 onwards (parallel to data collection) |
| End-to-end test run (partial data, test models) | after enough data to train |
| Delete test models, retrain with qualified data | after ~1 week of clean data |
| Real signal observation begins | after qualified retrain |

**Note:** First training run uses partial/test data for pipeline validation only.
Test model brains will be deleted and replaced once fully qualified data is available.

## Component status (as of 2026-04-13)

| Component | Status | Location |
|-----------|--------|----------|
| BSA (Broker Service Agent) | Built, working | server/ |
| Web UI | Built, working | client/ |
| TFA (TickFeatureAgent) | **Phases 0–15 all built, 961 tests passing** | python_modules/tick_feature_agent/ |
| Model Training Agent | Not yet specced | TBD |
| Old AI engine modules | Deprecated, moved to python_modules/deprecated/ | — |

## TFA completed phases (all tests passing as of 2026-04-13)

- Phase 0: instrument_profile.py (InstrumentProfile, load_profile)
- Phase 2: buffers/ (CircularBuffer, OptionBufferStore)
- Phase 3: feed/ (DhanFeed, ChainPoller, binary_parser)
- Phase 4: state_machine.py (StateMachine — WARMING_UP/TRADING/FEED_STALE/CHAIN_STALE)
- Phase 5: session.py (SessionManager — IST edge trigger, rollover)
- Phase 6: features/atm.py + features/active_strikes.py
- Phase 7: ALL feature modules (underlying, ofi, realized_vol, horizon, compression, time_to_move, option_tick, chain, active_features, decay, regime, zone, meta)
- Phase 8: chain_cache.py
- Phase 9: output/emitter.py (COLUMN_NAMES 370 cols, assemble_flat_vector, Emitter live+replay modes)
- Phase 10: features/targets.py (TargetBuffer, UpsidePercentileTracker, two-pass lookahead)
- Phase 11: output/alerts.py (AlertEmitter, DA handshake, 14 alert methods)
- Phase 13: recorder/ (NdjsonGzWriter, SessionRecorder, metadata_writer, DashboardWriter)
- Phase 14.1: replay/stream_merger.py (heap merge of 3 NDJSON.gz streams)
- Phase 14.2: replay/replay_adapter.py (full TFA pipeline in replay mode)
- Phase 14.3: replay/checkpoint.py (ReplayCheckpoint)
- Phase 14.4: replay/replay_runner.py (CLI: date-range iteration, checkpoint, validator)
- Phase 14.5: emitter Parquet mode (write_parquet, pyarrow casting)
- Phase 15: validation/feature_validator.py (3-layer validation: structural/null_rates/statistical)
- **Live pipeline integration**: tick_processor.py (hot path: all features → emit → record) + main.py fully wired (live asyncio loop + replay dispatch)

## TFA implementation order (user confirmed 2026-04-13)

1. Create 4 instrument profile JSON files (config/instrument_profiles/)
2. Build BSA credentials endpoint (GET /api/internal/broker/credentials)
3. Build TFA Phases: 11b → 0 → 1 → 2 → 4 → 5 → 3 → 13 (recording)
   → **Milestone A: start collecting raw data**
4. Build TFA Phases: 6 → 8 → 7 → 9 → 10 → 11 (features)
   → **Milestone B: live feature stream**
5. After ~1 month data: Phases 14 → 15 → 12 (replay + validation)
   → **Milestone C: Parquet training dataset**
6. Spec + build Model Training Agent
   → **Milestone D: first trained model**
7. Deploy to live production
   → **Milestone E: live trading with ML model**

## Key architectural decisions

- TFA runs as 4 isolated processes (one per instrument) — 4 Dhan WS + 1 BSA = 5 connections (Dhan limit)
- Stagger TFA process starts by 5s each
- DataRecorder as separate module was superseded — recording is built into TFA
- python_modules/deprecated/ contains all old AI engine modules
- data/ directory at project root (not inside python_modules/)
- Instrument profiles at config/instrument_profiles/

## Model Training Agent
- Reads Parquet from data/features/
- Resumes from its own checkpoint (not TFA's responsibility)
- Triggered explicitly by user ("train the model"), weekly
- NOT TFA's responsibility
- Location: python_modules/model_training_agent/
- Spec: docs/specs/ModelTrainingAgent_Spec_v0.1.md (draft)

## MTA (Model Training Agent)
- Replaces deprecated AI engine modules
- Consumes TFA NDJSON socket (live ticks), runs LightGBM inference
- Posts TradeSuggestions to RCA POST /api/risk-control/evaluate
- Location: python_modules/decision_engine/
- One process per instrument (4 total)
- Operates in AI Trades workspace (ai-paper default, ai-live via Settings)

## Model Architecture Decisions (locked)
- Algorithm: LightGBM v1 (LSTM/Transformer future TODO)
- 15 models per instrument (one per target column — see §4 of spec)
- Separate models per instrument (not shared)
- Minimum 5 trading days before first training
- Weekly retraining, manual trigger
- Versioning: timestamp-based (YYYYMMDD_HHMMSS)
- models/ at project root (gitignored), NOT inside data/
- config/model_feature_config/*.json git-tracked (feature config)

## Two-Phase Delivery (user decision 2026-04-13)
- Phase 1 (current): Build Model Training Agent + Signal Engine Agent (SEA)
  Signal Engine Agent (SEA) outputs signals to log/dashboard only — NO trade execution
  User manually watches GO_CALL/GO_PUT/WAIT signals and tracks win rate
- Phase 2 (future): Wire Signal Engine Agent (SEA) → RCA, then build RCA/TEA/Discipline/Portfolio
  Phase 2 starts ONLY after win rate is manually validated as satisfactory
  Downstream execution stack (RCA, TEA, Discipline, Portfolio) not in scope yet

## Open Items (model spec v0.1)
- E: Model promotion threshold (what AUC/RMSE is good enough?)
- F: Strike selection (ATM? ATM-1? best RR across ATM±1?)
- G: Signal Engine Agent (SEA) socket connection to TFA — RESOLVED: Unix Domain Socket
