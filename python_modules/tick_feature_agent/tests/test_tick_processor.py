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
        # 2-window default profile: 402 legacy + 69 Phase 2 trend/swing = 471.
        # +2 for atm_ce_security_id / atm_pe_security_id which the tick
        # processor appends to the row but aren't in COLUMN_NAMES = 473.
        assert len(table.schema.names) == 473

    def test_parquet_column_names_match_spec(self, tmp_path):
        import pyarrow.parquet as pq

        proc = self._run(30)
        path = tmp_path / "test.parquet"
        proc._emitter.write_parquet(path)
        table = pq.read_table(path)
        # Tick processor appends atm_ce/pe_security_id post-assemble; these
        # are NOT in COLUMN_NAMES (preprocessor strips object dtype).
        extra_metadata = {"atm_ce_security_id", "atm_pe_security_id"}
        assert set(table.schema.names) - extra_metadata == set(COLUMN_NAMES)

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


# ══════════════════════════════════════════════════════════════════════════════
# TestFeatureHistoriesPopulation (Phase 2d-02)
# ══════════════════════════════════════════════════════════════════════════════


class TestFeatureHistoriesPopulation:
    """Chain snapshots landing in TickProcessor must populate the caller-side
    history buffers that the new trend/swing features consume."""

    def test_chain_snapshot_populates_pcr_history(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        proc.on_chain_snapshot(_make_snapshot(24150.0))
        pcr_history = proc._histories.pcr_list()
        assert len(pcr_history) == 1
        ts, pcr = pcr_history[0]
        # PCR = put_oi / call_oi. ATM fixture has put=8000, call=10000 per
        # row × 7 strikes → 56000 / 70000 = 0.8.
        assert pcr == pytest.approx(0.8)

    def test_chain_snapshot_populates_oi_totals_history(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        proc.on_chain_snapshot(_make_snapshot(24150.0))
        oi_history = proc._histories.oi_totals_list()
        assert len(oi_history) == 1
        ts, ce_oi, pe_oi = oi_history[0]
        assert ce_oi == pytest.approx(70_000.0)  # 10000 × 7 strikes
        assert pe_oi == pytest.approx(56_000.0)  # 8000  × 7 strikes

    def test_chain_snapshot_populates_iv_velocity_history(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        proc.on_chain_snapshot(_make_snapshot(24150.0))
        iv_history = proc._histories.iv_velocity_list()
        assert len(iv_history) == 1
        ts, ce_iv_dec, pe_iv_dec, spot = iv_history[0]
        # Fixture publishes IV in percent (18.5 / 17.5) — buffer must
        # store decimals (0.185 / 0.175) so feature modules see the
        # same units they were tested with.
        assert ce_iv_dec == pytest.approx(0.185)
        assert pe_iv_dec == pytest.approx(0.175)
        assert spot == pytest.approx(24150.0)

    def test_chain_snapshot_populates_active_strikes_history(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        proc.on_chain_snapshot(_make_snapshot(24150.0))
        active = proc._histories.active_strikes_list()
        assert len(active) == 1
        ts, rows = active[0]
        # The fixture emits 7 strikes (ATM ± 3).
        assert len(rows) == 7
        # Compacted rows must carry the minimal C7 key set.
        assert set(rows[0].keys()) == {
            "strike", "callOI", "putOI", "callOIChange", "putOIChange",
        }

    def test_session_open_resets_histories(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        proc.on_chain_snapshot(_make_snapshot(24150.0))
        assert len(proc._histories.pcr_list()) == 1

        # Simulate next-day session start.
        proc.on_session_open(_session_end_sec())
        assert proc._histories.pcr_list() == []
        assert proc._histories.oi_totals_list() == []
        assert proc._histories.iv_velocity_list() == []
        assert proc._histories.active_strikes_list() == []

    def test_multiple_snapshots_accrue_into_buffers(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        for i in range(3):
            proc.on_chain_snapshot(_make_snapshot(24150.0 + i))
        assert len(proc._histories.pcr_list()) == 3
        assert len(proc._histories.oi_totals_list()) == 3
        assert len(proc._histories.iv_velocity_list()) == 3


# ══════════════════════════════════════════════════════════════════════════════
# TestStatefulTrackerWiring (Phase 2d-03)
# ══════════════════════════════════════════════════════════════════════════════


def _tick_with_vol(ltp: float = 24150.0, ts: float | None = None, vol: int = 100) -> dict:
    """Helper — like _tick() but lets the test set the tick volume."""
    return {
        "ltp": ltp,
        "bid": ltp - 0.5,
        "ask": ltp + 0.5,
        "ltq": vol,
        "recv_ts": ts if ts is not None else _now(),
    }


class TestStatefulTrackerWiring:
    """The 6 per-instrument trackers added in 2d-03 must instantiate
    on construction, configure / reset on session_open, and update on
    the correct callbacks (tick / option-tick / chain-snapshot)."""

    def test_trackers_exist_after_construction(self):
        proc = _make_processor()
        # All six trackers must be live attributes.
        assert proc._bars is not None
        assert proc._session_state is not None
        assert proc._opening_range is not None
        assert proc._premium_vwap is not None
        assert proc._exhaustion is not None
        assert proc._oi_dominance is not None

    def test_session_open_configures_opening_range_window(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        # The OR window-end should be session_start (09:15 IST) + 15 min = 09:30 IST.
        expected = datetime(2026, 4, 14, 9, 30, tzinfo=_IST).timestamp()
        assert proc._opening_range.window_end_ts == pytest.approx(expected)

    def test_underlying_tick_feeds_bar_aggregator(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        ts = datetime(2026, 4, 14, 10, 0, 0, tzinfo=_IST).timestamp()
        proc.on_underlying_tick(_tick_with_vol(ltp=24150.0, ts=ts, vol=42))
        cur = proc._bars.current_bar(60)
        assert cur is not None
        assert cur.open == pytest.approx(24150.0)
        assert cur.volume >= 42

    def test_underlying_tick_feeds_session_state(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        ts = datetime(2026, 4, 14, 10, 0, 0, tzinfo=_IST).timestamp()
        proc.on_underlying_tick(_tick_with_vol(ltp=24100.0, ts=ts, vol=10))
        assert proc._session_state.open_price == pytest.approx(24100.0)
        assert proc._session_state.session_high == pytest.approx(24100.0)
        assert proc._session_state.session_low == pytest.approx(24100.0)

    def test_underlying_tick_feeds_opening_range_inside_window(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        ts = datetime(2026, 4, 14, 9, 20, 0, tzinfo=_IST).timestamp()  # inside OR
        proc.on_underlying_tick(_tick_with_vol(ltp=24105.0, ts=ts, vol=10))
        assert proc._opening_range.or_high == pytest.approx(24105.0)
        assert proc._opening_range.or_low == pytest.approx(24105.0)

    def test_opening_range_ignores_tick_outside_window(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        ts = datetime(2026, 4, 14, 11, 0, 0, tzinfo=_IST).timestamp()  # past 09:30
        proc.on_underlying_tick(_tick_with_vol(ltp=24105.0, ts=ts, vol=10))
        assert proc._opening_range.or_high is None
        assert proc._opening_range.or_low is None

    def test_atm_option_tick_feeds_premium_vwap_ce(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        proc.on_chain_snapshot(_make_snapshot(24150.0))   # so _cache.atm == 24150
        atm = proc._cache.atm
        assert atm is not None
        proc.on_option_tick(
            strike=int(atm),
            opt_type="CE",
            data={"ltp": 250.0, "bid": 249.0, "ask": 251.0, "ltq": 5, "recv_ts": _now()},
        )
        assert proc._premium_vwap.ce_cum_volume > 0
        assert proc._premium_vwap.ce_vwap == pytest.approx(250.0)

    def test_non_atm_option_tick_skipped_by_premium_vwap(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        proc.on_chain_snapshot(_make_snapshot(24150.0))
        atm = proc._cache.atm
        non_atm = int(atm) + 200
        proc.on_option_tick(
            strike=non_atm,
            opt_type="CE",
            data={"ltp": 99.0, "bid": 98, "ask": 100, "ltq": 5, "recv_ts": _now()},
        )
        assert proc._premium_vwap.ce_cum_volume == 0

    def test_chain_snapshot_feeds_oi_dominance(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        proc.on_chain_snapshot(_make_snapshot(24150.0))
        # Fixture has +500 callOIChange and +300 putOIChange per strike × 7
        # strikes → call_change > put_change → +1 side.
        assert proc._oi_dominance.current_side == 1
        assert proc._oi_dominance.streak_start_ts is not None

    def test_session_open_resets_all_trackers(self):
        proc = _make_processor()
        proc.on_session_open(_session_end_sec())
        ts = datetime(2026, 4, 14, 10, 0, 0, tzinfo=_IST).timestamp()
        proc.on_underlying_tick(_tick_with_vol(ts=ts, vol=10))
        proc.on_chain_snapshot(_make_snapshot(24150.0))
        # Re-open for next session — everything must be cleared.
        proc.on_session_open(_session_end_sec())
        assert proc._session_state.open_price is None
        assert proc._bars.current_bar(60) is None
        assert proc._opening_range.or_high is None
        assert proc._premium_vwap.ce_cum_volume == 0
        assert proc._oi_dominance.current_side == 0
        assert proc._exhaustion.trend_age_ticks == 0


# ══════════════════════════════════════════════════════════════════════════════
# TestPhase2dOrchestration (Phase 2d-04)
# ══════════════════════════════════════════════════════════════════════════════


class TestPhase2dOrchestration:
    """Verify that `_compute_row` actually populates the 69 new Phase 2 columns
    with finite values after a representative tick stream (chain snapshot
    landed + bars + session state primed)."""

    def _prime(self, n_ticks: int = 40, spot: float = 24150.0):
        """Build a processor, open a session, deliver a chain snapshot, and
        run `n_ticks` underlying ticks spaced 1 s apart starting at
        10:00 IST. Returns (proc, last_row)."""
        proc = _make_processor(warm_up=1)
        proc.on_session_open(_session_end_sec())
        proc.on_chain_snapshot(_make_snapshot(spot))
        base = datetime(2026, 4, 14, 10, 0, 0, tzinfo=_IST).timestamp()
        last_row = None
        for i in range(n_ticks):
            ts = base + i
            proc.on_underlying_tick(_tick_with_vol(ltp=spot + i * 0.1, ts=ts, vol=10))
            # _compute_row stashes into _pending; the most recently appended
            # PendingRow has the latest row.
            if proc._pending:
                last_row = proc._pending[-1].row
        return proc, last_row

    def test_row_carries_phase2_column_names(self):
        _, row = self._prime(n_ticks=10)
        # A spot-check across feature groups.
        expected_keys = {
            "india_vix",
            "india_vix_change_5min",
            "net_gex",
            "gamma_flip_distance_pct",
            "max_pain_strike",
            "is_tier_2_event_day",
            "oi_weighted_ce_resistance_strike",
            "ce_wall_strength_rel",
            "ce_oi_change_5min_pct",
            "oi_dominance_streak_min",
            "pcr_intraday_slope_30min",
            "iv_change_5min",
            "active_strike_shift_direction",
            "distance_to_prev_day_high_pct",
            "distance_to_round_number_above_pct",
            "ma_5_5min",
            "adx_5min",
            "rsi_14_5min",
            "macd_5min",
            "dist_from_session_open_pct",
            "session_high_age_min",
            "distance_to_opening_range_high_pct",
            "minutes_from_open",
            "lunch_session_flag",
            "atm_ce_premium_vwap_dist",
            "trend_age_ticks",
            "volume_no_move_score",
            "days_to_expiry_bucket",
        }
        missing = expected_keys - set(row.keys())
        assert not missing, f"missing Phase 2 keys in row: {sorted(missing)}"

    def test_chain_features_populated_after_snapshot(self):
        _, row = self._prime(n_ticks=5)
        # Chain-derived features must be finite after a chain snapshot lands.
        for key in (
            "max_pain_strike",
            "oi_weighted_ce_resistance_strike",
            "oi_weighted_pe_support_strike",
            "ce_wall_strength_rel",
            "pe_wall_strength_rel",
        ):
            assert math.isfinite(row[key]), f"{key} = {row[key]} (expected finite)"

    def test_session_relative_features_populated(self):
        _, row = self._prime(n_ticks=10)
        assert math.isfinite(row["dist_from_session_open_pct"])
        # session_high_age_min is non-negative.
        assert row["session_high_age_min"] >= 0
        assert row["session_low_age_min"] >= 0

    def test_intraday_time_features_populated(self):
        _, row = self._prime(n_ticks=5)
        # Ticks start at 10:00 IST, session open 09:15 IST → 45 min from open.
        assert row["minutes_from_open"] == pytest.approx(45.0, abs=0.1)
        # lunch_session_flag is 0 (10:00 IST is outside the 12:00 lunch hour).
        assert row["lunch_session_flag"] == 0.0
        assert row["minutes_to_close"] > 0

    def test_oi_dominance_streak_finite_after_snapshot(self):
        _, row = self._prime(n_ticks=2)
        # Fixture chain has CE OI change > PE OI change → +1 dominance side,
        # but the very first snapshot starts a fresh streak so the value is
        # zero before any time has elapsed. Just verify it's finite + sign-ok.
        assert math.isfinite(row["oi_dominance_streak_min"])
        assert row["oi_dominance_streak_min"] >= 0

    def test_dte_bucket_populated_when_expiry_known(self):
        _, row = self._prime(n_ticks=2)
        # Fixture expiry is 2026-04-17, session 2026-04-14 → 3 DTE bucket.
        assert math.isfinite(row["days_to_expiry_bucket"])

    def test_features_remain_finite_after_long_tick_stream(self):
        """Stress: 200 ticks should not introduce any NaN-bloom or crash."""
        _, row = self._prime(n_ticks=200)
        assert row is not None
        # Bar-derived features need bars to have finalised; after ~3 min of
        # 1-Hz ticks we should have a couple of 1-min bars.
        assert math.isfinite(row["max_pain_strike"])
        assert math.isfinite(row["minutes_from_open"])
