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
Stage-by-stage design of the perfect signal system. One layer per session for focus.

- **Status:** Architecture + locked constraints saved 2026-05-15. Layers 1-3 partially designed in `docs/TARGET_SPEC_V2_DESIGN.md`.
- **Layers designed so far:**
  - [x] Architecture overview
  - [x] Layer 1 (input features) — partial
  - [x] Layer 2 (target labels) — partial
  - [x] Layer 3 (model architecture) — partial
  - [ ] Layer 4 — Gate logic ← **NEXT UP**
  - [ ] Layer 5 — Trade management
  - [ ] Layer 6 — Position sizing
  - [ ] Layer 7 — Risk controls
  - [ ] Layer 8 — Regime / meta
  - [ ] Final integration: master `docs/SIGNAL_SYSTEM_V2.md`
- **Suggested order:** Layer 4 → 5 → 7 → 6 → 8 → revisit 1-3.
- **Constraints (do NOT re-litigate):**
  - Trades must live MINUTES (>5 min hold), not seconds. Per Partha's mandate.
  - Noise floor for nifty50 ≈ 8 pts (TP ≥25 pts, SL ≥15 pts).
  - Real trends visible only at 10-30 min horizons.
  - LightGBM stays — no transformer/LSTM pivot in this iteration.
  - Wave 2 scalp model stays as backup signal layer (don't delete).
- **One session per layer. Produce a `docs/<LAYER_NAME>_DESIGN.md` per session.**

### T3 — Trend-capture retrain (P1 blocker for paper trading)
The current Wave 2 model is a microstructure scalp predictor; doesn't satisfy "trades live MINUTES" mandate. Needs new target spec (10/15/30 min horizons with noise floor in labels), new multi-TF features, retrain.

- **Status:** Design complete in `docs/TARGET_SPEC_V2_DESIGN.md`. Implementation deferred.
- **Blocker:** Need ≥30 sessions of training data (currently ~10). Auto-recorder accumulates Mon-Fri.
- **Phases:**
  - [x] Phase 1: Design lock (`docs/TARGET_SPEC_V2_DESIGN.md`)
  - [ ] Phase 2: TFA feature additions (~1-2 days code)
  - [ ] Phase 3: Target additions (~1 day code)
  - [ ] Phase 4: Auto-record accumulation (~30 days passive)
  - [ ] Phase 5: Retrain all 4 with combined targets (~hours of compute)
  - [ ] Phase 6: Trend gate + smoke (~1 day code)
  - [ ] Phase 7: Paper trade ramp
- **Empirical evidence the current model is scalp-only:** 9/9 nifty50 signals on 2026-04-30 / 2026-05-11 were 5-7 pt captures at day-extreme reversals; 85-pt sustained 10:50-11:20 uptrend on 2026-05-11 produced ZERO signals.

## P2 — parked features (small enough to wait)

### T4 — Replay in-date progress indicator
Show events_done / events_total_est / rate / ETA in launcher Replay submenu while a replay is in flight. Replay submenu **only** — not main menu, train, or backtest.

- **Status:** Plan locked 2026-05-15 (Option 1 — estimated total via 1MB sample, ±10% precision).
- **Where:**
  - TFA writes `data/features/<date>/<inst>_progress.json` every ~2s with `{events_done, events_total_est, percent, rate, elapsed_s, eta_s}`.
  - Launcher's `act_replay` reads the progress file for the in-flight date and extends status_hint of the running-replay row.
- **Cost:** ~15-25 lines in `replay_runner.py`, ~15 lines in `launcher_v2.py`.
- **Out of scope:** pre-counting events (rejected — too slow), adding to Train/Backtest (Partha excluded).

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
