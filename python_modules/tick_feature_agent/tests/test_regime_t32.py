"""
tests/test_regime_t32.py — V2_MASTER_SPEC §2.8 D4 upgrade.

Covers what the pre-T32 ``test_regime.py`` doesn't:
  * TREND_STRONG tier fires only when ADX(14)≥30 alongside TREND signals.
  * NaN ADX degrades gracefully to TREND (no TREND_STRONG label).
  * RegimeClassifier wrapper accepts the first valid reading immediately.
  * Confirmed regime does NOT change until a candidate sustains for
    ``sustain_sec``.
  * Benign degradation: None instantaneous reading does not reset state.
  * reset() clears all state for session_start / rollover.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from tick_feature_agent.buffers.tick_buffer import CircularBuffer, UnderlyingTick
from tick_feature_agent.features.regime import (
    RegimeClassifier,
    compute_regime_features,
)


def _make_buffer_with_trend(maxlen: int = 50, n_ticks: int = 30) -> CircularBuffer:
    """Buffer of 30 ticks with a +1 pt/sec uptrend — picks up momentum
    signal cleanly. Bid/ask/volume are placeholders the regime function
    ignores."""
    buf = CircularBuffer(maxlen=maxlen)
    for i in range(n_ticks):
        buf.push(UnderlyingTick(
            timestamp=float(i),
            ltp=25_000.0 + float(i),
            bid=24_999.0 + float(i),
            ask=25_001.0 + float(i),
            volume=i * 100,
        ))
    return buf


# ── compute_regime_features TREND_STRONG tier ───────────────────────────────


def test_trend_strong_fires_when_adx_above_threshold():
    """Strong TREND signals + ADX 35 -> TREND_STRONG."""
    buf = _make_buffer_with_trend()
    out = compute_regime_features(
        buffer=buf,
        volatility_compression=1.2,   # > trend_volatility_min (0.8)
        tick_imbalance_20=0.6,        # > trend_imbalance_min (0.3)
        active_strike_count=8,        # s_activity = min(8/4, 1) = 1.0 > trend_activity_min (0.5)
        vol_diff_available=True,
        adx_5min=35.0,
    )
    assert out["regime"] == "TREND_STRONG"
    assert out["regime_confidence"] > 0.5


def test_trend_strong_falls_back_to_trend_below_adx_threshold():
    """Same TREND signals but ADX 25 -> regular TREND (not strong)."""
    buf = _make_buffer_with_trend()
    out = compute_regime_features(
        buffer=buf,
        volatility_compression=1.2,
        tick_imbalance_20=0.6,
        active_strike_count=8,
        vol_diff_available=True,
        adx_5min=25.0,
    )
    assert out["regime"] == "TREND"


def test_trend_strong_falls_back_to_trend_on_nan_adx():
    """ADX NaN (e.g. <14 5-min bars yet) -> graceful TREND fallback."""
    buf = _make_buffer_with_trend()
    out = compute_regime_features(
        buffer=buf,
        volatility_compression=1.2,
        tick_imbalance_20=0.6,
        active_strike_count=8,
        vol_diff_available=True,
        # adx_5min default NaN
    )
    assert out["regime"] == "TREND"


def test_trend_strong_threshold_inclusive():
    """ADX exactly 30 (the default min) qualifies as TREND_STRONG."""
    buf = _make_buffer_with_trend()
    out = compute_regime_features(
        buffer=buf,
        volatility_compression=1.2,
        tick_imbalance_20=0.6,
        active_strike_count=8,
        vol_diff_available=True,
        adx_5min=30.0,
    )
    assert out["regime"] == "TREND_STRONG"


def test_trend_strong_ignored_when_trend_conditions_fail():
    """High ADX but weak volatility_compression -> doesn't qualify
    as TREND, so TREND_STRONG also can't fire."""
    buf = _make_buffer_with_trend()
    out = compute_regime_features(
        buffer=buf,
        volatility_compression=0.4,   # below trend_volatility_min
        tick_imbalance_20=0.6,
        active_strike_count=8,
        vol_diff_available=True,
        adx_5min=50.0,
    )
    assert out["regime"] in ("RANGE", "NEUTRAL", "TREND")
    assert out["regime"] != "TREND_STRONG"


# ── RegimeClassifier sustain wrapper ────────────────────────────────────────


def _trend_strong_inputs(buf: CircularBuffer, adx: float = 35.0) -> dict:
    return dict(
        buffer=buf, volatility_compression=1.2, tick_imbalance_20=0.6,
        active_strike_count=8, vol_diff_available=True, adx_5min=adx,
    )


def _trend_inputs(buf: CircularBuffer) -> dict:
    return dict(
        buffer=buf, volatility_compression=1.2, tick_imbalance_20=0.6,
        active_strike_count=8, vol_diff_available=True, adx_5min=25.0,
    )


def _range_inputs(buf: CircularBuffer) -> dict:
    """Construct signals that produce RANGE (low vol, low imbalance, modest activity)."""
    return dict(
        buffer=buf, volatility_compression=0.2,
        tick_imbalance_20=0.1, active_strike_count=2,
        vol_diff_available=True, adx_5min=10.0,
    )


def test_classifier_accepts_first_valid_reading_immediately():
    clf = RegimeClassifier(sustain_sec=300.0)
    buf = _make_buffer_with_trend()
    out = clf.update(now_ts=0.0, **_trend_strong_inputs(buf))
    assert out["regime"] == "TREND_STRONG"
    assert clf.confirmed_regime == "TREND_STRONG"


def test_classifier_holds_confirmed_until_window_majority(monkeypatch):
    """RANGE candidate must accumulate ≥70% of the rolling window AND
    the window must hold ≥min_window_ticks before promotion. T32-FU1
    swapped consecutive-hold for rolling-majority sustain (2026-06-13).
    """
    clf = RegimeClassifier(sustain_sec=300.0, min_window_ticks=10)
    buf = _make_buffer_with_trend()

    # Confirmed: TREND_STRONG at t=0.
    clf.update(now_ts=0.0, **_trend_strong_inputs(buf))
    assert clf.confirmed_regime == "TREND_STRONG"

    # Send 5 RANGE readings — window now has 6 entries (1 TS + 5 RANGE).
    # 5/6 = 83% >= 70% but window_n=6 < min_window_ticks=10 → no flip.
    for i in range(1, 6):
        out = clf.update(now_ts=float(i * 10), **_range_inputs(buf))
        assert out["regime"] == "TREND_STRONG", f"flipped too early at i={i}"

    # 6th RANGE reading: window=[TS, R×6] → 7 entries, RANGE=6/7=86%
    # but window_n=7 still <10 → no flip.
    out = clf.update(now_ts=60.0, **_range_inputs(buf))
    assert out["regime"] == "TREND_STRONG"

    # 9th RANGE reading: window has 10 entries (1 TS + 9 RANGE).
    # RANGE 9/10 = 90% >= 70%, window_n=10 >= min — PROMOTE.
    for i in range(7, 10):
        clf.update(now_ts=float(i * 10), **_range_inputs(buf))
    assert clf.confirmed_regime == "RANGE"


def test_classifier_brief_excursion_does_not_promote():
    """A short flap to RANGE that doesn't reach majority must NOT
    flip the confirmed regime — even though the old consecutive-hold
    logic would have started a candidate timer immediately.
    """
    clf = RegimeClassifier(sustain_sec=300.0, min_window_ticks=10)
    buf = _make_buffer_with_trend()
    clf.update(now_ts=0.0, **_trend_strong_inputs(buf))

    # Send 2 RANGE then back to TREND_STRONG, repeat. Each round
    # only 2 out of 4 entries are non-confirmed → 50% share, below
    # 70% threshold → no promotion regardless of how long this goes.
    for round_idx in range(10):
        t = 10.0 * round_idx * 4
        clf.update(now_ts=t + 0,  **_range_inputs(buf))
        clf.update(now_ts=t + 10, **_range_inputs(buf))
        clf.update(now_ts=t + 20, **_trend_strong_inputs(buf))
        clf.update(now_ts=t + 30, **_trend_strong_inputs(buf))
    # Confirmed must still be TREND_STRONG.
    assert clf.confirmed_regime == "TREND_STRONG"


def test_classifier_flapping_majority_eventually_flips():
    """Regression test for the bug T32-FU1 fixes: when the instant
    classification flaps but RANGE dominates (e.g. 8 RANGE for every
    1 TREND), the rolling majority must eventually promote RANGE.

    The pre-T32-FU1 consecutive-hold logic would never flip in this
    scenario because the single TREND tick reset the candidate timer
    every time — producing the always-one-regime parquets the
    validator WARNed on.
    """
    clf = RegimeClassifier(sustain_sec=300.0, min_window_ticks=10)
    buf = _make_buffer_with_trend()
    clf.update(now_ts=0.0, **_trend_strong_inputs(buf))

    # Simulate 50 ticks where RANGE wins 8-out-of-9 — even with the
    # constant TREND_STRONG interruptions the candidate timer would
    # have reset, the rolling majority should promote RANGE.
    for i in range(1, 51):
        t = float(i * 10)
        if i % 9 == 0:
            clf.update(now_ts=t, **_trend_strong_inputs(buf))
        else:
            clf.update(now_ts=t, **_range_inputs(buf))
    assert clf.confirmed_regime == "RANGE", (
        "rolling majority must promote RANGE under flapping data — "
        "this is the bug T32-FU1 specifically fixes"
    )


def test_classifier_old_entries_fall_out_of_window():
    """Entries older than sustain_sec must drop from the window so a
    burst of past-tick activity can't keep a confirmed regime alive
    indefinitely.
    """
    clf = RegimeClassifier(sustain_sec=300.0, min_window_ticks=10)
    buf = _make_buffer_with_trend()
    # Seed: TREND_STRONG at t=0.
    clf.update(now_ts=0.0, **_trend_strong_inputs(buf))
    # Burst of TREND_STRONG readings far in the past relative to the
    # eventual RANGE majority.
    for i in range(1, 21):
        clf.update(now_ts=float(i), **_trend_strong_inputs(buf))
    # Now jump ahead 600 seconds (well past sustain_sec=300) and send
    # only RANGE readings. The old TREND entries must age out so RANGE
    # can dominate.
    for i in range(15):
        clf.update(now_ts=600.0 + i * 10, **_range_inputs(buf))
    assert clf.confirmed_regime == "RANGE"


def test_classifier_benign_degradation_none_keeps_confirmed():
    """A None instantaneous reading (warmup / missing inputs) must not
    flip confirmed nor start a candidate."""
    clf = RegimeClassifier(sustain_sec=300.0)
    buf = _make_buffer_with_trend()
    clf.update(now_ts=0.0, **_trend_strong_inputs(buf))
    assert clf.confirmed_regime == "TREND_STRONG"

    # WARMING_UP forces compute_regime_features to return None.
    out = clf.update(
        now_ts=10.0, buffer=buf,
        volatility_compression=1.2, tick_imbalance_20=0.6,
        active_strike_count=8, vol_diff_available=True,
        trading_state="WARMING_UP",
        adx_5min=35.0,
    )
    assert out["regime"] == "TREND_STRONG"
    assert clf.candidate_regime is None


def test_classifier_reset_clears_state():
    clf = RegimeClassifier(sustain_sec=300.0)
    buf = _make_buffer_with_trend()
    clf.update(now_ts=0.0, **_trend_strong_inputs(buf))
    assert clf.confirmed_regime == "TREND_STRONG"

    clf.reset()
    assert clf.confirmed_regime is None
    assert clf.candidate_regime is None
    assert math.isnan(clf.confirmed_confidence)


def test_classifier_initial_none_stays_none_until_valid_reading():
    """Before the underlying buffer fills, instant is None; the
    classifier must stay None until first valid classification."""
    clf = RegimeClassifier(sustain_sec=300.0)
    # Buffer too short -> compute returns None.
    buf = CircularBuffer(maxlen=50)
    for i in range(5):  # < 20 ticks
        buf.push(UnderlyingTick(
            timestamp=float(i), ltp=25_000.0, bid=24_999.0,
            ask=25_001.0, volume=0,
        ))
    out = clf.update(now_ts=0.0, **_trend_strong_inputs(buf))
    assert out["regime"] is None
    assert clf.confirmed_regime is None

    # Now valid:
    full_buf = _make_buffer_with_trend()
    out = clf.update(now_ts=1.0, **_trend_strong_inputs(full_buf))
    assert out["regime"] == "TREND_STRONG"
