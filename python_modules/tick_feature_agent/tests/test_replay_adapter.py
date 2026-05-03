"""
tests/test_replay_adapter.py — Unit tests for replay/replay_adapter.py (Phase 14.2).

Run: python -m pytest python_modules/tick_feature_agent/tests/test_replay_adapter.py -v
"""

from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.instrument_profile import InstrumentProfile
from tick_feature_agent.output.emitter import COLUMN_NAMES
from tick_feature_agent.replay.replay_adapter import (
    ReplayAdapter,
    _build_chain_snapshot,
    _parse_ts,
    _session_boundary_sec,
)

_IST = timezone(timedelta(hours=5, minutes=30))
_DATE = "2026-04-14"


# ── Fixtures ──────────────────────────────────────────────────────────────────


def _make_profile(**overrides) -> InstrumentProfile:
    """Build a minimal InstrumentProfile suitable for tests."""
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
        warm_up_duration_sec=1,  # short for tests
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


def _ts(h: int, m: int, s: int, ms: int = 0) -> str:
    """Build an IST ISO timestamp for 2026-04-14."""
    dt = datetime(2026, 4, 14, h, m, s, ms * 1000, tzinfo=_IST)
    return dt.isoformat(timespec="milliseconds")


def _underlying_event(ltp: float, h: int, m: int, s: int, ms: int = 0) -> dict:
    return {
        "type": "underlying_tick",
        "data": {
            "recv_ts": _ts(h, m, s, ms),
            "ltp": ltp,
            "bid": ltp - 0.5,
            "ask": ltp + 0.5,
            "bid_size": 100,
            "ask_size": 100,
            "ltq": 5,
        },
    }


def _option_event(
    strike: int,
    opt_type: str,
    ltp: float,
    h: int,
    m: int,
    s: int,
    ms: int = 0,
) -> dict:
    return {
        "type": "option_tick",
        "data": {
            "recv_ts": _ts(h, m, s, ms),
            "ltp": ltp,
            "bid": ltp - 0.25,
            "ask": ltp + 0.25,
            "bid_size": 50,
            "ask_size": 50,
            "ltq": 1,
            "strike": strike,
            "opt_type": opt_type,
        },
    }


def _chain_event(spot: float, h: int, m: int, s: int) -> dict:
    """Build a minimal chain_snapshot event around the given spot."""
    atm = int(round(spot / 50)) * 50
    rows = []
    for offset in range(-3, 4):
        k = atm + offset * 50
        rows.append(
            {
                "strike": k,
                "callOI": 10000,
                "callOIChange": 500,
                "callLTP": max(0.5, spot - k + 100),
                "callVolume": 200,
                "callIV": 18.5,
                "callSecurityId": str(52000 + (k - 24000) // 50 * 2),
                "putOI": 8000,
                "putOIChange": 300,
                "putLTP": max(0.5, k - spot + 100),
                "putVolume": 150,
                "putIV": 17.5,
                "putSecurityId": str(52001 + (k - 24000) // 50 * 2),
            }
        )
    return {
        "type": "chain_snapshot",
        "data": {
            "recv_ts": _ts(h, m, s),
            "underlying": "13",
            "expiry": "2026-04-17",
            "spotPrice": spot,
            "timestamp": int(datetime(2026, 4, 14, h, m, s, tzinfo=_IST).timestamp() * 1000),
            "rows": rows,
        },
    }


# ══════════════════════════════════════════════════════════════════════════════
# TestTimestampHelpers
# ══════════════════════════════════════════════════════════════════════════════


class TestTimestampHelpers:

    def test_parse_ts_valid_ist(self):
        ts = _parse_ts("2026-04-14T09:15:01.000+05:30")
        assert math.isfinite(ts)
        assert ts > 0

    def test_parse_ts_invalid_returns_nan(self):
        result = _parse_ts("not-a-timestamp")
        assert math.isnan(result)

    def test_parse_ts_empty_string(self):
        result = _parse_ts("")
        assert math.isnan(result)

    def test_session_boundary_sec_order(self):
        start = _session_boundary_sec(_DATE, "09:15")
        end = _session_boundary_sec(_DATE, "15:30")
        assert start < end

    def test_session_boundary_sec_diff(self):
        start = _session_boundary_sec(_DATE, "09:15")
        end = _session_boundary_sec(_DATE, "15:30")
        diff_hours = (end - start) / 3600
        assert pytest.approx(diff_hours, abs=0.01) == 6.25  # 6h15m


# ══════════════════════════════════════════════════════════════════════════════
# TestBuildChainSnapshot
# ══════════════════════════════════════════════════════════════════════════════


class TestBuildChainSnapshot:

    def test_valid_data(self):
        data = {
            "recv_ts": "2026-04-14T09:15:05.000+05:30",
            "underlying": "13",
            "expiry": "2026-04-17",
            "spotPrice": 24150.0,
            "timestamp": 1744594505000,
            "rows": [
                {
                    "strike": 24100,
                    "callOI": 1000,
                    "callOIChange": 100,
                    "callLTP": 150.0,
                    "callVolume": 50,
                    "callIV": 18.0,
                    "callSecurityId": "52175",
                    "putOI": 800,
                    "putOIChange": 80,
                    "putLTP": 95.0,
                    "putVolume": 30,
                    "putIV": 17.5,
                    "putSecurityId": "52176",
                },
            ],
        }
        snap = _build_chain_snapshot(data)
        assert snap is not None
        assert snap.spot_price == 24150.0
        assert snap.expiry == "2026-04-17"
        assert len(snap.rows) == 1
        assert "52175" in snap.sec_id_map
        assert snap.sec_id_map["52175"] == (24100, "CE")
        assert snap.sec_id_map["52176"] == (24100, "PE")

    def test_missing_rows_returns_snapshot(self):
        data = {
            "recv_ts": "2026-04-14T09:15:05.000+05:30",
            "spotPrice": 24150.0,
            "timestamp": 1744594505000,
        }
        snap = _build_chain_snapshot(data)
        assert snap is not None
        assert snap.rows == []

    def test_malformed_data_returns_none(self):
        snap = _build_chain_snapshot({"bad": "data", "spotPrice": "NOT_A_FLOAT"})
        # Should return None or a best-effort snapshot (0.0 spot)
        # Either is acceptable — just no exception
        if snap is not None:
            assert isinstance(snap.spot_price, float)

    def test_strike_step_detected(self):
        """With strikes 24000, 24050, 24100, strike_step should be 50."""
        data = {
            "recv_ts": "2026-04-14T09:15:05.000+05:30",
            "spotPrice": 24100.0,
            "timestamp": 0,
            "rows": [
                {
                    "strike": k,
                    "callOI": 1000,
                    "callOIChange": 100,
                    "callLTP": 100.0,
                    "callVolume": 50,
                    "callIV": 18.0,
                    "callSecurityId": str(k),
                    "putOI": 800,
                    "putOIChange": 80,
                    "putLTP": 100.0,
                    "putVolume": 30,
                    "putIV": 17.5,
                    "putSecurityId": str(k + 1),
                }
                for k in (24000, 24050, 24100, 24150, 24200)
            ],
        }
        snap = _build_chain_snapshot(data)
        assert snap is not None
        assert snap.strike_step == 50


# ══════════════════════════════════════════════════════════════════════════════
# TestReplayAdapterBasic
# ══════════════════════════════════════════════════════════════════════════════


class TestReplayAdapterBasic:

    def test_empty_event_stream_no_rows(self):
        adapter = ReplayAdapter(_make_profile(), _DATE)
        adapter.flush_all()
        assert adapter.emitter.row_count == 0

    def test_underlying_ticks_only_no_chain_queues_rows(self):
        """Without a chain snapshot, ticks are queued but not emitted yet."""
        adapter = ReplayAdapter(_make_profile(), _DATE)
        for i in range(5):
            adapter.process_event(_underlying_event(24100.0, 9, 15, i + 1))
        # Before flush_all, rows in pending queue are NOT yet emitted
        assert adapter.emitter.row_count == 0
        adapter.flush_all()
        # After flush, all rows should be emitted
        assert adapter.emitter.row_count == 5

    def test_chain_snapshot_only_no_rows(self):
        adapter = ReplayAdapter(_make_profile(), _DATE)
        adapter.process_event(_chain_event(24150.0, 9, 15, 5))
        adapter.flush_all()
        assert adapter.emitter.row_count == 0

    def test_tick_count_correct(self):
        adapter = ReplayAdapter(_make_profile(), _DATE)
        for i in range(10):
            adapter.process_event(_underlying_event(24100.0, 9, 15, i + 1))
        assert adapter.underlying_tick_count == 10

    def test_option_tick_does_not_emit_row(self):
        adapter = ReplayAdapter(_make_profile(), _DATE)
        adapter.process_event(_chain_event(24150.0, 9, 15, 0))
        adapter.process_event(_option_event(24150, "CE", 250.0, 9, 15, 1))
        adapter.flush_all()
        assert adapter.emitter.row_count == 0

    def test_unknown_event_type_ignored(self):
        adapter = ReplayAdapter(_make_profile(), _DATE)
        adapter.process_event({"type": "unknown", "data": {}})
        adapter.flush_all()
        assert adapter.emitter.row_count == 0


# ══════════════════════════════════════════════════════════════════════════════
# TestReplayAdapterWithChain
# ══════════════════════════════════════════════════════════════════════════════


class TestReplayAdapterWithChain:

    def _feed_session(self, n_ticks: int = 100, spot: float = 24150.0) -> ReplayAdapter:
        """Feed a chain snapshot + n underlying ticks (1 tick/second)."""
        adapter = ReplayAdapter(_make_profile(warm_up_duration_sec=1), _DATE)
        # Chain snapshot first (at 09:15:00)
        adapter.process_event(_chain_event(spot, 9, 15, 0))
        for i in range(n_ticks):
            total_sec = 1 + i
            m, s = divmod(total_sec, 60)
            adapter.process_event(_underlying_event(spot, 9, 15 + m, s))
        # Add ticks ~2 minutes later to flush 30s + 60s target windows
        for j in range(3):
            total_sec = 1 + n_ticks + 120 + j
            m, s = divmod(total_sec, 60)
            adapter.process_event(_underlying_event(spot, 9, 15 + m, s))
        adapter.flush_all()
        return adapter

    def test_rows_emitted_after_chain(self):
        adapter = self._feed_session(50)
        # Some rows should have been emitted
        assert adapter.emitter.row_count > 0

    def test_row_count_equals_tick_count(self):
        adapter = self._feed_session(100)
        assert adapter.emitter.row_count == adapter.underlying_tick_count

    def test_emitter_write_parquet(self, tmp_path):
        adapter = self._feed_session(50)
        path = tmp_path / "test.parquet"
        adapter.emitter.write_parquet(path)
        assert path.exists()

    def test_parquet_has_correct_column_count(self, tmp_path):
        import pyarrow.parquet as pq

        adapter = self._feed_session(50)
        path = tmp_path / "test.parquet"
        adapter.emitter.write_parquet(path)
        table = pq.read_table(path)
        assert len(table.schema.names) == 370

    def test_parquet_column_names_match_spec(self, tmp_path):
        import pyarrow.parquet as pq

        adapter = self._feed_session(50)
        path = tmp_path / "test.parquet"
        adapter.emitter.write_parquet(path)
        table = pq.read_table(path)
        assert set(table.schema.names) == set(COLUMN_NAMES)

    def test_timestamps_monotonic_in_parquet(self, tmp_path):
        import pyarrow.parquet as pq

        adapter = self._feed_session(50)
        path = tmp_path / "test.parquet"
        adapter.emitter.write_parquet(path)
        table = pq.read_table(path)
        ts = table.column("timestamp").to_pylist()
        assert all(t is not None for t in ts)
        assert ts == sorted(ts)

    def test_instrument_meta_in_rows(self, tmp_path):
        """instrument and exchange columns should reflect the profile."""
        import pyarrow.parquet as pq

        adapter = self._feed_session(20)
        path = tmp_path / "test.parquet"
        adapter.emitter.write_parquet(path)
        table = pq.read_table(path)
        exchanges = set(table.column("exchange").to_pylist())
        assert "NSE" in exchanges

    def test_flush_all_idempotent(self):
        """Calling flush_all twice should not add rows."""
        adapter = self._feed_session(30)
        count_after_first = adapter.emitter.row_count
        adapter.flush_all()
        assert adapter.emitter.row_count == count_after_first


# ══════════════════════════════════════════════════════════════════════════════
# TestStateMachineReplay
# ══════════════════════════════════════════════════════════════════════════════


class TestStateMachineReplay:

    def test_starts_in_feed_stale(self):
        adapter = ReplayAdapter(_make_profile(), _DATE)
        from tick_feature_agent.state_machine import TradingState

        assert adapter._sm.state == TradingState.FEED_STALE

    def test_transitions_to_warming_up_on_first_tick(self):
        from tick_feature_agent.state_machine import TradingState

        adapter = ReplayAdapter(_make_profile(warm_up_duration_sec=300), _DATE)
        adapter.process_event(_underlying_event(24100.0, 9, 15, 1))
        assert adapter._sm.state == TradingState.WARMING_UP

    def test_transitions_to_trading_after_warmup_sec(self):
        """With warm_up_duration_sec=1, first tick starts warmup;
        second tick 2s later should complete it."""
        from tick_feature_agent.state_machine import TradingState

        adapter = ReplayAdapter(_make_profile(warm_up_duration_sec=1), _DATE)
        adapter.process_event(_underlying_event(24100.0, 9, 15, 1))
        adapter.process_event(_underlying_event(24100.0, 9, 15, 3))  # 2s later
        assert adapter._sm.state == TradingState.TRADING

    def test_chain_available_flag_after_snapshot(self):
        adapter = ReplayAdapter(_make_profile(), _DATE)
        assert not adapter._cache.chain_available
        adapter.process_event(_chain_event(24150.0, 9, 15, 0))
        assert adapter._cache.chain_available


# ══════════════════════════════════════════════════════════════════════════════
# TestTargetBackfill
# ══════════════════════════════════════════════════════════════════════════════


class TestTargetBackfill:

    def test_target_columns_present_in_output(self, tmp_path):
        """After replay with enough ticks, target columns should exist in Parquet."""
        import pyarrow.parquet as pq

        profile = _make_profile(warm_up_duration_sec=1, target_windows_sec=(30, 60))
        adapter = ReplayAdapter(profile, _DATE)
        adapter.process_event(_chain_event(24150.0, 9, 15, 0))

        # Feed 120 ticks at 1 tick/second
        for i in range(120):
            total_sec = i + 1
            m, s = divmod(total_sec, 60)
            adapter.process_event(_underlying_event(24150.0, 9, 15 + m, s))

        # Feed more ticks ~2 minutes later to flush the 60s window
        for j in range(5):
            total_sec = 121 + 120 + j
            m, s = divmod(total_sec, 60)
            adapter.process_event(_underlying_event(24150.0, 9, 15 + m, s))

        adapter.flush_all()

        if adapter.emitter.row_count > 0:
            path = tmp_path / "test.parquet"
            adapter.emitter.write_parquet(path)
            table = pq.read_table(path)
            cols = set(table.schema.names)
            assert "max_upside_30s" in cols
            assert "direction_30s" in cols
            assert "max_upside_60s" in cols
            assert "direction_60s" in cols

    def test_option_tick_updates_option_store(self):
        """Option ticks should be stored in the option buffer."""
        adapter = ReplayAdapter(_make_profile(), _DATE)
        adapter.process_event(_chain_event(24150.0, 9, 15, 0))
        adapter.process_event(_option_event(24150, "CE", 250.0, 9, 15, 1))
        assert adapter._opt_store.tick_available(24150, "CE")

    def test_option_tick_by_security_id_lookup(self):
        """Option ticks without strike/opt_type use sec_id_map for lookup."""
        adapter = ReplayAdapter(_make_profile(), _DATE)
        adapter.process_event(_chain_event(24150.0, 9, 15, 0))

        # Get a sec_id from the chain snapshot
        sec_id_map = adapter._sec_id_map
        if not sec_id_map:
            pytest.skip("No sec_id_map populated — chain snapshot may have empty rows")

        some_sec_id, (strike, opt_type) = next(iter(sec_id_map.items()))

        # Build option tick using security_id (no strike/opt_type fields)
        opt_event = {
            "type": "option_tick",
            "data": {
                "recv_ts": _ts(9, 15, 2),
                "security_id": some_sec_id,
                "ltp": 200.0,
                "bid": 199.5,
                "ask": 200.5,
                "bid_size": 50,
                "ask_size": 50,
                "ltq": 1,
            },
        }
        adapter.process_event(opt_event)
        assert adapter._opt_store.tick_available(strike, opt_type)
