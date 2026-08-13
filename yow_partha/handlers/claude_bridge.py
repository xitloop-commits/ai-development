"""claude_bridge — hand `claude …` text messages to a running Claude Code session.

Partha (2026-08-13): "receive message from the bot, do what was asked and
respond back." The bot OWNS the Telegram inbox (two getUpdates consumers on
one token conflict), so it plays postman: any text message starting with
"claude" is appended to ``data/claude_inbox/inbox.ndjson`` and acknowledged.
A watcher inside the active Claude Code session tails that file, wakes
Claude, and Claude replies through the bot's sendMessage API.

If no session is alive, messages simply wait in the inbox — the next session
drains the backlog. Non-"claude" text keeps the existing behaviour (ignored;
the bot is buttons-first).
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

from telegram import Update
from telegram.ext import ContextTypes

from .._auth import guard

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent.parent
INBOX_DIR = ROOT / "data" / "claude_inbox"
INBOX = INBOX_DIR / "inbox.ndjson"


@guard
async def on_text(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    if msg is None or not msg.text:
        return
    text = msg.text.strip()
    if not text.lower().startswith("claude"):
        return  # not for the bridge — keep the buttons-first bot silent
    ask = text[len("claude"):].lstrip(" :,-–")
    if not ask:
        await msg.reply_text("Say it like: claude check why natgas has no signal")
        return
    try:
        INBOX_DIR.mkdir(parents=True, exist_ok=True)
        with INBOX.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "ts": time.time(),
                "message_id": msg.message_id,
                "text": ask,
            }, ensure_ascii=False) + "\n")
        await msg.reply_text("📨 Passed to Claude — it will reply here when done.")
        log.info("claude inbox <- %r", ask[:120])
    except OSError as exc:
        await msg.reply_text(f"Could not queue the message: {exc}")
