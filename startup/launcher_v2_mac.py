#!/usr/bin/env python3
"""
launcher_v2_mac.py — ATS unified launcher (macOS version).

Pass 1: scaffolding + Train submenu. Other action submenus to follow.

Design:
  Root menu lists action types (Q/F/T/B/P/I/W/.).
  Each action opens a submenu with multi-select instrument checkboxes,
  inline date pills (green = processed, dim = pending), and a date-mode
  toggle (ALL DAYS / D-2 holdout where applicable).

Run from terminal: `python3 startup/launcher_v2_mac.py`
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import termios
import tty
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

# Disable stdout line-buffering so each `print()` does NOT flush automatically
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
    sys.stdout.flush()  # commit the pending frame before we block on input

    # Check if stdin is actually connected to a terminal
    if not sys.stdin.isatty():
        # Fallback: read from stdin directly (for non-interactive mode)
        try:
            ch = sys.stdin.read(1)
            if not ch:  # EOF
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
        # Terminal mode not available (e.g., piped input)
        print(f"\n  {RED('✗')}  Terminal mode not available. Please run in an interactive terminal.\n")
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
        elif ch == "\x7f":  # backspace
            return "backspace"
        return ch
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def _pause_briefly() -> None:
    print(f"  {DIM('Press any key to return…')}")
    sys.stdout.flush()
    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        sys.stdin.read(1)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


# ── Launch helpers ────────────────────────────────────────────────────
def _launch_new_window(title: str, script_or_cmd: str, *args: str) -> None:
    """Spawn a new terminal window running a script or command."""

    # If it's a command like "pnpm dev", run it directly as a shell command
    if script_or_cmd in ["pnpm dev"] or " " in script_or_cmd:
        cmd = script_or_cmd
        if args:
            cmd = f"{cmd} {' '.join(args)}"
        applescript = f"""
tell application "Terminal"
    activate
    create window with default settings
    tell the front window
        do script "cd '{str(ROOT)}' && {cmd}"
    end tell
end tell
"""
        try:
            subprocess.run(["osascript", "-e", applescript], check=True)
            print(f"  {GREEN('✓')} Launched: {title}")
        except Exception as e:
            print(f"  {RED('✗')} Failed to launch {title}: {e}")
    else:
        # It's a script file
        script_path = str(ROOT / "startup" / script_or_cmd)
        cmd = [
            "open",
            "-a",
            "Terminal",
            script_path,
            *args
        ]
        try:
            subprocess.Popen(cmd, cwd=str(ROOT))
            print(f"  {GREEN('✓')} Launched: {title}")
        except Exception as e:
            print(f"  {RED('✗')} Failed to launch {title}: {e}")


def _launch_no_pause(title: str, script_name: str, *args: str) -> None:
    """Spawn a new terminal window running the script (no pause)."""
    _launch_new_window(title, script_name, *args)


# ── Data loading ──────────────────────────────────────────────────────
def _load_instrument_status() -> dict[str, dict]:
    """Load instrument status from data directory if it exists."""
    status_file = ROOT / "data" / "status.json"
    if status_file.exists():
        try:
            with open(status_file) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _get_date_color(date_str: str, processed: bool) -> str:
    """Return ANSI color for a date pill based on processed status."""
    if processed:
        return GREEN(date_str)
    return DIM(date_str)


# ── Submenu rendering ────────────────────────────────────────────────
@dataclass
class InstrumentRow:
    """One row shown in the submenu."""
    instrument: str
    checked: bool
    enabled: bool
    status_line: str


@dataclass
class SubmenuResult:
    """Result from submenu selection."""
    selected: list[str]
    date_mode_all_days: bool
    cancelled: bool


def submenu(
    title: str,
    rows: list[InstrumentRow],
    *,
    show_date_mode_toggle: bool = True,
) -> SubmenuResult:
    """Display multi-select submenu for instruments."""
    selected_idx = 0
    date_mode_all_days = True
    cancelled = False

    while True:
        _clear()

        # Header
        print()
        print(f"  {BOLD(title)}")
        print(f"  {DIM('─' * 80)}")
        print()

        # Rows
        for i, row in enumerate(rows):
            prefix = f"  {CYAN('►')}" if i == selected_idx else "   "
            check = MAGENTA("[✓]") if row.checked else MAGENTA("[ ]")
            disabled_mark = " " + DIM("(disabled)") if not row.enabled else ""
            print(f"{prefix}  {check}  {row.instrument:<20} {row.status_line}{disabled_mark}")

        # Date mode toggle (if applicable)
        if show_date_mode_toggle:
            print()
            date_mode_str = "ALL DAYS" if date_mode_all_days else "D-2 holdout"
            print(f"  {DIM('─' * 80)}")
            print(f"  Date mode: {YELLOW(date_mode_str)} (toggle with Space)")

        print()
        print(f"  {CYAN('↑↓')} navigate  {CYAN('Space')} toggle  {CYAN('Enter')} confirm  {CYAN('Esc')} cancel")
        print()

        # Get input
        key = _getkey()

        if key == "up":
            selected_idx = max(0, selected_idx - 1)
        elif key == "down":
            selected_idx = min(len(rows) - 1, selected_idx + 1)
        elif key == "space":
            if rows[selected_idx].enabled:
                rows[selected_idx].checked = not rows[selected_idx].checked
        elif key == "enter":
            break
        elif key == "esc":
            cancelled = True
            break

    selected = [r.instrument for r in rows if r.checked and r.enabled]
    return SubmenuResult(
        selected=selected,
        date_mode_all_days=date_mode_all_days,
        cancelled=cancelled,
    )


# ── Main menu ────────────────────────────────────────────────────────
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
        print(f"  {BOLD('ATS Launcher')} {DIM('(v2 macOS)')}")
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
        elif key == "esc" or key == "q":
            return None
        else:
            # Hotkey jump
            for i, item in enumerate(items):
                if item.hotkey.lower() == key:
                    selected_idx = i
                    return item.hotkey

    return None


def _handle_train_menu() -> None:
    """Handle Train menu."""
    # Create dummy instrument rows (would load from config in real version)
    rows = [
        InstrumentRow("NIFTY", checked=True, enabled=True, status_line=""),
        InstrumentRow("BANKNIFTY", checked=False, enabled=True, status_line=""),
        InstrumentRow("FINNIFTY", checked=False, enabled=True, status_line=""),
    ]

    result = submenu("Train", rows, show_date_mode_toggle=True)

    if result.cancelled:
        return

    if not result.selected:
        _clear()
        print(f"  {YELLOW('⚠')}  No instruments selected.")
        _pause_briefly()
        return

    # Launch training
    _launch_new_window(
        "ATS Training",
        "train.bat",
        f"--instruments={','.join(result.selected)}",
    )


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
                _handle_train_menu()
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
