"""market_calendar.py -- NSE + MCX holiday calendar for the ATS launcher.

Used by startup\\_scheduled-start.bat to skip the morning fan-out on
trading holidays. Pure stdlib so it works before any third-party deps
are installed.

CLI usage (intended for batch callers):
    python python_modules\\market_calendar.py
        -> exit 0 if today is a trading day
        -> exit 1 if today is a published holiday

Library usage:
    from market_calendar import is_market_holiday
    if is_market_holiday():
        ...
"""

from __future__ import annotations

import datetime as _dt
import json
import sys
from pathlib import Path

_HOLIDAYS_JSON = Path(__file__).resolve().parent.parent / "config" / "market_holidays.json"


def _load_holidays() -> set[str]:
    """Return the flat set of all YYYY-MM-DD strings across all years.

    Missing or malformed file -> empty set (fail-open: treat as trading day
    rather than risk skipping a legitimate market open). JSON parse errors
    are reported to stderr so a broken edit doesn't silently disable the
    holiday guard for weeks.
    """
    try:
        data = json.loads(_HOLIDAYS_JSON.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return set()
    except json.JSONDecodeError as e:
        sys.stderr.write(
            f"market_calendar: failed to parse {_HOLIDAYS_JSON}: {e}\n"
            f"  Treating as no holidays. Fix the JSON to re-enable the guard.\n"
        )
        return set()
    out: set[str] = set()
    for key, value in data.items():
        if key.startswith("_"):  # documentation keys
            continue
        if isinstance(value, list):
            out.update(str(d) for d in value)
    return out


def is_market_holiday(today: _dt.date | None = None) -> bool:
    """True if `today` is in config/market_holidays.json."""
    today = today or _dt.date.today()
    return today.isoformat() in _load_holidays()


if __name__ == "__main__":
    sys.exit(1 if is_market_holiday() else 0)
