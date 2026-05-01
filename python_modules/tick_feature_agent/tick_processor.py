"""
tick_processor.py — Live tick processing hot path.

Phase 7 integration: wires all feature modules together and emits flat
feature-vector rows on every underlying tick received from DhanFeed.
Per Phase E8 the row width is **dynamic per profile** — the canonical
4-window profile (target_windows_sec = [30, 60, 300, 900]) emits 384
columns; the legacy 2-window profile emits 370. See
`tick_feature_agent.output.emitter.column_names_for(windows)`.

Called from the asyncio event loop (single-threaded). No locks needed for the
feature computation path; the Emitter and SessionRecorder have their own locks
for output sinks.

Usage:
    proc = TickProcessor(
        profile=profile,
        state_machine=sm,
        tick_buffer=tick_buf,
        option_store=opt_store,
        chain_cache=cache,
        emitter=emitter,
        recorder=recorder,       # optional — None disables recording
        alert_emitter=alerts,    # optional
        logger=log,
    )

    # Wire as callbacks:
    feed = DhanFeed(...,
        on_underlying_tick=proc.on_underlying_tick,
        on_option_tick=proc.on_option_tick,
    )
    poller = ChainPoller(...,
        on_snapshot=proc.on_chain_snapshot,
        on_chain_stale=proc.on_chain_stale,
        on_chain_recovered=proc.on_chain_recovered,
    )
"""

from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass
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
)
from tick_feature_agent.features.time_to_move import TimeToMoveState
from tick_feature_agent.features.underlying import compute_underlying_features
from tick_feature_agent.features.zone import compute_zone_features
from tick_feature_agent.instrument_profile import InstrumentProfile
from tick_feature_agent.output.emitter import Emitter, assemble_flat_vector
from tick_feature_agent.state_machine import StateMachine, TradingState

_NAN = float("nan")


# ── Pending-target row (same as replay_adapter pattern) ───────────────────────

@dataclass
class _PendingRow:
    row:        dict
    t0:         float
    spot_at_t0: float
    ltps_at_t0: dict[int, tuple[float, float]]


# ── TickProcessor ─────────────────────────────────────────────────────────────

class TickProcessor:
    """
    Live tick-processing hot path.

    Instantiate once per TFA process. Wire DhanFeed and ChainPoller callbacks
    to the methods on_underlying_tick / on_option_tick / on_chain_snapshot.
    """

    def __init__(
        self,
        profile: InstrumentProfile,
        state_machine: StateMachine,
        tick_buffer: CircularBuffer,
        option_store: OptionBufferStore,
        chain_cache: ChainCache,
        emitter: Emitter,
        session_manager: Any = None,   # SessionManager (optional, for is_market_open)
        recorder: Any = None,          # SessionRecorder (optional)
        alert_emitter: Any = None,     # AlertEmitter (optional)
        logger: Any = None,
    ) -> None:
        self._profile        = profile
        self._sm             = state_machine
        self._tick_buf       = tick_buffer
        self._opt_store      = option_store
        self._cache          = chain_cache
        self._emitter        = emitter
        self._session_mgr    = session_manager
        self._recorder       = recorder
        self._alerts         = alert_emitter
        self._log            = logger

        # Stateful feature modules
        self._compression  = CompressionState()
        self._time_to_move = TimeToMoveState()
        self._decay        = DecayState()

        # Target modules
        self._target_buf  = TargetBuffer(
            target_windows_sec=profile.target_windows_sec
        )
        self._upside_pct  = UpsidePercentileTracker()

        # Max target window for backfill decisions
        self._max_window_sec = float(
            max(profile.target_windows_sec) if profile.target_windows_sec else 60.0
        )

        # Session-level counters and state
        self._underlying_tick_count = 0
        self._prev_ltp:       float | None = None
        self._prev_tick_ts:   float | None = None
        self._last_tick_time: float        = 0.0   # monotonic — for feed-stale detection

        # Target backfill queue
        self._pending: deque[_PendingRow] = deque()

        # Session-end timestamp (for flush_session)
        self._session_end_sec: float = 0.0

        # Symbol-mismatch flag (set by external caller if detected)
        self.symbol_mismatch: bool = False

    # ── Session lifecycle ─────────────────────────────────────────────────────

    def on_session_open(self, session_end_sec: float) -> None:
        """
        Call at session_start each day to reset all per-session state.

        Args:
            session_end_sec: Unix epoch seconds for today's session end (IST).
        """
        self._session_end_sec      = session_end_sec
        self._underlying_tick_count = 0
        self._prev_ltp             = None
        self._prev_tick_ts         = None
        self._last_tick_time       = 0.0
        self.symbol_mismatch       = False

        self._compression  = CompressionState()
        self._time_to_move = TimeToMoveState()
        self._decay        = DecayState()
        self._target_buf.reset()
        self._upside_pct.reset()
        self._pending.clear()

    def on_session_close(self) -> None:
        """
        Call at session_end to flush any remaining pending-target rows.
        """
        while self._pending:
            p = self._pending.popleft()
            targets = self._target_buf.compute_targets(
                t0=p.t0,
                spot_at_t0=p.spot_at_t0,
                active_strike_ltps_at_t0=p.ltps_at_t0,
                session_end_sec=self._session_end_sec,
            )
            p.row.update(targets)
            self._emitter.emit(p.row)

    # ── Feed callbacks ────────────────────────────────────────────────────────

    def on_underlying_tick(self, data: dict) -> None:
        """
        Called by DhanFeed on every Full-packet underlying tick.

        Args:
            data: Parsed tick dict with keys: ltp, bid, ask, ltq, recv_ts, etc.
        """
        ts  = float(data.get("recv_ts") or time.time())
        ltp = float(data.get("ltp") or 0)
        bid = float(data.get("bid") or 0)
        ask = float(data.get("ask") or 0)
        vol = int(  data.get("ltq") or data.get("volume") or 0)

        self._last_tick_time = time.monotonic()

        # ── State machine tick (expires warm-up timer if elapsed) ─────────────
        self._sm.tick()

        # ── Transition from FEED_STALE on first tick ──────────────────────────
        if self._sm.state == TradingState.FEED_STALE:
            self._sm.on_feed_reconnect_tick()

        # ── Push to CircularBuffer ────────────────────────────────────────────
        tick = UnderlyingTick(timestamp=ts, ltp=ltp, bid=bid, ask=ask, volume=vol)
        self._tick_buf.push(tick)
        self._underlying_tick_count += 1

        # ── Market-open check ─────────────────────────────────────────────────
        is_open = (
            self._session_mgr.is_market_open
            if self._session_mgr is not None
            else True
        )

        # ── Push to target buffer ─────────────────────────────────────────────
        strike_ltps = self._get_atm_strike_ltps()
        self._target_buf.push(timestamp_sec=ts, spot=ltp, strike_ltps=strike_ltps)

        # ── Flush mature pending target rows ──────────────────────────────────
        self._flush_pending(ts)

        # ── Record raw tick ───────────────────────────────────────────────────
        if self._recorder is not None:
            self._recorder.record_underlying_tick(data)

        # ── Compute features and assemble row ─────────────────────────────────
        row = self._compute_row(ts, ltp, bid, ask, is_open)

        # ── Queue for target backfill ─────────────────────────────────────────
        self._pending.append(_PendingRow(
            row=row,
            t0=ts,
            spot_at_t0=ltp,
            ltps_at_t0=strike_ltps,
        ))

        # Update prev-tick state
        self._prev_ltp    = ltp
        self._prev_tick_ts = ts

    def on_option_tick(self, strike: int, opt_type: str, data: dict) -> None:
        """
        Called by DhanFeed on every Full-packet option tick.

        Args:
            strike:   Option strike price.
            opt_type: "CE" or "PE".
            data:     Parsed tick dict (ltp, bid, ask, bid_size, ask_size, ltq, recv_ts).
        """
        ts       = float(data.get("recv_ts") or time.time())
        ltp      = float(data.get("ltp")      or 0)
        bid      = float(data.get("bid")      or 0)
        ask      = float(data.get("ask")      or 0)
        bid_size = int(  data.get("bid_size") or 0)
        ask_size = int(  data.get("ask_size") or 0)
        vol      = int(  data.get("ltq")      or data.get("volume") or 0)

        tick = OptionTick(
            timestamp=ts,
            ltp=ltp,
            bid=bid,
            ask=ask,
            bid_size=bid_size,
            ask_size=ask_size,
            volume=vol,
        )
        self._opt_store.push(strike, opt_type, tick)

        # Record raw option tick
        if self._recorder is not None:
            record = dict(data)
            record.setdefault("strike",   strike)
            record.setdefault("opt_type", opt_type)
            self._recorder.record_option_tick(record)

    def on_chain_snapshot(self, snapshot: ChainSnapshot) -> None:
        """
        Called by ChainPoller on every validated chain snapshot (~5s).
        """
        was_stale = not self._cache.chain_available

        self._cache.update_from_snapshot(snapshot)

        if was_stale or self._sm.state == TradingState.CHAIN_STALE:
            self._sm.on_chain_recovered()

        # Record raw snapshot
        if self._recorder is not None:
            raw = {
                "recv_ts":   snapshot.recv_ts,
                "underlying": snapshot.sec_id_map and next(
                    (sid for sid, _ in snapshot.sec_id_map.items()), ""
                ),
                "expiry":    snapshot.expiry,
                "spotPrice": snapshot.spot_price,
                "timestamp": int(snapshot.timestamp_sec * 1000),
                "rows":      snapshot.rows,
            }
            self._recorder.record_chain_snapshot(raw)

    def on_chain_stale(self) -> None:
        """Called by ChainPoller when no snapshot for > 30s."""
        self._sm.on_chain_stale()
        if self._alerts:
            self._alerts.chain_stale(
                seconds_since_last=30,
                last_expiry=self._cache.snapshot.expiry if self._cache.snapshot else "",
            )

    def on_chain_recovered(self) -> None:
        """Called by ChainPoller when snapshots resume."""
        self._sm.on_chain_recovered()

    # ── Feed-stale check (call periodically from asyncio task) ───────────────

    def check_feed_stale(self) -> bool:
        """
        Returns True (and transitions SM to FEED_STALE) if no underlying tick
        has been received within profile.underlying_tick_timeout_sec seconds.

        Call this from a periodic asyncio task (e.g. every 1s).
        """
        if self._last_tick_time == 0.0:
            return False  # no tick yet — not stale
        elapsed = time.monotonic() - self._last_tick_time
        if elapsed > self._profile.underlying_tick_timeout_sec:
            if self._sm.state != TradingState.FEED_STALE:
                self._sm.on_feed_disconnect()
                if self._alerts:
                    self._alerts.outage_warm_up_starting(
                        reason="underlying_tick_timeout",
                        stale_sec=elapsed,
                    )
            return True
        return False

    # ── Feature computation (shared with replay) ──────────────────────────────

    def _compute_row(
        self,
        ts: float,
        ltp: float,
        bid: float,
        ask: float,
        is_market_open: bool,
    ) -> dict:
        """Compute all features (excluding targets) and return the flat row dict."""
        profile = self._profile
        cache   = self._cache

        # Underlying features
        uf  = compute_underlying_features(self._tick_buf)
        ofi = compute_ofi_features(self._tick_buf)
        rv  = compute_realized_vol_features(self._tick_buf)
        hf  = compute_horizon_features(uf, ofi, rv)

        # ATM context (partial refresh if spot moved)
        cache.refresh_atm_zone(ltp)
        atm_strike  = cache.atm
        strike_step = cache.strike_step
        atm_window  = cache.atm_window

        # Option tick features
        opt_tf = compute_option_tick_features(
            atm_window=atm_window,
            option_store=self._opt_store,
            staleness_threshold_sec=float(profile.option_tick_timeout_sec),
        )

        # Compression & breakout
        comp_f = self._compression.compute(
            buffer=self._tick_buf,
            opt_features=opt_tf,
            chain_available=cache.chain_available,
            atm_window=atm_window,
        )

        # Time-to-move (first pass; re-computed with zone data below)
        time_diff = (ts - self._prev_tick_ts) if self._prev_tick_ts is not None else 0.0
        ttm_f = self._time_to_move.compute(
            ltp=ltp,
            prev_ltp=self._prev_ltp,
            timestamp=ts,
            velocity=float(uf.get("velocity", 0) or 0),
            time_diff_sec=time_diff,
            regime=None,
            vol_compression=float(comp_f.get("volatility_compression", _NAN)),
            zone_call_pressure=_NAN,
            zone_put_pressure=_NAN,
            dead_market_score=_NAN,
        )

        # Chain / active / decay / zone features
        chain_f  = compute_chain_features(cache)
        active_f = compute_active_features(
            cache=cache,
            option_store=self._opt_store,
            current_time=ts,
            spot_price=ltp,
            staleness_threshold_sec=float(profile.option_tick_timeout_sec),
        )
        decay_f = self._decay.compute(
            option_store=self._opt_store,
            opt_features=opt_tf,
            cache=cache,
            atm_window=atm_window,
        )
        zone_f = compute_zone_features(cache, atm_window)

        # Regime
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

        # Re-compute time-to-move with real zone and decay data
        zone_call_p = float(zone_f.get("atm_zone_call_pressure", _NAN))
        zone_put_p  = float(zone_f.get("atm_zone_put_pressure",  _NAN))
        dead_mkt    = float(decay_f.get("dead_market_score", _NAN))
        if not (math.isnan(zone_call_p) and math.isnan(zone_put_p)):
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

        # Option feed staleness check (any ATM ±3 CE/PE not ticked recently)
        option_feed_stale = self._check_option_feed_stale(atm_window, ts)

        # Meta features
        meta_f = compute_meta_features(
            profile=profile,
            cache=cache,
            tick_time=ts,
            underlying_tick_count=self._underlying_tick_count,
            is_market_open=is_market_open,
            underlying_feed_stale=False,  # checked by check_feed_stale() separately
            option_feed_stale=option_feed_stale,
            symbol_mismatch=self.symbol_mismatch,
        )

        # Trading state
        sm_state    = self._sm.state
        t_allowed   = 1 if self._sm.trading_allowed else 0
        warm_remain = self._sm.warm_up_remaining_sec or 0.0
        stale_rsn   = sm_state.value if sm_state != TradingState.TRADING else None

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
            target_feats=None,        # backfilled later
            trading_state=sm_state.value,
            trading_allowed=t_allowed,
            warm_up_remaining_sec=warm_remain,
            stale_reason=stale_rsn,
            meta_feats=meta_f,
            target_windows_sec=profile.target_windows_sec,
        )

        # ── Attach ATM option security IDs (non-feature metadata) ───────────
        # String-typed; preprocessor._derive_feature_columns drops object dtype
        # columns, so these don't leak into model training. They propagate via
        # NDJSON to SEA → signal payload → UI for one-click TRADE placement.
        ce_sid, pe_sid = self._lookup_atm_security_ids(atm_strike)
        row["atm_ce_security_id"] = ce_sid
        row["atm_pe_security_id"] = pe_sid
        return row

    # ── Target backfill helpers ───────────────────────────────────────────────

    def _flush_pending(self, current_ts: float) -> None:
        """Emit rows whose full target window has elapsed."""
        while self._pending:
            head = self._pending[0]
            if current_ts < head.t0 + self._max_window_sec:
                break
            p = self._pending.popleft()
            targets = self._target_buf.compute_targets(
                t0=p.t0,
                spot_at_t0=p.spot_at_t0,
                active_strike_ltps_at_t0=p.ltps_at_t0,
                session_end_sec=self._session_end_sec,
            )
            min_w  = min(self._profile.target_windows_sec)
            upside = targets.get(f"max_upside_{min_w}s", _NAN)
            targets[f"upside_percentile_{min_w}s"] = self._upside_pct.add_and_query(upside)
            p.row.update(targets)
            self._emitter.emit(p.row)

    def _lookup_atm_security_ids(self, atm_strike: int | None) -> tuple[str | None, str | None]:
        """
        Resolve (ce_security_id, pe_security_id) for the current ATM strike
        from the latest chain snapshot's sec_id_map.

        Returns (None, None) when no snapshot or strike is unavailable.
        """
        if atm_strike is None or self._cache.snapshot is None:
            return (None, None)
        ce_sid: str | None = None
        pe_sid: str | None = None
        # sec_id_map: {security_id(str): (strike, opt_type)}
        for sid, (strike, opt_type) in self._cache.snapshot.sec_id_map.items():
            if int(strike) != int(atm_strike):
                continue
            if opt_type == "CE":
                ce_sid = sid
            elif opt_type == "PE":
                pe_sid = sid
            if ce_sid and pe_sid:
                break
        return (ce_sid, pe_sid)

    def _get_atm_strike_ltps(self) -> dict[int, tuple[float, float]]:
        """Return {strike: (ce_ltp, pe_ltp)} for current ATM window."""
        out: dict[int, tuple[float, float]] = {}
        for strike in self._cache.atm_window:
            ce = self._opt_store.get_last(strike, "CE", n=1)
            pe = self._opt_store.get_last(strike, "PE", n=1)
            out[strike] = (
                float(ce[-1].ltp) if ce else _NAN,
                float(pe[-1].ltp) if pe else _NAN,
            )
        return out

    def _check_option_feed_stale(
        self, atm_window: list[int], current_ts: float
    ) -> bool:
        """
        True if any ATM ±3 CE/PE has not been ticked within option_tick_timeout_sec.
        Returns False when chain is not yet available (no ATM window yet).
        """
        if not self._cache.chain_available or not atm_window:
            return False
        timeout = float(self._profile.option_tick_timeout_sec)
        for strike in atm_window:
            for side in ("CE", "PE"):
                if not self._opt_store.tick_available(strike, side):
                    return True
                ticks = self._opt_store.get_last(strike, side, n=1)
                if ticks and (current_ts - ticks[-1].timestamp) > timeout:
                    return True
        return False

    def _regime_thresholds(self) -> dict:
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
