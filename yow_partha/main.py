"""yow-partha listener — entry point.

Long-poll PTB Application. Registers `/start` plus a single CallbackQuery
handler that routes every button tap (`callback_data` is the spec).

Run with:
    python -m yow_partha.main
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv

# Load root .env BEFORE importing handlers (they read env at module load).
ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

from telegram import BotCommand
from telegram.ext import Application, CallbackQueryHandler, CommandHandler

from .handlers.callbacks import on_callback
from .handlers.start import cmd_start

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)
log = logging.getLogger("yow_partha")


def _emit_lifecycle(event: str, result: str, detail: str = "") -> None:
    """Fire-and-forget lifecycle ping via the existing PowerShell helper."""
    helper = ROOT / "startup" / "_emit-lifecycle.ps1"
    if not helper.exists():
        return
    args = [
        "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", str(helper),
        "-Event", event, "-Result", result, "-Process", "yow-partha",
    ]
    if detail:
        args += ["-Detail", detail]
    try:
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass  # never crash the bot on lifecycle ping failure


def main() -> None:
    token = os.environ.get("YOW_PARTHA_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("YOW_PARTHA_CHAT_ID", "").strip()
    if not token:
        print("ERROR: YOW_PARTHA_BOT_TOKEN missing in .env", file=sys.stderr)
        sys.exit(1)
    if not chat_id:
        print("ERROR: YOW_PARTHA_CHAT_ID missing in .env", file=sys.stderr)
        sys.exit(1)

    app = Application.builder().token(token).build()

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CallbackQueryHandler(on_callback))

    async def _post_init(application: Application) -> None:
        # Register /start in the bot's command menu so Telegram surfaces it
        # as a tappable entry — keeps the "no typing" rule honest.
        await application.bot.set_my_commands([
            BotCommand("start", "Show status table"),
        ])

    app.post_init = _post_init

    _emit_lifecycle("start", "starting", "bot polling")
    print(f"yow-partha running — allowed user: {chat_id}")
    print("Press Ctrl+C to stop.\n")
    try:
        app.run_polling(drop_pending_updates=True)
    except KeyboardInterrupt:
        pass
    finally:
        _emit_lifecycle("stop", "ok", "bot stopped")


if __name__ == "__main__":
    main()
