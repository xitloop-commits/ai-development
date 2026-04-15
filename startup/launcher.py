"""
launcher.py — ATS unified launcher menu.

Navigate with ↑/↓ arrows, Enter to select, Esc to go back / quit.
Each action launches in a new window so the launcher stays usable.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

# ── Windows VT (ANSI) mode ────────────────────────────────────────────────
if sys.platform == "win32":
    try:
        import ctypes
        _k32 = ctypes.windll.kernel32
        _h   = _k32.GetStdHandle(-11)
        _m   = ctypes.c_ulong()
        _k32.GetConsoleMode(_h, ctypes.byref(_m))
        _k32.SetConsoleMode(_h, _m.value | 0x0004)
    except Exception:
        pass

# ── ANSI helpers ──────────────────────────────────────────────────────────
def _c(code, text):
    return f"\033[{code}m{text}\033[0m"

BOLD   = lambda t: _c("1",  t)
DIM    = lambda t: _c("2",  t)
GREEN  = lambda t: _c("32", t)
CYAN   = lambda t: _c("36", t)
YELLOW = lambda t: _c("33", t)

ROOT = Path(__file__).resolve().parent.parent

# ── Screen helpers ────────────────────────────────────────────────────────
def _clear() -> None:
    sys.stdout.write("\033[2J\033[H")
    sys.stdout.flush()


def _draw(title: str, items: list[tuple[str, str]], selected: int,
          breadcrumb: str = "") -> None:
    _clear()
    W = 62
    bar = "═" * W
    print()
    print(f"  {bar}")
    print(f"    {BOLD('ATS — Launcher')}   {DIM(breadcrumb)}")
    print(f"  {bar}")
    print()
    for i, (label, _action) in enumerate(items):
        marker = CYAN("►") if i == selected else " "
        text = BOLD(label) if i == selected else label
        print(f"    {marker}  {i+1}. {text}")
    print()
    print(f"  {DIM('─' * W)}")
    print(f"  {DIM('↑/↓ navigate   Enter select   Esc back/quit   1-9 quick')}")
    print()


# ── Keyboard (Windows) ────────────────────────────────────────────────────
def _getkey() -> str:
    """Return 'up', 'down', 'enter', 'esc', or a literal char."""
    import msvcrt
    ch = msvcrt.getwch()
    if ch in ("\xe0", "\x00"):
        ch2 = msvcrt.getwch()
        return {"H": "up", "P": "down", "K": "left", "M": "right"}.get(ch2, "")
    if ch == "\r":
        return "enter"
    if ch == "\x1b":
        return "esc"
    return ch


def menu(title: str, items: list[tuple[str, callable]],
         breadcrumb: str = "") -> None:
    """
    Display `items` and let the user select one. Each item is (label, callback).
    Callback runs on Enter. Menu loops until Esc.
    """
    selected = 0
    while True:
        _draw(title, items, selected, breadcrumb)
        key = _getkey()
        if key == "up":
            selected = (selected - 1) % len(items)
        elif key == "down":
            selected = (selected + 1) % len(items)
        elif key == "enter":
            items[selected][1]()
        elif key == "esc":
            return
        elif key.isdigit():
            idx = int(key) - 1
            if 0 <= idx < len(items):
                selected = idx
                items[idx][1]()


# ── Launch helpers ────────────────────────────────────────────────────────
def _launch_new_window(title: str, bat_args: str) -> None:
    """Open a new cmd window running `startup\\<bat_args>` then return."""
    cmd = (f'start "{title}" cmd /k "chcp 65001 >nul && '
           f'cd /d "{ROOT}" && call startup\\{bat_args}"')
    subprocess.Popen(cmd, shell=True, cwd=str(ROOT))
    print(f"  {GREEN('✓')} Launched: {title}")
    _pause_briefly()


def _pause_briefly() -> None:
    print(f"  {DIM('Press any key to return to menu…')}")
    import msvcrt
    msvcrt.getwch()


# ── Actions ───────────────────────────────────────────────────────────────
def act_start_all():      _launch_new_window("ATS: Start All",     "start-all.bat")
def act_api_server():     _launch_new_window("ATS: API Server",    "start-api.bat")
def act_tfa_nifty():      _launch_new_window("TFA: nifty50",       "start-tfa.bat nifty50")
def act_tfa_banknifty():  _launch_new_window("TFA: banknifty",     "start-tfa.bat banknifty")
def act_tfa_crudeoil():   _launch_new_window("TFA: crudeoil",      "start-tfa.bat crudeoil")
def act_tfa_natgas():     _launch_new_window("TFA: naturalgas",    "start-tfa.bat naturalgas")
def act_rep_nifty():      _launch_new_window("Replay: nifty50",    "start-replay.bat nifty50")
def act_rep_banknifty():  _launch_new_window("Replay: banknifty",  "start-replay.bat banknifty")
def act_rep_crudeoil():   _launch_new_window("Replay: crudeoil",   "start-replay.bat crudeoil")
def act_rep_natgas():     _launch_new_window("Replay: naturalgas", "start-replay.bat naturalgas")
def act_bot():            _launch_new_window("TFA Bot",            "start-bot.bat")

# --- Signal engine (SEA) ---
def act_sea_nifty():      _launch_new_window("SEA: nifty50",       "start-sea.bat nifty50")
def act_sea_banknifty():  _launch_new_window("SEA: banknifty",     "start-sea.bat banknifty")
def act_sea_crudeoil():   _launch_new_window("SEA: crudeoil",      "start-sea.bat crudeoil")
def act_sea_natgas():     _launch_new_window("SEA: naturalgas",    "start-sea.bat naturalgas")

# --- Signal dashboards ---
def act_watch_nifty():    _launch_new_window("Signals: nifty50",    "watch-signals.bat nifty50")
def act_watch_banknifty():_launch_new_window("Signals: banknifty",  "watch-signals.bat banknifty")
def act_watch_crudeoil(): _launch_new_window("Signals: crudeoil",   "watch-signals.bat crudeoil")
def act_watch_natgas():   _launch_new_window("Signals: naturalgas", "watch-signals.bat naturalgas")


def act_refresh_token():
    print()
    subprocess.run(["cmd", "/c", str(ROOT / "scripts" / "run-dhan-refresh.bat")],
                   cwd=str(ROOT))
    _pause_briefly()


def act_update_creds():
    print()
    print(f"  {YELLOW('Update Dhan credentials (runs interactive script)')}")
    print()
    print("  Example:")
    print(f"    {CYAN('node scripts/dhan-update-credentials.mjs --totp <SECRET>')}")
    print(f"    {CYAN('node scripts/dhan-update-credentials.mjs --show')}")
    print()
    _pause_briefly()


def act_file_sizes():
    from datetime import datetime
    today = datetime.now().strftime("%Y-%m-%d")
    d = ROOT / "data" / "raw" / today
    print()
    header = BOLD("Today's raw files")
    print(f"  {header}  ({today})")
    print()
    if not d.exists():
        print(f"  {YELLOW('No directory yet:')} {d}")
    else:
        for f in sorted(d.glob("*.ndjson.gz")):
            size_mb = f.stat().st_size / 1024 / 1024
            print(f"    {f.name:<45}  {size_mb:>8.2f} MB")
    print()
    _pause_briefly()


def act_tail_log():
    from datetime import datetime
    today = datetime.now().strftime("%Y-%m-%d")
    print()
    print(f"  {BOLD('Recent log files')}")
    print()
    logs_dir = ROOT / "logs"
    if logs_dir.exists():
        for f in sorted(logs_dir.glob(f"tfa_*_{today}.log")):
            size_kb = f.stat().st_size / 1024
            print(f"    {f.name:<45}  {size_kb:>8.1f} KB")
    print()
    print(f"  {DIM('Tip: open with your editor for full detail')}")
    print()
    _pause_briefly()


def act_checkpoint_status():
    import json
    cp_path = ROOT / "data" / "raw" / "replay_checkpoint.json"
    print()
    print(f"  {BOLD('Replay checkpoint')}  {DIM(str(cp_path))}")
    print()
    if not cp_path.exists():
        print(f"  {YELLOW('No checkpoint file yet.')}")
    else:
        data = json.loads(cp_path.read_text())
        if not data:
            print(f"  {YELLOW('(empty)')}")
        for inst, entry in data.items():
            print(f"    {inst:<15}  last={entry.get('last_completed_date'):<12}  "
                  f"sessions={entry.get('sessions_completed')}")
    print()
    _pause_briefly()


# ── Main ──────────────────────────────────────────────────────────────────
def main():
    items = [
        ("── Live ──────────────────────────────────────────", None),
        ("Start everything  (API server + all 4 TFAs)",   act_start_all),
        ("Start API server only",                         act_api_server),
        ("Start TFA  nifty50",                            act_tfa_nifty),
        ("Start TFA  banknifty",                          act_tfa_banknifty),
        ("Start TFA  crudeoil",                           act_tfa_crudeoil),
        ("Start TFA  naturalgas",                         act_tfa_natgas),
        ("── Replay  (feature generation) ─────────────────", None),
        ("Replay  nifty50",                               act_rep_nifty),
        ("Replay  banknifty",                             act_rep_banknifty),
        ("Replay  crudeoil",                              act_rep_crudeoil),
        ("Replay  naturalgas",                            act_rep_natgas),
        ("── Signals  (SEA live inference) ────────────────", None),
        ("Start SEA  nifty50",                            act_sea_nifty),
        ("Start SEA  banknifty",                          act_sea_banknifty),
        ("Start SEA  crudeoil",                           act_sea_crudeoil),
        ("Start SEA  naturalgas",                         act_sea_natgas),
        ("Watch signals  nifty50",                        act_watch_nifty),
        ("Watch signals  banknifty",                      act_watch_banknifty),
        ("Watch signals  crudeoil",                       act_watch_crudeoil),
        ("Watch signals  naturalgas",                     act_watch_natgas),
        ("── Tools ─────────────────────────────────────────", None),
        ("Refresh Dhan token (TOTP)",                     act_refresh_token),
        ("Update Dhan credentials (info)",                act_update_creds),
        ("Start Telegram Bot",                            act_bot),
        ("── Status ────────────────────────────────────────", None),
        ("Today's raw file sizes",                        act_file_sizes),
        ("Today's log files",                             act_tail_log),
        ("Replay checkpoint status",                      act_checkpoint_status),
    ]
    try:
        menu_flat(items)
    except KeyboardInterrupt:
        pass
    _clear()
    print()
    print(f"  {GREEN('Goodbye.')}")
    print()


def menu_flat(items: list[tuple[str, callable | None]]) -> None:
    """Flat list menu with section headers (action=None). Loops until Esc."""
    # Skip headers when navigating
    selectable = [i for i, (_, act) in enumerate(items) if act is not None]
    selected = selectable[0]

    while True:
        _draw_flat(items, selected)
        key = _getkey()
        if key == "up":
            idx = selectable.index(selected)
            selected = selectable[(idx - 1) % len(selectable)]
        elif key == "down":
            idx = selectable.index(selected)
            selected = selectable[(idx + 1) % len(selectable)]
        elif key == "enter":
            label, action = items[selected]
            if action is not None and _confirm(label):
                action()
        elif key == "esc":
            return


def _confirm(label: str) -> bool:
    """Ask Y/N before running the action. Returns True if confirmed."""
    print()
    print(f"  {YELLOW('?')}  Run: {BOLD(label)}  —  {GREEN('Y')} yes   "
          f"{DIM('N / Esc')} cancel")
    while True:
        k = _getkey()
        if k in ("y", "Y", "enter"):
            return True
        if k in ("n", "N", "esc"):
            print(f"  {DIM('Cancelled.')}")
            import time
            time.sleep(0.4)
            return False


def _draw_flat(items: list[tuple[str, callable | None]], selected: int) -> None:
    _clear()
    W = 62
    bar = "═" * W
    print()
    print(f"  {bar}")
    print(f"    {BOLD('ATS — Launcher')}")
    print(f"  {bar}")
    for i, (label, action) in enumerate(items):
        if action is None:
            # Header row
            print(f"    {DIM(label)}")
        elif i == selected:
            print(f"    {CYAN('►')}  {BOLD(label)}")
        else:
            print(f"       {label}")
    print(f"  {DIM('─' * W)}")
    print(f"  {DIM('↑/↓ navigate   Enter select   Esc quit')}")
    print()


if __name__ == "__main__":
    main()
