"""
esc_watcher.py — Reusable Esc-to-drain trigger for long-running CLI runs.

Lifted from ``tick_feature_agent.replay.replay_runner`` (Phase 2, 2026-06-20)
so the trainer can share the exact same two-press confirmation UX.

How it works:
  1. A daemon thread polls ``msvcrt.kbhit()`` every 50 ms.
  2. First Esc tap → ``set_banner(confirm_text, "bold yellow")``. A 3-second
     window opens; any non-Esc keypress (or the timeout) cancels.
  3. Second Esc within the window → ``set_banner(stopping_text, "bold red")``
     then ``os.kill(getpid(), SIGINT)``. The main thread receives
     ``KeyboardInterrupt`` at the next Python opcode boundary.
  4. The caller's ``except KeyboardInterrupt`` handles cleanup. Partial
     state has been written by the per-fold / per-head checkpoint hooks
     so ``--resume`` can pick up where the killed run left off.

Windows-only. On non-Windows hosts the start function returns ``(None, None)``
so callers can use it unconditionally without platform branches.

Arrow keys and function keys arrive as a two-byte sequence beginning with
``\\xe0`` or ``\\x00``; we eat the second byte so they don't fake an Esc.
"""
from __future__ import annotations

import os
import signal
import sys
import threading
import time
from typing import Callable

_CONFIRM_BANNER = (
    "⚠  Press Esc AGAIN within 3 seconds to STOP training. "
    "Any other key to continue."
)
_CONFIRM_STYLE = "bold yellow"
_STOPPING_BANNER = (
    "STOPPING — finishing current head, then exit (partial state preserved)..."
)
_STOPPING_STYLE = "bold red"


def start_esc_watcher(
    set_banner: Callable[[str | None, str], None] | None = None,
    *,
    confirm_text: str = _CONFIRM_BANNER,
    stopping_text: str = _STOPPING_BANNER,
) -> tuple[threading.Event | None, threading.Thread | None]:
    """Start the daemon Esc watcher.

    Returns ``(stop_event, thread)`` on Windows when msvcrt is importable;
    ``(None, None)`` everywhere else (non-Windows hosts, or if msvcrt
    import fails for any reason). Callers shut the watcher down by
    setting ``stop_event``.

    ``set_banner`` is invoked as ``set_banner(text, style)`` to display
    the confirmation prompt and the "STOPPING..." message. Pass ``None``
    to silence the banner channel (the SIGINT still fires).
    """
    if sys.platform != "win32":
        return None, None
    try:
        import msvcrt  # noqa: F401  — imported at start so non-win imports don't fail
    except ImportError:
        return None, None

    stop_event = threading.Event()

    def _set(text: str | None, style: str = "bold yellow") -> None:
        if set_banner is None:
            return
        try:
            set_banner(text, style)
        except Exception:
            pass

    def _poll() -> None:
        import msvcrt as _mc
        pending = False
        pending_until = 0.0
        while not stop_event.is_set():
            try:
                now = time.monotonic()
                if pending and now > pending_until:
                    pending = False
                    _set(None)
                if _mc.kbhit():
                    ch = _mc.getch()
                    # Arrow / F-keys: \xe0 or \x00 + key code. Eat the
                    # follow-up byte so they don't read as an Esc.
                    if ch in (b"\xe0", b"\x00"):
                        if _mc.kbhit():
                            _mc.getch()
                        if pending:
                            pending = False
                            _set(None)
                        continue
                    if ch == b"\x1b":  # ESC
                        # ESC[X sequences (terminal-encoded arrows) — eat
                        # the follow-up byte if present.
                        time.sleep(0.005)
                        if _mc.kbhit():
                            _mc.getch()
                            continue
                        if pending and now <= pending_until:
                            # If the caller has already torn the watcher down
                            # (training finished), do NOT fire — a SIGINT here
                            # would land after completion and be misread as a
                            # restart request by the CLI's Ctrl+C handler.
                            if stop_event.is_set():
                                return
                            _set(stopping_text, _STOPPING_STYLE)
                            try:
                                os.kill(os.getpid(), signal.SIGINT)
                            except Exception:
                                pass
                            return
                        pending = True
                        pending_until = now + 3.0
                        _set(confirm_text, _CONFIRM_STYLE)
                    else:
                        if pending:
                            pending = False
                            _set(None)
            except Exception:
                pass
            stop_event.wait(0.05)

    th = threading.Thread(target=_poll, name="trainer-esc-watcher", daemon=True)
    th.start()
    return stop_event, th


__all__ = ["start_esc_watcher"]
