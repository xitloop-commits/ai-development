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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from tick_feature_agent.buffers.option_buffer import OptionBufferStore, OptionTick
from tick_feature_agent.buffers.tick_buffer import CircularBuffer, UnderlyingTick
from tick_feature_agent.chain_cache import ChainCache
from tick_feature_agent.features.active_features import compute_active_features
from tick_feature_agent.features.chain import compute_chain_features
from tick_feature_agent.features.compression import CompressionState
from tick_feature_agent.features.decay import DecayState
from tick_feature_agent.features.expiry import compute_expiry_features
from tick_feature_agent.features.greeks import compute_greek_features
from tick_feature_agent.features.horizon import compute_horizon_features
from tick_feature_agent.features.levels import compute_level_features
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
from tick_feature_agent.feed.chain_poller import ChainSnapshot
from tick_feature_agent.instrument_profile import InstrumentProfile
from tick_feature_agent.output.emitter import Emitter, assemble_flat_vector
from tick_feature_agent.state import feature_pipeline, levels_store
from tick_feature_agent.state_machine import StateMachine, TradingState

_NAN = float("nan")
_IST = timezone(timedelta(hours=5, minutes=30))

# Repo root = three levels above this file:
#   tick_processor.py  →  tick_feature_agent/  →  python_modules/  →  <repo>
_REPO_ROOT = Path(__file__).resolve().parents[2]
_LEVELS_STATE_DIR = _REPO_ROOT / "data" / "state"


# ── Pending-target row (same as replay_adapter pattern) ───────────────────────


@dataclass
class _PendingRow:
    row: dict
    t0: float
    spot_at_t0: float
    ltps_at_t0: dict[int, tuple[float, float]]
    # Wave 2: snapshotted at t0 for breakout_in_X target. Day high/low
    # progress through the session, so the value at trade-open is what
    # determines whether a future breakout occurred.
    day_high_at_t0: float | None = None
    day_low_at_t0: float | None = None


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
        session_manager: Any = None,  # SessionManager (optional, for is_market_open)
        recorder: Any = None,  # SessionRecorder (optional)
        alert_emitter: Any = None,  # AlertEmitter (optional)
        logger: Any = None,
        levels_state_dir: Path | str | None = None,  # task 2c-21: cross-day H/L writer
    ) -> None:
        self._profile = profile
        self._sm = state_machine
        self._tick_buf = tick_buffer
        self._opt_store = option_store
        self._cache = chain_cache
        self._emitter = emitter
        self._session_mgr = session_manager
        self._recorder = recorder
        self._alerts = alert_emitter
        self._log = logger

        # Task 2c-21: directory where per-instrument cross-day H/L JSON lives.
        # Default to <repo>/data/state/; tests override via constructor kwarg.
        self._levels_state_dir: Path = (
            Path(levels_state_dir) if levels_state_dir is not None else _LEVELS_STATE_DIR
        )

        # Stateful feature modules
        self._compression = CompressionState()
        self._time_to_move = TimeToMoveState()
        self._decay = DecayState()

        # Phase 2d: shared trend/swing feature pipeline state. Owns the
        # history buffers + 6 stateful trackers + event calendar + cross-day
        # state used by the new feature modules. The free-function helpers
        # in `feature_pipeline` populate it on chain / tick / option events
        # and produce the per-row compute dicts.
        self._pipeline_state = feature_pipeline.FeaturePipelineState()

        # Scheduled session-start epoch (set in on_session_open).
        self._scheduled_session_start_sec: float | None = None

        # Target modules
        self._target_buf = TargetBuffer(target_windows_sec=profile.target_windows_sec)
        self._upside_pct = UpsidePercentileTracker()

        # Max target window for backfill decisions
        self._max_window_sec = float(
            max(profile.target_windows_sec) if profile.target_windows_sec else 60.0
        )

        # Session-level counters and state
        self._underlying_tick_count = 0
        self._prev_ltp: float | None = None
        self._prev_tick_ts: float | None = None
        self._last_tick_time: float = 0.0  # monotonic — for feed-stale detection

        # Target backfill queue
        self._pending: deque[_PendingRow] = deque()

        # Session-end timestamp (for flush_session)
        self._session_end_sec: float = 0.0
        # Wave 1: session-open timestamp (set on first tick of the day)
        self._session_open_sec: float = 0.0

        # Wave 1: session-level OHLC tracking (from Dhan QUOTE/FULL/PrevClose packets)
        self._day_high: float | None = None
        self._day_low: float | None = None
        self._prev_close: float | None = None

        # Symbol-mismatch flag (set by external caller if detected)
        self.symbol_mismatch: bool = False

    # ── Session lifecycle ─────────────────────────────────────────────────────

    def on_session_open(self, session_end_sec: float) -> None:
        """
        Call at session_start each day to reset all per-session state.

        Args:
            session_end_sec: Unix epoch seconds for today's session end (IST).
        """
        self._session_end_sec = session_end_sec
        self._session_open_sec = 0.0  # set on first tick
        self._day_high = None
        self._day_low = None
        # prev_close is NOT cleared — it's yesterday's close, set once per day from PrevClose packet
        self._underlying_tick_count = 0
        self._prev_ltp = None
        self._prev_tick_ts = None
        self._last_tick_time = 0.0
        self.symbol_mismatch = False

        self._compression = CompressionState()
        self._time_to_move = TimeToMoveState()
        self._decay = DecayState()
        self._target_buf.reset()
        self._upside_pct.reset()
        self._pending.clear()
        # Scheduled session start (09:15 IST etc.) — anchors `minutes_from_open`
        # so the feature is invariant to first-tick latency. Computed here
        # because the trend/swing pipeline depends on it for the OR window
        # and the intraday-time feature.
        self._scheduled_session_start_sec = self._compute_session_start_sec(
            session_end_sec
        )
        # Phase 2d: hand the shared trend/swing pipeline a fresh session —
        # resets every buffer + tracker, configures the OR window end at
        # session_start + 15 min per D74 B3, reloads event_calendar.json and
        # the cross-day H/L state file written by yesterday's session close.
        feature_pipeline.reset_for_session(
            self._pipeline_state,
            scheduled_session_start_sec=self._scheduled_session_start_sec,
            event_calendar_path=self._event_calendar_path(),
            cross_day_levels_path=self._cross_day_levels_path(),
        )

    def _event_calendar_path(self) -> Path:
        """<repo>/config/event_calendar.json (best-effort consumer)."""
        return _LEVELS_STATE_DIR.parent.parent / "config" / "event_calendar.json"

    def _cross_day_levels_path(self) -> Path:
        """<repo>/data/state/<inst>_levels.json (best-effort consumer)."""
        return self._levels_state_dir / f"{self._profile.instrument_name}_levels.json"

    def _latest_atm_premiums(
        self, atm_strike: int | None
    ) -> tuple[float | None, float | None]:
        """Return (latest_ATM_CE_ltp, latest_ATM_PE_ltp) from option_store, or (None, None)."""
        if atm_strike is None:
            return (None, None)
        ce = pe = None
        try:
            ce_tick = self._opt_store.latest(int(atm_strike), "CE")
            if ce_tick is not None and ce_tick.ltp > 0:
                ce = float(ce_tick.ltp)
        except (AttributeError, KeyError):
            pass
        try:
            pe_tick = self._opt_store.latest(int(atm_strike), "PE")
            if pe_tick is not None and pe_tick.ltp > 0:
                pe = float(pe_tick.ltp)
        except (AttributeError, KeyError):
            pass
        return (ce, pe)

    def _compute_session_start_sec(self, session_end_sec: float) -> float | None:
        """Return the SCHEDULED session-start epoch (e.g. 09:15 IST for NSE).

        Derived from the profile's `session_start` (HH:MM) anchored to the
        same calendar date as `session_end_sec` (interpreted in IST).
        Used as the anchor for `minutes_from_open` so the feature is
        invariant to first-tick latency.
        """
        try:
            from datetime import datetime, timedelta, timezone
            tz = timezone(timedelta(hours=5, minutes=30))
            end_dt = datetime.fromtimestamp(float(session_end_sec), tz=tz)
            h, m = self._profile.session_start.split(":")
            start_dt = end_dt.replace(hour=int(h), minute=int(m), second=0, microsecond=0)
            return start_dt.timestamp()
        except (TypeError, ValueError, AttributeError, OverflowError, OSError):
            return None

    def _compute_opening_range_end(self, session_end_sec: float) -> float | None:
        """Return the epoch second 15 min after the scheduled session start
        (D74 B3 — NSE 09:30 IST, MCX 09:15 IST). NaN inputs → None."""
        start = self._compute_session_start_sec(session_end_sec)
        if start is None:
            return None
        return start + 15 * 60.0

    def on_session_close(self) -> None:
        """
        Call at session_end to flush any remaining pending-target rows.

        Task 2c-21: also persist today's session high/low to a per-instrument
        JSON file under ``<repo>/data/state/`` so tomorrow's cross-day level
        features (`compute_cross_day_level_features`) can read prev-day H/L
        and the 5-day swing window. Any failure here is logged and swallowed
        — the writer must NEVER block the session-close flush flow.
        """
        while self._pending:
            p = self._pending.popleft()
            targets = self._target_buf.compute_targets(
                t0=p.t0,
                spot_at_t0=p.spot_at_t0,
                active_strike_ltps_at_t0=p.ltps_at_t0,
                session_end_sec=self._session_end_sec,
                day_high_at_t0=p.day_high_at_t0,
                day_low_at_t0=p.day_low_at_t0,
            )
            p.row.update(targets)
            self._emitter.emit(p.row)

        # Task 2c-21 writer hook — best-effort, never raises.
        self._persist_cross_day_levels()

    def _persist_cross_day_levels(self) -> None:
        """
        Persist today's session high/low to ``data/state/<inst>_levels.json``.

        The whole hook is wrapped in try/except so a writer failure (disk
        full, permission denied, etc.) can NEVER block the session-close
        flow — we log a warning and move on.
        """
        try:
            hi = self._day_high
            lo = self._day_low
            if hi is None or lo is None:
                # No ticks seen this session — nothing to persist.
                return

            session_date = self._infer_session_date()
            if session_date is None:
                # No way to date the entry — skip rather than write a bogus row.
                if self._log is not None:
                    self._log.warning(
                        "levels_store: unable to infer session_date, skipping persist"
                    )
                return

            inst = (self._profile.instrument_name or "UNKNOWN").strip() or "UNKNOWN"
            path = self._levels_state_dir / f"{inst}_levels.json"

            state = levels_store.load(path)
            new_state = levels_store.update(state, session_date, hi, lo)
            levels_store.save(new_state, path)
        except Exception as exc:  # noqa: BLE001 — must never bubble up
            if self._log is not None:
                self._log.warning("levels_store: persist failed: %s", exc)

    def _infer_session_date(self) -> str | None:
        """
        Return today's IST calendar date as ``YYYY-MM-DD``.

        Prefer ``_session_end_sec`` (set at session_open and tied to today's
        IST close) so the writer dates the entry correctly even if it runs
        a hair past midnight UTC. Fall back to ``time.time()`` if no session
        end was set (test/replay paths).
        """
        ts = self._session_end_sec if self._session_end_sec else time.time()
        try:
            return datetime.fromtimestamp(ts, tz=_IST).date().isoformat()
        except (OverflowError, OSError, ValueError):
            return None

    # ── Feed callbacks ────────────────────────────────────────────────────────

    def on_vix_tick(self, data: dict) -> None:
        """Phase 2d-01: route a recorded India VIX tick into the shared
        pipeline's VIX history buffer. VIX is the implied vol of NIFTY
        options but is consumed by every instrument's trend/swing gates
        as vol-regime context, so we co-subscribe on each TFA process's
        WS and append independently.

        Dhan publishes VIX as INDEX packets with `ltp` (the VIX value).
        Bad / missing inputs are silently dropped by the buffer's append.
        """
        try:
            ts = float(data.get("recv_ts") or time.time())
            ltp = float(data.get("ltp") or 0)
        except (TypeError, ValueError):
            return
        self._pipeline_state.histories.append_vix(ts, ltp)

    def on_underlying_tick(self, data: dict) -> None:
        """
        Called by DhanFeed on every Full-packet underlying tick.

        Args:
            data: Parsed tick dict with keys: ltp, bid, ask, ltq, recv_ts, etc.
        """
        ts = float(data.get("recv_ts") or time.time())
        ltp = float(data.get("ltp") or 0)
        bid = float(data.get("bid") or 0)
        ask = float(data.get("ask") or 0)
        vol = int(data.get("ltq") or data.get("volume") or 0)

        # Wave 1: capture session-OHLC from Dhan QUOTE/FULL packet fields.
        # day_high/day_low arrive on every QUOTE/FULL tick (not just at session
        # boundaries). prev_close arrives once via PrevClose packet (parsed
        # separately by binary_parser); accept it from data dict if present.
        dh = data.get("day_high")
        if dh is not None and dh > 0:
            self._day_high = float(dh)
        dl = data.get("day_low")
        if dl is not None and dl > 0:
            self._day_low = float(dl)
        pc = data.get("prev_close")
        if pc is not None and pc > 0:
            self._prev_close = float(pc)

        if self._session_open_sec == 0.0:
            self._session_open_sec = ts

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

        # Phase 2d: feed this underlying tick into the shared trend/swing
        # pipeline (bars / session / opening-range trackers).
        feature_pipeline.on_underlying_tick(
            self._pipeline_state, ts=ts, ltp=ltp, tick_volume=vol,
        )

        # ── Market-open check ─────────────────────────────────────────────────
        is_open = self._session_mgr.is_market_open if self._session_mgr is not None else True

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
        self._pending.append(
            _PendingRow(
                row=row,
                t0=ts,
                spot_at_t0=ltp,
                ltps_at_t0=strike_ltps,
                day_high_at_t0=self._day_high,
                day_low_at_t0=self._day_low,
            )
        )

        # Update prev-tick state
        self._prev_ltp = ltp
        self._prev_tick_ts = ts

    def on_option_tick(self, strike: int, opt_type: str, data: dict) -> None:
        """
        Called by DhanFeed on every Full-packet option tick.

        Args:
            strike:   Option strike price.
            opt_type: "CE" or "PE".
            data:     Parsed tick dict (ltp, bid, ask, bid_size, ask_size, ltq, recv_ts).
        """
        ts = float(data.get("recv_ts") or time.time())
        ltp = float(data.get("ltp") or 0)
        bid = float(data.get("bid") or 0)
        ask = float(data.get("ask") or 0)
        bid_size = int(data.get("bid_size") or 0)
        ask_size = int(data.get("ask_size") or 0)
        vol = int(data.get("ltq") or data.get("volume") or 0)

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

        # Phase 2d: ATM-only option ticks feed the premium-VWAP tracker
        # in the shared pipeline. Non-ATM ticks are skipped here so the
        # spec's "ATM CE / ATM PE premium streams" definition is preserved.
        atm = self._cache.atm
        if atm is not None and int(strike) == int(atm):
            feature_pipeline.on_atm_option_tick(
                self._pipeline_state, opt_type=opt_type, ltp=ltp, tick_volume=vol,
            )

        # Record raw option tick
        if self._recorder is not None:
            record = dict(data)
            record.setdefault("strike", strike)
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

        # Phase 2d: hand the snapshot to the shared trend/swing pipeline.
        # Populates PCR / OI totals / IV velocity / active strikes buffers
        # AND advances the OI-dominance streak. ATM-delta history is
        # populated separately on the per-tick Greeks pass.
        feature_pipeline.on_chain_snapshot(self._pipeline_state, snapshot, self._cache)

        # Record raw snapshot
        if self._recorder is not None:
            raw = {
                "recv_ts": snapshot.recv_ts,
                "underlying": snapshot.sec_id_map
                and next((sid for sid, _ in snapshot.sec_id_map.items()), ""),
                "expiry": snapshot.expiry,
                "spotPrice": snapshot.spot_price,
                "timestamp": int(snapshot.timestamp_sec * 1000),
                "rows": snapshot.rows,
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
        cache = self._cache

        # Underlying features
        uf = compute_underlying_features(self._tick_buf)
        ofi = compute_ofi_features(self._tick_buf)
        rv = compute_realized_vol_features(self._tick_buf)
        hf = compute_horizon_features(uf, ofi, rv)

        # ATM context (partial refresh if spot moved)
        cache.refresh_atm_zone(ltp)
        atm_strike = cache.atm
        strike_step = cache.strike_step
        atm_window = cache.atm_window

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
        chain_f = compute_chain_features(cache)
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
        zone_put_p = float(zone_f.get("atm_zone_put_pressure", _NAN))
        dead_mkt = float(decay_f.get("dead_market_score", _NAN))
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
        sm_state = self._sm.state
        t_allowed = 1 if self._sm.trading_allowed else 0
        warm_remain = self._sm.warm_up_remaining_sec or 0.0
        stale_rsn = sm_state.value if sm_state != TradingState.TRADING else None

        # ── Wave 1 features: levels, greeks, expiry ──────────────────────────
        chain_rows = cache.snapshot.rows if cache.snapshot is not None else None
        level_f = compute_level_features(
            spot=ltp,
            day_high=self._day_high,
            day_low=self._day_low,
            prev_close=self._prev_close,
            chain_rows=chain_rows,
        )

        # Find ATM-strike row from chain to extract IVs
        atm_ce_iv_pct = None
        atm_pe_iv_pct = None
        if chain_rows and atm_strike is not None:
            for r in chain_rows:
                if r.get("strike") == atm_strike:
                    atm_ce_iv_pct = r.get("callIV")
                    atm_pe_iv_pct = r.get("putIV")
                    break

        # Days-to-expiry from cache.snapshot (chain_poller resolved it)
        dte = None
        expiry_ts: float | None = None
        if cache.snapshot is not None and cache.snapshot.expiry:
            try:
                from datetime import datetime as _dt
                from datetime import timezone as _tz
                from datetime import timedelta as _td
                ist = _tz(_td(hours=5, minutes=30))
                exp_date = _dt.fromisoformat(cache.snapshot.expiry).date()
                # Use today's session_end clock-time on the expiry date
                exp_dt = _dt.combine(exp_date, _dt.fromtimestamp(self._session_end_sec, tz=ist).time(), tzinfo=ist) \
                    if self._session_end_sec else _dt.combine(exp_date, _dt.min.time(), tzinfo=ist)
                expiry_ts = exp_dt.timestamp()
                dte = (expiry_ts - ts) / 86400.0
            except (ValueError, TypeError, OSError):
                pass

        greek_f = compute_greek_features(
            spot=ltp,
            atm_strike=float(atm_strike) if atm_strike is not None else None,
            atm_ce_iv_pct=atm_ce_iv_pct,
            atm_pe_iv_pct=atm_pe_iv_pct,
            days_to_expiry=dte,
        )
        expiry_f = compute_expiry_features(
            now_ts=ts,
            expiry_ts=expiry_ts,
            session_open_ts=self._session_open_sec or None,
            session_end_ts=self._session_end_sec or None,
            is_monthly=None,  # Wave 1: classifier deferred — emits NaN
        )

        # Phase 2d: hand the ATM Greek snapshot to the shared pipeline so
        # dealer-hedging charm + vanna FD estimates have a 5-min lookback.
        feature_pipeline.append_atm_greek_snapshot(
            self._pipeline_state,
            ts=ts,
            atm_ce_delta=greek_f.get("atm_ce_delta"),
            atm_ce_iv_decimal=greek_f.get("atm_ce_iv"),
        )

        # Phase 2d: run the trend/swing pipeline. Returns 15 feature-group
        # dicts keyed by the kwargs assemble_flat_vector accepts.
        ce_prem, pe_prem = self._latest_atm_premiums(atm_strike)
        pipeline = feature_pipeline.compute_pipeline_features(
            self._pipeline_state,
            ts=ts,
            ltp=ltp,
            chain_rows=chain_rows,
            atm_strike=atm_strike,
            strike_step=strike_step,
            days_to_expiry=dte,
            instrument_name=self._profile.instrument_name,
            scheduled_session_start_sec=self._scheduled_session_start_sec,
            session_end_sec=self._session_end_sec or None,
            latest_atm_ce_premium=ce_prem,
            latest_atm_pe_premium=pe_prem,
        )

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
            target_feats=None,  # backfilled later
            trading_state=sm_state.value,
            trading_allowed=t_allowed,
            warm_up_remaining_sec=warm_remain,
            stale_reason=stale_rsn,
            meta_feats=meta_f,
            target_windows_sec=profile.target_windows_sec,
            level_feats=level_f,
            greek_feats=greek_f,
            expiry_feats=expiry_f,
            # Phase 2d-04: trend/swing feature groups (69 new columns)
            multi_tf_feats=pipeline["multi_tf_feats"],
            session_feats=pipeline["session_feats"],
            opening_range_feats=pipeline["opening_range_feats"],
            cross_day_level_feats=pipeline["cross_day_level_feats"],
            oi_flow_feats=pipeline["oi_flow_feats"],
            technical_feats=pipeline["technical_feats"],
            vix_feats=pipeline["vix_feats"],
            dealer_hedging_feats=pipeline["dealer_hedging_feats"],
            exhaustion_feats=pipeline["exhaustion_feats"],
            intraday_time_feats=pipeline["intraday_time_feats"],
            strike_rotation_feats=pipeline["strike_rotation_feats"],
            premium_vwap_feats=pipeline["premium_vwap_feats"],
            iv_velocity_feats=pipeline["iv_velocity_feats"],
            max_pain_feats=pipeline["max_pain_feats"],
            event_calendar_feats=pipeline["event_calendar_feats"],
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
                day_high_at_t0=p.day_high_at_t0,
                day_low_at_t0=p.day_low_at_t0,
            )
            min_w = min(self._profile.target_windows_sec)
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

    def _check_option_feed_stale(self, atm_window: list[int], current_ts: float) -> bool:
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
            "trend_volatility_min": p.regime_trend_volatility_min,
            "trend_imbalance_min": p.regime_trend_imbalance_min,
            "trend_momentum_min": p.regime_trend_momentum_min,
            "trend_activity_min": p.regime_trend_activity_min,
            "range_volatility_max": p.regime_range_volatility_max,
            "range_imbalance_max": p.regime_range_imbalance_max,
            "range_activity_min": p.regime_range_activity_min,
            "dead_activity_max": p.regime_dead_activity_max,
            "dead_vol_drought_max": p.regime_dead_vol_drought_max,
        }
