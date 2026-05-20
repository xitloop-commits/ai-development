# yow-partha v0.1 — Implementation Roster

**Created:** 2026-05-19
**Owner:** Claude (assistant) + Partha (reviewer)
**Spec:** [YowPartha_Spec_v0.1.md](YowPartha_Spec_v0.1.md)
**Goal:** ship buttons-only Telegram bot that mirrors the desktop launcher.

This roster is the single tracker for v0.1 work. Three sections — **Planned** (queued or in flight), **Done** (shipped), **Parked** (deferred with reason).

---

## Planned

| # | Item | Notes |
|---|------|-------|
| 1 | Update `YowPartha_Spec_v0.1.md` with today's iterations (date prettify, context-aware connector, batch-summary-deferred, 5 open items resolved) | quick edit pass |
| 2 | Create `yow_partha/` Python module skeleton — `main.py`, `handlers/`, `_runners/`, `_status.py`, `_auth.py`, `_ui.py`, `_utils.py`, `requirements.txt`, `README.md` | empty stubs first |
| 3 | Implement `_auth.py` — allowlist decorator (lift from `tfa_bot/bot.py` `_guard`) | |
| 4 | Implement `_utils.py` — IST tz, duration/size formatters, ISO-date prettifier | duplicate of helper logic for Python side |
| 5 | Implement `_status.py` — process liveness from log mtime + parquet/checkpoint progress reader | replay only; train fraction parked (#P3) |
| 6 | Implement `_ui.py` — status-table renderer + inline-keyboard builders per event-type | |
| 7 | Implement `_runners/bats.py` — shell-out wrappers for all 15 targets | uses `subprocess.Popen` with `CREATE_NEW_PROCESS_GROUP` |
| 8 | Implement `handlers/start.py` — `/start` → home table | |
| 9 | Implement `handlers/target.py` — row tap → per-target sub-screen | |
| 10 | Implement `handlers/action.py` — button tap → confirm-or-fire | |
| 11 | Implement `handlers/confirm.py` — destructive ops two-tap flow + shutdown three-tap flow | |
| 12 | Implement `handlers/logs.py` — `👀 See logs` / `👀 See error` log tail | reuse `tfa_bot/_tail_log` pattern |
| 13 | Implement `handlers/picker.py` — train-model date-list picker (instrument → from-date → to-date) | reads parquet dates from `data/raw/<INST>/` |
| 14 | Extend `_emit-lifecycle.ps1` with optional `inline_keyboard` markup per event type | default mapping from spec §4 |
| 15 | Wire `main.py` — PTB Application, register all handlers, set bot commands (`/start`), start polling | |
| 16 | Replace `start-yow-partha.bat` smoke-test with real launcher (`python -m yow_partha.main`) | keep lifecycle hooks so bot itself emits events |
| 17 | Add yow-partha to `stop-all.ps1` process matcher (so it's killed on system shutdown) | |
| 18 | End-to-end smoke test from iPhone — `/start` → table → tap row → tap action → bat fires → confirmation push | |

## Done

| # | Item | Date |
|---|------|------|
| — | (none yet — spec finalised, implementation queued) | — |

## Parked

| # | Item | Reason | Reactivation trigger |
|---|------|--------|----------------------|
| P1 | SEA × 4 control buttons | scope cut from v0.1 | yow-partha v0.2 |
| P2 | Watch (live dashboards) on phone | phone tap can't open desktop browser tabs | redesign needed (URL DM? screenshot?) |
| P3 | Train progress fraction in status table (`logs/train_progress_<INST>.json`) | requires `model_training_agent` changes | when MTA emits the progress file |
| P4 | Replay `planned_range` field in `replay_checkpoint.json` | requires `replay_runner.py` changes | when runner is updated |
| P5 | Per-instrument pipeline-done aggregate summary | user said "leave it" (2026-05-19) | future request |
| P6 | Train-model alternative pickers (presets, calendar) | date-list picker chosen | only if list picker proves awkward in practice |
| P7 | Tools menu (token refresh, creds info, file sizes, checkpoint status) on bot | stays on desktop launcher | if mobile need surfaces |
| P8 | Strategy-level control (pause signals, switch model, flatten position) | trading agents not wired yet | trading layer v1 |
| P9 | Multi-user / team mode | single-user by design | future product decision |

---

## Resume point — 2026-05-19 EOD

Bot is up and working end-to-end except for the graceful-stop path. Tomorrow's first task: implement **direct-spawn architecture**:

1. Add `yow_partha/_runners/direct.py` — spawns Python with `CREATE_NEW_PROCESS_GROUP | CREATE_NEW_CONSOLE` so each bot-started process has its own console window AND its own process group.
2. Replace bat-shellout in `callbacks.py` for API + replay + train + TFA-record with direct spawn. Replicate each bat's argv/env in Python.
3. Stop sends `GenerateConsoleCtrlEvent(1, pid)` (CTRL_BREAK_EVENT) to the new group → Python runs finally blocks → NDJSON flushes → window closes.
4. Add **confirmation tap** before stop (`About to stop X. Confirm?`).
5. Bot fires `🛑 <process> stopped` lifecycle ping after a successful kill (today the bat's stop-emit never reaches because we kill mid-execution).
6. Bot reply distinguishes graceful (bot-spawned) vs force (launcher-spawned) outcomes.
7. **Smart shutdown gate:** on Shutdown tap, scan for any running managed process (api / tfa / replay / train / sea later). If any are running, list them on the phone with a `⏹ Stop all and shutdown` button and a `✗ Cancel` button. Only when nothing is running, proceed to the existing two-tap shutdown confirmation. Avoids an accidental shutdown nuking an in-flight replay or training run.

Other items still parked or in flight from today's session:

- Replay date picker (multi-select, reserved excluded) — **shipped**, working.
- Per-process Replay/Train listing — **shipped**.
- Per-target stop with parent-window kill — **shipped** (but force-only; tomorrow's work flips this to graceful).
- Backtest / Compare / SEA / Watch — placeholders.
- `find` → `findstr` fix in start-replay.bat — **shipped** (handles non-standard PATH).

## Change log

| Date | Change |
|------|--------|
| 2026-05-19 | Roster created. 18 Planned, 0 Done, 9 Parked. |
| 2026-05-19 | Spec + module + bats wired end-to-end. Bot live, used from iPhone. Outstanding: graceful-stop refactor (direct-spawn) — pending tomorrow. |
