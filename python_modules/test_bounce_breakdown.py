#!/usr/bin/env python3
"""
Unit Tests — Bounce/Breakdown Engine (classify_bounce_breakdown)
================================================================
Tests the structural setup classifier in ai_decision_engine.py.

Coverage:
  1. BOUNCE_SUPPORT: LTP near support, support holding → GO_CALL
  2. BOUNCE_RESISTANCE: LTP near resistance, resistance holding → GO_PUT
  3. BREAKDOWN_SUPPORT: LTP near support, support breaking → GO_PUT
  4. BREAKOUT_RESISTANCE: LTP near resistance, resistance breaking → GO_CALL
  5. NEUTRAL: LTP in mid-range, or no clear setup
  6. Alignment checks: direction matches vs mismatches required_direction
  7. Edge cases: zero levels, missing data, boundary conditions

Run:
    cd python_modules && python3.11 -m pytest test_bounce_breakdown.py -v
    OR
    cd python_modules && python3.11 test_bounce_breakdown.py
"""

import sys
import os
import unittest

# Ensure the module directory is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ai_decision_engine import classify_bounce_breakdown


# --- Helper factories ---

def make_support(level, prediction="BOUNCE", strength=70):
    """Create a support_analysis dict."""
    return {
        "level": level,
        "prediction": prediction,
        "strength": strength,
        "probability": 65,
        "evidence": ["test"],
        "oi": 50000,
        "oi_change": 5000,
        "oi_change_pct": 10,
        "volume": 3000,
        "iv": 15,
    }


def make_resistance(level, prediction="BOUNCE", strength=70):
    """Create a resistance_analysis dict."""
    return {
        "level": level,
        "prediction": prediction,
        "strength": strength,
        "probability": 65,
        "evidence": ["test"],
        "oi": 60000,
        "oi_change": 6000,
        "oi_change_pct": 12,
        "volume": 4000,
        "iv": 16,
    }


# =============================================================================
# Test Suite
# =============================================================================

class TestBounceBreakdownClassification(unittest.TestCase):
    """Tests for the 4 primary setup types + NEUTRAL."""

    # --- 1. BOUNCE_SUPPORT ---

    def test_bounce_support_basic(self):
        """LTP near support, support prediction=BOUNCE, strength>=50 → BOUNCE_SUPPORT."""
        # Support=100, Resistance=200, LTP=110 → dist_to_support = 10% of range
        result = classify_bounce_breakdown(
            ltp=110,
            direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "BOUNCE_SUPPORT")
        self.assertEqual(result["required_direction"], "GO_CALL")
        self.assertTrue(result["aligned"])
        self.assertIn("bounce up", result["detail"].lower())

    def test_bounce_support_at_exact_support(self):
        """LTP exactly at support level → dist_to_support = 0% → BOUNCE_SUPPORT."""
        result = classify_bounce_breakdown(
            ltp=100,
            direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 60),
            resistance_analysis=make_resistance(200, "BOUNCE", 60),
        )
        self.assertEqual(result["setup_type"], "BOUNCE_SUPPORT")
        self.assertEqual(result["required_direction"], "GO_CALL")

    def test_bounce_support_at_29_percent(self):
        """LTP at 29% from support (just within 30% threshold) → BOUNCE_SUPPORT."""
        # Support=1000, Resistance=2000, range=1000, 29% = LTP at 1290
        result = classify_bounce_breakdown(
            ltp=1290,
            direction="GO_CALL",
            support_analysis=make_support(1000, "BOUNCE", 55),
            resistance_analysis=make_resistance(2000, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "BOUNCE_SUPPORT")

    def test_bounce_support_strength_exactly_50(self):
        """Support strength exactly 50 (boundary) → BOUNCE_SUPPORT (>= 50 passes)."""
        result = classify_bounce_breakdown(
            ltp=105,
            direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 50),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "BOUNCE_SUPPORT")

    def test_bounce_support_weak_strength_rejected(self):
        """Support prediction=BOUNCE but strength < 50 → NOT BOUNCE_SUPPORT (falls to NEUTRAL)."""
        result = classify_bounce_breakdown(
            ltp=105,
            direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 49),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertNotEqual(result["setup_type"], "BOUNCE_SUPPORT")
        # With weak strength, near support but BOUNCE doesn't qualify → NEUTRAL
        self.assertEqual(result["setup_type"], "NEUTRAL")

    # --- 2. BOUNCE_RESISTANCE ---

    def test_bounce_resistance_basic(self):
        """LTP near resistance, resistance prediction=BOUNCE, strength>=50 → BOUNCE_RESISTANCE."""
        # Support=100, Resistance=200, LTP=185 → dist_to_resistance = 15% of range
        result = classify_bounce_breakdown(
            ltp=185,
            direction="GO_PUT",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "BOUNCE_RESISTANCE")
        self.assertEqual(result["required_direction"], "GO_PUT")
        self.assertTrue(result["aligned"])
        self.assertIn("bounce down", result["detail"].lower())

    def test_bounce_resistance_at_exact_resistance(self):
        """LTP exactly at resistance level → dist_to_resistance = 0% → BOUNCE_RESISTANCE."""
        result = classify_bounce_breakdown(
            ltp=200,
            direction="GO_PUT",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 80),
        )
        self.assertEqual(result["setup_type"], "BOUNCE_RESISTANCE")

    def test_bounce_resistance_weak_strength_rejected(self):
        """Resistance prediction=BOUNCE but strength < 50 → NEUTRAL."""
        result = classify_bounce_breakdown(
            ltp=195,
            direction="GO_PUT",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 40),
        )
        self.assertEqual(result["setup_type"], "NEUTRAL")

    # --- 3. BREAKDOWN_SUPPORT ---

    def test_breakdown_support_basic(self):
        """LTP near support, support prediction=BREAKDOWN → BREAKDOWN_SUPPORT → GO_PUT."""
        result = classify_bounce_breakdown(
            ltp=110,
            direction="GO_PUT",
            support_analysis=make_support(100, "BREAKDOWN", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "BREAKDOWN_SUPPORT")
        self.assertEqual(result["required_direction"], "GO_PUT")
        self.assertTrue(result["aligned"])
        self.assertIn("breakdown", result["detail"].lower())

    def test_breakdown_support_no_strength_requirement(self):
        """BREAKDOWN does not require strength >= 50 (unlike BOUNCE)."""
        result = classify_bounce_breakdown(
            ltp=105,
            direction="GO_PUT",
            support_analysis=make_support(100, "BREAKDOWN", 30),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "BREAKDOWN_SUPPORT")
        self.assertEqual(result["required_direction"], "GO_PUT")

    # --- 4. BREAKOUT_RESISTANCE ---

    def test_breakout_resistance_basic(self):
        """LTP near resistance, resistance prediction=BREAKOUT → BREAKOUT_RESISTANCE → GO_CALL."""
        result = classify_bounce_breakdown(
            ltp=190,
            direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BREAKOUT", 80),
        )
        self.assertEqual(result["setup_type"], "BREAKOUT_RESISTANCE")
        self.assertEqual(result["required_direction"], "GO_CALL")
        self.assertTrue(result["aligned"])
        self.assertIn("breakout up", result["detail"].lower())

    def test_breakout_resistance_no_strength_requirement(self):
        """BREAKOUT does not require strength >= 50 (unlike BOUNCE)."""
        result = classify_bounce_breakdown(
            ltp=195,
            direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BREAKOUT", 25),
        )
        self.assertEqual(result["setup_type"], "BREAKOUT_RESISTANCE")

    # --- 5. NEUTRAL ---

    def test_neutral_mid_range(self):
        """LTP in the middle of the range (30-70%) → NEUTRAL."""
        # Support=100, Resistance=200, LTP=150 → 50% from support
        result = classify_bounce_breakdown(
            ltp=150,
            direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "NEUTRAL")
        self.assertIsNone(result["required_direction"])
        self.assertIn("mid-range", result["detail"].lower())

    def test_neutral_at_30_percent_boundary(self):
        """LTP at exactly 30% from support → NOT near support (>= 30 fails < 30 check) → mid-range."""
        # Support=100, Resistance=200, range=100, 30% = LTP at 130
        result = classify_bounce_breakdown(
            ltp=130,
            direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        # dist_to_support_pct = 30, dist_to_resistance_pct = 70
        # 30 is NOT < 30, and 70 is NOT < 30 → mid-range
        self.assertEqual(result["setup_type"], "NEUTRAL")

    def test_neutral_uncertain_prediction_near_support(self):
        """LTP near support but prediction=UNCERTAIN → NEUTRAL."""
        result = classify_bounce_breakdown(
            ltp=105,
            direction="GO_CALL",
            support_analysis=make_support(100, "UNCERTAIN", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "NEUTRAL")

    def test_neutral_uncertain_prediction_near_resistance(self):
        """LTP near resistance but prediction=UNCERTAIN → NEUTRAL."""
        result = classify_bounce_breakdown(
            ltp=195,
            direction="GO_PUT",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "UNCERTAIN", 70),
        )
        self.assertEqual(result["setup_type"], "NEUTRAL")


class TestBounceBreakdownAlignment(unittest.TestCase):
    """Tests for direction alignment logic."""

    def test_aligned_call_with_bounce_support(self):
        """GO_CALL + BOUNCE_SUPPORT → aligned=True."""
        result = classify_bounce_breakdown(
            ltp=110, direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertTrue(result["aligned"])

    def test_misaligned_put_with_bounce_support(self):
        """GO_PUT + BOUNCE_SUPPORT (requires GO_CALL) → aligned=False."""
        result = classify_bounce_breakdown(
            ltp=110, direction="GO_PUT",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "BOUNCE_SUPPORT")
        self.assertFalse(result["aligned"])

    def test_aligned_put_with_bounce_resistance(self):
        """GO_PUT + BOUNCE_RESISTANCE → aligned=True."""
        result = classify_bounce_breakdown(
            ltp=185, direction="GO_PUT",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertTrue(result["aligned"])

    def test_misaligned_call_with_bounce_resistance(self):
        """GO_CALL + BOUNCE_RESISTANCE (requires GO_PUT) → aligned=False."""
        result = classify_bounce_breakdown(
            ltp=185, direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "BOUNCE_RESISTANCE")
        self.assertFalse(result["aligned"])

    def test_aligned_put_with_breakdown_support(self):
        """GO_PUT + BREAKDOWN_SUPPORT → aligned=True."""
        result = classify_bounce_breakdown(
            ltp=110, direction="GO_PUT",
            support_analysis=make_support(100, "BREAKDOWN", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertTrue(result["aligned"])

    def test_misaligned_call_with_breakdown_support(self):
        """GO_CALL + BREAKDOWN_SUPPORT (requires GO_PUT) → aligned=False."""
        result = classify_bounce_breakdown(
            ltp=110, direction="GO_CALL",
            support_analysis=make_support(100, "BREAKDOWN", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertFalse(result["aligned"])

    def test_aligned_call_with_breakout_resistance(self):
        """GO_CALL + BREAKOUT_RESISTANCE → aligned=True."""
        result = classify_bounce_breakdown(
            ltp=190, direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BREAKOUT", 80),
        )
        self.assertTrue(result["aligned"])

    def test_misaligned_put_with_breakout_resistance(self):
        """GO_PUT + BREAKOUT_RESISTANCE (requires GO_CALL) → aligned=False."""
        result = classify_bounce_breakdown(
            ltp=190, direction="GO_PUT",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BREAKOUT", 80),
        )
        self.assertFalse(result["aligned"])

    def test_wait_direction_always_aligned(self):
        """direction=WAIT is not GO_CALL/GO_PUT → aligned defaults to True."""
        result = classify_bounce_breakdown(
            ltp=110, direction="WAIT",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertTrue(result["aligned"])

    def test_neutral_direction_always_aligned(self):
        """direction=NEUTRAL → aligned defaults to True (no required_direction to conflict)."""
        result = classify_bounce_breakdown(
            ltp=150, direction="NEUTRAL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertTrue(result["aligned"])

    def test_neutral_setup_always_aligned(self):
        """NEUTRAL setup has no required_direction → aligned=True regardless of direction."""
        result = classify_bounce_breakdown(
            ltp=150, direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "NEUTRAL")
        self.assertTrue(result["aligned"])


class TestBounceBreakdownEdgeCases(unittest.TestCase):
    """Edge cases: zero levels, missing data, inverted ranges."""

    def test_zero_support_level(self):
        """Support level = 0 → outer if-block fails → NEUTRAL."""
        result = classify_bounce_breakdown(
            ltp=150, direction="GO_CALL",
            support_analysis=make_support(0, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "NEUTRAL")
        self.assertTrue(result["aligned"])

    def test_zero_resistance_level(self):
        """Resistance level = 0 → outer if-block fails → NEUTRAL."""
        result = classify_bounce_breakdown(
            ltp=150, direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(0, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "NEUTRAL")

    def test_zero_ltp(self):
        """LTP = 0 → outer if-block fails → NEUTRAL."""
        result = classify_bounce_breakdown(
            ltp=0, direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "NEUTRAL")

    def test_support_equals_resistance(self):
        """Support == Resistance → total_range = 0 → inner if fails → NEUTRAL."""
        result = classify_bounce_breakdown(
            ltp=150, direction="GO_CALL",
            support_analysis=make_support(150, "BOUNCE", 70),
            resistance_analysis=make_resistance(150, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "NEUTRAL")

    def test_inverted_support_resistance(self):
        """Support > Resistance → total_range < 0 → inner if fails → NEUTRAL."""
        result = classify_bounce_breakdown(
            ltp=150, direction="GO_CALL",
            support_analysis=make_support(200, "BOUNCE", 70),
            resistance_analysis=make_resistance(100, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "NEUTRAL")

    def test_ltp_below_support(self):
        """LTP below support → dist_to_support_pct < 0 (< 30) → near support path."""
        # Support=100, Resistance=200, LTP=95 → dist_to_support = -5%
        result = classify_bounce_breakdown(
            ltp=95, direction="GO_PUT",
            support_analysis=make_support(100, "BREAKDOWN", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "BREAKDOWN_SUPPORT")

    def test_ltp_above_resistance(self):
        """LTP above resistance → dist_to_resistance_pct < 0 (< 30) → near resistance path."""
        # Support=100, Resistance=200, LTP=210 → dist_to_resistance = -10%
        result = classify_bounce_breakdown(
            ltp=210, direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BREAKOUT", 80),
        )
        # dist_to_support = 110%, dist_to_resistance = -10%
        # 110 is NOT < 30, but -10 IS < 30 → near resistance path
        # Actually: elif dist_to_resistance_pct < 30 → since dist_to_support >= 30, this elif fires
        self.assertEqual(result["setup_type"], "BREAKOUT_RESISTANCE")

    def test_empty_support_analysis(self):
        """Support analysis with missing keys → defaults to 0/UNCERTAIN."""
        result = classify_bounce_breakdown(
            ltp=150, direction="GO_CALL",
            support_analysis={},
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        # level=0 → outer if fails → NEUTRAL
        self.assertEqual(result["setup_type"], "NEUTRAL")

    def test_empty_resistance_analysis(self):
        """Resistance analysis with missing keys → defaults to 0/UNCERTAIN."""
        result = classify_bounce_breakdown(
            ltp=150, direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis={},
        )
        self.assertEqual(result["setup_type"], "NEUTRAL")

    def test_both_analyses_empty(self):
        """Both analyses empty → NEUTRAL."""
        result = classify_bounce_breakdown(
            ltp=150, direction="GO_CALL",
            support_analysis={},
            resistance_analysis={},
        )
        self.assertEqual(result["setup_type"], "NEUTRAL")
        self.assertTrue(result["aligned"])
        self.assertIsNone(result["required_direction"])


class TestBounceBreakdownReturnSchema(unittest.TestCase):
    """Verify the return dict always has the expected keys and types."""

    def test_return_keys(self):
        """Return dict must have exactly 4 keys: setup_type, aligned, required_direction, detail."""
        result = classify_bounce_breakdown(
            ltp=150, direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertSetEqual(set(result.keys()), {"setup_type", "aligned", "required_direction", "detail"})

    def test_setup_type_is_string(self):
        result = classify_bounce_breakdown(
            ltp=110, direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertIsInstance(result["setup_type"], str)

    def test_aligned_is_bool(self):
        result = classify_bounce_breakdown(
            ltp=110, direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertIsInstance(result["aligned"], bool)

    def test_detail_is_string(self):
        result = classify_bounce_breakdown(
            ltp=110, direction="GO_CALL",
            support_analysis=make_support(100, "BOUNCE", 70),
            resistance_analysis=make_resistance(200, "BOUNCE", 70),
        )
        self.assertIsInstance(result["detail"], str)

    def test_required_direction_valid_values(self):
        """required_direction must be GO_CALL, GO_PUT, or None."""
        for ltp, sup_pred, res_pred in [
            (110, "BOUNCE", "BOUNCE"),       # BOUNCE_SUPPORT → GO_CALL
            (190, "BOUNCE", "BOUNCE"),       # BOUNCE_RESISTANCE → GO_PUT
            (110, "BREAKDOWN", "BOUNCE"),    # BREAKDOWN_SUPPORT → GO_PUT
            (190, "BOUNCE", "BREAKOUT"),     # BREAKOUT_RESISTANCE → GO_CALL
            (150, "BOUNCE", "BOUNCE"),       # NEUTRAL → None
        ]:
            result = classify_bounce_breakdown(
                ltp=ltp, direction="GO_CALL",
                support_analysis=make_support(100, sup_pred, 70),
                resistance_analysis=make_resistance(200, res_pred, 70),
            )
            self.assertIn(result["required_direction"], ("GO_CALL", "GO_PUT", None))


class TestBounceBreakdownRealWorldScenarios(unittest.TestCase):
    """Realistic NIFTY/BANKNIFTY scenarios."""

    def test_nifty_bounce_at_support(self):
        """NIFTY at 24100 with support at 24000 and resistance at 24500 → BOUNCE_SUPPORT."""
        result = classify_bounce_breakdown(
            ltp=24100,
            direction="GO_CALL",
            support_analysis=make_support(24000, "BOUNCE", 75),
            resistance_analysis=make_resistance(24500, "BOUNCE", 65),
        )
        # dist_to_support = (24100-24000)/500 * 100 = 20% → < 30% → near support
        self.assertEqual(result["setup_type"], "BOUNCE_SUPPORT")
        self.assertEqual(result["required_direction"], "GO_CALL")
        self.assertTrue(result["aligned"])

    def test_nifty_breakdown_at_support(self):
        """NIFTY at 24050 with support breaking at 24000 → BREAKDOWN_SUPPORT → GO_PUT."""
        result = classify_bounce_breakdown(
            ltp=24050,
            direction="GO_PUT",
            support_analysis=make_support(24000, "BREAKDOWN", 40),
            resistance_analysis=make_resistance(24500, "BOUNCE", 65),
        )
        self.assertEqual(result["setup_type"], "BREAKDOWN_SUPPORT")
        self.assertEqual(result["required_direction"], "GO_PUT")
        self.assertTrue(result["aligned"])

    def test_banknifty_breakout_at_resistance(self):
        """BANKNIFTY at 51800 with resistance breaking at 52000 → BREAKOUT_RESISTANCE → GO_CALL."""
        result = classify_bounce_breakdown(
            ltp=51800,
            direction="GO_CALL",
            support_analysis=make_support(51000, "BOUNCE", 60),
            resistance_analysis=make_resistance(52000, "BREAKOUT", 55),
        )
        # dist_to_resistance = (52000-51800)/1000 * 100 = 20% → < 30% → near resistance
        self.assertEqual(result["setup_type"], "BREAKOUT_RESISTANCE")
        self.assertEqual(result["required_direction"], "GO_CALL")
        self.assertTrue(result["aligned"])

    def test_banknifty_bounce_at_resistance(self):
        """BANKNIFTY at 51900 with resistance holding at 52000 → BOUNCE_RESISTANCE → GO_PUT."""
        result = classify_bounce_breakdown(
            ltp=51900,
            direction="GO_PUT",
            support_analysis=make_support(51000, "BOUNCE", 60),
            resistance_analysis=make_resistance(52000, "BOUNCE", 70),
        )
        self.assertEqual(result["setup_type"], "BOUNCE_RESISTANCE")
        self.assertEqual(result["required_direction"], "GO_PUT")
        self.assertTrue(result["aligned"])

    def test_nifty_mid_range_no_trade(self):
        """NIFTY at 24250 (exactly mid-range) → NEUTRAL."""
        result = classify_bounce_breakdown(
            ltp=24250,
            direction="GO_CALL",
            support_analysis=make_support(24000, "BOUNCE", 70),
            resistance_analysis=make_resistance(24500, "BOUNCE", 70),
        )
        # dist_to_support = 50% → not < 30, dist_to_resistance = 50% → not < 30
        self.assertEqual(result["setup_type"], "NEUTRAL")

    def test_crudeoil_narrow_range(self):
        """CRUDEOIL with narrow range: support=5900, resistance=5950, LTP=5910."""
        result = classify_bounce_breakdown(
            ltp=5910,
            direction="GO_CALL",
            support_analysis=make_support(5900, "BOUNCE", 65),
            resistance_analysis=make_resistance(5950, "BOUNCE", 60),
        )
        # dist_to_support = (5910-5900)/50 * 100 = 20% → < 30% → near support
        self.assertEqual(result["setup_type"], "BOUNCE_SUPPORT")

    def test_wrong_direction_blocked(self):
        """AI says GO_CALL but structure says BREAKDOWN_SUPPORT (GO_PUT) → misaligned."""
        result = classify_bounce_breakdown(
            ltp=24050,
            direction="GO_CALL",
            support_analysis=make_support(24000, "BREAKDOWN", 60),
            resistance_analysis=make_resistance(24500, "BOUNCE", 65),
        )
        self.assertEqual(result["setup_type"], "BREAKDOWN_SUPPORT")
        self.assertEqual(result["required_direction"], "GO_PUT")
        self.assertFalse(result["aligned"])


# =============================================================================
# Runner
# =============================================================================

if __name__ == "__main__":
    # Run with verbose output
    unittest.main(verbosity=2)
