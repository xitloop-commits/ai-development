"""Tests for features/premium_vwap.py — C8 ATM premium-VWAP features."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.premium_vwap import (
    PremiumVwapState,
    compute_premium_vwap_features,
)


# ── Cold state ────────────────────────────────────────────────────────────


def test_none_state_yields_all_nan():
    out = compute_premium_vwap_features(None, current_ce_premium=100.0, current_pe_premium=100.0)
    for v in out.values():
        assert math.isnan(v)


def test_empty_state_yields_dist_nan_but_count_zero():
    state = PremiumVwapState()
    out = compute_premium_vwap_features(state, current_ce_premium=100.0, current_pe_premium=100.0)
    assert math.isnan(out["atm_ce_premium_vwap_dist"])
    assert math.isnan(out["atm_pe_premium_vwap_dist"])
    # State exists → count is defined (0), not NaN.
    assert out["premium_vwap_reclaim_count"] == pytest.approx(0.0)


# ── First-tick VWAP seeding ───────────────────────────────────────────────


def test_first_update_sets_vwap_to_premium_and_dist_zero():
    state = PremiumVwapState()
    state.update(ce_premium=120.0, pe_premium=80.0, tick_volume=10.0)
    assert state.ce_vwap == pytest.approx(120.0)
    assert state.pe_vwap == pytest.approx(80.0)
    out = compute_premium_vwap_features(
        state, current_ce_premium=120.0, current_pe_premium=80.0
    )
    assert out["atm_ce_premium_vwap_dist"] == pytest.approx(0.0)
    assert out["atm_pe_premium_vwap_dist"] == pytest.approx(0.0)
    assert out["premium_vwap_reclaim_count"] == pytest.approx(0.0)


def test_first_tick_with_only_ce_leaves_pe_vwap_none():
    state = PremiumVwapState()
    state.update(ce_premium=120.0, pe_premium=None, tick_volume=10.0)
    assert state.ce_vwap == pytest.approx(120.0)
    assert state.pe_vwap is None
    out = compute_premium_vwap_features(
        state, current_ce_premium=120.0, current_pe_premium=80.0
    )
    assert out["atm_ce_premium_vwap_dist"] == pytest.approx(0.0)
    assert math.isnan(out["atm_pe_premium_vwap_dist"])


# ── dist sign / magnitude ─────────────────────────────────────────────────


def test_rising_ce_premium_yields_positive_dist():
    state = PremiumVwapState()
    state.update(ce_premium=100.0, pe_premium=100.0, tick_volume=10.0)
    state.update(ce_premium=110.0, pe_premium=100.0, tick_volume=10.0)
    # CE vwap = (100*10 + 110*10) / 20 = 105
    out = compute_premium_vwap_features(
        state, current_ce_premium=110.0, current_pe_premium=100.0
    )
    expected = (110.0 - 105.0) / 105.0 * 100.0
    assert out["atm_ce_premium_vwap_dist"] == pytest.approx(expected)
    assert out["atm_ce_premium_vwap_dist"] > 0


def test_falling_pe_premium_yields_negative_dist():
    state = PremiumVwapState()
    state.update(ce_premium=100.0, pe_premium=120.0, tick_volume=10.0)
    state.update(ce_premium=100.0, pe_premium=110.0, tick_volume=10.0)
    # PE vwap = (120*10 + 110*10) / 20 = 115; current 100 → -13.04%
    out = compute_premium_vwap_features(
        state, current_ce_premium=100.0, current_pe_premium=100.0
    )
    expected = (100.0 - 115.0) / 115.0 * 100.0
    assert out["atm_pe_premium_vwap_dist"] == pytest.approx(expected)
    assert out["atm_pe_premium_vwap_dist"] < 0


# ── Reclaim counter ───────────────────────────────────────────────────────


def test_reclaim_count_starts_at_zero():
    state = PremiumVwapState()
    assert state.reclaim_count == 0
    out = compute_premium_vwap_features(state, 100.0, 100.0)
    assert out["premium_vwap_reclaim_count"] == pytest.approx(0.0)


def test_first_tick_does_not_count_as_reclaim():
    """None → True transition is initial state discovery, not a reclaim."""
    state = PremiumVwapState()
    state.update(ce_premium=100.0, pe_premium=100.0, tick_volume=10.0)
    # First tick: premium == vwap → now_above = False. Then if next tick is above,
    # that IS a reclaim (False → True). But the first sample itself must not fire.
    assert state.reclaim_count == 0
    assert state.ce_last_above_vwap is False  # premium > vwap is False (==)
    assert state.pe_last_above_vwap is False


def test_below_to_above_increments_reclaim_count():
    state = PremiumVwapState()
    # tick 1: premium = vwap = 100 → last_above = False
    state.update(ce_premium=100.0, pe_premium=100.0, tick_volume=10.0)
    # tick 2: low premium → still below vwap
    state.update(ce_premium=90.0, pe_premium=100.0, tick_volume=10.0)
    # CE vwap so far: (100*10 + 90*10) / 20 = 95; 90 < 95 → below
    assert state.ce_last_above_vwap is False
    assert state.reclaim_count == 0
    # tick 3: high premium → above vwap → CE reclaim fires
    state.update(ce_premium=200.0, pe_premium=100.0, tick_volume=10.0)
    # CE vwap = (100*10 + 90*10 + 200*10) / 30 = 130; 200 > 130 → above
    assert state.ce_last_above_vwap is True
    assert state.reclaim_count == 1


def test_oscillation_counts_each_below_to_above_flip():
    """below→above→below→above should produce exactly 2 reclaims."""
    state = PremiumVwapState()
    # Seed: premium = vwap = 100 → last_above = False
    state.update(ce_premium=100.0, pe_premium=100.0, tick_volume=10.0)
    assert state.reclaim_count == 0

    # Push CE above vwap: first reclaim (False → True).
    state.update(ce_premium=300.0, pe_premium=100.0, tick_volume=10.0)
    # vwap = (100+300)*10/20 = 200; 300 > 200 → above.
    assert state.ce_last_above_vwap is True
    assert state.reclaim_count == 1

    # Drag CE back below vwap (True → False, no reclaim fires).
    state.update(ce_premium=50.0, pe_premium=100.0, tick_volume=10.0)
    # vwap = (100+300+50)*10/30 = 150; 50 < 150 → below.
    assert state.ce_last_above_vwap is False
    assert state.reclaim_count == 1

    # Push CE above vwap again: second reclaim.
    state.update(ce_premium=500.0, pe_premium=100.0, tick_volume=10.0)
    # vwap = (100+300+50+500)*10/40 = 237.5; 500 > 237.5 → above.
    assert state.ce_last_above_vwap is True
    assert state.reclaim_count == 2


def test_ce_and_pe_share_the_same_reclaim_counter():
    """CE reclaim + PE reclaim → counter increments to 2."""
    state = PremiumVwapState()
    # Seed both sides below their (own == initial) vwap.
    state.update(ce_premium=100.0, pe_premium=100.0, tick_volume=10.0)
    state.update(ce_premium=80.0, pe_premium=80.0, tick_volume=10.0)
    # Both vwaps now (100+80)/2 = 90, current 80 < 90 → both below.
    assert state.ce_last_above_vwap is False
    assert state.pe_last_above_vwap is False
    assert state.reclaim_count == 0

    # CE reclaims alone first.
    state.update(ce_premium=300.0, pe_premium=80.0, tick_volume=10.0)
    # CE vwap = (100+80+300)*10/30 = 160; 300 > 160 → above. CE reclaimed.
    # PE vwap = (100+80+80)*10/30 = 86.67; 80 < 86.67 → still below.
    assert state.ce_last_above_vwap is True
    assert state.pe_last_above_vwap is False
    assert state.reclaim_count == 1

    # PE reclaims; counter advances to 2 (shared).
    state.update(ce_premium=300.0, pe_premium=400.0, tick_volume=10.0)
    # PE vwap = (100+80+80+400)*10/40 = 165; 400 > 165 → above. PE reclaimed.
    assert state.pe_last_above_vwap is True
    assert state.reclaim_count == 2


def test_reclaim_count_monotonic_non_decreasing():
    """Across an arbitrary sequence of updates, reclaim_count never falls."""
    state = PremiumVwapState()
    seen = [state.reclaim_count]
    for ce, pe in [
        (100.0, 100.0),
        (80.0, 120.0),
        (150.0, 80.0),
        (90.0, 200.0),
        (300.0, 70.0),
        (60.0, 250.0),
    ]:
        state.update(ce_premium=ce, pe_premium=pe, tick_volume=10.0)
        seen.append(state.reclaim_count)
    for prev, curr in zip(seen, seen[1:]):
        assert curr >= prev


# ── Bad-input handling ────────────────────────────────────────────────────


def test_zero_tick_volume_ignored():
    state = PremiumVwapState()
    state.update(ce_premium=100.0, pe_premium=100.0, tick_volume=0.0)
    assert state.ce_cum_volume == 0
    assert state.pe_cum_volume == 0
    assert state.ce_vwap is None
    assert state.pe_vwap is None


def test_negative_tick_volume_ignored():
    state = PremiumVwapState()
    state.update(ce_premium=100.0, pe_premium=100.0, tick_volume=-5.0)
    assert state.ce_cum_volume == 0
    assert state.pe_cum_volume == 0


def test_nan_tick_volume_ignored():
    state = PremiumVwapState()
    state.update(ce_premium=100.0, pe_premium=100.0, tick_volume=float("nan"))
    assert state.ce_cum_volume == 0
    assert state.pe_cum_volume == 0


def test_negative_ce_premium_skips_ce_side_only():
    state = PremiumVwapState()
    state.update(ce_premium=-10.0, pe_premium=80.0, tick_volume=10.0)
    assert state.ce_cum_volume == 0
    assert state.pe_cum_volume == 10
    assert state.pe_vwap == pytest.approx(80.0)


def test_nan_pe_premium_skips_pe_side_only():
    state = PremiumVwapState()
    state.update(ce_premium=120.0, pe_premium=float("nan"), tick_volume=10.0)
    assert state.ce_cum_volume == 10
    assert state.pe_cum_volume == 0
    assert state.ce_vwap == pytest.approx(120.0)


# ── Reset ─────────────────────────────────────────────────────────────────


def test_reset_clears_all_state():
    state = PremiumVwapState()
    state.update(ce_premium=100.0, pe_premium=100.0, tick_volume=10.0)
    state.update(ce_premium=200.0, pe_premium=200.0, tick_volume=10.0)
    # Force at least one reclaim before reset so we know it really cleared.
    state.update(ce_premium=50.0, pe_premium=50.0, tick_volume=10.0)
    state.update(ce_premium=500.0, pe_premium=500.0, tick_volume=10.0)
    assert state.reclaim_count >= 1

    state.reset()
    assert state.ce_cum_value == 0.0
    assert state.ce_cum_volume == 0.0
    assert state.pe_cum_value == 0.0
    assert state.pe_cum_volume == 0.0
    assert state.ce_last_above_vwap is None
    assert state.pe_last_above_vwap is None
    assert state.reclaim_count == 0
    assert state.ce_vwap is None
    assert state.pe_vwap is None
    out = compute_premium_vwap_features(state, 100.0, 100.0)
    assert math.isnan(out["atm_ce_premium_vwap_dist"])
    assert math.isnan(out["atm_pe_premium_vwap_dist"])
    assert out["premium_vwap_reclaim_count"] == pytest.approx(0.0)


# ── compute_premium_vwap_features partial-input behaviour ────────────────


def test_missing_current_ce_premium_still_yields_pe_dist_and_count():
    state = PremiumVwapState()
    state.update(ce_premium=100.0, pe_premium=80.0, tick_volume=10.0)
    state.update(ce_premium=120.0, pe_premium=90.0, tick_volume=10.0)
    out = compute_premium_vwap_features(
        state, current_ce_premium=None, current_pe_premium=90.0
    )
    assert math.isnan(out["atm_ce_premium_vwap_dist"])
    # PE vwap = (80+90)*10/20 = 85; current 90 → +5.88%
    expected_pe = (90.0 - 85.0) / 85.0 * 100.0
    assert out["atm_pe_premium_vwap_dist"] == pytest.approx(expected_pe)
    assert out["premium_vwap_reclaim_count"] == pytest.approx(float(state.reclaim_count))


def test_invalid_current_premiums_yield_dist_nan_but_count_defined():
    state = PremiumVwapState()
    state.update(ce_premium=100.0, pe_premium=100.0, tick_volume=10.0)
    out = compute_premium_vwap_features(
        state, current_ce_premium=float("nan"), current_pe_premium=-5.0
    )
    assert math.isnan(out["atm_ce_premium_vwap_dist"])
    assert math.isnan(out["atm_pe_premium_vwap_dist"])
    assert out["premium_vwap_reclaim_count"] == pytest.approx(0.0)
