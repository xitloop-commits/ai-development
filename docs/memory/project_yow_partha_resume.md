---
name: project-yow-partha-resume
description: yow-partha bot live but graceful-stop refactor pending — resume from direct-spawn architecture
metadata: 
  node_type: memory
  type: project
  originSessionId: f20481aa-cc4b-4fb1-bbc2-ba37069f057d
---

yow-partha Telegram bot is **live and working end-to-end** as of 2026-05-19 EOD, except for graceful process shutdown.

**Why:** Building a buttons-only Telegram bot that mirrors the Lubas desktop launcher onto Partha's iPhone. See [[project-yow-partha-bot]] for the naming/scoping context.

**Current state (shipped today):**
- Spec at `docs/specs/YowPartha_Spec_v0.1.md`, roster at `docs/specs/YowPartha_v0.1_Roster.md`.
- Module at `yow_partha/` — PTB v22.7 long-poll listener, launcher-style grouped main menu (API / Record / Replay / Train / Backtest+Compare+SEA+Watch placeholders / Tools / Delete / Shutdown).
- Multi-select date picker for Train AND Replay (reserved-date exclusion via `holdout_utils.resolve_holdout_dates`).
- Per-process Replay/Train listing (one row per running PID with date label).
- Lifecycle helper `_emit-lifecycle.ps1` extended with contextual inline buttons (only on error/warning; start/finish are buttonless per user choice).
- Plain-English message format (locked): `<emoji> <noun> <verb>[ <connector> <detail>]`, U+279C as separator, ISO-date prettifier (Apr 13th [2026]).

**How to apply (tomorrow's resume):**
- First task: graceful-stop refactor via direct-spawn (`yow_partha/_runners/direct.py`).
- Spawn Python with `subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NEW_CONSOLE`, bypassing the bats. Replicate each bat's argv/env inline.
- Stop sends `GenerateConsoleCtrlEvent(1, pid)` (CTRL_BREAK_EVENT) → Python flushes NDJSON, closes console, no `Terminate batch job?` prompt.
- Add confirmation tap before stop. Add bot-side `🛑 <process> stopped` lifecycle ping after kill.
- Caveat: only bot-spawned processes get graceful stop; launcher-spawned still force-kill.
- Also add: **smart shutdown gate** — on Shutdown tap, list any running managed processes; only allow shutdown when nothing is running (or via an explicit "Stop all and shutdown" button). Prevents accidentally nuking an in-flight replay/training.

**Env contract:** `YOW_PARTHA_BOT_TOKEN` + `YOW_PARTHA_CHAT_ID` in root `.env` (already set). Bot launched via `py -3 -m yow_partha.main` or `startup\start-yow-partha.bat`.

**Outstanding noise:** if bot is launched from Git Bash (as in dev), child bats may inherit GNU `find` and trip on `--date` args; fixed in `start-replay.bat` via `findstr` swap. Bot launched from desktop launcher does not have this issue.
