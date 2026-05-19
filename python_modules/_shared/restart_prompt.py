"""
_shared.restart_prompt — Ctrl+C → "Restart or Exit?" prompt helper.

Every long-running Lubas program (tfa recorder, replay, training, sea, ...)
catches `KeyboardInterrupt` at its outermost `__main__` block and calls
`prompt_restart_or_exit(program_name)`. The function shows a small two-key
prompt:

    R    restart with latest code (process exits with code 75; the .bat
         wrapper loops on exit 75 and re-launches with the same args)
    X    exit cleanly (process exits with code 0)

Returns the exit code the caller should pass to `sys.exit(...)`.

Design:
- Single Ctrl+C lands here, second Ctrl+C exits 130 (POSIX SIGINT convention).
- EOF on stdin (e.g. closed pipe) defaults to "exit".
- Any other key prints help and re-prompts.
- Headless override: set `LUBAS_HEADLESS=1` to skip the prompt entirely and
  exit 130 (preserves prior behaviour for cron / Task Scheduler runs that
  must not block on a keypress).

No Windows-only dependencies — uses plain `input()` so it works in any
console the bat wrapper opened. msvcrt is intentionally avoided so unit
tests can stub stdin.
"""

from __future__ import annotations

import os
import sys


def prompt_restart_or_exit(program_name: str) -> int:
    """Show R/X prompt after Ctrl+C; return the exit code to pass to sys.exit."""
    if os.environ.get("LUBAS_HEADLESS"):
        # Non-interactive (Task Scheduler, CI) — preserve historical SIGINT exit code.
        return 130

    sys.stdout.write(
        f"\n\n  {program_name} interrupted.\n"
        f"    [R] restart with latest code\n"
        f"    [X] exit\n"
    )
    sys.stdout.flush()

    while True:
        try:
            choice = input("  > ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            # Second Ctrl+C or closed stdin → exit cleanly.
            return 0
        if choice in ("r", "restart"):
            return 75
        if choice in ("x", "exit", "q", "quit", ""):
            return 0
        sys.stdout.write("  Press R to restart or X to exit.\n")
        sys.stdout.flush()
