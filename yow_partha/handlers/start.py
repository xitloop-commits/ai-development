"""`/start` handler — renders the home table.

Telegram surfaces `/start` as a tappable button on first open of the bot
and as a slash-menu entry thereafter (via `setMyCommands` in main.py), so
the user never types it.
"""

from __future__ import annotations

from telegram import Update
from telegram.ext import ContextTypes

from .._auth import guard
from .._ui import render_home


@guard
async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    text, markup = render_home()
    if update.message:
        await update.message.reply_text(text, reply_markup=markup)
