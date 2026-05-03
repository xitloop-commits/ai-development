"""
tests/test_meta.py — Unit tests for features/meta.py (§8.14 Meta Features).

Run: python -m pytest python_modules/tick_feature_agent/tests/test_meta.py -v
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.chain_cache import ChainCache
from tick_feature_agent.features.meta import compute_meta_features
from tick_feature_agent.feed.chain_poller import ChainSnapshot
from tick_feature_agent.instrument_profile import InstrumentProfile

# ── Helpers ───────────────────────────────────────────────────────────────────


def _row(strike: int) -> dict:
    return {
        "strike": strike,
        "callOI": 1000,
        "putOI": 1000,
        "callOIChange": 0,
        "putOIChange": 0,
        "callVolume": 100,
        "putVolume": 100,
        "callSecurityId": str(strike * 2),
        "putSecurityId": str(strike * 2 + 1),
        "callLTP": 100.0,
        "putLTP": 100.0,
    }


def _make_snapshot(spot: float = 24100.0, ts_sec: float | None = None) -> ChainSnapshot:
    if ts_sec is None:
        ts_sec = time.time()
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


def _make_profile(
    exchange: str = "NSE",
    instrument_name: str = "NIFTY",
    underlying_symbol: str = "NIFTY25MAYFUT",
    underlying_security_id: str = "13",
) -> InstrumentProfile:
    return InstrumentProfile(
        exchange=exchange,
        instrument_name=instrument_name,
        underlying_symbol=underlying_symbol,
        underlying_security_id=underlying_security_id,
        session_start="09:15",
        session_end="15:30",
        underlying_tick_timeout_sec=5,
        option_tick_timeout_sec=30,
        momentum_staleness_threshold_sec=60,
        warm_up_duration_sec=15,
        regime_trend_volatility_min=0.8,
        regime_trend_imbalance_min=0.4,
        regime_trend_momentum_min=0.5,
        regime_trend_activity_min=0.5,
        regime_range_volatility_max=0.5,
        regime_range_imbalance_max=0.3,
        regime_range_activity_min=0.25,
        regime_dead_activity_max=0.15,
        regime_dead_vol_drought_max=0.02,
        target_windows_sec=(30, 60),
    )


def _cache_with_one_snapshot(ts_sec: float | None = None) -> ChainCache:
    """Returns a cache with exactly 1 snapshot (chain_available=True, vol_diff=False)."""
    c = ChainCache()
    c.update_from_snapshot(_make_snapshot(ts_sec=ts_sec or time.time()))
    return c


def _cache_with_two_snapshots(ts_sec: float | None = None) -> ChainCache:
    """Returns a cache with 2 snapshots (chain_available=True, vol_diff=True)."""
    c = ChainCache()
    c.update_from_snapshot(_make_snapshot(ts_sec=(ts_sec or time.time()) - 5))
    c.update_from_snapshot(_make_snapshot(ts_sec=ts_sec or time.time()))
    return c


# ── Test classes ──────────────────────────────────────────────────────────────


class TestMetaFeatureKeys:

    def test_all_keys_present(self):
        profile = _make_profile()
        cache = _cache_with_two_snapshots()
        out = compute_meta_features(profile, cache, time.time(), 25, True)
        expected = {
            "exchange",
            "instrument",
            "underlying_symbol",
            "underlying_security_id",
            "chain_timestamp",
            "time_since_chain_sec",
            "chain_available",
            "data_quality_flag",
            "is_market_open",
        }
        assert set(out.keys()) == expected

    def test_exactly_9_keys(self):
        profile = _make_profile()
        cache = _cache_with_two_snapshots()
        out = compute_meta_features(profile, cache, time.time(), 25, True)
        assert len(out) == 9


class TestStaticProfileFields:

    def test_exchange_nse(self):
        profile = _make_profile(exchange="NSE")
        out = compute_meta_features(profile, ChainCache(), 1000.0, 5, True)
        assert out["exchange"] == "NSE"

    def test_exchange_mcx(self):
        profile = _make_profile(
            exchange="MCX",
            instrument_name="CRUDEOIL",
            underlying_symbol="CRUDEOIL25MAYFUT",
            underlying_security_id="486502",
        )
        out = compute_meta_features(profile, ChainCache(), 1000.0, 5, True)
        assert out["exchange"] == "MCX"

    def test_instrument_name(self):
        profile = _make_profile(instrument_name="BANKNIFTY")
        out = compute_meta_features(profile, ChainCache(), 1000.0, 5, True)
        assert out["instrument"] == "BANKNIFTY"

    def test_underlying_symbol(self):
        profile = _make_profile(underlying_symbol="NIFTY25MAYFUT")
        out = compute_meta_features(profile, ChainCache(), 1000.0, 5, True)
        assert out["underlying_symbol"] == "NIFTY25MAYFUT"

    def test_underlying_security_id(self):
        profile = _make_profile(underlying_security_id="13")
        out = compute_meta_features(profile, ChainCache(), 1000.0, 5, True)
        assert out["underlying_security_id"] == "13"


class TestChainAvailability:

    def test_chain_available_false_before_snapshot(self):
        out = compute_meta_features(_make_profile(), ChainCache(), 1000.0, 5, True)
        assert out["chain_available"] == 0

    def test_chain_available_true_after_first_snapshot(self):
        cache = _cache_with_one_snapshot()
        out = compute_meta_features(_make_profile(), cache, time.time(), 5, True)
        assert out["chain_available"] == 1

    def test_chain_timestamp_none_before_snapshot(self):
        out = compute_meta_features(_make_profile(), ChainCache(), 1000.0, 5, True)
        assert out["chain_timestamp"] is None

    def test_chain_timestamp_set_after_snapshot(self):
        ts = time.time() - 3.0
        cache = _cache_with_one_snapshot(ts_sec=ts)
        out = compute_meta_features(_make_profile(), cache, time.time(), 5, True)
        assert out["chain_timestamp"] == pytest.approx(ts, abs=0.001)

    def test_time_since_chain_none_before_snapshot(self):
        out = compute_meta_features(_make_profile(), ChainCache(), 1000.0, 5, True)
        assert out["time_since_chain_sec"] is None

    def test_time_since_chain_calculated(self):
        chain_ts = 1_700_000_000.0
        tick_time = 1_700_000_005.0  # 5s later
        cache = _cache_with_one_snapshot(ts_sec=chain_ts)
        out = compute_meta_features(_make_profile(), cache, tick_time, 25, True)
        assert out["time_since_chain_sec"] == pytest.approx(5.0, abs=0.001)

    def test_time_since_chain_large_gap(self):
        """Chain 45s old — still computed, flag is lower by quality check."""
        chain_ts = 1_700_000_000.0
        tick_time = 1_700_000_045.0  # 45s later
        cache = _cache_with_two_snapshots(ts_sec=chain_ts)
        out = compute_meta_features(_make_profile(), cache, tick_time, 25, True)
        assert out["time_since_chain_sec"] == pytest.approx(45.0, abs=0.001)


class TestIsMarketOpen:

    def test_market_open_true(self):
        cache = _cache_with_two_snapshots()
        out = compute_meta_features(_make_profile(), cache, time.time(), 25, True)
        assert out["is_market_open"] == 1

    def test_market_open_false(self):
        cache = _cache_with_two_snapshots()
        out = compute_meta_features(_make_profile(), cache, time.time(), 25, False)
        assert out["is_market_open"] == 0


class TestDataQualityFlag:

    def _normal_out(self, **kwargs):
        """Baseline: normal conditions → flag should be 1."""
        profile = _make_profile()
        chain_ts = time.time() - 3.0  # 3s old (fresh)
        cache = _cache_with_two_snapshots(ts_sec=chain_ts)
        defaults = dict(
            tick_time=time.time(),
            underlying_tick_count=25,
            is_market_open=True,
        )
        defaults.update(kwargs)
        return compute_meta_features(profile, cache, **defaults)

    def test_flag_1_in_normal_conditions(self):
        assert self._normal_out()["data_quality_flag"] == 1

    def test_flag_0_no_chain(self):
        """No chain snapshot → flag = 0."""
        out = compute_meta_features(_make_profile(), ChainCache(), time.time(), 25, True)
        assert out["data_quality_flag"] == 0

    def test_flag_0_only_one_snapshot(self):
        """One snapshot (vol_diff not available) → flag = 0."""
        cache = _cache_with_one_snapshot(ts_sec=time.time() - 2)
        out = compute_meta_features(_make_profile(), cache, time.time(), 25, True)
        assert out["data_quality_flag"] == 0

    def test_flag_0_tick_count_19(self):
        """Tick 19: 20-tick buffer not full → flag = 0."""
        assert self._normal_out(underlying_tick_count=19)["data_quality_flag"] == 0

    def test_flag_1_tick_count_20(self):
        """Tick 20: 20-tick buffer just filled → flag = 1."""
        assert self._normal_out(underlying_tick_count=20)["data_quality_flag"] == 1

    def test_flag_0_tick_count_1(self):
        """Tick 1: far below 20-tick threshold → flag = 0."""
        assert self._normal_out(underlying_tick_count=1)["data_quality_flag"] == 0

    def test_flag_0_chain_stale_31s(self):
        """Chain 31s old → time_since_chain > 30 → flag = 0."""
        chain_ts = 1_700_000_000.0
        tick_time = chain_ts + 31.0  # 31s > 30s threshold → stale
        cache = _cache_with_two_snapshots(ts_sec=chain_ts)
        out = compute_meta_features(_make_profile(), cache, tick_time, 25, True)
        assert out["data_quality_flag"] == 0

    def test_flag_1_chain_exactly_30s(self):
        """Chain exactly 30s old — not stale (> 30 threshold) → flag = 1."""
        chain_ts = 1_700_000_000.0
        tick_time = chain_ts + 30.0  # exactly 30s — threshold is > 30, so still valid
        cache = _cache_with_two_snapshots(ts_sec=chain_ts)
        out = compute_meta_features(_make_profile(), cache, tick_time, 25, True)
        assert out["data_quality_flag"] == 1

    def test_flag_0_underlying_feed_stale(self):
        assert self._normal_out(underlying_feed_stale=True)["data_quality_flag"] == 0

    def test_flag_0_option_feed_stale(self):
        assert self._normal_out(option_feed_stale=True)["data_quality_flag"] == 0

    def test_flag_0_symbol_mismatch(self):
        assert self._normal_out(symbol_mismatch=True)["data_quality_flag"] == 0

    def test_flag_0_multiple_conditions(self):
        """Multiple failure conditions all independently cause flag = 0."""
        out = compute_meta_features(
            _make_profile(),
            ChainCache(),
            time.time(),
            1,
            False,
            underlying_feed_stale=True,
            symbol_mismatch=True,
        )
        assert out["data_quality_flag"] == 0

    def test_chain_unavailable_still_reports_chain_available_0(self):
        """Even when flag=0 due to no chain, chain_available = 0 is reported."""
        out = compute_meta_features(_make_profile(), ChainCache(), time.time(), 25, True)
        assert out["chain_available"] == 0
        assert out["data_quality_flag"] == 0

    def test_quality_flag_independent_of_50tick_warmup(self):
        """Tick 49: 50-tick buffer not full, but flag should still be 1 (only 20-tick gates it)."""
        assert self._normal_out(underlying_tick_count=49)["data_quality_flag"] == 1

    def test_quality_flag_independent_of_market_open(self):
        """is_market_open=False does NOT lower data_quality_flag."""
        assert self._normal_out(is_market_open=False)["data_quality_flag"] == 1
