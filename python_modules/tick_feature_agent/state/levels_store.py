"""
levels_store.py — Per-instrument cross-day H/L persistence (task 2c-21).

A session-close writer hook persists each session's high/low to a per-
instrument JSON file so the *next* session's cross-day features
(``compute_cross_day_level_features`` in ``features/levels.py``) can read
prev-day H/L and the 5-day swing window.

State file shape (pretty-printed JSON for git-friendly diffs)::

    {
      "prev_day_high": 24380.5,
      "prev_day_low":  24105.2,
      "swing_5d_high": 24500.0,
      "swing_5d_low":  23980.0,
      "history": [
        {"date": "2026-05-13", "high": 24210.1, "low": 24005.0},
        {"date": "2026-05-14", "high": 24380.5, "low": 24105.2},
        ...up to 5 entries...
      ]
    }

Design rules:
    - All I/O is stdlib only (``json``, ``pathlib``, ``os``).
    - ``load()`` NEVER raises on a missing or malformed file — it returns
      an empty ``CrossDayLevels`` instead. Same posture as
      ``features/event_calendar.py``: a bad row should never kill the
      recorder on the morning of an FOMC day.
    - ``save()`` is atomic: write to ``<path>.tmp`` then ``os.replace()``.
    - ``update()`` is pure (returns a NEW state, never mutates the input).
    - ``update()`` is idempotent on re-call with the same ``session_date``:
      the existing entry is replaced, not duplicated.
    - Non-finite / None / non-positive H or L → ``update()`` returns the
      input state unchanged (silent skip — caller logs).

Session date format: ISO ``"YYYY-MM-DD"`` (e.g. ``"2026-05-17"``).
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

_SWING_WINDOW_DAYS = 5


@dataclass
class CrossDayLevels:
    """In-memory cross-day H/L state for a single instrument."""

    prev_day_high: float | None = None
    prev_day_low: float | None = None
    swing_5d_high: float | None = None
    swing_5d_low: float | None = None
    # history: [{"date": "YYYY-MM-DD", "high": float, "low": float}, ...]
    # Sorted ascending by date, capped at _SWING_WINDOW_DAYS entries.
    history: list[dict] = field(default_factory=list)


# ── Internal helpers ─────────────────────────────────────────────────────────


def _safe_pos(v) -> float | None:
    """Return float(v) iff finite and > 0; else None. Mirrors features/levels.py."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0:
        return None
    return f


def _safe_float_or_none(v) -> float | None:
    """Return float(v) iff finite; else None (preserves 0 and negatives)."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return f


def _coerce_history(raw) -> list[dict]:
    """
    Validate a history list loaded from JSON. Drop malformed rows silently
    (log-and-continue posture). Sort ascending by date and cap at the
    swing window length.
    """
    if not isinstance(raw, list):
        return []
    clean: list[dict] = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        date_str = row.get("date")
        if not isinstance(date_str, str) or not date_str:
            continue
        high = _safe_pos(row.get("high"))
        low = _safe_pos(row.get("low"))
        if high is None or low is None:
            continue
        clean.append({"date": date_str, "high": high, "low": low})
    clean.sort(key=lambda r: r["date"])
    if len(clean) > _SWING_WINDOW_DAYS:
        clean = clean[-_SWING_WINDOW_DAYS:]
    return clean


# ── Public API ───────────────────────────────────────────────────────────────


def load(path: str | Path) -> CrossDayLevels:
    """
    Read the JSON. If the file doesn't exist or is malformed, return an
    empty ``CrossDayLevels`` (never crash).
    """
    p = Path(path)
    if not p.exists():
        return CrossDayLevels()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return CrossDayLevels()
    if not isinstance(raw, dict):
        return CrossDayLevels()

    return CrossDayLevels(
        prev_day_high=_safe_pos(raw.get("prev_day_high")),
        prev_day_low=_safe_pos(raw.get("prev_day_low")),
        swing_5d_high=_safe_pos(raw.get("swing_5d_high")),
        swing_5d_low=_safe_pos(raw.get("swing_5d_low")),
        history=_coerce_history(raw.get("history")),
    )


def update(
    state: CrossDayLevels,
    session_date: str,
    session_high: float | None,
    session_low: float | None,
) -> CrossDayLevels:
    """
    Return a NEW ``CrossDayLevels`` reflecting close-of-day state.

    Rules:
        - ``prev_day_high`` / ``prev_day_low`` become the high/low just observed.
        - Today's ``{date, high, low}`` is appended to history.
        - If ``session_date`` already exists in history, the existing entry is
          REPLACED (idempotent on re-call, no duplicates).
        - History is sorted by date ascending and trimmed to the last 5 days.
        - ``swing_5d_high`` / ``swing_5d_low`` = max / min over the new history.
        - If ``session_high`` or ``session_low`` is non-finite, None, or ≤ 0,
          the state is returned UNCHANGED (silent skip; caller logs).
        - Same posture if ``session_date`` is not a non-empty string.
    """
    if not isinstance(session_date, str) or not session_date:
        return state
    hi = _safe_pos(session_high)
    lo = _safe_pos(session_low)
    if hi is None or lo is None:
        return state

    # Replace-or-insert today's entry.
    new_history = [row for row in state.history if row.get("date") != session_date]
    new_history.append({"date": session_date, "high": hi, "low": lo})
    new_history.sort(key=lambda r: r["date"])
    if len(new_history) > _SWING_WINDOW_DAYS:
        new_history = new_history[-_SWING_WINDOW_DAYS:]

    swing_high = max(row["high"] for row in new_history)
    swing_low = min(row["low"] for row in new_history)

    return CrossDayLevels(
        prev_day_high=hi,
        prev_day_low=lo,
        swing_5d_high=swing_high,
        swing_5d_low=swing_low,
        history=new_history,
    )


def save(state: CrossDayLevels, path: str | Path) -> None:
    """
    Atomic write — serialise to ``<path>.tmp`` then ``os.replace()`` into
    place so a partial write can never leave a corrupt file on disk.
    Pretty-printed JSON keeps git diffs human-readable.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp") if p.suffix else p.with_name(p.name + ".tmp")
    payload = asdict(state)
    tmp.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, p)
