# Memory Index

**Top priority — always read first:** `docs/V2_MASTER_SPEC.md` is the single source of truth for the Signal System v2 (8-layer design, schema, component spec deltas, phase plan, 33 pending decisions). Consolidated 2026-05-16 from the now-deleted `SIGNAL_SYSTEM_V2.md`, `TARGET_SPEC_V2_DESIGN.md`, `REFERENCE.md`, `LAYER1_CANDIDATES.md`. See also `CLAUDE.md` for session-start checklist.

- [ML Training Pipeline Architecture](project_pipeline.md) — Full pipeline + current status (MTA+SEA MVP built 2026-04-16, 4 instruments trained, end-to-end backtest pending)
- [Autonomous Operation Permission](feedback_autonomous_mode.md) — User grants blanket permission to run commands and build without asking approval each step
- ~~[SEA Trade Signal Brainstorm](project_sea_brainstorm.md)~~ — **SUPERSEDED 2026-05-16 by `docs/V2_MASTER_SPEC.md` §2.4 (L4 Gate Logic) and §2.5 (L5 Trade Management). Kept on disk for historical reference; do not use as design source.**
- [ATS path conventions and naming](reference_paths_and_naming.md) — File-path map (raw vs features vs live ndjson vs models vs signals); nifty/nifty50 mismatch fix-later; launcher pipeline-stage layout
- [Repo worktree layout](reference_worktree_layout.md) — Primary dir on `main` (running programs); sibling `ai-development-ui-refactoring/` on `ui-refactoring` for dev work.
- [TradingDesk redesign plan](project_tradedesk_redesign.md) — Summary bar 10→6 items, table 15→10 columns, today row expands with trade details. Ready to implement.
- [Recorder gzip corruption fix (2026-04-21)](project_recorder_corruption_fix.md) — All raw .ndjson.gz from 2026-04-14→20 were corrupt due to missing cross-process lock in NdjsonGzWriter. Writer hardened, recovery script added, 28 files partially recovered.
- [MCX near-month rollover fix (2026-04-21)](project_mcx_rollover_fix.md) — ChainPoller was using profile's stale underlying_security_id; broke CRUDEOIL TFA after April contract expired. Fixed via override from main.py; profile ids are fallback-only for MCX.
- [Dhan WS limit blocks runtime testing](project_dhan_ws_limit.md) — Can't run ui-refactoring branch while main's TFA holds 4 Dhan WS connections; would exceed account limit and kill the live recorder.
