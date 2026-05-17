"""Tests for features/dealer_hedging.py — C4 dealer-hedging features."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.dealer_hedging import (
    compute_dealer_hedging_features,
)


# ── Helpers ───────────────────────────────────────────────────────────────


def _row(strike, c_oi=1000, p_oi=1000, c_iv=18.0, p_iv=18.0):
    """Build a chain-snapshot row dict."""
    return {
        "strike": strike,
        "callOI": c_oi,
        "putOI": p_oi,
        "callIV": c_iv,
        "putIV": p_iv,
    }


def _flat_chain(spot=24000, strikes=range(23000, 25001, 100)):
    """Equal-OI chain spanning around spot."""
    return [_row(k) for k in strikes]


# ── Empty / missing inputs ────────────────────────────────────────────────


def test_no_rows_all_nan():
    out = compute_dealer_hedging_features(
        spot=24000, rows=[], days_to_expiry=5.0, atm_delta_history=None, now_ts=1_000_000,
    )
    for key in (
        "net_gex",
        "gamma_flip_distance_pct",
        "dealer_net_delta",
        "charm_estimate_atm",
        "vanna_estimate_atm",
    ):
        assert math.isnan(out[key])


def test_no_spot_all_chain_nan():
    rows = _flat_chain()
    out = compute_dealer_hedging_features(
        spot=None, rows=rows, days_to_expiry=5.0, atm_delta_history=None, now_ts=1_000_000,
    )
    assert math.isnan(out["net_gex"])
    assert math.isnan(out["dealer_net_delta"])
    assert math.isnan(out["gamma_flip_distance_pct"])


def test_zero_dte_chain_nan_but_estimates_can_work():
    """At expiry, Greeks blow up — chain aggregates must be NaN, but the FD
    estimates only depend on the history buffer and should remain available."""
    history = [
        (1_000_000.0 - 300, 0.45, 0.18),
        (1_000_000.0 - 1,   0.55, 0.20),
    ]
    out = compute_dealer_hedging_features(
        spot=24000, rows=_flat_chain(), days_to_expiry=0,
        atm_delta_history=history, now_ts=1_000_000.0,
    )
    assert math.isnan(out["net_gex"])
    assert math.isnan(out["gamma_flip_distance_pct"])
    assert math.isnan(out["dealer_net_delta"])
    assert out["charm_estimate_atm"] == pytest.approx((0.55 - 0.45) / 299.0, rel=1e-6)
    assert out["vanna_estimate_atm"] == pytest.approx((0.55 - 0.45) / (0.20 - 0.18), rel=1e-6)


# ── Chain aggregates ──────────────────────────────────────────────────────


def test_net_gex_finite_on_balanced_chain():
    out = compute_dealer_hedging_features(
        spot=24000, rows=_flat_chain(), days_to_expiry=5.0,
        atm_delta_history=None, now_ts=None,
    )
    assert math.isfinite(out["net_gex"])
    # Symmetric chain with equal CE/PE OI → net_gex very close to zero
    # (gamma is symmetric in CE/PE for same K, sigma, T → they cancel).
    assert abs(out["net_gex"]) < 1.0


def test_net_gex_call_heavy_chain_is_positive():
    """If CE OI >> PE OI, dealers are net long gamma from calls → positive."""
    rows = [_row(k, c_oi=5000, p_oi=500) for k in range(23000, 25001, 100)]
    out = compute_dealer_hedging_features(
        spot=24000, rows=rows, days_to_expiry=5.0,
        atm_delta_history=None, now_ts=None,
    )
    assert out["net_gex"] > 0


def test_net_gex_put_heavy_chain_is_negative():
    rows = [_row(k, c_oi=500, p_oi=5000) for k in range(23000, 25001, 100)]
    out = compute_dealer_hedging_features(
        spot=24000, rows=rows, days_to_expiry=5.0,
        atm_delta_history=None, now_ts=None,
    )
    assert out["net_gex"] < 0


def test_dealer_net_delta_call_only_is_positive():
    """Pure calls → positive Σ (callΔ · callOI). Put delta is negative."""
    rows = [_row(k, c_oi=1000, p_oi=0) for k in range(23000, 25001, 100)]
    out = compute_dealer_hedging_features(
        spot=24000, rows=rows, days_to_expiry=5.0,
        atm_delta_history=None, now_ts=None,
    )
    assert out["dealer_net_delta"] > 0


def test_dealer_net_delta_put_only_is_negative():
    rows = [_row(k, c_oi=0, p_oi=1000) for k in range(23000, 25001, 100)]
    out = compute_dealer_hedging_features(
        spot=24000, rows=rows, days_to_expiry=5.0,
        atm_delta_history=None, now_ts=None,
    )
    assert out["dealer_net_delta"] < 0


def test_gamma_flip_distance_signed_pct():
    """Below 24000: puts dominate (net_gex contribution negative).
    Above 24000: calls dominate (positive). Flip should sit near 24000."""
    rows = []
    for k in range(23000, 25001, 100):
        if k < 24000:
            rows.append(_row(k, c_oi=200, p_oi=5000))
        else:
            rows.append(_row(k, c_oi=5000, p_oi=200))
    out = compute_dealer_hedging_features(
        spot=24000, rows=rows, days_to_expiry=5.0,
        atm_delta_history=None, now_ts=None,
    )
    # Cumulative net gamma starts very negative (puts dominate), crosses to
    # positive somewhere near the regime change. Within ±5% of spot.
    assert math.isfinite(out["gamma_flip_distance_pct"])
    assert abs(out["gamma_flip_distance_pct"]) < 5.0


def test_gamma_flip_nan_when_no_crossover():
    """Pure-call chain → cumulative gamma is monotonic positive, no zero
    crossing → NaN distance."""
    rows = [_row(k, c_oi=5000, p_oi=0) for k in range(23000, 25001, 100)]
    out = compute_dealer_hedging_features(
        spot=24000, rows=rows, days_to_expiry=5.0,
        atm_delta_history=None, now_ts=None,
    )
    assert math.isnan(out["gamma_flip_distance_pct"])


def test_invalid_iv_strike_is_skipped_others_still_count():
    rows = _flat_chain()
    # Corrupt one row's IV — module should skip that strike, not blow up.
    rows[3]["callIV"] = -1.0
    rows[3]["putIV"] = float("nan")
    out = compute_dealer_hedging_features(
        spot=24000, rows=rows, days_to_expiry=5.0,
        atm_delta_history=None, now_ts=None,
    )
    assert math.isfinite(out["net_gex"])
    assert math.isfinite(out["dealer_net_delta"])


# ── Charm / vanna FD estimates ────────────────────────────────────────────


def test_charm_estimate_positive_when_delta_rising():
    history = [
        (1_000_000.0 - 300, 0.45, 0.18),
        (1_000_000.0 - 1,   0.55, 0.18),
    ]
    out = compute_dealer_hedging_features(
        spot=24000, rows=[], days_to_expiry=5.0,
        atm_delta_history=history, now_ts=1_000_000.0,
    )
    assert out["charm_estimate_atm"] > 0
    # Slope: 0.10 delta / 299 sec ≈ 3.34e-4 per sec.
    assert out["charm_estimate_atm"] == pytest.approx(0.10 / 299.0, rel=1e-6)


def test_charm_nan_with_only_current_sample():
    history = [(1_000_000.0 - 1, 0.55, 0.18)]
    out = compute_dealer_hedging_features(
        spot=24000, rows=[], days_to_expiry=5.0,
        atm_delta_history=history, now_ts=1_000_000.0,
    )
    assert math.isnan(out["charm_estimate_atm"])
    assert math.isnan(out["vanna_estimate_atm"])


def test_baseline_too_stale_yields_nan_charm():
    history = [
        (1_000_000.0 - 600, 0.45, 0.18),  # 10 min ago — beyond tolerance
        (1_000_000.0 - 1,   0.55, 0.18),
    ]
    out = compute_dealer_hedging_features(
        spot=24000, rows=[], days_to_expiry=5.0,
        atm_delta_history=history, now_ts=1_000_000.0,
    )
    assert math.isnan(out["charm_estimate_atm"])
    assert math.isnan(out["vanna_estimate_atm"])


def test_vanna_nan_when_iv_unchanged():
    """No IV move → slope undefined → NaN."""
    history = [
        (1_000_000.0 - 300, 0.45, 0.180),
        (1_000_000.0 - 1,   0.55, 0.180),  # iv identical
    ]
    out = compute_dealer_hedging_features(
        spot=24000, rows=[], days_to_expiry=5.0,
        atm_delta_history=history, now_ts=1_000_000.0,
    )
    assert math.isnan(out["vanna_estimate_atm"])
    # charm should still be valid
    assert math.isfinite(out["charm_estimate_atm"])


def test_vanna_finite_with_iv_change():
    history = [
        (1_000_000.0 - 300, 0.45, 0.18),
        (1_000_000.0 - 1,   0.55, 0.20),
    ]
    out = compute_dealer_hedging_features(
        spot=24000, rows=[], days_to_expiry=5.0,
        atm_delta_history=history, now_ts=1_000_000.0,
    )
    assert out["vanna_estimate_atm"] == pytest.approx((0.55 - 0.45) / (0.20 - 0.18), rel=1e-6)


def test_history_with_future_samples_ignored():
    history = [
        (1_000_000.0 - 300, 0.45, 0.18),
        (1_000_000.0 - 1,   0.55, 0.20),
        (1_000_000.0 + 30,  0.99, 0.50),  # future — must be ignored
    ]
    out = compute_dealer_hedging_features(
        spot=24000, rows=[], days_to_expiry=5.0,
        atm_delta_history=history, now_ts=1_000_000.0,
    )
    # Uses the at-or-before-now sample (0.55, 0.20), not the future one.
    assert out["charm_estimate_atm"] == pytest.approx(0.10 / 299.0, rel=1e-6)
