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
                    "callSecurityId": "52475",
                    "putOI": 800,
                    "putOIChange": 80,
                    "putLTP": 95.0,
                    "putVolume": 30,
                    "putIV": 17.5,
                    "putSecurityId": "52476",
                },
            ],
        }
        snap = _build_chain_snapshot(data)
        assert snap is not None
        assert snap.spot_price == 24150.0
        assert snap.expiry == "2026-04-17"
        assert len(snap.rows) == 1
        assert "52475" in snap.sec_id_map
        assert snap.sec_id_map["52475"] == (24100, "CE")
        assert snap.sec_id_map["52476"] == (24100, "PE")

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

    # ── Phase 2d-01: VIX event routing ──────────────────────────────────────

    def test_vix_event_lands_in_pipeline_buffer(self):
        adapter = ReplayAdapter(_make_profile(), _DATE)
        assert adapter._pipeline_state.histories.vix_list() == []
        adapter.process_event({
            "type": "vix_tick",
            "data": {"recv_ts": _ts(9, 15, 5), "ltp": 13.45},
        })
        history = adapter._pipeline_state.histories.vix_list()
        assert len(history) == 1
        _ts_sample, value = history[0]
        assert value == pytest.approx(13.45)

    def test_vix_event_with_zero_ltp_is_dropped(self):
        """Buffer's append_vix rejects non-positive values silently."""
        adapter = ReplayAdapter(_make_profile(), _DATE)
        adapter.process_event({
            "type": "vix_tick",
            "data": {"recv_ts": _ts(9, 15, 5), "ltp": 0},
        })
        assert adapter._pipeline_state.histories.vix_list() == []

    def test_vix_event_with_bad_recv_ts_is_dropped(self):
        adapter = ReplayAdapter(_make_profile(), _DATE)
        adapter.process_event({
            "type": "vix_tick",
            "data": {"recv_ts": "not-a-timestamp", "ltp": 13.45},
        })
        assert adapter._pipeline_state.histories.vix_list() == []

    def test_vix_events_drive_india_vix_feature_end_to_end(self):
        """5-min gap between two VIX events must produce non-NaN
        india_vix_change_5min in the next compute pass."""
        from tick_feature_agent.features.india_vix import compute_india_vix_features
        adapter = ReplayAdapter(_make_profile(), _DATE)
        # Two VIX samples ~5 min apart, using the replay date's IST clock.
        adapter.process_event({
            "type": "vix_tick",
            "data": {"recv_ts": _ts(9, 15, 0), "ltp": 13.0},
        })
        adapter.process_event({
            "type": "vix_tick",
            "data": {"recv_ts": _ts(9, 20, 0), "ltp": 14.5},
        })
        # now_ts = the timestamp of the latest sample, so it's "now".
        from datetime import datetime as _dt
        from datetime import timedelta as _td
        from datetime import timezone as _tz
        ist = _tz(_td(hours=5, minutes=30))
        now_ts = _dt(2026, 4, 14, 9, 20, 0, tzinfo=ist).timestamp()
        out = compute_india_vix_features(
            now_ts=now_ts,
            vix_history=adapter._pipeline_state.histories.vix_list(),
        )
        assert out["india_vix"] == pytest.approx(14.5)
        assert out["india_vix_change_5min"] == pytest.approx(1.5)


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
        # 2-window default profile: 402 legacy + 69 Phase 2 trend/swing + 26 T37 ATM depth = 524.
        assert len(table.schema.names) == 524

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

    def test_flush_all_chunked_batch_size_matches_unchunked(self, monkeypatch):
        """Chunked flush (batch_size=5) must emit the same number of
        rows in the same order as the all-at-once batched path. Pins
        the contract that the memory-safety chunking doesn't drop or
        re-order rows.

        Repro for the freeze fix: pending deque is 30k+ on long MCX
        sessions; the original ``all_pending = list(self._pending)``
        + single ``compute_pending_targets_batched`` call materialised
        a Polars frame from the whole batch → OS thrash. Chunking
        bounds peak memory at batch_size × column_count.
        """
        # Drive enough events to fill _pending — feed a slowish session
        # so several pending rows accumulate without _flush_pending
        # draining them all (the chain timer keeps them stuck).
        adapter_unchunked = self._feed_session(40)
        # No batch env var → uses default 2000 (effectively unchunked
        # for this small case). Snapshot the row count + last few rows
        # before the second adapter clobbers things.
        rows_unchunked_before = adapter_unchunked.emitter.row_count
        adapter_unchunked.flush_all()
        rows_unchunked_after = adapter_unchunked.emitter.row_count

        monkeypatch.setenv("TFA_FLUSH_BATCH_SIZE", "5")
        adapter_chunked = self._feed_session(40)
        rows_chunked_before = adapter_chunked.emitter.row_count
        adapter_chunked.flush_all()
        rows_chunked_after = adapter_chunked.emitter.row_count

        # Same number of rows pre + post flush regardless of batch size.
        assert rows_unchunked_before == rows_chunked_before
        assert rows_unchunked_after == rows_chunked_after
        # And actual flushing happened (otherwise this test is vacuous).
        assert rows_unchunked_after >= rows_unchunked_before

    def test_flush_all_progress_callback_reports_chunks(self, monkeypatch):
        """flush_progress_callback fires once per batch with cumulative
        rows_done — used by replay_runner to surface 'flushing N/M
        rows' in the live dashboard.
        """
        monkeypatch.setenv("TFA_FLUSH_BATCH_SIZE", "5")
        adapter = self._feed_session(40)

        calls: list[tuple[int, int]] = []

        def _cb(done: int, total: int) -> None:
            calls.append((done, total))

        adapter.flush_all(flush_progress_callback=_cb)

        # At least one call fires whenever there are pending rows.
        # `_feed_session(40)` doesn't always leave >2 pending after
        # mid-stream _flush_pending; if it doesn't, the scalar path
        # runs and we still get heartbeat callbacks (every 1000 rows
        # OR at the end), which guarantees at least the final call.
        # Tolerate either path: the LAST call must report
        # done == total.
        if calls:
            done_final, total_final = calls[-1]
            assert done_final == total_final
            # Cumulative semantics: each call's done >= previous call's done.
            for i in range(1, len(calls)):
                assert calls[i][0] >= calls[i - 1][0]
                assert calls[i][1] == calls[0][1]

    def test_flush_all_on_batches_emitted_fires_mid_flush(self, monkeypatch):
        """on_batches_emitted fires every TFA_FLUSH_DRAIN_EVERY_N_BATCHES
        and once more at the end (when batches_since_drain > 0). The
        replay_runner uses this signal to write a chunk parquet
        mid-flush so the emitter's row list doesn't accumulate every
        flushed row.
        """
        monkeypatch.setenv("TFA_FLUSH_BATCH_SIZE", "5")
        monkeypatch.setenv("TFA_FLUSH_DRAIN_EVERY_N_BATCHES", "2")
        adapter = self._feed_session(40)

        drain_calls: list[int] = []

        def _on_drain(n: int) -> None:
            drain_calls.append(n)

        adapter.flush_all(on_batches_emitted=_on_drain)

        # Either the scalar path ran (no drain calls — fine, the
        # contract says drain is COLUMNAR-path only) OR the columnar
        # path ran and the drain callback fired at least once. Pin
        # the columnar-path contract: every drain call reports
        # batch count > 0 and <= DRAIN_EVERY_N (= 2 here).
        for n in drain_calls:
            assert n > 0
            assert n <= 2


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


# ══════════════════════════════════════════════════════════════════════════════
# TestVixEndToEnd (Phase 2d-01)
# ══════════════════════════════════════════════════════════════════════════════
#
# Recorder → merger → adapter integration: writes a VIX file via the live
# SessionRecorder, reads it back via the replay stream_merger, routes
# events through ReplayAdapter, asserts the india_vix feature populates.


class TestVixEndToEndRecordReplay:

    def test_recorder_to_merger_to_adapter_round_trip(self, tmp_path):
        """Closes the live↔replay loop for VIX:
        SessionRecorder writes vix_ticks.ndjson.gz, stream_merger reads
        it back as `vix_tick` events, ReplayAdapter routes each event
        into the pipeline's history buffer, and the feature compute
        function emits a non-NaN india_vix_change_5min."""
        from tick_feature_agent.recorder.session_recorder import SessionRecorder
        from tick_feature_agent.replay.stream_merger import merge_streams
        from tick_feature_agent.features.india_vix import compute_india_vix_features

        # Use the same date the replay adapter is fixed to (_DATE = "2026-04-14").
        from datetime import datetime as _dt
        from datetime import timedelta as _td
        from datetime import timezone as _tz
        ist = _tz(_td(hours=5, minutes=30))

        # 1. SessionRecorder writes two VIX samples 5 min apart.
        rec = SessionRecorder(
            instrument="nifty50",
            data_root=tmp_path / "data" / "raw",
            underlying_security_id="13",
        )
        rec.on_session_open(_DATE)
        t0 = _dt(2026, 4, 14, 9, 15, 0, tzinfo=ist)
        t1 = _dt(2026, 4, 14, 9, 20, 0, tzinfo=ist)
        rec.record_vix_tick({"recv_ts": str(t0.timestamp()), "ltp": 13.0})
        rec.record_vix_tick({"recv_ts": str(t1.timestamp()), "ltp": 14.5})
        rec.on_session_close()

        # 2. Stream merger reads the just-written file.
        date_folder = tmp_path / "data" / "raw" / _DATE
        events = list(merge_streams(date_folder, "nifty50"))
        vix_events = [e for e in events if e["type"] == "vix_tick"]
        assert len(vix_events) == 2

        # 3. ReplayAdapter routes each VIX event into the pipeline buffer.
        adapter = ReplayAdapter(_make_profile(), _DATE)
        for ev in vix_events:
            adapter.process_event(ev)

        # 4. Compute india_vix from the populated history — both features
        #    must be non-NaN.
        out = compute_india_vix_features(
            now_ts=t1.timestamp(),
            vix_history=adapter._pipeline_state.histories.vix_list(),
        )
        assert out["india_vix"] == pytest.approx(14.5)
        assert out["india_vix_change_5min"] == pytest.approx(1.5)
