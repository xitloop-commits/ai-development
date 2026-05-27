"""
tests/test_dealer_hedging_columnar.py — T50 B.3d equivalence tests.

Verifies that ``compute_dealer_hedging_features_vec`` (numpy
vectorised) matches ``dealer_hedging.compute_dealer_hedging_features``
(scalar) bit-for-bit modulo float epsilon on synthetic chains.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from tick_feature_agent.features.dealer_hedging import (
    compute_dealer_hedging_features,
)
from tick_feature_agent.features.dealer_hedging_columnar import (
    compute_dealer_hedging_features_vec,
)


_KEYS = (
    "net_gex",
    "gamma_flip_distance_pct",
    "dealer_net_delta",
    "charm_estimate_atm",
    "vanna_estimate_atm",
)


def _eq(a, b, *, abs_tol: float = 1e-6, rel_tol: float = 1e-9) -> bool:
    """Slightly looser than usual — Black-Scholes erf via scipy vs
    math.erf can differ by ~1e-16 per value, which amplifies to ~1e-9
    after multiplication by spot². 1e-6 abs is plenty for our scale."""
    a_missing = a is None or (isinstance(a, float) and math.isnan(a))
    b_missing = b is None or (isinstance(b, float) and math.isnan(b))
    if a_missing and b_missing:
        return True
    if a_missing != b_missing:
        return False
    return abs(a - b) <= abs_tol + rel_tol * abs(a)


def _both(spot, rows, dte, hist, now_ts):
    s = compute_dealer_hedging_features(spot, rows, dte, hist, now_ts)
    v = compute_dealer_hedging_features_vec(spot, rows, dte, hist, now_ts)
    return s, v


def _assert_equiv(s, v):
    for k in _KEYS:
        assert _eq(s[k], v[k]), f"{k}: scalar={s[k]!r} vec={v[k]!r}"


def _row(strike, *, ce_oi=10_000, pe_oi=10_000, ce_iv=18.0, pe_iv=18.0):
    return {
        "strike": strike,
        "callOI": ce_oi,
        "putOI": pe_oi,
        "callIV": ce_iv,
        "putIV": pe_iv,
    }


def test_realistic_atm_chain_matches_scalar():
    """5-strike chain bracketing spot, typical 30-day expiry, realistic IVs."""
    spot = 25_000.0
    rows = [
        _row(24_800, ce_oi=15_000, pe_oi=80_000, ce_iv=22.0, pe_iv=19.0),
        _row(24_900, ce_oi=25_000, pe_oi=60_000, ce_iv=20.0, pe_iv=18.5),
        _row(25_000, ce_oi=90_000, pe_oi=90_000, ce_iv=18.0, pe_iv=18.0),
        _row(25_100, ce_oi=60_000, pe_oi=25_000, ce_iv=18.5, pe_iv=20.0),
        _row(25_200, ce_oi=80_000, pe_oi=15_000, ce_iv=19.0, pe_iv=22.0),
    ]
    s, v = _both(spot, rows, 30.0, None, None)
    _assert_equiv(s, v)


def test_no_spot_yields_all_nan():
    s, v = _both(None, [_row(25_000)], 30.0, None, None)
    _assert_equiv(s, v)


def test_no_chain_rows_yields_all_nan():
    s, v = _both(25_000.0, [], 30.0, None, None)
    _assert_equiv(s, v)


def test_zero_dte_yields_all_nan():
    s, v = _both(25_000.0, [_row(25_000)], 0.0, None, None)
    _assert_equiv(s, v)


def test_charm_and_vanna_from_history():
    """5-min lookback in atm_delta_history should produce non-NaN
    charm + vanna. Build a history where delta and IV have moved enough."""
    spot = 25_000.0
    rows = [_row(25_000)]
    now_ts = 1000.0
    # history: (ts, delta, iv) - need a baseline at now-300s and a current
    history = [
        (now_ts - 300.0, 0.50, 0.18),  # baseline
        (now_ts - 200.0, 0.52, 0.185),
        (now_ts,         0.55, 0.19),   # current
    ]
    s, v = _both(spot, rows, 30.0, history, now_ts)
    _assert_equiv(s, v)
    assert isinstance(s["charm_estimate_atm"], float)
    assert not math.isnan(s["charm_estimate_atm"])
    assert isinstance(s["vanna_estimate_atm"], float)
    assert not math.isnan(s["vanna_estimate_atm"])


def test_history_baseline_too_old_yields_charm_nan():
    """Baseline > 30s before target (now - 300s) -> baseline rejected ->
    charm/vanna NaN."""
    spot = 25_000.0
    rows = [_row(25_000)]
    now_ts = 1000.0
    history = [
        (now_ts - 400.0, 0.50, 0.18),  # too old (>30s before target=700)
        (now_ts,         0.55, 0.19),
    ]
    s, v = _both(spot, rows, 30.0, history, now_ts)
    _assert_equiv(s, v)
    assert math.isnan(s["charm_estimate_atm"])
    assert math.isnan(s["vanna_estimate_atm"])


def test_invalid_iv_strike_skipped():
    """A row with IV outside (0, 500) should be skipped — matches scalar's
    _safe_iv_pct rejection. The remaining strikes still produce features."""
    spot = 25_000.0
    rows = [
        _row(24_900, ce_iv=20.0, pe_iv=20.0),
        _row(25_000, ce_iv=999.0, pe_iv=999.0),  # IV >= 500 -> rejected
        _row(25_100, ce_iv=20.0, pe_iv=20.0),
    ]
    s, v = _both(spot, rows, 30.0, None, None)
    _assert_equiv(s, v)


def test_gamma_flip_with_asymmetric_oi():
    """OI concentrated above spot -> gamma flip should be at/near a strike
    near the dominant cluster."""
    spot = 25_000.0
    rows = [
        _row(24_800, ce_oi=5_000,  pe_oi=5_000),
        _row(24_900, ce_oi=5_000,  pe_oi=5_000),
        _row(25_000, ce_oi=10_000, pe_oi=10_000),
        _row(25_100, ce_oi=100_000, pe_oi=10_000),  # huge call OI here
        _row(25_200, ce_oi=200_000, pe_oi=10_000),
    ]
    s, v = _both(spot, rows, 30.0, None, None)
    _assert_equiv(s, v)
