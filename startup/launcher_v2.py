"""
launcher_v2.py — Lubas unified launcher (redesigned).

Pass 1: scaffolding + Train submenu. Other action submenus to follow.

Design:
  Root menu lists action types (R/F/T/B/C/I/W/.).
  Each action opens a submenu with multi-select instrument checkboxes,
  inline date pills (green = processed, dim = pending), and a date-mode
  toggle (ALL DAYS / D-2 holdout where applicable).

Run from the launcher batch or directly: `py startup\\launcher_v2.py`
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

# Allow `import holdout_utils` (the module lives in python_modules/ alongside
# the agent packages). Safe to insert here even before ROOT is defined below.
_PYTHON_MODULES_DIR = Path(__file__).resolve().parent.parent / "python_modules"
if str(_PYTHON_MODULES_DIR) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES_DIR))
from holdout_utils import resolve_holdout_dates  # noqa: E402

# ── Windows VT (ANSI) mode ────────────────────────────────────────────────
# Only enable VT escapes on the OUTPUT handle so colours render.
if sys.platform == "win32":
    try:
        import ctypes
        _k32 = ctypes.windll.kernel32
        _h_out = _k32.GetStdHandle(-11)
        _m_out = ctypes.c_ulong()
        _k32.GetConsoleMode(_h_out, ctypes.byref(_m_out))
        _k32.SetConsoleMode(_h_out, _m_out.value | 0x0004)
    except Exception:
        pass

# Disable stdout line-buffering so each `print()` does NOT flush automatically
# at every '\n'. We flush once per frame (in `_getkey` / `_pause_briefly`) so
# the terminal receives the whole frame in a single write — no visible flicker
# between the screen-clear and the new content.
try:
    sys.stdout.reconfigure(line_buffering=False)
except Exception:
    pass


# ── ANSI helpers ──────────────────────────────────────────────────────────
def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m"


BOLD = lambda t: _c("1", t)
DIM = lambda t: _c("2", t)        # grey
RED = lambda t: _c("31", t)
GREEN = lambda t: _c("32", t)
YELLOW = lambda t: _c("33", t)
BLUE = lambda t: _c("34", t)
MAGENTA = lambda t: _c("35", t)
CYAN = lambda t: _c("36", t)
PINK = lambda t: _c("95", t)      # bright magenta — used for [hotkey] brackets


def _hk(key: str, label: str) -> str:
    """Render one footer hint as '[key] label' with [key] in pink."""
    return f"{PINK('[' + key + ']')} {label}"


def _hk_line(*pairs: tuple[str, str]) -> str:
    """Render a single-line footer made of (key, label) pairs."""
    return "   ".join(_hk(k, lab) for k, lab in pairs)


ROOT = Path(__file__).resolve().parent.parent

# Canonical display/launch order. Membership is *derived* from the
# config/instrument_profiles/ directory below; this list controls only the
# order of known instruments. New profiles appear at the end alphabetically.
_INSTRUMENT_ORDER = ["nifty50", "banknifty", "crudeoil", "naturalgas"]


def _scan_instruments() -> list[str]:
    profile_dir = ROOT / "config" / "instrument_profiles"
    if not profile_dir.exists():
        return list(_INSTRUMENT_ORDER)
    found = {p.name.replace("_profile.json", "") for p in profile_dir.glob("*_profile.json")}
    ordered = [n for n in _INSTRUMENT_ORDER if n in found]
    extras = sorted(found - set(_INSTRUMENT_ORDER))
    return ordered + extras


_INSTRUMENTS = _scan_instruments()


# ── Status collectors ─────────────────────────────────────────────────────


def _date_dirs_under(root: Path) -> list[str]:
    """Return YYYY-MM-DD dir names under root, sorted ascending."""
    if not root.exists():
        return []
    out: list[str] = []
    for d in root.iterdir():
        if d.is_dir() and re.match(r"^\d{4}-\d{2}-\d{2}$", d.name):
            out.append(d.name)
    out.sort()
    return out


def scan_feature_days(instrument: str) -> list[str]:
    """Days under data/features/ that have a parquet for this instrument."""
    feat_root = ROOT / "data" / "features"
    return [
        d for d in _date_dirs_under(feat_root)
        if (feat_root / d / f"{instrument}_features.parquet").exists()
    ]


def scan_raw_days(instrument: str) -> list[str]:
    """Days under data/raw/ that have an ndjson.gz for this instrument.

    Returns only days with COMPLETED `.gz` recordings — days that have only
    `.lock` markers (TFA started but never wrote data) are excluded so they
    don't show up as 'replayable' in the Replay submenu."""
    raw_root = ROOT / "data" / "raw"
    out: list[str] = []
    for d in _date_dirs_under(raw_root):
        day_dir = raw_root / d
        if any(day_dir.glob(f"{instrument}*.ndjson.gz")):
            out.append(d)
    return out


def scan_raw_artifact_days(instrument: str) -> list[str]:
    """Days with ANY raw artifact (`.ndjson.gz`, `.lock`, partial files…).

    Used by the Delete submenu so the user can clean up stale lock-only days
    where TFA created markers but never wrote ticks."""
    raw_root = ROOT / "data" / "raw"
    out: list[str] = []
    for d in _date_dirs_under(raw_root):
        day_dir = raw_root / d
        if any(day_dir.glob(f"{instrument}*")):
            out.append(d)
    return out


def scan_backtest_days(instrument: str) -> list[str]:
    """Days with any backtest scorecard for this instrument (across all model
    versions). Layout: data/backtests/<instrument>/<version>/<YYYY-MM-DD>/."""
    bt_root = ROOT / "data" / "backtests" / instrument
    if not bt_root.exists():
        return []
    out: set[str] = set()
    for vdir in bt_root.iterdir():
        if not vdir.is_dir():
            continue
        for ddir in vdir.iterdir():
            if ddir.is_dir() and re.match(r"^\d{4}-\d{2}-\d{2}$", ddir.name):
                out.add(ddir.name)
    return sorted(out)


@dataclass
class ModelInfo:
    version: str | None = None
    trained_dates: list[str] = field(default_factory=list)
    feature_count: int | None = None
    skipped_targets: list[str] = field(default_factory=list)


def last_model_info(instrument: str) -> ModelInfo:
    """Read LATEST + training_manifest for the newest model."""
    inst_dir = ROOT / "models" / instrument
    latest = inst_dir / "LATEST"
    if not latest.exists():
        return ModelInfo()
    try:
        version = latest.read_text(encoding="utf-8").strip()
    except Exception:
        return ModelInfo()
    manifest = inst_dir / version / "training_manifest.json"
    if not manifest.exists():
        return ModelInfo(version=version)
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except Exception:
        return ModelInfo(version=version)

    # Trained dates may live under "train_dates" as either bare YYYY-MM-DD
    # strings or "YYYY-MM-DD (80%)" annotated strings. Extract the dates.
    raw_train = data.get("train_dates", []) or []
    raw_val = data.get("val_dates", []) or []
    trained: list[str] = []
    for s in list(raw_train) + list(raw_val):
        m = re.search(r"\d{4}-\d{2}-\d{2}", str(s))
        if m:
            trained.append(m.group(0))
    # Deduplicate, preserve order
    seen: set[str] = set()
    trained = [d for d in trained if not (d in seen or seen.add(d))]

    return ModelInfo(
        version=version,
        trained_dates=trained,
        feature_count=data.get("feature_count"),
        skipped_targets=list(data.get("skipped_targets", []) or []),
    )


# ── Date pill renderer ────────────────────────────────────────────────────


def render_date_pills(
    available: list[str],
    processed: list[str],
    max_show: int = 14,
) -> str:
    """Render a single-line list of date pills.
    Green = processed, dim/grey = pending.
    Truncates with `…` if more than max_show.
    """
    if not available:
        return DIM("(none)")
    processed_set = set(processed)
    tokens: list[str] = []
    overflow = 0
    if len(available) > max_show:
        overflow = len(available) - max_show
        shown = available[-max_show:]  # keep most recent
    else:
        shown = available
    for d in shown:
        short = d[5:]  # MM-DD
        if d in processed_set:
            tokens.append(GREEN(short))
        else:
            tokens.append(DIM(short))
    s = " ".join(tokens)
    if overflow:
        s = DIM(f"… +{overflow}d  ") + s
    return s


# ── Process detection ─────────────────────────────────────────────────────


@dataclass
class RunningProc:
    kind: str           # "tfa" | "replay" | "sea" | "train"
    instrument: str
    pid: int
    rss_mb: float
    include_dates: list[str] = field(default_factory=list)  # parsed --include-dates args


def running_processes() -> list[RunningProc]:
    """Best-effort enumeration of Lubas python processes via PowerShell.
    Empty list on any failure (non-fatal — UI degrades to no-status)."""
    try:
        proc = subprocess.run(
            [
                "powershell", "-NoProfile", "-Command",
                "Get-CimInstance Win32_Process -Filter \"Name = 'python.exe'\" "
                "| Select-Object ProcessId,WorkingSetSize,CommandLine "
                "| ConvertTo-Json -Compress",
            ],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return []
    if proc.returncode != 0 or not proc.stdout.strip():
        return []
    try:
        data = json.loads(proc.stdout)
    except Exception:
        return []
    if isinstance(data, dict):
        data = [data]

    out: list[RunningProc] = []
    for entry in data:
        cmd = (entry.get("CommandLine") or "").lower()
        if "ai-development" not in cmd and "tick_feature_agent" not in cmd \
           and "signal_engine_agent" not in cmd \
           and "model_training_agent" not in cmd:
            continue
        kind = ""
        if "tick_feature_agent" in cmd:
            kind = "replay" if "--mode replay" in cmd else "tfa"
        elif "signal_engine_agent" in cmd:
            kind = "sea"
        elif "model_training_agent" in cmd:
            kind = "train"
        else:
            continue
        instrument = ""
        for inst in _INSTRUMENTS:
            if inst in cmd:
                instrument = inst
                break
        if not instrument:
            continue
        raw_cmd = entry.get("CommandLine") or ""
        # Accept --include-dates 2026-05-10, --include-dates "2026-05-10",
        # --include-dates=2026-05-10, AND comma-separated lists like
        # --include-dates 2026-05-10,2026-05-11,2026-05-12 (the launcher
        # uses this form to drive T47's pooled runner with one terminal
        # per instrument).
        include_date_chunks = re.findall(
            r'--include-dates[=\s]+"?([\d\-,]+)"?',
            raw_cmd,
        )
        include_dates: list[str] = []
        for chunk in include_date_chunks:
            for d in chunk.split(","):
                d = d.strip()
                if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
                    include_dates.append(d)
        out.append(RunningProc(
            kind=kind,
            instrument=instrument,
            pid=int(entry.get("ProcessId") or 0),
            rss_mb=round((entry.get("WorkingSetSize") or 0) / (1024 * 1024), 1),
            include_dates=include_dates,
        ))
    return out


# ── Walk-forward dates (D-1, D-2) ─────────────────────────────────────────


def _scan_complete_feature_dates() -> list[str]:
    """Dates where parquets exist for ALL 4 instruments AND are < today."""
    today = datetime.now().strftime("%Y-%m-%d")
    by_inst = {inst: set(scan_feature_days(inst)) for inst in _INSTRUMENTS}
    common = set.intersection(*by_inst.values()) if all(by_inst.values()) else set()
    return sorted(d for d in common if d < today)


def compute_walk_forward_dates() -> tuple[str, str]:
    """(backtest target, train end-date).

    Honours config/holdout_dates.json: the most recent reserved date becomes
    the default backtest target; train_end is the most recent NON-reserved
    date (so training stops before the holdout begins).

    Return-value semantics (callers MUST handle empty strings):
      - ("", "")         : no feature parquets exist at all.
      - (date, "")       : every available parquet is in the reserved
                           holdout -- nothing left to train on, but a
                           backtest target exists. Caller should disable
                           the Train action and surface this state.
      - (date, date)     : normal walk-forward state.

    All current call sites guard via `or '--'` for display or via the
    date-picker's `if not date: continue` for selection -- do NOT
    interpolate the returned strings into subprocess args without
    checking for empty first.
    """
    dates = _scan_complete_feature_dates()
    if not dates:
        return "", ""
    # Union across all instruments — used for the cross-instrument walk-forward
    # default. Per-instrument leak checks happen separately at training time.
    reserved = set(resolve_holdout_dates(
        features_root=ROOT / "data" / "features",
        raw_root=ROOT / "data" / "raw",
    ))
    if reserved:
        # Most recent reserved date for backtest; train_end is the most recent
        # date that is NOT reserved.
        backtest = sorted(d for d in dates if d in reserved)[-1] if any(d in reserved for d in dates) else dates[-1]
        non_reserved = [d for d in dates if d not in reserved]
        train_end = non_reserved[-1] if non_reserved else ""
        return backtest, train_end
    # No holdout configured — fall back to the legacy D-1 / D-2 split.
    if len(dates) >= 2:
        return dates[-1], dates[-2]
    return dates[0], dates[0]


# ── Screen / key helpers ──────────────────────────────────────────────────


def _clear() -> None:
    # Write the screen-clear into stdout's buffer but DO NOT flush yet.
    # The subsequent print() calls also accumulate (we disabled line-
    # buffering at startup). Everything for this frame is flushed in one
    # write by `_getkey` / `_pause_briefly` just before they block on
    # input — terminal receives the whole frame in a single syscall, so
    # there is no visible blank-and-repaint flash between clear and
    # content.
    sys.stdout.write("\033[2J\033[H")


def _getkey() -> str:
    """Return 'up' | 'down' | 'left' | 'right' | 'enter' | 'esc' | 'space' | <char>."""
    import msvcrt
    sys.stdout.flush()  # commit the pending frame before we block on input

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


def _flush_keys() -> None:
    """Drain any pending keypresses so we don't act on stale input."""
    import msvcrt
    while msvcrt.kbhit():
        try:
            msvcrt.getwch()
        except Exception:
            break


def _pause_briefly() -> None:
    print(f"  {DIM('Press any key to return…')}")
    sys.stdout.flush()  # commit the pending frame before we block on input
    import msvcrt
    msvcrt.getwch()


# ── Launch helpers ────────────────────────────────────────────────────────


def _launch_new_window(title: str, *bat_args: str) -> None:
    _launch_no_pause(title, *bat_args)
    _pause_briefly()


def _launch_no_pause(title: str, *bat_args: str) -> None:
    """Spawn a new console window running `startup\\<bat_args[0]>` with the
    remaining tokens as its arguments. Each token is passed as its own list
    element so Windows quotes them individually — no chained-`&` command
    string, no quote-escape mismatch between Python's C-runtime rules and
    cmd.exe's own.
    """
    if not bat_args:
        return
    bat_name = bat_args[0]
    extra = list(bat_args[1:])
    bat_path = str(ROOT / "startup" / bat_name)
    subprocess.Popen(
        ["cmd", "/c", "start", title, "cmd", "/k", bat_path, *extra],
        cwd=str(ROOT),
    )
    print(f"  {GREEN('✓')} Launched: {title}")


# ── Generic multi-select submenu ──────────────────────────────────────────


@dataclass
class InstrumentRow:
    """One row shown in the submenu. Caller fills in the status line."""
    instrument: str
    checked: bool
    enabled: bool                      # False → can't toggle, won't run
    status_line: str                   # right-of-name content, fully rendered


@dataclass
class SubmenuResult:
    selected: list[str]                # instrument names (only enabled+checked)
    date_mode_all_days: bool           # True = ALL DAYS, False = D-2 holdout
    cancelled: bool


def submenu(
    title: str,
    rows: list[InstrumentRow],
    *,
    show_date_mode_toggle: bool,
    initial_all_days: bool = True,
    train_end_date: str = "",
    bottom_actions: list[str] | None = None,
) -> SubmenuResult:
    """Render a submenu and return the user's selections.
    `bottom_actions` is a list of action labels shown at the bottom; this
    pass returns immediately on Enter (caller handles only the first action)."""
    bottom_actions = bottom_actions or ["Run"]
    all_days = initial_all_days
    cursor = 0  # index within rows
    enabled_idx = [i for i, r in enumerate(rows) if r.enabled]
    if enabled_idx and cursor not in enabled_idx:
        cursor = enabled_idx[0]

    while True:
        _clear()
        W = 76
        bar = "═" * W
        print()
        print(f"  {bar}")
        print(f"    {BOLD(title)}")
        print(f"  {bar}")
        print()
        if show_date_mode_toggle:
            mode_all = "(●)" if all_days else "( )"
            mode_d2 = "(●)" if not all_days else "( )"
            d2_label = f"D-2 holdout (→ {train_end_date})" if train_end_date else "D-2 holdout"
            all_label = "ALL DAYS"
            print(f"    Date mode:  {mode_d2} {d2_label}     {mode_all} {all_label}    "
                  f"{DIM('[D] toggle')}")
            print()

        print(f"    Instruments:                                     "
              f"{GREEN('✓green')}={GREEN('processed')}  {DIM('grey')}={DIM('pending')}")
        print()
        for i, row in enumerate(rows):
            check = "[x]" if row.checked else "[ ]"
            if not row.enabled:
                check = DIM("[-]")
            marker = CYAN("►") if i == cursor else " "
            num = f"{i + 1}."
            name = f"{row.instrument:<11}"
            if row.enabled:
                line = f"    {marker}  {check} {num} {BOLD(name)}  {row.status_line}"
            else:
                line = f"    {marker}  {check} {num} {DIM(name)}  {row.status_line}"
            print(line)
            # Visual breathing room between instruments
            if i < len(rows) - 1:
                print()

        print()
        actions_str = "    ".join(f"[{BOLD(a)}]" for a in bottom_actions)
        print(f"    {actions_str}")
        print()
        print(f"  {DIM('─' * W)}")
        pairs = [
            ("1-4", "toggle"),
            ("A", "all"),
            ("C", "clear"),
            ("Space", "toggle"),
            ("↑↓", "move"),
        ]
        if show_date_mode_toggle:
            pairs.append(("D", "date mode"))
        pairs.extend([("Enter", "run"), ("Esc", "cancel")])
        print(f"  " + _hk_line(*pairs))
        print()

        key = _getkey()
        if key == "esc":
            return SubmenuResult(selected=[], date_mode_all_days=all_days, cancelled=True)
        if key == "enter":
            chosen = [r.instrument for r in rows if r.checked and r.enabled]
            return SubmenuResult(selected=chosen, date_mode_all_days=all_days, cancelled=False)
        if key == "up":
            if enabled_idx:
                cur = enabled_idx.index(cursor) if cursor in enabled_idx else 0
                cursor = enabled_idx[(cur - 1) % len(enabled_idx)]
        elif key == "down":
            if enabled_idx:
                cur = enabled_idx.index(cursor) if cursor in enabled_idx else 0
                cursor = enabled_idx[(cur + 1) % len(enabled_idx)]
        elif key == "space":
            if rows[cursor].enabled:
                rows[cursor].checked = not rows[cursor].checked
        elif key in ("a", "A"):
            for r in rows:
                if r.enabled:
                    r.checked = True
        elif key in ("n", "N"):
            for r in rows:
                r.checked = False
        elif key in ("d", "D") and show_date_mode_toggle:
            all_days = not all_days
        elif key.isdigit():
            idx = int(key) - 1
            if 0 <= idx < len(rows) and rows[idx].enabled:
                rows[idx].checked = not rows[idx].checked
                cursor = idx


# ── Date picker widget (per-instrument with locked dates) ─────────────────


@dataclass
class InstrumentDates:
    """State for one instrument inside the date picker."""
    instrument: str
    enabled: bool                   # False → whole instrument disabled (e.g. replay running)
    included: bool                  # Whether this instrument is in the run at all
    available: list[str]            # All available dates, ascending
    locked: set[str] = field(default_factory=set)   # Dates that must be included (e.g. already trained)
    checked: set[str] = field(default_factory=set)  # Pending dates the user has ticked
    status_hint: str = ""           # Extra text shown after the instrument name (e.g. "REPLAY pid 3360")
    fully_done: bool = False        # All available dates are already locked (nothing left to process)
    in_progress: set[str] = field(default_factory=set)   # Dates currently being processed by a running proc (rendered yellow ✓)
    reserved: set[str] = field(default_factory=set)      # Holdout dates reserved for backtest (rendered magenta)


@dataclass
class DatePickerResult:
    selections: dict[str, list[str]]   # instrument → sorted list of include_dates (locked ∪ added)
    added: dict[str, list[str]]        # instrument → sorted list of NEW dates only (user's ticks, excluding locked)
    cancelled: bool


def _term_cols() -> int:
    """Detect current terminal width with a sensible fallback."""
    import shutil
    try:
        cols = shutil.get_terminal_size((120, 30)).columns
    except Exception:
        cols = 120
    return max(cols, 80)


def date_picker(
    title: str,
    items: list[InstrumentDates],
    *,
    pills_per_row: int | None = None,
) -> DatePickerResult:
    """
    Combined instrument + per-date picker.

    Layout per instrument:
        [x] N. <instrument>   <status_hint>
              [x]04-13  [x]04-14  ...   ← locked (green, immutable)
              [ ]04-17  [x]04-21  ...   ← pending (grey when off, green when on)

    Navigation:
        Up/Down  — move cursor through the flat sequence of nav items
        Space    — toggle cursor (no-op on locked dates / disabled instruments)
        A        — turn ON every pending date across all included instruments
        C / N    — turn OFF every pending date (locked stay ON)
        1-4      — toggle instrument inclusion (whole-instrument on/off)
        I        — same as 1-4 for current cursor instrument
        Enter    — return selections (locked ∪ checked)
        Esc      — cancel
    """
    # Dynamic pills-per-row from terminal width when not explicitly set.
    # Each pill renders as " [x]04-13 " (leading space + 8-char pill + 1 sep)
    # = ~11 visible chars; leading indent ~11 chars. Cap at 30 to keep
    # numbers reasonable on very wide terminals.
    if pills_per_row is None:
        cols = _term_cols()
        pills_per_row = max(1, min(30, (cols - 13) // 11))

    # Build the flat navigable sequence: one entry per row.
    # Each nav-item is a (kind, instrument_idx, date_or_None) tuple.
    # Excluded from nav (so the cursor never lands there):
    #   - Locked dates (immutable)
    #   - All dates of an instrument whose own checkbox is off (`included=False`)
    def _build_nav() -> list[tuple[str, int, str | None]]:
        nav: list[tuple[str, int, str | None]] = []
        for i, it in enumerate(items):
            if not it.enabled:
                # Disabled instrument: cursor can still rest on the header so the
                # user sees the status, but can't toggle anything.
                nav.append(("inst", i, None))
                continue
            nav.append(("inst", i, None))
            if not it.included:
                # Instrument toggled off — its dates are not navigable until
                # the user re-includes it via Space / 1-4.
                continue
            for d in it.available:
                if d in it.locked:
                    continue  # immutable — skip from cursor traversal
                nav.append(("date", i, d))
        return nav

    cursor = 0
    while True:
        nav = _build_nav()
        # Clamp cursor if it overflowed (rebuild is idempotent here, but safe)
        cursor = max(0, min(cursor, len(nav) - 1))

        _clear()
        cols = _term_cols()
        W = min(cols - 4, 160)
        bar = "═" * W
        print()
        print(f"  {bar}")
        print(f"    {BOLD(title)}")
        print(f"  {bar}")
        print()
        print(f"    {GREEN('[✓]')}=done   {YELLOW('[✓]')}=in progress   "
              f"{YELLOW('[x]')}=selected   {MAGENTA('[R]')}=reserved   "
              f"{DIM('[ ]')}=pending   "
              f"{DIM(f'(width={cols}, {pills_per_row}/row)')}")
        print()

        i = 0
        while i < len(nav):
            kind, inst_idx, _date = nav[i]
            it = items[inst_idx]
            if kind == "inst":
                # Instrument header row
                if it.fully_done:
                    # Every date already processed; row is immutable + dimmed.
                    check = f"[{GREEN('✓')}]"
                    name_render = DIM(f"{it.instrument:<11}")
                elif not it.enabled:
                    check = DIM("[-]")
                    name_render = DIM(f"{it.instrument:<11}")
                elif it.included:
                    check = "[x]"
                    name_render = BOLD(f"{it.instrument:<11}")
                else:
                    check = "[ ]"
                    name_render = f"{it.instrument:<11}"
                marker = CYAN("►") if i == cursor else " "
                hint = f"  {it.status_hint}" if it.status_hint else ""
                num = f"{inst_idx + 1}."
                print(f"    {marker}  {check} {num} {name_render}{hint}")
                i += 1
                # Render ALL dates for this instrument (locked, pending, in-progress).
                # Disabled instruments still render pills IF they have in-progress
                # dates so the user can see what's currently being processed.
                show_pills = it.available and (it.enabled or it.in_progress)
                if show_pills:
                    # Map each pending date to its index in nav (for cursor checks)
                    pending_to_nav: dict[str, int] = {}
                    for k_idx in range(i, len(nav)):
                        if nav[k_idx][0] != "date" or nav[k_idx][1] != inst_idx:
                            break
                        pending_to_nav[nav[k_idx][2]] = k_idx
                    # Render every available date as a pill, paginated by pills_per_row
                    all_dates = list(it.available)
                    for row_start in range(0, len(all_dates), pills_per_row):
                        chunk = all_dates[row_start: row_start + pills_per_row]
                        tokens: list[str] = []
                        for dstr in chunk:
                            short = dstr[5:]  # MM-DD
                            short_dim = DIM(short)
                            lb, rb = DIM("["), DIM("]")
                            is_reserved = dstr in it.reserved
                            # Reserved takes priority over every other state so
                            # the user can always see which dates are off-limits,
                            # even when they are also featurized / in-progress.
                            if is_reserved:
                                pill = " " + f"{lb}{MAGENTA('R')}{rb}{MAGENTA(short)}"
                            elif dstr in it.locked:
                                # Already processed in last run: only ✓ green; immutable.
                                pill = " " + f"{lb}{GREEN('✓')}{rb}{short_dim}"
                            elif dstr in it.in_progress:
                                # Currently being processed by a running proc: only ✓ yellow.
                                pill = " " + f"{lb}{YELLOW('✓')}{rb}{short_dim}"
                            else:
                                is_on = it.included and dstr in it.checked
                                if is_on:
                                    # User-picked for next run: only x yellow.
                                    pill = f"{lb}{YELLOW('x')}{rb}{short_dim}"
                                else:
                                    pill = DIM(f"[ ]{short}")
                                k_idx = pending_to_nav.get(dstr, -1)
                                if k_idx == cursor:
                                    pill = CYAN("▶") + pill
                                else:
                                    pill = " " + pill
                            tokens.append(pill)
                        print("           " + "  ".join(tokens))
                    # Advance i past this instrument's pending nav entries
                    i = i + len(pending_to_nav)
                # Blank line between instruments for breathing room
                if inst_idx < len(items) - 1:
                    print()
                continue
            i += 1  # safety

        print()
        print(f"    [Run]    [Clear Selection]    [Cancel]")
        print()
        print(f"  {DIM('─' * W)}")
        print(f"  " + _hk_line(
            ("↑↓", "move"),
            ("Space", "toggle"),
            ("A", "all pending"),
            ("C", "clear"),
            ("1-4", "toggle inst"),
            ("I", "toggle current"),
            ("Enter", "run"),
            ("Esc", "cancel"),
        ))
        print()

        key = _getkey()
        if key == "esc":
            return DatePickerResult(selections={}, added={}, cancelled=True)
        if key == "enter":
            sel: dict[str, list[str]] = {}
            added: dict[str, list[str]] = {}
            for it in items:
                if not it.enabled or not it.included:
                    continue
                user_added = (it.checked - it.locked)
                final = sorted(it.locked | it.checked)
                if final:
                    sel[it.instrument] = final
                if user_added:
                    added[it.instrument] = sorted(user_added)
            return DatePickerResult(selections=sel, added=added, cancelled=False)

        if not nav:
            continue
        if key in ("up", "left"):
            cursor = (cursor - 1) % len(nav)
        elif key in ("down", "right"):
            cursor = (cursor + 1) % len(nav)
        elif key == "space":
            kind, inst_idx, dstr = nav[cursor]
            it = items[inst_idx]
            if not it.enabled:
                continue
            if kind == "inst":
                it.included = not it.included
            elif kind == "date" and dstr not in it.locked and it.included:
                if dstr in it.checked:
                    it.checked.discard(dstr)
                else:
                    it.checked.add(dstr)
        elif key in ("a", "A"):
            for it in items:
                if it.enabled and it.included:
                    it.checked = set(it.available) - it.locked
                    it.checked |= it.locked  # locked already always included; harmless
                    it.checked -= it.locked
                    # Above is messy: simplify to "all pending ticked"
                    it.checked = set(d for d in it.available if d not in it.locked)
        elif key in ("c", "C", "n", "N"):
            for it in items:
                it.checked.clear()
        elif key.isdigit():
            idx = int(key) - 1
            if 0 <= idx < len(items) and items[idx].enabled:
                items[idx].included = not items[idx].included
        elif key in ("i", "I"):
            _knd, inst_idx, _ = nav[cursor]
            it = items[inst_idx]
            if it.enabled:
                it.included = not it.included


# ── Train submenu ─────────────────────────────────────────────────────────


def _train_status_line(instrument: str, running: list[RunningProc]) -> tuple[str, bool, list[str]]:
    """Return (status_line, enabled, available_dates).
    `enabled` is False when we can't train (no parquets, or replay is running)."""
    avail = scan_feature_days(instrument)
    info = last_model_info(instrument)
    proc = next(
        (p for p in running if p.instrument == instrument and p.kind in ("replay", "train")),
        None,
    )
    if proc:
        return (
            f"  {YELLOW('●' + proc.kind.upper())}  pid {proc.pid}  {proc.rss_mb:.0f} MB",
            False,
            avail,
        )
    if not avail:
        return (DIM("  (no parquets)"), False, [])
    pills = render_date_pills(avail, info.trained_dates)
    n_done = sum(1 for d in avail if d in set(info.trained_dates))
    counter = f"{n_done}/{len(avail)} ✓"
    last_ver = info.version or "----"
    return (
        f"  {counter:>8}  {pills}   "
        f"{DIM('last:')} {DIM(last_ver)}",
        True,
        avail,
    )


def act_train() -> None:
    # Stay on this submenu after each action; only Esc returns to the main menu.
    while True:
        running = running_processes()
        items: list[InstrumentDates] = []
        for inst in _INSTRUMENTS:
            reserved = set(resolve_holdout_dates(
                features_root=ROOT / "data" / "features",
                raw_root=ROOT / "data" / "raw",
                instrument=inst,
            ))
            avail = scan_feature_days(inst)
            info = last_model_info(inst)
            proc = next(
                (p for p in running if p.instrument == inst and p.kind in ("replay", "train")),
                None,
            )
            if proc:
                status = f"{YELLOW('●' + proc.kind.upper())}  pid {proc.pid}  {proc.rss_mb:.0f} MB"
                items.append(InstrumentDates(
                    instrument=inst, enabled=False, included=False, available=avail,
                    status_hint=status,
                    reserved=reserved,
                ))
                continue
            if not avail:
                items.append(InstrumentDates(
                    instrument=inst, enabled=False, included=False, available=[],
                    status_hint=DIM("(no parquets)"),
                ))
                continue
            locked = set(info.trained_dates) & set(avail)
            last_ver = info.version or "----"
            # All available parquet dates are already in the last model →
            # no pending work for this instrument. Row shows as [✓] and dim,
            # cannot be toggled, won't fire a subprocess on Enter.
            if locked == set(avail):
                items.append(InstrumentDates(
                    instrument=inst,
                    enabled=False,
                    included=True,
                    available=avail,
                    locked=locked,
                    checked=set(),
                    status_hint=DIM(f"all {len(avail)} dates already trained "
                                    f"(model {last_ver})"),
                    fully_done=True,
                    reserved=reserved,
                ))
                continue
            status = f"{DIM('last:')} {DIM(last_ver)}"
            items.append(InstrumentDates(
                instrument=inst,
                enabled=True,
                included=True,
                available=avail,
                locked=locked,
                checked=set(),
                status_hint=status,
                reserved=reserved,
            ))

        res = date_picker("Train  —  features → models/  (pick instruments + dates)", items)
        if res.cancelled:
            return
        if not res.added:
            print()
            print(f"  {YELLOW('!')} No new dates selected. The model is already trained on every "
                  f"locked date — nothing to do.")
            _pause_briefly()
            continue

        print()
        launched = 0
        # Phase 1b (2026-06-20): when 2+ instruments need training, route
        # to a single parallel window via train-parallel.bat instead of
        # spawning N separate windows that fight for CPU. Each worker gets
        # cpu_count() // N LightGBM threads (no oversubscription) and
        # output is prefixed `[instrument]` so the operator can still
        # follow per-instrument progress. The rich dashboard is OFF in
        # parallel mode -- multiple rich.Live instances in one terminal
        # would clobber the alt-screen.
        to_train: list[tuple[str, list[str]]] = []
        for inst, dates in res.selections.items():
            new_dates = res.added.get(inst, [])
            if not new_dates:
                print(f"  {DIM('•')} {inst:11s} skipped (no new dates to add)")
                continue
            to_train.append((inst, dates))

        if len(to_train) == 1:
            # Serial path -- single dashboard window.
            inst, dates = to_train[0]
            flags: list[str] = []
            for d in dates:
                flags.extend(["--include-dates", d])
            _launch_no_pause(
                f"Train: {inst} (+{len(res.added[inst])}d, {len(dates)}d total)",
                "train-auto.bat", inst, *flags,
            )
            launched = 1
        elif len(to_train) >= 2:
            # Parallel path -- one window, N workers, no dashboard.
            insts = [inst for inst, _ in to_train]
            # Date set = UNION across instruments. Each worker's
            # _load_parquets silently skips dates without parquet files for
            # its own instrument, so this works even if instruments have
            # divergent date selections.
            union_dates: list[str] = sorted({
                d for _, dates in to_train for d in dates
            })
            flags = []
            for d in union_dates:
                flags.extend(["--include-dates", d])
            inst_csv = ",".join(insts)
            added_counts = ", ".join(
                f"{i}+{len(res.added[i])}d" for i, _ in to_train
            )
            _launch_no_pause(
                f"Train parallel: {inst_csv} ({added_counts})",
                "train-parallel.bat", inst_csv, *flags,
            )
            launched = len(to_train)

        if launched == 0:
            print(f"  {YELLOW('!')} Nothing launched.")
        _pause_briefly()


def act_record() -> None:
    """Record submenu — start/stop per-instrument TFA recording.

    Status line shows: process state (RECORDING / stopped), today's raw file
    size (with `↑` if growing), and how many of the last 30 trading days
    were captured.
    """
    while True:
        running = running_processes()
        today = datetime.now().strftime("%Y-%m-%d")
        items: list[InstrumentRow] = []
        for inst in _INSTRUMENTS:
            proc = next((p for p in running if p.instrument == inst and p.kind == "tfa"), None)
            day_dir = ROOT / "data" / "raw" / today
            total_today = 0
            if day_dir.exists():
                for f in day_dir.glob(f"{inst}*.ndjson.gz"):
                    total_today += _path_size(f)
            history = scan_raw_days(inst)
            n_hist = len(history)
            if proc:
                state = f"{GREEN('●RECORDING')}  pid {proc.pid}  {proc.rss_mb:.0f} MB"
            else:
                state = f"{DIM('●stopped')}"
            size_str = _human_bytes(total_today) if total_today else DIM("--")
            items.append(InstrumentRow(
                instrument=inst,
                checked=False,
                enabled=proc is None,
                status_line=f"  {state:<40}  today: {size_str:>10}  "
                            f"{DIM(f'hist {n_hist}d')}",
            ))

        res = submenu(
            title="Record  —  ticks → data/raw/  (start TFA per instrument)",
            rows=items,
            show_date_mode_toggle=False,
            bottom_actions=["Start selected"],
        )
        if res.cancelled:
            return
        if not res.selected:
            print()
            print(f"  {YELLOW('!')} Nothing selected.")
            _pause_briefly()
            continue
        print()
        for inst in res.selected:
            _launch_no_pause(f"TFA: {inst}", "start-tfa.bat", inst)
        _pause_briefly()


def act_sea() -> None:
    while True:
        running = running_processes()
        items: list[InstrumentRow] = []
        for inst in _INSTRUMENTS:
            proc = next((p for p in running if p.instrument == inst and p.kind == "sea"), None)
            info = last_model_info(inst)
            live_path = ROOT / "data" / "features" / f"{inst}_live.ndjson"
            live_sz = _path_size(live_path) if live_path.exists() else 0
            live_str = _human_bytes(live_sz) if live_sz else DIM("(no live.ndjson)")
            if proc:
                state = f"{GREEN('●RUNNING')}  pid {proc.pid}  {proc.rss_mb:.0f} MB"
            else:
                state = f"{DIM('●stopped')}"
            items.append(InstrumentRow(
                instrument=inst,
                checked=False,
                enabled=(proc is None) and bool(info.version),
                status_line=f"  {state:<40}  "
                            f"{DIM('model:')} {DIM(info.version or 'none'):<24}  "
                            f"live: {live_str}",
            ))

        res = submenu(
            title="Run SEA  —  live features → signals/",
            rows=items,
            show_date_mode_toggle=False,
            bottom_actions=["Start selected"],
        )
        if res.cancelled:
            return
        if not res.selected:
            print()
            print(f"  {YELLOW('!')} Nothing selected.")
            _pause_briefly()
            continue
        print()
        for inst in res.selected:
            _launch_no_pause(f"SEA: {inst}", "start-sea.bat", inst)
        _pause_briefly()


# ── Single-date picker (Scored BT, Compare) ───────────────────────────────


def _single_date_picker(title: str, available: list[str], default: str = "") -> str | None:
    """Render a flat date list, return selected ISO date or None on cancel."""
    if not available:
        print()
        print(f"  {YELLOW('!')} {title}: no dates available.")
        _pause_briefly()
        return None
    dates = sorted(available)
    reserved = set(resolve_holdout_dates(
        features_root=ROOT / "data" / "features",
        raw_root=ROOT / "data" / "raw",
    ))
    selected = dates.index(default) if default in dates else len(dates) - 1
    while True:
        _clear()
        cols = _term_cols()
        W = min(cols - 4, 160)
        print()
        print(f"  {'═' * W}")
        print(f"    {BOLD(title)}")
        print(f"  {'═' * W}")
        print()
        if reserved:
            print(f"    {MAGENTA('[R]')}=reserved holdout (recommended for backtest)")
            print()
        # Render dates in a wide grid
        ppr = max(1, min(30, (cols - 13) // 11))
        for i, d in enumerate(dates):
            short = d[5:]
            is_reserved = d in reserved
            if i == selected:
                inner = MAGENTA(short) if is_reserved else short
                tok = CYAN("▶") + GREEN("[") + inner + GREEN("]")
            else:
                inner = MAGENTA(f" {short} ") if is_reserved else DIM(f" {short} ")
                tok = " " + inner
            end = "\n" if (i % ppr) == ppr - 1 else ""
            print(tok, end=end)
        if (len(dates) % ppr) != 0:
            print()
        print()
        print(f"  {DIM('─' * W)}")
        print(f"  " + _hk_line(
            ("←→", "move"),
            ("Enter", "select"),
            ("Esc", "cancel"),
        ))
        print()
        key = _getkey()
        if key == "esc":
            return None
        if key == "enter":
            return dates[selected]
        if key in ("left", "up"):
            selected = (selected - 1) % len(dates)
        elif key in ("right", "down"):
            selected = (selected + 1) % len(dates)


def act_sbt() -> None:
    while True:
        d1, _d2 = compute_walk_forward_dates()
        items: list[InstrumentRow] = []
        for inst in _INSTRUMENTS:
            info = last_model_info(inst)
            items.append(InstrumentRow(
                instrument=inst,
                checked=bool(info.version),
                enabled=bool(info.version),
                status_line=f"  {DIM('model:')} {DIM(info.version or 'none')}",
            ))
        res = submenu(
            title="Scored Backtest  —  step 1 of 2: pick instruments",
            rows=items,
            show_date_mode_toggle=False,
            bottom_actions=["Continue"],
        )
        if res.cancelled:
            return
        if not res.selected:
            print()
            print(f"  {YELLOW('!')} Nothing selected.")
            _pause_briefly()
            continue
        available = _scan_complete_feature_dates()
        reserved = set(resolve_holdout_dates(
            features_root=ROOT / "data" / "features",
            raw_root=ROOT / "data" / "raw",
        ))
        default_label = (f"reserved holdout = {d1}" if d1 and d1 in reserved
                         else f"D-1 = {d1 or '--'}")
        date = _single_date_picker(
            f"Scored Backtest  —  step 2 of 2: pick test date (default {default_label})",
            available,
            default=d1,
        )
        if not date:
            continue
        if reserved and date not in reserved:
            print()
            print(f"  {YELLOW('Note:')} {date} is NOT in the reserved holdout "
                  f"({', '.join(sorted(reserved)) or 'empty'}).")
            print(f"  Backtest results may be in-sample. Continue anyway?  (Enter=yes, Esc=cancel)")
            print()
            ch = _getkey()
            if ch == "esc":
                continue

        # Skip-if-scorecard-exists guard (ported from legacy launcher.py).
        # Split selected instruments into (already-scored, fresh) so the user
        # decides whether to re-score the duplicates or skip them.
        duplicates: list[str] = [inst for inst in res.selected
                                 if _has_scorecard(inst, date)]
        fresh: list[str] = [inst for inst in res.selected
                            if inst not in duplicates]
        if duplicates:
            print()
            print(f"  {YELLOW('!')} Scorecard for {date} already exists for:")
            for inst in duplicates:
                print(f"      - {BOLD(inst)}")
            print()
            print(f"  {GREEN('Y')} re-score all   "
                  f"{CYAN('S')} skip duplicates ({len(fresh)} fresh only)   "
                  f"{DIM('N / Esc')} cancel")
            print()
            chosen: list[str] | None = None
            while chosen is None:
                k = _getkey()
                if k in ("y", "Y", "enter"):
                    chosen = list(res.selected)
                elif k in ("s", "S"):
                    chosen = fresh
                elif k in ("n", "N", "esc"):
                    print(f"  {DIM('Cancelled.')}")
                    _pause_briefly()
                    chosen = []
            if not chosen:
                continue
            targets = chosen
        else:
            targets = list(res.selected)

        print()
        for inst in targets:
            _launch_no_pause(f"SBT: {inst} on {date}", "backtest-scored.bat", inst, date)
        if not targets:
            print(f"  {YELLOW('!')} Nothing launched.")
        _pause_briefly()


def act_compare() -> None:
    while True:
        d1, _d2 = compute_walk_forward_dates()
        items: list[InstrumentRow] = []
        for inst in _INSTRUMENTS:
            inst_dir = ROOT / "models" / inst
            n_versions = (
                sum(1 for v in inst_dir.iterdir() if v.is_dir()) if inst_dir.exists() else 0
            )
            items.append(InstrumentRow(
                instrument=inst,
                checked=n_versions >= 2,
                enabled=n_versions >= 2,
                status_line=(
                    f"  {DIM(f'{n_versions} versions')}"
                    if n_versions >= 2
                    else f"  {DIM(f'{n_versions} versions — need ≥2 to compare')}"
                ),
            ))
        res = submenu(
            title="Compare  —  step 1 of 2: pick instruments",
            rows=items,
            show_date_mode_toggle=False,
            bottom_actions=["Continue"],
        )
        if res.cancelled:
            return
        if not res.selected:
            print()
            print(f"  {YELLOW('!')} Nothing selected.")
            _pause_briefly()
            continue
        available = _scan_complete_feature_dates()
        date = _single_date_picker(
            f"Compare  —  step 2 of 2: pick test date (default D-1 = {d1 or '--'})",
            available,
            default=d1,
        )
        if not date:
            continue
        print()
        for inst in res.selected:
            _launch_no_pause(f"Compare: {inst} on {date}", "backtest-compare.bat", inst, date)
        _pause_briefly()


def act_watch() -> None:
    while True:
        items: list[InstrumentRow] = []
        for inst in _INSTRUMENTS:
            items.append(InstrumentRow(
                instrument=inst, checked=False, enabled=True, status_line="",
            ))
        res = submenu(
            title="Watch dashboards  —  step 1 of 2: pick instruments",
            rows=items,
            show_date_mode_toggle=False,
            bottom_actions=["Continue"],
        )
        if res.cancelled:
            return
        if not res.selected:
            print()
            print(f"  {YELLOW('!')} Nothing selected.")
            _pause_briefly()
            continue
        dash_items = [
            InstrumentRow(instrument="features  (feature stream watcher)",
                          checked=False, enabled=True, status_line=""),
            InstrumentRow(instrument="signals   (signal log tailer)",
                          checked=False, enabled=True, status_line=""),
        ]
        d_res = submenu(
            title="Watch dashboards  —  step 2 of 2: pick dashboards",
            rows=dash_items,
            show_date_mode_toggle=False,
            bottom_actions=["Open"],
        )
        if d_res.cancelled or not d_res.selected:
            continue
        open_features = any(s.startswith("features") for s in d_res.selected)
        open_signals = any(s.startswith("signals") for s in d_res.selected)
        print()
        for inst in res.selected:
            if open_features:
                _launch_no_pause(f"Features: {inst}", "watch-features.bat", inst)
            if open_signals:
                _launch_no_pause(f"Signals: {inst}", "watch-signals.bat", inst)
        _pause_briefly()


def _read_server_port() -> int:
    """Resolve the API server port from .env (PORT=...) with a 3000 default.

    Tolerates common .env quirks: '#' comments, surrounding whitespace around
    '=', quoted values, inline trailing comments. Any parse failure returns
    the 3000 default so a typo doesn't crash callers.
    """
    env_path = ROOT / ".env"
    if not env_path.exists():
        return 3000
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            s = raw.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            key, _, val = s.partition("=")
            if key.strip().upper() != "PORT":
                continue
            val = val.split("#", 1)[0].strip().strip('"').strip("'")
            try:
                return int(val)
            except ValueError:
                return 3000
    except OSError:
        return 3000
    return 3000


def _is_api_server_running(port: int, timeout: float = 1.5) -> bool:
    """True if the API server's /health endpoint responds 200 within timeout."""
    import urllib.error
    import urllib.request
    try:
        with urllib.request.urlopen(
            f"http://localhost:{port}/health", timeout=timeout
        ) as r:
            return r.status == 200
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        return False


def act_api_server() -> None:
    """Launch the Lubas broker / tRPC API server in a new window — unless one
    is already responding on /health (avoids duplicate spawns)."""
    port = _read_server_port()
    if _is_api_server_running(port):
        print()
        print(f"  {YELLOW('!')} API server already running on port {port} "
              f"({GREEN('/health')} responding).")
        print(f"  {DIM('Close the existing Lubas-Server window first if you need to restart.')}")
        _pause_briefly()
        return
    _launch_new_window("Lubas: API Server", "start-api.bat")


def act_restart_launcher() -> None:
    """Exit with code 75 so start.bat re-launches the launcher with fresh code.
    Clear the console so the new launcher starts on a clean screen."""
    _clear()
    sys.stdout.flush()
    sys.exit(75)


def act_yow_partha() -> None:
    """Launch yow-partha test entry — fires lifecycle pings so you can
    confirm the Telegram channel is wired. The real bot module will hook
    in here once it exists.

    Title must contain a space — `start` parses unquoted single-token
    titles as the program name, which broke when we passed "yow-partha".
    """
    _launch_new_window("Lubas: yow-partha", "start-yow-partha.bat")


def act_tools() -> None:
    """Tools menu — token refresh, credentials info, ops utilities."""
    items = [
        ("Refresh Dhan token (TOTP)",       "refresh-token"),
        ("Show Dhan credentials info",      "creds-info"),
        ("Today's raw file sizes",          "file-sizes"),
        ("Replay checkpoint status",        "checkpoint"),
    ]
    selected = 0
    while True:
        _clear()
        cols = _term_cols()
        W = min(cols - 4, 160)
        print()
        print(f"  {'═' * W}")
        print(f"    {BOLD('Tools')}")
        print(f"  {'═' * W}")
        print()
        for i, (label, _) in enumerate(items):
            marker = CYAN("►") if i == selected else " "
            text = BOLD(label) if i == selected else label
            print(f"    {marker}  {i + 1}. {text}")
        print()
        print(f"  {DIM('─' * W)}")
        print(f"  " + _hk_line(
            ("↑↓", "move"),
            ("Enter", "select"),
            ("Esc", "back"),
        ))
        print()
        key = _getkey()
        if key == "esc":
            return
        kind: str | None = None
        if key == "up":
            selected = (selected - 1) % len(items)
            continue
        elif key == "down":
            selected = (selected + 1) % len(items)
            continue
        elif key == "enter":
            kind = items[selected][1]
        elif key.isdigit():
            idx = int(key) - 1
            if 0 <= idx < len(items):
                kind = items[idx][1]
            else:
                continue
        else:
            continue

        if kind == "refresh-token":
            print()
            subprocess.run(["cmd", "/c", str(ROOT / "scripts" / "run-dhan-refresh.bat")],
                           cwd=str(ROOT))
            _pause_briefly()
        elif kind == "creds-info":
            print()
            print(f"  {YELLOW('Dhan credentials — interactive script')}")
            print()
            print("  Examples:")
            print(f"    {CYAN('node scripts/dhan-update-credentials.mjs --totp <SECRET>')}")
            print(f"    {CYAN('node scripts/dhan-update-credentials.mjs --show')}")
            print()
            _pause_briefly()
        elif kind == "file-sizes":
            today = datetime.now().strftime("%Y-%m-%d")
            d = ROOT / "data" / "raw" / today
            print()
            print(f"  {BOLD(f'Today raw files  ({today})')}")
            print()
            if not d.exists():
                print(f"  {YELLOW('No directory yet:')} {d}")
            else:
                for f in sorted(d.glob("*.ndjson.gz")):
                    print(f"    {f.name:<45}  {_human_bytes(_path_size(f)):>10}")
            print()
            _pause_briefly()
        elif kind == "checkpoint":
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


def act_replay() -> None:
    # Stay on this submenu after each action; only Esc returns to main menu.
    while True:
        running = running_processes()
        today = datetime.now().strftime("%Y-%m-%d")
        items: list[InstrumentDates] = []
        for inst in _INSTRUMENTS:
            reserved = set(resolve_holdout_dates(
                features_root=ROOT / "data" / "features",
                raw_root=ROOT / "data" / "raw",
                instrument=inst,
            ))
            raw = scan_raw_days(inst)
            parquet = scan_feature_days(inst)
            # Look up replay and TFA independently — both can run for the same
            # instrument at once (replay on past dates, TFA on today).
            replay_proc = next(
                (p for p in running if p.instrument == inst and p.kind == "replay"),
                None,
            )
            tfa_proc = next(
                (p for p in running if p.instrument == inst and p.kind == "tfa"),
                None,
            )
            # Replay already in flight on this instrument → block new selections
            # but render the in-flight dates as yellow ticks so the user sees
            # which dates are currently being processed.
            if replay_proc is not None:
                status = f"{YELLOW('●REPLAY')}  pid {replay_proc.pid}  {replay_proc.rss_mb:.0f} MB"
                if tfa_proc is not None:
                    status += f"   {YELLOW('+TFA pid ' + str(tfa_proc.pid))}"
                locked = set(parquet) & set(raw)   # already featurized → green ✓
                items.append(InstrumentDates(
                    instrument=inst, enabled=False, included=False,
                    available=sorted(set(raw)),
                    locked=locked,
                    status_hint=status,
                    in_progress=set(replay_proc.include_dates),
                    reserved=reserved,
                ))
                continue
            # TFA recording today's raw file. Today's date stays visible in the
            # list (so the user sees raw exists) — just warn via status hint.
            # The user decides whether to replay today's partial file.
            tfa_hint = (f"  {YELLOW('TFA pid ' + str(tfa_proc.pid) + ' writing ' + today)}"
                        if tfa_proc is not None else "")
            if not raw:
                items.append(InstrumentDates(
                    instrument=inst, enabled=False, included=False, available=[],
                    status_hint=DIM("(no raw recordings)"),
                ))
                continue
            locked = set(parquet) & set(raw)
            pending = set(raw) - set(parquet)
            if raw and not pending:
                # Every raw day is already featurized → row shows [✓], dim.
                items.append(InstrumentDates(
                    instrument=inst,
                    enabled=False,
                    included=True,
                    available=sorted(set(raw)),
                    locked=locked,
                    checked=set(),
                    status_hint=tfa_hint.strip(),
                    fully_done=True,
                    reserved=reserved,
                ))
                continue
            items.append(InstrumentDates(
                instrument=inst,
                enabled=True,
                included=bool(pending),
                available=sorted(set(raw)),
                locked=locked,
                checked=set(),
                status_hint=tfa_hint.strip(),
                reserved=reserved,
            ))

        res = date_picker("Replay  —  raw → data/features/  (pick instruments + dates)", items)
        if res.cancelled:
            return
        if not res.added:
            print()
            print(f"  {YELLOW('!')} No pending dates selected. Every available date is already "
                  f"featurized — use Delete first if you want to re-replay.")
            _pause_briefly()
            continue

        # Launch one terminal PER INSTRUMENT, passing each selected date as
        # its own --include-dates flag (argparse action="append" collects
        # them into a list). T47's pooled replay_runner (ProcessPoolExecutor
        # + rich dashboard, default min(num_dates, 16) workers) handles
        # per-date parallelism *inside* that terminal — no more
        # N-windows-per-date fan-out. NOTE: comma-joined lists like
        # "d1,d2,d3" cannot be used here because cmd.exe's `start` command
        # treats commas as token separators and would split the value
        # before it reaches start-replay.bat.
        print()
        launched = 0
        for inst, new_dates in res.added.items():
            sorted_dates = sorted(new_dates)
            if not sorted_dates:
                continue
            include_flags: list[str] = []
            for d in sorted_dates:
                include_flags.extend(["--include-dates", d])
            _launch_no_pause(
                f"Replay: {inst} ({len(sorted_dates)}d)",
                "start-replay.bat", inst, *include_flags,
            )
            launched += 1
        if launched == 0:
            print(f"  {YELLOW('!')} Nothing launched.")
        _pause_briefly()


# ── Delete submenu ────────────────────────────────────────────────────────


def _human_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    if n < 1024 * 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    return f"{n / (1024 * 1024 * 1024):.2f} GB"


def _path_size(path: Path) -> int:
    """Total size of a file, or recursive size of a directory."""
    if not path.exists():
        return 0
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    for f in path.rglob("*"):
        if f.is_file():
            try:
                total += f.stat().st_size
            except OSError:
                pass
    return total


def _typed_confirm(token: str, lines_above: list[str]) -> bool:
    """Clear screen, print preview lines, prompt for typed token. Esc cancels.
    Reads characters via msvcrt so Esc is detected mid-typing."""
    import msvcrt
    buf = ""
    while True:
        _clear()
        print()
        for line in lines_above:
            print(line)
        print()
        print(f"  Type {BOLD(RED(token))} and press {_hk('Enter', 'confirm')}     "
              f"{_hk('Esc', 'cancel')}:")
        print(f"    {YELLOW(buf)}")
        print()
        sys.stdout.flush()
        ch = msvcrt.getwch()
        if ch == "\x1b":  # Esc
            return False
        if ch == "\r":    # Enter
            return buf == token
        if ch in ("\b", "\x7f"):  # Backspace
            buf = buf[:-1]
            continue
        if ch in ("\xe0", "\x00"):  # extended (arrows etc) — swallow
            msvcrt.getwch()
            continue
        if ch.isprintable() and len(buf) < 32:
            buf += ch


def _delete_paths(paths: list[Path]) -> tuple[int, int]:
    """Delete files / directories. Returns (n_deleted, n_failed)."""
    import shutil
    n_ok = 0
    n_err = 0
    for p in paths:
        try:
            if p.is_dir():
                shutil.rmtree(p)
            elif p.exists():
                p.unlink()
            n_ok += 1
        except Exception as e:
            print(f"  {RED('✗')} {p}: {e}")
            n_err += 1
    return n_ok, n_err


def _rebuild_replay_checkpoint(instruments: set[str]) -> tuple[int, list[str]]:
    """Recompute the replay checkpoint from on-disk parquet reality.

    Called after a parquet-delete flow so the next replay run doesn't skip
    dates whose parquets were just removed. For each instrument passed in,
    the checkpoint's `last_completed_date` is reset to the latest date
    that still has a parquet on disk (or removed entirely if none remain).
    `sessions_completed` is recounted from disk.

    Returns:
        (n_instruments_updated, summary_lines)
    """
    import json
    cp_path = ROOT / "data" / "raw" / "replay_checkpoint.json"
    features_root = ROOT / "data" / "features"
    try:
        data = json.loads(cp_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return (0, [])

    updated = 0
    summary: list[str] = []
    for inst in sorted(instruments):
        # Scan features dir for surviving parquets of this instrument.
        dates_on_disk: list[str] = []
        if features_root.exists():
            for date_dir in features_root.iterdir():
                if not date_dir.is_dir():
                    continue
                if (date_dir / f"{inst}_features.parquet").exists():
                    dates_on_disk.append(date_dir.name)
        dates_on_disk.sort()

        before = data.get(inst, {}).get("last_completed_date")
        if dates_on_disk:
            new_last = dates_on_disk[-1]
            data[inst] = {
                "last_completed_date": new_last,
                "sessions_completed": len(dates_on_disk),
            }
            if before != new_last:
                summary.append(f"{inst}: {before} → {new_last} ({len(dates_on_disk)} sessions)")
                updated += 1
        elif inst in data:
            # No parquets left for this instrument — drop the entry entirely.
            del data[inst]
            summary.append(f"{inst}: cleared (no parquets remain)")
            updated += 1

    cp_path.parent.mkdir(parents=True, exist_ok=True)
    cp_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return (updated, summary)


def _delete_raw_or_parquet(kind: str) -> None:
    """Shared body for the Raw and Parquet delete flows.
    `kind` ∈ {'raw', 'parquet'}."""
    label = "raw recordings" if kind == "raw" else "parquet features"
    # Per-instrument reservations: each row colours its own dates and the
    # post-pick safety check uses the same dict.
    reserved_by_inst: dict[str, set[str]] = {
        inst: set(resolve_holdout_dates(
            features_root=ROOT / "data" / "features",
            raw_root=ROOT / "data" / "raw",
            instrument=inst,
        )) for inst in _INSTRUMENTS
    }
    items: list[InstrumentDates] = []
    for inst in _INSTRUMENTS:
        reserved = reserved_by_inst[inst]
        if kind == "raw":
            # Include lock-only days too so the user can clean up stale state
            # left behind by a TFA that never finished writing.
            dates = scan_raw_artifact_days(inst)
        else:
            dates = scan_feature_days(inst)
        if not dates:
            items.append(InstrumentDates(
                instrument=inst, enabled=False, included=False, available=[],
                status_hint=DIM(f"(no {kind})"),
            ))
            continue
        items.append(InstrumentDates(
            instrument=inst,
            enabled=True,
            included=False,             # default OFF for destructive ops
            available=sorted(set(dates)),
            locked=set(),               # no locked dates for delete
            checked=set(),              # default empty selection
            status_hint=DIM(f"({len(dates)} dates)"),
            reserved=reserved,
        ))

    res = date_picker(f"Delete {label.upper()}  —  pick instruments + dates", items)
    if res.cancelled:
        return
    if not res.selections:
        print()
        print(f"  {YELLOW('!')} Nothing selected.")
        _pause_briefly()
        return

    # Holdout safety check: if user selected any reserved date, force a
    # typed-token confirm with explicit warning.
    reserved_hits: list[tuple[str, str]] = []
    for inst, dates in res.selections.items():
        for d in dates:
            if d in reserved_by_inst.get(inst, set()):
                reserved_hits.append((inst, d))
    if reserved_hits:
        print()
        print(f"  {RED('!! HOLDOUT WARNING !!')}")
        print()
        print(f"  You are about to delete dates reserved for backtest holdout:")
        for inst, d in reserved_hits:
            print(f"    - {MAGENTA(inst + '  ' + d)}")
        print()
        print(f"  Deleting these will break out-of-sample backtest. Re-record /")
        print(f"  re-replay would normally restore the parquets, but the holdout")
        print(f"  policy in {DIM('config/holdout_dates.json')} would then keep")
        print(f"  reserving them anyway, so this is mostly a wasted destructive op.")
        print()
        if not _typed_confirm("DELETE-HOLDOUT", [
            "  Type this exact phrase to override the holdout protection:",
        ]):
            print()
            print(f"  {YELLOW('Cancelled.')}")
            _pause_briefly()
            return

    # Resolve actual paths + sizes
    plan: list[tuple[Path, int]] = []
    for inst, dates in res.selections.items():
        for d in dates:
            if kind == "raw":
                # Grab every raw artifact for this instrument-day: the .gz
                # data files AND auxiliary .lock / partial files. Lock-only
                # days (TFA started, never wrote ticks) are the common
                # cleanup target.
                day_dir = ROOT / "data" / "raw" / d
                for f in day_dir.glob(f"{inst}*"):
                    if f.is_file():
                        plan.append((f, _path_size(f)))
            else:
                p = ROOT / "data" / "features" / d / f"{inst}_features.parquet"
                if p.exists():
                    plan.append((p, _path_size(p)))

    if not plan:
        print()
        print(f"  {YELLOW('!')} Nothing to delete.")
        _pause_briefly()
        return

    total = sum(s for _, s in plan)
    preview = [
        f"  {BOLD('About to delete:')}",
        "",
    ]
    for p, s in plan[:20]:
        preview.append(f"    {p.relative_to(ROOT)}    {DIM(_human_bytes(s))}")
    if len(plan) > 20:
        preview.append(f"    {DIM(f'… +{len(plan) - 20} more files')}")
    preview.append("")
    preview.append(f"  {BOLD(f'Total: {len(plan)} files, ~{_human_bytes(total)}')}")

    if not _typed_confirm("DELETE", preview):
        print(f"  {DIM('Cancelled.')}")
        _pause_briefly()
        return

    ok, err = _delete_paths([p for p, _ in plan])

    # Empty-date-folder cleanup: for each (instrument, date) we touched, if no
    # instrument-specific artifact remains in that date's directory, drop any
    # orphan metadata.json and remove the directory itself.
    touched_dirs: set[Path] = {p.parent for p, _ in plan}
    pruned_dirs = 0
    for day_dir in touched_dirs:
        if not day_dir.exists():
            continue
        # Any instrument artifact still here?
        any_inst_file = any(
            f.is_file() and any(f.name.startswith(inst) for inst in _INSTRUMENTS)
            for f in day_dir.iterdir()
        )
        if any_inst_file:
            continue
        # Only metadata / housekeeping left → wipe it too, then rmdir.
        try:
            for f in list(day_dir.iterdir()):
                if f.is_file():
                    f.unlink()
            day_dir.rmdir()
            pruned_dirs += 1
        except OSError as e:
            print(f"  {YELLOW('!')} could not remove {day_dir}: {e}")

    # If we just deleted parquets, the replay checkpoint may now skip dates
    # we removed. Rebuild it from on-disk reality before the next replay run.
    cp_updates: list[str] = []
    if kind == "parquet":
        touched_insts = set(res.selections.keys())
        _, cp_updates = _rebuild_replay_checkpoint(touched_insts)

    print()
    msg = f"  {GREEN('✓')} Deleted {ok} files"
    if err:
        msg += f", {RED(str(err) + ' failed')}"
    if pruned_dirs:
        msg += f", {GREEN('✓')} pruned {pruned_dirs} empty date folder(s)"
    print(msg)
    if cp_updates:
        print(f"  {GREEN('✓')} Replay checkpoint updated:")
        for line in cp_updates:
            print(f"      {line}")
    _pause_briefly()


def _delete_backtest() -> None:
    """Delete scored-backtest output for (instrument, date) across all model
    versions. Layout: data/backtests/<instrument>/<version>/<date>/."""
    items: list[InstrumentDates] = []
    for inst in _INSTRUMENTS:
        reserved = set(resolve_holdout_dates(
            features_root=ROOT / "data" / "features",
            raw_root=ROOT / "data" / "raw",
            instrument=inst,
        ))
        dates = scan_backtest_days(inst)
        if not dates:
            items.append(InstrumentDates(
                instrument=inst, enabled=False, included=False, available=[],
                status_hint=DIM("(no scorecards)"),
            ))
            continue
        # Count total scorecards across all versions for this instrument
        bt_root = ROOT / "data" / "backtests" / inst
        total = 0
        if bt_root.exists():
            for vdir in bt_root.iterdir():
                if vdir.is_dir():
                    total += sum(1 for d in vdir.iterdir() if d.is_dir())
        items.append(InstrumentDates(
            instrument=inst,
            enabled=True,
            included=False,            # default OFF for destructive ops
            available=sorted(set(dates)),
            locked=set(),
            checked=set(),
            status_hint=DIM(f"({len(dates)} dates, {total} scorecards)"),
            reserved=reserved,
        ))

    res = date_picker("Delete BACKTESTS  —  pick instruments + dates", items)
    if res.cancelled:
        return
    if not res.selections:
        print()
        print(f"  {YELLOW('!')} Nothing selected.")
        _pause_briefly()
        return

    # Resolve actual paths: for each (instrument, date) picked, sweep every
    # version dir under data/backtests/<instrument>/ and delete the matching
    # <date>/ folder (with its scorecard.json and any siblings).
    plan: list[tuple[Path, int]] = []
    for inst, dates in res.selections.items():
        bt_root = ROOT / "data" / "backtests" / inst
        if not bt_root.exists():
            continue
        for vdir in bt_root.iterdir():
            if not vdir.is_dir():
                continue
            for d in dates:
                day_dir = vdir / d
                if day_dir.exists() and day_dir.is_dir():
                    plan.append((day_dir, _path_size(day_dir)))

    if not plan:
        print()
        print(f"  {YELLOW('!')} Nothing to delete.")
        _pause_briefly()
        return

    total = sum(s for _, s in plan)
    preview = [f"  {BOLD('About to delete:')}", ""]
    for p, s in plan[:20]:
        preview.append(f"    {p.relative_to(ROOT)}    {DIM(_human_bytes(s))}")
    if len(plan) > 20:
        preview.append(f"    {DIM(f'… +{len(plan) - 20} more dirs')}")
    preview.append("")
    preview.append(f"  {BOLD(f'Total: {len(plan)} backtest dirs, ~{_human_bytes(total)}')}")

    if not _typed_confirm("DELETE", preview):
        print(f"  {DIM('Cancelled.')}")
        _pause_briefly()
        return

    ok, err = _delete_paths([p for p, _ in plan])

    # Prune empty version dirs (and the per-instrument root) after deletion.
    touched_version_dirs: set[Path] = {p.parent for p, _ in plan}
    pruned = 0
    for vdir in touched_version_dirs:
        try:
            if vdir.exists() and not any(vdir.iterdir()):
                vdir.rmdir()
                pruned += 1
                inst_root = vdir.parent
                if inst_root.exists() and not any(inst_root.iterdir()):
                    inst_root.rmdir()
                    pruned += 1
        except OSError:
            pass

    print()
    msg = f"  {GREEN('✓')} Deleted {ok} backtest dirs"
    if err:
        msg += f", {RED(str(err) + ' failed')}"
    if pruned:
        msg += f", {GREEN('✓')} pruned {pruned} empty parent dir(s)"
    print(msg)
    _pause_briefly()


def _delete_live() -> None:
    """Truncate per-instrument data/features/<inst>_live.ndjson files."""
    items: list[InstrumentRow] = []
    paths_by_inst: dict[str, Path] = {}
    for inst in _INSTRUMENTS:
        p = ROOT / "data" / "features" / f"{inst}_live.ndjson"
        paths_by_inst[inst] = p
        size = _path_size(p)
        if not p.exists():
            line = DIM("  (no live.ndjson)")
            enabled = False
        else:
            line = f"  {DIM(_human_bytes(size))}  {DIM(str(p.relative_to(ROOT)))}"
            enabled = True
        items.append(InstrumentRow(
            instrument=inst, checked=False, enabled=enabled, status_line=line,
        ))

    res = submenu(
        title="Delete LIVE feature stream  —  pick instruments",
        rows=items,
        show_date_mode_toggle=False,
        bottom_actions=["Delete"],
    )
    if res.cancelled or not res.selected:
        return

    plan: list[tuple[Path, int]] = []
    for inst in res.selected:
        p = paths_by_inst[inst]
        if p.exists():
            plan.append((p, _path_size(p)))

    if not plan:
        print()
        print(f"  {YELLOW('!')} Nothing to delete.")
        _pause_briefly()
        return

    total = sum(s for _, s in plan)
    preview = [f"  {BOLD('About to delete:')}", ""]
    for p, s in plan:
        preview.append(f"    {p.relative_to(ROOT)}    {DIM(_human_bytes(s))}")
    preview.append("")
    preview.append(f"  {BOLD(f'Total: {len(plan)} files, ~{_human_bytes(total)}')}")
    preview.append(f"  {YELLOW('!')} Affected SEAs will hit EOF and stop emitting "
                   f"until TFA writes new ticks.")

    if not _typed_confirm("DELETE", preview):
        print(f"  {DIM('Cancelled.')}")
        _pause_briefly()
        return

    ok, err = _delete_paths([p for p, _ in plan])
    print()
    print(f"  {GREEN('✓')} Deleted {ok} files" + (f", {RED(str(err) + ' failed')}" if err else ""))
    _pause_briefly()


def _delete_model() -> None:
    """Delete model versions. LATEST is protected unless explicit override."""
    items: list[InstrumentRow] = []
    versions_by_inst: dict[str, list[tuple[str, bool, int]]] = {}  # (version, is_latest, size)
    for inst in _INSTRUMENTS:
        inst_dir = ROOT / "models" / inst
        if not inst_dir.exists():
            items.append(InstrumentRow(
                instrument=inst, checked=False, enabled=False,
                status_line=DIM("  (no models)"),
            ))
            versions_by_inst[inst] = []
            continue
        latest_ptr = inst_dir / "LATEST"
        latest = latest_ptr.read_text(encoding="utf-8").strip() if latest_ptr.exists() else ""
        vlist: list[tuple[str, bool, int]] = []
        for vdir in sorted(inst_dir.iterdir()):
            if not vdir.is_dir():
                continue
            vlist.append((vdir.name, vdir.name == latest, _path_size(vdir)))
        versions_by_inst[inst] = vlist
        total_size = sum(s for _, _, s in vlist)
        items.append(InstrumentRow(
            instrument=inst, checked=False, enabled=bool(vlist),
            status_line=f"  {DIM(f'{len(vlist)} versions, {_human_bytes(total_size)}')}  "
                        f"{DIM('LATEST=')}{latest or DIM('none')}",
        ))

    res = submenu(
        title="Delete MODELS  —  step 1 of 2: pick instruments",
        rows=items,
        show_date_mode_toggle=False,
        bottom_actions=["Continue"],
    )
    if res.cancelled or not res.selected:
        return

    # Step 2: per-instrument, pick which versions to delete.
    # We render this as a flat list of (instrument, version) rows.
    plan: list[tuple[Path, int]] = []
    summary_lines: list[str] = []
    for inst in res.selected:
        vlist = versions_by_inst[inst]
        rows: list[InstrumentRow] = []
        for ver, is_latest, sz in vlist:
            label = ver + (f"  {YELLOW('(LATEST)')}" if is_latest else "")
            rows.append(InstrumentRow(
                instrument=label,
                checked=False,
                enabled=True,           # LATEST IS deletable but we'll warn
                status_line=f"  {DIM(_human_bytes(sz))}",
            ))
        if not rows:
            continue
        v_res = submenu(
            title=f"Delete MODELS  —  {inst}: pick versions",
            rows=rows,
            show_date_mode_toggle=False,
            bottom_actions=["Continue"],
        )
        if v_res.cancelled:
            return
        for sel_label in v_res.selected:
            ver = sel_label.split("  ")[0]  # strip "(LATEST)" tag
            vdir = ROOT / "models" / inst / ver
            plan.append((vdir, _path_size(vdir)))
            summary_lines.append(
                f"    models/{inst}/{ver}    {DIM(_human_bytes(_path_size(vdir)))}"
            )

    if not plan:
        print()
        print(f"  {YELLOW('!')} No versions selected.")
        _pause_briefly()
        return

    total = sum(s for _, s in plan)
    preview = [f"  {BOLD('About to delete:')}", "", *summary_lines, ""]
    preview.append(f"  {BOLD(f'Total: {len(plan)} versions, ~{_human_bytes(total)}')}")
    # Warn if any LATEST is being deleted
    latest_in_plan = []
    for p, _ in plan:
        # path is models/<inst>/<version>
        inst_name = p.parent.name
        latest_ptr = p.parent / "LATEST"
        if latest_ptr.exists():
            latest = latest_ptr.read_text(encoding="utf-8").strip()
            if latest == p.name:
                latest_in_plan.append(f"{inst_name}/{p.name}")
    if latest_in_plan:
        preview.append("")
        preview.append(f"  {RED('!!')} Deleting CURRENT LATEST for: {', '.join(latest_in_plan)}")
        preview.append(f"     SEA will fail to load that instrument until a new model is trained.")

    if not _typed_confirm("DELETE", preview):
        print(f"  {DIM('Cancelled.')}")
        _pause_briefly()
        return

    # Also clear LATEST file when its target is deleted
    for p, _ in plan:
        inst_name = p.parent.name
        latest_ptr = p.parent / "LATEST"
        if latest_ptr.exists():
            latest = latest_ptr.read_text(encoding="utf-8").strip()
            if latest == p.name:
                try:
                    latest_ptr.unlink()
                except OSError:
                    pass

    ok, err = _delete_paths([p for p, _ in plan])
    print()
    print(f"  {GREEN('✓')} Deleted {ok} model versions"
          + (f", {RED(str(err) + ' failed')}" if err else ""))
    _pause_briefly()


def act_delete() -> None:
    """Delete category picker → routes to one of the four delete flows."""
    categories = [
        ("Raw recordings       (data/raw/<date>/<inst>*.ndjson.gz)",     "raw"),
        ("Parquet features     (data/features/<date>/<inst>_features.parquet)", "parquet"),
        ("Backtest scorecards  (data/backtests/<inst>/<version>/<date>/)", "backtest"),
        ("Live feature stream  (data/features/<inst>_live.ndjson)",      "live"),
        ("Model versions       (models/<inst>/<version>/)",              "model"),
    ]
    selected = 0
    while True:
        _clear()
        W = 76
        bar = "═" * W
        print()
        print(f"  {bar}")
        print(f"    {BOLD('Delete')}  {DIM('— pick what to remove')}")
        print(f"  {bar}")
        print()
        for i, (label, _) in enumerate(categories):
            marker = CYAN("►") if i == selected else " "
            text = BOLD(label) if i == selected else label
            print(f"    {marker}  {i + 1}. {text}")
        print()
        print(f"  {DIM('─' * W)}")
        print(f"  " + _hk_line(
            ("↑↓", "move"),
            ("Enter", "select"),
            ("1-5", "jump"),
            ("Esc", "cancel"),
        ))
        print()
        key = _getkey()
        if key == "esc":
            return
        kind: str | None = None
        if key == "up":
            selected = (selected - 1) % len(categories)
            continue
        elif key == "down":
            selected = (selected + 1) % len(categories)
            continue
        elif key == "enter":
            kind = categories[selected][1]
        elif key.isdigit():
            idx = int(key) - 1
            if 0 <= idx < len(categories):
                kind = categories[idx][1]
            else:
                continue
        else:
            continue

        if kind == "raw":
            _delete_raw_or_parquet("raw")
        elif kind == "parquet":
            _delete_raw_or_parquet("parquet")
        elif kind == "backtest":
            _delete_backtest()
        elif kind == "live":
            _delete_live()
        elif kind == "model":
            _delete_model()


# ── Root menu ─────────────────────────────────────────────────────────────


@dataclass
class RootItem:
    label: str
    hotkey: str
    action: callable


def _read_replay_progress() -> list[tuple[str, str, float, str]]:
    """Scan `data/features/*/<inst>_features_progress.json` for files that
    were updated in the last 60s and return one row per active replay:
        (instrument, date, percent_capped_0_99, eta_str)

    Stale or unreadable files are skipped. Used by the root status header
    to surface real-time replay progress alongside the bare 'running' line.
    """
    import json, time
    out: list[tuple[str, str, float, str]] = []
    features_root = ROOT / "data" / "features"
    if not features_root.exists():
        return out
    now = time.time()
    for date_dir in features_root.iterdir():
        if not date_dir.is_dir():
            continue
        for f in date_dir.glob("*_features_progress.json"):
            try:
                if now - f.stat().st_mtime > 60:
                    continue
                data = json.loads(f.read_text(encoding="utf-8"))
                inst = data.get("instrument") or f.name.split("_")[0]
                date_str = data.get("date") or date_dir.name
                pct = float(data.get("percent_est", 0.0))
                pct = max(0.0, min(99.0, pct))  # cap so a low total_est can't read >100%
                rate = float(data.get("rate_events_per_sec", 0.0))
                processed = float(data.get("events_processed", 0.0))
                total_est = float(data.get("events_total_est", 0.0))
                remaining = max(0.0, total_est - processed)
                if rate > 0 and remaining > 0:
                    eta_sec = remaining / rate
                    if eta_sec < 60:
                        eta_str = f"{int(eta_sec)}s"
                    else:
                        eta_str = f"{eta_sec / 60:.1f}m"
                else:
                    eta_str = "—"
                out.append((inst, date_str, pct, eta_str))
            except Exception:
                continue
    # Sort by instrument then date for stable display
    out.sort(key=lambda r: (r[0], r[1]))
    return out


def _root_status_header(procs: list[RunningProc] | None = None) -> list[str]:
    today = datetime.now().strftime("%Y-%m-%d")
    d1, d2 = compute_walk_forward_dates()
    if procs is None:
        procs = running_processes()
    by_kind: dict[str, list[str]] = {}
    for p in procs:
        by_kind.setdefault(p.kind, []).append(p.instrument)
    parts: list[str] = []
    for kind in ("tfa", "replay", "sea", "train"):
        if kind in by_kind:
            parts.append(f"{kind}({','.join(sorted(by_kind[kind]))})")
    running_str = "  ".join(parts) if parts else DIM("idle")
    lines = [
        f"today: {today}    D-1: {d1 or '--'}    D-2: {d2 or '--'}",
        f"running: {running_str}",
    ]
    # Real-time progress per active replay (T4 follow-on).
    for inst, date_str, pct, eta in _read_replay_progress():
        lines.append(
            f"  {YELLOW('↳')} {inst:<10} {date_str}  "
            f"{BOLD(f'{pct:5.1f}%')}  ETA {eta}"
        )
    return lines


def _compute_pending_counts(procs: list[RunningProc]) -> dict[str, int]:
    """Pending work for each pipeline stage, summed across all instruments.

    Returns a dict keyed by root-menu hotkey:
      "F" replay   = raw days that have no parquet AND no in-flight replay
      "T" train    = parquet days not yet trained on AND not reserved holdout
      "B" backtest = reserved holdout days that have no scorecard yet
      "P" compare  = reserved holdout days without a compare report

    Caller passes the cached procs list so we don't re-shell PowerShell.
    """
    replay_in_flight: dict[str, set[str]] = {inst: set() for inst in _INSTRUMENTS}
    for p in procs:
        if p.kind == "replay" and p.instrument in replay_in_flight:
            replay_in_flight[p.instrument].update(p.include_dates)

    replay_pending = 0
    train_pending = 0
    backtest_pending = 0
    compare_pending = 0
    for inst in _INSTRUMENTS:
        reserved = set(resolve_holdout_dates(
            features_root=ROOT / "data" / "features",
            raw_root=ROOT / "data" / "raw",
            instrument=inst,
        ))
        raw = set(scan_raw_days(inst))
        parquet = set(scan_feature_days(inst))
        info = last_model_info(inst)
        trained = set(info.trained_dates)
        # F: replay pending — raw not yet featurized, not currently being
        # replayed, and not reserved (reserved dates are tracked separately
        # under Backtest pending).
        replay_pending += len(raw - parquet - replay_in_flight[inst] - reserved)
        # T: train pending — parquet not in latest model's trained_dates AND not reserved
        train_pending  += len(parquet - trained - reserved)
        # B: backtest pending — reserved dates missing a scorecard for THIS instrument
        for d in reserved:
            if d in parquet and not _has_scorecard(inst, d):
                backtest_pending += 1
        # P: compare pending — reserved dates without a compare report
        for d in reserved:
            if d in parquet and not _has_compare_report(inst, d):
                compare_pending += 1
    return {"F": replay_pending, "T": train_pending,
            "B": backtest_pending, "P": compare_pending}


def _has_compare_report(instrument: str, date: str) -> bool:
    """True if a compare-report file exists for (instrument, date)."""
    bt_root = ROOT / "data" / "backtests" / instrument
    if not bt_root.exists():
        return False
    for vdir in bt_root.iterdir():
        if not vdir.is_dir():
            continue
        if (vdir / date / "compare.json").exists():
            return True
    return False


def _has_scorecard(instrument: str, date: str) -> bool:
    """True if any scorecard for `instrument` exists on `date` (any model version)."""
    bt_root = ROOT / "data" / "backtests" / instrument
    if not bt_root.exists():
        return False
    for vdir in bt_root.iterdir():
        if not vdir.is_dir():
            continue
        if (vdir / date / "scorecard.json").exists():
            return True
    return False


def _render_status_table(procs: list[RunningProc] | None = None) -> list[str]:
    """One table summarising every known date × instrument × pipeline stage.

    Rows: union of every date that appears in raw / parquet / model-trained /
    backtest history across all 4 instruments.
    Columns (per instrument): Raw / Rep / Trn / SBT.
    Cell values:
        green ✓  = done
        yellow … = in progress (a TFA/replay/train process is running for that
                   instrument; the specific date may or may not be the one
                   currently being processed — we show ALL pending cells as
                   loading for that instrument+stage)
        dim   ·  = not done
    """
    # Process state per instrument
    if procs is None:
        procs = running_processes()
    proc_kinds: dict[str, set[str]] = {inst: set() for inst in _INSTRUMENTS}
    # Dates that an active replay is specifically processing, per instrument.
    replay_dates: dict[str, set[str]] = {inst: set() for inst in _INSTRUMENTS}
    for p in procs:
        if p.instrument in proc_kinds:
            proc_kinds[p.instrument].add(p.kind)
            if p.kind == "replay":
                replay_dates[p.instrument].update(p.include_dates)

    today = datetime.now().strftime("%Y-%m-%d")

    # Gather state for every (instrument, date) tuple
    state: dict[str, dict[str, dict[str, str]]] = {}
    all_dates: set[str] = set()
    for inst in _INSTRUMENTS:
        raw = set(scan_raw_days(inst))
        parquet = set(scan_feature_days(inst))
        info = last_model_info(inst)
        trained = set(info.trained_dates)
        inst_dates = raw | parquet | trained
        if "tfa" in proc_kinds[inst]:
            inst_dates.add(today)
        state[inst] = {}
        pending_rep = raw - parquet
        pending_trn = parquet - trained
        for d in inst_dates:
            # raw cell
            if d in raw:
                raw_state = "done"
            elif d == today and "tfa" in proc_kinds[inst]:
                raw_state = "loading"
            else:
                raw_state = "none"
            # rep cell — only mark "loading" for dates the running replay was
            # actually launched with (parsed from --include-dates args).
            if d in parquet:
                rep_state = "done"
            elif d in replay_dates[inst]:
                rep_state = "loading"
            else:
                rep_state = "none"
            # trn cell
            if d in trained:
                trn_state = "done"
            elif d in pending_trn and "train" in proc_kinds[inst]:
                trn_state = "loading"
            else:
                trn_state = "none"
            # sbt cell — no real-time progress tracking, just done/none
            sbt_state = "done" if _has_scorecard(inst, d) else "none"
            state[inst][d] = {
                "raw": raw_state, "rep": rep_state,
                "trn": trn_state, "sbt": sbt_state,
            }
        all_dates |= inst_dates

    if not all_dates:
        return [DIM("  (no data yet — record some ticks to begin)")]

    dates = sorted(all_dates)   # ascending: oldest first, newest at the bottom

    # Compact one-column-per-instrument layout. Each cell holds 4 tick chars
    # in fixed positions:
    #   pos 1 = Raw   (recorded ticks)
    #   pos 2 = Rep   (replay → parquet features)
    #   pos 3 = Trn   (model trained including this date)
    #   pos 4 = SBT   (scorecard exists for this date)
    # Each tick is green when that stage is done, yellow when a process is
    # currently working on it, and dim grey otherwise.
    DATE_W = 14
    TICK_W = 4                                       # 4 ticks per cell
    COL_W = max(TICK_W, max(len(i) for i in _INSTRUMENTS))   # instrument-name width
    INTER_GAP = "    "                               # gap between instrument cells
    # Centre offset so the 4-tick block lines up under the centred name
    PAD_L = (COL_W - TICK_W) // 2
    PAD_R = COL_W - TICK_W - PAD_L

    def _tick(v: str) -> str:
        if v == "done":    return GREEN("✓")   # stage finished
        if v == "loading": return YELLOW("✓")  # stage in progress
        return DIM("✓")                        # stage not done

    # Single header row — instrument labels centred over each cell
    header_top = " " * DATE_W
    for i, inst in enumerate(_INSTRUMENTS):
        if i > 0:
            header_top += INTER_GAP
        header_top += BOLD(inst.center(COL_W))

    rule_w = DATE_W + COL_W * len(_INSTRUMENTS) + len(INTER_GAP) * (len(_INSTRUMENTS) - 1)
    rule = "  " + DIM("─" * (rule_w - 2))

    out: list[str] = [header_top, rule]
    for d in dates:
        line = f"  {d}  "  # 14 chars total
        for i, inst in enumerate(_INSTRUMENTS):
            if i > 0:
                line += INTER_GAP
            row = state[inst].get(d, {})
            # If raw data was never collected for this instrument+date, the
            # whole pipeline is N/A — show a single dim hyphen, not 4 ticks.
            # .center() can't be used on coloured strings because ANSI escape
            # bytes inflate len(), so we centre manually around the visible
            # 1-char "-" within TICK_W visible chars.
            if row.get("raw", "none") != "done":
                pad_l = (TICK_W - 1) // 2
                pad_r = TICK_W - 1 - pad_l
                cell = " " * pad_l + DIM("-") + " " * pad_r
            else:
                cell = "".join(
                    _tick(row.get(stage, "none"))
                    for stage in ("raw", "rep", "trn", "sbt")
                )
            line += " " * PAD_L + cell + " " * PAD_R
        out.append(line)
    return out


def _draw_root(
    items: list[RootItem],
    selected: int,
    header_lines: list[str],
    table_lines: list[str],
    pending: dict[str, int] | None = None,
) -> None:
    _clear()
    cols = _term_cols()
    W = min(cols - 4, 160)
    bar = "═" * W
    print()
    print(f"  {bar}")
    print(f"    {BOLD('Lubas Launcher')}  {DIM('(v2)')}")
    for line in header_lines:
        print(f"    {DIM(line)}")
    print(f"  {bar}")
    print()
    # Status table
    for line in table_lines:
        print(line)
    print()
    print(f"  {DIM('─' * W)}")
    print(f"    {BOLD('Main menu')}")
    print()
    # Compute max raw-label width once so the suffix column aligns across rows.
    label_width = max(len(it.label) for it in items)
    for i, it in enumerate(items):
        marker = CYAN("►") if i == selected else " "
        hint = f"{PINK('[' + it.hotkey + ']')}"
        # Pad before applying BOLD so the colour codes don't throw off width.
        padded = it.label.ljust(label_width)
        label = BOLD(padded) if i == selected else padded
        suffix = ""
        if pending is not None:
            n = pending.get(it.hotkey, -1)
            if n > 0:
                suffix = f"   {YELLOW(f'[{n} pending]')}"
            elif n == 0:
                suffix = f"   {DIM('[up to date]')}"
        print(f"    {marker}  {hint}  {label}{suffix}")
    print()
    print(f"  {DIM('─' * W)}")
    print(f"  " + _hk_line(
        ("↑↓", "navigate"),
        ("Enter", "select"),
        ("Hotkey", "jump"),
        ("R", "refresh"),
        ("Esc", "quit"),
    ))
    print()


def main() -> None:
    items = [
        RootItem("API Server   (Lubas broker / tRPC server)", "A", act_api_server),
        RootItem("Record       (ticks → data/raw/)",       "Q", act_record),
        RootItem("Replay       (raw → data/features/)",    "F", act_replay),
        RootItem("Train        (features → models/)",      "T", act_train),
        RootItem("Backtest     (scored on D-1)",           "B", act_sbt),
        RootItem("Compare      (model vs prior on D-1)",   "P", act_compare),
        RootItem("Run SEA      (live features → signals/)", "I", act_sea),
        RootItem("Watch        (live dashboards)",         "W", act_watch),
        RootItem("yow-partha   (Telegram control bot)",    "Y", act_yow_partha),
        RootItem("Tools        (token / creds / status)",  ".", act_tools),
        RootItem("Restart      (reload launcher code)",    "L", act_restart_launcher),
        RootItem("Delete       (raw / parquet / live / models)", "X", act_delete),
    ]
    # NOTE: `R` and `C` are reserved as global refresh / clear hotkeys; root
    # items use `Q` for Record and `P` for Compare to avoid conflicts.
    selected = 0
    hotkey_map = {it.hotkey.lower(): i for i, it in enumerate(items)}
    # Cache the status header + table + pending counts. `running_processes()`
    # shells out to PowerShell (~300-500 ms cold start) — call it ONCE per
    # refresh and share the result between header, table, and counters.
    def _refresh() -> tuple[list[str], list[str], dict[str, int]]:
        procs = running_processes()
        return (
            _root_status_header(procs),
            _render_status_table(procs),
            _compute_pending_counts(procs),
        )

    header_lines, table_lines, pending = _refresh()
    while True:
        _draw_root(items, selected, header_lines, table_lines, pending)
        key = _getkey()
        if key == "esc":
            break
        if key == "up":
            selected = (selected - 1) % len(items)
        elif key == "down":
            selected = (selected + 1) % len(items)
        elif key == "enter":
            items[selected].action()
            _flush_keys()
            header_lines, table_lines, pending = _refresh()
        elif key.lower() == "r":
            header_lines, table_lines, pending = _refresh()
        elif key.lower() in hotkey_map:
            selected = hotkey_map[key.lower()]
            items[selected].action()
            _flush_keys()
            header_lines, table_lines, pending = _refresh()

    _clear()
    print()
    print(f"  {GREEN('Goodbye.')}")
    print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
