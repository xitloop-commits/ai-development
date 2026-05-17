"""Tests for features/session.py — B3 session-relative features."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.session import (
    SessionState,
    compute_session_features,
)


# ── Cold state ────────────────────────────────────────────────────────────


def test_empty_state_yields_all_nan():
    state = SessionState()
    out = compute_session_features(state, spot=100.0, now_ts=1_000_000.0)
    for k in (
        "dist_from_session_open_pct",
        "dist_from_session_vwap_pct",
        "session_high_age_min",
        "session_low_age_min",
    ):
        assert math.isnan(out[k])


def test_none_state_yields_all_nan():
    out = compute_session_features(None, spot=100.0, now_ts=1_000_000.0)
    for v in out.values():
        assert math.isnan(v)


# ── First-tick seeding ────────────────────────────────────────────────────


def test_first_tick_seeds_open_high_low_at_same_value():
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0, tick_volume=10.0)
    assert state.open_price == 100.0
    assert state.session_high == 100.0
    assert state.session_low == 100.0


def test_first_tick_dist_from_open_zero_when_spot_equals_open():
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0)
    out = compute_session_features(state, spot=100.0, now_ts=1_000_000.0)
    assert out["dist_from_session_open_pct"] == pytest.approx(0.0)


# ── dist_from_session_open_pct ────────────────────────────────────────────


def test_dist_from_open_positive_when_spot_above():
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0)
    out = compute_session_features(state, spot=101.0, now_ts=1_000_000.0)
    assert out["dist_from_session_open_pct"] == pytest.approx(1.0)


def test_dist_from_open_negative_when_spot_below():
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0)
    out = compute_session_features(state, spot=98.5, now_ts=1_000_000.0)
    assert out["dist_from_session_open_pct"] == pytest.approx(-1.5)


# ── dist_from_session_vwap_pct ────────────────────────────────────────────


def test_vwap_nan_when_no_volume_seen():
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0, tick_volume=0.0)
    out = compute_session_features(state, spot=100.0, now_ts=1_000_000.0)
    assert math.isnan(out["dist_from_session_vwap_pct"])


def test_vwap_computed_from_volume_weighted_average():
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0, tick_volume=10.0)   # value 1000
    state.update(ts=1_000_010.0, ltp=110.0, tick_volume=20.0)   # value 2200
    # VWAP = (1000 + 2200) / 30 = 106.666...
    expected_vwap = 3200.0 / 30.0
    out = compute_session_features(state, spot=110.0, now_ts=1_000_010.0)
    expected_dist = (110.0 - expected_vwap) / expected_vwap * 100.0
    assert out["dist_from_session_vwap_pct"] == pytest.approx(expected_dist)


def test_negative_tick_volume_ignored():
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0, tick_volume=-5.0)
    assert state.cum_volume == 0
    assert state.vwap is None


# ── Session high/low ages ─────────────────────────────────────────────────


def test_high_low_age_zero_at_touch():
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0)
    out = compute_session_features(state, spot=100.0, now_ts=1_000_000.0)
    assert out["session_high_age_min"] == 0.0
    assert out["session_low_age_min"] == 0.0


def test_high_age_grows_after_touch_falls_away():
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0)            # opens; high=100
    state.update(ts=1_000_060.0, ltp=99.0)             # 1 min later, dipped
    out = compute_session_features(state, spot=99.0, now_ts=1_000_120.0)
    # high touched at ts=1_000_000; now is 1_000_120 → 2 min age.
    assert out["session_high_age_min"] == pytest.approx(2.0)


def test_low_age_resets_when_new_low_set():
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0)
    state.update(ts=1_000_060.0, ltp=99.0)   # new low
    out = compute_session_features(state, spot=99.0, now_ts=1_000_180.0)
    # New low at 1_000_060; now 1_000_180 → 2 min age.
    assert out["session_low_age_min"] == pytest.approx(2.0)


def test_high_age_resets_when_high_is_matched():
    """Equal-to-high tick should update the timestamp (latest touch wins)."""
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0)
    state.update(ts=1_000_060.0, ltp=99.0)
    state.update(ts=1_000_120.0, ltp=100.0)  # touches high again
    out = compute_session_features(state, spot=100.0, now_ts=1_000_120.0)
    assert out["session_high_age_min"] == 0.0


def test_now_ts_before_extreme_ts_yields_nan_age():
    """Defensive — caller passes stale now_ts. Don't extrapolate negative age."""
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0)
    out = compute_session_features(state, spot=100.0, now_ts=999_999.0)
    assert math.isnan(out["session_high_age_min"])
    assert math.isnan(out["session_low_age_min"])


# ── reset ─────────────────────────────────────────────────────────────────


def test_reset_clears_state():
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0, tick_volume=10.0)
    state.update(ts=1_000_060.0, ltp=110.0, tick_volume=10.0)
    state.reset()
    assert state.open_price is None
    assert state.cum_volume == 0.0
    out = compute_session_features(state, spot=100.0, now_ts=1_000_120.0)
    for v in out.values():
        assert math.isnan(v)


# ── Bad inputs ────────────────────────────────────────────────────────────


def test_update_with_invalid_ltp_ignored():
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=0.0)
    state.update(ts=1_000_000.0, ltp=float("nan"))
    state.update(ts=1_000_000.0, ltp=-5.0)
    assert state.open_price is None


def test_compute_with_invalid_spot_handles_distance_nan_but_keeps_ages():
    state = SessionState()
    state.update(ts=1_000_000.0, ltp=100.0)
    out = compute_session_features(state, spot=None, now_ts=1_000_060.0)
    assert math.isnan(out["dist_from_session_open_pct"])
    assert math.isnan(out["dist_from_session_vwap_pct"])
    assert out["session_high_age_min"] == pytest.approx(1.0)
    assert out["session_low_age_min"] == pytest.approx(1.0)
