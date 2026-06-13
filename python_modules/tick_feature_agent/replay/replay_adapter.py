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
import os
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

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
from tick_feature_agent.features.multi_tf import compute_multi_tf_features
from tick_feature_agent.features.premium_acceleration import PremiumAccelerationState
from tick_feature_agent.features.regime import RegimeClassifier, compute_regime_features
from tick_feature_agent.features.strike_migration_persistence import (
    StrikeMigrationPersistenceState,
)
from tick_feature_agent.features.targets import (
    TargetBuffer,
    UpsidePercentileTracker,
)
from tick_feature_agent.features.trend_swing_targets import (
    SWING_HORIZONS_SEC,
    TREND_HORIZONS_SEC,
    SpotTargetBuffer,
)
from tick_feature_agent.features.time_to_move import TimeToMoveState
from tick_feature_agent.features.underlying import compute_underlying_features
from tick_feature_agent.features.zone import compute_zone_features
from tick_feature_agent.feed.chain_poller import ChainSnapshot
from tick_feature_agent.instrument_profile import InstrumentProfile
from tick_feature_agent.output.emitter import Emitter, assemble_flat_vector
from tick_feature_agent.state import feature_pipeline
from tick_feature_agent.state_machine import StateMachine, TradingState

# T35-FU1: clamp session_end to the abnormal close on Muhurat /
# half-session days so target lookahead doesn't reach into NULL/
# stale post-close prices.
import sys as _sys
from pathlib import Path as _Path
_PY_MODULES_DIR = _Path(__file__).resolve().parents[2]
if str(_PY_MODULES_DIR) not in _sys.path:
    _sys.path.insert(0, str(_PY_MODULES_DIR))
from market_calendar import effective_session_end_epoch  # noqa: E402

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
        return float(ts_str)  # Unix epoch as string
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

    row: dict  # mutable — will be updated in-place
    t0: float  # Unix seconds for this tick
    spot_at_t0: float  # underlying LTP at t0
    ltps_at_t0: dict[int, tuple[float, float]]  # {strike: (ce_ltp, pe_ltp)} at t0
    # Wave 2: snapshotted at t0 for breakout_in_X target. Day high/low
    # progress through the session so the value at trade-open is what
    # determines whether a future breakout occurred.
    day_high_at_t0: float | None = None
    day_low_at_t0: float | None = None


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
        rows = data.get("rows") or []
        spot = float(data.get("spotPrice") or data.get("spot_price") or 0)
        expiry = str(data.get("expiry", ""))
        ts_ms = data.get("timestamp") or data.get("timestamp_ms") or 0
        ts_sec = float(ts_ms) / 1000.0 if ts_ms else _parse_ts(str(data.get("recv_ts", "")))

        # Build sec_id_map: security_id → (strike, "CE"|"PE")
        sec_id_map: dict[str, tuple[int, str]] = {}
        for row in rows:
            strike = int(row.get("strike", 0))
            cs = str(row.get("callSecurityId") or row.get("call_security_id") or "")
            ps = str(row.get("putSecurityId") or row.get("put_security_id") or "")
            if cs:
                sec_id_map[cs] = (strike, "CE")
            if ps:
                sec_id_map[ps] = (strike, "PE")

        # Detect strike step from sorted unique strikes
        strikes = sorted(int(r.get("strike", 0)) for r in rows if r.get("strike"))
        strike_step = 50  # default
        if len(strikes) >= 2:
            diffs = [strikes[i + 1] - strikes[i] for i in range(len(strikes) - 1)]
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
        self._profile = profile
        self._date_str = date_str
        self._log = logger

        # ── Pipeline components ───────────────────────────────────────────────
        self._tick_buf = CircularBuffer(maxlen=50)
        self._opt_store = OptionBufferStore()
        self._sm = StateMachine(
            warm_up_duration_sec=profile.warm_up_duration_sec,
        )
        self._cache = ChainCache()

        # Stateful feature modules
        self._compression = CompressionState()
        self._time_to_move = TimeToMoveState()
        self._decay = DecayState()

        # Phase 2d: shared trend/swing feature pipeline state. Same holder
        # used by the live TickProcessor — the free-function helpers in
        # `feature_pipeline` populate it on chain / tick / option events
        # and produce the per-row compute dicts.
        self._pipeline_state = feature_pipeline.FeaturePipelineState()

        # Target modules
        # Retention matches the max flush window (max of scalp + trend + swing
        # horizons) because _flush_pending defers target compute until that
        # window elapses. Without this, scalp targets see an empty buffer and
        # return NaN for ~99% of rows. See diagnosis 2026-05-19.
        self._target_buf = TargetBuffer(
            target_windows_sec=profile.target_windows_sec,
            retention_window_sec=int(
                max(
                    max(profile.target_windows_sec) if profile.target_windows_sec else 60,
                    max(TREND_HORIZONS_SEC + SWING_HORIZONS_SEC),
                )
            ),
        )
        self._upside_pct = UpsidePercentileTracker()

        # T32 D4: 5-min sustain wrapper around compute_regime_features.
        # Stateful — confirmed regime stays unchanged until a candidate
        # transition holds for sustain_sec. Reset on session_start /
        # expiry rollover.
        _regime_sustain = float(
            getattr(profile, "regime_sustain_sec", 0.0)
            or self._regime_thresholds().get("regime_sustain_sec", 300.0)
        )
        self._regime_classifier = RegimeClassifier(sustain_sec=_regime_sustain)
        # T14 (scope F, 2026-06-13): stateful trackers for
        # premium-acceleration drop (per-leg) + strike-migration
        # persistence counter. Both reset on session_start /
        # expiry rollover via reset() — see flush_all below.
        self._premium_acceleration = PremiumAccelerationState()
        self._strike_migration_persistence = StrikeMigrationPersistenceState()

        # Phase 3: replay-only buffer for trend + swing target labels.
        # Live emits NaN per Option B (2026-05-18) — only replay backfills
        # the 24 trend/swing target columns.
        self._spot_target_buf = SpotTargetBuffer()

        # Output emitter in replay mode (accumulates rows in memory).
        # Phase E8: pass profile windows so the parquet schema picks up
        # 4-window direction columns as int32 instead of float32.
        self._emitter = Emitter(
            mode="replay",
            target_windows_sec=profile.target_windows_sec,
        )

        # ── Session boundary (Unix epoch seconds) ─────────────────────────────
        # T35-FU1: session_end is clamped against partial-session
        # entries in config/market_holidays.json. On a normal day the
        # value collapses to the profile's session_end. On a Muhurat /
        # MCX morning-only day, it returns the abnormal early close so
        # downstream target-labelling stops emitting NaN for lookahead
        # windows that reach into post-session NULL prices.
        self._session_start_sec = _session_boundary_sec(date_str, profile.session_start)
        self._session_end_sec = effective_session_end_epoch(
            date_str,
            exchange=profile.exchange,
            default_hhmm=profile.session_end,
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

        # Wave 1 / 2: session-level OHLC tracking from recorded QUOTE/FULL/PrevClose
        # data dicts. Mirrors live tick_processor state. Required for level
        # features (S/R distances) and breakout_in_X targets.
        self._day_high: float | None = None
        self._day_low: float | None = None
        self._prev_close: float | None = None
        # First tick's timestamp serves as session_open for the expiry
        # session_remaining_pct feature.
        self._session_open_replay_sec: float = 0.0

        # Target backfill queue
        self._pending: deque[_PendingRow] = deque()

        # Maximum target window (seconds) — determines when to backfill.
        # Phase 3: must also span the trend (1800s) + swing (7200s) horizons
        # so rows aren't flushed before their swing windows close.
        self._max_window_sec: float = max(
            max(profile.target_windows_sec) if profile.target_windows_sec else 60.0,
            float(max(TREND_HORIZONS_SEC + SWING_HORIZONS_SEC)),
        )

        # Market-open flag (derived from replay timestamps)
        self._is_market_open = False

        # Phase 2d: prime the shared trend/swing pipeline for this session.
        # Resets buffers + trackers, configures the OR window end at
        # session_start + 15 min per D74 B3, loads event_calendar.json +
        # this instrument's cross-day H/L state file (best-effort each).
        from pathlib import Path as _Path
        _repo = _Path(__file__).resolve().parents[3]
        feature_pipeline.reset_for_session(
            self._pipeline_state,
            scheduled_session_start_sec=self._session_start_sec,
            event_calendar_path=_repo / "config" / "event_calendar.json",
            cross_day_levels_path=_repo / "data" / "state"
                / f"{profile.instrument_name}_levels.json",
        )

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
                   ``type`` (one of ``underlying_tick``, ``option_tick``,
                   ``chain_snapshot``, ``vix_tick``)
                   ``data`` (raw recorded record dict)
        """
        etype = event.get("type")
        data = event.get("data", {})
        if etype == "underlying_tick":
            self._handle_underlying(data)
        elif etype == "option_tick":
            self._handle_option(data)
        elif etype == "chain_snapshot":
            self._handle_chain(data)
        elif etype == "vix_tick":
            self._handle_vix(data)

    def _handle_vix(self, data: dict) -> None:
        """Phase 2d-01: route a recorded India VIX tick into the shared
        pipeline's VIX history buffer. Mirrors TickProcessor.on_vix_tick."""
        ts_raw = data.get("recv_ts") or data.get("timestamp")
        ts = _parse_ts(str(ts_raw)) if ts_raw else _NAN
        if math.isnan(ts):
            return

        # Memory-leak fix: keep _pending drainage uniform across all event
        # types so no single tick stream can stall flushing.
        self._flush_pending(ts)

        try:
            ltp = float(data.get("ltp") or 0)
        except (TypeError, ValueError):
            return
        self._pipeline_state.histories.append_vix(ts, ltp)

    def flush_all(
        self,
        flush_progress_callback: Callable[[int, int], None] | None = None,
        on_batches_emitted: Callable[[int], None] | None = None,
    ) -> None:
        """
        Finalise all pending target rows after the event stream is exhausted.

        Rows whose target windows would extend past the session end get NaN
        targets (they represent incomplete lookahead windows).

        T50 B.3b: batched columnar path runs pending rows through the three
        Polars target functions, then emits in FIFO order. Falls back to
        per-row scalar when ``TFA_LEGACY_TARGETS=1``.

        Memory-safe chunking (added 2026-06-04 after a freeze repro):
        the columnar path now processes pending rows in batches of
        ``TFA_FLUSH_BATCH_SIZE`` (default 2000). On long sessions (esp.
        MCX 14.5h) the pending deque can hold 30k+ rows × ~500 columns
        at session end — feeding it all into one Polars DataFrame
        materialises tens of GB of intermediate columns and the OS
        starts paging. Chunking caps peak memory at batch_size ×
        column_count regardless of total pending size. The strike +
        spot history extracts are computed ONCE outside the loop and
        reused across batches — they're snapshots of the same target_buf
        state. Order is preserved (FIFO batches, FIFO emit within each).

        ``flush_progress_callback(rows_done, rows_total)`` fires once
        per batch when given — used by ``run_one_date`` to surface
        "flushing batch i/N" in the live progress dashboard so the
        operator can see movement during what used to look like a
        freeze.

        ``on_batches_emitted(n_batches_since_last_call)`` fires every
        N batches when given — used by ``run_one_date`` to write a
        chunk parquet mid-flush so the emitter's ``_parquet_rows``
        list doesn't accumulate every flushed row until ``flush_all``
        returns. Without this drain the emitter can hold 30k+ row
        dicts (~3 GB) at flush_all exit time, on top of pending and
        Polars working memory.
        """
        from tick_feature_agent.replay import targets_cache as _tc
        if _tc.legacy_enabled() or len(self._pending) < 2:
            # Scalar path: original per-row implementation. Also used
            # when there's only one pending row (Polars per-batch
            # overhead beats it).
            n_total = len(self._pending)
            n_done = 0
            while self._pending:
                pending = self._pending.popleft()
                targets = self._target_buf.compute_targets(
                    t0=pending.t0,
                    spot_at_t0=pending.spot_at_t0,
                    active_strike_ltps_at_t0=pending.ltps_at_t0,
                    session_end_sec=self._session_end_sec,
                    day_high_at_t0=pending.day_high_at_t0,
                    day_low_at_t0=pending.day_low_at_t0,
                )
                pending.row.update(targets)
                trend_swing = self._spot_target_buf.compute_targets(
                    t0=pending.t0,
                    spot_at_t0=pending.spot_at_t0,
                    instrument_name=self._profile.instrument_name,
                    session_end_sec=self._session_end_sec,
                )
                pending.row.update(trend_swing)
                self._emitter.emit(pending.row)
                n_done += 1
                # Heartbeat ~every 1000 rows so the dashboard ticks
                # even on the slower scalar path.
                if flush_progress_callback is not None and (
                    n_done % 1000 == 0 or n_done == n_total
                ):
                    try:
                        flush_progress_callback(n_done, n_total)
                    except Exception:
                        pass
        else:
            # Columnar batched path — chunked to bound peak memory.
            # See docstring for the rationale.
            from tick_feature_agent.replay.targets_cache import (
                extract_spot_history_df,
                extract_strike_history_df,
            )
            batch_size_str = os.environ.get("TFA_FLUSH_BATCH_SIZE", "500")
            try:
                batch_size = max(1, int(batch_size_str))
            except ValueError:
                batch_size = 500
            # Mid-flush emitter-drain frequency. Default: every 10
            # batches → at batch=500 that's 5k accumulated rows before
            # _parquet_rows is written + cleared. Tune lower if RAM is
            # tighter; tune higher (or set to 0 to disable) if you'd
            # rather pay one big merge at the end on a fast disk.
            drain_str = os.environ.get("TFA_FLUSH_DRAIN_EVERY_N_BATCHES", "10")
            try:
                drain_every_n = max(0, int(drain_str))
            except ValueError:
                drain_every_n = 10

            # Snapshot the history dataframes once. Cheap relative to
            # compute and constant across batches (target_buf state
            # doesn't change while we're flushing — no new ticks
            # arriving post-stream).
            strike_history_df = extract_strike_history_df(self._target_buf)
            spot_history_df = extract_spot_history_df(self._spot_target_buf)

            n_total = len(self._pending)
            n_done = 0
            batches_since_drain = 0
            # Drain the deque PROGRESSIVELY via popleft instead of
            # snapshotting the whole thing into a list upfront. The
            # upfront-snapshot approach (2026-06-04 first fix) pinned
            # all N_pending rows for the entire flush; with 30k rows of
            # ~500-key dicts that's ~3 GB held for the whole flush even
            # though we only need batch_size rows in hand at any moment.
            # Progressive drain lets CPython's refcount GC reclaim each
            # batch's pending dicts as soon as they're emitted into the
            # emitter (which is the new owner — emitter still
            # accumulates until the next _flush_chunk, but at least
            # pending isn't double-pinned).
            while self._pending:
                batch_n = min(batch_size, len(self._pending))
                batch = [self._pending.popleft() for _ in range(batch_n)]
                batched = _tc.compute_pending_targets_batched(
                    pending_rows=batch,
                    target_buf=self._target_buf,
                    spot_target_buf=self._spot_target_buf,
                    instrument_name=self._profile.instrument_name,
                    session_end_sec=self._session_end_sec,
                    target_windows_sec=self._profile.target_windows_sec,
                    strike_history_df=strike_history_df,
                    spot_history_df=spot_history_df,
                )
                # Note: flush_all does NOT call self._upside_pct (matches
                # the scalar flush_all path above; only _flush_pending
                # does). End-of-session rows leave upside_percentile_*
                # unset — same as pre-T50 behaviour.
                for pending, target_dict in zip(batch, batched, strict=True):
                    pending.row.update(target_dict)
                    self._emitter.emit(pending.row)
                n_done += batch_n
                if flush_progress_callback is not None:
                    try:
                        flush_progress_callback(n_done, n_total)
                    except Exception:
                        pass
                # Help GC reclaim the batch + its result list before
                # the next iteration claims its own working memory.
                # The pending dicts inside `batch` are now referenced
                # by emitter._parquet_rows, so del'ing batch here just
                # drops our local reference — emitter retains them
                # until the next _flush_chunk drains.
                del batched
                del batch
                # Mid-flush emitter drain. Let the caller write a chunk
                # parquet every drain_every_n batches so the emitter's
                # _parquet_rows list doesn't hold all flushed rows
                # simultaneously. drain_every_n=0 disables.
                batches_since_drain += 1
                if (
                    on_batches_emitted is not None
                    and drain_every_n > 0
                    and batches_since_drain >= drain_every_n
                ):
                    try:
                        on_batches_emitted(batches_since_drain)
                    except Exception:
                        pass
                    batches_since_drain = 0
            # Final drain hint so the caller can write the tail
            # accumulation as a chunk too (idempotent if it already
            # wrote on the last loop iteration).
            if on_batches_emitted is not None and batches_since_drain > 0:
                try:
                    on_batches_emitted(batches_since_drain)
                except Exception:
                    pass
            del strike_history_df
            del spot_history_df

        # Reset target buffer and tracker for clean re-use (if any)
        self._target_buf.reset()
        self._upside_pct.reset()
        self._spot_target_buf.reset()
        self._regime_classifier.reset()  # T32 — clear sustain state
        # T14 (scope F)
        self._premium_acceleration.reset()
        self._strike_migration_persistence.reset()

    # ── Event handlers ────────────────────────────────────────────────────────

    def _handle_chain(self, data: dict) -> None:
        """Process a recorded chain_snapshot event."""
        snapshot = _build_chain_snapshot(data)
        if snapshot is None:
            return

        # T50 B.3a: thread the current snapshot's timestamp into the
        # max_pain_cache module so the monkey-patched
        # compute_max_pain_features can look up the pre-computed
        # max_pain_strike for THIS snapshot. No-op (writes to an unread
        # module var) when the cache isn't installed (live mode never
        # installs; replay can opt out via TFA_LEGACY_MAX_PAIN=1).
        from tick_feature_agent.replay import max_pain_cache as _mpc
        _mpc.current_snapshot_ts = float(snapshot.timestamp_sec)

        # Memory-leak fix: advance pending-row flush on every event with a
        # valid timestamp, not only on underlying ticks. Without this, sparse
        # underlying + dense option/chain caused unbounded growth of
        # self._pending during long replays.
        ts_chain = float(snapshot.timestamp_sec)
        if not math.isnan(ts_chain):
            self._flush_pending(ts_chain)

        was_stale = not self._cache.chain_available

        self._cache.update_from_snapshot(snapshot)
        self._sec_id_map = snapshot.sec_id_map

        # Notify state machine that chain is healthy
        if was_stale or self._sm.state == TradingState.CHAIN_STALE:
            self._sm.on_chain_recovered()

        # Phase 2d: feed the snapshot through the shared trend/swing pipeline.
        feature_pipeline.on_chain_snapshot(
            self._pipeline_state, snapshot, self._cache,
        )

    def _handle_option(self, data: dict) -> None:
        """Process a recorded option_tick event."""
        ts_raw = data.get("recv_ts") or data.get("timestamp")
        ts = _parse_ts(str(ts_raw)) if ts_raw else _NAN
        if math.isnan(ts):
            return

        # Memory-leak fix: option ticks dominate event volume during dense
        # periods. Flushing here keeps self._pending bounded when underlying
        # ticks go sparse.
        self._flush_pending(ts)

        # Look up (strike, opt_type) from the tick data or sec_id_map
        strike = data.get("strike")
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

        ltp = float(data.get("ltp") or 0)
        bid = float(data.get("bid") or 0)
        ask = float(data.get("ask") or 0)
        bid_size = int(data.get("bid_size") or data.get("bidSize") or 0)
        ask_size = int(data.get("ask_size") or data.get("askSize") or 0)
        volume = int(data.get("ltq") or data.get("volume") or 0)

        # T37: surface levels 1-4 of the recorded depth array. Recorded
        # ndjson includes the full 5-level depth list; level 0 is the
        # top-of-book already exposed above. Empty/missing depth →
        # defaults (zero quantities) preserve legacy synthetic ticks.
        from tick_feature_agent.buffers.option_buffer import depth_levels_to_kwargs
        depth_kwargs = depth_levels_to_kwargs(data.get("depth"))

        tick = OptionTick(
            timestamp=ts,
            ltp=ltp,
            bid=bid,
            ask=ask,
            bid_size=bid_size,
            ask_size=ask_size,
            volume=volume,
            **depth_kwargs,
        )
        self._opt_store.push(strike, str(opt_type), tick)

        # Phase 2d: ATM-only premium ticks feed the shared pipeline's
        # premium-VWAP tracker. Non-ATM ticks are skipped here so the
        # spec's "ATM CE / ATM PE premium streams" definition is preserved.
        atm = self._cache.atm
        if atm is not None and strike == int(atm):
            feature_pipeline.on_atm_option_tick(
                self._pipeline_state,
                opt_type=str(opt_type),
                ltp=ltp,
                tick_volume=volume,
            )

    def _handle_underlying(self, data: dict) -> None:
        """Process a recorded underlying_tick event — the hot path."""
        ts_raw = data.get("recv_ts") or data.get("timestamp")
        ts = _parse_ts(str(ts_raw)) if ts_raw else _NAN
        if math.isnan(ts):
            return

        ltp = float(data.get("ltp") or 0)
        bid = float(data.get("bid") or 0)
        ask = float(data.get("ask") or 0)
        vol = int(data.get("ltq") or data.get("volume") or 0)

        # ── Wave 1/2: capture session OHLC from recorded QUOTE/FULL fields ────
        dh = data.get("day_high")
        if dh is not None and dh > 0:
            self._day_high = float(dh)
        dl = data.get("day_low")
        if dl is not None and dl > 0:
            self._day_low = float(dl)
        pc = data.get("prev_close")
        if pc is not None and pc > 0:
            self._prev_close = float(pc)

        if self._session_open_replay_sec == 0.0:
            self._session_open_replay_sec = ts

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
        if self._cache.chain_available and self._cache.last_snapshot_ts > 0:
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

        # Phase 2d: feed the per-tick stateful trackers through the shared
        # pipeline (bars / session / opening range).
        feature_pipeline.on_underlying_tick(
            self._pipeline_state, ts=ts, ltp=ltp, tick_volume=vol,
        )

        # ── Push to target buffer (future-lookahead state) ────────────────────
        # Gather current ATM strike LTPs for target computation reference
        strike_ltps = self._get_atm_strike_ltps()
        self._target_buf.push(
            timestamp_sec=ts,
            spot=ltp,
            strike_ltps=strike_ltps,
        )
        # Phase 3: feed the spot-only buffer used by trend + swing target
        # compute. Lightweight — stores only (ts, spot), no option legs.
        self._spot_target_buf.push(ts, ltp)

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
            day_high_at_t0=self._day_high,
            day_low_at_t0=self._day_low,
        )
        self._pending.append(pending)

        # Update previous tick state for TimeToMoveState
        self._prev_ltp = ltp
        self._prev_tick_ts = ts

    # ── Helper: latest ATM premiums for the C8 premium-VWAP dist features ────

    def _latest_atm_premiums(
        self, atm_strike: int | None
    ) -> tuple[float | None, float | None]:
        """Return (latest_ATM_CE_ltp, latest_ATM_PE_ltp) from option_store."""
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

    # ── Feature computation ───────────────────────────────────────────────────

    def _compute_row(self, ts: float, ltp: float, bid: float, ask: float) -> dict:
        """Compute all features (excluding targets) and assemble a flat row dict."""
        profile = self._profile
        cache = self._cache

        # ── Underlying features ───────────────────────────────────────────────
        uf = compute_underlying_features(self._tick_buf)
        ofi = compute_ofi_features(self._tick_buf)
        rv = compute_realized_vol_features(self._tick_buf)
        hf = compute_horizon_features(uf, ofi, rv)

        # ── ATM context ───────────────────────────────────────────────────────
        # Refresh ATM zone when spot changes (returns True if shifted)
        cache.refresh_atm_zone(ltp)

        atm_strike = cache.atm
        strike_step = cache.strike_step
        atm_window = cache.atm_window

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

        # ── Regime features (T32 D4: sustained + ADX-aware) ──────────────────
        # ADX(14) on 5-min bars feeds the new TREND_STRONG tier.
        # compute_multi_tf_features is cheap on already-aggregated bars and
        # is re-invoked inside compute_pipeline_features below — duplicate
        # work but negligible (~100µs per call); avoids reordering the hot
        # path. ADX is NaN until ≥14 5-min bars have closed → classifier
        # gracefully falls back to TREND (no TREND_STRONG yet).
        _bars_5m_for_regime = self._pipeline_state.bars.get_recent_bars(300)
        _bars_1m_for_regime = self._pipeline_state.bars.get_recent_bars(60)
        _bars_15m_for_regime = self._pipeline_state.bars.get_recent_bars(900)
        _multi_tf_for_regime = compute_multi_tf_features(
            spot=ltp,
            bars_1m=_bars_1m_for_regime,
            bars_5m=_bars_5m_for_regime,
            bars_15m=_bars_15m_for_regime,
        )
        _adx_5min_for_regime = float(_multi_tf_for_regime.get("adx_5min", _NAN))
        regime_f = self._regime_classifier.update(
            now_ts=ts,
            buffer=self._tick_buf,
            volatility_compression=float(comp_f.get("volatility_compression", _NAN)),
            tick_imbalance_20=float(uf.get("tick_imbalance_20", _NAN)),
            active_strike_count=int(decay_f.get("active_strike_count", 0)),
            vol_diff_available=cache.vol_diff_available,
            trading_state=self._sm.state.value,
            volume_drought_atm=float(decay_f.get("volume_drought_atm", _NAN)),
            thresholds=self._regime_thresholds(),
            adx_5min=_adx_5min_for_regime,
        )

        # Now update TimeToMoveState with real zone pressures (re-compute for
        # this tick if zone data is ready)
        zone_call_p = float(zone_f.get("atm_zone_call_pressure", _NAN))
        zone_put_p = float(zone_f.get("atm_zone_put_pressure", _NAN))
        dead_mkt = float(decay_f.get("dead_market_score", _NAN))
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
        sm_state = self._sm.state
        t_allowed = 1 if self._sm.trading_allowed else 0
        warm_remain = self._sm.warm_up_remaining_sec or 0.0
        stale_rsn = self._sm.state.value if sm_state != TradingState.TRADING else None

        # ── Wave 1 features: levels, greeks, expiry (mirror tick_processor) ───
        chain_rows = cache.snapshot.rows if cache.snapshot is not None else None
        level_f = compute_level_features(
            spot=ltp,
            day_high=self._day_high,
            day_low=self._day_low,
            prev_close=self._prev_close,
            chain_rows=chain_rows,
        )

        # Find ATM-strike row from chain to extract IVs for greeks
        atm_ce_iv_pct = None
        atm_pe_iv_pct = None
        if chain_rows and atm_strike is not None:
            for r in chain_rows:
                if r.get("strike") == atm_strike:
                    atm_ce_iv_pct = r.get("callIV")
                    atm_pe_iv_pct = r.get("putIV")
                    break

        # Days-to-expiry from cache.snapshot (chain_poller resolved it).
        # In replay this is reconstructed from the recorded snapshot.
        dte = None
        expiry_ts: float | None = None
        if cache.snapshot is not None and cache.snapshot.expiry:
            try:
                from datetime import datetime as _dt
                from datetime import timezone as _tz
                from datetime import timedelta as _td
                ist = _tz(_td(hours=5, minutes=30))
                exp_date = _dt.fromisoformat(cache.snapshot.expiry).date()
                exp_dt = _dt.combine(
                    exp_date,
                    _dt.fromtimestamp(self._session_end_sec, tz=ist).time(),
                    tzinfo=ist,
                ) if self._session_end_sec else _dt.combine(exp_date, _dt.min.time(), tzinfo=ist)
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
            session_open_ts=self._session_open_replay_sec or None,
            session_end_ts=self._session_end_sec or None,
            is_monthly=None,
        )

        # Phase 2d: hand the ATM Greek snapshot to the shared pipeline so
        # dealer-hedging charm + vanna FD estimates have a 5-min lookback.
        feature_pipeline.append_atm_greek_snapshot(
            self._pipeline_state,
            ts=ts,
            atm_ce_delta=greek_f.get("atm_ce_delta"),
            atm_ce_iv_decimal=greek_f.get("atm_ce_iv"),
        )

        # Phase 2d: run the shared trend/swing pipeline.
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
            scheduled_session_start_sec=self._session_start_sec,
            session_end_sec=self._session_end_sec or None,
            latest_atm_ce_premium=ce_prem,
            latest_atm_pe_premium=pe_prem,
        )

        # ── T14 scope F: ATM premium-acceleration drop + strike-migration
        # persistence counter. Both run BEFORE assemble_flat_vector so
        # their outputs flow in via the dedicated kwarg.
        _atm_ce_dict = opt_tf.get((atm_strike, "CE"), {}) if atm_strike is not None else {}
        _atm_pe_dict = opt_tf.get((atm_strike, "PE"), {}) if atm_strike is not None else {}
        _accel = self._premium_acceleration.update(
            ce_momentum=_atm_ce_dict.get("premium_momentum"),
            pe_momentum=_atm_pe_dict.get("premium_momentum"),
        )
        _strike_dir = (
            pipeline.get("strike_rotation_feats", {}) or {}
        ).get("active_strike_shift_direction")
        _migration_ticks = self._strike_migration_persistence.update(_strike_dir)
        t14_feats = {
            **_accel,
            "strike_migration_persistence_ticks": _migration_ticks,
        }

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
            target_feats=None,  # NaN placeholders; backfilled below
            trading_state=sm_state.value,
            trading_allowed=t_allowed,
            warm_up_remaining_sec=warm_remain,
            stale_reason=stale_rsn,
            meta_feats=meta_f,
            target_windows_sec=profile.target_windows_sec,
            level_feats=level_f,
            greek_feats=greek_f,
            expiry_feats=expiry_f,
            # Phase 2d-04 mirror: trend/swing feature groups (69 new columns)
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
            # T14 (scope F): premium-acceleration + strike-migration
            t14_feats=t14_feats,
        )
        return row

    # ── Target backfill helpers ───────────────────────────────────────────────

    def _flush_pending(self, current_ts: float) -> None:
        """
        Emit any pending rows whose full target window has elapsed.

        A row at t0 is ready when current_ts >= t0 + max_window_sec.

        T50 B.3b: collects all ready rows up-front, then batch-computes
        targets via the columnar functions. Falls back to per-row scalar
        when ``TFA_LEGACY_TARGETS=1`` or when the ready batch is < 2 rows
        (scalar wins below the Polars per-batch overhead break-even).
        """
        # Collect eligible rows (FIFO order preserved by popleft loop).
        ready: list = []
        while self._pending:
            head = self._pending[0]
            if current_ts < head.t0 + self._max_window_sec:
                break  # remaining rows are also not ready (queue is FIFO)
            ready.append(self._pending.popleft())
        if not ready:
            return

        from tick_feature_agent.replay import targets_cache as _tc
        min_window = min(self._profile.target_windows_sec)
        upside_key = f"max_upside_{min_window}s"
        upside_pct_key = f"upside_percentile_{min_window}s"

        if _tc.legacy_enabled() or len(ready) < 2:
            # Scalar per-row fallback (original behaviour).
            for pending in ready:
                targets = self._target_buf.compute_targets(
                    t0=pending.t0,
                    spot_at_t0=pending.spot_at_t0,
                    active_strike_ltps_at_t0=pending.ltps_at_t0,
                    session_end_sec=self._session_end_sec,
                    day_high_at_t0=pending.day_high_at_t0,
                    day_low_at_t0=pending.day_low_at_t0,
                )
                upside_val = targets.get(upside_key, _NAN)
                targets[upside_pct_key] = self._upside_pct.add_and_query(upside_val)
                pending.row.update(targets)
                trend_swing = self._spot_target_buf.compute_targets(
                    t0=pending.t0,
                    spot_at_t0=pending.spot_at_t0,
                    instrument_name=self._profile.instrument_name,
                    session_end_sec=self._session_end_sec,
                )
                pending.row.update(trend_swing)
                self._emitter.emit(pending.row)
            return

        # Batched columnar path.
        batched = _tc.compute_pending_targets_batched(
            pending_rows=ready,
            target_buf=self._target_buf,
            spot_target_buf=self._spot_target_buf,
            instrument_name=self._profile.instrument_name,
            session_end_sec=self._session_end_sec,
            target_windows_sec=self._profile.target_windows_sec,
        )
        for pending, target_dict in zip(ready, batched, strict=True):
            pending.row.update(target_dict)
            # upside_percentile must stay sequential — UpsidePercentileTracker
            # carries state across calls and we must preserve FIFO ordering.
            upside_val = pending.row.get(upside_key, _NAN)
            pending.row[upside_pct_key] = self._upside_pct.add_and_query(upside_val)
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
