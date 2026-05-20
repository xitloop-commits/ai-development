# yow-partha — Spec v0.1

**Created:** 2026-05-19
**Status:** Draft v0.1. Locked decisions cited inline; open items at the bottom.
**Supersedes:** the removed `tfa_bot/` module (see `YowPartha_Migration_From_TfaBot.md`).
**Companion docs:** `Notifications_Spec_v0.1.md` (the outbound routing layer; yow-partha is its Telegram delivery surface for lifecycle events).

---

## 1. Scope

yow-partha is a Telegram bot that turns the user's phone into a **remote launcher** for the Lubas trading system. It is:

- **Buttons-only**: zero typing after the one-time `/start` tap (Telegram surfaces `/start` as a button on first open and as a slash-menu entry thereafter).
- **Bidirectional**: receives state-change pushes from launcher scripts (already wired via `_emit-lifecycle.ps1`) AND accepts button-driven commands to start / stop / restart / inspect every process the desktop launcher knows about.
- **Single-user**: allowlist of one chat id (`YOW_PARTHA_CHAT_ID`). All other chats rejected silently — never confirm the bot's existence to a wrong user.
- **Always-up**: supervised by Lubas as a managed process, auto-restart on crash, lifecycle-emitting itself.

### In scope (v0.1)

| Target              | Action buttons              | Notes                                              |
|---------------------|-----------------------------|----------------------------------------------------|
| API server          | Start · Stop · Restart      | 1 instance                                         |
| Recorders (TFA × 4) | Start · Stop · Restart      | nifty50, banknifty, crudeoil, naturalgas           |
| Replay × 4          | Start · Stop · Restart      | Per-instrument                                     |
| Train × 4           | Start · Stop · Restart      | Per-instrument; needs date-list picker (see §5)    |
| Backtest × 4        | Run                         | Sub-screen for instrument; one-shot                |
| Compare × 4         | Run                         | Sub-screen for instrument; one-shot                |
| Delete              | Raw · Parquet · Live · Models | 4 sub-buttons, each guarded by confirmation tap |
| Shutdown system     | Confirm                     | Fires existing `stop-all.ps1` (graceful + OS off)  |

### Explicitly NOT in v0.1

- **SEA (signal engines × 4)** — deferred to v0.2.
- **Watch** (live dashboards) — desktop-only, phone tap can't open desktop browser tabs. Skipped.
- **Tools menu** (token refresh, creds info, file sizes, checkpoint status) — stays on the desktop launcher.
- **Typed commands** — only `/start` (which is a tappable, not typed).
- **Multi-user / team mode** — single chat id only.
- **In-app strategy control** (pause signals, switch model, flatten position) — comes when the trading agents themselves are wired in v0.2+.

---

## 2. Entry point and home screen

`/start` always renders the **live status table** as a single Telegram message:

```
🤖 yow-partha — status

🟢 API server                      running
🟢 NIFTY 50 recorder               running
⚫ Bank Nifty recorder             stopped
🔴 Crude Oil recorder              crashed
⚫ Natural Gas recorder            stopped
🟢 Crude Oil replay     ➜ 12/40   running
⚫ NIFTY 50 train                  stopped
…
🔌 Shutdown computer
```

Each non-header row is a tappable **inline button** (the row label is the button text). Tapping a row drills into a per-target sub-screen.

State icons:

- 🟢 running
- ⚫ stopped (cleanly)
- 🔴 crashed (stopped with non-zero exit)
- ⏳ starting / shutting down (transient, ≤30s)

Progress fragment (e.g. `12/40`) appears inline for **long-iterating processes** (replay, train) by reading their checkpoint files; see §6.

Re-tapping `/start` (or the `🏠 Home` button on any sub-screen) re-renders the table with fresh state.

---

## 3. Per-target sub-screens

Tapping a target row opens a sub-screen with action buttons appropriate to that target's current state:

| Current state | Buttons offered                                   |
|---------------|---------------------------------------------------|
| Running       | `⏹ Stop`  `↻ Restart`  `👀 See logs`  `🏠 Home` |
| Stopped       | `▶ Start`  `👀 See logs`  `🏠 Home`              |
| Crashed       | `▶ Start`  `👀 See error`  `🏠 Home`             |

Destructive actions (`⏹ Stop`, `↻ Restart`, `🔌 Shutdown`, all Delete buttons) require a **second tap on a confirmation message** before firing:

```
About to stop NIFTY 50 recorder.
[ ✓ Yes, stop ]  [ ✗ Cancel ]
```

`👀 See logs` and `👀 See error` reply in-thread with the last 20 lines of that process's log file (`See error` filters to WARN/ERROR levels only — same pattern as the deleted `tfa_bot`'s `/errors` command; see `YowPartha_Migration_From_TfaBot.md` §10).

---

## 4. Push notifications with contextual buttons

Every lifecycle event (already pushed via `_emit-lifecycle.ps1`) gets **inline buttons** matched to the event type:

| Event                 | Buttons appended                              |
|-----------------------|-----------------------------------------------|
| 🟢 start              | `⏹ Stop`  `↻ Restart`                        |
| ✅ ok / completed     | `▶ Start again`  `🏠 Home`                   |
| 🔴 error / crashed    | `👀 See error`  `↻ Restart`  `⏹ Stop`        |
| ⚠️ warning            | `👀 See logs`  `✓ Ack`                       |
| 🛑 stopped (system)   | (none — terminal)                             |

The `_emit-lifecycle.ps1` helper is extended to attach a `reply_markup.inline_keyboard` payload alongside the existing `text` payload. Each button carries `callback_data` of the form `<action>:<process>` (e.g. `stop:tfa-nifty50`, `seeerror:api`). The Python listener routes the callback to the same execution path as a manually-triggered button.

`✓ Ack` is a no-op handler that just removes the button row (so the user can mark a warning as dismissed without taking action).

---

## 5. Date-list picker for `train`

Train-model needs `--date-from` and `--date-to`. Since typing is banned, the flow is:

1. Home → tap a Train row → tap instrument confirmation.
2. Bot reads dates that have parquet data for that instrument (`data/raw/<INSTRUMENT>/*.parquet` or wherever the trainer's data source lives — see Open Items) and renders them as buttons, newest first, paginated 20 per page.
3. User taps a date → that becomes `from-date`; the list re-renders highlighting only dates ≥ from-date as eligible for `to-date`.
4. User taps a second date → confirmation message with both dates and a fire/cancel pair.
5. Confirm → bot shells out to `start-tfa.bat` … wait, that's wrong → `train-model.bat <instrument> <from> <to>` and replies with a lifecycle event when done.

If only one date is desired (`from == to`), the user taps the same date twice.

---

## 6. Progress reading (status-table)

For long-running iterative processes:

- **Replay:** read `data/raw/replay_checkpoint.json` (already maintained by `replay_runner.py`). Schema today: per-instrument map of completed date → timestamp. Compute progress as `len(completed) / len(planned_range)`; spec mandates `replay_runner` writes a `planned_range` field alongside.
- **Train:** **new contract** — `model_training_agent` must emit progress to `logs/train_progress_<INSTRUMENT>.json` with `{ "done": N, "total": M, "current_date": "YYYY-MM-DD", "started_at": "..." }`. Bot reads on every status refresh.

If no progress file exists or it's older than 5 minutes, the row shows the bare state without a fraction.

Final completion messages use the locked plain-English shape (see §10 — context-aware connector replaced the early-design arrow):

```
✅ NIFTY 50 replay finished, 40/40
✅ Crude Oil model training finished, Apr 13th to Apr 15th
🔴 NIFTY 50 replay crashed because 5/40 finished before error
```

---

## 7. Shutdown flow

The bottom row of the home table is `🔌 Shutdown computer`. Tapping opens a **two-tap** confirmation (one extra step beyond regular destructive ops, because OS shutdown is the most expensive mistake):

1. Tap row → confirm message: `Shut down the whole computer? [ ✓ Yes ]  [ ✗ Cancel ]`
2. Tap Yes → second confirm: `This will kill all running processes and power off the machine in 60s. Confirm again to fire. [ ✓ Confirm ]  [ ✗ Cancel ]`
3. Tap Confirm → bot fires `stop-all.ps1` (existing, unchanged).

The 60s grace window can be cancelled at the desktop by `shutdown /a` (already documented in `stop-all.ps1`).

---

## 8. Architecture

```
yow_partha/
├── main.py              # listener entry: PTB Application, registers handlers, starts polling
├── handlers/
│   ├── start.py         # /start → home table
│   ├── target.py        # row tap → sub-screen
│   ├── action.py        # button tap → exec
│   ├── confirm.py       # destructive ops two-tap flow
│   └── logs.py          # See error / See logs handler
├── _runners/
│   ├── bats.py          # shells out to start-*.bat / stop-all.ps1
│   └── progress.py      # reads replay / train checkpoints
├── _status.py           # liveness check (log mtime + process list)
├── _auth.py             # allowlist decorator
├── _ui.py               # button-row builders, status-table renderer
├── requirements.txt     # python-telegram-bot[job-queue]==20.8, python-dotenv
└── README.md
```

**Listener:** `python-telegram-bot` v20.x long-poll. Same library/pin as the deleted `tfa_bot/` (see migration doc §8 for the rationale).

**Execution path:** the bot **never reimplements** what the launcher already does. Every action shells out to the same `start-*.bat` / `stop-all.ps1` / `train-model.bat` etc. So bot-fired and launcher-fired actions hit the identical code path; future changes to a bat propagate to both surfaces automatically.

**Auth:** `_auth.py` decorator checks `update.effective_user.id == int(os.environ["YOW_PARTHA_CHAT_ID"])`. Wrong chat → silently drop the update (no reply, no log message above DEBUG). Same pattern as `tfa_bot/bot.py`'s `_guard` (see migration doc §1).

**Self-supervision:** Lubas's `launcher_v2.py` adds yow-partha to its managed process list. `start-yow-partha.bat` (currently a smoke-test) is replaced with the real bot launcher that runs `python -m yow_partha.main`. On crash, Lubas auto-restarts. Bot itself emits `🟢 yow-partha started` / `🛑 yow-partha stopped` / `🔴 yow-partha crashed` lifecycle events to itself (via `_emit-lifecycle.ps1`).

**Push surface:** `_emit-lifecycle.ps1` already exists and is the only push surface. The bot does NOT push anything directly — every push originates from a launcher script. Bot only handles **inbound** button taps. This keeps a clean separation: launcher = source of truth for "what's happening"; bot = control surface and renderer.

To attach inline buttons to existing pushes, the helper is extended with two optional params: `-Buttons '<json array>'` and a default button set derived from `Result`. The default set is what §4 specifies; callers can override.

---

## 9. Reused patterns from tfa_bot

Per `YowPartha_Migration_From_TfaBot.md`, lift these as-is:

- §1 Auth guard decorator → `_auth.py`
- §3 Liveness from log mtime → `_status.py`
- §4 Traffic-light rendering → `_ui.py`
- §5 Markdown V1 safety wisdom → `_ui.py` (also evaluate switching to HTML parse mode for less escape hell)
- §9 IST + size + duration formatters → `_utils.py`
- §10 Log tail with level filter → `handlers/logs.py`

Do NOT lift:

- Per-instrument command explosion (16 handlers). Use args / callback_data instead.

---

## 10. Decisions locked

- **Buttons only.** No typed commands ever. `/start` is the single entry point (Telegram surfaces it as tappable). [Source: 2026-05-19 chat — "i dont type any in bot".]
- **Single user.** No multi-user, no team mode. Allowlist = `YOW_PARTHA_CHAT_ID` only. Wrong chats silently dropped. [Source: 2026-05-19 — bot is personal operator surface.]
- **Bot is a thin client over the launcher.** All actions shell out to existing bats. No reimplementation. [Source: migration doc §2.]
- **Plain-English messages.** Process → human noun ("NIFTY 50 recorder"), result → human verb ("crashed" / "started"), no `code=N` jargon in chat. Already wired in `_emit-lifecycle.ps1`. [Source: 2026-05-19 — "normal english a layman understanble".]
- **Progress is pull, not push.** No intermittent progress pings during replay/train. User taps `/start` to see live progress in the status table. [Source: 2026-05-19 — "no, i will say hi, from there we find option to check the status".]
- **Context-aware connector per verb** between the verb and the detail (`started for ...`, `finished, ...`, `crashed because ...`, `Heads up from ...: ...`, `stopped. ...`). Replaces the earlier-locked arrow separator. The connector switches to a bare space when the detail already begins with its own preposition (`up to`, `since`, `from`, etc.) to avoid awkward phrasing like "started for up to Dec 31st". [Source: 2026-05-19 — "remove arrow and connect english", Option B chosen.]
- **Dates inside detail strings are prettified** via regex transform in `_emit-lifecycle.ps1`: `YYYY-MM-DD` → `Mon Nth [YYYY]` (e.g. `Apr 13th`). Year is omitted when it matches the current calendar year, included when it differs. Raw ISO stays in the NDJSON log for forensics. [Source: 2026-05-19 — "date format is jan 4th 2026", "Apr 1st to Apr 30th".]
- **Long lines, no newlines.** Telegram chat is single-line per message. [Source: 2026-05-19 — "do not break, keep in line".]
- **No hashtags, no bold.** [Source: 2026-05-19 — "turn off and proceed".]
- **Two-tap confirmation for shutdown.** One-tap confirmation for other destructive ops.
- **Train-model uses a date-list picker** (not preset buttons, not calendar). User picks from-date and to-date from actual data-available parquet dates. [Source: 2026-05-19 — "list the dates, i will pick from that".]
- **No batch-summary push.** Per-instrument pipeline-done aggregate ("NIFTY 50 — full pipeline done") is deferred to a later spec; current per-process pings stay as-is. [Source: 2026-05-19 — "leave it".]

---

## 11. Open items

5 of the 7 original items resolved 2026-05-19 (decisions inline). 2 remain parked — see `YowPartha_v0.1_Roster.md` for the full Parked list.

| # | Item                                                                                              | Resolution                                                 |
|---|---------------------------------------------------------------------------------------------------|------------------------------------------------------------|
| 1 | Trainer must emit `logs/train_progress_<INSTRUMENT>.json` — new contract, needs MTA changes.       | **Parked.** Train rows show without fraction until MTA emits the file (no v0.1 MTA change). |
| 2 | `replay_runner.py` must add `planned_range` to `replay_checkpoint.json`.                          | **Parked.** Bot computes best-effort fraction from the checkpoint's completed-date count; if `planned_range` is missing the row shows "X done" without `/Y`. |
| 3 | Date-list source for the train picker.                                                            | **Decided.** Bot probes `data/raw/<INSTRUMENT>/<DATE>/` directory names (`YYYY-MM-DD` folders, same convention `replay_runner` uses). |
| 4 | Pagination UX for >20 available dates.                                                            | **Decided.** `< Older` / `Newer >` button pair at the bottom of each page; 20 dates per page, newest first. |
| 5 | Telegram message length cap (4096 chars).                                                         | **Decided.** Log tail truncated to last 20 lines (compact format) before send; status table fits comfortably under cap. |
| 6 | Bot polling interval vs webhook.                                                                  | **Decided.** PTB default long-poll (10s). Webhook deferred — needs public URL infra. |
| 7 | Tap `▶ Start` on already-running process.                                                         | **Decided.** Bot replies with status echo (`🟢 NIFTY 50 recorder is already running`) and does NOT re-spawn. Avoids dup-fire collisions with the 5-minute lock in `start-all.bat`. |

---

## 12. Dependencies

- `_emit-lifecycle.ps1` — push surface; extended with inline-keyboard payloads.
- `start-*.bat` / `stop-all.ps1` / `train-model.bat` / `backtest-*.bat` / `backtest-compare.bat` — execution surface (unchanged).
- `data/raw/replay_checkpoint.json` — needs `planned_range` field added.
- `logs/train_progress_<INSTRUMENT>.json` — new file written by `model_training_agent`.
- `python-telegram-bot[job-queue]==20.8` — listener library.
- Existing patterns from `tfa_bot/` via `YowPartha_Migration_From_TfaBot.md`.

---

## 13. Change Log

| Date       | Version | Change                                              |
|------------|---------|-----------------------------------------------------|
| 2026-05-19 | v0.1    | Initial draft (scope, home screen, push buttons, train date picker, architecture, open items). |
| 2026-05-19 | v0.1.1  | Folded in same-day iterations: arrow separator → context-aware connector (Option B), ISO-date prettifier (`Apr 13th [2026]`), batch-summary-deferred decision, 5 of 7 open items resolved with defaults. |
