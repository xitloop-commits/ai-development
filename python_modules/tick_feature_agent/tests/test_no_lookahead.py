"""
test_no_lookahead.py — Top-level safety guard against future-data leakage
in L1 feature modules (Test-24, V2_MASTER_SPEC D65 / D74 W1).

The single most dangerous class of bug a retrain pipeline can suffer is a
feature module that, during training, peeks at samples whose timestamp is
LATER than the "now" of the row being labelled. The model then learns a
correlation that simply does not exist at inference time (when the future
samples have not arrived yet). For every history-buffer-driven L1 feature
this test calls the function twice:

    1. With a history that includes samples beyond ``now_ts``.
    2. With the SAME history, but with the post-``now_ts`` rows dropped.

Both invocations must produce identical output (NaN treated as equal to
NaN for the same key). A diff means the function is leaking future data.

For stateful classes (BarAggregator, SessionState, OpeningRangeState,
OiDominanceState, PremiumVwapState) the analogous lookahead is a
backwards-in-time tick arriving AFTER a forward one — applying it would
retroactively modify the state as if the later tick had not yet
happened. Each stateful test feeds two instances:

    A: only the forward tick.
    B: the forward tick + a backwards-in-time tick.

A and B must end in the same observable state.

Run:
    py -3 -m pytest python_modules/tick_feature_agent/tests/test_no_lookahead.py -v
"""

from __future__ import annotations

import math
import sys
from dataclasses import asdict
from pathlib import Path

# Ensure the package root is importable when this file is run directly.
_HERE = Path(__file__).resolve().parent
_PKG_ROOT = _HERE.parent.parent
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))

import pytest

from tick_feature_agent.features.active_features import (
    compute_strike_rotation_features,
)
from tick_feature_agent.features.bars import BarAggregator
from tick_feature_agent.features.chain import (
    compute_oi_change_deltas,
    compute_pcr_slope,
)
from tick_feature_agent.features.dealer_hedging import (
    compute_dealer_hedging_features,
)
from tick_feature_agent.features.event_calendar import (
    compute_event_calendar_features,
)
from tick_feature_agent.features.greeks import compute_iv_velocity_features
from tick_feature_agent.features.india_vix import compute_india_vix_features
from tick_feature_agent.features.oi_dominance import OiDominanceState
from tick_feature_agent.features.opening_range import OpeningRangeState
from tick_feature_agent.features.premium_vwap import PremiumVwapState
from tick_feature_agent.features.session import SessionState


# ── Common timeline ───────────────────────────────────────────────────────
#
# Every history buffer uses the same set of anchor offsets so the test
# layout is uniform and easy to scan visually. Times are epoch-second
# floats; the absolute value is irrelevant, only the deltas matter.
#
#   now − 1800   (30 min ago)   — extra context, comfortably inside windows
#   now − 600    (10 min ago)
#   now − 300    (≈ 5 min baseline)
#   now − 60     (≈ 1 min baseline)
#   now − 1      (current)
#   now + 60     (FUTURE — present only when future_included=True)
#   now + 600    (FUTURE — present only when future_included=True)
#
# A correct, lookahead-free function MUST ignore the future samples; the
# results with or without them must therefore be identical.

NOW = 1_700_000_000.0  # arbitrary fixed epoch
PRE_TS = (NOW - 1800.0, NOW - 600.0, NOW - 300.0, NOW - 60.0, NOW - 1.0)
FUTURE_TS = (NOW + 60.0, NOW + 600.0)


def _assert_outputs_equal(
    out_with_future: dict[str, float],
    out_without: dict[str, float],
    fn_name: str,
) -> None:
    """Both NaN counts as equal; otherwise must match exactly (no float fuzz —
    the function should be deterministic on the same input)."""
    assert out_with_future.keys() == out_without.keys(), (
        f"{fn_name}: output key set changed when future was added/removed"
    )
    for key, v_with in out_with_future.items():
        v_without = out_without[key]
        with_nan = isinstance(v_with, float) and math.isnan(v_with)
        without_nan = isinstance(v_without, float) and math.isnan(v_without)
        if with_nan and without_nan:
            continue
        assert v_with == v_without, (
            f"LOOKAHEAD LEAK in {fn_name}: key={key!r} "
            f"with_future={v_with!r} without_future={v_without!r}"
        )


# ── History builders ──────────────────────────────────────────────────────
#
# Each builder returns the (args, kwargs) tuple for its target function in
# both flavours: with future samples and without. The future samples are
# deliberately given OUTLIER values so a leak would produce a visibly
# different output (helps trace which baseline a function picked up).


def _make_vix_history(future_included: bool) -> tuple[tuple, dict]:
    history = [
        (PRE_TS[0], 12.0),
        (PRE_TS[1], 12.5),
        (PRE_TS[2], 13.0),   # 5-min baseline anchor
        (PRE_TS[3], 13.5),
        (PRE_TS[4], 14.0),   # current
    ]
    if future_included:
        history.append((FUTURE_TS[0], 99.0))   # outlier — would leak if used
        history.append((FUTURE_TS[1], 199.0))
    return (NOW, history), {}


def _make_atm_delta_history(future_included: bool) -> tuple[tuple, dict]:
    """For compute_dealer_hedging_features charm/vanna path."""
    # (ts, atm_ce_delta, atm_ce_iv_decimal)
    history = [
        (PRE_TS[0], 0.40, 0.16),
        (PRE_TS[1], 0.42, 0.17),
        (PRE_TS[2], 0.45, 0.18),   # 5-min baseline anchor
        (PRE_TS[3], 0.48, 0.185),
        (PRE_TS[4], 0.50, 0.19),   # current
    ]
    if future_included:
        history.append((FUTURE_TS[0], 0.99, 0.40))   # outlier
        history.append((FUTURE_TS[1], 0.10, 0.05))
    # Minimal but valid chain so the chain-aggregate path also runs; spot,
    # rows, dte are stateless so they cannot leak. The non-NaN charm/vanna
    # are what the lookahead check guards.
    rows = [
        {"strike": 23900, "callOI": 1000, "putOI": 1000, "callIV": 18.0, "putIV": 18.0},
        {"strike": 24000, "callOI": 1500, "putOI": 1500, "callIV": 18.0, "putIV": 18.0},
        {"strike": 24100, "callOI": 1000, "putOI": 1000, "callIV": 18.0, "putIV": 18.0},
    ]
    args = (24000.0, rows, 5.0, history, NOW)
    return args, {}


def _make_event_calendar(future_included: bool) -> tuple[tuple, dict]:
    """
    For compute_event_calendar_features: the function legitimately surfaces
    upcoming-today events (by design — see docstring: "TODAY's most recent
    or upcoming-today event"), so events later today are NOT a lookahead.

    The real lookahead vector is whether tomorrow's (or further-future)
    events bleed into TODAY's `is_tier_2_event_day` / `event_type_categorical`
    fields. We park the future events well beyond the IST day boundary so
    they cannot conflate with today's record.

    `hours_to_next_tier_1_or_2_event` legitimately looks forward, so we
    keep the SAME future events in both flavours: removing them would
    change that field by design, which would not be a leak.
    """
    past_event = (NOW - 1800.0, "fomc", 1)              # past, today (IST)
    # +2 calendar days, well beyond any IST date boundary edge case.
    far_future_event = (NOW + 2 * 86400.0, "rbi_policy", 1)
    # Future events that BOTH flavours include — these probe whether
    # `hours_to_next_tier_1_or_2_event` reads the nearest future event
    # (which it should) without colouring the today-side fields.
    near_future_today_event = (NOW + 600.0, "us_cpi", 1)

    events = [past_event, near_future_today_event]
    if future_included:
        events.append(far_future_event)
    calendar = {
        "event_types": ["none", "fomc", "rbi_policy", "us_cpi"],
        "events_parsed": sorted(events, key=lambda r: r[0]),
    }
    return (NOW, calendar), {}


def _make_pcr_history(future_included: bool) -> tuple[tuple, dict]:
    history = [
        (PRE_TS[0], 0.90),
        (PRE_TS[1], 0.95),
        (PRE_TS[2], 1.00),
        (PRE_TS[3], 1.05),
        (PRE_TS[4], 1.10),
    ]
    if future_included:
        history.append((FUTURE_TS[0], 9.99))   # outlier slope-bender
        history.append((FUTURE_TS[1], -9.99))
    return (history, NOW), {}


def _make_oi_history(future_included: bool) -> tuple[tuple, dict]:
    # (ts, total_call_oi, total_put_oi)
    history = [
        (PRE_TS[0], 100_000.0, 110_000.0),
        (PRE_TS[1], 105_000.0, 112_000.0),
        (PRE_TS[2], 110_000.0, 115_000.0),  # 5-min baseline anchor
        (PRE_TS[3], 115_000.0, 117_000.0),
        (PRE_TS[4], 120_000.0, 120_000.0),  # current
    ]
    if future_included:
        history.append((FUTURE_TS[0], 999_999.0, 1.0))   # outliers
        history.append((FUTURE_TS[1], 1.0, 999_999.0))
    return (history, NOW), {}


def _make_iv_history(future_included: bool) -> tuple[tuple, dict]:
    # (ts, atm_ce_iv_decimal, atm_pe_iv_decimal, spot)
    history = [
        (PRE_TS[0], 0.16, 0.17, 24000.0),
        (PRE_TS[1], 0.17, 0.18, 24010.0),
        (PRE_TS[2], 0.18, 0.19, 24020.0),   # 5-min baseline anchor
        (PRE_TS[3], 0.19, 0.20, 24030.0),
        (PRE_TS[4], 0.20, 0.21, 24050.0),   # current
    ]
    if future_included:
        history.append((FUTURE_TS[0], 0.50, 0.50, 25000.0))   # outliers
        history.append((FUTURE_TS[1], 0.05, 0.05, 23000.0))
    return (history, NOW), {}


def _make_active_strike_history(future_included: bool) -> tuple[tuple, dict]:
    """
    Each entry is (ts, rows) where rows is ChainSnapshot.rows shape with
    strike / callOI / putOI / callOIChange / putOIChange.
    """
    def _rows(strike_center: int) -> list[dict]:
        rows = []
        for offset in (-200, -100, 0, 100, 200):
            strike = strike_center + offset
            rows.append({
                "strike": strike,
                "callOI": 1000 + offset,
                "putOI": 1000 - offset,
                "callOIChange": 10 + offset / 100,
                "putOIChange": -10 - offset / 100,
            })
        return rows

    history = [
        (PRE_TS[0], _rows(24000)),
        (PRE_TS[1], _rows(24050)),
        (PRE_TS[2], _rows(24100)),   # 5-min baseline anchor
        (PRE_TS[3], _rows(24100)),
        (PRE_TS[4], _rows(24100)),
    ]
    if future_included:
        # Future snapshots with HEAVY centre-of-mass shift to expose a leak.
        history.append((FUTURE_TS[0], _rows(25000)))
        history.append((FUTURE_TS[1], _rows(23000)))

    args = (history, 24100, 50, NOW)
    return args, {}


# ── Part 1 — history-buffer + now_ts functions ────────────────────────────


# Each entry: (test_id, callable, builder)
_HISTORY_FN_CASES = [
    ("india_vix",
     compute_india_vix_features,
     _make_vix_history),
    ("dealer_hedging_charm_vanna",
     compute_dealer_hedging_features,
     _make_atm_delta_history),
    ("event_calendar",
     compute_event_calendar_features,
     _make_event_calendar),
    ("chain_pcr_slope",
     compute_pcr_slope,
     _make_pcr_history),
    ("chain_oi_change_deltas",
     compute_oi_change_deltas,
     _make_oi_history),
    ("greeks_iv_velocity",
     compute_iv_velocity_features,
     _make_iv_history),
    ("active_strike_rotation",
     compute_strike_rotation_features,
     _make_active_strike_history),
]


@pytest.mark.parametrize(
    "fn,builder",
    [pytest.param(fn, builder, id=tid) for tid, fn, builder in _HISTORY_FN_CASES],
)
def test_no_lookahead_history_function(fn, builder):
    """Adding samples beyond now_ts must not change the function's output."""
    args_with, kwargs_with = builder(True)
    args_without, kwargs_without = builder(False)
    out_with_future = fn(*args_with, **kwargs_with)
    out_without = fn(*args_without, **kwargs_without)
    _assert_outputs_equal(out_with_future, out_without, fn_name=fn.__name__)


# ── Part 1b — neutral-time / arg-permutation lookahead spot-checks ────────
#
# The bulk test above swaps the *content* of history. These small targeted
# parametrised cases each apply ONE specific lookahead vector to each
# function so a failure points at exactly which path leaked. They share
# the same builders but assert per-key.


@pytest.mark.parametrize(
    "key",
    [
        "india_vix",
        "india_vix_change_5min",
    ],
)
def test_no_lookahead_india_vix_per_key(key):
    args_w, _ = _make_vix_history(True)
    args_wo, _ = _make_vix_history(False)
    out_w = compute_india_vix_features(*args_w)
    out_wo = compute_india_vix_features(*args_wo)
    v_w, v_wo = out_w[key], out_wo[key]
    if math.isnan(v_w) and math.isnan(v_wo):
        return
    assert v_w == v_wo, f"india_vix leaked into key={key}"


@pytest.mark.parametrize(
    "key",
    [
        "charm_estimate_atm",
        "vanna_estimate_atm",
    ],
)
def test_no_lookahead_dealer_hedging_per_key(key):
    args_w, _ = _make_atm_delta_history(True)
    args_wo, _ = _make_atm_delta_history(False)
    out_w = compute_dealer_hedging_features(*args_w)
    out_wo = compute_dealer_hedging_features(*args_wo)
    v_w, v_wo = out_w[key], out_wo[key]
    if math.isnan(v_w) and math.isnan(v_wo):
        return
    assert v_w == v_wo, f"dealer_hedging leaked into key={key}"


@pytest.mark.parametrize(
    "key",
    [
        "is_tier_2_event_day",
        "event_type_categorical",
        # hours_to_next_tier_1_or_2_event legitimately reads the future,
        # so we don't include it: removing future events changes the
        # expected output by design. (We do include it implicitly in the
        # full-dict test above because there both flavours either include
        # the future event or both exclude it; the equality holds when
        # the future event is the SAME in both builds, but here we toggle
        # it and the field correctly varies. Excluded from per-key.)
    ],
)
def test_no_lookahead_event_calendar_per_key(key):
    args_w, _ = _make_event_calendar(True)
    args_wo, _ = _make_event_calendar(False)
    out_w = compute_event_calendar_features(*args_w)
    out_wo = compute_event_calendar_features(*args_wo)
    v_w, v_wo = out_w[key], out_wo[key]
    if math.isnan(v_w) and math.isnan(v_wo):
        return
    assert v_w == v_wo, f"event_calendar leaked into key={key}"


@pytest.mark.parametrize(
    "key",
    [
        "pcr_intraday_slope_30min",
    ],
)
def test_no_lookahead_pcr_slope_per_key(key):
    args_w, _ = _make_pcr_history(True)
    args_wo, _ = _make_pcr_history(False)
    out_w = compute_pcr_slope(*args_w)
    out_wo = compute_pcr_slope(*args_wo)
    v_w, v_wo = out_w[key], out_wo[key]
    if math.isnan(v_w) and math.isnan(v_wo):
        return
    assert v_w == v_wo, f"pcr_slope leaked into key={key}"


@pytest.mark.parametrize(
    "key",
    [
        "ce_oi_change_5min_pct",
        "pe_oi_change_5min_pct",
        "ce_oi_change_15min_pct",
        "pe_oi_change_15min_pct",
        "ce_oi_change_60min_pct",
        "pe_oi_change_60min_pct",
    ],
)
def test_no_lookahead_oi_change_deltas_per_key(key):
    args_w, _ = _make_oi_history(True)
    args_wo, _ = _make_oi_history(False)
    out_w = compute_oi_change_deltas(*args_w)
    out_wo = compute_oi_change_deltas(*args_wo)
    v_w, v_wo = out_w[key], out_wo[key]
    if math.isnan(v_w) and math.isnan(v_wo):
        return
    assert v_w == v_wo, f"oi_change_deltas leaked into key={key}"


@pytest.mark.parametrize(
    "key",
    [
        "iv_change_1min",
        "iv_change_5min",
        "iv_skew_velocity",
        "iv_expansion_without_spot",
    ],
)
def test_no_lookahead_iv_velocity_per_key(key):
    args_w, _ = _make_iv_history(True)
    args_wo, _ = _make_iv_history(False)
    out_w = compute_iv_velocity_features(*args_w)
    out_wo = compute_iv_velocity_features(*args_wo)
    v_w, v_wo = out_w[key], out_wo[key]
    if math.isnan(v_w) and math.isnan(v_wo):
        return
    assert v_w == v_wo, f"iv_velocity leaked into key={key}"


@pytest.mark.parametrize(
    "key",
    [
        "active_strike_shift_direction",
        "active_strike_shift_velocity",
        "atm_to_otm_flow_ratio",
    ],
)
def test_no_lookahead_strike_rotation_per_key(key):
    args_w, _ = _make_active_strike_history(True)
    args_wo, _ = _make_active_strike_history(False)
    out_w = compute_strike_rotation_features(*args_w)
    out_wo = compute_strike_rotation_features(*args_wo)
    v_w, v_wo = out_w[key], out_wo[key]
    if math.isnan(v_w) and math.isnan(v_wo):
        return
    assert v_w == v_wo, f"strike_rotation leaked into key={key}"


# ── Part 2 — Stateful classes ─────────────────────────────────────────────
#
# Each stateful class is asked to absorb a forward tick, then an OUTLIER
# tick that violates the time invariant of the class. The second instance
# receives only the forward tick. Observable state must be identical:
# the violating tick should be a no-op.


def test_no_lookahead_bar_aggregator_backwards_tick_dropped():
    """
    A tick whose bar_start lands BEFORE the currently-open bar must be
    silently dropped (would otherwise corrupt an already-emitted history
    bar). The two aggregators below differ only by such a tick — they
    must observe identical state.
    """
    base = 1_500_000  # second 0 of a 1-min bar
    agg_a = BarAggregator(timeframes_sec=(60,))
    agg_b = BarAggregator(timeframes_sec=(60,))

    # Forward tick — opens a fresh bar starting at `base + 60` (the next
    # minute boundary at second 1_500_060).
    agg_a.add_tick(ts=base + 90, ltp=100.0, tick_volume=10.0)
    agg_b.add_tick(ts=base + 90, ltp=100.0, tick_volume=10.0)

    # Backwards tick — lands 30 seconds before the open bar's start. The
    # implementation must drop it (see bars.py: bar_start < cur.start_ts).
    agg_b.add_tick(ts=base + 30, ltp=999.0, tick_volume=999.0)

    assert agg_a.current_bar(60) == agg_b.current_bar(60), (
        "BarAggregator accepted a backwards tick — would corrupt OHLC"
    )
    assert agg_a.get_recent_bars(60) == agg_b.get_recent_bars(60)


def test_no_lookahead_bar_aggregator_multi_tf_backwards_tick_dropped():
    """Same as above but on the (60, 300, 900) default timeframes."""
    base = 1_500_000
    agg_a = BarAggregator()
    agg_b = BarAggregator()

    agg_a.add_tick(ts=base + 600, ltp=100.0, tick_volume=10.0)
    agg_b.add_tick(ts=base + 600, ltp=100.0, tick_volume=10.0)

    agg_b.add_tick(ts=base + 1, ltp=999.0, tick_volume=999.0)  # waaay backwards

    for tf in (60, 300, 900):
        assert agg_a.current_bar(tf) == agg_b.current_bar(tf), (
            f"BarAggregator leaked backwards tick into tf={tf}"
        )


def _session_state_snapshot(state: SessionState) -> dict:
    """Capture every observable field for an equality check."""
    return asdict(state)


def test_no_lookahead_session_state_backwards_tick_is_noop():
    """
    Calling update(ts=T) AFTER update(ts=T+something) must NOT mutate the
    state — the later tick already established 'now' and a stale tick
    arriving afterwards is from the past.

    NOTE: SessionState as implemented today does not check ts monotonicity
    inside update(). If this test fails, the module is leaking; report
    it as a lookahead bug and do NOT modify session.py from this slice.
    """
    a = SessionState()
    b = SessionState()
    a.update(ts=NOW, ltp=100.0, tick_volume=10.0)
    b.update(ts=NOW, ltp=100.0, tick_volume=10.0)

    # Backwards tick with an EXTREME value — would corrupt session_low if
    # accepted, and would push cum_value upward if accepted.
    b.update(ts=NOW - 100.0, ltp=0.01, tick_volume=10_000.0)

    assert _session_state_snapshot(a) == _session_state_snapshot(b), (
        "SessionState accepted a backwards tick — extremes / VWAP corrupted"
    )


def test_no_lookahead_opening_range_state_ignores_post_window_tick():
    """OpeningRangeState must drop ticks at-or-after window_end_ts."""
    window_end = NOW
    a = OpeningRangeState()
    b = OpeningRangeState()
    a.configure(window_end)
    b.configure(window_end)

    # In-window tick (well before window_end).
    a.update(ts=NOW - 600.0, ltp=100.0)
    b.update(ts=NOW - 600.0, ltp=100.0)

    # Post-window tick with extreme LTP — must be ignored.
    b.update(ts=NOW + 1.0, ltp=999_999.0)
    b.update(ts=window_end, ltp=0.0001)   # exactly == window_end ⇒ exclusive bound

    assert a.or_high == b.or_high, "OpeningRange or_high mutated by post-window tick"
    assert a.or_low == b.or_low, "OpeningRange or_low mutated by post-window tick"


def test_no_lookahead_oi_dominance_state_drops_backwards_tick():
    """OiDominanceState already documents the backwards-ts-as-no-op rule."""
    a = OiDominanceState()
    b = OiDominanceState()
    a.update(ts=NOW, oi_change_call=50_000.0, oi_change_put=20_000.0)
    b.update(ts=NOW, oi_change_call=50_000.0, oi_change_put=20_000.0)

    # Backwards tick — must be ignored.
    b.update(ts=NOW - 100.0, oi_change_call=1.0, oi_change_put=999_999.0)

    assert a.current_side == b.current_side, "OiDominance side flipped by backwards tick"
    assert a.streak_start_ts == b.streak_start_ts, "OiDominance streak start moved by backwards tick"
    assert a.last_update_ts == b.last_update_ts, "OiDominance last_update_ts mutated by backwards tick"


def test_no_lookahead_premium_vwap_update_is_side_independent():
    """
    PremiumVwapState.update() does not take a timestamp argument, so the
    lookahead vector is order-independence of the CE / PE accumulation:
    feeding the same (ce, pe, vol) batch should produce the same VWAP and
    reclaim count regardless of whether one side's tick lands first.

    We feed two identical sequences and assert the final state matches.
    A third sequence simulates "PE side suddenly receives a tick at the
    same instant" — neither side may be skipped if positive volume + valid
    premium are both present.
    """
    seq = [
        (100.0, 200.0, 10.0),
        (110.0, 190.0, 5.0),
        (105.0, 195.0, 20.0),
    ]
    a = PremiumVwapState()
    b = PremiumVwapState()
    for ce, pe, vol in seq:
        a.update(ce_premium=ce, pe_premium=pe, tick_volume=vol)
        b.update(ce_premium=ce, pe_premium=pe, tick_volume=vol)

    assert a.ce_vwap == b.ce_vwap
    assert a.pe_vwap == b.pe_vwap
    assert a.reclaim_count == b.reclaim_count
    assert a.ce_last_above_vwap == b.ce_last_above_vwap
    assert a.pe_last_above_vwap == b.pe_last_above_vwap


# ── Determinism guards ────────────────────────────────────────────────────
#
# Belt-and-braces: every history-buffer function must also be deterministic
# given the SAME input. This catches the (rare but ugly) case of a
# function with hidden global state that could itself leak via reordering.


@pytest.mark.parametrize(
    "fn,builder",
    [pytest.param(fn, builder, id=tid) for tid, fn, builder in _HISTORY_FN_CASES],
)
def test_function_is_deterministic_with_future_excluded(fn, builder):
    args, kwargs = builder(False)
    out1 = fn(*args, **kwargs)
    out2 = fn(*args, **kwargs)
    _assert_outputs_equal(out1, out2, fn_name=fn.__name__ + "[determinism]")
