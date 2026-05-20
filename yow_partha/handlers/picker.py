"""Train-model date-list picker.

Flow:
  1. User taps `▶ Start` on a train-<inst> row.
  2. Bot lists data-available dates (folders matching `YYYY-MM-DD` under
     `data/raw/<inst>/`), newest first, paginated 20 per page.
  3. User taps a date → that becomes from-date; list re-renders with
     dates < from-date greyed out.
  4. User taps a second date → confirmation message with both dates.
  5. Confirm → fires `train-model.bat <inst> <from> <to>`.

State lives entirely in `callback_data` (Telegram caps it at 64 bytes, so
schema is tight).
"""

from __future__ import annotations

import re
from pathlib import Path

from .._runners.targets import TARGETS

ROOT = Path(__file__).resolve().parent.parent.parent
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _reserved_dates(inst: str) -> set[str]:
    """Dates excluded from training/replay because they're held out for
    backtest. Imported lazily so a bad config in holdout_utils doesn't
    crash the bot at import time."""
    import sys as _sys
    pm = ROOT / "python_modules"
    if str(pm) not in _sys.path:
        _sys.path.insert(0, str(pm))
    try:
        from holdout_utils import resolve_holdout_dates
        return set(resolve_holdout_dates(
            features_root=ROOT / "data" / "features",
            raw_root=ROOT / "data" / "raw",
            instrument=inst,
        ))
    except Exception:
        return set()


def available_dates(inst: str) -> list[str]:
    """Trainable dates for this instrument.

    Mirrors the launcher's `scan_feature_days(inst)` exactly — looks under
    `data/features/<DATE>/<inst>_features.parquet`. Reserved (holdout)
    dates are excluded so the user can't accidentally train on them.
    """
    feat_root = ROOT / "data" / "features"
    if not feat_root.exists():
        return []
    reserved = _reserved_dates(inst)
    out: list[str] = []
    for p in feat_root.iterdir():
        if not (p.is_dir() and _DATE_RE.match(p.name)):
            continue
        if not (p / f"{inst}_features.parquet").exists():
            continue
        if p.name in reserved:
            continue
        out.append(p.name)
    return sorted(out)


def available_parquet_dates() -> list[dict]:
    """Per-date list of feature parquets that exist on disk.

    Returns: list of {"date": "YYYY-MM-DD", "insts": ["nifty50", ...]}.
    Newest first. Each row is what the Delete > Parquet picker shows.
    """
    feat_root = ROOT / "data" / "features"
    if not feat_root.exists():
        return []
    rows: list[dict] = []
    for p in feat_root.iterdir():
        if not (p.is_dir() and _DATE_RE.match(p.name)):
            continue
        insts: list[str] = []
        for inst in ("nifty50", "banknifty", "crudeoil", "naturalgas"):
            if (p / f"{inst}_features.parquet").exists():
                insts.append(inst)
        if insts:
            rows.append({"date": p.name, "insts": insts})
    rows.sort(key=lambda r: r["date"], reverse=True)
    return rows


def available_replay_dates(inst: str) -> list[str]:
    """Replay-able dates for this instrument.

    Conditions, all required:
      - raw recording exists      (`data/raw/<DATE>/<inst>*.ndjson.gz`)
      - parquet does NOT exist    (skip already-replayed dates)
      - date is not reserved      (holdout dates excluded)
    """
    raw_root = ROOT / "data" / "raw"
    feat_root = ROOT / "data" / "features"
    if not raw_root.exists():
        return []
    reserved = _reserved_dates(inst)
    out: list[str] = []
    for p in raw_root.iterdir():
        if not (p.is_dir() and _DATE_RE.match(p.name)):
            continue
        if not any(p.glob(f"{inst}*.ndjson.gz")):
            continue
        if (feat_root / p.name / f"{inst}_features.parquet").exists():
            continue
        if p.name in reserved:
            continue
        out.append(p.name)
    return sorted(out)


def render_confirm_train(tid: str, from_date: str, to_date: str) -> tuple[str, "InlineKeyboardMarkup"]:
    """Final confirmation before firing train-model.bat."""
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    t = TARGETS[tid]
    text = f"{t['noun']} — train on {from_date} to {to_date}?"
    buttons = [
        [
            InlineKeyboardButton("✓ Train", callback_data=f"do:train:{tid}:{from_date}:{to_date}"),
            InlineKeyboardButton("✗ Cancel", callback_data=f"target:{tid}"),
        ],
    ]
    return text, InlineKeyboardMarkup(buttons)
