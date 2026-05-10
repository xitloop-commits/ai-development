"""Tests for features/expiry.py — Wave 1 DTE + session-position features."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.expiry import compute_expiry_features


# ── DTE math ──────────────────────────────────────────────────────────────


def test_days_to_expiry_5_days_out():
    now = 1_000_000.0
    expiry = now + 5 * 86400  # 5 days later
    out = compute_expiry_features(now_ts=now, expiry_ts=expiry)
    assert out["days_to_expiry"] == pytest.approx(5.0)
    assert out["hours_to_expiry"] == pytest.approx(120.0)


def test_fractional_days_to_expiry():
    now = 1_000_000.0
    expiry = now + 12 * 3600  # 12 hours
    out = compute_expiry_features(now_ts=now, expiry_ts=expiry)
    assert out["days_to_expiry"] == pytest.approx(0.5)
    assert out["hours_to_expiry"] == pytest.approx(12.0)


def test_negative_dte_after_expiry():
    """After expiry has passed, DTE should be negative (caller may filter on this)."""
    now = 1_000_000.0
    expiry = now - 86400  # expired yesterday
    out = compute_expiry_features(now_ts=now, expiry_ts=expiry)
    assert out["days_to_expiry"] == pytest.approx(-1.0)


# ── is_expiry_day ─────────────────────────────────────────────────────────


def test_is_expiry_day_when_within_24h():
    now = 1_000_000.0
    expiry = now + 6 * 3600  # 6 hours from now
    out = compute_expiry_features(now_ts=now, expiry_ts=expiry)
    assert out["is_expiry_day"] == 1.0


def test_is_expiry_day_zero_when_not_today():
    now = 1_000_000.0
    expiry = now + 5 * 86400
    out = compute_expiry_features(now_ts=now, expiry_ts=expiry)
    assert out["is_expiry_day"] == 0.0


def test_is_expiry_day_zero_after_expiry():
    now = 1_000_000.0
    expiry = now - 3600  # 1h ago
    out = compute_expiry_features(now_ts=now, expiry_ts=expiry)
    assert out["is_expiry_day"] == 0.0


# ── Monthly flag ──────────────────────────────────────────────────────────


def test_is_monthly_expiry_true():
    out = compute_expiry_features(1_000_000, 1_500_000, is_monthly=True)
    assert out["is_monthly_expiry"] == 1.0


def test_is_monthly_expiry_false():
    out = compute_expiry_features(1_000_000, 1_500_000, is_monthly=False)
    assert out["is_monthly_expiry"] == 0.0


def test_is_monthly_expiry_none_yields_nan():
    out = compute_expiry_features(1_000_000, 1_500_000, is_monthly=None)
    assert math.isnan(out["is_monthly_expiry"])


# ── Session remaining ─────────────────────────────────────────────────────


def test_session_remaining_at_open_is_one():
    open_ts = 1_000_000.0
    end_ts = open_ts + 6 * 3600
    out = compute_expiry_features(
        now_ts=open_ts, expiry_ts=end_ts,
        session_open_ts=open_ts, session_end_ts=end_ts,
    )
    assert out["session_remaining_pct"] == pytest.approx(1.0)


def test_session_remaining_at_close_is_zero():
    open_ts = 1_000_000.0
    end_ts = open_ts + 6 * 3600
    out = compute_expiry_features(
        now_ts=end_ts, expiry_ts=end_ts,
        session_open_ts=open_ts, session_end_ts=end_ts,
    )
    assert out["session_remaining_pct"] == pytest.approx(0.0)


def test_session_remaining_at_mid():
    open_ts = 1_000_000.0
    end_ts = open_ts + 6 * 3600
    mid = open_ts + 3 * 3600
    out = compute_expiry_features(
        now_ts=mid, expiry_ts=end_ts,
        session_open_ts=open_ts, session_end_ts=end_ts,
    )
    assert out["session_remaining_pct"] == pytest.approx(0.5)


def test_session_remaining_clamps_before_open():
    """If now < open (pre-market tick), clamp to 1.0."""
    open_ts = 1_000_000.0
    end_ts = open_ts + 6 * 3600
    pre = open_ts - 100
    out = compute_expiry_features(
        now_ts=pre, expiry_ts=end_ts,
        session_open_ts=open_ts, session_end_ts=end_ts,
    )
    assert out["session_remaining_pct"] == pytest.approx(1.0)


def test_session_remaining_clamps_after_close():
    open_ts = 1_000_000.0
    end_ts = open_ts + 6 * 3600
    out = compute_expiry_features(
        now_ts=end_ts + 100, expiry_ts=end_ts,
        session_open_ts=open_ts, session_end_ts=end_ts,
    )
    assert out["session_remaining_pct"] == pytest.approx(0.0)


# ── Null rules ────────────────────────────────────────────────────────────


def test_missing_timestamps_yield_nan():
    out = compute_expiry_features(now_ts=None, expiry_ts=None)
    assert all(math.isnan(out[k]) for k in (
        "days_to_expiry", "hours_to_expiry", "is_expiry_day",
        "is_monthly_expiry", "session_remaining_pct",
    ))


def test_missing_session_bounds_yields_session_nan():
    out = compute_expiry_features(
        now_ts=1_000_000, expiry_ts=1_500_000,
        session_open_ts=None, session_end_ts=None,
    )
    # DTE features still computed
    assert out["days_to_expiry"] > 0
    # Session remaining is NaN
    assert math.isnan(out["session_remaining_pct"])


def test_invalid_session_bounds_yields_session_nan():
    """end_ts <= open_ts is invalid (e.g., feed bug)."""
    out = compute_expiry_features(
        now_ts=1_000_000, expiry_ts=1_500_000,
        session_open_ts=1_000_000, session_end_ts=1_000_000,  # same → invalid
    )
    assert math.isnan(out["session_remaining_pct"])
