"""
tfa_bot/bot.py — Telegram bot for remote TFA management.

Per-instrument commands (4 × 4 = 16):
  /nifty50_status         /start_nifty50      /stop_nifty50      /restart_nifty50
  /banknifty_status       /start_banknifty    /stop_banknifty    /restart_banknifty
  /crudeoil_status        /start_crudeoil     /stop_crudeoil     /restart_crudeoil
  /naturalgas_status      /start_naturalgas   /stop_naturalgas   /restart_naturalgas

Global commands:
  /status                 — compact health of all 4 instruments
  /start_all              — start every instrument
  /stop_all               — stop every instrument
  /logs <inst> [n]        — last N log lines (default 20, max 50)
  /errors [inst]          — WARN/ERROR lines only
  /files [date]           — raw file sizes (today if date omitted)
  /help                   — show this list

Health (from /<inst>_status) includes: process state + pid + uptime,
session open/closed, feed connected/disconnected, last log activity,
today's WARN/ERROR counts, and the most recent WARN/ERROR message.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from telegram import Update
from telegram.constants import ParseMode
from telegram.ext import Application, CommandHandler, ContextTypes

# ── Config ─────────────────────────────────────────────────────────────────────
_HERE = Path(__file__).resolve().parent
load_dotenv(_HERE / ".env")

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
ALLOWED_USER_ID = int(os.environ.get("ALLOWED_USER_ID", "0"))
ROOT = _HERE.parent
IST = timezone(timedelta(hours=5, minutes=30))

# Use the same Python that is running the bot (guaranteed correct interpreter)
_PYTHON = sys.executable

INSTRUMENTS = ["nifty50", "banknifty", "crudeoil", "naturalgas"]

# Log filenames use a different key for nifty50 (historical "nifty/nifty50" mismatch —
# logger writes tfa_NIFTY_YYYY-MM-DD.log, not tfa_NIFTY50_...).
_LOG_KEY = {
    "nifty50": "NIFTY",
    "banknifty": "BANKNIFTY",
    "crudeoil": "CRUDEOIL",
    "naturalgas": "NATURALGAS",
}

# Running processes tracked by this bot: instrument → Popen
_procs: dict[str, subprocess.Popen] = {}


# ── General helpers ────────────────────────────────────────────────────────────


def _now_ist() -> datetime:
    return datetime.now(IST)


def _parse_iso(ts_str: str) -> datetime | None:
    """Parse TFA log ISO timestamp (e.g. '2026-04-22T09:15:00.176+05:30')."""
    if not ts_str:
        return None
    try:
        return datetime.fromisoformat(ts_str)
    except Exception:
        return None


def _fmt_duration(seconds: float) -> str:
    s = max(0, int(seconds))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60}s"
    if s < 86400:
        return f"{s // 3600}h {(s % 3600) // 60}m"
    return f"{s // 86400}d {(s % 86400) // 3600}h"


def _fmt_size(path: Path) -> str:
    if not path.exists():
        return "—"
    b = path.stat().st_size
    if b < 1024:
        return f"{b} B"
    if b < 1024 * 1024:
        return f"{b / 1024:.1f} KB"
    return f"{b / 1024 / 1024:.2f} MB"


def _log_file(inst: str, date: str | None = None) -> Path:
    d = date or _now_ist().strftime("%Y-%m-%d")
    return ROOT / "logs" / f"tfa_{_LOG_KEY[inst]}_{d}.log"


def _perf_log_file(inst: str, date: str | None = None) -> Path:
    """Per-tick perf log — updates every tick when TFA is live, so its mtime
    is the strongest proof-of-life signal for 'is TFA actually running?'"""
    d = date or _now_ist().strftime("%Y-%m-%d")
    return ROOT / "logs" / f"tfa_perf_{_LOG_KEY[inst]}_{d}.log"


def _tfa_cmd(inst: str) -> list[str]:
    profile = ROOT / "config" / "instrument_profiles" / f"{inst}_profile.json"
    output = ROOT / "data" / "features" / f"{inst}_live.ndjson"
    return [
        _PYTHON,
        str(ROOT / "python_modules" / "tick_feature_agent" / "main.py"),
        "--instrument-profile",
        str(profile),
        "--output-file",
        str(output),
    ]


def _is_running(inst: str) -> bool:
    p = _procs.get(inst)
    return p is not None and p.poll() is None


# ── Log parsing ────────────────────────────────────────────────────────────────


def _tail_log(inst: str, n: int = 20, levels: list[str] | None = None) -> str:
    """Return last N log lines, formatted as human-readable text."""
    lf = _log_file(inst)
    if not lf.exists():
        return f"No log file for {inst} today."
    try:
        with open(lf, encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
    except Exception as exc:
        return f"Error reading log: {exc}"

    if levels:
        filtered = []
        for line in all_lines:
            try:
                if json.loads(line).get("level") in levels:
                    filtered.append(line)
            except Exception:
                pass
        all_lines = filtered

    lines = all_lines[-n:]
    if not lines:
        return f"No {'matching ' if levels else ''}log entries for {inst} today."

    out = []
    for line in lines:
        try:
            e = json.loads(line.strip())
            ts = e.get("ts", "")[:19].replace("T", " ")
            level = e.get("level", "")[:4]
            alert = e.get("alert") or e.get("event", "")
            msg = e.get("msg", "")
            out.append(f"[{ts}] {level} {alert}: {msg}" if msg else f"[{ts}] {level} {alert}")
        except Exception:
            out.append(line.strip())
    return "\n".join(out)


def _compute_health(inst: str) -> dict:
    """
    Parse today's log to extract health signals. Only events that occurred after
    the most recent TFA_START are relevant (earlier entries are from crashed /
    restarted runs of the process).
    """
    health: dict = {
        "inst": inst,
        "bot_tracked": _is_running(inst),
        "pid": _procs[inst].pid if _is_running(inst) else None,
        "last_tfa_start": None,
        "session_open": False,
        "session_open_ts": None,
        "feed_connected": False,
        "log_mtime": None,
        "perf_log_mtime": None,
        "warn_count": 0,
        "error_count": 0,
        "last_issue": None,  # {"level", "alert", "msg", "ts"}
        "log_exists": False,
    }

    lf = _log_file(inst)
    pf = _perf_log_file(inst)

    if pf.exists():
        try:
            health["perf_log_mtime"] = datetime.fromtimestamp(pf.stat().st_mtime, tz=IST)
        except Exception:
            pass

    if not lf.exists():
        return health

    health["log_exists"] = True
    try:
        health["log_mtime"] = datetime.fromtimestamp(lf.stat().st_mtime, tz=IST)
    except Exception:
        pass

    try:
        with open(lf, encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
    except Exception:
        return health

    # First pass: find the index of the most recent TFA_START so we can ignore
    # events from earlier crashed runs.
    latest_start_idx = -1
    for i in range(len(all_lines) - 1, -1, -1):
        try:
            if json.loads(all_lines[i]).get("alert") == "TFA_START":
                latest_start_idx = i
                break
        except Exception:
            pass

    scope = all_lines[latest_start_idx:] if latest_start_idx >= 0 else all_lines

    # Second pass: aggregate state over relevant scope
    last_session_open_ts: str | None = None
    last_session_close_ts: str | None = None
    last_feed_conn_ts: str | None = None
    last_feed_disc_ts: str | None = None

    for line in scope:
        try:
            e = json.loads(line)
        except Exception:
            continue

        alert = e.get("alert") or ""
        level = e.get("level") or ""
        ts = e.get("ts") or ""

        if alert == "TFA_START":
            health["last_tfa_start"] = ts
        elif alert in ("SESSION_OPEN", "SESSION_RECORDING_OPEN"):
            last_session_open_ts = ts
        elif alert in ("SESSION_RECORDING_CLOSE", "SESSION_CLOSE", "TFA_STOPPED"):
            last_session_close_ts = ts
        elif alert == "FEED_CONNECTED":
            last_feed_conn_ts = ts
        elif alert == "FEED_DISCONNECTED":
            last_feed_disc_ts = ts

        if level == "WARN":
            health["warn_count"] += 1
        elif level == "ERROR":
            health["error_count"] += 1

        if level in ("WARN", "ERROR"):
            health["last_issue"] = {
                "level": level,
                "alert": alert,
                "msg": (e.get("msg") or "")[:120],
                "ts": ts[:19].replace("T", " "),
            }

    # Derive booleans by comparing latest open vs close (string ISO compare works)
    if last_session_open_ts:
        if last_session_close_ts is None or last_session_open_ts > last_session_close_ts:
            health["session_open"] = True
            health["session_open_ts"] = last_session_open_ts
    if last_feed_conn_ts:
        if last_feed_disc_ts is None or last_feed_conn_ts > last_feed_disc_ts:
            health["feed_connected"] = True

    return health


# ── Process control ────────────────────────────────────────────────────────────


def _start_inst(inst: str) -> str:
    if _is_running(inst):
        return f"⚪ {inst} already running  (pid={_procs[inst].pid})"
    _procs.pop(inst, None)  # remove dead entry if any
    try:
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
        p = subprocess.Popen(
            _tfa_cmd(inst),
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
        )
        _procs[inst] = p
        return f"✅ Started {inst}  (pid={p.pid})"
    except Exception as exc:
        return f"❌ Failed to start {inst}: {exc}"


def _stop_inst(inst: str) -> str:
    if not _is_running(inst):
        return f"⚪ {inst} is not running"
    p = _procs[inst]
    p.terminate()
    try:
        p.wait(timeout=8)
    except subprocess.TimeoutExpired:
        p.kill()
    _procs.pop(inst, None)
    return f"🛑 Stopped {inst}"


# ── Health formatting ──────────────────────────────────────────────────────────


def _is_alive(h: dict) -> bool:
    """Is TFA actually running? Primary signal is log-file freshness — works
    whether the bot launched the process or it was started externally via
    bat scripts. The perf log gets a line per tick during active trading, so
    its mtime is the strongest proof-of-life. Fall back to the main log for
    periods when ticks are paused (weekends, pre-market)."""
    now = _now_ist()
    if h["perf_log_mtime"]:
        age = (now - h["perf_log_mtime"]).total_seconds()
        if age < 60:
            return True
    if h["log_mtime"]:
        age = (now - h["log_mtime"]).total_seconds()
        if age < 300:  # 5-min main-log grace (events aren't per-tick)
            return True
    return False


def _health_status_icon(h: dict) -> str:
    """Traffic-light summary of health."""
    alive = _is_alive(h)
    if not alive:
        return "🔴"  # no recent log activity — process is not running
    if h["error_count"] > 0:
        return "🔴"  # running but hit hard errors today
    if not h["feed_connected"] or not h["session_open"]:
        return "🟡"  # partial — feed down or outside session
    if h["warn_count"] > 0:
        return "🟡"  # running with warnings
    return "🟢"


def _health_state_label(h: dict) -> str:
    if not _is_alive(h):
        return "STOPPED"
    if not h["feed_connected"]:
        return "FEED_DOWN"
    if not h["session_open"]:
        return "OUT_OF_SESSION"
    return "TRADING"


def _compact_health_line(inst: str) -> str:
    """One-line health for /status. Uses Markdown V1; state label is wrapped
    in backticks because labels like FEED_DOWN / OUT_OF_SESSION contain
    underscores that V1 would otherwise parse as italic markers.
    """
    h = _compute_health(inst)
    icon = _health_status_icon(h)
    state = _health_state_label(h)

    # Uptime comes from the TFA_START timestamp in the log — works whether
    # the bot launched the process or it was started externally.
    uptime = "—"
    if h["last_tfa_start"] and _is_alive(h):
        start = _parse_iso(h["last_tfa_start"])
        if start:
            uptime = _fmt_duration((_now_ist() - start).total_seconds())

    # Tag external processes so user knows bot can't stop them directly
    tag = "" if h["bot_tracked"] or not _is_alive(h) else "  (ext)"

    issues = ""
    if h["error_count"]:
        issues = f"  ✖{h['error_count']}"
    elif h["warn_count"]:
        issues = f"  ⚠{h['warn_count']}"

    return f"{icon} `{inst}`  `{state}`  up {uptime}{tag}{issues}"


def _format_detailed_health(inst: str) -> str:
    """Full health readout for /<inst>_status. Returns Telegram markdown."""
    h = _compute_health(inst)
    icon = _health_status_icon(h)
    state = _health_state_label(h)

    lines = [
        f"*{inst}*  {icon} `{state}`",
        "",
    ]

    alive = _is_alive(h)
    start = _parse_iso(h["last_tfa_start"]) if h["last_tfa_start"] else None
    uptime = _fmt_duration((_now_ist() - start).total_seconds()) if start and alive else "—"

    if h["bot_tracked"]:
        lines.append(f"Process:   pid `{h['pid']}`  up `{uptime}` (bot-managed)")
    elif alive:
        lines.append(f"Process:   up `{uptime}` (running externally, not bot-managed)")
    else:
        lines.append("Process:   not running")

    # Session
    if h["session_open"] and h["session_open_ts"]:
        open_ts = h["session_open_ts"][:19].replace("T", " ")
        lines.append(f"Session:   `open`  (since {open_ts})")
    else:
        lines.append("Session:   `closed`")

    # Feed
    feed_label = "`connected`" if h["feed_connected"] else "`disconnected`"
    lines.append(f"Feed:      {feed_label}")

    # Log freshness
    if h["log_mtime"]:
        age = (_now_ist() - h["log_mtime"]).total_seconds()
        lines.append(f"Last log:  `{_fmt_duration(age)} ago`")
    else:
        lines.append("Last log:  `—`")

    # Today's issues
    lines.append(f"Today:     `{h['warn_count']} warnings, {h['error_count']} errors`")

    if h["last_issue"]:
        lvl = h["last_issue"]["level"]
        alert = h["last_issue"]["alert"]
        msg = h["last_issue"]["msg"]
        ts = h["last_issue"]["ts"]
        lines.append("")
        lines.append(f"Last {lvl.lower()}:  `[{ts}] {alert}`")
        if msg:
            # Wrap in backticks — log messages can contain arbitrary punctuation
            # (asterisks, underscores, backticks inside strings…) that would
            # otherwise break V1 parsing.
            safe_msg = msg.replace("`", "'")
            lines.append(f"  `{safe_msg}`")

    return "\n".join(lines)


# ── Auth guard ─────────────────────────────────────────────────────────────────


def _guard(func):
    async def wrapper(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        if not update.effective_user or update.effective_user.id != ALLOWED_USER_ID:
            if update.message:
                await update.message.reply_text("⛔ Unauthorized")
            return
        await func(update, ctx)

    return wrapper


# ── Global command handlers ────────────────────────────────────────────────────


@_guard
async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    # Plain text — avoids MarkdownV2 escape headaches (hyphen / angle-bracket /
    # etc. are all reserved in V2 and silently break parsing).
    text = (
        "TFA Bot — Commands\n"
        "\n"
        "Per-instrument:\n"
        "  /nifty50_status    /start_nifty50    /stop_nifty50    /restart_nifty50\n"
        "  /banknifty_status  /start_banknifty  /stop_banknifty  /restart_banknifty\n"
        "  /crudeoil_status   /start_crudeoil   /stop_crudeoil   /restart_crudeoil\n"
        "  /naturalgas_status /start_naturalgas /stop_naturalgas /restart_naturalgas\n"
        "\n"
        "Global:\n"
        "  /status             all 4 compact\n"
        "  /start_all          start every instrument\n"
        "  /stop_all           stop every instrument\n"
        "  /logs inst [n]      last N log lines (max 50)\n"
        "  /errors [inst]      WARN/ERROR lines only\n"
        "  /files [date]       raw file sizes\n"
    )
    await update.message.reply_text(text)


@_guard
async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    lines = ["*TFA Process Status*", ""]
    for inst in INSTRUMENTS:
        lines.append(_compact_health_line(inst))
    await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)


@_guard
async def cmd_start_all(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    msgs = [_start_inst(inst) for inst in INSTRUMENTS]
    await update.message.reply_text("\n".join(msgs))


@_guard
async def cmd_stop_all(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    msgs = []
    for inst in INSTRUMENTS:
        msgs.append(_stop_inst(inst) if _is_running(inst) else f"⚪ {inst} already stopped")
    await update.message.reply_text("\n".join(msgs))


@_guard
async def cmd_logs(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not ctx.args:
        await update.message.reply_text(
            f"Usage: /logs <instrument> [lines]\nOptions: {', '.join(INSTRUMENTS)}"
        )
        return
    inst = ctx.args[0].lower()
    if inst not in INSTRUMENTS:
        await update.message.reply_text(f"❓ Unknown: {inst}  (valid: {', '.join(INSTRUMENTS)})")
        return
    n = min(int(ctx.args[1]), 50) if len(ctx.args) > 1 and ctx.args[1].isdigit() else 20
    text = _tail_log(inst, n)
    if len(text) > 3800:
        text = "...\n" + text[-3800:]
    await update.message.reply_text(f"```\n{text}\n```", parse_mode=ParseMode.MARKDOWN)


@_guard
async def cmd_errors(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if ctx.args:
        inst_arg = ctx.args[0].lower()
        if inst_arg not in INSTRUMENTS:
            await update.message.reply_text(
                f"❓ Unknown: {inst_arg}  (valid: {', '.join(INSTRUMENTS)})"
            )
            return
        insts = [inst_arg]
    else:
        insts = INSTRUMENTS

    results = []
    for inst in insts:
        text = _tail_log(inst, n=15, levels=["WARN", "ERROR"])
        if "No " not in text:
            results.append(f"── {inst} ──\n{text}")
    if not results:
        await update.message.reply_text("✅ No WARN/ERROR entries today.")
        return
    full = "\n\n".join(results)
    if len(full) > 3800:
        full = "...\n" + full[-3800:]
    await update.message.reply_text(f"```\n{full}\n```", parse_mode=ParseMode.MARKDOWN)


@_guard
async def cmd_files(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    date = ctx.args[0] if ctx.args else _now_ist().strftime("%Y-%m-%d")
    date_folder = ROOT / "data" / "raw" / date
    if not date_folder.exists():
        await update.message.reply_text(f"No data folder for {date}")
        return
    lines = [f"*Raw files — {date}*"]
    for inst in INSTRUMENTS:
        uf = date_folder / f"{inst}_underlying_ticks.ndjson.gz"
        of = date_folder / f"{inst}_option_ticks.ndjson.gz"
        cf = date_folder / f"{inst}_chain_snapshots.ndjson.gz"
        lines.append(
            f"\n`{inst}`\n"
            f"  underlying : {_fmt_size(uf)}\n"
            f"  options    : {_fmt_size(of)}\n"
            f"  chain      : {_fmt_size(cf)}"
        )
    await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)


# ── Per-instrument command factories ───────────────────────────────────────────


def _make_status_cmd(inst: str):
    @_guard
    async def handler(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        msg = _format_detailed_health(inst)
        await update.message.reply_text(msg, parse_mode=ParseMode.MARKDOWN)

    return handler


def _make_start_cmd(inst: str):
    @_guard
    async def handler(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        await update.message.reply_text(_start_inst(inst))

    return handler


def _make_stop_cmd(inst: str):
    @_guard
    async def handler(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        await update.message.reply_text(_stop_inst(inst))

    return handler


def _make_restart_cmd(inst: str):
    @_guard
    async def handler(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        stop_msg = _stop_inst(inst)
        await asyncio.sleep(2)
        start_msg = _start_inst(inst)
        await update.message.reply_text(f"{stop_msg}\n{start_msg}")

    return handler


# ── Crash monitor (PTB job, runs every 30 s) ───────────────────────────────────


async def _check_crashes(ctx: ContextTypes.DEFAULT_TYPE) -> None:
    for inst in list(_procs.keys()):
        p = _procs[inst]
        if p.poll() is not None:  # process has exited
            alert_key = f"alerted_{inst}"
            if not ctx.bot_data.get(alert_key):
                ctx.bot_data[alert_key] = True
                # Plain text — V2 escaping for dynamic fields (=, parens, etc.)
                # is fragile. Readable without markup.
                await ctx.bot.send_message(
                    chat_id=ALLOWED_USER_ID,
                    text=(
                        f"⚠️ {inst} TFA process crashed "
                        f"(exit={p.returncode})\n"
                        f"Use /start_{inst} to restart"
                    ),
                )
        else:
            ctx.bot_data.pop(f"alerted_{inst}", None)  # clear alert once back up


# ── Main ───────────────────────────────────────────────────────────────────────


def main() -> None:
    if not BOT_TOKEN:
        print("ERROR: TELEGRAM_BOT_TOKEN not set in tfa_bot/.env")
        sys.exit(1)
    if not ALLOWED_USER_ID:
        print("ERROR: ALLOWED_USER_ID not set in tfa_bot/.env")
        sys.exit(1)

    app = Application.builder().token(BOT_TOKEN).build()

    # Global
    app.add_handler(CommandHandler("start", cmd_help))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("start_all", cmd_start_all))
    app.add_handler(CommandHandler("stop_all", cmd_stop_all))
    app.add_handler(CommandHandler("logs", cmd_logs))
    app.add_handler(CommandHandler("errors", cmd_errors))
    app.add_handler(CommandHandler("files", cmd_files))

    # Per-instrument (4 × 4 = 16 handlers)
    for inst in INSTRUMENTS:
        app.add_handler(CommandHandler(f"{inst}_status", _make_status_cmd(inst)))
        app.add_handler(CommandHandler(f"start_{inst}", _make_start_cmd(inst)))
        app.add_handler(CommandHandler(f"stop_{inst}", _make_stop_cmd(inst)))
        app.add_handler(CommandHandler(f"restart_{inst}", _make_restart_cmd(inst)))

    app.job_queue.run_repeating(_check_crashes, interval=30, first=15)

    print(f"TFA Bot running — allowed user: {ALLOWED_USER_ID}")
    print("Press Ctrl+C to stop.\n")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
