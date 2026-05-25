# yow-partha

Buttons-only Telegram bot that mirrors the desktop Lubas launcher onto your phone.

## What it does

- `/start` (tap-only) → live **status table** of every launcher target with traffic-light state.
- Tap a row → action sub-screen (`▶ Start`  `⏹ Stop`  `↻ Restart`  `👀 See logs`  `🏠 Home`).
- Tap a destructive action → one-tap confirmation; tap **Shutdown computer** → two-tap confirmation.
- Listens for `callback_query` events on lifecycle pushes (`👀 See error`, `↻ Restart`, etc.).

## What it is NOT

- **Not** a re-implementation of any launcher action. Every action shells out to the same `startup\start-*.bat` / `startup\stop-all.ps1` the desktop launcher already calls. One execution path, two surfaces.
- **Not** a typed-command bot. The only typed thing is the initial `/start`, which Telegram surfaces as a tappable button.
- **Not** running unless Lubas supervises it. The bot has no auto-start of its own; it's launched by Lubas (`startup\start-yow-partha.bat`) and emits its own lifecycle events.

## Running locally

```
pip install -r yow_partha/requirements.txt
python -m yow_partha.main
```

Required environment variables (read from root `.env`):

- `YOW_PARTHA_BOT_TOKEN` — BotFather token for `@yowparthabot`.
- `YOW_PARTHA_CHAT_ID` — your Telegram user id (allowlist of one).

## Design + status

Single source of truth: [docs/systems/09_control_bot.md](../docs/systems/09_control_bot.md) — purpose, scope, architecture, status table format, push-notification matrix, security model, code locations.

Open work: [docs/PROJECT_TODO.md](../docs/PROJECT_TODO.md) — `T39` (graceful-stop direct-spawn refactor), `T52` (full Telegram routing for trade events).
