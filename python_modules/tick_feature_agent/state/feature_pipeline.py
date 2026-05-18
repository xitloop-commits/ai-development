"""
feature_pipeline.py — shared trend/swing feature pipeline (live + replay).

Both ``tick_processor.TickProcessor`` (live) and
``replay.replay_adapter.ReplayAdapter`` (replay) need to:

  1. Own one ``FeatureHistories`` + six per-session stateful trackers
     (bars, session, opening-range, premium-VWAP, exhaustion,
     OI-dominance) plus a loaded event calendar + a loaded cross-day
     level state.
  2. Populate the history buffers + tracker states on chain snapshots,
     underlying ticks, ATM option ticks, and the Greek-recompute path.
  3. Invoke the trend/swing ``compute_*_features`` functions once per
     emitter row and hand a dict of feature-group dicts back to the
     caller, which then routes them into ``assemble_flat_vector``.

Before this module, those six concerns lived as parallel copies in
``TickProcessor`` and ``ReplayAdapter``. Putting the shared work here
makes both call-sites thin wrappers and lets future feature additions
(target labels, L8 regime wiring, etc.) land in exactly one place.

What stays in each caller (the "thin wrapper" part):
  - Wall-clock vs replay-time semantics (state-machine warm-up, etc.).
  - Recording / event routing.
  - Session-boundary computation (live derives it from the next-day
    schedule; replay derives it from the recording's date).
  - The ``assemble_flat_vector`` call itself, with the existing Wave 1
    + Wave 2 kwargs untouched.

Threading: single-threaded. The state holder and helpers must only be
called from the same asyncio loop that owns the caller.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

from tick_feature_agent.chain_cache import ChainCache
from tick_feature_agent.features.active_features import compute_strike_rotation_features
from tick_feature_agent.features.bars import BarAggregator
from tick_feature_agent.features.chain import (
    compute_oi_change_deltas,
    compute_oi_weighted_levels,
    compute_pcr_slope,
    compute_wall_strength,
)
from tick_feature_agent.features.dealer_hedging import compute_dealer_hedging_features
from tick_feature_agent.features.event_calendar import (
    compute_event_calendar_features,
    load_event_calendar,
)
from tick_feature_agent.features.exhaustion import (
    ExhaustionState,
    compute_exhaustion_features,
)
from tick_feature_agent.features.greeks import compute_iv_velocity_features
from tick_feature_agent.features.india_vix import compute_india_vix_features
from tick_feature_agent.features.intraday_time import compute_intraday_time_features
from tick_feature_agent.features.levels import (
    compute_cross_day_level_features,
    compute_max_pain_features,
)
from tick_feature_agent.features.multi_tf import compute_multi_tf_features
from tick_feature_agent.features.oi_dominance import (
    OiDominanceState,
    compute_oi_dominance_features,
)
from tick_feature_agent.features.opening_range import (
    OpeningRangeState,
    compute_opening_range_features,
)
from tick_feature_agent.features.premium_vwap import (
    PremiumVwapState,
    compute_premium_vwap_features,
)
from tick_feature_agent.features.session import (
    SessionState,
    compute_session_features,
)
from tick_feature_agent.features.technical import compute_technical_features
from tick_feature_agent.feed.chain_poller import ChainSnapshot
from tick_feature_agent.state import levels_store
from tick_feature_agent.state.feature_histories import FeatureHistories


# Round-number step for the B5 round-number distance features. Keyed by
# the profile's `instrument_name`. Unknown instruments → None → those two
# features NaN. Promote to InstrumentProfile when FINNIFTY etc. join.
_ROUND_NUMBER_STEP: dict[str, int] = {
    "NIFTY": 100,
    "BANKNIFTY": 500,
    "CRUDEOIL": 100,
    "NATURALGAS": 10,
}


@dataclass
class FeaturePipelineState:
    """All per-instrument state the Phase 2 features need.

    Owners (``TickProcessor`` / ``ReplayAdapter``) construct one
    ``FeaturePipelineState`` in their ``__init__`` and pass it back to each
    helper below. ``reset_for_session`` is the single entry point for
    session-boundary handling.
    """

    histories: FeatureHistories = field(default_factory=FeatureHistories)
    bars: BarAggregator = field(
        default_factory=lambda: BarAggregator(
            timeframes_sec=(60, 300, 900), max_bars_per_tf=60
        )
    )
    session: SessionState = field(default_factory=SessionState)
    opening_range: OpeningRangeState = field(default_factory=OpeningRangeState)
    premium_vwap: PremiumVwapState = field(default_factory=PremiumVwapState)
    exhaustion: ExhaustionState = field(default_factory=ExhaustionState)
    oi_dominance: OiDominanceState = field(default_factory=OiDominanceState)
    event_calendar: dict | None = None
    cross_day_levels: "levels_store.CrossDayLevels" = field(
        default_factory=levels_store.CrossDayLevels
    )


def reset_for_session(
    state: FeaturePipelineState,
    *,
    scheduled_session_start_sec: float | None,
    event_calendar_path: Path | None,
    cross_day_levels_path: Path | None,
) -> None:
    """Reset/configure every component for a fresh session.

    Args:
        state: the FeaturePipelineState to reset.
        scheduled_session_start_sec: 09:15 IST (NSE) / 09:00 IST (MCX)
            epoch for today. Used to configure the opening-range window
            end as start + 15 min per D74 B3. ``None`` skips OR config.
        event_calendar_path: ``config/event_calendar.json``. Loader is
            best-effort; missing / unreadable file → ``None``.
        cross_day_levels_path: ``data/state/<inst>_levels.json``. Same
            best-effort posture.
    """
    state.histories.reset()
    state.bars.reset()
    state.session.reset()
    state.opening_range.reset()
    state.premium_vwap.reset()
    state.exhaustion.reset()
    state.oi_dominance.reset()

    if scheduled_session_start_sec is not None:
        try:
            state.opening_range.configure(
                window_end_ts=float(scheduled_session_start_sec) + 15 * 60.0
            )
        except (TypeError, ValueError):
            pass

    state.event_calendar = _try_load_event_calendar(event_calendar_path)
    state.cross_day_levels = _try_load_cross_day_levels(cross_day_levels_path)


def _try_load_event_calendar(path: Path | None) -> dict | None:
    if path is None:
        return None
    try:
        if path.exists():
            return load_event_calendar(path)
    except Exception:
        pass
    return None


def _try_load_cross_day_levels(path: Path | None) -> "levels_store.CrossDayLevels":
    if path is None:
        return levels_store.CrossDayLevels()
    try:
        return levels_store.load(path)
    except Exception:
        return levels_store.CrossDayLevels()


# ── Population helpers (call from the appropriate per-event callback) ────


def on_chain_snapshot(
    state: FeaturePipelineState,
    snapshot: ChainSnapshot,
    cache: ChainCache,
) -> None:
    """Populate PCR / OI totals / IV velocity / active strikes buffers
    AND update the OI-dominance streak. Call after ChainCache has
    already absorbed the snapshot."""
    snap_ts = snapshot.timestamp_sec

    if cache.pcr_global is not None:
        state.histories.append_pcr(snap_ts, cache.pcr_global)

    state.histories.append_oi_totals(
        snap_ts,
        float(cache.oi_total_call),
        float(cache.oi_total_put),
    )

    atm = cache.atm
    if atm is not None:
        for row in snapshot.rows:
            try:
                if int(row.get("strike", -1)) != int(atm):
                    continue
            except (TypeError, ValueError):
                continue
            ce_iv_pct = row.get("callIV")
            pe_iv_pct = row.get("putIV")
            if ce_iv_pct is None or pe_iv_pct is None:
                break
            try:
                ce_dec = float(ce_iv_pct) / 100.0
                pe_dec = float(pe_iv_pct) / 100.0
            except (TypeError, ValueError):
                break
            state.histories.append_iv_velocity(
                snap_ts, ce_dec, pe_dec, snapshot.spot_price,
            )
            break

    state.histories.append_active_strikes(snap_ts, list(snapshot.rows))

    state.oi_dominance.update(
        ts=snap_ts,
        oi_change_call=float(cache.oi_change_call),
        oi_change_put=float(cache.oi_change_put),
    )


def on_underlying_tick(
    state: FeaturePipelineState,
    ts: float,
    ltp: float,
    tick_volume: float,
) -> None:
    """Feed the per-tick stateful trackers (bars / session / opening range)."""
    state.bars.add_tick(ts, ltp, tick_volume=tick_volume)
    state.session.update(ts, ltp, tick_volume=tick_volume)
    state.opening_range.update(ts, ltp)


def on_atm_option_tick(
    state: FeaturePipelineState,
    *,
    opt_type: str,
    ltp: float,
    tick_volume: float,
) -> None:
    """Feed a tick that's been verified to be on the current ATM strike
    into the premium-VWAP accumulator. Non-ATM ticks should NOT reach
    this helper — the caller filters by strike."""
    if ltp <= 0:
        return
    if opt_type == "CE":
        state.premium_vwap.update(
            ce_premium=ltp, pe_premium=None, tick_volume=tick_volume,
        )
    elif opt_type == "PE":
        state.premium_vwap.update(
            ce_premium=None, pe_premium=ltp, tick_volume=tick_volume,
        )


def append_atm_greek_snapshot(
    state: FeaturePipelineState,
    ts: float,
    atm_ce_delta: float | None,
    atm_ce_iv_decimal: float | None,
) -> None:
    """Append the post-Greek-compute ATM snapshot to the FD buffer so
    charm + vanna FD estimates have a 5-min lookback to slope against."""
    if atm_ce_delta is None or atm_ce_iv_decimal is None:
        return
    if not (math.isfinite(atm_ce_delta) and math.isfinite(atm_ce_iv_decimal)):
        return
    state.histories.append_atm_delta(ts, atm_ce_delta, atm_ce_iv_decimal)


# ── Per-row compute ──────────────────────────────────────────────────────


def compute_pipeline_features(
    state: FeaturePipelineState,
    *,
    ts: float,
    ltp: float,
    chain_rows: list[dict] | None,
    atm_strike: int | None,
    strike_step: int | None,
    days_to_expiry: float | None,
    instrument_name: str,
    scheduled_session_start_sec: float | None,
    session_end_sec: float | None,
    latest_atm_ce_premium: float | None,
    latest_atm_pe_premium: float | None,
) -> dict[str, dict]:
    """Run the trend/swing compute functions and return the dict of
    feature-group dicts ``assemble_flat_vector`` expects. Identical
    semantics to the inline helper that previously lived in both
    TickProcessor and ReplayAdapter."""
    h = state.histories

    vix_feats = compute_india_vix_features(now_ts=ts, vix_history=h.vix_list())

    dealer_hedging_feats = compute_dealer_hedging_features(
        spot=ltp,
        rows=chain_rows or [],
        days_to_expiry=days_to_expiry,
        atm_delta_history=h.atm_delta_list(),
        now_ts=ts,
    )

    max_pain_feats = compute_max_pain_features(spot=ltp, chain_rows=chain_rows)

    event_calendar_feats = compute_event_calendar_features(
        now_ts=ts, calendar=state.event_calendar,
    )

    # C1 OI-flow group — 5 compute functions merged into one dict so the
    # emitter's single `oi_flow_feats` kwarg covers all 12 C1 keys.
    oi_flow_feats: dict[str, float] = {}
    oi_flow_feats.update(compute_oi_weighted_levels(chain_rows))
    oi_flow_feats.update(compute_pcr_slope(pcr_history=h.pcr_list(), now_ts=ts))
    oi_flow_feats.update(compute_wall_strength(chain_rows))
    oi_flow_feats.update(
        compute_oi_change_deltas(oi_history=h.oi_totals_list(), now_ts=ts)
    )
    oi_flow_feats.update(compute_oi_dominance_features(state.oi_dominance))

    iv_velocity_feats = compute_iv_velocity_features(
        iv_history=h.iv_velocity_list(), now_ts=ts,
    )

    strike_rotation_feats = compute_strike_rotation_features(
        active_strike_history=h.active_strikes_list(),
        atm_strike=atm_strike,
        strike_step=strike_step,
        now_ts=ts,
    )

    cd = state.cross_day_levels
    cross_day_level_feats = compute_cross_day_level_features(
        spot=ltp,
        prev_day_high=cd.prev_day_high if cd else None,
        prev_day_low=cd.prev_day_low if cd else None,
        swing_5d_high=cd.swing_5d_high if cd else None,
        swing_5d_low=cd.swing_5d_low if cd else None,
        round_number_step=_ROUND_NUMBER_STEP.get(instrument_name),
    )

    bars_1m = state.bars.get_recent_bars(60)
    bars_5m = state.bars.get_recent_bars(300)
    bars_15m = state.bars.get_recent_bars(900)
    technical_feats = compute_technical_features(bars_5m)
    multi_tf_feats = compute_multi_tf_features(
        spot=ltp, bars_1m=bars_1m, bars_5m=bars_5m, bars_15m=bars_15m,
    )

    session_feats = compute_session_features(
        state=state.session, spot=ltp, now_ts=ts,
    )

    opening_range_feats = compute_opening_range_features(
        state=state.opening_range, spot=ltp, now_ts=ts,
    )

    intraday_time_feats = compute_intraday_time_features(
        now_ts=ts,
        session_open_ts=scheduled_session_start_sec,
        session_close_ts=session_end_sec or None,
    )

    premium_vwap_feats = compute_premium_vwap_features(
        state=state.premium_vwap,
        current_ce_premium=latest_atm_ce_premium,
        current_pe_premium=latest_atm_pe_premium,
    )

    # ExhaustionState.update() waits for the L8 regime tag (Phase 6).
    # Compute is safe — returns trend_age=0 + bar-derived
    # volume_no_move_score.
    exhaustion_feats = compute_exhaustion_features(
        state=state.exhaustion, bars_5m=bars_5m,
    )

    return {
        "multi_tf_feats": multi_tf_feats,
        "session_feats": session_feats,
        "opening_range_feats": opening_range_feats,
        "cross_day_level_feats": cross_day_level_feats,
        "oi_flow_feats": oi_flow_feats,
        "technical_feats": technical_feats,
        "vix_feats": vix_feats,
        "dealer_hedging_feats": dealer_hedging_feats,
        "exhaustion_feats": exhaustion_feats,
        "intraday_time_feats": intraday_time_feats,
        "strike_rotation_feats": strike_rotation_feats,
        "premium_vwap_feats": premium_vwap_feats,
        "iv_velocity_feats": iv_velocity_feats,
        "max_pain_feats": max_pain_feats,
        "event_calendar_feats": event_calendar_feats,
    }
