"""Tests for features/india_vix.py — C3 vol-regime features."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.india_vix import compute_india_vix_features


# ── Empty / None inputs ───────────────────────────────────────────────────


def test_empty_history_yields_nan():
    out = compute_india_vix_features(now_ts=1_000_000.0, vix_history=[])
    assert math.isnan(out["india_vix"])
    assert math.isnan(out["india_vix_change_5min"])


def test_none_history_yields_nan():
    out = compute_india_vix_features(now_ts=1_000_000.0, vix_history=None)
    assert math.isnan(out["india_vix"])
    assert math.isnan(out["india_vix_change_5min"])


def test_none_now_ts_yields_nan():
    history = [(1_000_000.0, 13.5)]
    out = compute_india_vix_features(now_ts=None, vix_history=history)
    assert math.isnan(out["india_vix"])
    assert math.isnan(out["india_vix_change_5min"])


def test_history_only_in_future_yields_nan():
    """All samples are newer than now_ts → no current value available."""
    now = 1_000_000.0
    history = [(now + 10, 13.5), (now + 20, 13.6)]
    out = compute_india_vix_features(now_ts=now, vix_history=history)
    assert math.isnan(out["india_vix"])
    assert math.isnan(out["india_vix_change_5min"])


# ── Current value picking ─────────────────────────────────────────────────


def test_single_sample_gives_current_only():
    now = 1_000_000.0
    history = [(now - 5, 14.2)]
    out = compute_india_vix_features(now_ts=now, vix_history=history)
    assert out["india_vix"] == pytest.approx(14.2)
    assert math.isnan(out["india_vix_change_5min"])


def test_latest_sample_at_or_before_now_is_chosen():
    """When multiple samples exist, the most recent ≤ now_ts wins."""
    now = 1_000_000.0
    history = [
        (now - 100, 13.0),
        (now - 50, 13.5),
        (now - 1, 14.0),
        (now + 5, 99.0),  # future, must be ignored
    ]
    out = compute_india_vix_features(now_ts=now, vix_history=history)
    assert out["india_vix"] == pytest.approx(14.0)


# ── 5-min change ──────────────────────────────────────────────────────────


def test_change_5min_with_exact_baseline():
    now = 1_000_000.0
    history = [
        (now - 300, 13.0),  # exactly 5 min ago
        (now - 1, 15.5),
    ]
    out = compute_india_vix_features(now_ts=now, vix_history=history)
    assert out["india_vix"] == pytest.approx(15.5)
    assert out["india_vix_change_5min"] == pytest.approx(2.5)


def test_change_5min_uses_latest_within_tolerance():
    """Baseline = latest sample at-or-before (now-300s), within 60s gap."""
    now = 1_000_000.0
    history = [
        (now - 330, 13.0),  # 30s past target, within tolerance
        (now - 305, 13.2),  # 5s past target, the latest at-or-before — picked
        (now - 100, 14.5),
        (now - 1, 15.0),
    ]
    out = compute_india_vix_features(now_ts=now, vix_history=history)
    assert out["india_vix"] == pytest.approx(15.0)
    assert out["india_vix_change_5min"] == pytest.approx(15.0 - 13.2)


def test_baseline_too_stale_yields_nan_change():
    """No sample within 60s of (now-300s) → change_5min NaN even though current is fine."""
    now = 1_000_000.0
    history = [
        (now - 500, 13.0),  # 200s past target, beyond 60s tolerance
        (now - 1, 14.0),
    ]
    out = compute_india_vix_features(now_ts=now, vix_history=history)
    assert out["india_vix"] == pytest.approx(14.0)
    assert math.isnan(out["india_vix_change_5min"])


def test_change_5min_negative_on_vix_drop():
    now = 1_000_000.0
    history = [
        (now - 300, 18.0),
        (now - 1, 14.5),
    ]
    out = compute_india_vix_features(now_ts=now, vix_history=history)
    assert out["india_vix_change_5min"] == pytest.approx(-3.5)


# ── Bad value handling ────────────────────────────────────────────────────


def test_nan_vix_in_history_is_skipped():
    now = 1_000_000.0
    history = [
        (now - 300, 13.0),
        (now - 50, float("nan")),  # corrupt — skip
        (now - 1, 14.0),
    ]
    out = compute_india_vix_features(now_ts=now, vix_history=history)
    assert out["india_vix"] == pytest.approx(14.0)
    assert out["india_vix_change_5min"] == pytest.approx(1.0)


def test_zero_or_negative_vix_treated_as_invalid():
    now = 1_000_000.0
    history = [
        (now - 300, 0.0),  # invalid baseline
        (now - 1, 14.0),
    ]
    out = compute_india_vix_features(now_ts=now, vix_history=history)
    assert out["india_vix"] == pytest.approx(14.0)
    # Baseline rejected → change NaN
    assert math.isnan(out["india_vix_change_5min"])


def test_bad_now_ts_string_yields_nan():
    history = [(1_000_000.0, 14.0)]
    out = compute_india_vix_features(now_ts="not-a-number", vix_history=history)  # type: ignore[arg-type]
    assert math.isnan(out["india_vix"])
    assert math.isnan(out["india_vix_change_5min"])
