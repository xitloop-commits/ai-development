"""Status-table renderer + inline-keyboard builders.

Single source of truth for the bot's visual surface. Every screen the
user sees comes through one of these functions.
"""

from __future__ import annotations

from telegram import InlineKeyboardButton, InlineKeyboardMarkup

from ._runners.targets import INSTRUMENTS, TARGETS
from ._status import status_for

# ── Home menu (grouped, mirrors the launcher) ────────────────────────────
#
# Each home row drills into either a per-target action screen (api, delete,
# shutdown) or a group submenu (record/replay/train/tools). Order matches
# the launcher's `act_*` items minus the entries that don't make sense on
# the phone (Restart launcher, yow-partha).

_HOME_MENU: list[tuple[str, str, str | None]] = [
    ("API Server",  "target:api",           "api"),
    ("Record",      "group:record",         None),
    ("Replay",      "group:replay",         None),
    ("Train",       "group:train",          None),
    ("Backtest",    "placeholder:backtest", None),
    ("Compare",     "placeholder:compare",  None),
    ("SEA",         "placeholder:sea",      None),
    ("Watch",       "placeholder:watch",    None),
    ("Tools",       "group:tools",          None),
    ("Delete data", "target:delete",        None),
    ("Shutdown",    "target:shutdown",      None),
]


# Non-breaking space — used to pad inline buttons to equal width.
_NBSP = " "


# Per-kind glyph used on group rows so the home menu still has a visual
# cue without claiming to summarise per-instrument state.
_KIND_GLYPH = {
    "record": "📼",
    "replay": "🎞",
    "train": "🧠",
    "tools": "🛠",
    "delete": "🗑",
    "shutdown": "🔌",
    "placeholder": "⏳",
}


def _pad_buttons_for_uniform_width(rows: list[tuple[str, str]]) -> list[list[InlineKeyboardButton]]:
    """Pad every label to the same width with trailing non-breaking spaces
    so Telegram's centered inline-button text aligns visually at the same
    horizontal extent across all rows."""
    max_len = max((len(lbl) for lbl, _ in rows), default=0)
    return [
        [InlineKeyboardButton(lbl + _NBSP * (max_len - len(lbl)), callback_data=cb)]
        for lbl, cb in rows
    ]


def render_home() -> tuple[str, InlineKeyboardMarkup]:
    """Launcher-style main menu. Each row drills into either a per-target
    action screen or a group submenu — mirrors the desktop launcher."""
    raw: list[tuple[str, str]] = []
    for label, cb, target_id in _HOME_MENU:
        if target_id == "api":
            st = status_for("api")
            raw.append((f"{st['icon']} {label}", cb))
        else:
            kind = cb.split(":", 1)[1] if ":" in cb else ""
            if kind in ("backtest", "compare", "sea", "watch"):
                glyph = _KIND_GLYPH["placeholder"]
            elif kind == "delete":
                glyph = _KIND_GLYPH["delete"]
            elif kind == "shutdown":
                glyph = _KIND_GLYPH["shutdown"]
            else:
                glyph = _KIND_GLYPH.get(kind, "•")
            raw.append((f"{glyph} {label}", cb))
    return "🤖 yow-partha — main menu", InlineKeyboardMarkup(_pad_buttons_for_uniform_width(raw))


def render_group(kind: str) -> tuple[str, InlineKeyboardMarkup]:
    """Submenu for Record / Replay / Train.

    - Record (TFA recorders): per-instrument list. Only one recorder per
      instrument is meaningful, so the launcher-style 4-row layout fits.
    - Replay / Train: per-PROCESS list. Many concurrent instances can run
      (one replay per date), so each running process is its own row with
      a single-tap stop. A `▶ Start new` row at the top opens the per-
      instrument picker for spawning a fresh one.
    """
    if kind == "record":
        return _render_per_instrument("Record", "tfa")
    if kind in ("replay", "train"):
        return _render_running_processes(kind)
    return f"Unknown group: {kind}", home_button_only()


def _render_per_instrument(title: str, prefix: str) -> tuple[str, InlineKeyboardMarkup]:
    raw: list[tuple[str, str]] = []
    for inst in INSTRUMENTS:
        tid = f"{prefix}-{inst}"
        st = status_for(tid)
        progress = f"  {st['progress']}" if st.get("progress") else ""
        raw.append((f"{st['icon']} {st['noun']}{progress}", f"target:{tid}"))
    rows = _pad_buttons_for_uniform_width(raw)
    rows.append([InlineKeyboardButton("🏠 Home", callback_data="home")])
    return f"{title} — pick an instrument", InlineKeyboardMarkup(rows)


def _render_running_processes(kind: str) -> tuple[str, InlineKeyboardMarkup]:
    from ._status import list_running
    title = "Replay" if kind == "replay" else "Train"
    running = list_running(kind)
    raw: list[tuple[str, str]] = []
    # "Start new" row at the top — opens the per-instrument picker.
    raw.append((f"➕ Start new {kind}", f"new:{kind}"))
    if running:
        for p in running:
            raw.append((f"🟢 {p['label']}", f"pidstop:{p['pid']}"))
    rows = _pad_buttons_for_uniform_width(raw)
    if not running:
        info = f"{title} — no processes currently running.\nTap above to start one."
    else:
        info = f"{title} — {len(running)} running. Tap any row to stop that one."
    rows.append([InlineKeyboardButton("🏠 Home", callback_data="home")])
    return info, InlineKeyboardMarkup(rows)


def render_new_picker(kind: str) -> tuple[str, InlineKeyboardMarkup]:
    """Instrument picker for starting a fresh replay / train. Re-uses
    the launcher-style 4-row layout."""
    title = "Start new replay" if kind == "replay" else "Start new training"
    prefix = "replay" if kind == "replay" else "train"
    raw: list[tuple[str, str]] = []
    for inst in INSTRUMENTS:
        tid = f"{prefix}-{inst}"
        st = status_for(tid)
        raw.append((f"{st['icon']} {st['noun']}", f"target:{tid}"))
    rows = _pad_buttons_for_uniform_width(raw)
    rows.append([InlineKeyboardButton(f"🏠 Back to {prefix.title()}", callback_data=f"group:{prefix}")])
    return title, InlineKeyboardMarkup(rows)


def render_tools() -> tuple[str, InlineKeyboardMarkup]:
    """Tools submenu — refresh-token + file-sizes (skipping the desktop-only
    creds-info and replay-checkpoint entries from the launcher)."""
    rows: list[list[InlineKeyboardButton]] = [
        [InlineKeyboardButton("🔄 Refresh Dhan token", callback_data="tool:refresh_token")],
        [InlineKeyboardButton("📊 Today's raw file sizes", callback_data="tool:file_sizes")],
        [InlineKeyboardButton("🏠 Home", callback_data="home")],
    ]
    return "Tools", InlineKeyboardMarkup(rows)


def render_placeholder(kind: str) -> tuple[str, InlineKeyboardMarkup]:
    """`Coming in v0.2` placeholder for Backtest / Compare / SEA / Watch."""
    label_map = {
        "backtest": "Backtest",
        "compare":  "Compare",
        "sea":      "SEA (signal engines)",
        "watch":    "Watch (live dashboards)",
    }
    label = label_map.get(kind, kind)
    text = (f"{label} — coming in v0.2.\n"
            f"Use the desktop launcher for now.")
    return text, home_button_only()


# ── Per-target sub-screen ────────────────────────────────────────────────

def render_target(tid: str) -> tuple[str, InlineKeyboardMarkup]:
    t = TARGETS[tid]
    st = status_for(tid)
    running = st["running"]

    if t["kind"] in ("backtest", "compare"):
        # One-shot run buttons (parked targets — kept for future).
        text = f"{t['noun']}\n\nReady to run."
        buttons = [
            [InlineKeyboardButton("▶ Run", callback_data=f"run:{tid}")],
            [InlineKeyboardButton("🏠 Home", callback_data="home")],
        ]
        return text, InlineKeyboardMarkup(buttons)

    if t["kind"] == "delete":
        text = "Delete data — pick what to remove (each tap asks for confirmation):"
        buttons = [
            [InlineKeyboardButton("🗑 Raw ticks", callback_data="delete:raw")],
            [InlineKeyboardButton("🗑 Parquet features", callback_data="delete:parquet")],
            [InlineKeyboardButton("🗑 Live NDJSON", callback_data="delete:live")],
            [InlineKeyboardButton("🗑 Trained models", callback_data="delete:models")],
            [InlineKeyboardButton("🏠 Home", callback_data="home")],
        ]
        return text, InlineKeyboardMarkup(buttons)

    if t["kind"] == "shutdown":
        # Smart shutdown gate: list any running managed processes first.
        # Only when nothing is running do we go straight to the 2-tap
        # confirmation. If something IS running, the user must consciously
        # choose `Stop all and shutdown` so a replay/training isn't nuked
        # by accident.
        from ._status import list_all_managed_running
        running = list_all_managed_running()
        if not running:
            text = "Nothing is currently running.\nShut down the whole computer?"
            buttons = [
                [InlineKeyboardButton("✓ Yes, shut down", callback_data="shutdown:confirm1")],
                [InlineKeyboardButton("✗ Cancel", callback_data="home")],
            ]
            return text, InlineKeyboardMarkup(buttons)
        # Running processes — surface them so user knows what would die.
        lines = ["⚠️ Still running — shutdown would kill these:"]
        for r in running:
            lines.append(f"🟢 {r['label']}")
        text = "\n".join(lines)
        buttons = [
            [InlineKeyboardButton("⏹ Stop all and shut down", callback_data="shutdown:force_with_running")],
            [InlineKeyboardButton("✗ Cancel — return home", callback_data="home")],
        ]
        return text, InlineKeyboardMarkup(buttons)

    # Standard start/stop/restart targets
    state_word = "running" if running else "stopped"
    text = f"{st['icon']} {t['noun']} — {state_word}"
    if st.get("progress"):
        text += f" ({st['progress']})"

    btns: list[list[InlineKeyboardButton]] = []
    if running:
        btns.append([
            InlineKeyboardButton("⏹ Stop", callback_data=f"stop:{tid}"),
            InlineKeyboardButton("↻ Restart", callback_data=f"restart:{tid}"),
        ])
    else:
        btns.append([InlineKeyboardButton("▶ Start", callback_data=f"start:{tid}")])
    btns.append([
        InlineKeyboardButton("👀 See logs", callback_data=f"logs:{tid}"),
        InlineKeyboardButton("🏠 Home", callback_data="home"),
    ])
    return text, InlineKeyboardMarkup(btns)


# ── Confirmation prompts ────────────────────────────────────────────────

def render_confirm(action: str, tid: str) -> tuple[str, InlineKeyboardMarkup]:
    t = TARGETS[tid]
    text = f"About to {action} {t['noun']}.\n\nConfirm?"
    buttons = [
        [
            InlineKeyboardButton(f"✓ Yes, {action}", callback_data=f"do:{action}:{tid}"),
            InlineKeyboardButton("✗ Cancel", callback_data=f"target:{tid}"),
        ],
    ]
    return text, InlineKeyboardMarkup(buttons)


def render_shutdown_confirm2() -> tuple[str, InlineKeyboardMarkup]:
    text = ("This will kill all running processes and power off the machine in 60s.\n"
            "Confirm again to fire.")
    buttons = [
        [
            InlineKeyboardButton("✓ Confirm shutdown", callback_data="shutdown:confirm2"),
            InlineKeyboardButton("✗ Cancel", callback_data="home"),
        ],
    ]
    return text, InlineKeyboardMarkup(buttons)


def render_delete_confirm(kind: str) -> tuple[str, InlineKeyboardMarkup]:
    text = f"About to delete {kind}. This is irreversible — confirm?"
    buttons = [
        [
            InlineKeyboardButton(f"✓ Yes, delete {kind}", callback_data=f"do:delete:{kind}"),
            InlineKeyboardButton("✗ Cancel", callback_data="target:delete"),
        ],
    ]
    return text, InlineKeyboardMarkup(buttons)


def render_delete_parquet_picker(rows: list[dict], selected: set[str]) -> tuple[str, InlineKeyboardMarkup]:
    """Multi-select picker for `Delete > Parquet features`. Each row is a
    date; the date label also shows which instruments have parquet on
    that day so the user can see what would actually be removed."""
    n = len(selected)
    title = f"Delete parquet features — tap dates to select ({n}/{len(rows)})"
    raw: list[tuple[str, str]] = []
    for r in rows:
        d = r["date"]
        mark = "☑" if d in selected else "☐"
        inst_initials = ",".join(_inst_initial(i) for i in r["insts"])
        raw.append((f"{mark} {d}  [{inst_initials}]", f"delpdt:{d}"))
    kb_rows = _pad_buttons_for_uniform_width(raw)
    confirm_label = f"✓ Confirm delete ({n})" if n else "✓ Confirm (pick at least one)"
    kb_rows.append([
        InlineKeyboardButton(confirm_label, callback_data=("delpconf" if n else "noop")),
        InlineKeyboardButton("✗ Cancel", callback_data="target:delete"),
    ])
    return title, InlineKeyboardMarkup(kb_rows)


def render_delete_parquet_confirm(dates: list[str]) -> tuple[str, InlineKeyboardMarkup]:
    """Final confirmation before nuking the selected parquet date folders."""
    n = len(dates)
    sample = ", ".join(dates[:5]) + (f" … (+{n-5})" if n > 5 else "")
    text = (f"About to delete parquet features for {n} date(s):\n"
            f"{sample}\n\n"
            "This is irreversible. Confirm?")
    buttons = [
        [
            InlineKeyboardButton(f"✓ Yes, delete {n} date(s)", callback_data="do:delpdates"),
            InlineKeyboardButton("✗ Cancel", callback_data="target:delete"),
        ],
    ]
    return text, InlineKeyboardMarkup(buttons)


def _inst_initial(inst: str) -> str:
    return {"nifty50": "N", "banknifty": "BN", "crudeoil": "C", "naturalgas": "G"}.get(inst, inst[:2].upper())


# ── Multi-select date picker for train-model ─────────────────────────────

def render_train_picker(tid: str, dates: list[str], selected: set[str]) -> tuple[str, InlineKeyboardMarkup]:
    """Multi-select date picker — matches the desktop launcher's pattern.

    Each date is a toggle row (☐ unchecked / ☑ checked). The user taps to
    flip, then taps the bottom Confirm button to fire training on every
    checked date. Selection state lives in `context.user_data` between
    taps (see callbacks.py).
    """
    t = TARGETS[tid]
    n = len(selected)
    text = (f"{t['noun']} — tap dates to select for training\n"
            f"({n} selected of {len(dates)} available)")

    rows: list[list[InlineKeyboardButton]] = []
    for d in dates:
        mark = "☑" if d in selected else "☐"
        rows.append([InlineKeyboardButton(f"{mark} {d}", callback_data=f"tog:{tid}:{d}")])

    confirm_label = f"✓ Confirm ({n} selected)" if n else "✓ Confirm (pick at least one)"
    rows.append([
        InlineKeyboardButton(confirm_label, callback_data=(f"tconf:{tid}" if n else "noop")),
        InlineKeyboardButton("✗ Cancel", callback_data="home"),
    ])
    return text, InlineKeyboardMarkup(rows)


# ── Plain reply (no buttons) ─────────────────────────────────────────────

def home_button_only() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("🏠 Home", callback_data="home")]])
