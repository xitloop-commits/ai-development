# YowPartha — Migration Notes from `tfa_bot/`

**Created:** 2026-05-19
**Reason:** The narrow `tfa_bot/` (Telegram process-manager for 4 TFA instruments) is being removed in favour of `yow-partha`, a full project-level Telegram control + visibility bot. The patterns below are non-obvious wisdom from `tfa_bot/bot.py` that should be lifted into yow-partha rather than rediscovered.

This is a **read-only catalogue** of "what to lift, from where, and why." It is not yow-partha's own spec — that lives at `YowPartha_Spec_v0.1.md` (to be drafted next).

---

## 1. Auth guard decorator

**Source:** `tfa_bot/bot.py` lines 460–468 (`_guard`)

**Pattern:** every command handler is wrapped by `@_guard` which checks `update.effective_user.id == ALLOWED_USER_ID` and replies "⛔ Unauthorized" otherwise. Single-user allowlist via env var.

**Why lift:** simple, correct, no surface area for bypass. yow-partha needs tiered auth (read / write / destructive); the same decorator factory pattern extends cleanly — e.g. `@_guard(level="destructive")` that also requires OTP.

```python
def _guard(func):
    async def wrapper(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        if not update.effective_user or update.effective_user.id != ALLOWED_USER_ID:
            if update.message:
                await update.message.reply_text("⛔ Unauthorized")
            return
        await func(update, ctx)
    return wrapper
```

---

## 2. Log-derived health (scope to latest TFA_START)

**Source:** `tfa_bot/bot.py` lines 177–285 (`_compute_health`)

**Pattern:** read today's structured log, find the *index of the most recent* `TFA_START` event by reverse-scanning, then aggregate session/feed/warn/error state only over lines after that index.

**Why lift:** without this, crashed/restarted runs from earlier in the day pollute "current health" with stale events. The reverse-scan trick is cheap and avoids needing a separate per-process state store. yow-partha's "system status" command should apply the same logic per subsystem.

---

## 3. Liveness from log mtime (per-tick perf log as proof-of-life)

**Source:** `tfa_bot/bot.py` lines 326–341 (`_is_alive`)

**Pattern:** primary signal = `tfa_perf_<INST>_<DATE>.log` mtime within 60s (perf log writes per tick when TFA is live). Fallback = main log mtime within 5 min (events aren't per-tick). Returns False otherwise.

**Why lift:** works whether the bot launched the process or it was started externally (via `start-tfa.bat`, scheduled task, etc.). No PID tracking required, no IPC needed. yow-partha can apply the same trick to *any* subsystem that emits a heartbeat log line.

---

## 4. Traffic-light health rendering

**Source:** `tfa_bot/bot.py` lines 344–355 (`_health_status_icon`), 358–365 (`_health_state_label`), 368–394 (`_compact_health_line`), 397–454 (`_format_detailed_health`)

**Pattern:** ladder of conditions → emoji icon (🔴/🟡/🟢) + ALL_CAPS state label (STOPPED/FEED_DOWN/OUT_OF_SESSION/TRADING). Compact one-line for `/status`, multi-line for `/<inst>_status`.

**Why lift:** the icon + label combo is scannable on mobile lock-screen — exactly what a phone-facing operator surface needs. The compact-vs-detailed split is the right pattern for "one message dashboard" vs "drill down".

---

## 5. Markdown V1 safety wisdom

**Source:** `tfa_bot/bot.py` lines 369–372 (comment in `_compact_health_line`) and lines 446–452

**Pattern (two related rules):**
1. **Wrap labels containing underscores in backticks** — labels like `FEED_DOWN` / `OUT_OF_SESSION` would otherwise be interpreted as italic markers by Markdown V1 and break rendering.
2. **Wrap dynamic log messages in backticks AND replace inner backticks with single-quotes** — arbitrary punctuation (asterisks, underscores, backticks-inside-strings) breaks parsing otherwise.

**Why lift:** rediscovering these the hard way costs an afternoon of debugging "why is my Telegram message rendering wrong." Document them once and apply consistently. Also evaluate whether to switch to `MarkdownV2` or `HTML` parse modes — V1 is the path of least friction but has these footguns; V2 needs aggressive escaping of `_*[]()~``>#+-=|{}.!`; HTML is cleanest if templates allow.

---

## 6. Process start/stop wrappers (Windows-aware)

**Source:** `tfa_bot/bot.py` lines 291–320 (`_start_inst`, `_stop_inst`)

**Pattern:**
- `subprocess.Popen` with `CREATE_NEW_PROCESS_GROUP` on Windows so we can signal the child independently.
- Stop uses `terminate()` then `wait(timeout=8)` then `kill()` — the same three-step pattern in `startup/stop-all.ps1`.

**Why lift:** the `CREATE_NEW_PROCESS_GROUP` flag is the single thing that lets `Ctrl+C`-equivalent shutdown work on Windows. Easy to miss when porting; preserve the comment too.

---

## 7. Crash-monitor job (PTB `run_repeating` + per-target dedup)

**Source:** `tfa_bot/bot.py` lines 628–646 (`_check_crashes`), 679 (registration)

**Pattern:** PTB JobQueue runs `_check_crashes` every 30s. On exit, sends one Telegram message AND sets `ctx.bot_data["alerted_<inst>"] = True`. When the process is restarted, the flag is cleared so the next crash alerts again. Prevents alert spam during a sustained outage.

**Why lift:** the dedup pattern (alert once per outage, re-arm on recovery) is what makes push alerts livable. yow-partha needs the same pattern for every "subsystem is down" alert — broker disconnect, feed disconnect, server unreachable.

---

## 8. PTB pinning rationale

**Source:** `tfa_bot/requirements.txt`

**Pattern:** `python-telegram-bot[job-queue]==20.8` with explicit comment that v21+ has breaking changes to JobQueue / Application lifecycle.

**Why lift:** if yow-partha uses PTB, pin to v20.x and inherit the same comment. If yow-partha decides to write directly against the HTTP Bot API (no PTB), document that choice — PTB brings nice ergonomics (CommandHandler, JobQueue, ConversationHandler) but is opinionated and large; a thin client over `aiohttp` may be a better fit for a control-surface bot that mostly emits pushes and accepts a handful of slash commands.

---

## 9. IST timezone + duration/size formatters

**Source:** `tfa_bot/bot.py` lines 46–47 (`IST`), 69–71 (`_now_ist`), 73–80 (`_parse_iso`), 83–91 (`_fmt_duration`), 94–102 (`_fmt_size`)

**Pattern:** hardcoded `timezone(timedelta(hours=5, minutes=30))`, helper to parse ISO timestamps (handles the `+05:30` suffix), and human-readable duration + byte-size formatters with the right unit transitions.

**Why lift:** straight utility code. Drop into a `yow_partha/_utils.py` and move on. The duration formatter ("2h 15m" / "45s" / "3d 4h") is mobile-readable and worth keeping byte-for-byte.

---

## 10. Compact log tail with optional level filter

**Source:** `tfa_bot/bot.py` lines 138–174 (`_tail_log`)

**Pattern:** read NDJSON log file, optionally filter by `level in ["WARN", "ERROR"]`, return last N as formatted human-readable lines (`[ts] LEVEL alert: msg`). Includes a JSON-parse fallback so malformed lines still render.

**Why lift:** the `levels=["WARN", "ERROR"]` filter is what powers `/errors` — instantly the most useful operational command. yow-partha's `/errors` should support `--since 1h` / `--grep <pattern>` extensions on top of this base.

---

## What NOT to lift

- **Per-instrument command explosion** (`/nifty50_status` + `/start_nifty50` + `/stop_nifty50` + `/restart_nifty50` × 4 = 16 handlers). yow-partha should use **args, not separate commands**: `/tfa status [inst]`, `/tfa start [inst|all]`, etc. The factory pattern (`_make_status_cmd(inst)`) is a workaround for the design mistake, not the design itself.
- **The "tools menu" entry point** in `launcher_v2.py` (`Start Telegram bot` under Tools submenu). yow-partha is promoted to a **main menu item** instead.
- **The standalone `.env` in `tfa_bot/`** — yow-partha reads from root `.env` only (single source of credentials).
- **`tfa_bot.ico` and `paper-plane` icon mapping in `make_icons.py`** — yow-partha gets a fresh icon. Suggested glyph: `headset` (operator) or `satellite-dish` (always-listening) from Font Awesome.

---

## Where the secrets live (post-migration)

| Var | Location | Notes |
|---|---|---|
| `YOW_PARTHA_BOT_TOKEN` | root `.env` only | Never `.env.example`, never memory files, never docs |
| `YOW_PARTHA_CHAT_ID`   | root `.env` only | Same |

Old `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` env vars stay (still used by `server/_core/telegram.ts` for fatal handlers + RCA desync alerts). They will be migrated to the yow-partha channel in a later spec phase; for now both channels coexist.