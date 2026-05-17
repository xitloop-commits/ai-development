"""Tests for features/intraday_time.py — C6 intraday-timing features."""

from __future__ import annotations

import math
from datetime import datetime

import pytest

from tick_feature_agent.features.intraday_time import compute_intraday_time_features


# ── Helpers ───────────────────────────────────────────────────────────────


def _ist_ts(iso: str) -> float:
    """Convert an ISO string (must include +05:30 offset) to epoch seconds."""
    return datetime.fromisoformat(iso).timestamp()


# Standard NSE session anchors used across happy-path tests.
SESSION_OPEN = _ist_ts("2026-06-04T09:15:00+05:30")
SESSION_CLOSE = _ist_ts("2026-06-04T15:30:00+05:30")


# ── All-None inputs ───────────────────────────────────────────────────────


def test_all_none_inputs_yield_all_nan():
    out = compute_intraday_time_features(
        now_ts=None, session_open_ts=None, session_close_ts=None,
    )
    assert math.isnan(out["minutes_from_open"])
    assert math.isnan(out["minutes_to_close"])
    assert math.isnan(out["lunch_session_flag"])


# ── Happy path ────────────────────────────────────────────────────────────


def test_happy_path_10am_tick():
    """09:15 open, 15:30 close, tick at 10:00 IST.
    → 45 min from open, 330 min to close, lunch=0."""
    now = _ist_ts("2026-06-04T10:00:00+05:30")
    out = compute_intraday_time_features(
        now_ts=now,
        session_open_ts=SESSION_OPEN,
        session_close_ts=SESSION_CLOSE,
    )
    assert out["minutes_from_open"] == pytest.approx(45.0)
    assert out["minutes_to_close"] == pytest.approx(330.0)
    assert out["lunch_session_flag"] == 0.0


# ── Lunch flag ────────────────────────────────────────────────────────────


def test_lunch_flag_set_at_12_30_ist():
    now = _ist_ts("2026-06-04T12:30:00+05:30")
    out = compute_intraday_time_features(
        now_ts=now,
        session_open_ts=SESSION_OPEN,
        session_close_ts=SESSION_CLOSE,
    )
    assert out["lunch_session_flag"] == 1.0


def test_lunch_flag_clear_just_before_noon():
    """11:59:59 IST is still in the 11-hour bucket — flag must be 0."""
    now = _ist_ts("2026-06-04T11:59:59+05:30")
    out = compute_intraday_time_features(
        now_ts=now,
        session_open_ts=SESSION_OPEN,
        session_close_ts=SESSION_CLOSE,
    )
    assert out["lunch_session_flag"] == 0.0


def test_lunch_flag_clear_at_13_00_boundary():
    """13:00:00 IST is in the 13-hour bucket — flag must be 0 (closed
    upper bound at 13:00)."""
    now = _ist_ts("2026-06-04T13:00:00+05:30")
    out = compute_intraday_time_features(
        now_ts=now,
        session_open_ts=SESSION_OPEN,
        session_close_ts=SESSION_CLOSE,
    )
    assert out["lunch_session_flag"] == 0.0


def test_lunch_flag_set_at_12_00_boundary():
    """12:00:00 IST is the start of the lunch window — flag must be 1."""
    now = _ist_ts("2026-06-04T12:00:00+05:30")
    out = compute_intraday_time_features(
        now_ts=now,
        session_open_ts=SESSION_OPEN,
        session_close_ts=SESSION_CLOSE,
    )
    assert out["lunch_session_flag"] == 1.0


# ── Clamping ──────────────────────────────────────────────────────────────


def test_minutes_from_open_clamps_premarket_to_zero():
    """Tick at 09:00 IST, session opens 09:15 — minutes_from_open clamps to 0."""
    now = _ist_ts("2026-06-04T09:00:00+05:30")
    out = compute_intraday_time_features(
        now_ts=now,
        session_open_ts=SESSION_OPEN,
        session_close_ts=SESSION_CLOSE,
    )
    assert out["minutes_from_open"] == 0.0
    # minutes_to_close still meaningful (positive)
    assert out["minutes_to_close"] == pytest.approx(390.0)


def test_minutes_to_close_clamps_postclose_to_zero():
    """Tick at 16:00 IST, session closes 15:30 — minutes_to_close clamps to 0."""
    now = _ist_ts("2026-06-04T16:00:00+05:30")
    out = compute_intraday_time_features(
        now_ts=now,
        session_open_ts=SESSION_OPEN,
        session_close_ts=SESSION_CLOSE,
    )
    assert out["minutes_to_close"] == 0.0
    # minutes_from_open still meaningful (positive)
    assert out["minutes_from_open"] == pytest.approx(405.0)


# ── Partial missing inputs ────────────────────────────────────────────────


def test_missing_session_open_keeps_other_outputs():
    """Only session_open_ts missing — minutes_from_open NaN, others fine."""
    now = _ist_ts("2026-06-04T10:00:00+05:30")
    out = compute_intraday_time_features(
        now_ts=now,
        session_open_ts=None,
        session_close_ts=SESSION_CLOSE,
    )
    assert math.isnan(out["minutes_from_open"])
    assert out["minutes_to_close"] == pytest.approx(330.0)
    # Lunch flag is purely clock-based, must still compute.
    assert out["lunch_session_flag"] == 0.0


def test_missing_session_close_keeps_other_outputs():
    now = _ist_ts("2026-06-04T12:30:00+05:30")
    out = compute_intraday_time_features(
        now_ts=now,
        session_open_ts=SESSION_OPEN,
        session_close_ts=None,
    )
    assert out["minutes_from_open"] == pytest.approx(195.0)
    assert math.isnan(out["minutes_to_close"])
    assert out["lunch_session_flag"] == 1.0


def test_missing_now_ts_yields_all_nan():
    """now_ts is required for every output — all three go NaN."""
    out = compute_intraday_time_features(
        now_ts=None,
        session_open_ts=SESSION_OPEN,
        session_close_ts=SESSION_CLOSE,
    )
    assert math.isnan(out["minutes_from_open"])
    assert math.isnan(out["minutes_to_close"])
    assert math.isnan(out["lunch_session_flag"])


# ── Invalid input types ───────────────────────────────────────────────────


def test_bad_string_inputs_yield_nan():
    out = compute_intraday_time_features(
        now_ts="not-a-number",       # type: ignore[arg-type]
        session_open_ts="bad",        # type: ignore[arg-type]
        session_close_ts="also-bad",  # type: ignore[arg-type]
    )
    assert math.isnan(out["minutes_from_open"])
    assert math.isnan(out["minutes_to_close"])
    assert math.isnan(out["lunch_session_flag"])


def test_non_finite_now_ts_yields_nan():
    """NaN / inf / non-positive epoch seconds are rejected."""
    for bad in (float("nan"), float("inf"), 0.0, -1.0):
        out = compute_intraday_time_features(
            now_ts=bad,
            session_open_ts=SESSION_OPEN,
            session_close_ts=SESSION_CLOSE,
        )
        assert math.isnan(out["minutes_from_open"]), f"bad={bad}"
        assert math.isnan(out["minutes_to_close"]), f"bad={bad}"
        assert math.isnan(out["lunch_session_flag"]), f"bad={bad}"
