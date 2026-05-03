"""
tests/test_tick_processor.py — Unit tests for tick_processor.py.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_tick_processor.py -v
"""

from __future__ import annotations

import math
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.buffers.option_buffer import OptionBufferStore
from tick_feature_agent.buffers.tick_buffer import CircularBuffer
from tick_feature_agent.chain_cache import ChainCache
from tick_feature_agent.feed.chain_poller import ChainSnapshot
from tick_feature_agent.instrument_profile import InstrumentProfile
from tick_feature_agent.output.emitter import COLUMN_NAMES, Emitter
from tick_feature_agent.state_machine import StateMachine, TradingState
from tick_feature_agent.tick_processor import TickProcessor

_IST = timezone(timedelta(hours=5, minutes=30))
_DATE = "2026-04-14"


# ── Fixtures ──────────────────────────────────────────────────────────────────


def _profile(**overrides) -> InstrumentProfile:
    defaults = dict(
        exchange="NSE",
        instrument_name="NIFTY",
        underlying_symbol="NIFTY25APRFUT",
        underlying_security_id="13",
        session_start="09:15",
        session_end="15:30",
        underlying_tick_timeout_sec=5,
        option_tick_timeout_sec=10,
        momentum_staleness_threshold_sec=60,
        warm_up_duration_sec=1,
        regime_trend_volatility_min=0.3,
        regime_trend_imbalance_min=0.3,
        regime_trend_momentum_min=0.3,
        regime_trend_activity_min=0.5,
        regime_range_volatility_max=0.15,
        regime_range_imbalance_max=0.2,
        regime_range_activity_min=0.3,
        regime_dead_activity_max=0.1,
        regime_dead_vol_drought_max=0.2,
        target_windows_sec=(30, 60),
    )
    defaults.update(overrides)
    return InstrumentProfile(**defaults)


def _make_processor(warm_up=1, **profile_overrides):
    """Build a TickProcessor with minimal in-memory emitter."""
    p = _profile(warm_up_duration_sec=warm_up, **profile_overrides)
    sm = StateMachine(warm_up_duration_sec=p.warm_up_duration_sec)
    buf = CircularBuffer(maxlen=50)
    opt = OptionBufferStore()
    cc = ChainCache()
    em = Emitter(mode="replay")
    return TickProcessor(
        profile=p,
        state_machine=sm,
        tick_buffer=buf,
        option_store=opt,
        chain_cache=cc,
        emitter=em,
    )


def _now() -> float:
    return time.time()


def _tick(ltp: float, ts: float | None = None) -> dict:
    ts = ts or _now()
    return {
        "recv_ts": ts,
        "ltp": ltp,
        "bid": ltp - 0.5,
        "ask": ltp + 0.5,
        "bid_size": 100,
        "ask_size": 100,
        "ltq": 5,
    }


def _opt_tick(ltp: float, ts: float | None = None) -> dict:
    ts = ts or _now()
    return {
        "recv_ts": ts,
        "ltp": ltp,
        "bid": ltp - 0.25,
        "ask": ltp + 0.25,
        "bid_size": 50,
        "ask_size": 50,
        "ltq": 1,
    }


def _make_snapshot(spot: float = 24150.0) -> ChainSnapshot:
    atm = int(round(spot / 50)) * 50
    rows = [
        {
            "strike": atm + off * 50,
            "callOI": 10000,
            "callOIChange": 500,
            "callLTP": max(0.5, spot - (atm + off * 50) + 100),
            "callVolume": 200,
            "callIV": 18.5,
            "callSecurityId": str(52000 + off * 2),
            "putOI": 8000,
            "putOIChange": 300,
            "putLTP": max(0.5, (atm + off * 50) - spot + 100),
            "putVolume": 150,
            "putIV": 17.5,
            "putSecurityId": str(52001 + off * 2),
        }
        for off in range(-3, 4)
    ]
    sec_id_map = {}
    for r in rows:
        strike = int(r["strike"])
        sec_id_map[r["callSecurityId"]] = (strike, "CE")
        sec_id_map[r["putSecurityId"]] = (strike, "PE")

    return ChainSnapshot(
        spot_price=spot,
        expiry="2026-04-17",
        timestamp_sec=_now(),
        rows=rows,
        strike_step=50,
        sec_id_map=sec_id_map,
    )


def _session_end_sec() -> float:
    dt = datetime(2026, 4, 14, 15, 30, tzinfo=_IST)
    return dt.timestamp()


# ══════════════════════════════════════════════════════════════════════════════
# TestStateMachineIntegration
# ══════════════════════════════════════════════════════════════════════════════


class TestStateMachineIntegration:

    def test_initial_state_is_feed_stale(self):
        proc = _make_processor()
        assert proc._sm.state == TradingState.FEED_STALE

    def test_first_tick_triggers_warming_up(self):
        proc = _make_processor(warm_up=300)  # long warm-up so it won't expire
        proc.on_underlying_tick(_tick(24100.0))
        assert proc._sm.state == TradingState.WARMING_UP

    def test_sm_tick_checks_warmup_expiry(self):
        """Calling on_underlying_tick after warm_up_duration_sec → TRADING."""
        proc = _make_processor(warm_up=1)
        proc.on_underlying_tick(_tick(24100.0))  # → WARMING_UP
        time.sleep(1.1)  # let timer elapse
        proc.on_underlying_tick(_tick(24100.0))  # sm.tick() fires
        assert proc._sm.state == TradingState.TRADING

    def test_chain_snapshot_sets_cache(self):
        proc = _make_processor()
        assert not proc._cache.chain_available
        proc.on_chain_snapshot(_make_snapshot())
        assert proc._cache.chain_available

    def test_chain_snapshot_updates_sec_id_map_in_cache(self):
        proc = _make_processor()
        snap = _make_snapshot()
        proc.on_chain_snapshot(snap)
        assert proc._cache.snapshot is snap

    def test_chain_stale_transitions_state(self):
        proc = _make_processor(warm_up=1)
        proc.on_underlying_tick(_tick(24100.0))
        time.sleep(1.1)
        proc.on_underlying_tick(_tick(24100.0))  # TRADING now
        assert proc._sm.state == TradingState.TRADING
        proc.on_chain_stale()
        assert proc._sm.state == TradingState.CHAIN_STALE

    def test_chain_recovered_transitions_back_to_trading(self):
        proc = _make_processor(warm_up=1)
        proc.on_underlying_tick(_tick(24100.0))
        time.sleep(1.1)
        proc.on_underlying_tick(_tick(24100.0))
        proc.on_chain_stale()
        proc.on_chain_recovered()
        assert proc._sm.state == TradingState.TRADING


# ══════════════════════════════════════════════════════════════════════════════
# TestTickProcessorOutput
# ══════════════════════════════════════════════════════════════════════════════


class TestTickProcessorOutput:

    def _run(self, n_ticks: int = 20, spot: float = 24150.0) -> TickProcessor:
        proc = _make_processor(warm_up=1)
        proc.on_session_open(_session_end_sec())
        proc.on_chain_snapshot(_make_snapshot(spot))

        base_ts = datetime(2026, 4, 14, 9, 15, 0, tzinfo=_IST).timestamp()
        for i in range(n_ticks):
            proc.on_underlying_tick(_tick(spot, ts=base_ts + i))

        # Push ticks 2 minutes later to flush 60s window
        flush_base = base_ts + n_ticks + 130
        for j in range(5):
            proc.on_underlying_tick(_tick(spot, ts=flush_base + j))

        proc.on_session_close()
        return proc

    def test_tick_count_is_correct(self):
        proc = self._run(20)
        assert proc._underlying_tick_count == 25  # 20 + 5 flush ticks

    def test_emitter_has_rows(self):
        proc = self._run(20)
        assert proc._emitter.row_count > 0

    def test_all_rows_emitted_after_session_close(self):
        proc = self._run(20)
        # After flush_all in session_close, all rows should be emitted
        assert proc._emitter.row_count == proc._underlying_tick_count

    def test_parquet_has_correct_columns(self, tmp_path):
        import pyarrow.parquet as pq

        proc = self._run(30)
        path = tmp_path / "test.parquet"
        proc._emitter.write_parquet(path)
        table = pq.read_table(path)
        assert len(table.schema.names) == 370

    def test_parquet_column_names_match_spec(self, tmp_path):
        import pyarrow.parquet as pq

        proc = self._run(30)
        path = tmp_path / "test.parquet"
        proc._emitter.write_parquet(path)
        table = pq.read_table(path)
        assert set(table.schema.names) == set(COLUMN_NAMES)

    def test_timestamps_increase(self, tmp_path):
        import pyarrow.parquet as pq

        proc = self._run(30)
        path = tmp_path / "test.parquet"
        proc._emitter.write_parquet(path)
        table = pq.read_table(path)
        ts = table.column("timestamp").to_pylist()
        assert ts == sorted(ts)


# ══════════════════════════════════════════════════════════════════════════════
# TestOptionTickIntegration
# ══════════════════════════════════════════════════════════════════════════════


class TestOptionTickIntegration:

    def test_option_tick_stored(self):
        proc = _make_processor()
        proc.on_chain_snapshot(_make_snapshot())
        proc.on_option_tick(24150, "CE", _opt_tick(250.0))
        assert proc._opt_store.tick_available(24150, "CE")

    def test_option_tick_pe_stored(self):
        proc = _make_processor()
        proc.on_chain_snapshot(_make_snapshot())
        proc.on_option_tick(24150, "PE", _opt_tick(150.0))
        assert proc._opt_store.tick_available(24150, "PE")

    def test_option_feed_stale_false_when_fresh(self):
        proc = _make_processor()
        proc.on_chain_snapshot(_make_snapshot(24150.0))
        ts = _now()
        # Feed all ATM ±3 strikes
        for off in range(-3, 4):
            strike = 24150 + off * 50
            proc.on_option_tick(strike, "CE", _opt_tick(100.0, ts=ts))
            proc.on_option_tick(strike, "PE", _opt_tick(100.0, ts=ts))
        result = proc._check_option_feed_stale(proc._cache.atm_window, ts + 1)
        assert result is False

    def test_option_feed_stale_true_when_not_ticked(self):
        proc = _make_processor(option_tick_timeout_sec=5)
        proc.on_chain_snapshot(_make_snapshot(24150.0))
        # Don't feed any option ticks — all ATM ±3 strikes are unavailable
        result = proc._check_option_feed_stale(proc._cache.atm_window, _now())
        assert result is True


# ══════════════════════════════════════════════════════════════════════════════
# TestFeedStaleCheck
# ══════════════════════════════════════════════════════════════════════════════


class TestFeedStaleCheck:

    def test_not_stale_before_any_tick(self):
        proc = _make_processor()
        assert proc.check_feed_stale() is False

    def test_not_stale_immediately_after_tick(self):
        proc = _make_processor(underlying_tick_timeout_sec=5)
        proc.on_underlying_tick(_tick(24100.0))
        assert proc.check_feed_stale() is False

    def test_stale_after_timeout(self):
        proc = _make_processor(underlying_tick_timeout_sec=1)
        proc.on_underlying_tick(_tick(24100.0))
        proc._last_tick_time = time.monotonic() - 2.0  # fake 2s ago
        assert proc.check_feed_stale() is True
        assert proc._sm.state == TradingState.FEED_STALE


# ══════════════════════════════════════════════════════════════════════════════
# TestSessionLifecycle
# ══════════════════════════════════════════════════════════════════════════════


class TestSessionLifecycle:

    def test_on_session_open_resets_tick_count(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        proc.on_underlying_tick(_tick(24100.0))
        assert proc._underlying_tick_count == 1
        proc.on_session_open(_session_end_sec())  # new session
        assert proc._underlying_tick_count == 0

    def test_on_session_close_flushes_pending(self):
        proc = _make_processor(warm_up=1)
        proc.on_session_open(_session_end_sec())
        proc.on_chain_snapshot(_make_snapshot())
        base_ts = datetime(2026, 4, 14, 9, 15, 0, tzinfo=_IST).timestamp()
        for i in range(10):
            proc.on_underlying_tick(_tick(24150.0, ts=base_ts + i))
        assert proc._emitter.row_count == 0  # none flushed yet (no mature pending)
        proc.on_session_close()
        assert proc._emitter.row_count == 10  # all flushed

    def test_session_end_sec_stored(self):
        proc = _make_processor()
        end = _session_end_sec()
        proc.on_session_open(end)
        assert proc._session_end_sec == end


# ══════════════════════════════════════════════════════════════════════════════
# TestTargetBackfillInProcessor
# ══════════════════════════════════════════════════════════════════════════════


class TestTargetBackfillInProcessor:

    def test_target_columns_present_after_session(self, tmp_path):
        import pyarrow.parquet as pq

        proc = _make_processor(warm_up=1, target_windows_sec=(30, 60))
        proc.on_session_open(_session_end_sec())
        proc.on_chain_snapshot(_make_snapshot())
        base_ts = datetime(2026, 4, 14, 9, 15, 0, tzinfo=_IST).timestamp()
        for i in range(80):
            proc.on_underlying_tick(_tick(24150.0, ts=base_ts + i))
        proc.on_session_close()

        path = tmp_path / "proc_test.parquet"
        proc._emitter.write_parquet(path)
        table = pq.read_table(path)
        cols = set(table.schema.names)
        assert "max_upside_30s" in cols
        assert "direction_30s" in cols
        assert "max_upside_60s" in cols
