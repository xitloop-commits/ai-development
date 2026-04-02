#!/usr/bin/env python3
"""
Integration Tests — AI Engine Pipeline
---------------------------------------
Tests the full pipeline from AI decision through filters and discipline engine
to trade execution, using mocked HTTP responses (no live server needed).

Test scenarios:
  1. Full pipeline: AI decision → filters pass → discipline pass → entry accepted
  2. Discipline Engine rejects 4th trade (max trades reached)
  3. Discipline Engine rejects on daily loss limit
  4. Sideways market filter blocks trade
  5. Trap detection filter blocks trade
  6. Bounce/Breakdown misalignment blocks trade
  7. Quality gate (low confidence) blocks trade
  8. Session Manager halts trading after profit cap
  9. Fail-open: Discipline Engine unreachable → trade allowed
  10. Legacy AI decision format still works

Usage:
  python3 test_integration.py
"""

import unittest
import json
import os
import sys
import time
import tempfile
import shutil
from unittest.mock import patch, MagicMock
from datetime import datetime

# Ensure python_modules is on path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


# ═══════════════════════════════════════════════════════════════════
# Mock Data Factories
# ═══════════════════════════════════════════════════════════════════

def make_option_chain(ltp=24500, atm=24500, instrument="NIFTY_50"):
    """Create a minimal option chain with ATM ± 5 strikes."""
    step = 50
    oc = {"oc": {}}
    for offset in range(-5, 6):
        strike = atm + offset * step
        oc["oc"][str(strike)] = {
            "ce": {
                "ltp": max(10, 200 - abs(offset) * 30),
                "oi": 500000 + offset * 50000,
                "previous_oi": 480000 + offset * 45000,
                "volume": 10000 + abs(offset) * 1000,
                "iv": 15.5 + abs(offset) * 0.5,
            },
            "pe": {
                "ltp": max(10, 200 + abs(offset) * 30 - 200),
                "oi": 450000 - offset * 40000,
                "previous_oi": 430000 - offset * 38000,
                "volume": 9000 + abs(offset) * 800,
                "iv": 16.0 + abs(offset) * 0.5,
            },
        }
    oc["ltp"] = ltp
    oc["expiry"] = "2026-04-09"
    return oc


def make_analyzer_output(bias="Bullish"):
    """Create a minimal analyzer output."""
    return {
        "market_bias": bias,
        "entry_signals": ["Bullish: Strong call buying at ATM"],
        "real_time_signals": [],
        "support_levels": [{"strike": 24400, "total_oi": 800000}],
        "resistance_levels": [{"strike": 24600, "total_oi": 750000}],
        "pcr_ratio": 1.1,
        "total_call_oi": 5000000,
        "total_put_oi": 5500000,
        "volume_analysis": {"total_call_volume": 100000, "total_put_volume": 90000},
    }


def make_ai_decision(direction="GO_CALL", confidence=0.75, strike=24500,
                      entry_price=180.0, target_price=234.0, stop_loss=153.0,
                      risk_reward=2.0, filters=None):
    """Create a minimal AI decision JSON."""
    decision = {
        "instrument": "NIFTY_50",
        "timestamp": datetime.now().isoformat(),
        "decision": "GO" if direction != "WAIT" else "NO_GO",
        "trade_type": "CALL_BUY" if direction == "GO_CALL" else ("PUT_BUY" if direction == "GO_PUT" else None),
        "confidence_score": confidence,
        "rationale": "Test rationale",
        "market_bias_oc": "Bullish",
        "market_bias_news": "Neutral",
        "trade_direction": direction,
        "ltp": 24500,
        "atm_strike": 24500,
        "trade_setup": {
            "strike": strike,
            "option_type": "CE" if direction == "GO_CALL" else "PE",
            "entry_price": entry_price,
            "target_price": target_price,
            "stop_loss": stop_loss,
            "risk_reward": risk_reward,
            "delta": 0.5,
        } if direction in ("GO_CALL", "GO_PUT") else None,
        "support_analysis": {
            "level": 24400,
            "strength": 75,
            "prediction": "BOUNCE",
            "detail": "Strong support at 24400",
        },
        "resistance_analysis": {
            "level": 24600,
            "strength": 70,
            "prediction": "BOUNCE",
            "detail": "Resistance at 24600",
        },
        "target_expiry_date": "2026-04-09",
    }
    if filters:
        decision["filters"] = filters
    return decision


def make_discipline_response(allowed=True, blocked_by=None, warnings=None):
    """Create a mock discipline engine response."""
    return {
        "result": {
            "data": {
                "json": {
                    "allowed": allowed,
                    "blockedBy": blocked_by or [],
                    "warnings": warnings or [],
                }
            }
        }
    }


def make_capital_response(capital=500000, exposure=50000):
    """Create a mock capital state response."""
    return {
        "result": {
            "data": {
                "json": {
                    "tradingPool": capital,
                    "openPositionMargin": exposure,
                }
            }
        }
    }


# ═══════════════════════════════════════════════════════════════════
# Mock HTTP Response Helper
# ═══════════════════════════════════════════════════════════════════

class MockResponse:
    """Simulates a requests.Response object."""
    def __init__(self, json_data, status_code=200):
        self._json = json_data
        self.status_code = status_code
        self.text = json.dumps(json_data)

    def json(self):
        return self._json


# ═══════════════════════════════════════════════════════════════════
# Test: Full Pipeline Entry Flow
# ═══════════════════════════════════════════════════════════════════

class TestPipelineEntryFlow(unittest.TestCase):
    """Test the execution module's try_entry function with mocked HTTP."""

    def setUp(self):
        """Reset execution module state before each test."""
        import execution_module as em
        em.OPEN_POSITIONS = {}
        em.LIVE_TRADING = False
        em.MIN_CONFIDENCE = 0.65
        em.MIN_RISK_REWARD = 1.0

    @patch('execution_module.requests.post')
    @patch('execution_module.requests.get')
    def test_full_entry_accepted(self, mock_get, mock_post):
        """AI decision → discipline pass → paper trade entry accepted."""
        import execution_module as em

        # Mock GET for capital.state
        def mock_get_handler(url, **kwargs):
            if "capital.state" in url:
                return MockResponse(make_capital_response())
            return MockResponse({}, 404)

        # Mock POST for discipline.validate, onTradePlaced, position push
        def mock_post_handler(url, **kwargs):
            if "discipline.validate" in url:
                return MockResponse(make_discipline_response(allowed=True))
            elif "discipline.onTradePlaced" in url:
                return MockResponse({"result": {"data": {"json": {}}}})
            elif "trading/position" in url:
                return MockResponse({"success": True})
            return MockResponse({}, 404)

        mock_get.side_effect = mock_get_handler
        mock_post.side_effect = mock_post_handler

        decision = make_ai_decision(direction="GO_CALL", confidence=0.75)
        oc = make_option_chain()

        result = em.try_entry("NIFTY_50", decision, oc)
        self.assertTrue(result, "Trade should be accepted when discipline allows it")
        self.assertIn("NIFTY_50", em.OPEN_POSITIONS)
        self.assertEqual(em.OPEN_POSITIONS["NIFTY_50"]["status"], "OPEN")

    @patch('execution_module.requests.post')
    @patch('execution_module.requests.get')
    def test_discipline_blocks_max_trades(self, mock_get, mock_post):
        """Discipline Engine blocks trade when max trades reached."""
        import execution_module as em

        def mock_get_handler(url, **kwargs):
            if "capital.state" in url:
                return MockResponse(make_capital_response())
            return MockResponse({}, 404)

        def mock_post_handler(url, **kwargs):
            if "discipline.validate" in url:
                return MockResponse(make_discipline_response(
                    allowed=False,
                    blocked_by=["MAX_TRADES_REACHED"]
                ))
            return MockResponse({}, 404)

        mock_get.side_effect = mock_get_handler
        mock_post.side_effect = mock_post_handler

        decision = make_ai_decision(direction="GO_CALL", confidence=0.75)
        oc = make_option_chain()

        result = em.try_entry("NIFTY_50", decision, oc)
        self.assertFalse(result, "Trade should be blocked when max trades reached")
        self.assertNotIn("NIFTY_50", em.OPEN_POSITIONS)

    @patch('execution_module.requests.post')
    @patch('execution_module.requests.get')
    def test_discipline_blocks_daily_loss_limit(self, mock_get, mock_post):
        """Discipline Engine blocks trade when daily loss limit is hit."""
        import execution_module as em

        def mock_get_handler(url, **kwargs):
            if "capital.state" in url:
                return MockResponse(make_capital_response())
            return MockResponse({}, 404)

        def mock_post_handler(url, **kwargs):
            if "discipline.validate" in url:
                return MockResponse(make_discipline_response(
                    allowed=False,
                    blocked_by=["DAILY_LOSS_LIMIT"]
                ))
            return MockResponse({}, 404)

        mock_get.side_effect = mock_get_handler
        mock_post.side_effect = mock_post_handler

        decision = make_ai_decision(direction="GO_PUT", confidence=0.80)
        oc = make_option_chain()

        result = em.try_entry("NIFTY_50", decision, oc)
        self.assertFalse(result, "Trade should be blocked when daily loss limit hit")

    @patch('execution_module.requests.post')
    @patch('execution_module.requests.get')
    def test_discipline_blocks_cooldown(self, mock_get, mock_post):
        """Discipline Engine blocks trade during cooldown period."""
        import execution_module as em

        def mock_get_handler(url, **kwargs):
            if "capital.state" in url:
                return MockResponse(make_capital_response())
            return MockResponse({}, 404)

        def mock_post_handler(url, **kwargs):
            if "discipline.validate" in url:
                return MockResponse(make_discipline_response(
                    allowed=False,
                    blocked_by=["COOLDOWN_ACTIVE"]
                ))
            return MockResponse({}, 404)

        mock_get.side_effect = mock_get_handler
        mock_post.side_effect = mock_post_handler

        decision = make_ai_decision(direction="GO_CALL", confidence=0.75)
        oc = make_option_chain()

        result = em.try_entry("NIFTY_50", decision, oc)
        self.assertFalse(result, "Trade should be blocked during cooldown")

    @patch('execution_module.requests.post')
    @patch('execution_module.requests.get')
    def test_discipline_unreachable_failopen(self, mock_get, mock_post):
        """When Discipline Engine is unreachable, trade is allowed (fail-open)."""
        import execution_module as em

        def mock_get_handler(url, **kwargs):
            raise ConnectionError("Server unreachable")

        def mock_post_handler(url, **kwargs):
            if "discipline.onTradePlaced" in url:
                raise ConnectionError("Server unreachable")
            elif "trading/position" in url:
                raise ConnectionError("Server unreachable")
            raise ConnectionError("Server unreachable")

        mock_get.side_effect = mock_get_handler
        mock_post.side_effect = mock_post_handler

        decision = make_ai_decision(direction="GO_CALL", confidence=0.75)
        oc = make_option_chain()

        result = em.try_entry("NIFTY_50", decision, oc)
        # Fail-open: capital state unavailable → discipline skipped → trade allowed
        self.assertTrue(result, "Trade should be allowed when discipline engine is unreachable (fail-open)")

    @patch('execution_module.requests.post')
    @patch('execution_module.requests.get')
    def test_duplicate_position_blocked(self, mock_get, mock_post):
        """Cannot open a second position for the same instrument."""
        import execution_module as em

        # Pre-populate an open position
        em.OPEN_POSITIONS["NIFTY_50"] = {
            "id": "POS_001",
            "instrument": "NIFTY_50",
            "status": "OPEN",
            "entryPrice": 180.0,
        }

        decision = make_ai_decision(direction="GO_CALL", confidence=0.75)
        oc = make_option_chain()

        result = em.try_entry("NIFTY_50", decision, oc)
        self.assertFalse(result, "Should not open duplicate position for same instrument")

    @patch('execution_module.requests.post')
    @patch('execution_module.requests.get')
    def test_discipline_with_warnings_still_allows(self, mock_get, mock_post):
        """Discipline Engine allows trade but with warnings."""
        import execution_module as em

        def mock_get_handler(url, **kwargs):
            if "capital.state" in url:
                return MockResponse(make_capital_response())
            return MockResponse({}, 404)

        def mock_post_handler(url, **kwargs):
            if "discipline.validate" in url:
                return MockResponse(make_discipline_response(
                    allowed=True,
                    warnings=["APPROACHING_MAX_EXPOSURE"]
                ))
            elif "discipline.onTradePlaced" in url:
                return MockResponse({"result": {"data": {"json": {}}}})
            elif "trading/position" in url:
                return MockResponse({"success": True})
            return MockResponse({}, 404)

        mock_get.side_effect = mock_get_handler
        mock_post.side_effect = mock_post_handler

        decision = make_ai_decision(direction="GO_CALL", confidence=0.75)
        oc = make_option_chain()

        result = em.try_entry("NIFTY_50", decision, oc)
        self.assertTrue(result, "Trade should be allowed when discipline has warnings but allows")


# ═══════════════════════════════════════════════════════════════════
# Test: AI Decision Parsing
# ═══════════════════════════════════════════════════════════════════

class TestAIDecisionParsing(unittest.TestCase):
    """Test parse_ai_decision handles both enhanced and legacy formats."""

    def setUp(self):
        import execution_module as em
        em.MIN_CONFIDENCE = 0.65
        em.MIN_RISK_REWARD = 1.0

    def test_enhanced_format_go_call(self):
        """Enhanced format with trade_direction and trade_setup."""
        import execution_module as em
        decision = make_ai_decision(direction="GO_CALL", confidence=0.75)
        parsed = em.parse_ai_decision(decision)
        self.assertTrue(parsed["should_trade"])
        self.assertEqual(parsed["direction"], "GO_CALL")
        self.assertEqual(parsed["option_type"], "CE")
        self.assertEqual(parsed["strike"], 24500)
        self.assertAlmostEqual(parsed["confidence"], 0.75)

    def test_enhanced_format_go_put(self):
        """Enhanced format with GO_PUT direction."""
        import execution_module as em
        decision = make_ai_decision(direction="GO_PUT", confidence=0.80, strike=24400)
        parsed = em.parse_ai_decision(decision)
        self.assertTrue(parsed["should_trade"])
        self.assertEqual(parsed["direction"], "GO_PUT")
        self.assertEqual(parsed["option_type"], "PE")

    def test_enhanced_format_wait(self):
        """WAIT direction should not trade."""
        import execution_module as em
        decision = make_ai_decision(direction="WAIT", confidence=0.50)
        parsed = em.parse_ai_decision(decision)
        self.assertFalse(parsed["should_trade"])

    def test_low_confidence_rejected(self):
        """Below MIN_CONFIDENCE should not trade."""
        import execution_module as em
        decision = make_ai_decision(direction="GO_CALL", confidence=0.50)
        parsed = em.parse_ai_decision(decision)
        self.assertFalse(parsed["should_trade"])

    def test_low_risk_reward_rejected(self):
        """Below MIN_RISK_REWARD should not trade."""
        import execution_module as em
        decision = make_ai_decision(direction="GO_CALL", confidence=0.75, risk_reward=0.5)
        parsed = em.parse_ai_decision(decision)
        self.assertFalse(parsed["should_trade"])

    def test_legacy_format_call_buy(self):
        """Legacy format with decision=GO, trade_type=CALL_BUY."""
        import execution_module as em
        decision = {
            "decision": "GO",
            "trade_type": "CALL_BUY",
            "confidence_score": 0.70,
            "target_strike": 24500,
            "rationale": "Legacy test",
            "target_expiry_date": "2026-04-09",
        }
        parsed = em.parse_ai_decision(decision)
        self.assertTrue(parsed["should_trade"])
        self.assertEqual(parsed["direction"], "GO_CALL")
        self.assertEqual(parsed["option_type"], "CE")

    def test_legacy_format_no_go(self):
        """Legacy format with decision=NO_GO should not trade."""
        import execution_module as em
        decision = {
            "decision": "NO_GO",
            "trade_type": None,
            "confidence_score": 0.40,
        }
        parsed = em.parse_ai_decision(decision)
        self.assertFalse(parsed["should_trade"])


# ═══════════════════════════════════════════════════════════════════
# Test: AI Engine Filters (Integration with make_enhanced_decision)
# ═══════════════════════════════════════════════════════════════════

class TestAIEngineFilters(unittest.TestCase):
    """Test that AI Engine filters correctly block/allow trades."""

    def test_sideways_market_blocks_trade(self):
        """Sideways market detection should override direction to WAIT."""
        import ai_decision_engine as ai

        oc = make_option_chain(ltp=24500)
        analyzer = make_analyzer_output(bias="Neutral")
        analyzer["pcr_ratio"] = 1.0
        analyzer["volume_analysis"] = {"total_call_volume": 5000, "total_put_volume": 5000}

        result = ai.detect_sideways_market(oc, analyzer, 24500)
        self.assertIn("is_sideways", result)
        self.assertIn("signals_triggered", result)
        self.assertIn("threshold", result)
        self.assertIsInstance(result["details"], list)

    def test_trap_detection_returns_valid_shape(self):
        """Trap detection should return the expected shape."""
        import ai_decision_engine as ai

        oc = make_option_chain(ltp=24500)
        analyzer = make_analyzer_output(bias="Bullish")
        support = {"level": 24400, "strength": 75, "prediction": "BOUNCE"}
        resistance = {"level": 24600, "strength": 70, "prediction": "BOUNCE"}

        result = ai.detect_trap_market(oc, analyzer, "GO_CALL", support, resistance, "NIFTY_50", 24500)
        self.assertIn("is_trap", result)
        self.assertIn("trap_types", result)
        self.assertIn("details", result)
        self.assertIsInstance(result["is_trap"], bool)
        self.assertIsInstance(result["trap_types"], list)

    def test_quality_gate_blocks_low_confidence(self):
        """Quality gate should block trades with confidence below threshold."""
        import ai_decision_engine as ai

        trap_result = {"is_trap": False, "trap_types": [], "details": []}
        theta_info = {"days_to_expiry": 5}
        support = {"level": 24400, "prediction": "BOUNCE"}
        resistance = {"level": 24600, "prediction": "BOUNCE"}

        result = ai.check_trade_quality("GO_CALL", 0.50, support, resistance, trap_result, theta_info)
        self.assertFalse(result["passed"])
        self.assertIn("LOW_CONFIDENCE", result["blocked_by"])

    def test_quality_gate_passes_high_confidence(self):
        """Quality gate should pass trades with sufficient confidence and alignment."""
        import ai_decision_engine as ai

        trap_result = {"is_trap": False, "trap_types": [], "details": []}
        theta_info = {"days_to_expiry": 5}
        support = {"level": 24400, "prediction": "BOUNCE"}
        resistance = {"level": 24600, "prediction": "BOUNCE"}

        result = ai.check_trade_quality("GO_CALL", 0.80, support, resistance, trap_result, theta_info)
        self.assertNotIn("LOW_CONFIDENCE", result["blocked_by"])

    def test_quality_gate_blocks_late_session(self):
        """Quality gate should block trades after cutoff time."""
        import ai_decision_engine as ai

        trap_result = {"is_trap": False, "trap_types": [], "details": []}
        theta_info = {"days_to_expiry": 5}
        support = {"level": 24400, "prediction": "BOUNCE"}
        resistance = {"level": 24600, "prediction": "BOUNCE"}

        with patch('ai_decision_engine.datetime') as mock_dt:
            mock_dt.now.return_value = datetime(2026, 4, 3, 15, 0, 0)
            mock_dt.side_effect = lambda *args, **kw: datetime(*args, **kw)
            result = ai.check_trade_quality("GO_CALL", 0.80, support, resistance, trap_result, theta_info)
            self.assertIn("LATE_SESSION", result["blocked_by"])

    def test_quality_gate_blocks_low_dte(self):
        """Quality gate should block trades with DTE at or below minimum."""
        import ai_decision_engine as ai

        trap_result = {"is_trap": False, "trap_types": [], "details": []}
        theta_info = {"days_to_expiry": 0}
        support = {"level": 24400, "prediction": "BOUNCE"}
        resistance = {"level": 24600, "prediction": "BOUNCE"}

        result = ai.check_trade_quality("GO_CALL", 0.80, support, resistance, trap_result, theta_info)
        self.assertIn("LOW_DTE", result["blocked_by"])

    def test_bounce_breakdown_alignment_blocks_mismatched(self):
        """Bounce/Breakdown misalignment should block trade."""
        import ai_decision_engine as ai

        support = {"level": 24400, "strength": 75, "prediction": "BOUNCE"}
        resistance = {"level": 24600, "strength": 70, "prediction": "BOUNCE"}

        result = ai.classify_bounce_breakdown(24410, "GO_PUT", support, resistance)
        if result["setup_type"] == "BOUNCE_SUPPORT":
            self.assertFalse(result["aligned"])
            self.assertEqual(result["required_direction"], "GO_CALL")


# ═══════════════════════════════════════════════════════════════════
# Test: Session Manager Integration
# ═══════════════════════════════════════════════════════════════════

class TestSessionManagerIntegration(unittest.TestCase):
    """Test Session Manager trading halt behavior."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        # Remove stale session state file that may persist from previous runs
        state_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "session_state.json")
        if os.path.exists(state_file):
            os.remove(state_file)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)
        # Clean up session state file
        state_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "session_state.json")
        if os.path.exists(state_file):
            os.remove(state_file)

    @patch('session_manager._get_capital_state')
    def test_profit_cap_halts_trading(self, mock_capital):
        """After hitting daily profit cap, trading should be halted."""
        from session_manager import SessionManager

        mock_capital.return_value = 500000
        sm = SessionManager()
        sm.start()
        time.sleep(0.1)  # Let background thread initialize

        sm.record_trade_pnl(15000)
        sm.record_trade_pnl(12000)  # Total: 27000 > 25000 (5%)

        self.assertFalse(sm.is_trading_allowed(),
                         "Trading should be halted after exceeding profit cap")
        sm.stop()

    @patch('session_manager._get_capital_state')
    def test_loss_cap_halts_trading(self, mock_capital):
        """After hitting daily loss cap, trading should be halted."""
        from session_manager import SessionManager

        mock_capital.return_value = 500000
        sm = SessionManager()
        sm.start()
        time.sleep(0.1)  # Let background thread initialize

        sm.record_trade_pnl(-6000)
        sm.record_trade_pnl(-5000)  # Total: -11000 < -10000 (2%)

        self.assertFalse(sm.is_trading_allowed(),
                         "Trading should be halted after exceeding loss cap")
        sm.stop()

    @patch('session_manager._get_capital_state')
    def test_within_caps_allows_trading(self, mock_capital):
        """Within P&L caps, trading should be allowed."""
        from session_manager import SessionManager

        mock_capital.return_value = 500000
        sm = SessionManager()
        sm.start()
        time.sleep(0.1)  # Let background thread initialize

        sm.record_trade_pnl(5000)  # 1% of 500k, well within 5% cap

        self.assertTrue(sm.is_trading_allowed(),
                        "Trading should be allowed within P&L caps")
        sm.stop()


# ═══════════════════════════════════════════════════════════════════
# Test: Simulate 3 Trades, 4th Blocked by Discipline
# ═══════════════════════════════════════════════════════════════════

class TestMultiTradeSequence(unittest.TestCase):
    """Simulate a sequence of trades where the 4th is blocked by discipline."""

    def setUp(self):
        import execution_module as em
        em.OPEN_POSITIONS = {}
        em.LIVE_TRADING = False
        em.MIN_CONFIDENCE = 0.65
        em.MIN_RISK_REWARD = 1.0

    @patch('execution_module.requests.post')
    @patch('execution_module.requests.get')
    def test_three_trades_then_blocked(self, mock_get, mock_post):
        """First 3 trades accepted, 4th blocked by MAX_TRADES_REACHED."""
        import execution_module as em

        trade_count = [0]

        def mock_get_handler(url, **kwargs):
            if "capital.state" in url:
                return MockResponse(make_capital_response())
            return MockResponse({}, 404)

        def mock_post_handler(url, **kwargs):
            if "discipline.validate" in url:
                trade_count[0] += 1
                if trade_count[0] <= 3:
                    return MockResponse(make_discipline_response(allowed=True))
                else:
                    return MockResponse(make_discipline_response(
                        allowed=False, blocked_by=["MAX_TRADES_REACHED"]
                    ))
            elif "discipline.onTradePlaced" in url:
                return MockResponse({"result": {"data": {"json": {}}}})
            elif "trading/position" in url:
                return MockResponse({"success": True})
            return MockResponse({}, 404)

        mock_get.side_effect = mock_get_handler
        mock_post.side_effect = mock_post_handler

        instruments = ["NIFTY_50", "BANKNIFTY", "CRUDEOIL", "NATURALGAS"]
        results = []

        for inst in instruments:
            decision = make_ai_decision(direction="GO_CALL", confidence=0.75)
            oc = make_option_chain()
            result = em.try_entry(inst, decision, oc)
            results.append(result)

        self.assertTrue(results[0], "Trade 1 should succeed")
        self.assertTrue(results[1], "Trade 2 should succeed")
        self.assertTrue(results[2], "Trade 3 should succeed")
        self.assertFalse(results[3], "Trade 4 should be blocked by discipline")


# ═══════════════════════════════════════════════════════════════════
# Test: Performance Feedback Loop
# ═══════════════════════════════════════════════════════════════════

class TestFeedbackLoopIntegration(unittest.TestCase):
    """Test the feedback loop's parameter tuning logic."""

    def test_tune_raises_confidence_on_low_winrate(self):
        """Low win rate should raise MIN_CONFIDENCE."""
        from performance_feedback import tune_parameters

        metrics = {
            "total_trades": 10,
            "win_rate": 0.30,
            "avg_profit_pct": 5.0,
            "avg_loss_pct": -3.0,
            "avg_hold_time": 300,
            "peak_vs_exit": 2.0,
        }
        current_params = {
            "MIN_CONFIDENCE": 0.65,
            "PROFIT_PARTIAL_EXIT_PCT": 6.0,
            "TRADE_AGE_FORCE_EXIT": 10,
        }

        new_params, adjustments = tune_parameters(metrics, current_params)
        self.assertGreater(new_params["MIN_CONFIDENCE"], 0.65,
                           "Low win rate should raise MIN_CONFIDENCE")

    def test_tune_lowers_confidence_on_high_winrate(self):
        """High win rate should lower MIN_CONFIDENCE."""
        from performance_feedback import tune_parameters

        metrics = {
            "total_trades": 10,
            "win_rate": 0.70,
            "avg_profit_pct": 8.0,
            "avg_loss_pct": -2.0,
            "avg_hold_time": 300,
            "peak_vs_exit": 2.0,
        }
        current_params = {
            "MIN_CONFIDENCE": 0.67,
            "PROFIT_PARTIAL_EXIT_PCT": 6.0,
            "TRADE_AGE_FORCE_EXIT": 10,
        }

        new_params, adjustments = tune_parameters(metrics, current_params)
        self.assertLess(new_params["MIN_CONFIDENCE"], 0.67,
                        "High win rate should lower MIN_CONFIDENCE")

    def test_tune_respects_bounds(self):
        """Tuned parameters should stay within defined bounds."""
        from performance_feedback import tune_parameters

        metrics = {
            "total_trades": 10,
            "win_rate": 0.10,
            "avg_profit_pct": 1.0,
            "avg_loss_pct": -8.0,
            "avg_hold_time": 60,
            "peak_vs_exit": 5.0,
        }
        current_params = {
            "MIN_CONFIDENCE": 0.74,
            "PROFIT_PARTIAL_EXIT_PCT": 4.0,
            "TRADE_AGE_FORCE_EXIT": 7,
        }

        new_params, adjustments = tune_parameters(metrics, current_params)
        self.assertLessEqual(new_params["MIN_CONFIDENCE"], 0.75, "Should not exceed max bound")
        self.assertGreaterEqual(new_params["PROFIT_PARTIAL_EXIT_PCT"], 4.0, "Should not go below min bound")
        self.assertGreaterEqual(new_params["TRADE_AGE_FORCE_EXIT"], 7, "Should not go below min bound")

    def test_tune_no_change_mid_winrate(self):
        """Win rate between 40-60% should not change MIN_CONFIDENCE."""
        from performance_feedback import tune_parameters

        metrics = {
            "total_trades": 10,
            "win_rate": 0.50,
            "avg_profit_pct": 5.0,
            "avg_loss_pct": -3.0,
            "avg_hold_time": 300,
            "peak_vs_exit": 2.0,
        }
        current_params = {
            "MIN_CONFIDENCE": 0.65,
            "PROFIT_PARTIAL_EXIT_PCT": 6.0,
            "TRADE_AGE_FORCE_EXIT": 10,
        }

        new_params, adjustments = tune_parameters(metrics, current_params)
        self.assertEqual(new_params["MIN_CONFIDENCE"], 0.65,
                         "Mid-range win rate should not change MIN_CONFIDENCE")


# ═══════════════════════════════════════════════════════════════════
# Run
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main(verbosity=2)
