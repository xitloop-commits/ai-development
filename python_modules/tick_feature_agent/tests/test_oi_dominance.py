"""Tests for features/oi_dominance.py — C1 OI-dominance persistence."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.oi_dominance import (
    OiDominanceState,
    compute_oi_dominance_features,
)


# ── Cold state ────────────────────────────────────────────────────────────


def test_none_state_yields_nan():
    out = compute_oi_dominance_features(None)
    assert math.isnan(out["oi_dominance_streak_min"])


def test_empty_state_yields_zero():
    state = OiDominanceState()
    out = compute_oi_dominance_features(state)
    assert out["oi_dominance_streak_min"] == 0.0


# ── First update / side seeding ───────────────────────────────────────────


def test_first_update_call_dominant_sets_side_and_starts_streak():
    state = OiDominanceState()
    state.update(ts=1_000_000.0, oi_change_call=50_000.0, oi_change_put=20_000.0)
    assert state.current_side == 1
    assert state.streak_start_ts == 1_000_000.0
    assert state.last_update_ts == 1_000_000.0
    # No elapsed time yet → 0.0
    out = compute_oi_dominance_features(state)
    assert out["oi_dominance_streak_min"] == 0.0


def test_first_update_put_dominant_sets_negative_side():
    state = OiDominanceState()
    state.update(ts=1_000_000.0, oi_change_call=10_000.0, oi_change_put=40_000.0)
    assert state.current_side == -1
    out = compute_oi_dominance_features(state)
    # streak just started → 0.0 (sign visible only once elapsed accrues)
    assert out["oi_dominance_streak_min"] == 0.0


# ── Streak accrual ────────────────────────────────────────────────────────


def test_continued_call_dominance_accrues_positive_minutes():
    state = OiDominanceState()
    state.update(ts=1_000_000.0, oi_change_call=50_000.0, oi_change_put=20_000.0)
    # 5 minutes later, still call-dominant.
    state.update(ts=1_000_300.0, oi_change_call=60_000.0, oi_change_put=25_000.0)
    out = compute_oi_dominance_features(state)
    assert out["oi_dominance_streak_min"] == pytest.approx(5.0)


def test_continued_put_dominance_accrues_negative_minutes():
    state = OiDominanceState()
    state.update(ts=2_000_000.0, oi_change_call=10_000.0, oi_change_put=30_000.0)
    # 10 minutes later, still put-dominant.
    state.update(ts=2_000_600.0, oi_change_call=12_000.0, oi_change_put=35_000.0)
    out = compute_oi_dominance_features(state)
    assert out["oi_dominance_streak_min"] == pytest.approx(-10.0)


# ── Flip behavior ─────────────────────────────────────────────────────────


def test_flip_call_to_put_resets_streak_to_zero_on_flip_tick():
    state = OiDominanceState()
    state.update(ts=1_000_000.0, oi_change_call=50_000.0, oi_change_put=20_000.0)
    state.update(ts=1_000_300.0, oi_change_call=55_000.0, oi_change_put=22_000.0)
    # Now flip: puts dominate.
    state.update(ts=1_000_400.0, oi_change_call=10_000.0, oi_change_put=40_000.0)
    assert state.current_side == -1
    assert state.streak_start_ts == 1_000_400.0
    out = compute_oi_dominance_features(state)
    # Fresh flip — no elapsed time yet on the new side.
    assert out["oi_dominance_streak_min"] == 0.0


def test_flip_then_accrue_yields_signed_minutes_on_new_side():
    state = OiDominanceState()
    state.update(ts=1_000_000.0, oi_change_call=50_000.0, oi_change_put=20_000.0)
    state.update(ts=1_000_400.0, oi_change_call=10_000.0, oi_change_put=40_000.0)  # flip
    # 10 min after the flip, still put-dominant.
    state.update(ts=1_001_000.0, oi_change_call=15_000.0, oi_change_put=45_000.0)
    out = compute_oi_dominance_features(state)
    assert out["oi_dominance_streak_min"] == pytest.approx(-10.0)


# ── Neutral / equal ───────────────────────────────────────────────────────


def test_equal_oi_changes_neutral_side():
    state = OiDominanceState()
    state.update(ts=1_000_000.0, oi_change_call=30_000.0, oi_change_put=30_000.0)
    assert state.current_side == 0
    out = compute_oi_dominance_features(state)
    assert out["oi_dominance_streak_min"] == 0.0


def test_flip_through_neutral_resets_streak():
    state = OiDominanceState()
    state.update(ts=1_000_000.0, oi_change_call=50_000.0, oi_change_put=20_000.0)
    state.update(ts=1_000_300.0, oi_change_call=55_000.0, oi_change_put=22_000.0)
    # Neutral tick mid-streak.
    state.update(ts=1_000_360.0, oi_change_call=30_000.0, oi_change_put=30_000.0)
    assert state.current_side == 0
    out = compute_oi_dominance_features(state)
    assert out["oi_dominance_streak_min"] == 0.0


# ── Cap ───────────────────────────────────────────────────────────────────


def test_positive_cap_at_240_minutes():
    state = OiDominanceState()
    state.update(ts=1_000_000.0, oi_change_call=50_000.0, oi_change_put=20_000.0)
    # 5 hours (300 min) later, still call-dominant — should clamp at +240.
    state.update(ts=1_000_000.0 + 300 * 60, oi_change_call=80_000.0, oi_change_put=30_000.0)
    out = compute_oi_dominance_features(state)
    assert out["oi_dominance_streak_min"] == pytest.approx(240.0)


def test_negative_cap_at_minus_240_minutes():
    state = OiDominanceState()
    state.update(ts=1_000_000.0, oi_change_call=10_000.0, oi_change_put=40_000.0)
    state.update(ts=1_000_000.0 + 300 * 60, oi_change_call=15_000.0, oi_change_put=60_000.0)
    out = compute_oi_dominance_features(state)
    assert out["oi_dominance_streak_min"] == pytest.approx(-240.0)


def test_cap_not_applied_inside_state():
    """State should remain honest — cap is only enforced in compute_*."""
    state = OiDominanceState()
    state.update(ts=1_000_000.0, oi_change_call=50_000.0, oi_change_put=20_000.0)
    state.update(ts=1_000_000.0 + 300 * 60, oi_change_call=80_000.0, oi_change_put=30_000.0)
    # streak_start_ts should still point at the original start; last_update_ts at 5h later.
    assert state.streak_start_ts == 1_000_000.0
    assert state.last_update_ts == 1_000_000.0 + 300 * 60
    # i.e. raw elapsed = 300 min, only the compute result clamps to 240.


# ── Defensive paths ───────────────────────────────────────────────────────


def test_backwards_ts_is_ignored():
    state = OiDominanceState()
    state.update(ts=1_000_300.0, oi_change_call=50_000.0, oi_change_put=20_000.0)
    # Earlier ts arrives — should be ignored silently.
    state.update(ts=1_000_000.0, oi_change_call=10_000.0, oi_change_put=40_000.0)
    assert state.current_side == 1
    assert state.streak_start_ts == 1_000_300.0
    assert state.last_update_ts == 1_000_300.0


def test_non_finite_oi_change_is_ignored():
    state = OiDominanceState()
    state.update(ts=1_000_000.0, oi_change_call=50_000.0, oi_change_put=20_000.0)
    snapshot_side = state.current_side
    snapshot_start = state.streak_start_ts
    snapshot_last = state.last_update_ts
    # NaN / inf inputs should leave state untouched.
    state.update(ts=1_000_060.0, oi_change_call=float("nan"), oi_change_put=20_000.0)
    state.update(ts=1_000_060.0, oi_change_call=50_000.0, oi_change_put=float("inf"))
    state.update(ts=1_000_060.0, oi_change_call=None, oi_change_put=20_000.0)  # type: ignore[arg-type]
    assert state.current_side == snapshot_side
    assert state.streak_start_ts == snapshot_start
    assert state.last_update_ts == snapshot_last


# ── reset ─────────────────────────────────────────────────────────────────


def test_reset_clears_state_and_fresh_streak_starts_after():
    state = OiDominanceState()
    state.update(ts=1_000_000.0, oi_change_call=50_000.0, oi_change_put=20_000.0)
    state.update(ts=1_000_300.0, oi_change_call=55_000.0, oi_change_put=22_000.0)
    state.reset()
    assert state.current_side == 0
    assert state.streak_start_ts is None
    assert state.last_update_ts is None
    out = compute_oi_dominance_features(state)
    assert out["oi_dominance_streak_min"] == 0.0

    # First update post-reset should start a fresh streak.
    state.update(ts=2_000_000.0, oi_change_call=10_000.0, oi_change_put=40_000.0)
    assert state.current_side == -1
    assert state.streak_start_ts == 2_000_000.0
    state.update(ts=2_000_180.0, oi_change_call=12_000.0, oi_change_put=42_000.0)
    out = compute_oi_dominance_features(state)
    assert out["oi_dominance_streak_min"] == pytest.approx(-3.0)
