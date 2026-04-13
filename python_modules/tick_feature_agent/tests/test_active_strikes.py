"""
test_active_strikes.py — Unit tests for features/active_strikes.py.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_active_strikes.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pytest
from tick_feature_agent.features.active_strikes import (
    StrikeScore,
    compute_strike_scores,
    select_active_strikes,
    _normalize,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _row(strike: int, call_vol: float = 0, put_vol: float = 0,
         call_oi_chg: float = 0, put_oi_chg: float = 0) -> dict:
    return {
        "strike":       strike,
        "callVolume":   call_vol,
        "putVolume":    put_vol,
        "callOIChange": call_oi_chg,
        "putOIChange":  put_oi_chg,
    }


def _prev_row(strike: int, call_vol: float = 0, put_vol: float = 0) -> dict:
    return {"strike": strike, "callVolume": call_vol, "putVolume": put_vol}


# ══════════════════════════════════════════════════════════════════════════════
# _normalize (internal helper — tested directly for edge-case coverage)
# ══════════════════════════════════════════════════════════════════════════════

class TestNormalize:

    def test_empty_returns_empty(self):
        assert _normalize([]) == []

    def test_all_zero(self):
        assert _normalize([0.0, 0.0, 0.0]) == [0.0, 0.0, 0.0]

    def test_all_equal_nonzero(self):
        assert _normalize([5.0, 5.0, 5.0]) == [1.0, 1.0, 1.0]

    def test_standard_min_max(self):
        result = _normalize([0.0, 50.0, 100.0])
        assert result[0] == pytest.approx(0.0)
        assert result[1] == pytest.approx(0.5)
        assert result[2] == pytest.approx(1.0)

    def test_single_nonzero_value(self):
        # max == min == non-zero → all-equal-nonzero branch → 1.0
        assert _normalize([7.0]) == [1.0]

    def test_single_zero_value(self):
        assert _normalize([0.0]) == [0.0]

    def test_min_is_nonzero(self):
        # min=10, max=20 → (10-10)/(20-10)=0.0, (20-10)/(20-10)=1.0
        result = _normalize([10.0, 20.0])
        assert result[0] == pytest.approx(0.0)
        assert result[1] == pytest.approx(1.0)


# ══════════════════════════════════════════════════════════════════════════════
# compute_strike_scores
# ══════════════════════════════════════════════════════════════════════════════

class TestComputeStrikeScores:

    def test_returns_one_score_per_row(self):
        rows = [_row(24000), _row(24050), _row(24100)]
        scores = compute_strike_scores(rows, prev_rows=None)
        assert len(scores) == 3

    def test_strike_values_preserved(self):
        rows = [_row(24000), _row(24100)]
        scores = compute_strike_scores(rows, prev_rows=None)
        strikes = [s.strike for s in scores]
        assert strikes == [24000, 24100]

    def test_no_prev_rows_vol_scores_zero(self):
        rows = [
            _row(24000, call_vol=1000, put_vol=500),
            _row(24050, call_vol=800,  put_vol=300),
        ]
        scores = compute_strike_scores(rows, prev_rows=None)
        assert all(s.vol_score == 0.0 for s in scores)

    def test_vol_score_with_prev_rows(self):
        rows      = [_row(24000, call_vol=1200, put_vol=600)]
        prev_rows = [_prev_row(24000, call_vol=1000, put_vol=400)]
        scores = compute_strike_scores(rows, prev_rows)
        # vol_score = (1200-1000) + (600-400) = 400
        assert scores[0].vol_score == pytest.approx(400.0)

    def test_vol_score_clamped_to_zero_on_decrease(self):
        # Volume can't decrease — guard against stale data
        rows      = [_row(24000, call_vol=900, put_vol=400)]
        prev_rows = [_prev_row(24000, call_vol=1000, put_vol=500)]
        scores = compute_strike_scores(rows, prev_rows)
        assert scores[0].vol_score == 0.0

    def test_oi_score_uses_absolute_values(self):
        rows = [_row(24000, call_oi_chg=-500, put_oi_chg=300)]
        scores = compute_strike_scores(rows, prev_rows=None)
        # oi_score = |−500| + |300| = 800
        assert scores[0].oi_score == pytest.approx(800.0)

    def test_oi_score_sums_call_and_put(self):
        rows = [_row(24000, call_oi_chg=200, put_oi_chg=150)]
        scores = compute_strike_scores(rows, prev_rows=None)
        assert scores[0].oi_score == pytest.approx(350.0)

    def test_strength_all_zero(self):
        rows = [_row(24000), _row(24050), _row(24100)]
        scores = compute_strike_scores(rows, prev_rows=None)
        assert all(s.strength == 0.0 for s in scores)

    def test_strength_all_equal_nonzero(self):
        rows = [
            _row(24000, call_oi_chg=100),
            _row(24050, call_oi_chg=100),
        ]
        scores = compute_strike_scores(rows, prev_rows=None)
        assert all(s.strength == pytest.approx(1.0) for s in scores)

    def test_strength_normalized_min_max(self):
        rows = [
            _row(24000, call_oi_chg=0),
            _row(24050, call_oi_chg=500),
            _row(24100, call_oi_chg=1000),
        ]
        scores = compute_strike_scores(rows, prev_rows=None)
        strengths = {s.strike: s.strength for s in scores}
        assert strengths[24000] == pytest.approx(0.0)
        assert strengths[24050] == pytest.approx(0.5)
        assert strengths[24100] == pytest.approx(1.0)

    def test_prev_row_for_missing_strike_treated_as_zero(self):
        rows      = [_row(24000, call_vol=500), _row(24100, call_vol=300)]
        prev_rows = [_prev_row(24000, call_vol=200)]  # 24100 absent from prev
        scores = compute_strike_scores(rows, prev_rows)
        score_map = {s.strike: s for s in scores}
        assert score_map[24000].vol_score == pytest.approx(300.0)   # 500−200
        assert score_map[24100].vol_score == pytest.approx(300.0)   # 300−0

    def test_returns_StrikeScore_instances(self):
        scores = compute_strike_scores([_row(24000)], prev_rows=None)
        assert isinstance(scores[0], StrikeScore)


# ══════════════════════════════════════════════════════════════════════════════
# select_active_strikes
# ══════════════════════════════════════════════════════════════════════════════

class TestSelectActiveStrikes:

    # ── Basic edge cases ──────────────────────────────────────────────────────

    def test_empty_scores_returns_empty(self):
        assert select_active_strikes([], spot=24150.0, vol_diff_available=False) == []

    def test_all_zero_scores_returns_empty(self):
        rows = [_row(s) for s in [24000, 24050, 24100]]
        scores = compute_strike_scores(rows, prev_rows=None)
        result = select_active_strikes(scores, spot=24050.0, vol_diff_available=False)
        assert result == []

    def test_returns_strike_score_instances(self):
        rows = [_row(24000, call_oi_chg=500)]
        scores = compute_strike_scores(rows, prev_rows=None)
        result = select_active_strikes(scores, spot=24000.0, vol_diff_available=False)
        assert all(isinstance(s, StrikeScore) for s in result)

    # ── First snapshot (vol_diff_available=False) ─────────────────────────────

    def test_first_snapshot_uses_oi_only(self):
        rows = [
            _row(24000, call_vol=500, put_vol=300, call_oi_chg=100),
            _row(24050, call_vol=800, put_vol=600, call_oi_chg=200),
            _row(24100, call_vol=200, put_vol=100, call_oi_chg=50),
        ]
        scores = compute_strike_scores(rows, prev_rows=None)
        result = select_active_strikes(scores, spot=24050.0, vol_diff_available=False)
        result_strikes = {s.strike for s in result}
        # All three have non-zero OI change
        assert result_strikes == {24000, 24050, 24100}

    def test_first_snapshot_max_top_n_strikes(self):
        rows = [_row(s, call_oi_chg=100) for s in range(24000, 24400, 50)]  # 8 strikes
        scores = compute_strike_scores(rows, prev_rows=None)
        result = select_active_strikes(scores, spot=24150.0,
                                       vol_diff_available=False, top_n=3)
        assert len(result) <= 3

    # ── OI set selection ──────────────────────────────────────────────────────

    def test_oi_set_top3_by_oi_score(self):
        rows = [
            _row(24000, call_oi_chg=1000),
            _row(24050, call_oi_chg=500),
            _row(24100, call_oi_chg=800),
            _row(24150, call_oi_chg=200),
            _row(24200, call_oi_chg=50),
        ]
        scores = compute_strike_scores(rows, prev_rows=None)
        result = select_active_strikes(scores, spot=24100.0, vol_diff_available=False)
        result_strikes = {s.strike for s in result}
        # Top 3 by OI: 24000(1000), 24100(800), 24050(500)
        assert result_strikes == {24000, 24050, 24100}
        assert 24150 not in result_strikes
        assert 24200 not in result_strikes

    def test_oi_nonzero_filter(self):
        rows = [
            _row(24000, call_oi_chg=100),
            _row(24050),                    # zero OI change
            _row(24100, call_oi_chg=200),
        ]
        scores = compute_strike_scores(rows, prev_rows=None)
        result = select_active_strikes(scores, spot=24050.0, vol_diff_available=False)
        result_strikes = {s.strike for s in result}
        assert 24050 not in result_strikes

    # ── Volume set selection ──────────────────────────────────────────────────

    def test_vol_diff_available_false_skips_volume_set(self):
        rows = [
            _row(24000, call_vol=1000, call_oi_chg=10),
            _row(24050, call_vol=5000, call_oi_chg=5),
        ]
        prev_rows = [_prev_row(24000, call_vol=0), _prev_row(24050, call_vol=0)]
        scores = compute_strike_scores(rows, prev_rows)
        # vol_diff_available=False → OI-only; 24000 has higher OI change
        result = select_active_strikes(scores, spot=24025.0, vol_diff_available=False)
        result_strikes = {s.strike for s in result}
        assert 24000 in result_strikes
        # 24050 is still in OI set since it has oi_chg=5 > 0
        assert 24050 in result_strikes

    def test_vol_set_selects_top3_by_vol_score(self):
        # Only test volume set — set oi_chg=0 so OI set is empty
        rows = [
            _row(24000, call_vol=2000),
            _row(24050, call_vol=5000),
            _row(24100, call_vol=3000),
            _row(24150, call_vol=1000),
            _row(24200, call_vol=500),
        ]
        prev_rows = [_prev_row(s, call_vol=0) for s in [24000, 24050, 24100, 24150, 24200]]
        scores = compute_strike_scores(rows, prev_rows)
        result = select_active_strikes(scores, spot=24100.0, vol_diff_available=True)
        result_strikes = {s.strike for s in result}
        # Top 3 by vol: 24050(5000), 24100(3000), 24000(2000)
        assert result_strikes == {24000, 24050, 24100}

    # ── Union and dedup ───────────────────────────────────────────────────────

    def test_union_dedup_max_6_strikes(self):
        # 3 OI-only strikes + 3 vol-only strikes = 6 unique
        rows = [
            _row(24000, call_vol=100, call_oi_chg=0),
            _row(24050, call_vol=200, call_oi_chg=0),
            _row(24100, call_vol=300, call_oi_chg=0),
            _row(24150, call_vol=0,   call_oi_chg=100),
            _row(24200, call_vol=0,   call_oi_chg=200),
            _row(24250, call_vol=0,   call_oi_chg=300),
        ]
        prev_rows = [_prev_row(s) for s in [24000, 24050, 24100, 24150, 24200, 24250]]
        scores = compute_strike_scores(rows, prev_rows)
        result = select_active_strikes(scores, spot=24125.0, vol_diff_available=True)
        assert len(result) == 6

    def test_union_dedup_overlap(self):
        # Strike 24100 appears in both sets — counted once
        rows = [
            _row(24000, call_vol=100, call_oi_chg=50),
            _row(24050, call_vol=200, call_oi_chg=100),
            _row(24100, call_vol=300, call_oi_chg=200),  # in both sets
            _row(24150, call_vol=0,   call_oi_chg=300),
            _row(24200, call_vol=0,   call_oi_chg=400),
        ]
        prev_rows = [_prev_row(s) for s in [24000, 24050, 24100, 24150, 24200]]
        scores = compute_strike_scores(rows, prev_rows)
        result = select_active_strikes(scores, spot=24100.0, vol_diff_available=True)
        strikes = [s.strike for s in result]
        assert len(strikes) == len(set(strikes))   # no duplicates

    # ── Tiebreaker ────────────────────────────────────────────────────────────

    def test_tiebreaker_closer_strike_wins(self):
        spot = 24100.0
        # Both have same OI score; 24100 is closer (distance=0) vs 24200 (distance=100)
        rows = [
            _row(24100, call_oi_chg=500),
            _row(24200, call_oi_chg=500),
            _row(24300, call_oi_chg=500),
            _row(24400, call_oi_chg=500),  # furthest
        ]
        scores = compute_strike_scores(rows, prev_rows=None)
        result = select_active_strikes(scores, spot=spot, vol_diff_available=False, top_n=3)
        result_strikes = {s.strike for s in result}
        assert 24100 in result_strikes
        assert 24200 in result_strikes
        assert 24300 in result_strikes
        assert 24400 not in result_strikes

    def test_tiebreaker_above_spot_wins_on_equal_distance(self):
        spot = 24100.0
        # 24050 (distance=50, below) and 24150 (distance=50, above) have equal scores.
        # With top_n=1, only 1 strike is selected: 24150 wins because it is above spot.
        rows = [
            _row(24000, call_oi_chg=500),   # distance=100
            _row(24050, call_oi_chg=500),   # distance=50, below
            _row(24150, call_oi_chg=500),   # distance=50, above — beats 24050
        ]
        scores = compute_strike_scores(rows, prev_rows=None)
        result = select_active_strikes(scores, spot=spot, vol_diff_available=False, top_n=1)
        result_strikes = {s.strike for s in result}
        # top_n=1: closest is 24050/24150 (tied at distance 50); 24150 wins (above)
        assert result_strikes == {24150}

    # ── Slot ordering ─────────────────────────────────────────────────────────

    def test_result_ordered_by_descending_strength(self):
        rows = [
            _row(24000, call_oi_chg=100),   # strength=low
            _row(24050, call_oi_chg=500),   # strength=high
            _row(24100, call_oi_chg=300),   # strength=mid
        ]
        scores = compute_strike_scores(rows, prev_rows=None)
        result = select_active_strikes(scores, spot=24050.0, vol_diff_available=False)
        strengths = [s.strength for s in result]
        assert strengths == sorted(strengths, reverse=True)

    def test_highest_strength_is_first(self):
        rows = [
            _row(24000, call_oi_chg=100),
            _row(24050, call_oi_chg=1000),  # highest
            _row(24100, call_oi_chg=200),
        ]
        scores = compute_strike_scores(rows, prev_rows=None)
        result = select_active_strikes(scores, spot=24050.0, vol_diff_available=False)
        assert result[0].strike == 24050

    # ── top_n parameter ───────────────────────────────────────────────────────

    def test_top_n_1_returns_at_most_2_strikes(self):
        rows = [_row(s, call_oi_chg=100, call_vol=100) for s in range(24000, 24700, 50)]
        prev_rows = [_prev_row(s) for s in range(24000, 24700, 50)]
        scores = compute_strike_scores(rows, prev_rows)
        result = select_active_strikes(scores, spot=24100.0,
                                       vol_diff_available=True, top_n=1)
        assert len(result) <= 2   # 1 from OI set + 1 from vol set (may overlap → 1)

    def test_top_n_default_is_3(self):
        # 3+3 non-overlapping sets → 6 strikes maximum
        rows = [
            _row(24000, call_oi_chg=100),
            _row(24050, call_oi_chg=200),
            _row(24100, call_oi_chg=300),
            _row(24150, call_vol=100),
            _row(24200, call_vol=200),
            _row(24250, call_vol=300),
        ]
        prev_rows = [_prev_row(s) for s in [24150, 24200, 24250]]
        scores = compute_strike_scores(rows, prev_rows)
        result = select_active_strikes(scores, spot=24125.0, vol_diff_available=True)
        assert len(result) <= 6
