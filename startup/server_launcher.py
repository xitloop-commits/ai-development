"""
server_launcher.py — wraps 'pnpm dev' with Esc-key menu support.

  Esc          → show menu (server keeps running):
    Enter      → restart server
    Esc        → stop server and exit
    C          → continue (dismiss menu)
  Ctrl+C       → stop server and exit (hard stop)

Exit code 75 → bat loop re-launches (restart).
"""

import os
import subprocess
import sys
import threading
import time

# ── Windows VT (ANSI) mode ────────────────────────────────────────────────
if sys.platform == "win32":
    try:
        import ctypes

        _k32 = ctypes.windll.kernel32
        _h = _k32.GetStdHandle(-11)
        _m = ctypes.c_ulong()
        _k32.GetConsoleMode(_h, ctypes.byref(_m))
        _k32.SetConsoleMode(_h, _m.value | 0x0004)
    except Exception:
        pass

# ── ANSI helpers ──────────────────────────────────────────────────────────
_NO_COLOUR = bool(os.environ.get("NO_COLOR"))


def _c(code, text):
    return text if _NO_COLOUR else f"\033[{code}m{text}\033[0m"


BOLD = lambda t: _c("1", t)
GREEN = lambda t: _c("32", t)
YELLOW = lambda t: _c("33", t)


def _msg(text, end="\n"):
    sys.stdout.write(text + end)
    sys.stdout.flush()


def _run_once():
    """
    Start pnpm dev, watch keyboard, return action string:
      'restart' | 'exit'
    """
    # On Windows, pnpm is a .cmd file so shell=True is needed.
    # stdin=DEVNULL prevents pnpm dev (Next.js) from reading keyboard input —
    # otherwise Next.js steals keypresses (e.g. Enter triggers HMR reload)
    # and only Python's msvcrt owns the keyboard for the Esc menu.
    cmd = "pnpm dev"
    proc = subprocess.Popen(cmd, shell=True, cwd=os.getcwd(), stdin=subprocess.DEVNULL)

    action = [None]  # mutable cell shared with keyboard thread

    def _kb_watch():
        if sys.platform != "win32":
            return
        import msvcrt

        while proc.poll() is None:
            if not msvcrt.kbhit():
                time.sleep(0.05)
                continue
            ch = msvcrt.getwch()
            if ch != "\x1b":
                continue

            # A real Esc keypress is a lone \x1b with nothing after it.
            # Arrow keys / function keys send \x1b[ or \xe0 sequences — skip those.
            time.sleep(0.02)
            if msvcrt.kbhit():
                # Chars follow immediately → not a plain Esc, discard the sequence
                while msvcrt.kbhit():
                    msvcrt.getwch()
                continue

            # ── Confirmed lone Esc — show menu, server still running ───
            _msg(
                f"\n  {YELLOW('⏸  Paused')}  —  choose an action:\n"
                f"  {BOLD('Enter')} Restart   "
                f"{BOLD('Esc')} Exit   "
                f"{BOLD('C')} Continue"
            )

            while proc.poll() is None:
                if not msvcrt.kbhit():
                    time.sleep(0.05)
                    continue
                ch2 = msvcrt.getwch()

                if ch2 == "\x1b":  # Esc → exit
                    action[0] = "exit"
                    proc.terminate()
                    return

                elif ch2 in ("\r", "\n"):  # Enter → restart
                    action[0] = "restart"
                    proc.terminate()
                    return

                elif ch2.lower() == "c":  # C → continue
                    _msg(f"\n  {GREEN('▶ Continuing...')}\n")
                    break  # back to outer loop

    kb_thread = threading.Thread(target=_kb_watch, daemon=True)
    kb_thread.start()

    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        action[0] = "exit"

    kb_thread.join(timeout=1)
    return action[0] or "exit"


def main():
    _msg(
        f"\n  {'─' * 50}\n"
        f"  ATS — API Server\n"
        f"  Press {BOLD('Esc')} for options  ·  {BOLD('Ctrl+C')} to force stop\n"
        f"  {'─' * 50}\n"
    )

    while True:
        result = _run_once()

        if result == "restart":
            _msg(f"\n  {GREEN('↺ Restarting...')}\n")
            # loop continues → pnpm dev starts again
        else:
            _msg("\n  Stopped.\n")
            break


if __name__ == "__main__":
    main()
