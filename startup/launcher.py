"""
launcher.py — ATS unified launcher menu.

Navigate with ↑/↓ arrows, Enter to select, Esc to go back / quit.
Each action launches in a new window so the launcher stays usable.
"""

from __future__ import annotations

import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

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
def _c(code, text):
    return f"\033[{code}m{text}\033[0m"


BOLD = lambda t: _c("1", t)
DIM = lambda t: _c("2", t)
GREEN = lambda t: _c("32", t)
CYAN = lambda t: _c("36", t)
YELLOW = lambda t: _c("33", t)

ROOT = Path(__file__).resolve().parent.parent


# ── Screen helpers ────────────────────────────────────────────────────────
def _clear() -> None:
    sys.stdout.write("\033[2J\033[H")
    sys.stdout.flush()


def _draw(title: str, items: list[tuple[str, str]], selected: int, breadcrumb: str = "") -> None:
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


def menu(title: str, items: list[tuple[str, callable]], breadcrumb: str = "") -> None:
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
    """Open a new cmd window running `startup\\<bat_args>` then pause."""
    _launch_no_pause(title, bat_args)
    _pause_briefly()


def _launch_no_pause(title: str, bat_args: str) -> None:
    """Open a new cmd window without waiting — used by batch launchers."""
    # Use subprocess list form with CREATE_NEW_CONSOLE to avoid quote-escaping issues
    # from trailing backslashes in ROOT path.
    root_str = str(ROOT).rstrip("\\")
    parts = bat_args.split()
    bat_name = parts[0]
    bat_extra = " ".join(parts[1:])
    inner = f'chcp 65001 >nul & cd /d "{root_str}" & call startup\\{bat_name} {bat_extra}'
    # Use start to launch in a new window with title
    cmd = ["cmd", "/c", "start", title, "cmd", "/k", inner]
    subprocess.Popen(cmd, cwd=str(ROOT))
    print(f"  {GREEN('✓')} Launched: {title}")


def _pause_briefly() -> None:
    print(f"  {DIM('Press any key to return to menu…')}")
    import msvcrt

    msvcrt.getwch()


# ── Actions ───────────────────────────────────────────────────────────────
def act_start_all():
    _launch_new_window("ATS: Start All", "start-all.bat")


def act_api_server():
    _launch_new_window("ATS: API Server", "start-api.bat")


def act_tfa_nifty():
    _launch_new_window("TFA: nifty50", "start-tfa.bat nifty50")


def act_tfa_banknifty():
    _launch_new_window("TFA: banknifty", "start-tfa.bat banknifty")


def act_tfa_crudeoil():
    _launch_new_window("TFA: crudeoil", "start-tfa.bat crudeoil")


def act_tfa_natgas():
    _launch_new_window("TFA: naturalgas", "start-tfa.bat naturalgas")


def act_rep_nifty():
    _launch_new_window("Replay: nifty50", "start-replay.bat nifty50")


def act_rep_banknifty():
    _launch_new_window("Replay: banknifty", "start-replay.bat banknifty")


def act_rep_crudeoil():
    _launch_new_window("Replay: crudeoil", "start-replay.bat crudeoil")


def act_rep_natgas():
    _launch_new_window("Replay: naturalgas", "start-replay.bat naturalgas")


def act_bot():
    _launch_new_window("TFA Bot", "start-bot.bat")


def act_rep_all():
    for inst in ["nifty50", "banknifty", "crudeoil", "naturalgas"]:
        _launch_no_pause(f"Replay: {inst}", f"start-replay.bat {inst}")
    _pause_briefly()


# --- Signal engine (SEA) ---
def act_sea_nifty():
    _launch_new_window("SEA: nifty50", "start-sea.bat nifty50")


def act_sea_banknifty():
    _launch_new_window("SEA: banknifty", "start-sea.bat banknifty")


def act_sea_crudeoil():
    _launch_new_window("SEA: crudeoil", "start-sea.bat crudeoil")


def act_sea_natgas():
    _launch_new_window("SEA: naturalgas", "start-sea.bat naturalgas")


def act_sea_all():
    for inst in ["nifty50", "banknifty", "crudeoil", "naturalgas"]:
        _launch_no_pause(f"SEA: {inst}", f"start-sea.bat {inst}")
    _pause_briefly()


# --- Training (MTA) ---
# Train cutoff = D-2 (holds out D-1 as unseen test day for Scored BT)


def _existing_model_for_cutoff(instrument: str, date_to: str) -> str | None:
    """Return version timestamp of an existing model with matching date_to, else None."""
    if not date_to:
        return None
    import json

    inst_dir = ROOT / "models" / instrument
    if not inst_dir.exists():
        return None
    for vdir in sorted(inst_dir.iterdir(), reverse=True):
        if not vdir.is_dir():
            continue
        manifest = vdir / "training_manifest.json"
        if not manifest.exists():
            continue
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except Exception:
            continue
        if data.get("date_to") == date_to:
            return vdir.name
    return None


def _train_one(instrument: str) -> None:
    """Single-instrument train with confirm-if-exists guard."""
    existing = _existing_model_for_cutoff(instrument, _TRAIN_END_DATE)
    if existing:
        print()
        print(
            f"  {YELLOW('!')}  Model for {BOLD(instrument)} with train end "
            f"{BOLD(_TRAIN_END_DATE)} already exists: {existing}"
        )
        print(f"     Retrain anyway?  {GREEN('Y')} yes   {DIM('N / Esc')} cancel")
        while True:
            k = _getkey()
            if k in ("y", "Y", "enter"):
                break
            if k in ("n", "N", "esc"):
                print(f"  {DIM('Cancelled.')}")
                import time

                time.sleep(0.4)
                return
    _launch_new_window(f"Train: {instrument}", f"train-auto.bat {instrument} {_TRAIN_END_DATE}")


def act_train_nifty():
    _train_one("nifty50")


def act_train_banknifty():
    _train_one("banknifty")


def act_train_crudeoil():
    _train_one("crudeoil")


def act_train_natgas():
    _train_one("naturalgas")


def act_train_all():
    queued = 0
    for inst in _INSTRUMENTS:
        existing = _existing_model_for_cutoff(inst, _TRAIN_END_DATE)
        if existing:
            print(
                f"  {DIM('•')} skip {inst:<11} (already trained for {_TRAIN_END_DATE}: {existing})"
            )
            continue
        _launch_no_pause(f"Train: {inst}", f"train-auto.bat {inst} {_TRAIN_END_DATE}")
        queued += 1
    if queued == 0:
        print()
        print(f"  {YELLOW('All 4 already trained for')} {BOLD(_TRAIN_END_DATE)}.")
        print(f"  {DIM('Retrain individually if you really want to redo.')}")
    _pause_briefly()


# --- Walk-forward date selection ------------------------------------------
# Convention: train on [start … D-2], hold out D-1, score on D-1.
# Dates are picked from feature parquets that exist for all 4 instruments
# (and exclude today, whose data is likely still being collected).

_INSTRUMENTS = ["nifty50", "banknifty", "crudeoil", "naturalgas"]


def _scan_feature_dates() -> list[str]:
    """Return sorted list of YYYY-MM-DD dirs under data/features/ that have
    parquets for all 4 instruments and are strictly older than today."""
    feat_root = ROOT / "data" / "features"
    if not feat_root.exists():
        return []
    today = datetime.now().strftime("%Y-%m-%d")
    out: list[str] = []
    for d in feat_root.iterdir():
        if not d.is_dir():
            continue
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", d.name):
            continue
        if d.name >= today:
            continue
        if all((d / f"{inst}_features.parquet").exists() for inst in _INSTRUMENTS):
            out.append(d.name)
    out.sort()
    return out


def _compute_dates() -> tuple[str, str]:
    """Return (test_date = D-1, train_cutoff = D-2) from available parquets."""
    dates = _scan_feature_dates()
    if len(dates) >= 2:
        return dates[-1], dates[-2]
    if len(dates) == 1:
        return dates[0], dates[0]
    return "", ""


_BT_DATE, _TRAIN_END_DATE = _compute_dates()


# --- Scored Backtest (run SEA inline on parquet, produce scorecard) ---


def _latest_model_version(instrument: str) -> str | None:
    """Read models/<instrument>/LATEST, return the version timestamp string."""
    latest_file = ROOT / "models" / instrument / "LATEST"
    if not latest_file.exists():
        return None
    try:
        return latest_file.read_text(encoding="utf-8").strip() or None
    except Exception:
        return None


def _scorecard_exists(instrument: str, version: str | None, date: str) -> bool:
    if not version or not date:
        return False
    return (ROOT / "data" / "backtests" / instrument / version / date / "scorecard.json").exists()


def _sbt_one(instrument: str) -> None:
    """Single-instrument scored BT with skip-if-exists guard."""
    version = _latest_model_version(instrument)
    if _scorecard_exists(instrument, version, _BT_DATE):
        print()
        print(
            f"  {YELLOW('!')}  Scorecard for {BOLD(instrument)} model "
            f"{version} on {BOLD(_BT_DATE)} already exists."
        )
        print(f"     Re-score anyway?  {GREEN('Y')} yes   {DIM('N / Esc')} cancel")
        while True:
            k = _getkey()
            if k in ("y", "Y", "enter"):
                break
            if k in ("n", "N", "esc"):
                print(f"  {DIM('Cancelled.')}")
                import time

                time.sleep(0.4)
                return
    _launch_new_window(f"Scored BT: {instrument}", f"backtest-scored.bat {instrument} {_BT_DATE}")


def act_sbt_nifty():
    _sbt_one("nifty50")


def act_sbt_banknifty():
    _sbt_one("banknifty")


def act_sbt_crudeoil():
    _sbt_one("crudeoil")


def act_sbt_natgas():
    _sbt_one("naturalgas")


def act_sbt_all():
    queued = 0
    for inst in _INSTRUMENTS:
        version = _latest_model_version(inst)
        if _scorecard_exists(inst, version, _BT_DATE):
            print(f"  {DIM('•')} skip {inst:<11} (scorecard exists for {version} on {_BT_DATE})")
            continue
        _launch_no_pause(f"Scored BT: {inst}", f"backtest-scored.bat {inst} {_BT_DATE}")
        queued += 1
    if queued == 0:
        print()
        print(f"  {YELLOW('All 4 already scored on')} {BOLD(_BT_DATE)}.")
        print(f"  {DIM('Re-score individually if you really want to redo.')}")
    _pause_briefly()


def act_compare_nifty():
    _launch_new_window("Compare: nifty50", f"backtest-compare.bat nifty50 {_BT_DATE}")


def act_compare_banknifty():
    _launch_new_window("Compare: banknifty", f"backtest-compare.bat banknifty {_BT_DATE}")


def act_compare_crudeoil():
    _launch_new_window("Compare: crudeoil", f"backtest-compare.bat crudeoil {_BT_DATE}")


def act_compare_natgas():
    _launch_new_window("Compare: naturalgas", f"backtest-compare.bat naturalgas {_BT_DATE}")


# --- Feature dashboards ---
def act_feat_nifty():
    _launch_new_window("Features: nifty50", "watch-features.bat nifty50")


def act_feat_banknifty():
    _launch_new_window("Features: banknifty", "watch-features.bat banknifty")


def act_feat_crudeoil():
    _launch_new_window("Features: crudeoil", "watch-features.bat crudeoil")


def act_feat_natgas():
    _launch_new_window("Features: naturalgas", "watch-features.bat naturalgas")


# --- Signal dashboards ---
def act_watch_nifty():
    _launch_new_window("Signals: nifty50", "watch-signals.bat nifty50")


def act_watch_banknifty():
    _launch_new_window("Signals: banknifty", "watch-signals.bat banknifty")


def act_watch_crudeoil():
    _launch_new_window("Signals: crudeoil", "watch-signals.bat crudeoil")


def act_watch_natgas():
    _launch_new_window("Signals: naturalgas", "watch-signals.bat naturalgas")


def act_refresh_token():
    print()
    subprocess.run(["cmd", "/c", str(ROOT / "scripts" / "run-dhan-refresh.bat")], cwd=str(ROOT))
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
            print(
                f"    {inst:<15}  last={entry.get('last_completed_date'):<12}  "
                f"sessions={entry.get('sessions_completed')}"
            )
    print()
    _pause_briefly()


# ── Main ──────────────────────────────────────────────────────────────────
def main():
    items = [
        ("─── 1. RECORD ─── ticks  →  data/raw/  ──────────────", None),
        ("Start everything  (API + all 4 TFAs)", act_start_all),
        ("API server only", act_api_server),
        ("Record  nifty50", act_tfa_nifty),
        ("Record  banknifty", act_tfa_banknifty),
        ("Record  crudeoil", act_tfa_crudeoil),
        ("Record  naturalgas", act_tfa_natgas),
        ("─── 2. FEATURIZE ─── raw  →  data/features/  ───────", None),
        ("Replay ALL  (4 instruments)", act_rep_all),
        ("Replay  nifty50", act_rep_nifty),
        ("Replay  banknifty", act_rep_banknifty),
        ("Replay  crudeoil", act_rep_crudeoil),
        ("Replay  naturalgas", act_rep_natgas),
        (
            f"─── 3. TRAIN ─── features → models/   train end = D-2 = {_TRAIN_END_DATE or '(no data)'}",
            None,
        ),
        ("Train ALL  (4 instruments)", act_train_all),
        ("Train  nifty50   (MTA)", act_train_nifty),
        ("Train  banknifty (MTA)", act_train_banknifty),
        ("Train  crudeoil  (MTA)", act_train_crudeoil),
        ("Train  naturalgas(MTA)", act_train_natgas),
        (
            f"─── Scored Backtest ─── test day = D-1 = {_BT_DATE or '(no data)'}   (held out from training)",
            None,
        ),
        ("Scored BT ALL  (4 instruments)", act_sbt_all),
        ("Scored BT  nifty50", act_sbt_nifty),
        ("Scored BT  banknifty", act_sbt_banknifty),
        ("Scored BT  crudeoil", act_sbt_crudeoil),
        ("Scored BT  naturalgas", act_sbt_natgas),
        (f"─── Compare ─── diff last two models on D-1 = {_BT_DATE or '(no data)'}", None),
        ("Compare  nifty50", act_compare_nifty),
        ("Compare  banknifty", act_compare_banknifty),
        ("Compare  crudeoil", act_compare_crudeoil),
        ("Compare  naturalgas", act_compare_natgas),
        ("─── 4. INFER ─── live features  →  signals/  ───────", None),
        ("Start ALL SEAs  (4 instruments)", act_sea_all),
        ("Start SEA  nifty50", act_sea_nifty),
        ("Start SEA  banknifty", act_sea_banknifty),
        ("Start SEA  crudeoil", act_sea_crudeoil),
        ("Start SEA  naturalgas", act_sea_natgas),
        ("─── 5. WATCH ─── live dashboards  ───────────────────", None),
        ("Watch features  nifty50", act_feat_nifty),
        ("Watch features  banknifty", act_feat_banknifty),
        ("Watch features  crudeoil", act_feat_crudeoil),
        ("Watch features  naturalgas", act_feat_natgas),
        ("Watch signals   nifty50", act_watch_nifty),
        ("Watch signals   banknifty", act_watch_banknifty),
        ("Watch signals   crudeoil", act_watch_crudeoil),
        ("Watch signals   naturalgas", act_watch_natgas),
        ("─── Tools ───────────────────────────────────────────", None),
        ("Refresh Dhan token (TOTP)", act_refresh_token),
        ("Update Dhan credentials (info)", act_update_creds),
        ("Start Telegram Bot", act_bot),
        ("─── Status ──────────────────────────────────────────", None),
        ("Today's raw file sizes", act_file_sizes),
        ("Today's log files", act_tail_log),
        ("Replay checkpoint status", act_checkpoint_status),
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
    print(f"  {YELLOW('?')}  Run: {BOLD(label)}  —  {GREEN('Y')} yes   " f"{DIM('N / Esc')} cancel")
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
    print(f"    {BOLD('lubas — Lucky Basker')}")
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
