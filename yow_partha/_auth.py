"""Allowlist guard — lift from tfa_bot/bot.py `_guard` (see migration doc §1)."""

from __future__ import annotations

import functools
import logging
import os
from typing import Awaitable, Callable

from telegram import Update
from telegram.ext import ContextTypes

log = logging.getLogger(__name__)


def _allowed_user_id() -> int:
    """Read once per check so a .env update doesn't require a bot restart."""
    raw = os.environ.get("YOW_PARTHA_CHAT_ID", "")
    try:
        return int(raw)
    except ValueError:
        return 0


def guard(handler: Callable[[Update, ContextTypes.DEFAULT_TYPE], Awaitable[None]]):
    """Drop updates from any chat not in the single-user allowlist.

    Silently — never confirm the bot's existence to a wrong user (a reply
    would leak that the chat id is wrong-but-bot-exists). Logged at DEBUG
    only.
    """

    @functools.wraps(handler)
    async def wrapper(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
        allowed = _allowed_user_id()
        uid = update.effective_user.id if update.effective_user else None
        if not allowed or uid != allowed:
            log.debug("dropped update from uid=%s (allowed=%s)", uid, allowed)
            return
        await handler(update, ctx)

    return wrapper
