# Memory Index

- [ML Training Pipeline Architecture](project_pipeline.md) — Full pipeline + current status (MTA+SEA MVP built 2026-04-16, 4 instruments trained, end-to-end backtest pending)
- [Autonomous Operation Permission](feedback_autonomous_mode.md) — User grants blanket permission to run commands and build without asking approval each step
- [Work on refactor branch, not main (from 2026-04-21)](feedback_refactor_branch.md) — User is refactoring; keep main untouched. Future changes land on `refactor` branch.
- [SEA Trade Signal Brainstorm](project_sea_brainstorm.md) — SEA output: LONG_CE/LONG_PE/SHORT_CE/SHORT_PE + SL/TP. Feature groups, routing logic, spec changes needed.
- [ATS path conventions and naming](reference_paths_and_naming.md) — File-path map (raw vs features vs live ndjson vs models vs signals); nifty/nifty50 mismatch fix-later; launcher pipeline-stage layout
- [TradingDesk redesign plan](project_tradedesk_redesign.md) — Summary bar 10→6 items, table 15→10 columns, today row expands with trade details. Ready to implement.
- [Recorder gzip corruption fix (2026-04-21)](project_recorder_corruption_fix.md) — All raw .ndjson.gz from 2026-04-14→20 were corrupt due to missing cross-process lock in NdjsonGzWriter. Writer hardened, recovery script added, 28 files partially recovered.
- [MCX near-month rollover fix (2026-04-21)](project_mcx_rollover_fix.md) — ChainPoller was using profile's stale underlying_security_id; broke CRUDEOIL TFA after April contract expired. Fixed via override from main.py; profile ids are fallback-only for MCX.
