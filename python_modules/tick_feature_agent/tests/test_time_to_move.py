"""
tests/test_time_to_move.py — Unit tests for features/time_to_move.py
                              (§8.11 Time-to-Move Signals).

Run: python -m pytest python_modules/tick_feature_agent/tests/test_time_to_move.py -v
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.features.time_to_move import TimeToMoveState

# ── Helpers ───────────────────────────────────────────────────────────────────

_NAN = float("nan")


def _nan(v) -> bool:
    return isinstance(v, float) and math.isnan(v)


def _call(
    ttm: TimeToMoveState,
    ltp: float,
    prev_ltp: float | None,
    timestamp: float,
    velocity: float = _NAN,
    time_diff_sec: float = 1.0,
    regime: str | None = None,
    vol_compression: float = _NAN,
    zone_call: float = _NAN,
    zone_put: float = _NAN,
    dead_score: float = _NAN,
) -> dict:
    return ttm.compute(
        ltp=ltp,
        prev_ltp=prev_ltp,
        timestamp=timestamp,
        velocity=velocity,
        time_diff_sec=time_diff_sec,
        regime=regime,
        vol_compression=vol_compression,
        zone_call_pressure=zone_call,
        zone_put_pressure=zone_put,
        dead_market_score=dead_score,
    )


# ══════════════════════════════════════════════════════════════════════════════


class TestTimeToMoveFeatureKeys:

    def test_all_keys_present(self):
        ttm = TimeToMoveState()
        out = _call(ttm, 100.0, None, 1000.0)
        expected = {
            "time_since_last_big_move",
            "stagnation_duration_sec",
            "momentum_persistence_ticks",
            "breakout_readiness",
            "breakout_readiness_extended",
        }
        assert set(out.keys()) == expected

    def test_exactly_5_keys(self):
        ttm = TimeToMoveState()
        out = _call(ttm, 100.0, None, 1000.0)
        assert len(out) == 5


class TestTimeSinceLastBigMove:

    def test_nan_on_tick_1(self):
        ttm = TimeToMoveState()
        out = _call(ttm, 100.0, None, 1000.0, velocity=_NAN)
        assert _nan(out["time_since_last_big_move"])

    def test_nan_on_tick_2(self):
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0, velocity=_NAN)
        out = _call(ttm, 101.0, 100.0, 1001.0, velocity=1.0)
        assert _nan(out["time_since_last_big_move"])

    def test_nan_on_tick_3_if_no_big_move(self):
        """Tick 3 with velocity valid but no big move detected yet → NaN."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0, velocity=_NAN)
        _call(ttm, 101.0, 100.0, 1001.0, velocity=1.0)
        # velocity=0.5; median of [1.0] (1 tick) = 1.0; 0.5 < 2×1.0 → no big move
        out = _call(ttm, 101.5, 101.0, 1002.0, velocity=0.5)
        assert _nan(out["time_since_last_big_move"])

    def _setup_big_move(self, ttm) -> float:
        """
        Helper: push 3 small-velocity ticks + 1 big-velocity tick so that
        a big move fires.

        The big-move check includes the current velocity in the median
        computation (it's appended to history before the check). With 4 values
        [1, 1, 1, V], median = 1.0; V > 2.0 fires when V >= 2.01.
        Returns the timestamp of the big-move tick.
        """
        _call(ttm, 100.0, None, 1000.0, velocity=_NAN)  # tick 1 (no vel)
        _call(ttm, 100.1, 100.0, 1001.0, velocity=1.0)  # tick 2
        _call(ttm, 100.2, 100.1, 1002.0, velocity=1.0)  # tick 3
        _call(ttm, 100.3, 100.2, 1003.0, velocity=1.0)  # tick 4 (median=1.0)
        # Tick 5: velocity=5.0; history=[1,1,1,5], median=1.0; 5>2.0 → big move
        _call(ttm, 100.4, 100.3, 1004.0, velocity=5.0)  # fires big move at ts=1004
        return 1004.0

    def test_not_nan_after_first_big_move(self):
        """Once a big move fires, time_since_last_big_move becomes non-NaN."""
        ttm = TimeToMoveState()
        self._setup_big_move(ttm)
        # The last tick of _setup_big_move already fired a big move
        out = _call(ttm, 100.5, 100.4, 1005.0, velocity=0.5)
        assert not _nan(out["time_since_last_big_move"])

    def test_time_since_big_move_zero_when_just_fired(self):
        """When big move fires at ts=1004, time_since at that tick = 0."""
        ttm = TimeToMoveState()
        # Replicate _setup_big_move inline to check the firing tick output
        _call(ttm, 100.0, None, 1000.0, velocity=_NAN)
        _call(ttm, 100.1, 100.0, 1001.0, velocity=1.0)
        _call(ttm, 100.2, 100.1, 1002.0, velocity=1.0)
        _call(ttm, 100.3, 100.2, 1003.0, velocity=1.0)
        out = _call(ttm, 100.4, 100.3, 1004.0, velocity=5.0)  # fires at 1004
        assert out["time_since_last_big_move"] == pytest.approx(0.0)

    def test_time_since_big_move_accumulates(self):
        """After big move at ts=1004, next tick at ts=1008 → 4s elapsed."""
        ttm = TimeToMoveState()
        self._setup_big_move(ttm)  # fires big move at ts=1004
        out = _call(ttm, 100.5, 100.4, 1008.0, velocity=0.5)
        assert out["time_since_last_big_move"] == pytest.approx(4.0)


class TestStagnationDuration:

    def test_zero_on_tick_1(self):
        ttm = TimeToMoveState()
        out = _call(ttm, 100.0, None, 1000.0)
        assert out["stagnation_duration_sec"] == pytest.approx(0.0)

    def test_reset_on_large_move(self):
        """Price change > 0.1% LTP → stagnation resets to 0."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0, time_diff_sec=5.0)
        _call(ttm, 100.0, 100.0, 1005.0, time_diff_sec=5.0)  # flat: stag=5
        # 0.2% move → reset
        out = _call(ttm, 100.2, 100.0, 1010.0, time_diff_sec=5.0)
        assert out["stagnation_duration_sec"] == pytest.approx(0.0)

    def test_accumulates_on_flat_market(self):
        """Flat price (no 0.1% move) → stagnation accumulates time_diff each tick."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0, time_diff_sec=5.0)
        _call(ttm, 100.0, 100.0, 1005.0, time_diff_sec=5.0)  # stag=5
        out = _call(ttm, 100.0, 100.0, 1010.0, time_diff_sec=5.0)  # stag=10
        assert out["stagnation_duration_sec"] == pytest.approx(10.0)

    def test_capped_at_300s(self):
        """Stagnation is capped at 300s even if more time passes."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0, time_diff_sec=0.0)
        # push stagnation to 290s first
        _call(ttm, 100.0, 100.0, 1001.0, time_diff_sec=290.0)
        # 20 more seconds would exceed 300 cap
        out = _call(ttm, 100.0, 100.0, 1002.0, time_diff_sec=20.0)
        assert out["stagnation_duration_sec"] == pytest.approx(300.0)

    def test_small_moves_under_threshold_do_not_reset(self):
        """A 0.05% move (< 0.1% threshold) → stagnation continues."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0, time_diff_sec=5.0)
        _call(ttm, 100.0, 100.0, 1005.0, time_diff_sec=5.0)  # stag=5
        # 0.05% move — below threshold
        out = _call(ttm, 100.05, 100.0, 1010.0, time_diff_sec=5.0)
        assert out["stagnation_duration_sec"] == pytest.approx(10.0)


class TestMomentumPersistence:

    def test_one_on_tick_1(self):
        """Tick 1: no direction established, persistence = 1."""
        ttm = TimeToMoveState()
        out = _call(ttm, 100.0, None, 1000.0)
        assert out["momentum_persistence_ticks"] == 1

    def test_two_on_first_up_move(self):
        """Tick 2: first upward move → streak = 2 (includes tick 1)."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0)
        out = _call(ttm, 101.0, 100.0, 1001.0)
        assert out["momentum_persistence_ticks"] == 2

    def test_streak_increments_on_continuation(self):
        """Consecutive up moves → streak increments."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0)
        _call(ttm, 101.0, 100.0, 1001.0)  # streak=2
        _call(ttm, 102.0, 101.0, 1002.0)  # streak=3
        out = _call(ttm, 103.0, 102.0, 1003.0)  # streak=4
        assert out["momentum_persistence_ticks"] == 4

    def test_streak_resets_on_reversal(self):
        """Direction reversal → streak resets to 1."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0)
        _call(ttm, 101.0, 100.0, 1001.0)  # up, streak=2
        _call(ttm, 102.0, 101.0, 1002.0)  # up, streak=3
        out = _call(ttm, 101.5, 102.0, 1003.0)  # down: reversal, streak=1
        assert out["momentum_persistence_ticks"] == 1

    def test_flat_carries_forward_streak(self):
        """Flat tick (ltp == prev_ltp) carries forward the current streak."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0)
        _call(ttm, 101.0, 100.0, 1001.0)  # up, streak=2
        _call(ttm, 102.0, 101.0, 1002.0)  # up, streak=3
        out = _call(ttm, 102.0, 102.0, 1003.0)  # flat: keep streak=3
        assert out["momentum_persistence_ticks"] == 3

    def test_down_streak(self):
        """Consecutive down moves build a negative streak."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0)
        _call(ttm, 99.0, 100.0, 1001.0)  # down, streak=2
        out = _call(ttm, 98.0, 99.0, 1002.0)  # down, streak=3
        assert out["momentum_persistence_ticks"] == 3


class TestBreakoutReadiness:

    def test_zero_by_default(self):
        ttm = TimeToMoveState()
        out = _call(ttm, 100.0, None, 1000.0)
        assert out["breakout_readiness"] == 0.0

    def test_zero_when_regime_not_range(self):
        """breakout_readiness only fires in RANGE regime."""
        ttm = TimeToMoveState()
        # Build up stagnation and momentum
        _call(ttm, 100.0, None, 1000.0)
        for i in range(1, 5):
            _call(ttm, 100.0 + i, 100.0 + i - 1, 1000.0 + i, time_diff_sec=3.0)
        out = _call(
            ttm,
            100.5,
            100.4,
            1005.0,
            time_diff_sec=3.0,
            regime="TREND",  # wrong regime
            vol_compression=0.2,
            zone_call=0.5,
            zone_put=0.4,
            dead_score=0.3,
        )
        assert out["breakout_readiness"] == 0.0

    def test_fires_when_all_conditions_met(self):
        """
        RANGE + compression < 0.4 + stagnation > 10s + persistence > 3 → 1.0.

        Use tiny increments (0.05 per tick = 0.05% of LTP) so each move is
        below the 0.1% stagnation-reset threshold. This lets stagnation
        accumulate while persistence also grows.
        """
        ttm = TimeToMoveState()
        ltp = 100.0
        prev_ltp = None
        ts = 1000.0
        # 15 tiny up ticks: each +0.05 (= 0.05% of ~100, below 0.1% threshold)
        # After 15 ticks × 1s each: stagnation ~15s > 10, streak ~15 > 3
        for _ in range(15):
            new_ltp = ltp + 0.05
            _call(ttm, new_ltp, prev_ltp, ts, time_diff_sec=1.0)
            prev_ltp = new_ltp
            ltp = new_ltp
            ts += 1.0
        out = _call(
            ttm, ltp, prev_ltp, ts, time_diff_sec=1.0, regime="RANGE", vol_compression=0.2
        )  # < 0.4 threshold
        assert out["breakout_readiness"] == 1.0

    def test_zero_when_compression_too_high(self):
        """vol_compression >= 0.4 → breakout_readiness = 0."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0)
        for _ in range(5):
            _call(ttm, 100.0, 100.0, 1001.0, time_diff_sec=3.0)
        for i in range(1, 5):
            _call(ttm, 100.0 + i, 100.0 + i - 1, 1016.0 + i)
        out = _call(
            ttm, 105.0, 104.0, 1021.0, regime="RANGE", vol_compression=0.5
        )  # >= 0.4 → no fire
        assert out["breakout_readiness"] == 0.0


class TestBreakoutReadinessExtended:

    def test_zero_by_default(self):
        ttm = TimeToMoveState()
        out = _call(ttm, 100.0, None, 1000.0)
        assert out["breakout_readiness_extended"] == 0.0

    def test_fires_when_all_conditions_met(self):
        """
        RANGE/NEUTRAL + compression < 0.4 + stagnation > 10 +
        max(zone_call, zone_put) > 0.3 + dead_score < 0.5 → 1.0.
        """
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0, time_diff_sec=0.0)
        for _ in range(4):
            _call(ttm, 100.0, 100.0, 1001.0, time_diff_sec=3.0)  # stag = 12s
        out = _call(
            ttm,
            100.0,
            100.0,
            1013.0,
            time_diff_sec=1.0,
            regime="NEUTRAL",
            vol_compression=0.2,
            zone_call=0.4,
            zone_put=0.2,  # max=0.4 > 0.3
            dead_score=0.3,
        )  # < 0.5
        assert out["breakout_readiness_extended"] == 1.0

    def test_fires_in_range_regime_too(self):
        """breakout_readiness_extended fires in both RANGE and NEUTRAL."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0, time_diff_sec=0.0)
        for _ in range(4):
            _call(ttm, 100.0, 100.0, 1001.0, time_diff_sec=3.0)
        out = _call(
            ttm,
            100.0,
            100.0,
            1013.0,
            time_diff_sec=1.0,
            regime="RANGE",
            vol_compression=0.2,
            zone_call=0.4,
            zone_put=0.2,
            dead_score=0.3,
        )
        assert out["breakout_readiness_extended"] == 1.0

    def test_zero_when_zone_pressure_too_low(self):
        """max(zone_call, zone_put) <= 0.3 → no fire."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0, time_diff_sec=0.0)
        for _ in range(4):
            _call(ttm, 100.0, 100.0, 1001.0, time_diff_sec=3.0)
        out = _call(
            ttm,
            100.0,
            100.0,
            1013.0,
            time_diff_sec=1.0,
            regime="RANGE",
            vol_compression=0.2,
            zone_call=0.2,
            zone_put=0.2,  # max=0.2 <= 0.3
            dead_score=0.3,
        )
        assert out["breakout_readiness_extended"] == 0.0

    def test_zero_when_dead_score_too_high(self):
        """dead_market_score >= 0.5 → no fire."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0, time_diff_sec=0.0)
        for _ in range(4):
            _call(ttm, 100.0, 100.0, 1001.0, time_diff_sec=3.0)
        out = _call(
            ttm,
            100.0,
            100.0,
            1013.0,
            time_diff_sec=1.0,
            regime="RANGE",
            vol_compression=0.2,
            zone_call=0.4,
            zone_put=0.2,
            dead_score=0.5,
        )  # >= 0.5 → no fire
        assert out["breakout_readiness_extended"] == 0.0

    def test_zero_when_zone_pressure_nan(self):
        """NaN zone pressure → guard fires → no fire."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0, time_diff_sec=0.0)
        for _ in range(4):
            _call(ttm, 100.0, 100.0, 1001.0, time_diff_sec=3.0)
        out = _call(
            ttm,
            100.0,
            100.0,
            1013.0,
            time_diff_sec=1.0,
            regime="RANGE",
            vol_compression=0.2,
            zone_call=float("nan"),
            zone_put=float("nan"),
            dead_score=0.3,
        )
        assert out["breakout_readiness_extended"] == 0.0


class TestReset:

    def test_reset_clears_tick_count(self):
        ttm = TimeToMoveState()
        for _ in range(5):
            _call(ttm, 100.0, 100.0, 1000.0)
        ttm.reset()
        assert ttm.tick_count == 0

    def test_reset_clears_stagnation(self):
        """After reset, first tick shows stagnation = 0 regardless of prior state."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0, time_diff_sec=0.0)
        for _ in range(3):
            _call(ttm, 100.0, 100.0, 1001.0, time_diff_sec=100.0)
        ttm.reset()
        out = _call(ttm, 100.0, None, 2000.0)
        assert out["stagnation_duration_sec"] == pytest.approx(0.0)

    def test_reset_clears_big_move_history(self):
        """After reset, time_since_last_big_move is NaN on first ticks."""
        ttm = TimeToMoveState()
        _call(ttm, 100.0, None, 1000.0, velocity=_NAN)
        _call(ttm, 101.0, 100.0, 1001.0, velocity=1.0)
        _call(ttm, 120.0, 101.0, 1002.0, velocity=50.0)  # big move
        ttm.reset()
        out = _call(ttm, 100.0, None, 2000.0, velocity=_NAN)
        assert _nan(out["time_since_last_big_move"])
