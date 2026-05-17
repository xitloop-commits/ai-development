"""
event_calendar.py — C11 macro-event suppression features (spec §2.1.4 C11).

Reads a human-maintained calendar of tier-1/tier-2 macro events
(`config/event_calendar.json`) and emits 3 features so every gate can
suppress entries near scheduled volatility shocks (FOMC, RBI, CPI, NFP,
expiry days, budget, etc.).

Features (3 outputs):
    is_tier_2_event_day                Binary {0, 1}. 1 if today's IST date
                                       has at least one tier-1 OR tier-2
                                       event in the calendar. "tier_2" in
                                       the feature name is shorthand for
                                       "tier-2-or-higher" (matches spec C11).
    event_type_categorical             Integer code of TODAY's most recent
                                       (or upcoming-today) tier-1/2 event.
                                       Index into `event_types[]` in the
                                       JSON. 0 = "none" / no event today.
    hours_to_next_tier_1_or_2_event    Hours from now_ts until the next
                                       FUTURE tier-1/2 event (today or
                                       later). NaN if calendar is empty
                                       or has no future events.

Calendar JSON shape (see config/event_calendar.json):
    {
      "event_types": ["none", "fomc", "rbi_policy", ...],
      "events": [
        {"ts_ist": "<ISO-with-+05:30>", "type": "fomc", "tier": 1},
        ...
      ]
    }

Null rules:
    - No calendar / empty events  → both binary features 0, hours NaN.
    - now_ts missing / invalid    → all three NaN.
    - Unknown event_type string   → that event still counts for the binary
      gate but `event_type_categorical` falls back to 0 ("none") since the
      mapping is not stable.
"""

from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

_NAN = float("nan")
_IST = timezone(timedelta(hours=5, minutes=30))
_SECONDS_PER_HOUR = 3600.0


# ── Loader ────────────────────────────────────────────────────────────────


def load_event_calendar(path: str | Path) -> dict:
    """
    Load + minimally validate the event-calendar JSON.

    Returns a dict with two pre-parsed keys:
        - "event_types": list[str] (canonical type-index table)
        - "events_parsed": list[(ts_epoch_sec, type_str, tier_int)]
                           sorted ascending by ts_epoch_sec.

    Malformed entries are skipped silently (we don't want a single bad
    row to kill the recorder on the morning of an FOMC day).
    """
    p = Path(path)
    raw = json.loads(p.read_text(encoding="utf-8"))

    event_types = list(raw.get("event_types") or ["none"])
    if "none" not in event_types:
        event_types.insert(0, "none")

    parsed: list[tuple[float, str, int]] = []
    for row in raw.get("events") or []:
        if not isinstance(row, dict):
            continue
        ts_str = row.get("ts_ist")
        type_str = row.get("type")
        tier = row.get("tier")
        if not isinstance(ts_str, str) or not isinstance(type_str, str):
            continue
        if not isinstance(tier, int):
            continue
        try:
            dt = datetime.fromisoformat(ts_str)
        except ValueError:
            continue
        if dt.tzinfo is None:
            continue  # must be tz-aware so epoch is unambiguous
        parsed.append((dt.timestamp(), type_str, tier))

    parsed.sort(key=lambda x: x[0])
    return {"event_types": event_types, "events_parsed": parsed}


# ── Feature compute ───────────────────────────────────────────────────────


def _event_type_index(name: str, table: list[str]) -> int:
    """Return index in table, or 0 (none) when name is not registered."""
    try:
        return table.index(name)
    except ValueError:
        return 0


def _ist_date(now_ts: float) -> date:
    """IST calendar date of an epoch second."""
    return datetime.fromtimestamp(now_ts, tz=_IST).date()


def compute_event_calendar_features(
    now_ts: float | None,
    calendar: dict | None,
) -> dict[str, float]:
    """
    Compute the 3 C11 event-calendar features.

    Args:
        now_ts:   Current epoch second (UTC). NaN/None → all NaN.
        calendar: Pre-parsed calendar dict from `load_event_calendar()`,
                  or None / empty for "no calendar available".

    Returns:
        Dict with 3 float keys.
    """
    out: dict[str, float] = {
        "is_tier_2_event_day": _NAN,
        "event_type_categorical": _NAN,
        "hours_to_next_tier_1_or_2_event": _NAN,
    }

    if now_ts is None:
        return out
    try:
        now_v = float(now_ts)
    except (TypeError, ValueError):
        return out
    if not math.isfinite(now_v) or now_v <= 0:
        return out

    # Empty/missing calendar — emit zeros for the binary features (well-defined
    # "no event"), NaN for hours since no future event exists in the file.
    if not calendar:
        out["is_tier_2_event_day"] = 0.0
        out["event_type_categorical"] = 0.0
        return out

    events: list[tuple[float, str, int]] = calendar.get("events_parsed") or []
    types_table: list[str] = calendar.get("event_types") or ["none"]

    if not events:
        out["is_tier_2_event_day"] = 0.0
        out["event_type_categorical"] = 0.0
        return out

    today = _ist_date(now_v)

    # Scan once; collect what we need.
    today_event_type: str | None = None
    today_event_ts: float = -math.inf  # pick the latest event whose IST date is today
    next_future_ts: float | None = None

    for ts, type_str, tier in events:
        if tier not in (1, 2):
            continue
        if _ist_date(ts) == today and ts >= today_event_ts:
            today_event_type = type_str
            today_event_ts = ts
        if ts >= now_v and next_future_ts is None:
            next_future_ts = ts
        # `events` is sorted; once we have a future event AND we're past
        # today, we could break early — but the dataset is tiny so a
        # full scan is fine and keeps logic obvious.

    out["is_tier_2_event_day"] = 1.0 if today_event_type is not None else 0.0
    out["event_type_categorical"] = float(
        _event_type_index(today_event_type, types_table) if today_event_type else 0
    )
    if next_future_ts is not None:
        out["hours_to_next_tier_1_or_2_event"] = (next_future_ts - now_v) / _SECONDS_PER_HOUR

    return out
