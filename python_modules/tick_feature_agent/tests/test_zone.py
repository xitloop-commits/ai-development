"""
tests/test_zone.py — Unit tests for features/zone.py (§8.12 Zone Pressure).

Run: python -m pytest python_modules/tick_feature_agent/tests/test_zone.py -v
"""

from __future__ import annotations

import math
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG  = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.chain_cache import ChainCache
from tick_feature_agent.feed.chain_poller import ChainSnapshot
from tick_feature_agent.features.active_strikes import StrikeScore, compute_strike_scores, select_active_strikes
from tick_feature_agent.features.zone import compute_zone_features


# ── Helpers ───────────────────────────────────────────────────────────────────

_NAN = float("nan")

def _nan(v) -> bool:
    return isinstance(v, float) and math.isnan(v)


ALL_STRIKES = list(range(23800, 24400, 50))   # 12 strikes in chain
ATM_WINDOW  = [23950, 24000, 24050, 24100, 24150, 24200, 24250]  # 7 ATM±3


def _row(strike: int, call_oi_chg: float = 0.0, put_oi_chg: float = 0.0,
         call_vol: float = 0.0, put_vol: float = 0.0) -> dict:
    return {
        "strike":         strike,
        "callOI":         1000,     "putOI":        1000,
        "callOIChange":   call_oi_chg, "putOIChange": put_oi_chg,
        "callVolume":     call_vol,  "putVolume":   put_vol,
        "callSecurityId": str(strike * 2),
        "putSecurityId":  str(strike * 2 + 1),
        "callLTP": 100.0, "putLTP": 100.0,
    }


def _make_snapshot(rows: list[dict], spot: float = 24100.0) -> ChainSnapshot:
    sec_id_map = {str(r["callSecurityId"]): (int(r["strike"]), "CE") for r in rows}
    sec_id_map.update({str(r["putSecurityId"]): (int(r["strike"]), "PE") for r in rows})
    return ChainSnapshot(
        spot_price=spot, expiry="2026-04-24",
        timestamp_sec=time.time(), rows=rows,
        strike_step=50, sec_id_map=sec_id_map,
    )


def _cache_no_chain() -> ChainCache:
    return ChainCache()


def _cache_all_zero_activity() -> ChainCache:
    """All OI changes = 0, no prev snapshot → all call/put strengths = 0."""
    rows = [_row(s) for s in ALL_STRIKES]
    c = ChainCache()
    c.update_from_snapshot(_make_snapshot(rows))
    return c


def _cache_call_dominant_atm() -> ChainCache:
    """
    All chain strikes have callOIChange=10, putOIChange=0.
    Normalization: all-equal non-zero → call_soi=1.0, all-zero → put_soi=0.0.
    call_strength=0.5, put_strength=0.0 for all ATM strikes.
    """
    rows = [_row(s, call_oi_chg=10.0, put_oi_chg=0.0) for s in ALL_STRIKES]
    c = ChainCache()
    c.update_from_snapshot(_make_snapshot(rows))
    return c


def _cache_put_dominant_atm() -> ChainCache:
    """
    All chain strikes have callOIChange=0, putOIChange=10.
    call_strength=0.0, put_strength=0.5 for all ATM strikes.
    """
    rows = [_row(s, call_oi_chg=0.0, put_oi_chg=10.0) for s in ALL_STRIKES]
    c = ChainCache()
    c.update_from_snapshot(_make_snapshot(rows))
    return c


def _cache_mixed_strengths() -> ChainCache:
    """
    Strike 24100: callOIChange=100, putOIChange=0   → call-dominant
    Strike 24050: callOIChange=0,   putOIChange=100 → put-dominant
    Strike 24150: callOIChange=50,  putOIChange=0   → call-dominant (strength 0.5)
    All other strikes: callOIChange=0, putOIChange=0 → all zero

    After cross-chain normalization:
      call_ois = [0, 0, 0, 50, 100, 0, 0, ...] → normalize: 24100=1.0, 24150=0.5, others=0.0
      put_ois  = [0, 0, 100, 0, 0, 0, 0, ...]  → normalize: 24050=1.0, others=0.0

    call_strength: 24100=(0+1.0)/2=0.5, 24150=(0+0.5)/2=0.25, others=0
    put_strength:  24050=(0+1.0)/2=0.5, others=0

    Active strikes set to [24100, 24050, 24150].
    """
    rows = []
    for s in ALL_STRIKES:
        if s == 24100:
            rows.append(_row(s, call_oi_chg=100.0, put_oi_chg=0.0))
        elif s == 24050:
            rows.append(_row(s, call_oi_chg=0.0, put_oi_chg=100.0))
        elif s == 24150:
            rows.append(_row(s, call_oi_chg=50.0, put_oi_chg=0.0))
        else:
            rows.append(_row(s))

    snap = _make_snapshot(rows)
    c = ChainCache()
    c.update_from_snapshot(snap)
    # Inject active strikes (only 3 for these tests)
    prev_rows = None
    scores = compute_strike_scores(snap.rows, prev_rows)
    c.active_strikes = [
        s for s in scores if s.strike in (24100, 24050, 24150)
    ]
    return c


# ══════════════════════════════════════════════════════════════════════════════

class TestZoneFeatureKeys:

    def test_all_keys_present(self):
        out = compute_zone_features(_cache_no_chain(), ATM_WINDOW)
        expected = {
            "atm_zone_call_pressure",
            "atm_zone_put_pressure",
            "atm_zone_net_pressure",
            "active_zone_call_count",
            "active_zone_put_count",
            "active_zone_dominance",
            "zone_activity_score",
        }
        assert set(out.keys()) == expected

    def test_exactly_7_keys(self):
        out = compute_zone_features(_cache_no_chain(), ATM_WINDOW)
        assert len(out) == 7


class TestNullsWhenChainUnavailable:

    def test_call_pressure_nan(self):
        out = compute_zone_features(_cache_no_chain(), ATM_WINDOW)
        assert _nan(out["atm_zone_call_pressure"])

    def test_put_pressure_nan(self):
        out = compute_zone_features(_cache_no_chain(), ATM_WINDOW)
        assert _nan(out["atm_zone_put_pressure"])

    def test_net_pressure_nan(self):
        out = compute_zone_features(_cache_no_chain(), ATM_WINDOW)
        assert _nan(out["atm_zone_net_pressure"])

    def test_zone_activity_score_nan(self):
        out = compute_zone_features(_cache_no_chain(), ATM_WINDOW)
        assert _nan(out["zone_activity_score"])

    def test_call_count_zero(self):
        """active_zone counts are 0 (not NaN) when chain unavailable."""
        out = compute_zone_features(_cache_no_chain(), ATM_WINDOW)
        assert out["active_zone_call_count"] == 0

    def test_put_count_zero(self):
        out = compute_zone_features(_cache_no_chain(), ATM_WINDOW)
        assert out["active_zone_put_count"] == 0

    def test_dominance_zero(self):
        out = compute_zone_features(_cache_no_chain(), ATM_WINDOW)
        assert out["active_zone_dominance"] == pytest.approx(0.0)


class TestPressureComputation:

    def test_zero_pressure_when_all_activity_zero(self):
        """
        All OI changes = 0 and no prev snapshot → all strengths = 0.0.
        Pressure = 0 / 7 = 0.
        """
        cache = _cache_all_zero_activity()
        out = compute_zone_features(cache, ATM_WINDOW)
        assert out["atm_zone_call_pressure"] == pytest.approx(0.0)
        assert out["atm_zone_put_pressure"] == pytest.approx(0.0)

    def test_call_pressure_from_snapshot(self):
        """
        All strikes: callOIChange=10, putOIChange=0.
        All-equal non-zero call_soi=1.0, put_soi=0.0 → call_strength=0.5, put_strength=0.
        call_pressure = 7 * 0.5 / 7 = 0.5.
        """
        cache = _cache_call_dominant_atm()
        out = compute_zone_features(cache, ATM_WINDOW)
        assert out["atm_zone_call_pressure"] == pytest.approx(0.5)
        assert out["atm_zone_put_pressure"] == pytest.approx(0.0)

    def test_put_pressure_from_snapshot(self):
        """All strikes: callOIChange=0, putOIChange=10 → put_strength=0.5, call=0."""
        cache = _cache_put_dominant_atm()
        out = compute_zone_features(cache, ATM_WINDOW)
        assert out["atm_zone_call_pressure"] == pytest.approx(0.0)
        assert out["atm_zone_put_pressure"] == pytest.approx(0.5)

    def test_net_pressure_positive_when_call_dominant(self):
        cache = _cache_call_dominant_atm()
        out = compute_zone_features(cache, ATM_WINDOW)
        assert out["atm_zone_net_pressure"] == pytest.approx(0.5)

    def test_net_pressure_negative_when_put_dominant(self):
        cache = _cache_put_dominant_atm()
        out = compute_zone_features(cache, ATM_WINDOW)
        assert out["atm_zone_net_pressure"] == pytest.approx(-0.5)

    def test_zone_activity_score_is_average(self):
        """zone_activity_score = (call_pressure + put_pressure) / 2."""
        cache = _cache_call_dominant_atm()
        out = compute_zone_features(cache, ATM_WINDOW)
        expected = (out["atm_zone_call_pressure"] + out["atm_zone_put_pressure"]) / 2
        assert out["zone_activity_score"] == pytest.approx(expected)

    def test_only_atm_window_strikes_included(self):
        """
        Non-ATM strikes' strengths don't influence ATM pressure even if high.
        """
        # Strike 23800 (outside ATM_WINDOW) has high callOIChange, ATM strikes have 0
        rows = [_row(s) for s in ALL_STRIKES]
        rows[0] = _row(23800, call_oi_chg=1000.0)   # non-ATM strike
        cache = ChainCache()
        cache.update_from_snapshot(_make_snapshot(rows))
        out = compute_zone_features(cache, ATM_WINDOW)
        # ATM strikes all have callOIChange=0 → min normalized call_soi=0.0
        # (but 23800 has 1000 → it gets 1.0, ATM strikes get 0.0)
        # → call_pressure = 0 / 7 = 0
        assert out["atm_zone_call_pressure"] == pytest.approx(0.0)

    def test_partial_atm_in_snapshot(self):
        """Strikes absent from snapshot contribute 0.0 (per spec null rule)."""
        # Only put some ATM strikes in the snapshot
        rows = [_row(s, call_oi_chg=10.0) for s in ALL_STRIKES if s != 24100]
        cache = ChainCache()
        cache.update_from_snapshot(_make_snapshot(rows))
        out = compute_zone_features(cache, ATM_WINDOW)
        # 6 out of 7 ATM strikes present with call_strength=0.5; absent=0.0
        assert out["atm_zone_call_pressure"] == pytest.approx(6 * 0.5 / 7)


class TestActiveCounts:

    def test_zero_counts_when_no_active_strikes(self):
        cache = _cache_all_zero_activity()
        cache.active_strikes = []
        out = compute_zone_features(cache, ATM_WINDOW)
        assert out["active_zone_call_count"] == 0
        assert out["active_zone_put_count"] == 0

    def test_call_count_when_call_strength_dominates(self):
        """24100 has callOIChange=100, putOIChange=0 → call_strength > put_strength."""
        cache = _cache_mixed_strengths()
        out = compute_zone_features(cache, ATM_WINDOW)
        # 24100 (call=0.5, put=0) and 24150 (call=0.25, put=0) are call-dominant
        assert out["active_zone_call_count"] == 2

    def test_put_count_when_put_strength_dominates(self):
        """24050 has callOIChange=0, putOIChange=100 → put_strength > call_strength."""
        cache = _cache_mixed_strengths()
        out = compute_zone_features(cache, ATM_WINDOW)
        # 24050 (call=0, put=0.5) is put-dominant
        assert out["active_zone_put_count"] == 1

    def test_ties_excluded_from_both_counts(self):
        """All-zero strengths → all ties → both counts = 0."""
        cache = _cache_all_zero_activity()
        # Inject one active strike
        scores = compute_strike_scores(cache.snapshot.rows, None)
        cache.active_strikes = [s for s in scores if s.strike == 24100]
        out = compute_zone_features(cache, ATM_WINDOW)
        # 24100 has call_strength=0.0 = put_strength=0.0 → tie
        assert out["active_zone_call_count"] == 0
        assert out["active_zone_put_count"] == 0

    def test_dominance_formula(self):
        """
        cache_mixed_strengths: call_count=2, put_count=1
        dominance = (2-1) / max(3,1) = 1/3.
        """
        cache = _cache_mixed_strengths()
        out = compute_zone_features(cache, ATM_WINDOW)
        assert out["active_zone_dominance"] == pytest.approx(1.0 / 3)

    def test_dominance_zero_when_balanced(self):
        """call_count == put_count → dominance = 0."""
        # One call-dominant, one put-dominant active strike
        rows = []
        for s in ALL_STRIKES:
            if s == 24100:
                rows.append(_row(s, call_oi_chg=100.0, put_oi_chg=0.0))
            elif s == 24050:
                rows.append(_row(s, call_oi_chg=0.0, put_oi_chg=100.0))
            else:
                rows.append(_row(s))
        snap = _make_snapshot(rows)
        c = ChainCache()
        c.update_from_snapshot(snap)
        scores = compute_strike_scores(snap.rows, None)
        c.active_strikes = [s for s in scores if s.strike in (24100, 24050)]
        out = compute_zone_features(c, ATM_WINDOW)
        assert out["active_zone_dominance"] == pytest.approx(0.0)

    def test_dominance_zero_when_no_active_strikes(self):
        """active_strike_count = 0 → both counts = 0, dominance = 0.0."""
        cache = _cache_all_zero_activity()
        cache.active_strikes = []
        out = compute_zone_features(cache, ATM_WINDOW)
        assert out["active_zone_dominance"] == pytest.approx(0.0)
