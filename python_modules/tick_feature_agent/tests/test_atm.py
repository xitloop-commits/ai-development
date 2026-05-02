"""
test_atm.py — Unit tests for features/atm.py.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_atm.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pytest

from tick_feature_agent.features.atm import (
    atm_shifted,
    compute_atm,
    compute_atm_window,
    detect_strike_step,
)

# ══════════════════════════════════════════════════════════════════════════════
# detect_strike_step
# ══════════════════════════════════════════════════════════════════════════════


class TestDetectStrikeStep:

    def test_uniform_chain_nifty(self):
        strikes = list(range(21000, 25100, 50))  # 50-pt steps
        assert detect_strike_step(strikes) == 50

    def test_uniform_chain_banknifty(self):
        strikes = list(range(48000, 52100, 100))
        assert detect_strike_step(strikes) == 100

    def test_uniform_chain_crudeoil(self):
        strikes = [5400, 5450, 5500, 5550, 5600]
        assert detect_strike_step(strikes) == 50

    def test_non_uniform_returns_minimum_step(self):
        # Chain with mostly 100-pt steps but one 50-pt gap
        strikes = [24000, 24050, 24100, 24200, 24300]
        assert detect_strike_step(strikes) == 50

    def test_unsorted_input(self):
        strikes = [24200, 24000, 24100, 24300]
        assert detect_strike_step(strikes) == 100

    def test_float_strikes_truncated_to_int(self):
        strikes = [24000.0, 24050.0, 24100.0]
        assert detect_strike_step(strikes) == 50

    def test_two_strikes_minimum(self):
        assert detect_strike_step([24000, 24050]) == 50

    def test_fewer_than_two_distinct_raises(self):
        with pytest.raises(ValueError, match="2 distinct"):
            detect_strike_step([24000])

    def test_empty_list_raises(self):
        with pytest.raises(ValueError):
            detect_strike_step([])

    def test_duplicates_are_deduplicated(self):
        # Duplicate strikes are silently deduplicated — result is the real step
        assert detect_strike_step([24000, 24000, 24100]) == 100

    def test_all_same_value_raises(self):
        with pytest.raises(ValueError):
            detect_strike_step([24000, 24000])


# ══════════════════════════════════════════════════════════════════════════════
# compute_atm
# ══════════════════════════════════════════════════════════════════════════════


class TestComputeAtm:

    def test_spot_below_midpoint_rounds_down(self):
        # 24137.6 → nearest 50-multiple is 24150 (since 24137.6 / 50 = 482.752 → 483 × 50 = 24150)
        # Actually: 24137.6/50 = 482.752 → round(482.752) = 483 → 483*50 = 24150
        assert compute_atm(24137.6, 50) == 24150

    def test_spot_above_midpoint_rounds_up(self):
        # 24176 / 50 = 483.52 → round = 484 → 484*50 = 24200
        assert compute_atm(24176.0, 50) == 24200

    def test_spot_exactly_on_strike(self):
        assert compute_atm(24150.0, 50) == 24150

    def test_spot_at_exact_midpoint_banker_rounding(self):
        # 24075 / 50 = 481.5 → banker's round to 482 (even) → 482*50 = 24100
        assert compute_atm(24075.0, 50) == 24100

    def test_small_step_naturalgas(self):
        # Natural gas: step = 10
        assert compute_atm(350.3, 10) == 350

    def test_large_step_banknifty(self):
        assert compute_atm(51234.0, 100) == 51200

    def test_returns_int(self):
        result = compute_atm(24137.6, 50)
        assert isinstance(result, int)

    def test_spot_very_close_to_lower_strike(self):
        # 24001 → rounds to 24000
        assert compute_atm(24001.0, 50) == 24000

    def test_spot_very_close_to_upper_strike(self):
        # 24049 → rounds to 24050
        assert compute_atm(24049.0, 50) == 24050


# ══════════════════════════════════════════════════════════════════════════════
# compute_atm_window
# ══════════════════════════════════════════════════════════════════════════════


class TestComputeAtmWindow:

    def test_returns_7_elements(self):
        window = compute_atm_window(24150, 50)
        assert len(window) == 7

    def test_correct_values_nifty(self):
        # ATM=24150, step=50: ATM±3*50 = 24150±150
        window = compute_atm_window(24150, 50)
        assert window == [24000, 24050, 24100, 24150, 24200, 24250, 24300]

    def test_atm_is_centre_element(self):
        atm = 24150
        window = compute_atm_window(atm, 50)
        assert window[3] == atm

    def test_sorted_ascending(self):
        window = compute_atm_window(24150, 50)
        assert window == sorted(window)

    def test_equal_spacing(self):
        window = compute_atm_window(24000, 100)
        diffs = [window[i + 1] - window[i] for i in range(len(window) - 1)]
        assert all(d == 100 for d in diffs)

    def test_banknifty_step_100(self):
        window = compute_atm_window(51000, 100)
        assert window == [50700, 50800, 50900, 51000, 51100, 51200, 51300]

    def test_naturalgas_step_10(self):
        window = compute_atm_window(350, 10)
        assert window == [320, 330, 340, 350, 360, 370, 380]


# ══════════════════════════════════════════════════════════════════════════════
# atm_shifted
# ══════════════════════════════════════════════════════════════════════════════


class TestAtmShifted:

    def test_same_atm_returns_false(self):
        assert atm_shifted(24150, 24150) is False

    def test_different_atm_returns_true(self):
        assert atm_shifted(24150, 24200) is True

    def test_none_old_atm_returns_true(self):
        # First tick — always a "shift" so the cache is initialized
        assert atm_shifted(None, 24150) is True

    def test_atm_drops_returns_true(self):
        assert atm_shifted(24200, 24150) is True

    def test_large_shift(self):
        assert atm_shifted(24000, 25000) is True
