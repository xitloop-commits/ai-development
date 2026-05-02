"""
tests/test_active_features.py — Unit tests for features/active_features.py.
§8.6–8.7 Per-slot active strike features + cross-feature intelligence.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_active_features.py -v
"""

from __future__ import annotations

import math
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.buffers.option_buffer import OptionBufferStore, OptionTick
from tick_feature_agent.chain_cache import ChainCache
from tick_feature_agent.features.active_features import (
    compute_active_features,
    compute_side_strengths,
)
from tick_feature_agent.features.active_strikes import StrikeScore
from tick_feature_agent.feed.chain_poller import ChainSnapshot

_NAN = float("nan")


def _nan(v) -> bool:
    return isinstance(v, float) and math.isnan(v)


# ── Snapshot / cache helpers ──────────────────────────────────────────────────

ALL_STRIKES = list(range(23800, 24400, 50))  # 12 strikes, step 50


def _row(
    strike: int,
    call_oi_chg: float = 0.0,
    put_oi_chg: float = 0.0,
    call_vol: float = 0.0,
    put_vol: float = 0.0,
) -> dict:
    return {
        "strike": strike,
        "callOI": 1000,
        "putOI": 1000,
        "callOIChange": call_oi_chg,
        "putOIChange": put_oi_chg,
        "callVolume": call_vol,
        "putVolume": put_vol,
        "callSecurityId": str(strike * 2),
        "putSecurityId": str(strike * 2 + 1),
        "callLTP": 100.0,
        "putLTP": 100.0,
    }


def _make_snapshot(rows: list[dict], spot: float = 24100.0) -> ChainSnapshot:
    sec_id_map = {str(r["callSecurityId"]): (int(r["strike"]), "CE") for r in rows}
    sec_id_map.update({str(r["putSecurityId"]): (int(r["strike"]), "PE") for r in rows})
    return ChainSnapshot(
        spot_price=spot,
        expiry="2026-04-24",
        timestamp_sec=time.time(),
        rows=rows,
        strike_step=50,
        sec_id_map=sec_id_map,
    )


def _make_cache(
    rows: list[dict] | None = None,
    spot: float = 24100.0,
    add_prev: bool = False,
) -> ChainCache:
    """Create ChainCache with one (or two) snapshots."""
    if rows is None:
        rows = [_row(s) for s in ALL_STRIKES]
    c = ChainCache()
    if add_prev:
        prev_rows = [_row(s) for s in ALL_STRIKES]
        c.update_from_snapshot(_make_snapshot(prev_rows, spot))
    c.update_from_snapshot(_make_snapshot(rows, spot))
    return c


def _empty_store() -> OptionBufferStore:
    return OptionBufferStore(maxlen=10)


def _tick(
    ts: float,
    ltp: float = 100.0,
    bid: float = 99.0,
    ask: float = 101.0,
    bid_size: int = 10,
    ask_size: int = 10,
    volume: int = 1000,
) -> OptionTick:
    return OptionTick(
        timestamp=ts,
        ltp=ltp,
        bid=bid,
        ask=ask,
        bid_size=bid_size,
        ask_size=ask_size,
        volume=volume,
    )


def _store_with_tick(strike: int, opt_type: str, tick: OptionTick) -> OptionBufferStore:
    store = OptionBufferStore(maxlen=10)
    store.push(strike, opt_type, tick)
    return store


# ══════════════════════════════════════════════════════════════════════════════
# compute_side_strengths
# ══════════════════════════════════════════════════════════════════════════════


class TestComputeSideStrengths:

    def test_empty_rows_returns_empty_dict(self):
        assert compute_side_strengths([], None) == {}

    def test_returns_six_tuple_per_strike(self):
        rows = [_row(24100, call_oi_chg=10.0)]
        result = compute_side_strengths(rows, None)
        assert 24100 in result
        assert len(result[24100]) == 6

    def test_no_prev_rows_vol_scores_are_zero(self):
        """prev_rows=None → all vol_diffs=0 → call_sv=put_sv=0.0."""
        rows = [_row(24100, call_oi_chg=10.0, put_oi_chg=5.0, call_vol=500.0, put_vol=300.0)]
        result = compute_side_strengths(rows, None)
        call_sv, call_soi, call_str, put_sv, put_soi, put_str = result[24100]
        assert call_sv == pytest.approx(0.0)
        assert put_sv == pytest.approx(0.0)

    def test_all_zero_oi_returns_zero_strengths(self):
        rows = [_row(s, call_oi_chg=0.0, put_oi_chg=0.0) for s in [24050, 24100, 24150]]
        result = compute_side_strengths(rows, None)
        for strike in [24050, 24100, 24150]:
            _, call_soi, call_str, _, put_soi, put_str = result[strike]
            assert call_soi == pytest.approx(0.0)
            assert put_soi == pytest.approx(0.0)
            assert call_str == pytest.approx(0.0)
            assert put_str == pytest.approx(0.0)

    def test_all_equal_nonzero_oi_returns_1_0(self):
        """All-equal non-zero OI → each strike normalized to 1.0."""
        rows = [_row(s, call_oi_chg=50.0, put_oi_chg=50.0) for s in [24050, 24100, 24150]]
        result = compute_side_strengths(rows, None)
        for strike in [24050, 24100, 24150]:
            _, call_soi, _, _, put_soi, _ = result[strike]
            assert call_soi == pytest.approx(1.0)
            assert put_soi == pytest.approx(1.0)

    def test_min_max_normalization_oi(self):
        """High-OI strike → 1.0, low-OI strike → 0.0, mid-OI interpolates."""
        rows = [
            _row(24050, call_oi_chg=0.0),
            _row(24100, call_oi_chg=50.0),
            _row(24150, call_oi_chg=100.0),
        ]
        result = compute_side_strengths(rows, None)
        _, soi_low, _, _, _, _ = result[24050]
        _, soi_mid, _, _, _, _ = result[24100]
        _, soi_high, _, _, _, _ = result[24150]
        assert soi_high == pytest.approx(1.0)
        assert soi_low == pytest.approx(0.0)
        assert soi_mid == pytest.approx(0.5)

    def test_call_strength_is_average_of_sv_and_soi(self):
        rows = [_row(24100, call_oi_chg=100.0)]
        result = compute_side_strengths(rows, None)
        call_sv, call_soi, call_str, _, _, _ = result[24100]
        assert call_str == pytest.approx((call_sv + call_soi) / 2.0)

    def test_vol_diff_clamped_to_zero(self):
        """Vol decreases (prev > curr) → clamped to 0 (intraday vol is non-decreasing)."""
        curr_rows = [_row(24100, call_vol=50.0)]
        prev_rows = [_row(24100, call_vol=200.0)]  # prev > curr
        result = compute_side_strengths(curr_rows, prev_rows)
        call_sv, _, _, _, _, _ = result[24100]
        assert call_sv == pytest.approx(0.0)

    def test_vol_diff_computed_with_prev_rows(self):
        """Vol_diff = current_vol - prev_vol; min-max normalized across strikes."""
        curr_rows = [
            _row(24050, call_vol=200.0),
            _row(24100, call_vol=400.0),
        ]
        prev_rows = [
            _row(24050, call_vol=100.0),
            _row(24100, call_vol=100.0),
        ]
        result = compute_side_strengths(curr_rows, prev_rows)
        # diffs: 24050=100, 24100=300 → min=100, max=300, span=200
        # 24050: (100-100)/200 = 0.0,  24100: (300-100)/200 = 1.0
        call_sv_low, _, _, _, _, _ = result[24050]
        call_sv_high, _, _, _, _, _ = result[24100]
        assert call_sv_low == pytest.approx(0.0)
        assert call_sv_high == pytest.approx(1.0)

    def test_all_strikes_in_snapshot_present_in_result(self):
        rows = [_row(s) for s in ALL_STRIKES]
        result = compute_side_strengths(rows, None)
        assert set(result.keys()) == set(ALL_STRIKES)


# ══════════════════════════════════════════════════════════════════════════════
# compute_active_features: output structure
# ══════════════════════════════════════════════════════════════════════════════


class TestActiveFeatureKeys:

    def test_key_count_is_148(self):
        cache = _make_cache()
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert len(out) == 148

    def test_all_slot_prefixes_present(self):
        cache = _make_cache()
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        for slot in range(6):
            assert f"active_{slot}_strike" in out
            assert f"active_{slot}_tick_available" in out
            assert f"active_{slot}_call_strength" in out
            assert f"active_{slot}_put_strength" in out

    def test_all_24_per_slot_keys_present(self):
        slot_keys = (
            "strike",
            "distance_from_spot",
            "tick_available",
            "call_strength_volume",
            "call_strength_oi",
            "call_strength",
            "call_ltp",
            "call_bid",
            "call_ask",
            "call_spread",
            "call_volume",
            "call_bid_ask_imbalance",
            "call_premium_momentum",
            "put_strength_volume",
            "put_strength_oi",
            "put_strength",
            "put_ltp",
            "put_bid",
            "put_ask",
            "put_spread",
            "put_volume",
            "put_bid_ask_imbalance",
            "put_premium_momentum",
            "tick_age_sec",
        )
        cache = _make_cache()
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        for slot in range(6):
            for k in slot_keys:
                assert f"active_{slot}_{k}" in out

    def test_cross_feature_keys_present(self):
        cache = _make_cache()
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        for k in (
            "call_put_strength_diff",
            "call_put_volume_diff",
            "call_put_oi_diff",
            "premium_divergence",
        ):
            assert k in out


# ══════════════════════════════════════════════════════════════════════════════
# Chain unavailable
# ══════════════════════════════════════════════════════════════════════════════


class TestChainUnavailable:

    def test_all_slots_tick_available_zero(self):
        cache = ChainCache()  # no snapshot
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        for slot in range(6):
            assert out[f"active_{slot}_tick_available"] == 0

    def test_all_slots_strike_nan(self):
        cache = ChainCache()
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        for slot in range(6):
            assert _nan(out[f"active_{slot}_strike"])

    def test_cross_features_nan_when_no_chain(self):
        cache = ChainCache()
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        for k in (
            "call_put_strength_diff",
            "call_put_volume_diff",
            "call_put_oi_diff",
            "premium_divergence",
        ):
            assert _nan(out[k])


# ══════════════════════════════════════════════════════════════════════════════
# Empty slots
# ══════════════════════════════════════════════════════════════════════════════


class TestEmptySlots:

    def test_all_slots_empty_when_no_active_strikes(self):
        cache = _make_cache()
        cache.active_strikes = []
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        for slot in range(6):
            assert _nan(out[f"active_{slot}_strike"])
            assert out[f"active_{slot}_tick_available"] == 0

    def test_overflow_slots_empty_when_fewer_than_6_active(self):
        """2 active strikes → slots 2–5 must be empty."""
        cache = _make_cache()
        cache.active_strikes = [
            StrikeScore(strike=24100, vol_score=0.0, oi_score=1.0, strength=1.0),
            StrikeScore(strike=24050, vol_score=0.0, oi_score=0.5, strength=0.5),
        ]
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        for slot in [2, 3, 4, 5]:
            assert _nan(out[f"active_{slot}_strike"])
            assert out[f"active_{slot}_tick_available"] == 0

    def test_premium_divergence_nan_when_no_active_strikes(self):
        cache = _make_cache()
        cache.active_strikes = []
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert _nan(out["premium_divergence"])

    def test_call_put_strength_diff_zero_when_no_active_strikes(self):
        """No active strikes → strength sums both 0 → diff = 0.0."""
        cache = _make_cache()
        cache.active_strikes = []
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert out["call_put_strength_diff"] == pytest.approx(0.0)


# ══════════════════════════════════════════════════════════════════════════════
# Per-slot features
# ══════════════════════════════════════════════════════════════════════════════


class TestPerSlotFeatures:

    def _cache_one_active(self, strike: int = 24100) -> ChainCache:
        """Cache with one active strike that has a dominant call side."""
        rows = [_row(s, call_oi_chg=100.0 if s == strike else 0.0) for s in ALL_STRIKES]
        cache = _make_cache(rows)
        cache.active_strikes = [
            StrikeScore(strike=strike, vol_score=0.0, oi_score=1.0, strength=1.0)
        ]
        return cache

    def test_slot_strike_value(self):
        cache = self._cache_one_active(24100)
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert out["active_0_strike"] == pytest.approx(24100.0)

    def test_slot_distance_from_spot(self):
        """distance_from_spot = strike - spot_price."""
        cache = self._cache_one_active(24100)
        out = compute_active_features(cache, _empty_store(), 1000.0, 24050.0)
        assert out["active_0_distance_from_spot"] == pytest.approx(50.0)

    def test_tick_available_zero_when_no_ticks(self):
        cache = self._cache_one_active(24100)
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert out["active_0_tick_available"] == 0

    def test_tick_available_one_when_call_tick(self):
        cache = self._cache_one_active(24100)
        store = _store_with_tick(24100, "CE", _tick(ts=999.0))
        out = compute_active_features(cache, store, 1000.0, 24100.0)
        assert out["active_0_tick_available"] == 1

    def test_tick_available_one_when_put_tick_only(self):
        """Put tick alone → tick_available = 1."""
        cache = self._cache_one_active(24100)
        store = _store_with_tick(24100, "PE", _tick(ts=999.0))
        out = compute_active_features(cache, store, 1000.0, 24100.0)
        assert out["active_0_tick_available"] == 1

    def test_call_ltp_nan_when_no_tick(self):
        cache = self._cache_one_active(24100)
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert _nan(out["active_0_call_ltp"])

    def test_call_ltp_from_tick(self):
        cache = self._cache_one_active(24100)
        store = _store_with_tick(24100, "CE", _tick(ts=999.0, ltp=250.0))
        out = compute_active_features(cache, store, 1000.0, 24100.0)
        assert out["active_0_call_ltp"] == pytest.approx(250.0)

    def test_call_spread_from_bid_ask(self):
        """call_spread = ask - bid."""
        cache = self._cache_one_active(24100)
        store = _store_with_tick(24100, "CE", _tick(ts=999.0, bid=98.0, ask=102.0))
        out = compute_active_features(cache, store, 1000.0, 24100.0)
        assert out["active_0_call_spread"] == pytest.approx(4.0)

    def test_put_ltp_nan_when_no_put_tick(self):
        """Call tick available but put absent → put features NaN."""
        cache = self._cache_one_active(24100)
        store = _store_with_tick(24100, "CE", _tick(ts=999.0))
        out = compute_active_features(cache, store, 1000.0, 24100.0)
        assert _nan(out["active_0_put_ltp"])

    def test_tick_age_sec(self):
        """tick_age_sec = current_time - most_recent_tick_time."""
        cache = self._cache_one_active(24100)
        store = _store_with_tick(24100, "CE", _tick(ts=990.0))
        out = compute_active_features(cache, store, 1000.0, 24100.0)
        assert out["active_0_tick_age_sec"] == pytest.approx(10.0)

    def test_tick_age_uses_min_of_call_and_put(self):
        """tick_age = min(age_call, age_put) — uses the freshest side."""
        cache = self._cache_one_active(24100)
        store = OptionBufferStore(maxlen=10)
        store.push(24100, "CE", _tick(ts=980.0))  # older call
        store.push(24100, "PE", _tick(ts=995.0))  # fresher put
        out = compute_active_features(cache, store, 1000.0, 24100.0)
        assert out["active_0_tick_age_sec"] == pytest.approx(5.0)

    def test_tick_age_nan_when_no_ticks(self):
        cache = self._cache_one_active(24100)
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert _nan(out["active_0_tick_age_sec"])

    def test_call_strength_from_snapshot(self):
        """
        24100 is the only strike with callOIChange=100 → call_soi=1.0.
        No prev_rows → call_sv=0.0.
        call_strength = (0.0 + 1.0) / 2 = 0.5.
        """
        rows = [_row(s, call_oi_chg=100.0 if s == 24100 else 0.0) for s in ALL_STRIKES]
        cache = _make_cache(rows)
        cache.active_strikes = [
            StrikeScore(strike=24100, vol_score=0.0, oi_score=1.0, strength=1.0)
        ]
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert out["active_0_call_strength"] == pytest.approx(0.5)
        assert out["active_0_call_strength_oi"] == pytest.approx(1.0)
        assert out["active_0_call_strength_volume"] == pytest.approx(0.0)

    def test_put_strength_zero_when_no_put_oi_change(self):
        rows = [_row(s, call_oi_chg=100.0 if s == 24100 else 0.0) for s in ALL_STRIKES]
        cache = _make_cache(rows)
        cache.active_strikes = [
            StrikeScore(strike=24100, vol_score=0.0, oi_score=1.0, strength=1.0)
        ]
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert out["active_0_put_strength"] == pytest.approx(0.0)

    def test_call_bid_ask_imbalance_balanced(self):
        """bid_size == ask_size → imbalance = 0.0."""
        cache = self._cache_one_active(24100)
        store = _store_with_tick(24100, "CE", _tick(ts=999.0, bid_size=10, ask_size=10))
        out = compute_active_features(cache, store, 1000.0, 24100.0)
        assert out["active_0_call_bid_ask_imbalance"] == pytest.approx(0.0)

    def test_call_bid_ask_imbalance_bid_dominant(self):
        """(bid_size - ask_size) / (bid_size + ask_size)."""
        cache = self._cache_one_active(24100)
        store = _store_with_tick(24100, "CE", _tick(ts=999.0, bid_size=30, ask_size=10))
        out = compute_active_features(cache, store, 1000.0, 24100.0)
        # (30-10) / (30+10) = 20/40 = 0.5
        assert out["active_0_call_bid_ask_imbalance"] == pytest.approx(0.5)


# ══════════════════════════════════════════════════════════════════════════════
# Slot ordering
# ══════════════════════════════════════════════════════════════════════════════


class TestSlotOrdering:

    def test_slots_follow_active_strikes_order(self):
        """Slot N gets active_strikes[N] — ordering is preserved."""
        cache = _make_cache()
        cache.active_strikes = [
            StrikeScore(strike=24100, vol_score=0.0, oi_score=1.0, strength=1.0),
            StrikeScore(strike=24050, vol_score=0.0, oi_score=0.5, strength=0.5),
            StrikeScore(strike=24150, vol_score=0.0, oi_score=0.25, strength=0.25),
        ]
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert out["active_0_strike"] == pytest.approx(24100.0)
        assert out["active_1_strike"] == pytest.approx(24050.0)
        assert out["active_2_strike"] == pytest.approx(24150.0)
        assert _nan(out["active_3_strike"])

    def test_max_6_slots_filled(self):
        """Only first 6 active strikes are written; extras ignored."""
        cache = _make_cache()
        cache.active_strikes = [
            StrikeScore(strike=s, vol_score=0.0, oi_score=1.0, strength=1.0)
            for s in [24100, 24050, 24150, 24000, 24200, 23950, 24250]
        ]
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        for slot in range(6):
            assert not _nan(out[f"active_{slot}_strike"])
        # 24250 (7th) should not appear in any slot
        slot_strikes = [out[f"active_{slot}_strike"] for slot in range(6)]
        assert 24250.0 not in slot_strikes


# ══════════════════════════════════════════════════════════════════════════════
# Cross-features
# ══════════════════════════════════════════════════════════════════════════════


class TestCrossFeatures:

    def _cache_two_active(self) -> ChainCache:
        """
        24100: callOIChange=100, putOIChange=0  → call_str=0.5, put_str=0.0
        24050: callOIChange=0,   putOIChange=100 → call_str=0.0, put_str=0.5
        """
        rows = [
            _row(
                s, call_oi_chg=100.0 if s == 24100 else 0.0, put_oi_chg=100.0 if s == 24050 else 0.0
            )
            for s in ALL_STRIKES
        ]
        cache = _make_cache(rows)
        cache.active_strikes = [
            StrikeScore(strike=24100, vol_score=0.0, oi_score=1.0, strength=1.0),
            StrikeScore(strike=24050, vol_score=0.0, oi_score=1.0, strength=1.0),
        ]
        return cache

    def test_call_put_strength_diff(self):
        """
        24100: call_str=0.5, put_str=0.0
        24050: call_str=0.0, put_str=0.5
        diff = (0.5+0.0) − (0.0+0.5) = 0.0
        """
        cache = self._cache_two_active()
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert out["call_put_strength_diff"] == pytest.approx(0.0)

    def test_call_put_strength_diff_call_dominant(self):
        """One call-dominant active strike → positive diff."""
        rows = [_row(s, call_oi_chg=100.0 if s == 24100 else 0.0) for s in ALL_STRIKES]
        cache = _make_cache(rows)
        cache.active_strikes = [
            StrikeScore(strike=24100, vol_score=0.0, oi_score=1.0, strength=1.0)
        ]
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        # call_str=0.5, put_str=0.0 → diff = 0.5
        assert out["call_put_strength_diff"] == pytest.approx(0.5)

    def test_call_put_volume_diff_nan_when_not_available(self):
        cache = self._cache_two_active()
        assert not cache.vol_diff_available
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert _nan(out["call_put_volume_diff"])

    def test_call_put_volume_diff_computed_when_available(self):
        """With two snapshots (vol_diff_available=True), value is not NaN."""
        cache = _make_cache(add_prev=True)
        assert cache.vol_diff_available
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert not _nan(out["call_put_volume_diff"])
        assert out["call_put_volume_diff"] == pytest.approx(0.0)

    def test_call_put_oi_diff_from_cache(self):
        """call_put_oi_diff = cache.oi_change_call_atm − cache.oi_change_put_atm."""
        atm_window = [23950, 24000, 24050, 24100, 24150, 24200, 24250]
        rows = [
            _row(
                s,
                call_oi_chg=10.0 if s in atm_window else 0.0,
                put_oi_chg=3.0 if s in atm_window else 0.0,
            )
            for s in ALL_STRIKES
        ]
        cache = _make_cache(rows)
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        expected = cache.oi_change_call_atm - cache.oi_change_put_atm
        assert out["call_put_oi_diff"] == pytest.approx(expected)

    def test_premium_divergence_nan_when_no_active(self):
        cache = _make_cache()
        cache.active_strikes = []
        out = compute_active_features(cache, _empty_store(), 1000.0, 24100.0)
        assert _nan(out["premium_divergence"])

    def test_premium_divergence_from_5_ticks(self):
        """premium_divergence = Σ(call.pm) − Σ(put.pm) across active slots."""
        cache = _make_cache()
        cache.active_strikes = [
            StrikeScore(strike=24100, vol_score=0.0, oi_score=1.0, strength=1.0),
        ]
        store = OptionBufferStore(maxlen=10)
        for i in range(5):
            store.push(24100, "CE", _tick(ts=float(i), ltp=100.0 + i))
            store.push(24100, "PE", _tick(ts=float(i), ltp=100.0 + 0.5 * i))
        out = compute_active_features(cache, store, 5.0, 24100.0)
        # call_pm = ltp[4] - ltp[0] = 104.0 - 100.0 = 4.0
        # put_pm  = 102.0 - 100.0 = 2.0
        assert out["premium_divergence"] == pytest.approx(4.0 - 2.0)

    def test_premium_divergence_nan_pm_contributes_zero(self):
        """NaN premium_momentum from a slot contributes 0 to the divergence sum."""
        cache = _make_cache()
        cache.active_strikes = [
            StrikeScore(strike=24100, vol_score=0.0, oi_score=1.0, strength=1.0),
        ]
        store = OptionBufferStore(maxlen=10)
        # Only 3 call ticks (< 5 → NaN pm); 5 put ticks with +4 pm
        for i in range(3):
            store.push(24100, "CE", _tick(ts=float(i), ltp=100.0 + i))
        for i in range(5):
            store.push(24100, "PE", _tick(ts=float(i), ltp=100.0 + i))
        out = compute_active_features(cache, store, 5.0, 24100.0)
        # call_pm = NaN → 0; put_pm = 4.0 → divergence = 0 − 4.0 = −4.0
        assert out["premium_divergence"] == pytest.approx(-4.0)
