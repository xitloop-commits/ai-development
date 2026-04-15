"""
tfa_bot/bot.py — Telegram bot for remote TFA management.

Commands:
  /status              — all 4 instruments running / stopped
  /start_tfa <inst>    — start one instrument
  /stop_tfa  <inst>    — stop one instrument
  /restart   <inst>    — stop then start
  /start_all           — start all 4
  /stop_all            — stop all 4
  /logs <inst> [n]     — last N log lines (default 20, max 50)
  /errors [inst]       — WARN/ERROR lines only
  /files [date]        — raw file sizes (today if date omitted)
  /help                — show this list
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

from dotenv import load_dotenv
from telegram import Update
from telegram.constants import ParseMode
from telegram.ext import Application, CommandHandler, ContextTypes

# ── Config ─────────────────────────────────────────────────────────────────────
_HERE = Path(__file__).resolve().parent
load_dotenv(_HERE / ".env")

BOT_TOKEN       = os.environ.get("TELEGRAM_BOT_TOKEN", "")
ALLOWED_USER_ID = int(os.environ.get("ALLOWED_USER_ID", "0"))
ROOT            = _HERE.parent
IST             = timezone(timedelta(hours=5, minutes=30))

# Use the same Python that is running the bot (guaranteed correct interpreter)
_PYTHON = sys.executable

INSTRUMENTS = ["nifty50", "banknifty", "crudeoil", "naturalgas"]

# Running processes: instrument → Popen
_procs: dict[str, subprocess.Popen] = {}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _now_ist() -> datetime:
    return datetime.now(IST)


def _tfa_cmd(inst: str) -> list[str]:
    profile = ROOT / "config" / "instrument_profiles" / f"{inst}_profile.json"
    output  = ROOT / "data" / "features" / f"{inst}_live.ndjson"
    return [
        _PYTHON,
        str(ROOT / "python_modules" / "tick_feature_agent" / "main.py"),
        "--instrument-profile", str(profile),
        "--output-file", str(output),
    ]


def _is_running(inst: str) -> bool:
    p = _procs.get(inst)
    return p is not None and p.poll() is None


def _status_icon(inst: str) -> str:
    return "🟢" if _is_running(inst) else "🔴"


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
    return ROOT / "logs" / f"tfa_{inst.upper()}_{d}.log"


def _tail_log(inst: str, n: int = 20, levels: list[str] | None = None) -> str:
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
            ts    = e.get("ts", "")[:19].replace("T", " ")
            level = e.get("level", "")[:4]
            alert = e.get("alert") or e.get("event", "")
            msg   = e.get("msg", "")
            out.append(f"[{ts}] {level} {alert}: {msg}" if msg else f"[{ts}] {level} {alert}")
        except Exception:
            out.append(line.strip())
    return "\n".join(out)


# ── Process control ────────────────────────────────────────────────────────────

def _start_inst(inst: str) -> str:
    if inst not in INSTRUMENTS:
        return f"❓ Unknown: {inst}  (valid: {', '.join(INSTRUMENTS)})"
    if _is_running(inst):
        return f"⚪ {inst} already running  (pid={_procs[inst].pid})"
    _procs.pop(inst, None)   # remove dead entry if any
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
    if inst not in INSTRUMENTS:
        return f"❓ Unknown: {inst}"
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


# ── Auth guard ─────────────────────────────────────────────────────────────────

def _guard(func):
    async def wrapper(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        if not update.effective_user or update.effective_user.id != ALLOWED_USER_ID:
            await update.message.reply_text("⛔ Unauthorized")
            return
        await func(update, ctx)
    return wrapper


# ── Command handlers ───────────────────────────────────────────────────────────

@_guard
async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    text = (
        "*TFA Bot — Commands*\n\n"
        "/status — all instruments on/off\n"
        "/start\\_tfa `nifty50` — start one\n"
        "/stop\\_tfa `nifty50` — stop one\n"
        "/restart `nifty50` — stop \\+ start\n"
        "/start\\_all — start all 4\n"
        "/stop\\_all — stop all 4\n"
        "/logs `nifty50` \\[n\\] — last N lines \\(default 20\\)\n"
        "/errors \\[inst\\] — WARN/ERROR lines only\n"
        "/files \\[date\\] — raw file sizes\n"
    )
    await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2)


@_guard
async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    lines = ["*TFA Process Status*"]
    for inst in INSTRUMENTS:
        pid_str = f"  pid={_procs[inst].pid}" if _is_running(inst) else ""
        lines.append(f"{_status_icon(inst)} `{inst}`{pid_str}")
    await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)


@_guard
async def cmd_start_tfa(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not ctx.args:
        await update.message.reply_text(
            f"Usage: /start\\_tfa <instrument>\nOptions: {', '.join(INSTRUMENTS)}"
        )
        return
    await update.message.reply_text(_start_inst(ctx.args[0].lower()))


@_guard
async def cmd_stop_tfa(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not ctx.args:
        await update.message.reply_text(
            f"Usage: /stop\\_tfa <instrument>\nOptions: {', '.join(INSTRUMENTS)}"
        )
        return
    await update.message.reply_text(_stop_inst(ctx.args[0].lower()))


@_guard
async def cmd_restart(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not ctx.args:
        await update.message.reply_text("Usage: /restart <instrument>")
        return
    inst = ctx.args[0].lower()
    stop_msg  = _stop_inst(inst)
    await asyncio.sleep(2)
    start_msg = _start_inst(inst)
    await update.message.reply_text(f"{stop_msg}\n{start_msg}")


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
        await update.message.reply_text("Usage: /logs <instrument> [lines]\nExample: /logs nifty50 30")
        return
    inst = ctx.args[0].lower()
    n    = min(int(ctx.args[1]), 50) if len(ctx.args) > 1 and ctx.args[1].isdigit() else 20
    text = _tail_log(inst, n)
    if len(text) > 3800:
        text = "...\n" + text[-3800:]
    await update.message.reply_text(f"```\n{text}\n```", parse_mode=ParseMode.MARKDOWN)


@_guard
async def cmd_errors(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    insts = [ctx.args[0].lower()] if ctx.args else INSTRUMENTS
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
    date        = ctx.args[0] if ctx.args else _now_ist().strftime("%Y-%m-%d")
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


# ── Crash monitor (PTB job, runs every 30 s) ───────────────────────────────────

async def _check_crashes(ctx: ContextTypes.DEFAULT_TYPE) -> None:
    for inst in list(_procs.keys()):
        p = _procs[inst]
        if p.poll() is not None:                          # process has exited
            alert_key = f"alerted_{inst}"
            if not ctx.bot_data.get(alert_key):
                ctx.bot_data[alert_key] = True
                await ctx.bot.send_message(
                    chat_id=ALLOWED_USER_ID,
                    text=(
                        f"⚠️ *{inst}* TFA process crashed "
                        f"\\(exit={p.returncode}\\)\n"
                        f"Use /start\\_tfa {inst} to restart"
                    ),
                    parse_mode=ParseMode.MARKDOWN_V2,
                )
        else:
            ctx.bot_data.pop(f"alerted_{inst}", None)    # clear alert once back up


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    if not BOT_TOKEN:
        print("ERROR: TELEGRAM_BOT_TOKEN not set in tfa_bot/.env")
        sys.exit(1)
    if not ALLOWED_USER_ID:
        print("ERROR: ALLOWED_USER_ID not set in tfa_bot/.env")
        sys.exit(1)

    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start",     cmd_help))
    app.add_handler(CommandHandler("help",      cmd_help))
    app.add_handler(CommandHandler("status",    cmd_status))
    app.add_handler(CommandHandler("start_tfa", cmd_start_tfa))
    app.add_handler(CommandHandler("stop_tfa",  cmd_stop_tfa))
    app.add_handler(CommandHandler("restart",   cmd_restart))
    app.add_handler(CommandHandler("start_all", cmd_start_all))
    app.add_handler(CommandHandler("stop_all",  cmd_stop_all))
    app.add_handler(CommandHandler("logs",      cmd_logs))
    app.add_handler(CommandHandler("errors",    cmd_errors))
    app.add_handler(CommandHandler("files",     cmd_files))

    app.job_queue.run_repeating(_check_crashes, interval=30, first=15)

    print(f"TFA Bot running — allowed user: {ALLOWED_USER_ID}")
    print("Press Ctrl+C to stop.\n")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
