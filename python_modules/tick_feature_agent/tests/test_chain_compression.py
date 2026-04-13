"""
tests/test_chain_compression.py — Unit tests for:
    features/chain.py        (§8.5 chain feature extractor)
    features/compression.py  (§8.8 compression & breakout signals)
"""

from __future__ import annotations

import math
import statistics
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG  = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.chain_cache import ChainCache
from tick_feature_agent.buffers.tick_buffer import CircularBuffer, UnderlyingTick
from tick_feature_agent.features.chain import compute_chain_features
from tick_feature_agent.features.compression import CompressionState


# ── Helpers ───────────────────────────────────────────────────────────────────

def _nan(v) -> bool:
    return isinstance(v, float) and math.isnan(v)


def _make_cache(
    chain_available: bool = True,
    pcr_global: float | None = 1.2,
    pcr_atm: float | None = 1.1,
    oi_total_call: float = 100_000.0,
    oi_total_put: float = 120_000.0,
    oi_change_call: float = 5_000.0,
    oi_change_put: float = 8_000.0,
    oi_change_call_atm: float = 1_000.0,
    oi_change_put_atm: float = 2_000.0,
    oi_imbalance_atm: float | None = 0.33,
) -> ChainCache:
    c = ChainCache()
    c.chain_available    = chain_available
    c.pcr_global         = pcr_global
    c.pcr_atm            = pcr_atm
    c.oi_total_call      = oi_total_call
    c.oi_total_put       = oi_total_put
    c.oi_change_call     = oi_change_call
    c.oi_change_put      = oi_change_put
    c.oi_change_call_atm = oi_change_call_atm
    c.oi_change_put_atm  = oi_change_put_atm
    c.oi_imbalance_atm   = oi_imbalance_atm
    return c


def _utick(ltp: float) -> UnderlyingTick:
    return UnderlyingTick(timestamp=0.0, ltp=ltp, bid=0.0, ask=0.0, volume=0)


def _price_buf(*prices: float) -> CircularBuffer:
    buf = CircularBuffer(maxlen=50)
    for p in prices:
        buf.push(_utick(p))
    return buf


def _opt_feat(spread: float | None = None) -> dict:
    """Build a minimal option feature dict for one (strike, opt_type) pair."""
    return {
        "tick_available": 0 if spread is None else 1,
        "spread": math.nan if spread is None else spread,
        # other keys not needed for compression tests
    }


# ══════════════════════════════════════════════════════════════════════════════
# §8.5 chain.py
# ══════════════════════════════════════════════════════════════════════════════

class TestChainFeatureKeys:
    def test_exactly_9_keys(self):
        result = compute_chain_features(ChainCache())
        assert len(result) == 9

    def test_all_have_chain_prefix(self):
        result = compute_chain_features(ChainCache())
        for k in result:
            assert k.startswith("chain_"), f"{k!r} lacks chain_ prefix"


class TestChainWhenUnavailable:
    def test_all_nan_when_not_available(self):
        result = compute_chain_features(ChainCache())   # chain_available=False
        for k, v in result.items():
            assert _nan(v), f"{k} should be NaN when chain unavailable"


class TestChainValues:
    def test_pcr_global_extracted(self):
        result = compute_chain_features(_make_cache(pcr_global=1.2))
        assert result["chain_pcr_global"] == pytest.approx(1.2)

    def test_pcr_global_nan_when_none(self):
        result = compute_chain_features(_make_cache(pcr_global=None))
        assert _nan(result["chain_pcr_global"])

    def test_pcr_atm_extracted(self):
        result = compute_chain_features(_make_cache(pcr_atm=0.8))
        assert result["chain_pcr_atm"] == pytest.approx(0.8)

    def test_pcr_atm_nan_when_none(self):
        result = compute_chain_features(_make_cache(pcr_atm=None))
        assert _nan(result["chain_pcr_atm"])

    def test_oi_totals_extracted(self):
        result = compute_chain_features(
            _make_cache(oi_total_call=50_000.0, oi_total_put=75_000.0)
        )
        assert result["chain_oi_total_call"] == pytest.approx(50_000.0)
        assert result["chain_oi_total_put"] == pytest.approx(75_000.0)

    def test_oi_change_globals_extracted(self):
        result = compute_chain_features(
            _make_cache(oi_change_call=1_234.0, oi_change_put=5_678.0)
        )
        assert result["chain_oi_change_call"] == pytest.approx(1_234.0)
        assert result["chain_oi_change_put"] == pytest.approx(5_678.0)

    def test_oi_change_atm_extracted(self):
        result = compute_chain_features(
            _make_cache(oi_change_call_atm=300.0, oi_change_put_atm=500.0)
        )
        assert result["chain_oi_change_call_atm"] == pytest.approx(300.0)
        assert result["chain_oi_change_put_atm"] == pytest.approx(500.0)

    def test_oi_imbalance_atm_extracted(self):
        result = compute_chain_features(_make_cache(oi_imbalance_atm=0.5))
        assert result["chain_oi_imbalance_atm"] == pytest.approx(0.5)

    def test_oi_imbalance_atm_nan_when_none(self):
        result = compute_chain_features(_make_cache(oi_imbalance_atm=None))
        assert _nan(result["chain_oi_imbalance_atm"])


# ══════════════════════════════════════════════════════════════════════════════
# §8.8 compression.py
# ══════════════════════════════════════════════════════════════════════════════

_ATM_WINDOW = [24000, 24050, 24100, 24150, 24200, 24250, 24300]


def _no_opt_features(atm_window=None) -> dict:
    """Option features dict where all CE spreads are NaN (no ticks)."""
    if atm_window is None:
        atm_window = _ATM_WINDOW
    return {(s, "CE"): _opt_feat(spread=None) for s in atm_window}


def _opt_features_with_spread(spread: float, atm_window=None) -> dict:
    """Option features where all CE strikes have the given spread."""
    if atm_window is None:
        atm_window = _ATM_WINDOW
    return {(s, "CE"): _opt_feat(spread=spread) for s in atm_window}


class TestCompressionFeatureKeys:
    def test_exactly_4_keys(self):
        comp = CompressionState()
        result = comp.compute(_price_buf(*[100.0] * 20), {}, False, _ATM_WINDOW)
        assert set(result) == {
            "range_20ticks", "range_percent_20ticks",
            "volatility_compression", "spread_tightening_atm",
        }


class TestCompressionNullBoundaries:
    def test_all_nan_at_19_ticks(self):
        comp = CompressionState()
        buf = _price_buf(*[100.0] * 19)
        result = comp.compute(buf, {}, True, _ATM_WINDOW)
        for k, v in result.items():
            assert _nan(v), f"{k} should be NaN with 19 ticks"

    def test_range_available_at_20_ticks(self):
        comp = CompressionState()
        buf = _price_buf(*[100.0] * 20)
        result = comp.compute(buf, {}, False, _ATM_WINDOW)
        assert not _nan(result["range_20ticks"])

    def test_vol_compression_nan_before_tick_100(self):
        comp = CompressionState()
        # Feed 99 ticks (20 needed for first computation)
        prices = [100.0 + i * 0.1 for i in range(99)]
        buf = _price_buf(*prices)
        # Simulate calling compute 99 times
        comp2 = CompressionState()
        result = None
        for i in range(99):
            sub_buf = _price_buf(*prices[:i + 1])
            result = comp2.compute(sub_buf, {}, False, _ATM_WINDOW)
        assert _nan(result["volatility_compression"])

    def test_vol_compression_available_at_tick_100(self):
        comp = CompressionState()
        prices = [100.0 + (i % 5) * 0.5 for i in range(100)]  # some variation
        result = None
        buf = CircularBuffer(maxlen=50)
        for p in prices:
            buf.push(_utick(p))
            result = comp.compute(buf, {}, False, _ATM_WINDOW)
        assert not _nan(result["volatility_compression"])


class TestRange20Ticks:
    def test_range_formula(self):
        comp = CompressionState()
        # 20 prices: 100 to 110 (range = 10)
        prices = list(range(100, 120))   # 100..119, range=19
        result = comp.compute(_price_buf(*prices), {}, False, _ATM_WINDOW)
        assert result["range_20ticks"] == pytest.approx(19.0)

    def test_range_zero_when_flat(self):
        comp = CompressionState()
        result = comp.compute(_price_buf(*[100.0] * 20), {}, False, _ATM_WINDOW)
        assert result["range_20ticks"] == pytest.approx(0.0)

    def test_range_uses_last_20_ticks(self):
        comp = CompressionState()
        # 25 ticks: first 5 very volatile, last 20 flat at 100
        prices = [200.0, 50.0, 300.0, 10.0, 150.0] + [100.0] * 20
        result = comp.compute(_price_buf(*prices), {}, False, _ATM_WINDOW)
        assert result["range_20ticks"] == pytest.approx(0.0)   # only last 20 (all 100.0)


class TestRangePercent20Ticks:
    def test_percent_formula(self):
        comp = CompressionState()
        # Prices: all same except two extremes; median is easy to compute
        prices = [100.0] * 18 + [95.0, 105.0]   # range=10, median=100.0
        result = comp.compute(_price_buf(*prices), {}, False, _ATM_WINDOW)
        assert result["range_percent_20ticks"] == pytest.approx(10.0 / 100.0)

    def test_range_percent_nan_when_median_zero(self):
        comp = CompressionState()
        # All prices = 0 → median = 0 → NaN
        result = comp.compute(_price_buf(*[0.0] * 20), {}, False, _ATM_WINDOW)
        assert _nan(result["range_percent_20ticks"])

    def test_range_percent_nan_when_negative_median(self):
        # All prices = -1 (feed error) → NaN
        comp = CompressionState()
        result = comp.compute(_price_buf(*[-1.0] * 20), {}, False, _ATM_WINDOW)
        assert _nan(result["range_percent_20ticks"])


class TestVolatilityCompression:
    def _run_n_ticks(self, comp: CompressionState, prices: list[float]) -> dict:
        """Run compute() for each tick in sequence, return final result."""
        buf = CircularBuffer(maxlen=50)
        result = {}
        for p in prices:
            buf.push(_utick(p))
            result = comp.compute(buf, {}, False, _ATM_WINDOW)
        return result

    def test_compression_formula(self):
        comp = CompressionState()
        # Use 100 ticks with controlled volatility to freeze vol_session_median
        prices = [100.0 + (i % 10) * 1.0 for i in range(100)]
        result = self._run_n_ticks(comp, prices)
        assert not _nan(result["volatility_compression"])
        assert result["volatility_compression"] >= 0.0

    def test_low_current_vol_gives_compression_below_1(self):
        comp = CompressionState()
        # First 100 ticks: high volatility (std large) → large vol_session_median
        # Final ticks: flat → rolling_std_20 is small → compression < 1
        volatile = [100.0 + (i % 20) * 5.0 for i in range(100)]
        result = self._run_n_ticks(comp, volatile)
        # Now push 20 more flat ticks
        buf = CircularBuffer(maxlen=50)
        for p in volatile:
            buf.push(_utick(p))
        for _ in range(20):
            buf.push(_utick(100.0))
            result = comp.compute(buf, {}, False, _ATM_WINDOW)
        # flat window → rolling_std_20 ≈ 0 → compression ≈ 0 < 1
        assert not _nan(result["volatility_compression"])
        assert result["volatility_compression"] < 1.0

    def test_vol_compression_nan_when_session_median_zero(self):
        comp = CompressionState()
        # 100 ticks all identical → rolling_std_20 = 0 for all → vol_session_median = 0
        prices = [100.0] * 100
        result = self._run_n_ticks(comp, prices)
        # After tick 100, median is frozen at 0.0 → compression = NaN
        assert _nan(result["volatility_compression"])

    def test_median_frozen_after_tick_100(self):
        comp = CompressionState()
        prices = [100.0 + (i % 5) * 1.0 for i in range(100)]
        self._run_n_ticks(comp, prices)
        assert comp.median_frozen
        vsm1 = comp.vol_session_median
        # Push 10 more ticks
        buf = CircularBuffer(maxlen=50)
        for p in prices:
            buf.push(_utick(p))
        for i in range(10):
            buf.push(_utick(200.0))
            comp.compute(buf, {}, False, _ATM_WINDOW)
        assert comp.vol_session_median == pytest.approx(vsm1)   # unchanged

    def test_reset_clears_state(self):
        comp = CompressionState()
        prices = [100.0 + i * 0.5 for i in range(100)]
        self._run_n_ticks(comp, prices)
        assert comp.median_frozen
        comp.reset()
        assert not comp.median_frozen
        assert comp.tick_count == 0
        assert _nan(comp.vol_session_median)


class TestSpreadTighteningAtm:
    def test_nan_when_no_chain(self):
        comp = CompressionState()
        buf = _price_buf(*[100.0] * 20)
        result = comp.compute(buf, {}, chain_available=False, atm_window=_ATM_WINDOW)
        assert _nan(result["spread_tightening_atm"])

    def test_uniform_spread_gives_mean_spread(self):
        comp = CompressionState()
        buf = _price_buf(*[100.0] * 20)
        # All 7 CE strikes have spread = 2.0
        opt = _opt_features_with_spread(2.0)
        result = comp.compute(buf, opt, chain_available=True, atm_window=_ATM_WINDOW)
        assert result["spread_tightening_atm"] == pytest.approx(2.0)

    def test_unticked_strikes_contribute_zero(self):
        comp = CompressionState()
        buf = _price_buf(*[100.0] * 20)
        # 4 strikes with spread=4.0, 3 strikes unticked (NaN)
        opt = {}
        for i, s in enumerate(_ATM_WINDOW):
            opt[(s, "CE")] = _opt_feat(spread=4.0 if i < 4 else None)
        result = comp.compute(buf, opt, chain_available=True, atm_window=_ATM_WINDOW)
        # sum = 4*4 = 16, denominator = 7
        assert result["spread_tightening_atm"] == pytest.approx(16.0 / 7.0)

    def test_all_unticked_gives_zero(self):
        comp = CompressionState()
        buf = _price_buf(*[100.0] * 20)
        opt = _no_opt_features()
        result = comp.compute(buf, opt, chain_available=True, atm_window=_ATM_WINDOW)
        assert result["spread_tightening_atm"] == pytest.approx(0.0)
