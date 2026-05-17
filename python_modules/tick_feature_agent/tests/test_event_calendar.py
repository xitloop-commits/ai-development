"""Tests for features/event_calendar.py — C11 event-suppression features."""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from tick_feature_agent.features.event_calendar import (
    compute_event_calendar_features,
    load_event_calendar,
)


_IST = timezone(timedelta(hours=5, minutes=30))


def _ist_epoch(date_str: str, time_str: str = "10:00:00") -> float:
    """Convert an IST '2026-06-04' + 'HH:MM:SS' to epoch seconds."""
    return datetime.fromisoformat(f"{date_str}T{time_str}+05:30").timestamp()


def _calendar(events: list[tuple[float, str, int]]) -> dict:
    return {
        "event_types": [
            "none", "fomc", "rbi_policy", "india_cpi",
            "us_cpi", "us_nfp", "us_pce", "expiry_monthly",
        ],
        "events_parsed": sorted(events, key=lambda r: r[0]),
    }


# ── now_ts / calendar guards ──────────────────────────────────────────────


def test_none_now_ts_all_nan():
    out = compute_event_calendar_features(now_ts=None, calendar=_calendar([]))
    for k in ("is_tier_2_event_day", "event_type_categorical", "hours_to_next_tier_1_or_2_event"):
        assert math.isnan(out[k])


def test_invalid_now_ts_all_nan():
    out = compute_event_calendar_features(now_ts=float("nan"), calendar=_calendar([]))
    for k in ("is_tier_2_event_day", "event_type_categorical", "hours_to_next_tier_1_or_2_event"):
        assert math.isnan(out[k])


def test_none_calendar_yields_zero_binaries_and_nan_hours():
    out = compute_event_calendar_features(now_ts=_ist_epoch("2026-06-04"), calendar=None)
    assert out["is_tier_2_event_day"] == 0.0
    assert out["event_type_categorical"] == 0.0
    assert math.isnan(out["hours_to_next_tier_1_or_2_event"])


def test_empty_events_yields_zero_binaries_and_nan_hours():
    out = compute_event_calendar_features(
        now_ts=_ist_epoch("2026-06-04"), calendar=_calendar([]),
    )
    assert out["is_tier_2_event_day"] == 0.0
    assert out["event_type_categorical"] == 0.0
    assert math.isnan(out["hours_to_next_tier_1_or_2_event"])


# ── is_tier_2_event_day ───────────────────────────────────────────────────


def test_tier_1_event_today_flips_flag():
    today = _ist_epoch("2026-06-04", "13:00:00")
    cal = _calendar([(_ist_epoch("2026-06-04", "19:30:00"), "us_nfp", 1)])
    out = compute_event_calendar_features(now_ts=today, calendar=cal)
    assert out["is_tier_2_event_day"] == 1.0


def test_tier_2_event_today_flips_flag():
    today = _ist_epoch("2026-06-25", "10:00:00")
    cal = _calendar([(_ist_epoch("2026-06-25", "15:30:00"), "expiry_monthly", 2)])
    out = compute_event_calendar_features(now_ts=today, calendar=cal)
    assert out["is_tier_2_event_day"] == 1.0


def test_tier_3_event_today_does_not_flip_flag():
    """Tier 3+ is intentionally ignored — features only track 1/2."""
    today = _ist_epoch("2026-06-04", "13:00:00")
    cal = _calendar([(_ist_epoch("2026-06-04", "16:00:00"), "noise", 3)])
    out = compute_event_calendar_features(now_ts=today, calendar=cal)
    assert out["is_tier_2_event_day"] == 0.0
    assert out["event_type_categorical"] == 0.0


def test_event_on_different_date_does_not_flip_flag():
    today = _ist_epoch("2026-06-03", "13:00:00")
    cal = _calendar([(_ist_epoch("2026-06-04", "19:30:00"), "us_nfp", 1)])
    out = compute_event_calendar_features(now_ts=today, calendar=cal)
    assert out["is_tier_2_event_day"] == 0.0


# ── event_type_categorical ────────────────────────────────────────────────


def test_event_type_categorical_maps_to_table_index():
    today = _ist_epoch("2026-06-04", "13:00:00")
    cal = _calendar([(_ist_epoch("2026-06-04", "19:30:00"), "us_nfp", 1)])
    # In _calendar table, "us_nfp" is at index 5.
    out = compute_event_calendar_features(now_ts=today, calendar=cal)
    assert out["event_type_categorical"] == 5.0


def test_event_type_categorical_zero_when_no_event_today():
    today = _ist_epoch("2026-06-03", "13:00:00")
    cal = _calendar([(_ist_epoch("2026-06-04", "19:30:00"), "us_nfp", 1)])
    out = compute_event_calendar_features(now_ts=today, calendar=cal)
    assert out["event_type_categorical"] == 0.0


def test_unknown_event_type_falls_back_to_zero_but_flag_still_set():
    today = _ist_epoch("2026-06-04", "13:00:00")
    cal = _calendar([(_ist_epoch("2026-06-04", "19:30:00"), "mystery_event", 1)])
    out = compute_event_calendar_features(now_ts=today, calendar=cal)
    assert out["is_tier_2_event_day"] == 1.0
    assert out["event_type_categorical"] == 0.0


def test_latest_today_event_wins_when_multiple_on_same_day():
    """When two tier-1/2 events fall on the same IST date, we report the LATER one."""
    today = _ist_epoch("2026-06-04", "08:00:00")  # before both events
    cal = _calendar([
        (_ist_epoch("2026-06-04", "11:00:00"), "rbi_policy", 1),
        (_ist_epoch("2026-06-04", "19:30:00"), "us_nfp", 1),
    ])
    out = compute_event_calendar_features(now_ts=today, calendar=cal)
    # In _calendar table, "us_nfp" is at index 5, "rbi_policy" is at 2.
    assert out["event_type_categorical"] == 5.0


# ── hours_to_next_tier_1_or_2_event ───────────────────────────────────────


def test_hours_to_next_event_same_day():
    now = _ist_epoch("2026-06-04", "13:00:00")
    cal = _calendar([(_ist_epoch("2026-06-04", "19:30:00"), "us_nfp", 1)])
    out = compute_event_calendar_features(now_ts=now, calendar=cal)
    assert out["hours_to_next_tier_1_or_2_event"] == pytest.approx(6.5)


def test_hours_to_next_event_zero_at_event_moment():
    moment = _ist_epoch("2026-06-04", "19:30:00")
    cal = _calendar([(moment, "us_nfp", 1)])
    out = compute_event_calendar_features(now_ts=moment, calendar=cal)
    assert out["hours_to_next_tier_1_or_2_event"] == pytest.approx(0.0)


def test_past_event_not_counted_as_next():
    """Once an event is in the past, find the NEXT future one."""
    now = _ist_epoch("2026-06-04", "20:00:00")  # 30 min after NFP
    cal = _calendar([
        (_ist_epoch("2026-06-04", "19:30:00"), "us_nfp", 1),
        (_ist_epoch("2026-06-12", "18:00:00"), "india_cpi", 1),
    ])
    out = compute_event_calendar_features(now_ts=now, calendar=cal)
    # 8 days minus 2 hours = 8*24 - 2 = 190 hrs
    assert out["hours_to_next_tier_1_or_2_event"] == pytest.approx(190.0)


def test_no_future_events_yields_nan_hours():
    now = _ist_epoch("2026-12-31", "10:00:00")
    cal = _calendar([(_ist_epoch("2026-06-04", "19:30:00"), "us_nfp", 1)])
    out = compute_event_calendar_features(now_ts=now, calendar=cal)
    assert math.isnan(out["hours_to_next_tier_1_or_2_event"])


def test_tier_3_events_excluded_from_hours():
    now = _ist_epoch("2026-06-04", "10:00:00")
    cal = _calendar([
        (_ist_epoch("2026-06-04", "11:00:00"), "noise", 3),       # ignored
        (_ist_epoch("2026-06-12", "18:00:00"), "india_cpi", 1),   # counted
    ])
    out = compute_event_calendar_features(now_ts=now, calendar=cal)
    # ~8 days, 8h hrs
    assert out["hours_to_next_tier_1_or_2_event"] == pytest.approx(8 * 24 + 8.0)


# ── Loader ────────────────────────────────────────────────────────────────


def test_load_event_calendar_parses_iso_with_tz(tmp_path: Path):
    p = tmp_path / "cal.json"
    p.write_text(json.dumps({
        "event_types": ["none", "fomc", "us_nfp"],
        "events": [
            {"ts_ist": "2026-06-04T19:30:00+05:30", "type": "us_nfp", "tier": 1},
            {"ts_ist": "2026-06-18T23:30:00+05:30", "type": "fomc", "tier": 1},
        ],
    }))
    cal = load_event_calendar(p)
    assert cal["event_types"] == ["none", "fomc", "us_nfp"]
    assert len(cal["events_parsed"]) == 2
    # Sorted ascending
    assert cal["events_parsed"][0][0] < cal["events_parsed"][1][0]
    assert cal["events_parsed"][0][1] == "us_nfp"
    assert cal["events_parsed"][0][2] == 1


def test_load_event_calendar_skips_malformed_rows(tmp_path: Path):
    p = tmp_path / "cal.json"
    p.write_text(json.dumps({
        "event_types": ["none", "fomc"],
        "events": [
            {"ts_ist": "2026-06-04T19:30:00+05:30", "type": "fomc", "tier": 1},
            {"ts_ist": "not-a-timestamp", "type": "fomc", "tier": 1},   # bad ts
            {"ts_ist": "2026-06-05T10:00:00", "type": "fomc", "tier": 1},  # no tz
            {"ts_ist": "2026-06-06T10:00:00+05:30", "type": "fomc"},     # no tier
            "string-not-dict",
        ],
    }))
    cal = load_event_calendar(p)
    # Only the first row should survive.
    assert len(cal["events_parsed"]) == 1


def test_load_event_calendar_injects_none_into_types(tmp_path: Path):
    p = tmp_path / "cal.json"
    p.write_text(json.dumps({
        "event_types": ["fomc", "us_nfp"],
        "events": [],
    }))
    cal = load_event_calendar(p)
    assert cal["event_types"][0] == "none"


def test_real_stub_calendar_loads(tmp_path: Path):
    """Sanity-check that the shipped config/event_calendar.json parses."""
    repo_cfg = Path(__file__).resolve().parents[3] / "config" / "event_calendar.json"
    if not repo_cfg.exists():
        pytest.skip("repo stub not present in this environment")
    cal = load_event_calendar(repo_cfg)
    assert "events_parsed" in cal
    assert "event_types" in cal
    assert cal["event_types"][0] == "none"
