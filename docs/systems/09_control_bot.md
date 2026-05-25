# 09 — Control Bot (yow-partha)

Single source of truth for the **yow-partha Telegram bot** — Partha's phone-side control surface for the Lubas pipeline. Buttons-only, single-user, supervised by Lubas.

## 1. Purpose & Scope

**In scope:**
- Telegram bot that turns the phone into a remote launcher for the Lubas trading system.
- `/start` (tap-only) renders a live status table of every launcher target.
- Per-target sub-screens with `▶ Start` / `⏹ Stop` / `↻ Restart` / `👀 See logs` / `🏠 Home` buttons.
- Push notifications for lifecycle events (already wired via `startup/_emit-lifecycle.ps1`) with inline action buttons.
- Date-list picker for `train` (since typing is banned).
- Confirmation flow on destructive actions (Stop / Restart / Delete / Shutdown).
- Auto-start at 8:55 IST Mon–Fri via the `Lubas-YowPartha-Daily` Windows scheduled task.
- Single-user allowlist (one `YOW_PARTHA_CHAT_ID`).

**Out of scope (v0.1):**
- SEA control buttons (deferred to v0.2 — the signal engines aren't operator-toggled in production today).
- Live dashboards / "Watch" mode (desktop-only; a phone tap can't open a desktop browser).
- Tools menu (token refresh, creds info, file sizes, checkpoint detail — stays on the desktop launcher).
- Typed commands beyond the initial `/start`.
- Multi-user / team mode.
- Notifications routing infrastructure → [08 UI Desktop §8](08_ui_desktop.md). yow-partha is one of the delivery routes; the catalog + preferences UI lives there.

## 2. Architecture at a glance

```
                    Lubas-YowPartha-Daily task
                    (Mon–Fri 08:55 IST, WakeToRun)
                                │
                                ▼
                       startup/start-yow-partha.bat
                                │
                                ▼
                     python -m yow_partha.main
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
        Telegram updates    _auth check    _emit-lifecycle.ps1
        (button taps,       (chat-id        (push events from
         callback_query)     allowlist)      launcher scripts)
                │                                   │
                ▼                                   ▼
        handlers/ dispatchers          inline keyboard payload
                │                                   │
                └───────────────┬───────────────────┘
                                ▼
                       _status.py probes
                       running-process state
                                │
                                ▼
                       _ui.py renders status table
                       + per-target sub-screens
                                │
                                ▼
                       Telegram message + inline buttons
                                │
                                ▼
                       button tap →
                       shells out to startup/start-*.bat
                       or startup/stop-all.ps1
```

**One execution path, two surfaces.** The bot never re-implements a launcher action — every button shells to the same `startup\start-*.bat` / `startup\stop-all.ps1` the desktop launcher already calls. That guarantees behaviour parity between phone and desk.

## 3. Module layout

| File | LOC | Purpose |
|---|---|---|
| `yow_partha/main.py` | 91 | Entry point; wires `python-telegram-bot` app, registers handlers, starts polling. |
| `yow_partha/_auth.py` | 42 | Single-chat allowlist (`YOW_PARTHA_CHAT_ID`). Silent reject — never confirms the bot's existence to a wrong user. |
| `yow_partha/_status.py` | 268 | Probes running-process state (API, recorders × 4, replays × 4, trains × 4, backtest × 4, compare × 4). Reads checkpoint files for progress fragments. |
| `yow_partha/_ui.py` | 357 | Renders status table + per-target sub-screens + confirmation messages. Inline-keyboard builders for every action set. |
| `yow_partha/_utils.py` | 73 | Shared helpers (formatting, time, file-path resolution). |
| `yow_partha/_runners/` | — | Per-action shells to `startup/*.bat` / `stop-all.ps1`. One module per target class. |
| `yow_partha/handlers/` | — | Callback-query dispatchers, one per action verb. |
| `yow_partha/requirements.txt` | — | `python-telegram-bot` + minimal deps. |

Total ~837 LOC.

## 4. The status table (entry point)

`/start` (always tappable, never typed beyond the first tap) renders one Telegram message:

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

Every non-header row is a tappable inline button. State icons:

- 🟢 running
- ⚫ stopped (clean)
- 🔴 crashed (non-zero exit)
- ⏳ starting / shutting down (transient, ≤ 30 s)

The progress fragment (e.g. `➜ 12/40`) appears inline for long-iterating processes (replay, train) by reading the same checkpoint files the desktop launcher reads. `🏠 Home` on any sub-screen re-renders the table with fresh state.

## 5. Per-target sub-screens

Tap a row → sub-screen with the right actions for the current state:

| Current state | Buttons offered |
|---|---|
| Running | `⏹ Stop` · `↻ Restart` · `👀 See logs` · `🏠 Home` |
| Stopped | `▶ Start` · `👀 See logs` · `🏠 Home` |
| Crashed | `▶ Start` · `👀 See error` · `🏠 Home` |

`👀 See logs` / `👀 See error` reply in-thread with the last 20 lines (See error filters WARN/ERROR only). Pattern lifted from the removed `tfa_bot`'s `/errors` command.

Destructive actions (`⏹ Stop`, `↻ Restart`, `🔌 Shutdown computer`, every `🗑 Delete` button) require a **second tap on a confirmation message**:

```
About to stop NIFTY 50 recorder.
[ ✓ Yes, stop ]  [ ✗ Cancel ]
```

## 6. Push notifications (lifecycle events)

`startup/_emit-lifecycle.ps1` already pushes lifecycle events into the Telegram chat. yow-partha extends each push with an inline-keyboard payload so the user can act directly from the alert:

| Event | Buttons appended |
|---|---|
| 🟢 start | `⏹ Stop` · `↻ Restart` |
| ✅ ok / completed | `▶ Start again` · `🏠 Home` |
| 🔴 error / crashed | `👀 See error` · `↻ Restart` · `⏹ Stop` |
| ⚠️ warning | `👀 See logs` · `✓ Ack` |
| 🛑 stopped (system) | (none — terminal) |

Each button's `callback_data` is `<action>:<process>` (e.g. `stop:tfa-nifty50`, `seeerror:api`). The handler routes the callback to the same execution path as a manually-triggered button.

`✓ Ack` is a no-op that just removes the button row — lets the user dismiss a warning without taking action.

## 7. Date-list picker for `train`

Training takes `--date-from` and `--date-to`. Since typing is banned:

1. Home → tap a `Train` row → tap instrument confirmation.
2. Bot reads available dates from the trainer's data source (`data/raw/<inst>/`) and renders them as buttons, newest first, paginated 20 per page.
3. Operator taps date-from, then date-to. Bot confirms the range, then shells `startup\start-train.bat`.

## 8. Auto-start + supervision

- **Scheduled task:** `Lubas-YowPartha-Daily` — weekly trigger Mon–Fri 08:55 IST, `-WakeToRun` brings the laptop out of sleep. Registered in `startup/install-scheduled-tasks.ps1` (one elevated install per machine).
- **Launch script:** `startup/start-yow-partha.bat` spawns `python -m yow_partha.main`.
- **Supervision:** the bot is managed as a process by Lubas; auto-restart on crash, lifecycle emission to its own Telegram channel.
- **Manual run:** `python -m yow_partha.main` from the repo root works for development. Reads `.env` for `YOW_PARTHA_BOT_TOKEN` + `YOW_PARTHA_CHAT_ID`.

## 9. Security model

- **Allowlist of one.** `YOW_PARTHA_CHAT_ID` env var is the only permitted chat. Every other chat receives **no reply at all** — silent reject. Never confirm the bot's existence to a wrong user.
- **No typed commands beyond `/start`.** Eliminates the entire class of free-text-parsing bugs.
- **Confirmation required on every destructive action.** Two taps separated by a confirmation message — protects against pocket-taps on `Shutdown` or `Delete Raw`.

The single-chat policy intentionally rules out team mode; if Partha needs spouse access in the future, that's a v1.0 design discussion, not a config flip.

## 10. Status

**ACTIVE — v0.1 live since 2026-05-19.**

- Bot supervises 4 recorders + 4 replays + 4 trains + 4 backtests + 4 compares + API + Shutdown (≈ 22 targets total).
- Auto-start scheduled task created 2026-05-20.
- Migration from removed `tfa_bot/` complete (see migration guide for the 8 reusable patterns).

**Pending:**
- [T39](../PROJECT_TODO.md) — graceful-stop refactor (direct-spawn architecture). Today the bot uses a separate polling daemon; direct-spawn from Lubas would give cleaner process lifecycle + better stop-signal propagation + no orphan listeners on Lubas restart. ~1 day. Design notes captured before the per-machine memory was cleaned up; original resume point at v0.1 EOD.
- [T52 [UI]](../PROJECT_TODO.md) — Notifications backend full Telegram routing. Today the bot pushes some events (token expiry, session-close anomaly); the catalog of every-trade / gate-rejection / DISCIPLINE_EXIT events isn't wired through. Lands when T52 ships the routing layer.
- **v0.2 (post-paper-trade):** SEA control buttons (start / stop / inspect signal engine × 4), maybe a `flatten position` super-action wired into the Discipline `MUST_EXIT` path. Tracked separately when v0.1 stabilises.

## 11. Cross-refs

- [05 Execution](05_execution.md) — yow-partha shells into `startup/stop-all.ps1`, which graceful-stops the broker connections too.
- [08 UI Desktop](08_ui_desktop.md) — sister control surface; the Notifications spec lives there and yow-partha is one of its delivery routes.
- [10 Launcher & Ops](10_launcher_ops.md) — yow-partha and the desktop launcher both shell out to the same `startup/*.bat` scripts. Scheduled-task registration lives there.
- [PROJECT_TODO.md](../PROJECT_TODO.md) — T39 (graceful-stop refactor), T52 (Notifications backend).

## 12. Code + ops locations

| What | Path |
|---|---|
| Bot entry + handlers | `yow_partha/main.py` |
| Single-chat allowlist | `yow_partha/_auth.py` |
| Process-state probes | `yow_partha/_status.py` |
| UI rendering (tables + sub-screens) | `yow_partha/_ui.py` |
| Action runners (shells to startup/*) | `yow_partha/_runners/` |
| Callback-query dispatchers | `yow_partha/handlers/` |
| Bot dependencies | `yow_partha/requirements.txt` |
| Manual launch script | `startup/start-yow-partha.bat` |
| Lifecycle push helper | `startup/_emit-lifecycle.ps1` |
| Scheduled-task registration | `startup/install-scheduled-tasks.ps1` (`Lubas-YowPartha-Daily` block) |
| Env vars consumed | `YOW_PARTHA_BOT_TOKEN`, `YOW_PARTHA_CHAT_ID` (read from root `.env`) |
| Tests | (none — bot logic is exercised via manual smoke runs against the live Telegram API) |
