"""Shared formatters — IST tz, durations, sizes, ISO-date prettifier.

The date prettifier mirrors `_emit-lifecycle.ps1`'s logic so a Python-side
caller (e.g. the bot's own messages) produces the same `Apr 13th [2026]`
form as a launcher-emitted message.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))


def now_ist() -> datetime:
    return datetime.now(IST)


def fmt_duration(seconds: float) -> str:
    s = max(0, int(seconds))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60}s"
    if s < 86400:
        return f"{s // 3600}h {(s % 3600) // 60}m"
    return f"{s // 86400}d {(s % 86400) // 3600}h"


def fmt_size(path: Path) -> str:
    if not path.exists():
        return "—"
    b = path.stat().st_size
    if b < 1024:
        return f"{b} B"
    if b < 1024 * 1024:
        return f"{b / 1024:.1f} KB"
    return f"{b / 1024 / 1024:.2f} MB"


_ISO_DATE_RE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _ordinal_suffix(n: int) -> str:
    if 11 <= n <= 13:
        return "th"
    return {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")


def prettify_dates(text: str) -> str:
    """Convert every YYYY-MM-DD in `text` to `Mon Nth [YYYY]`.

    Year is omitted when it matches the current calendar year. Identical
    behaviour to `_emit-lifecycle.ps1`'s _PrettyDate; tested cross-platform.
    """
    today_year = now_ist().year

    def _replace(m: re.Match[str]) -> str:
        try:
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            month = _MONTHS_SHORT[mo - 1]
            suf = _ordinal_suffix(d)
        except (ValueError, IndexError):
            return m.group(0)
        if y == today_year:
            return f"{month} {d}{suf}"
        return f"{month} {d}{suf} {y}"

    return _ISO_DATE_RE.sub(_replace, text)
