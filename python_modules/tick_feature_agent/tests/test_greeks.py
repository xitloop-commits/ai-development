"""Tests for features/greeks.py — Wave 1 IV + Black-Scholes greeks."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.greeks import compute_greek_features


# ── IV surfacing ─────────────────────────────────────────────────────────


def test_iv_surfaces_in_decimal():
    """Dhan reports IV in percent; we publish in decimal."""
    out = compute_greek_features(
        spot=24000, atm_strike=24000,
        atm_ce_iv_pct=18.5, atm_pe_iv_pct=17.2,
        days_to_expiry=5.0,
    )
    assert out["atm_ce_iv"] == pytest.approx(0.185)
    assert out["atm_pe_iv"] == pytest.approx(0.172)


def test_iv_skew_is_pe_minus_ce():
    """Positive skew (put expensive vs call) = bearish sentiment."""
    out = compute_greek_features(
        spot=100, atm_strike=100,
        atm_ce_iv_pct=15.0, atm_pe_iv_pct=18.0,
        days_to_expiry=7.0,
    )
    # skew = (18 - 15) / 100 = 0.03
    assert out["iv_skew_atm"] == pytest.approx(0.03)


def test_iv_skew_negative_when_calls_more_expensive():
    out = compute_greek_features(
        spot=100, atm_strike=100,
        atm_ce_iv_pct=20.0, atm_pe_iv_pct=15.0,
        days_to_expiry=5.0,
    )
    assert out["iv_skew_atm"] < 0


# ── ATM greeks sanity ────────────────────────────────────────────────────


def test_atm_ce_delta_near_half():
    """At-the-money call should have delta ≈ 0.5 (slightly higher due to drift)."""
    out = compute_greek_features(
        spot=100, atm_strike=100,
        atm_ce_iv_pct=20.0, atm_pe_iv_pct=20.0,
        days_to_expiry=7.0,
    )
    assert 0.45 < out["atm_ce_delta"] < 0.65


def test_atm_pe_delta_near_negative_half():
    """At-the-money put should have delta ≈ -0.5."""
    out = compute_greek_features(
        spot=100, atm_strike=100,
        atm_ce_iv_pct=20.0, atm_pe_iv_pct=20.0,
        days_to_expiry=7.0,
    )
    assert -0.55 < out["atm_pe_delta"] < -0.35


def test_put_call_parity_delta_sums_to_one():
    """For European options at same strike: delta_CE - delta_PE ≈ 1."""
    out = compute_greek_features(
        spot=100, atm_strike=100,
        atm_ce_iv_pct=20.0, atm_pe_iv_pct=20.0,
        days_to_expiry=7.0,
    )
    # delta_CE - delta_PE = N(d1) - (N(d1) - 1) = 1, exactly
    assert (out["atm_ce_delta"] - out["atm_pe_delta"]) == pytest.approx(1.0)


def test_atm_gamma_positive():
    out = compute_greek_features(
        spot=100, atm_strike=100,
        atm_ce_iv_pct=20.0, atm_pe_iv_pct=20.0,
        days_to_expiry=7.0,
    )
    assert out["atm_gamma"] > 0


def test_long_options_have_negative_theta():
    out = compute_greek_features(
        spot=100, atm_strike=100,
        atm_ce_iv_pct=20.0, atm_pe_iv_pct=20.0,
        days_to_expiry=7.0,
    )
    # Both CE and PE long positions decay (negative theta)
    assert out["atm_ce_theta"] < 0
    assert out["atm_pe_theta"] < 0


def test_atm_vega_positive():
    """Vega is the same magnitude for CE/PE at same strike+IV."""
    out = compute_greek_features(
        spot=100, atm_strike=100,
        atm_ce_iv_pct=20.0, atm_pe_iv_pct=20.0,
        days_to_expiry=7.0,
    )
    assert out["atm_vega"] > 0


# ── Time-decay sensitivity ───────────────────────────────────────────────


def test_theta_more_negative_near_expiry():
    """Daily theta accelerates as DTE drops — 1 DTE theta should be more negative
    (in absolute terms) than 7 DTE theta."""
    far = compute_greek_features(100, 100, 20, 20, days_to_expiry=7.0)
    near = compute_greek_features(100, 100, 20, 20, days_to_expiry=1.0)
    assert near["atm_ce_theta"] < far["atm_ce_theta"]  # more negative


def test_gamma_explodes_near_expiry():
    """Gamma grows as expiry approaches at the ATM strike."""
    far = compute_greek_features(100, 100, 20, 20, days_to_expiry=7.0)
    near = compute_greek_features(100, 100, 20, 20, days_to_expiry=0.5)
    assert near["atm_gamma"] > far["atm_gamma"]


# ── Null rules ────────────────────────────────────────────────────────────


def test_missing_spot_yields_greeks_nan_but_iv_surfaces():
    """IV surfacing doesn't require spot; greeks do."""
    out = compute_greek_features(
        spot=None, atm_strike=100,
        atm_ce_iv_pct=18.0, atm_pe_iv_pct=17.0,
        days_to_expiry=5.0,
    )
    assert out["atm_ce_iv"] == pytest.approx(0.18)
    assert math.isnan(out["atm_ce_delta"])
    assert math.isnan(out["atm_gamma"])


def test_zero_dte_yields_greeks_nan():
    """At expiry T=0, BS formulas blow up — we surface IV and NaN the greeks."""
    out = compute_greek_features(
        spot=100, atm_strike=100,
        atm_ce_iv_pct=20, atm_pe_iv_pct=20,
        days_to_expiry=0.0,
    )
    assert out["atm_ce_iv"] == pytest.approx(0.20)
    assert math.isnan(out["atm_ce_delta"])
    assert math.isnan(out["atm_gamma"])


def test_negative_dte_yields_greeks_nan():
    out = compute_greek_features(100, 100, 20, 20, days_to_expiry=-0.5)
    assert math.isnan(out["atm_ce_delta"])
    assert math.isnan(out["atm_gamma"])


def test_invalid_iv_yields_nan_for_that_leg():
    """Bad CE IV but valid PE IV → CE greeks NaN, PE greeks computed."""
    out = compute_greek_features(
        spot=100, atm_strike=100,
        atm_ce_iv_pct=None, atm_pe_iv_pct=20.0,
        days_to_expiry=5.0,
    )
    assert math.isnan(out["atm_ce_iv"])
    assert math.isnan(out["atm_ce_delta"])
    assert out["atm_pe_iv"] == pytest.approx(0.20)
    # Gamma + vega fall back to PE side when CE missing
    assert not math.isnan(out["atm_pe_delta"])
    assert not math.isnan(out["atm_gamma"])


def test_zero_iv_treated_as_invalid():
    out = compute_greek_features(
        spot=100, atm_strike=100,
        atm_ce_iv_pct=0.0, atm_pe_iv_pct=0.0,
        days_to_expiry=5.0,
    )
    assert math.isnan(out["atm_ce_iv"])
    assert math.isnan(out["atm_pe_iv"])


def test_extreme_iv_treated_as_invalid():
    """IV > 500% is almost certainly broker glitch — treat as invalid."""
    out = compute_greek_features(
        spot=100, atm_strike=100,
        atm_ce_iv_pct=999.0, atm_pe_iv_pct=20.0,
        days_to_expiry=5.0,
    )
    assert math.isnan(out["atm_ce_iv"])
    assert out["atm_pe_iv"] == pytest.approx(0.20)
