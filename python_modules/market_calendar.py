"""market_calendar.py -- NSE + MCX holiday calendar for the Lubas launcher.

Used by startup\\_scheduled-start.bat to skip the morning fan-out on
trading holidays. Pure stdlib so it works before any third-party deps
are installed.

T35 extension: ``partial_sessions`` block in ``market_holidays.json``
covers Muhurat Diwali sessions + exchange-mandated half-days. Callers
that compute lookahead targets must clamp the lookahead window at
``get_session_end_sec(date)`` rather than at the default 15:30 IST
close — otherwise targets near the abnormal close are computed against
post-session NULL/stale prices and corrupt the training labels.

CLI usage (intended for batch callers):
    python python_modules\\market_calendar.py
        -> exit 0 if today is a trading day
        -> exit 1 if today is a published holiday

Library usage:
    from market_calendar import is_market_holiday, get_session_end_sec
    if is_market_holiday():
        ...
    close_sec = get_session_end_sec(today, exchange="NSE")
"""

from __future__ import annotations

import datetime as _dt
import json
import sys
from pathlib import Path

_HOLIDAYS_JSON = Path(__file__).resolve().parent.parent / "config" / "market_holidays.json"

# IST seconds-since-midnight defaults for a normal trading day.
NSE_DEFAULT_END_SEC: int = 55800   # 15:30 IST
MCX_DEFAULT_END_SEC: int = 84600   # 23:30 IST (evening session close)


def _load_raw() -> dict:
    """Read + parse the holidays JSON, returning ``{}`` on missing/broken
    file. Fail-open mirrors ``_load_holidays()``: a corrupt edit
    shouldn't silently disable the guard.
    """
    try:
        return json.loads(_HOLIDAYS_JSON.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as e:
        sys.stderr.write(
            f"market_calendar: failed to parse {_HOLIDAYS_JSON}: {e}\n"
            f"  Treating as no holidays. Fix the JSON to re-enable the guard.\n"
        )
        return {}


def _load_holidays() -> set[str]:
    """Return the flat set of all YYYY-MM-DD strings across all years.

    Missing or malformed file -> empty set (fail-open: treat as trading day
    rather than risk skipping a legitimate market open). JSON parse errors
    are reported to stderr so a broken edit doesn't silently disable the
    holiday guard for weeks.
    """
    data = _load_raw()
    out: set[str] = set()
    for key, value in data.items():
        if key.startswith("_"):  # documentation keys
            continue
        if key == "partial_sessions":  # T35 — separate schema, not a holiday list
            continue
        if isinstance(value, list):
            out.update(str(d) for d in value)
    return out


def _load_partial_sessions() -> dict[str, dict]:
    """Return ``{"YYYY-MM-DD": {"session_end_sec": int, "reason": str}, ...}``.

    Schema example::

        "partial_sessions": {
          "2026-11-12": {
            "session_end_sec": 69300,
            "reason": "Muhurat Diwali NSE",
            "exchanges": ["NSE"]
          }
        }

    Missing block / wrong shape → empty dict. ``session_end_sec`` is
    required per entry; entries lacking it are skipped with a warning
    so a typo can't silently cause the wrong close time to be used.
    """
    data = _load_raw()
    raw = data.get("partial_sessions", {})
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict] = {}
    for date_str, entry in raw.items():
        if not isinstance(entry, dict):
            continue
        if "session_end_sec" not in entry:
            sys.stderr.write(
                f"market_calendar: partial_sessions[{date_str}] missing "
                f"'session_end_sec'; skipping.\n"
            )
            continue
        try:
            sec = int(entry["session_end_sec"])
        except (TypeError, ValueError):
            sys.stderr.write(
                f"market_calendar: partial_sessions[{date_str}] has non-int "
                f"session_end_sec ({entry['session_end_sec']!r}); skipping.\n"
            )
            continue
        if not (0 < sec < 86400):
            sys.stderr.write(
                f"market_calendar: partial_sessions[{date_str}] session_end_sec "
                f"out of range ({sec}); skipping.\n"
            )
            continue
        out[str(date_str)] = {
            "session_end_sec": sec,
            "reason": str(entry.get("reason", "")),
            "exchanges": [str(x) for x in entry.get("exchanges", [])],
        }
    return out


def is_market_holiday(today: _dt.date | None = None) -> bool:
    """True if `today` is in config/market_holidays.json's per-year arrays."""
    today = today or _dt.date.today()
    return today.isoformat() in _load_holidays()


def is_partial_session_day(today: _dt.date | None = None, *,
                           exchange: str | None = None) -> bool:
    """True if `today` is listed in ``partial_sessions``.

    When ``exchange`` is given (``"NSE"`` / ``"MCX"``), the entry's
    ``exchanges`` list must contain it; an entry with no ``exchanges``
    field is treated as applicable to all exchanges (the conservative
    default — better to clamp by accident than to label corrupt data
    silently).
    """
    today = today or _dt.date.today()
    entry = _load_partial_sessions().get(today.isoformat())
    if entry is None:
        return False
    if exchange is None or not entry["exchanges"]:
        return True
    return exchange in entry["exchanges"]


def get_session_end_sec(today: _dt.date | None = None, *,
                        exchange: str = "NSE") -> int:
    """Return the session-end time in seconds-since-midnight IST for ``today``.

    On a normal trading day or a date not in ``partial_sessions``, returns
    the per-exchange default (``NSE_DEFAULT_END_SEC`` = 15:30,
    ``MCX_DEFAULT_END_SEC`` = 23:30).

    On a partial-session day, returns the abnormal close from the JSON
    entry. If the entry has an ``exchanges`` list and ``exchange`` is
    NOT in it, returns the default (the abnormal close applies to a
    different exchange).

    Note: this function is silent about ``is_market_holiday`` — callers
    that want "is today a full trading day at all?" should check
    ``is_market_holiday`` first. Returning the default for holiday
    dates is intentional: callers that drop holidays earlier in the
    pipeline still get a sensible default if they ever bypass that
    check.
    """
    today = today or _dt.date.today()
    default = (
        MCX_DEFAULT_END_SEC if exchange.upper() == "MCX"
        else NSE_DEFAULT_END_SEC
    )
    entry = _load_partial_sessions().get(today.isoformat())
    if entry is None:
        return default
    # Entry exists. If it's exchange-scoped and this exchange isn't in
    # the list, fall back to the default.
    if entry["exchanges"] and exchange not in entry["exchanges"]:
        return default
    return entry["session_end_sec"]


def get_partial_session_reason(today: _dt.date | None = None) -> str | None:
    """Return the human-readable reason string for a partial-session day,
    or ``None`` if the date isn't a partial session. Useful for logging.
    """
    today = today or _dt.date.today()
    entry = _load_partial_sessions().get(today.isoformat())
    if entry is None:
        return None
    return entry["reason"] or None


if __name__ == "__main__":
    sys.exit(1 if is_market_holiday() else 0)
