"""TCS2 - tests for implied vol and Greeks.

Spec: docs/systems/14_tcs2.md D25

The central test is the round trip: price a chain at a known vol, then imply the
vol back from that price. Anything that breaks the solver shows up there, on far
strikes first.
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from tcs2 import greeks as g


# -- the normal CDF, since we implement it ourselves --------------------

def test_ndtr_matches_math_erf():
    """No scipy, so our CDF has to be pinned against the standard library."""
    xs = np.linspace(-8.0, 8.0, 4001)
    ours = g._ndtr(xs)
    theirs = np.array([0.5 * (1.0 + math.erf(x / math.sqrt(2.0))) for x in xs])
    assert np.max(np.abs(ours - theirs)) < 1.5e-7


def test_ndtr_endpoints():
    assert g._ndtr(np.array([0.0]))[0] == pytest.approx(0.5, abs=1e-9)
    assert g._ndtr(np.array([-40.0]))[0] == pytest.approx(0.0, abs=1e-12)
    assert g._ndtr(np.array([40.0]))[0] == pytest.approx(1.0, abs=1e-12)


def test_ndtr_is_monotonic():
    xs = np.linspace(-6, 6, 500)
    v = g._ndtr(xs)
    assert np.all(np.diff(v) >= -1e-12)


# -- pricing sanity ------------------------------------------------------

@pytest.mark.parametrize("on_futures", [True, False])
def test_put_call_parity(on_futures):
    u, k, t, sig = 23500.0, 23500.0, 7 / 365.0, 0.12
    c = g.price_and_greeks(u, k, t, sig, True, on_futures)["price"]
    p = g.price_and_greeks(u, k, t, sig, False, on_futures)["price"]
    df = math.exp(-g.DEFAULT_RATE * t)
    fwd = u if on_futures else u * math.exp(g.DEFAULT_RATE * t)
    assert float(c - p) == pytest.approx(df * (fwd - k), rel=1e-9)


@pytest.mark.parametrize("on_futures", [True, False])
def test_price_never_below_intrinsic(on_futures):
    u = 9000.0
    k = np.array([7000.0, 8000.0, 9000.0, 10000.0, 12000.0])
    call = np.array([True] * 5)
    t = 30 / 365.0
    px = g.price_and_greeks(u, k, t, 0.35, call, on_futures)["price"]
    # Model-aware bound: under Black-76 the payoff is discounted, so a deep ITM
    # option legitimately trades below an undiscounted F - K.
    assert np.all(px >= g.intrinsic(u, k, call, t, on_futures) - 1e-6)


def test_price_rises_with_vol():
    u, k, t = 23500.0, 23600.0, 7 / 365.0
    prev = -1.0
    for sig in (0.05, 0.10, 0.20, 0.40, 0.80):
        px = float(g.price_and_greeks(u, k, t, sig, True, False)["price"])
        assert px > prev
        prev = px


# -- greeks --------------------------------------------------------------

def test_call_and_put_delta_bounds_and_relationship():
    u, t, sig = 23500.0, 7 / 365.0, 0.12
    k = np.array([22000.0, 23500.0, 25000.0])
    c = g.price_and_greeks(u, k, t, sig, np.array([True] * 3), False)["delta"]
    p = g.price_and_greeks(u, k, t, sig, np.array([False] * 3), False)["delta"]
    assert np.all((c > 0) & (c < 1))
    assert np.all((p > -1) & (p < 0))
    assert np.allclose(c - p, 1.0, atol=1e-9)     # spot-model parity


def test_atm_delta_is_about_half():
    d = float(g.price_and_greeks(23500.0, 23500.0, 7 / 365.0, 0.12,
                                 True, False)["delta"])
    assert 0.45 < d < 0.60


def test_delta_matches_a_numeric_bump():
    """Delta must be the actual price sensitivity, not just a formula."""
    u, k, t, sig = 9000.0, 9050.0, 21 / 365.0, 0.30
    h = 0.01
    up = float(g.price_and_greeks(u + h, k, t, sig, True, True)["price"])
    dn = float(g.price_and_greeks(u - h, k, t, sig, True, True)["price"])
    numeric = (up - dn) / (2 * h)
    assert float(g.price_and_greeks(u, k, t, sig, True, True)["delta"]) == \
        pytest.approx(numeric, rel=1e-4)


def test_vega_matches_a_numeric_bump():
    u, k, t, sig = 23500.0, 23500.0, 7 / 365.0, 0.12
    h = 1e-5
    up = float(g.price_and_greeks(u, k, t, sig + h, True, False)["price"])
    dn = float(g.price_and_greeks(u, k, t, sig - h, True, False)["price"])
    assert float(g.price_and_greeks(u, k, t, sig, True, False)["vega"]) == \
        pytest.approx((up - dn) / (2 * h), rel=1e-4)


def test_gamma_is_highest_at_the_money():
    u, t, sig = 23500.0, 7 / 365.0, 0.12
    k = np.array([22500.0, 23500.0, 24500.0])
    gam = g.price_and_greeks(u, k, t, sig, np.array([True] * 3), False)["gamma"]
    assert gam[1] > gam[0] and gam[1] > gam[2]


def test_theta_is_negative_for_long_options():
    for call in (True, False):
        th = float(g.price_and_greeks(23500.0, 23500.0, 7 / 365.0, 0.12,
                                      call, False)["theta"])
        assert th < 0


def test_vega_collapses_on_far_strikes():
    """This is WHY Newton alone fails - and why bisection is not optional."""
    u, t, sig = 9000.0, 21 / 365.0, 0.30
    near = float(g.price_and_greeks(u, 9000.0, t, sig, True, True)["vega"])
    far = float(g.price_and_greeks(u, 13500.0, t, sig, True, True)["vega"])
    assert far < near / 1000.0


# -- the round trip ------------------------------------------------------

@pytest.mark.parametrize("on_futures,label", [(True, "MCX/Black-76"),
                                              (False, "NSE/Black-Scholes")])
def test_implied_vol_round_trip_across_a_whole_chain(on_futures, label):
    """Price at a known vol, imply it back. The accuracy claim in D25."""
    rng = np.random.default_rng(7)
    n = 1484
    u = 23476.0
    k = (17850 + 50 * rng.integers(0, 236, n)).astype(float)
    t = np.full(n, 7 / 365.0)
    call = rng.integers(0, 2, n).astype(bool)
    true_sig = rng.uniform(0.06, 0.90, n)

    px = g.price_and_greeks(u, k, t, true_sig, call, on_futures)["price"]
    got = g.implied_vol(px, u, k, t, call, on_futures)

    solved = ~np.isnan(got)
    assert solved.sum() > n * 0.5, f"{label}: too few legs solved"
    err = np.abs(got[solved] - true_sig[solved])
    assert err.max() < 1e-6, f"{label}: worst IV error {err.max():.2e}"
    # Whatever it refused to solve must be genuinely unidentifiable, not skipped
    # out of convenience: those legs carry negligible vega.
    if (~solved).any():
        vega = g.price_and_greeks(u, k[~solved], t[~solved], true_sig[~solved],
                                  call[~solved], on_futures)["vega"]
        assert np.all(vega < 1e-5 * u)


def test_far_strikes_specifically_round_trip():
    """The exact case a Newton-only solver got wrong by 0.17 on 2026-09-24."""
    u = 9040.0
    k = np.array([3200.0, 5000.0, 7000.0, 9000.0, 11000.0, 13500.0])
    t = np.full(6, 21 / 365.0)
    call = np.array([True] * 6)
    true_sig = np.full(6, 0.42)
    px = g.price_and_greeks(u, k, t, true_sig, call, True)["price"]
    got = g.implied_vol(px, u, k, t, call, True)
    solved = ~np.isnan(got)
    assert np.abs(got[solved] - 0.42).max() < 1e-6


# -- refusing to guess ---------------------------------------------------

def test_expired_options_return_nan_not_a_number():
    assert np.isnan(g.implied_vol(10.0, 23500.0, 23500.0, 0.0, True, False))


def test_price_at_or_below_intrinsic_returns_nan():
    """No time value left to imply a vol from - NaN, never a fabricated number."""
    u, k = 23500.0, 23000.0
    intr = float(g.intrinsic(u, k, True, 7 / 365.0, False))
    assert np.isnan(g.implied_vol(intr * 0.5, u, k, 7 / 365.0, True, False))


def test_absurdly_high_price_returns_nan():
    assert np.isnan(g.implied_vol(1e9, 23500.0, 23500.0, 7 / 365.0, True, False))


def test_zero_price_returns_nan():
    assert np.isnan(g.implied_vol(0.0, 23500.0, 23500.0, 7 / 365.0, True, False))


def test_nan_legs_do_not_poison_the_rest_of_the_chain():
    """One dead strike must not take the chain with it."""
    u = 23500.0
    k = np.array([23000.0, 23500.0, 24000.0])
    t = np.array([7 / 365.0, 7 / 365.0, 0.0])          # third one expired
    call = np.array([True, True, True])
    px = g.price_and_greeks(u, k, np.maximum(t, 1e-8), 0.12, call, False)["price"]
    got = g.implied_vol(px, u, k, t, call, False)
    assert not np.isnan(got[0]) and not np.isnan(got[1])
    assert np.isnan(got[2])


# -- the two models are genuinely different -----------------------------

def test_black76_and_black_scholes_disagree_as_expected():
    """MCX prices off the futures, NSE off spot (measured 2026-09-18).

    Using the wrong one would bias every IV and delta, so they must not be
    silently interchangeable.
    """
    u, k, t, sig = 23500.0, 23500.0, 30 / 365.0, 0.12
    b76 = float(g.price_and_greeks(u, k, t, sig, True, True)["price"])
    bs = float(g.price_and_greeks(u, k, t, sig, True, False)["price"])
    assert bs > b76                      # spot grows to a higher forward
    assert abs(bs - b76) > 1.0


# -- speed ---------------------------------------------------------------

def test_whole_chain_solves_fast_enough():
    """D25 claims 14 ms for a full chain. Budget generously; catch a blow-up."""
    import time
    n = 1484
    rng = np.random.default_rng(1)
    u = 23476.0
    k = (17850 + 50 * rng.integers(0, 236, n)).astype(float)
    t = np.full(n, 7 / 365.0)
    call = rng.integers(0, 2, n).astype(bool)
    px = g.price_and_greeks(u, k, t, 0.15, call, False)["price"]

    g.implied_vol(px, u, k, t, call, False)          # warm up
    t0 = time.perf_counter()
    g.implied_vol(px, u, k, t, call, False)
    elapsed = time.perf_counter() - t0
    assert elapsed < 0.5, f"full-chain IV took {elapsed * 1000:.0f} ms"


# -- refusing to report an unidentifiable vol ---------------------------

def test_vol_is_nan_where_the_premium_carries_no_vol_information():
    """Measured case: spot 23,476, strike 29,000, 7 days, vol 0.10.

    Price is 0.0000 and vega is 0.0000, so a one-paisa pricing difference would
    imply a vol error of 1e10. NaN is the only honest answer.
    """
    u, k, t = 23476.0, 29000.0, 7 / 365.0
    px = g.price_and_greeks(u, k, t, 0.10, True, False)["price"]
    assert float(px) < 1e-9
    assert np.isnan(g.implied_vol(px, u, k, t, True, False))


def test_vol_space_convergence_beats_price_space():
    """A far strike where a tiny PRICE residual hides a large VOL error.

    This is the case a price-based convergence check passed with a 3.1e-4 vol
    error on the first attempt.
    """
    u, t = 23476.0, 7 / 365.0
    k = np.array([26000.0, 27000.0, 28000.0])
    call = np.array([True] * 3)
    true_sig = np.array([0.62, 0.71, 0.83])
    px = g.price_and_greeks(u, k, t, true_sig, call, False)["price"]
    got = g.implied_vol(px, u, k, t, call, False)
    solved = ~np.isnan(got)
    assert solved.any()
    assert np.abs(got[solved] - true_sig[solved]).max() < 1e-6
