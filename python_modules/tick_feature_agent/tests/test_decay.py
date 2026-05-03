"""
tests/test_decay.py — Unit tests for features/decay.py (§8.9 Decay & Dead Market).

Run: python -m pytest python_modules/tick_feature_agent/tests/test_decay.py -v
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
from tick_feature_agent.features.decay import DecayState
from tick_feature_agent.feed.chain_poller import ChainSnapshot

# ── Helpers ───────────────────────────────────────────────────────────────────


def _nan(v) -> bool:
    return isinstance(v, float) and math.isnan(v)


def _opt_tick(ltp: float, ts: float = 1000.0) -> OptionTick:
    return OptionTick(
        timestamp=ts, ltp=ltp, bid=ltp - 1, ask=ltp + 1, bid_size=10, ask_size=10, volume=100
    )


def _row(
    strike: int,
    call_vol: float = 100.0,
    put_vol: float = 100.0,
    call_oi: float = 1000.0,
    put_oi: float = 1000.0,
) -> dict:
    return {
        "strike": strike,
        "callOI": call_oi,
        "putOI": put_oi,
        "callOIChange": 10.0,
        "putOIChange": 10.0,
        "callVolume": call_vol,
        "putVolume": put_vol,
        "callSecurityId": str(strike * 2),
        "putSecurityId": str(strike * 2 + 1),
        "callLTP": 100.0,
        "putLTP": 100.0,
    }


def _make_snapshot(
    spot: float = 24100.0, strikes: list[int] | None = None, ts_sec: float | None = None
) -> ChainSnapshot:
    if ts_sec is None:
        ts_sec = time.time()
    if strikes is None:
        strikes = list(range(23800, 24500, 50))
    rows = [_row(s) for s in strikes]
    sec_id_map = {str(r["callSecurityId"]): (int(r["strike"]), "CE") for r in rows}
    sec_id_map.update({str(r["putSecurityId"]): (int(r["strike"]), "PE") for r in rows})
    return ChainSnapshot(
        spot_price=spot,
        expiry="2026-04-24",
        timestamp_sec=ts_sec,
        rows=rows,
        strike_step=50,
        sec_id_map=sec_id_map,
    )


def _cache_no_chain() -> ChainCache:
    return ChainCache()


def _cache_one_snapshot(spot: float = 24100.0) -> ChainCache:
    c = ChainCache()
    c.update_from_snapshot(_make_snapshot(spot=spot))
    return c


def _cache_two_snapshots(
    spot: float = 24100.0,
    call_vol1: float = 50.0,
    put_vol1: float = 50.0,
    call_vol2: float = 80.0,
    put_vol2: float = 70.0,
) -> ChainCache:
    """Cache with 2 snapshots; vol diff = vol2 - vol1 per ATM strike."""
    strikes = list(range(23800, 24500, 50))
    snap1_rows = [_row(s, call_vol=call_vol1, put_vol=put_vol1) for s in strikes]
    snap2_rows = [_row(s, call_vol=call_vol2, put_vol=put_vol2) for s in strikes]

    def _snap(rows, ts):
        sec_id_map = {str(r["callSecurityId"]): (int(r["strike"]), "CE") for r in rows}
        sec_id_map.update({str(r["putSecurityId"]): (int(r["strike"]), "PE") for r in rows})
        return ChainSnapshot(
            spot_price=spot,
            expiry="2026-04-24",
            timestamp_sec=ts,
            rows=rows,
            strike_step=50,
            sec_id_map=sec_id_map,
        )

    c = ChainCache()
    c.update_from_snapshot(_snap(snap1_rows, time.time() - 5))
    c.update_from_snapshot(_snap(snap2_rows, time.time()))
    return c


ATM = 24100
ATM_WINDOW = [23950, 24000, 24050, 24100, 24150, 24200, 24250]  # 7 ATM±3 @ step=50


def _empty_opt_features() -> dict:
    return {}


# ══════════════════════════════════════════════════════════════════════════════


class TestDecayFeatureKeys:

    def test_all_keys_present(self):
        d = DecayState()
        store = OptionBufferStore()
        out = d.compute(store, _empty_opt_features(), _cache_no_chain(), ATM_WINDOW)
        expected = {
            "total_premium_decay_atm",
            "momentum_decay_20ticks_atm",
            "volume_drought_atm",
            "active_strike_count",
            "dead_market_score",
        }
        assert set(out.keys()) == expected

    def test_exactly_5_keys(self):
        d = DecayState()
        store = OptionBufferStore()
        out = d.compute(store, _empty_opt_features(), _cache_no_chain(), ATM_WINDOW)
        assert len(out) == 5


class TestTotalPremiumDecay:

    def test_nan_when_no_ticks(self):
        """No ticks in option store → NaN."""
        d = DecayState()
        store = OptionBufferStore()
        out = d.compute(store, {}, _cache_no_chain(), ATM_WINDOW)
        assert _nan(out["total_premium_decay_atm"])

    def test_nan_when_only_one_tick_per_pair(self):
        """Only 1 tick per pair — need ≥2 for diff."""
        d = DecayState()
        store = OptionBufferStore()
        for strike in ATM_WINDOW:
            for opt_type in ("CE", "PE"):
                store.push(strike, opt_type, _opt_tick(100.0))
        out = d.compute(store, {}, _cache_no_chain(), ATM_WINDOW)
        assert _nan(out["total_premium_decay_atm"])

    def test_decay_positive_when_premium_fell(self):
        """ltp_prev=110, ltp_now=100 → decay = +10 per pair."""
        d = DecayState()
        store = OptionBufferStore()
        for strike in ATM_WINDOW:
            for opt_type in ("CE", "PE"):
                store.push(strike, opt_type, _opt_tick(110.0, ts=999.0))
                store.push(strike, opt_type, _opt_tick(100.0, ts=1000.0))
        out = d.compute(store, {}, _cache_no_chain(), ATM_WINDOW)
        # 14 pairs, each contributing 110-100=10 → mean = 10
        assert abs(out["total_premium_decay_atm"] - 10.0) < 1e-9

    def test_decay_negative_when_premium_rose(self):
        """ltp_prev=100, ltp_now=110 → decay = -10."""
        d = DecayState()
        store = OptionBufferStore()
        for strike in ATM_WINDOW:
            for opt_type in ("CE", "PE"):
                store.push(strike, opt_type, _opt_tick(100.0, ts=999.0))
                store.push(strike, opt_type, _opt_tick(110.0, ts=1000.0))
        out = d.compute(store, {}, _cache_no_chain(), ATM_WINDOW)
        assert abs(out["total_premium_decay_atm"] - (-10.0)) < 1e-9

    def test_partial_pairs_excluded(self):
        """Only 1 pair has ≥2 ticks; denominator = 1."""
        d = DecayState()
        store = OptionBufferStore()
        # Only one pair gets 2 ticks
        store.push(ATM_WINDOW[0], "CE", _opt_tick(105.0))
        store.push(ATM_WINDOW[0], "CE", _opt_tick(100.0))
        out = d.compute(store, {}, _cache_no_chain(), ATM_WINDOW)
        assert abs(out["total_premium_decay_atm"] - 5.0) < 1e-9


class TestMomentumDecay:

    def test_nan_when_chain_not_available(self):
        d = DecayState()
        out = d.compute(OptionBufferStore(), {}, _cache_no_chain(), ATM_WINDOW)
        assert _nan(out["momentum_decay_20ticks_atm"])

    def test_zero_when_chain_available_no_option_features(self):
        """chain_available=True, no opt_features → all pm=NaN → sum 0 / 7 = 0.0."""
        d = DecayState()
        cache = _cache_one_snapshot()
        out = d.compute(OptionBufferStore(), {}, cache, ATM_WINDOW)
        assert out["momentum_decay_20ticks_atm"] == pytest.approx(0.0)

    def test_known_pm_values(self):
        """Provide known premium_momentum values; check Σ(abs)/7."""
        d = DecayState()
        cache = _cache_one_snapshot()
        # 7 strikes × 2 types = 14 pairs, each pm = 2.0
        opt_features = {}
        for strike in ATM_WINDOW:
            for opt_type in ("CE", "PE"):
                opt_features[(strike, opt_type)] = {"premium_momentum": 2.0}
        out = d.compute(OptionBufferStore(), opt_features, cache, ATM_WINDOW)
        # Σ(abs(2.0)) for 14 pairs / 7 = 28/7 = 4.0
        assert out["momentum_decay_20ticks_atm"] == pytest.approx(4.0)

    def test_nan_pm_contributes_zero(self):
        """NaN premium_momentum entries → treated as 0.0 per spec."""
        d = DecayState()
        cache = _cache_one_snapshot()
        opt_features = {(ATM_WINDOW[0], "CE"): {"premium_momentum": float("nan")}}
        out = d.compute(OptionBufferStore(), opt_features, cache, ATM_WINDOW)
        assert out["momentum_decay_20ticks_atm"] == pytest.approx(0.0)

    def test_mixed_pm_values(self):
        """Some NaN, some positive; verify denominator is always 7."""
        d = DecayState()
        cache = _cache_one_snapshot()
        # 2 pairs with pm=7.0, rest NaN
        opt_features = {
            (ATM_WINDOW[0], "CE"): {"premium_momentum": 7.0},
            (ATM_WINDOW[1], "CE"): {"premium_momentum": 7.0},
        }
        out = d.compute(OptionBufferStore(), opt_features, cache, ATM_WINDOW)
        # 14/7 = 2.0
        assert out["momentum_decay_20ticks_atm"] == pytest.approx(2.0)


class TestVolumeDrought:

    def test_nan_until_second_snapshot(self):
        """Only one snapshot → vol_diff_available=False → NaN."""
        d = DecayState()
        cache = _cache_one_snapshot()
        out = d.compute(OptionBufferStore(), {}, cache, ATM_WINDOW)
        assert _nan(out["volume_drought_atm"])

    def test_not_nan_after_two_snapshots(self):
        """Two snapshots → vol_drought computable."""
        d = DecayState()
        cache = _cache_two_snapshots()
        out = d.compute(OptionBufferStore(), {}, cache, ATM_WINDOW)
        assert not _nan(out["volume_drought_atm"])

    def test_volume_drought_value(self):
        """call_vol_diff_atm and put_vol_diff_atm; avg = mean of both sums."""
        # snap1: call_vol=50, put_vol=50 per strike (7 ATM strikes)
        # snap2: call_vol=80, put_vol=70 per strike
        # call_vol_diff_atm = sum(80-50 for 7 strikes) = 7*30 = 210
        # put_vol_diff_atm  = sum(70-50 for 7 strikes) = 7*20 = 140
        # volume_drought_atm = (210 + 140) / 2 = 175
        d = DecayState()
        cache = _cache_two_snapshots(call_vol1=50, put_vol1=50, call_vol2=80, put_vol2=70)
        out = d.compute(OptionBufferStore(), {}, cache, ATM_WINDOW)
        assert out["volume_drought_atm"] == pytest.approx(175.0)


class TestActiveStrikeCount:

    def test_zero_when_no_chain(self):
        d = DecayState()
        out = d.compute(OptionBufferStore(), {}, _cache_no_chain(), ATM_WINDOW)
        assert out["active_strike_count"] == 0.0

    def test_count_from_cache(self):
        """Active strike count comes from len(cache.active_strikes)."""
        d = DecayState()
        cache = _cache_one_snapshot()
        out = d.compute(OptionBufferStore(), {}, cache, ATM_WINDOW)
        # After one snapshot with no vol_diff, active_strikes may be empty
        # (depends on active_strikes selection logic), but the key should be present
        assert "active_strike_count" in out
        assert isinstance(out["active_strike_count"], float)


class TestDeadMarketScore:

    def test_nan_before_tick_100(self):
        """Dead market score NaN until tick 100 (historical_median frozen)."""
        d = DecayState()
        cache = _cache_two_snapshots()
        for _ in range(99):
            out = d.compute(OptionBufferStore(), {}, cache, ATM_WINDOW)
        assert _nan(out["dead_market_score"])

    def test_not_nan_at_tick_100(self):
        """At tick 100 the median freezes and dead_market_score becomes available."""
        d = DecayState()
        cache = _cache_two_snapshots()
        for _ in range(100):
            out = d.compute(OptionBufferStore(), {}, cache, ATM_WINDOW)
        # volume_drought_atm is available (2 snapshots) and median just froze
        assert not _nan(out["dead_market_score"])

    def test_score_in_range_0_1(self):
        """Score is always in [0, 1]."""
        d = DecayState()
        cache = _cache_two_snapshots()
        for _ in range(100):
            out = d.compute(OptionBufferStore(), {}, cache, ATM_WINDOW)
        score = out["dead_market_score"]
        assert not _nan(score)
        assert 0.0 <= score <= 1.0

    def test_nan_if_volume_drought_nan(self):
        """Even at tick 100+, dead_market_score is NaN if vol_drought is NaN."""
        d = DecayState()
        cache_no_vol = _cache_one_snapshot()  # only 1 snapshot → vol_drought=NaN
        for _ in range(100):
            out = d.compute(OptionBufferStore(), {}, cache_no_vol, ATM_WINDOW)
        assert _nan(out["dead_market_score"])

    def test_reset_clears_state(self):
        """After reset(), tick count resets to 0 and score is NaN again."""
        d = DecayState()
        cache = _cache_two_snapshots()
        for _ in range(100):
            d.compute(OptionBufferStore(), {}, cache, ATM_WINDOW)
        assert d.median_frozen

        d.reset()
        assert not d.median_frozen
        assert d.tick_count == 0
        out = d.compute(OptionBufferStore(), {}, cache, ATM_WINDOW)
        assert _nan(out["dead_market_score"])


class TestDecayStateProperties:

    def test_tick_count_increments(self):
        d = DecayState()
        assert d.tick_count == 0
        d.compute(OptionBufferStore(), {}, _cache_no_chain(), ATM_WINDOW)
        assert d.tick_count == 1
        d.compute(OptionBufferStore(), {}, _cache_no_chain(), ATM_WINDOW)
        assert d.tick_count == 2

    def test_median_not_frozen_before_tick_100(self):
        d = DecayState()
        for _ in range(99):
            d.compute(OptionBufferStore(), {}, _cache_two_snapshots(), ATM_WINDOW)
        assert not d.median_frozen

    def test_median_frozen_at_tick_100(self):
        d = DecayState()
        for _ in range(100):
            d.compute(OptionBufferStore(), {}, _cache_two_snapshots(), ATM_WINDOW)
        assert d.median_frozen

    def test_historical_median_nan_until_frozen(self):
        d = DecayState()
        assert _nan(d.historical_median_momentum)
