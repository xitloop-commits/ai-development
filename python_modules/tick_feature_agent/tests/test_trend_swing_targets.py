"""Tests for features/trend_swing_targets.py — Phase 3 trend + swing targets."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.trend_swing_targets import (
    BREAKOUT_SCALE,
    NOISE_FLOOR_PTS,
    SWING_HORIZONS_SEC,
    TREND_HORIZONS_SEC,
    SpotTargetBuffer,
    null_trend_swing_targets,
    trend_swing_target_column_names,
)


# ── Column-name helper ────────────────────────────────────────────────────


class TestColumnNames:

    def test_emits_28_names_in_default(self):
        # 7 types × 4 horizons = 28 (Part B added direction_down).
        names = trend_swing_target_column_names()
        assert len(names) == 28

    def test_names_are_unique(self):
        names = trend_swing_target_column_names()
        assert len(set(names)) == len(names)

    def test_layer_prefix_split(self):
        names = trend_swing_target_column_names()
        trend = [n for n in names if n.startswith("trend_")]
        swing = [n for n in names if n.startswith("swing_")]
        assert len(trend) == 14
        assert len(swing) == 14

    def test_horizon_coverage(self):
        names = set(trend_swing_target_column_names())
        # Seven types × four horizons (direction_down added in Part B).
        for w in (900, 1800):
            for t in ("direction", "direction_down", "magnitude",
                      "max_excursion", "max_drawdown", "continues",
                      "breakout_imminent"):
                assert f"trend_{t}_{w}s" in names
        for w in (3600, 7200):
            for t in ("direction", "direction_down", "magnitude",
                      "max_excursion", "max_drawdown", "continues",
                      "breakout_imminent"):
                assert f"swing_{t}_{w}s" in names


# ── Null helper ───────────────────────────────────────────────────────────


def test_null_targets_returns_28_nans():
    out = null_trend_swing_targets()
    assert len(out) == 28
    for v in out.values():
        assert math.isnan(v)


# ── Buffer lifecycle ──────────────────────────────────────────────────────


class TestBufferLifecycle:

    def test_default_retention_covers_swing_plus_lookback(self):
        buf = SpotTargetBuffer()
        # Retention must cover 7200s + 300s + small pad.
        assert buf._retention_sec >= 7200 + 300

    def test_push_rejects_non_finite(self):
        buf = SpotTargetBuffer()
        buf.push(float("nan"), 24000.0)
        buf.push(1_000_000.0, float("nan"))
        buf.push(None, 24000.0)  # type: ignore[arg-type]
        buf.push(1_000_000.0, 0.0)
        buf.push(1_000_000.0, -5.0)
        assert len(buf._entries) == 0

    def test_push_evicts_old_entries(self):
        buf = SpotTargetBuffer()
        buf.push(0.0, 24000.0)
        buf.push(50.0, 24010.0)
        # Push way in the future — both prior entries should evict.
        buf.push(100_000.0, 24050.0)
        assert len(buf._entries) == 1

    def test_reset_clears_buffer(self):
        buf = SpotTargetBuffer()
        buf.push(0.0, 24000.0)
        buf.push(60.0, 24010.0)
        buf.reset()
        assert len(buf._entries) == 0


# ── Compute: helpers ──────────────────────────────────────────────────────


def _seed(buf: SpotTargetBuffer, points: list[tuple[float, float]]) -> None:
    for ts, spot in points:
        buf.push(ts, spot)


def _compute(
    buf: SpotTargetBuffer,
    t0: float,
    spot_at_t0: float,
    *,
    instrument: str = "NIFTY",
    session_end: float | None = 1e12,
) -> dict[str, float]:
    return buf.compute_targets(
        t0=t0, spot_at_t0=spot_at_t0,
        instrument_name=instrument,
        session_end_sec=session_end,
    )


# ── direction / magnitude ─────────────────────────────────────────────────


class TestDirectionAndMagnitude:

    def test_direction_one_when_move_clears_noise_floor(self):
        buf = SpotTargetBuffer()
        # +20 pts over 15 min — well above NIFTY's 8 pt floor.
        _seed(buf, [(900.0, 24020.0)])
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_direction_900s"] == 1.0
        assert out["trend_magnitude_900s"] == pytest.approx(20.0)

    def test_direction_zero_when_move_below_noise_floor(self):
        buf = SpotTargetBuffer()
        # +3 pts — below NIFTY's 8 pt floor.
        _seed(buf, [(900.0, 24003.0)])
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_direction_900s"] == 0.0
        assert out["trend_magnitude_900s"] == pytest.approx(3.0)

    def test_direction_zero_when_move_is_negative(self):
        """direction targets are UP-only labels per spec (1 iff > +floor)."""
        buf = SpotTargetBuffer()
        _seed(buf, [(900.0, 23980.0)])  # -20 pts
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_direction_900s"] == 0.0
        assert out["trend_magnitude_900s"] == pytest.approx(-20.0)

    def test_unknown_instrument_yields_nan_direction(self):
        """Without a noise floor we can't label — direction stays NaN
        but magnitude (pure arithmetic) is still computed."""
        buf = SpotTargetBuffer()
        _seed(buf, [(900.0, 24020.0)])
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0, instrument="UNKNOWN")
        assert math.isnan(out["trend_direction_900s"])
        assert out["trend_magnitude_900s"] == pytest.approx(20.0)


class TestDirectionDown:
    """Part B: direction_down is the symmetric down-leg mirror of direction —
    1 iff spot fell more than the noise floor. The two are mutually exclusive
    (a move can't clear +floor and −floor at once)."""

    def test_down_one_when_move_clears_noise_floor_downward(self):
        buf = SpotTargetBuffer()
        _seed(buf, [(900.0, 23980.0)])  # -20 pts, below NIFTY's 8 pt floor
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_direction_down_900s"] == 1.0
        assert out["trend_direction_900s"] == 0.0  # not up

    def test_down_zero_when_move_is_up(self):
        buf = SpotTargetBuffer()
        _seed(buf, [(900.0, 24020.0)])  # +20 pts
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_direction_down_900s"] == 0.0
        assert out["trend_direction_900s"] == 1.0  # up

    def test_down_zero_when_move_within_noise_floor(self):
        buf = SpotTargetBuffer()
        _seed(buf, [(900.0, 23997.0)])  # -3 pts, inside the 8 pt floor
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_direction_down_900s"] == 0.0
        assert out["trend_direction_900s"] == 0.0  # flat → neither

    def test_unknown_instrument_yields_nan_down(self):
        buf = SpotTargetBuffer()
        _seed(buf, [(900.0, 23980.0)])
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0, instrument="UNKNOWN")
        assert math.isnan(out["trend_direction_down_900s"])


# ── max_excursion / max_drawdown ──────────────────────────────────────────


class TestExcursionAndDrawdown:

    def test_max_excursion_picks_peak_anywhere_in_window(self):
        buf = SpotTargetBuffer()
        # Spike to +50 at midpoint, then retrace to +5 by end.
        _seed(buf, [(300.0, 24050.0), (900.0, 24005.0)])
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_max_excursion_900s"] == pytest.approx(50.0)
        # Magnitude is end-of-window only.
        assert out["trend_magnitude_900s"] == pytest.approx(5.0)

    def test_max_drawdown_picks_trough_anywhere_in_window(self):
        buf = SpotTargetBuffer()
        _seed(buf, [(300.0, 23960.0), (900.0, 24010.0)])
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_max_drawdown_900s"] == pytest.approx(40.0)

    def test_flat_path_has_zero_excursion_and_drawdown(self):
        buf = SpotTargetBuffer()
        _seed(buf, [(300.0, 24000.0), (900.0, 24000.0)])
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_max_excursion_900s"] == pytest.approx(0.0)
        assert out["trend_max_drawdown_900s"] == pytest.approx(0.0)


# ── continues ─────────────────────────────────────────────────────────────


class TestContinues:

    def test_one_when_prior_uptrend_and_forward_continues_above_floor(self):
        buf = SpotTargetBuffer()
        # Prior: 5 min ago spot=23980, at t0=24000 → prior +20 pts up.
        # Forward: +25 pts over 15 min, well above 8 pt floor.
        _seed(buf, [(-300.0, 23980.0), (900.0, 24025.0)])
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_continues_900s"] == 1.0

    def test_zero_when_prior_down_and_forward_up(self):
        buf = SpotTargetBuffer()
        # Prior: down 20 pts. Forward: up 25 pts. Reversal, not continuation.
        _seed(buf, [(-300.0, 24020.0), (900.0, 24025.0)])
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_continues_900s"] == 0.0

    def test_zero_when_forward_below_noise_floor(self):
        buf = SpotTargetBuffer()
        # Prior up, forward up but only +3 pts — below 8 pt floor.
        _seed(buf, [(-300.0, 23980.0), (900.0, 24003.0)])
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_continues_900s"] == 0.0

    def test_nan_without_lookback_sample(self):
        """No lookback sample in [t0-300, t0] → continues can't be defined."""
        buf = SpotTargetBuffer()
        _seed(buf, [(900.0, 24025.0)])  # only forward, no lookback
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert math.isnan(out["trend_continues_900s"])


# ── breakout_imminent ─────────────────────────────────────────────────────


class TestBreakoutImminent:

    def test_one_when_excursion_clears_trend_scale(self):
        """trend scale = 3 → threshold = 8 × 3 = 24 pts for NIFTY."""
        buf = SpotTargetBuffer()
        _seed(buf, [(300.0, 24030.0), (900.0, 24010.0)])  # peak +30
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_breakout_imminent_900s"] == 1.0

    def test_zero_when_excursion_below_trend_scale(self):
        buf = SpotTargetBuffer()
        _seed(buf, [(300.0, 24015.0), (900.0, 24010.0)])  # peak +15 < 24
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["trend_breakout_imminent_900s"] == 0.0

    def test_swing_uses_six_times_scale(self):
        """swing scale = 6 → threshold = 8 × 6 = 48 pts for NIFTY."""
        buf = SpotTargetBuffer()
        # Peak +50 over 1 hr — clears swing's 48 pt threshold.
        _seed(buf, [(1800.0, 24050.0), (3600.0, 24010.0)])
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["swing_breakout_imminent_3600s"] == 1.0

    def test_swing_zero_at_just_below_six_times_scale(self):
        buf = SpotTargetBuffer()
        # Peak +40 over 1 hr — below swing's 48 pt threshold.
        _seed(buf, [(1800.0, 24040.0), (3600.0, 24010.0)])
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert out["swing_breakout_imminent_3600s"] == 0.0


# ── Session-end guard ─────────────────────────────────────────────────────


class TestSessionEndGuard:

    def test_all_targets_nan_when_horizon_passes_session_end(self):
        buf = SpotTargetBuffer()
        _seed(buf, [(900.0, 24020.0)])
        # session_end at t0 + 600 — 900s horizon would extend past it.
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0, session_end=600.0)
        for key in (
            "trend_direction_900s", "trend_magnitude_900s",
            "trend_max_excursion_900s", "trend_max_drawdown_900s",
            "trend_continues_900s", "trend_breakout_imminent_900s",
        ):
            assert math.isnan(out[key])

    def test_shorter_horizon_still_computes_when_longer_past_end(self):
        buf = SpotTargetBuffer()
        _seed(buf, [(900.0, 24020.0)])
        # session_end at 1500 — 900s OK, 1800s and beyond NaN.
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0, session_end=1500.0)
        assert math.isfinite(out["trend_direction_900s"])
        assert math.isnan(out["trend_direction_1800s"])
        assert math.isnan(out["swing_direction_3600s"])
        assert math.isnan(out["swing_direction_7200s"])


# ── No lookahead data ─────────────────────────────────────────────────────


class TestNoLookahead:

    def test_empty_buffer_all_targets_nan(self):
        buf = SpotTargetBuffer()
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        for v in out.values():
            assert math.isnan(v)

    def test_only_lookback_samples_targets_nan(self):
        """Spec: targets read FUTURE samples; past-only data → NaN."""
        buf = SpotTargetBuffer()
        _seed(buf, [(-120.0, 23990.0), (-30.0, 23999.0)])
        out = _compute(buf, t0=0.0, spot_at_t0=24000.0)
        assert math.isnan(out["trend_magnitude_900s"])

    def test_invalid_t0_or_spot_yields_full_nan_dict(self):
        buf = SpotTargetBuffer()
        _seed(buf, [(900.0, 24020.0)])
        out = _compute(buf, t0=float("nan"), spot_at_t0=24000.0)
        for v in out.values():
            assert math.isnan(v)
        out = _compute(buf, t0=0.0, spot_at_t0=-5.0)
        for v in out.values():
            assert math.isnan(v)


# ── Cross-instrument noise floor ──────────────────────────────────────────


class TestPerInstrumentNoiseFloor:

    def test_banknifty_uses_larger_floor(self):
        """Same +15 pt forward move: triggers NIFTY (>8) but not BANKNIFTY (<25)."""
        buf = SpotTargetBuffer()
        _seed(buf, [(900.0, 24015.0)])
        out_nifty = _compute(buf, t0=0.0, spot_at_t0=24000.0, instrument="NIFTY")
        out_bn = _compute(buf, t0=0.0, spot_at_t0=24000.0, instrument="BANKNIFTY")
        assert out_nifty["trend_direction_900s"] == 1.0
        assert out_bn["trend_direction_900s"] == 0.0

    def test_constants_match_locked_spec_values(self):
        """V2_MASTER_SPEC §7 locks these — drift detection."""
        assert NOISE_FLOOR_PTS["NIFTY"] == 8.0
        assert NOISE_FLOOR_PTS["BANKNIFTY"] == 25.0
        assert NOISE_FLOOR_PTS["CRUDEOIL"] == 5.0
        assert NOISE_FLOOR_PTS["NATURALGAS"] == 3.0
        assert BREAKOUT_SCALE["trend"] == 3.0
        assert BREAKOUT_SCALE["swing"] == 6.0
        assert TREND_HORIZONS_SEC == (900, 1800)
        assert SWING_HORIZONS_SEC == (3600, 7200)
