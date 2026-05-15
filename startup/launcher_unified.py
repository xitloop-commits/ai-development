#!/usr/bin/env python3
r"""
launcher_unified.py — ATS unified launcher (cross-platform: Windows + macOS).

Automatically detects platform and uses appropriate keyboard/window handling.

Usage:
  Windows: py startup\launcher_unified.py
  macOS:   python3 startup/launcher_unified.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import termios
import tty
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

# Platform detection
IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"

# Windows VT (ANSI) mode setup
if IS_WINDOWS:
    try:
        import ctypes
        _k32 = ctypes.windll.kernel32
        _h_out = _k32.GetStdHandle(-11)
        _m_out = ctypes.c_ulong()
        _k32.GetConsoleMode(_h_out, ctypes.byref(_m_out))
        _k32.SetConsoleMode(_h_out, _m_out.value | 0x0004)
    except Exception:
        pass

# Disable stdout line-buffering
try:
    sys.stdout.reconfigure(line_buffering=False)
except Exception:
    pass


# ── ANSI helpers ──────────────────────────────────────────────────────
def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m"


BOLD = lambda t: _c("1", t)
DIM = lambda t: _c("2", t)
GREEN = lambda t: _c("32", t)
RED = lambda t: _c("31", t)
CYAN = lambda t: _c("36", t)
MAGENTA = lambda t: _c("35", t)
YELLOW = lambda t: _c("33", t)

ROOT = Path(__file__).resolve().parent.parent


# ── Screen helpers ────────────────────────────────────────────────────
def _clear() -> None:
    sys.stdout.write("\033[2J\033[H")
    sys.stdout.flush()


def _getkey() -> str:
    """Return 'up' | 'down' | 'left' | 'right' | 'enter' | 'esc' | <char>."""
    sys.stdout.flush()

    if IS_WINDOWS:
        import msvcrt
        ch = msvcrt.getwch()
        if ch in ("\xe0", "\x00"):
            ch2 = msvcrt.getwch()
            return {"H": "up", "P": "down", "K": "left", "M": "right"}.get(ch2, "")
        if ch == "\r":
            return "enter"
        if ch == "\x1b":
            return "esc"
        if ch == " ":
            return "space"
        return ch

    else:  # macOS/Linux
        if not sys.stdin.isatty():
            try:
                ch = sys.stdin.read(1)
                if not ch:
                    return "esc"
                if ch == "\r" or ch == "\n":
                    return "enter"
                return ch
            except Exception:
                return "esc"

        try:
            fd = sys.stdin.fileno()
            old_settings = termios.tcgetattr(fd)
        except (termios.error, OSError):
            print(f"\n  {RED('✗')}  Terminal mode not available.\n")
            sys.exit(1)

        try:
            tty.setraw(fd)
            ch = sys.stdin.read(1)

            if ch == "\033":  # ESC sequence
                next_ch = sys.stdin.read(1)
                if next_ch == "[":
                    direction = sys.stdin.read(1)
                    directions = {"A": "up", "B": "down", "C": "right", "D": "left"}
                    return directions.get(direction, "")
                return "esc" if next_ch != "[" else ""
            elif ch == "\r" or ch == "\n":
                return "enter"
            elif ch == " ":
                return "space"
            return ch
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def _pause_briefly() -> None:
    print(f"  {DIM('Press any key to return…')}")
    sys.stdout.flush()

    if IS_WINDOWS:
        import msvcrt
        msvcrt.getwch()
    else:
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            sys.stdin.read(1)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


# ── Launch helpers ────────────────────────────────────────────────────
def _launch_new_window(title: str, script_or_cmd: str, *args: str) -> None:
    """Spawn a new window running a script or command."""

    # Check if it's a direct command (contains spaces or specific commands)
    is_command = script_or_cmd in ["pnpm dev"] or " " in script_or_cmd

    if IS_WINDOWS:
        if is_command:
            # Run command directly in new cmd window
            cmd_args = f"{script_or_cmd} {' '.join(args)}".strip()
            subprocess.Popen(["cmd", "/c", "start", "cmd", "/k", cmd_args], cwd=str(ROOT))
        else:
            # Launch .bat script
            script_path = str(ROOT / "startup" / script_or_cmd)
            subprocess.Popen(
                ["cmd", "/c", "start", title, "cmd", "/k", script_path, *args],
                cwd=str(ROOT),
            )
        print(f"  {GREEN('✓')} Launched: {title}")

    else:  # macOS/Linux
        if is_command:
            # Run command in Terminal via AppleScript
            cmd = script_or_cmd
            if args:
                cmd = f"{cmd} {' '.join(args)}"
            applescript = f"""
tell application "Terminal"
    activate
    do script "cd '{str(ROOT)}' && {cmd}"
end tell
"""
            try:
                subprocess.run(["osascript", "-e", applescript], check=True)
                print(f"  {GREEN('✓')} Launched: {title}")
            except Exception as e:
                print(f"  {RED('✗')} Failed to launch {title}: {e}")
        else:
            # Open script in Terminal
            script_path = str(ROOT / "startup" / script_or_cmd)
            subprocess.Popen(
                ["open", "-a", "Terminal", script_path, *args],
                cwd=str(ROOT),
            )
            print(f"  {GREEN('✓')} Launched: {title}")


# ── Menu ──────────────────────────────────────────────────────────────
@dataclass
class MenuItem:
    """One menu item."""
    hotkey: str
    label: str
    description: str


def _show_main_menu() -> Optional[str]:
    """Display main menu and return selected action key or None if quit."""

    items = [
        MenuItem("S", "Start Server", "API server on port 3000"),
        MenuItem("Q", "Record", "ticks → data/raw/"),
        MenuItem("F", "Featurize", "raw → data/features/"),
        MenuItem("T", "Train", "features → models/"),
        MenuItem("B", "Backtest", "scored on D-1"),
        MenuItem("P", "Compare", "model vs prior on D-1"),
        MenuItem("I", "Run SEA", "live features → signals/"),
        MenuItem("W", "Watch", "live dashboards"),
        MenuItem(".", "Tools", "token / creds / status"),
        MenuItem("X", "Delete", "raw / parquet / live / models"),
    ]

    selected_idx = 0
    today = datetime.now().strftime("%Y-%m-%d")

    while True:
        _clear()

        # Header
        print()
        print(f"  {BOLD('ATS Launcher')} {DIM('(v2 unified)')}")
        print(f"  {DIM(f'today: {today}')}")
        print(f"  {DIM('running: idle')}")
        print()
        print(f"  {BOLD('─' * 80)}")
        print()

        # Check if we have data
        data_raw = ROOT / "data" / "raw"
        if not data_raw.exists() or not list(data_raw.glob("*")):
            print(f"  {DIM('(no data yet — record some ticks to begin)')}")
            print()

        print(f"  {BOLD('Main menu')}")
        print()

        # Menu items
        for i, item in enumerate(items):
            prefix = f"  {CYAN('►')}" if i == selected_idx else "   "
            hotkey = MAGENTA(f"[{item.hotkey}]")
            print(f"{prefix}  {hotkey}  {BOLD(item.label):<15}  {DIM(item.description)}")

        print()
        print(f"  {CYAN('↑↓')} navigate  {CYAN('Enter')} select  {CYAN('Hotkey')} jump  {CYAN('Esc')} quit")
        print()

        # Get input
        key = _getkey().lower()

        if key == "up":
            selected_idx = max(0, selected_idx - 1)
        elif key == "down":
            selected_idx = min(len(items) - 1, selected_idx + 1)
        elif key == "enter":
            return items[selected_idx].hotkey
        elif key == "esc":
            return None
        else:
            # Hotkey jump
            for i, item in enumerate(items):
                if item.hotkey.lower() == key:
                    selected_idx = i
                    return item.hotkey

    return None


def main():
    """Main launcher loop."""
    try:
        while True:
            action = _show_main_menu()

            if action is None:
                _clear()
                print(f"\n  {GREEN('✓')} Goodbye!\n")
                break

            if action == "S":
                _launch_new_window("ATS API Server", "pnpm dev")
            elif action == "Q":
                _launch_new_window("ATS Record", "record.bat")
            elif action == "F":
                _launch_new_window("ATS Featurize", "featurize.bat")
            elif action == "T":
                _launch_new_window("ATS Train", "train.bat")
            elif action == "B":
                _launch_new_window("ATS Backtest", "backtest.bat")
            elif action == "P":
                _launch_new_window("ATS Compare", "backtest-compare.bat")
            elif action == "I":
                _launch_new_window("ATS SEA", "run-sea.bat")
            elif action == "W":
                _launch_new_window("ATS Watch", "watch.bat")
            elif action == ".":
                _launch_new_window("ATS Tools", "tools.bat")
            elif action == "X":
                _launch_new_window("ATS Delete", "delete.bat")

    except KeyboardInterrupt:
        _clear()
        print(f"\n  {YELLOW('⚠')}  Interrupted.\n")
        sys.exit(0)
    except Exception as e:
        print(f"\n  {RED('✗')}  Error: {e}\n")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
