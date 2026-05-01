"""
replay/replay_adapter.py — Route recorded events into the full TFA feature pipeline.

Phase 14.2 (spec §16.3).

Replaces DhanFeed (WebSocket) and ChainPoller (REST) during historical replay.
Reads events from stream_merger.merge_streams() and routes them into the same
feature pipeline that runs in live mode, but driven by recorded data.

Two-pass target design:
  Pass 1 (real-time): on each underlying tick, compute all features except targets;
    emit a row with NaN target columns; queue the row for target backfill.
  Pass 2 (deferred): once |T_now - T0| >= max_target_window, backfill target
    columns for the queued row using TargetBuffer.compute_targets(). Rows whose
    target windows extend past the session end are flushed with NaN targets by
    flush_all().

Usage:
    from tick_feature_agent.replay.stream_merger import merge_streams
    from tick_feature_agent.replay.replay_adapter import ReplayAdapter

    adapter = ReplayAdapter(profile, date_str="2026-04-14")
    for event in merge_streams(date_folder, instrument):
        adapter.process_event(event)
    adapter.flush_all()          # finalise remaining pending rows
    em = adapter.emitter         # Emitter in replay mode; call write_parquet()
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Any

from tick_feature_agent.buffers.tick_buffer import CircularBuffer, UnderlyingTick
from tick_feature_agent.buffers.option_buffer import OptionBufferStore, OptionTick
from tick_feature_agent.chain_cache import ChainCache
from tick_feature_agent.feed.chain_poller import ChainSnapshot
from tick_feature_agent.features.active_features import compute_active_features
from tick_feature_agent.features.chain import compute_chain_features
from tick_feature_agent.features.compression import CompressionState
from tick_feature_agent.features.decay import DecayState
from tick_feature_agent.features.horizon import compute_horizon_features
from tick_feature_agent.features.meta import compute_meta_features
from tick_feature_agent.features.ofi import compute_ofi_features
from tick_feature_agent.features.option_tick import compute_option_tick_features
from tick_feature_agent.features.realized_vol import compute_realized_vol_features
from tick_feature_agent.features.regime import compute_regime_features
from tick_feature_agent.features.targets import (
    TargetBuffer,
    UpsidePercentileTracker,
    null_target_features,
)
from tick_feature_agent.features.time_to_move import TimeToMoveState
from tick_feature_agent.features.underlying import compute_underlying_features
from tick_feature_agent.features.zone import compute_zone_features
from tick_feature_agent.instrument_profile import InstrumentProfile
from tick_feature_agent.output.emitter import Emitter, assemble_flat_vector
from tick_feature_agent.state_machine import StateMachine, TradingState

_NAN = float("nan")
_IST = timezone(timedelta(hours=5, minutes=30))


# ── Timestamp helpers ─────────────────────────────────────────────────────────

def _parse_ts(ts_str: str) -> float:
    """
    Parse a timestamp to Unix epoch seconds.

    Accepts:
      - Unix epoch float/int (as string or number): "1776074186.97", 1776074186.97
      - ISO 8601 string: "2026-04-14T09:15:05.123+05:30"
    """
    if isinstance(ts_str, (int, float)):
        return float(ts_str)
    try:
        return float(ts_str)   # Unix epoch as string
    except (ValueError, TypeError):
        pass
    try:
        dt = datetime.fromisoformat(ts_str)
        return dt.timestamp()
    except (ValueError, TypeError):
        return _NAN


def _session_boundary_sec(date_str: str, hhmm: str) -> float:
    """Build Unix epoch seconds for a session boundary on a given date (IST)."""
    h, m = hhmm.split(":")
    dt = datetime(
        year=int(date_str[:4]),
        month=int(date_str[5:7]),
        day=int(date_str[8:10]),
        hour=int(h),
        minute=int(m),
        tzinfo=_IST,
    )
    return dt.timestamp()


# ── Pending-target row ────────────────────────────────────────────────────────

@dataclass
class _PendingRow:
    """A feature row whose target columns have not yet been backfilled."""
    row:        dict                          # mutable — will be updated in-place
    t0:         float                         # Unix seconds for this tick
    spot_at_t0: float                         # underlying LTP at t0
    ltps_at_t0: dict[int, tuple[float, float]]  # {strike: (ce_ltp, pe_ltp)} at t0


# ── ChainSnapshot construction ────────────────────────────────────────────────

def _build_chain_snapshot(data: dict) -> ChainSnapshot | None:
    """
    Reconstruct a ChainSnapshot from a recorded chain_snapshot event data dict.

    Recorded format (from chain_poller / REST response):
        {
          "recv_ts": "2026-04-14T09:15:05.123+05:30",
          "underlying": "<security_id>",
          "expiry": "YYYY-MM-DD",
          "spotPrice": 24150.5,
          "timestamp": <unix_ms>,
          "rows": [ {"strike": ..., "callOI": ..., ...}, ... ]
        }

    Returns None if the data is malformed.
    """
    try:
        rows      = data.get("rows") or []
        spot      = float(data.get("spotPrice") or data.get("spot_price") or 0)
        expiry    = str(data.get("expiry", ""))
        ts_ms     = data.get("timestamp") or data.get("timestamp_ms") or 0
        ts_sec    = float(ts_ms) / 1000.0 if ts_ms else _parse_ts(
            str(data.get("recv_ts", ""))
        )

        # Build sec_id_map: security_id → (strike, "CE"|"PE")
        sec_id_map: dict[str, tuple[int, str]] = {}
        for row in rows:
            strike = int(row.get("strike", 0))
            cs = str(row.get("callSecurityId") or row.get("call_security_id") or "")
            ps = str(row.get("putSecurityId")  or row.get("put_security_id")  or "")
            if cs:
                sec_id_map[cs] = (strike, "CE")
            if ps:
                sec_id_map[ps] = (strike, "PE")

        # Detect strike step from sorted unique strikes
        strikes = sorted(int(r.get("strike", 0)) for r in rows if r.get("strike"))
        strike_step = 50  # default
        if len(strikes) >= 2:
            diffs = [strikes[i+1] - strikes[i] for i in range(len(strikes)-1)]
            if diffs:
                strike_step = max(set(diffs), key=diffs.count)  # mode

        return ChainSnapshot(
            spot_price=spot,
            expiry=expiry,
            timestamp_sec=ts_sec,
            rows=rows,
            strike_step=strike_step,
            sec_id_map=sec_id_map,
        )
    except Exception:
        return None


# ── Main adapter class ────────────────────────────────────────────────────────

class ReplayAdapter:
    """
    Replay adapter: routes stream_merger events into the TFA feature pipeline.

    Initialise once per date, call process_event() for every merged event,
    then call flush_all() before accessing the emitter.
    """

    def __init__(
        self,
        profile: InstrumentProfile,
        date_str: str,
        logger: Any = None,
    ) -> None:
        """
        Args:
            profile:   InstrumentProfile for this instrument/date. Should be
                       the result of InstrumentProfile.for_replay_date() so that
                       underlying_symbol and underlying_security_id match the
                       recorded data for this specific date.
            date_str:  ISO date string (YYYY-MM-DD) for the replay session.
            logger:    Optional TFA structured logger.
        """
        self._profile  = profile
        self._date_str = date_str
        self._log      = logger

        # ── Pipeline components ───────────────────────────────────────────────
        self._tick_buf    = CircularBuffer(maxlen=50)
        self._opt_store   = OptionBufferStore()
        self._sm          = StateMachine(
            warm_up_duration_sec=profile.warm_up_duration_sec,
        )
        self._cache       = ChainCache()

        # Stateful feature modules
        self._compression  = CompressionState()
        self._time_to_move = TimeToMoveState()
        self._decay        = DecayState()

        # Target modules
        self._target_buf   = TargetBuffer(
            target_windows_sec=profile.target_windows_sec
        )
        self._upside_pct   = UpsidePercentileTracker()

        # Output emitter in replay mode (accumulates rows in memory).
        # Phase E8: pass profile windows so the parquet schema picks up
        # 4-window direction columns as int32 instead of float32.
        self._emitter = Emitter(
            mode="replay",
            target_windows_sec=profile.target_windows_sec,
        )

        # ── Session boundary (Unix epoch seconds) ─────────────────────────────
        self._session_start_sec = _session_boundary_sec(
            date_str, profile.session_start
        )
        self._session_end_sec   = _session_boundary_sec(
            date_str, profile.session_end
        )

        # ── Internal replay state ─────────────────────────────────────────────
        # Security ID map from latest chain snapshot (for option tick lookup)
        self._sec_id_map: dict[str, tuple[int, str]] = {}

        # Warm-up tracking in replay time (bypass wall-clock timer in SM)
        self._warm_up_start_ts: float | None = None  # replay ts when SM entered WARMING_UP

        # Previous underlying LTP (for velocity in TimeToMoveState)
        self._prev_ltp: float | None = None
        self._prev_tick_ts: float | None = None

        # Underlying tick counter (for meta data_quality_flag)
        self._underlying_tick_count = 0

        # Target backfill queue
        self._pending: deque[_PendingRow] = deque()

        # Maximum target window (seconds) — determines when to backfill
        self._max_window_sec: float = max(profile.target_windows_sec) if profile.target_windows_sec else 60.0

        # Market-open flag (derived from replay timestamps)
        self._is_market_open = False

    # ── Public properties ─────────────────────────────────────────────────────

    @property
    def emitter(self) -> Emitter:
        """The Emitter in replay mode. Call write_parquet() after flush_all()."""
        return self._emitter

    @property
    def underlying_tick_count(self) -> int:
        return self._underlying_tick_count

    # ── Main entry point ──────────────────────────────────────────────────────

    def process_event(self, event: dict) -> None:
        """
        Route one merged event into the appropriate pipeline handler.

        Args:
            event: Dict from stream_merger.merge_streams() with keys:
                   ``type`` ("underlying_tick" | "option_tick" | "chain_snapshot")
                   ``data`` (raw recorded record dict)
        """
        etype = event.get("type")
        data  = event.get("data", {})
        if etype == "underlying_tick":
            self._handle_underlying(data)
        elif etype == "option_tick":
            self._handle_option(data)
        elif etype == "chain_snapshot":
            self._handle_chain(data)

    def flush_all(self) -> None:
        """
        Finalise all pending target rows after the event stream is exhausted.

        Rows whose target windows would extend past the session end get NaN
        targets (they represent incomplete lookahead windows).
        """
        while self._pending:
            pending = self._pending.popleft()
            # Use session_end as the cutoff — no lookahead past session close
            targets = self._target_buf.compute_targets(
                t0=pending.t0,
                spot_at_t0=pending.spot_at_t0,
                active_strike_ltps_at_t0=pending.ltps_at_t0,
                session_end_sec=self._session_end_sec,
            )
            pending.row.update(targets)
            self._emitter.emit(pending.row)

        # Reset target buffer and tracker for clean re-use (if any)
        self._target_buf.reset()
        self._upside_pct.reset()

    # ── Event handlers ────────────────────────────────────────────────────────

    def _handle_chain(self, data: dict) -> None:
        """Process a recorded chain_snapshot event."""
        snapshot = _build_chain_snapshot(data)
        if snapshot is None:
            return

        was_stale = not self._cache.chain_available

        self._cache.update_from_snapshot(snapshot)
        self._sec_id_map = snapshot.sec_id_map

        # Notify state machine that chain is healthy
        if was_stale or self._sm.state == TradingState.CHAIN_STALE:
            self._sm.on_chain_recovered()

    def _handle_option(self, data: dict) -> None:
        """Process a recorded option_tick event."""
        ts_raw = data.get("recv_ts") or data.get("timestamp")
        ts     = _parse_ts(str(ts_raw)) if ts_raw else _NAN
        if math.isnan(ts):
            return

        # Look up (strike, opt_type) from the tick data or sec_id_map
        strike   = data.get("strike")
        opt_type = data.get("opt_type") or data.get("option_type")

        if strike is None or opt_type is None:
            # Fall back to sec_id_map lookup
            sec_id = str(data.get("security_id") or data.get("securityId") or "")
            if sec_id in self._sec_id_map:
                strike, opt_type = self._sec_id_map[sec_id]
            else:
                return  # Cannot determine strike/type — skip

        try:
            strike = int(strike)
        except (TypeError, ValueError):
            return

        ltp      = float(data.get("ltp")      or 0)
        bid      = float(data.get("bid")       or 0)
        ask      = float(data.get("ask")       or 0)
        bid_size = int(  data.get("bid_size")  or data.get("bidSize") or 0)
        ask_size = int(  data.get("ask_size")  or data.get("askSize") or 0)
        volume   = int(  data.get("ltq")       or data.get("volume") or 0)

        tick = OptionTick(
            timestamp=ts,
            ltp=ltp,
            bid=bid,
            ask=ask,
            bid_size=bid_size,
            ask_size=ask_size,
            volume=volume,
        )
        self._opt_store.push(strike, str(opt_type), tick)

    def _handle_underlying(self, data: dict) -> None:
        """Process a recorded underlying_tick event — the hot path."""
        ts_raw = data.get("recv_ts") or data.get("timestamp")
        ts     = _parse_ts(str(ts_raw)) if ts_raw else _NAN
        if math.isnan(ts):
            return

        ltp  = float(data.get("ltp")      or 0)
        bid  = float(data.get("bid")      or 0)
        ask  = float(data.get("ask")      or 0)
        vol  = int(  data.get("ltq")      or data.get("volume") or 0)

        # ── Market-open flag ──────────────────────────────────────────────────
        self._is_market_open = self._session_start_sec <= ts < self._session_end_sec

        # ── State machine: tick-driven warm-up management ─────────────────────
        if self._sm.state == TradingState.FEED_STALE:
            self._sm.on_feed_reconnect_tick()
            self._warm_up_start_ts = ts

        elif self._sm.state == TradingState.WARMING_UP:
            if self._warm_up_start_ts is not None:
                if ts - self._warm_up_start_ts >= self._profile.warm_up_duration_sec:
                    self._sm.on_warm_up_complete()

        # Also check chain staleness in replay (30s without snapshot)
        if (
            self._cache.chain_available
            and self._cache.last_snapshot_ts > 0
        ):
            import time as _time
            elapsed = _time.monotonic() - self._cache.last_snapshot_ts
            if elapsed > 30.0 and self._sm.state == TradingState.TRADING:
                self._sm.on_chain_stale()

        # ── Push to circular buffer ───────────────────────────────────────────
        tick = UnderlyingTick(
            timestamp=ts,
            ltp=ltp,
            bid=bid,
            ask=ask,
            volume=vol,
        )
        self._tick_buf.push(tick)
        self._underlying_tick_count += 1

        # ── Push to target buffer (future-lookahead state) ────────────────────
        # Gather current ATM strike LTPs for target computation reference
        strike_ltps = self._get_atm_strike_ltps()
        self._target_buf.push(
            timestamp_sec=ts,
            spot=ltp,
            strike_ltps=strike_ltps,
        )

        # ── Flush mature pending rows whose target windows are now complete ────
        self._flush_pending(ts)

        # ── Compute features ──────────────────────────────────────────────────
        row = self._compute_row(ts, ltp, bid, ask)

        # ── Queue row for target backfill ─────────────────────────────────────
        pending = _PendingRow(
            row=row,
            t0=ts,
            spot_at_t0=ltp,
            ltps_at_t0=strike_ltps,
        )
        self._pending.append(pending)

        # Update previous tick state for TimeToMoveState
        self._prev_ltp     = ltp
        self._prev_tick_ts = ts

    # ── Feature computation ───────────────────────────────────────────────────

    def _compute_row(self, ts: float, ltp: float, bid: float, ask: float) -> dict:
        """Compute all features (excluding targets) and assemble a flat row dict."""
        profile = self._profile
        cache   = self._cache

        # ── Underlying features ───────────────────────────────────────────────
        uf  = compute_underlying_features(self._tick_buf)
        ofi = compute_ofi_features(self._tick_buf)
        rv  = compute_realized_vol_features(self._tick_buf)
        hf  = compute_horizon_features(uf, ofi, rv)

        # ── ATM context ───────────────────────────────────────────────────────
        # Refresh ATM zone when spot changes (returns True if shifted)
        cache.refresh_atm_zone(ltp)

        atm_strike  = cache.atm
        strike_step = cache.strike_step
        atm_window  = cache.atm_window

        # ── Option tick features ──────────────────────────────────────────────
        opt_tf = compute_option_tick_features(
            atm_window=atm_window,
            option_store=self._opt_store,
            staleness_threshold_sec=float(profile.option_tick_timeout_sec),
        )

        # ── Compression & breakout ────────────────────────────────────────────
        comp_f = self._compression.compute(
            buffer=self._tick_buf,
            opt_features=opt_tf,
            chain_available=cache.chain_available,
            atm_window=atm_window,
        )

        # ── Time-to-move ──────────────────────────────────────────────────────
        time_diff = (ts - self._prev_tick_ts) if self._prev_tick_ts is not None else 0.0
        regime_name = None  # computed below — use previous tick's regime for T2M

        ttm_f = self._time_to_move.compute(
            ltp=ltp,
            prev_ltp=self._prev_ltp,
            timestamp=ts,
            velocity=float(uf.get("velocity", 0) or 0),
            time_diff_sec=time_diff,
            regime=regime_name,
            vol_compression=float(comp_f.get("volatility_compression", _NAN)),
            zone_call_pressure=_NAN,  # will be overwritten below
            zone_put_pressure=_NAN,
            dead_market_score=_NAN,
        )

        # ── Chain features ────────────────────────────────────────────────────
        chain_f = compute_chain_features(cache)

        # ── Active strike features ────────────────────────────────────────────
        active_f = compute_active_features(
            cache=cache,
            option_store=self._opt_store,
            current_time=ts,
            spot_price=ltp,
            staleness_threshold_sec=float(profile.option_tick_timeout_sec),
        )

        # ── Decay features ────────────────────────────────────────────────────
        decay_f = self._decay.compute(
            option_store=self._opt_store,
            opt_features=opt_tf,
            cache=cache,
            atm_window=atm_window,
        )

        # ── Zone features ─────────────────────────────────────────────────────
        zone_f = compute_zone_features(cache, atm_window)

        # ── Regime features ───────────────────────────────────────────────────
        regime_f = compute_regime_features(
            buffer=self._tick_buf,
            volatility_compression=float(comp_f.get("volatility_compression", _NAN)),
            tick_imbalance_20=float(uf.get("tick_imbalance_20", _NAN)),
            active_strike_count=int(decay_f.get("active_strike_count", 0)),
            vol_diff_available=cache.vol_diff_available,
            trading_state=self._sm.state.value,
            volume_drought_atm=float(decay_f.get("volume_drought_atm", _NAN)),
            thresholds=self._regime_thresholds(),
        )

        # Now update TimeToMoveState with real zone pressures (re-compute for
        # this tick if zone data is ready)
        zone_call_p = float(zone_f.get("atm_zone_call_pressure", _NAN))
        zone_put_p  = float(zone_f.get("atm_zone_put_pressure",  _NAN))
        dead_mkt    = float(decay_f.get("dead_market_score", _NAN))
        if not math.isnan(zone_call_p) or not math.isnan(zone_put_p):
            ttm_f = self._time_to_move.compute(
                ltp=ltp,
                prev_ltp=self._prev_ltp,
                timestamp=ts,
                velocity=float(uf.get("velocity", 0) or 0),
                time_diff_sec=time_diff,
                regime=regime_f.get("regime"),
                vol_compression=float(comp_f.get("volatility_compression", _NAN)),
                zone_call_pressure=zone_call_p,
                zone_put_pressure=zone_put_p,
                dead_market_score=dead_mkt,
            )

        # ── Meta features ─────────────────────────────────────────────────────
        meta_f = compute_meta_features(
            profile=profile,
            cache=cache,
            tick_time=ts,
            underlying_tick_count=self._underlying_tick_count,
            is_market_open=self._is_market_open,
        )

        # ── Trading state ─────────────────────────────────────────────────────
        sm_state    = self._sm.state
        t_allowed   = 1 if self._sm.trading_allowed else 0
        warm_remain = self._sm.warm_up_remaining_sec or 0.0
        stale_rsn   = self._sm.state.value if sm_state != TradingState.TRADING else None

        # ── Assemble flat row (NaN targets — backfilled later) ────────────────
        row = assemble_flat_vector(
            timestamp=ts,
            spot_price=ltp,
            atm_strike=atm_strike,
            strike_step=strike_step,
            atm_window=atm_window,
            underlying_feats=uf,
            ofi_feats=ofi,
            realized_vol_feats=rv,
            horizon_feats=hf,
            compression_feats=comp_f,
            time_to_move_feats=ttm_f,
            opt_tick_feats=opt_tf,
            chain_feats=chain_f,
            active_feats=active_f,
            decay_feats=decay_f,
            regime_feats=regime_f,
            zone_feats=zone_f,
            target_feats=None,        # NaN placeholders; backfilled below
            trading_state=sm_state.value,
            trading_allowed=t_allowed,
            warm_up_remaining_sec=warm_remain,
            stale_reason=stale_rsn,
            meta_feats=meta_f,
            target_windows_sec=profile.target_windows_sec,
        )
        return row

    # ── Target backfill helpers ───────────────────────────────────────────────

    def _flush_pending(self, current_ts: float) -> None:
        """
        Emit any pending rows whose full target window has elapsed.

        A row at t0 is ready when current_ts >= t0 + max_window_sec.
        """
        while self._pending:
            head = self._pending[0]
            if current_ts < head.t0 + self._max_window_sec:
                break  # remaining rows are also not ready (queue is FIFO)

            pending = self._pending.popleft()
            targets = self._target_buf.compute_targets(
                t0=pending.t0,
                spot_at_t0=pending.spot_at_t0,
                active_strike_ltps_at_t0=pending.ltps_at_t0,
                session_end_sec=self._session_end_sec,
            )
            # Inject upside percentile for the shortest window
            min_window = min(self._profile.target_windows_sec)
            upside_key = f"max_upside_{min_window}s"
            upside_pct_key = f"upside_percentile_{min_window}s"
            upside_val = targets.get(upside_key, _NAN)
            targets[upside_pct_key] = self._upside_pct.add_and_query(upside_val)

            pending.row.update(targets)
            self._emitter.emit(pending.row)

    def _get_atm_strike_ltps(self) -> dict[int, tuple[float, float]]:
        """
        Collect current CE/PE LTP for each ATM-window strike from the option store.

        Returns {strike: (ce_ltp, pe_ltp)} — NaN for unavailable sides.
        """
        out: dict[int, tuple[float, float]] = {}
        for strike in self._cache.atm_window:
            ce_ticks = self._opt_store.get_last(strike, "CE", n=1)
            pe_ticks = self._opt_store.get_last(strike, "PE", n=1)
            ce_ltp = float(ce_ticks[-1].ltp) if ce_ticks else _NAN
            pe_ltp = float(pe_ticks[-1].ltp) if pe_ticks else _NAN
            out[strike] = (ce_ltp, pe_ltp)
        return out

    def _regime_thresholds(self) -> dict:
        """Extract regime threshold dict from the instrument profile."""
        p = self._profile
        return {
            "trend_volatility_min":  p.regime_trend_volatility_min,
            "trend_imbalance_min":   p.regime_trend_imbalance_min,
            "trend_momentum_min":    p.regime_trend_momentum_min,
            "trend_activity_min":    p.regime_trend_activity_min,
            "range_volatility_max":  p.regime_range_volatility_max,
            "range_imbalance_max":   p.regime_range_imbalance_max,
            "range_activity_min":    p.regime_range_activity_min,
            "dead_activity_max":     p.regime_dead_activity_max,
            "dead_vol_drought_max":  p.regime_dead_vol_drought_max,
        }
