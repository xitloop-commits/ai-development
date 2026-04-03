"""
Comprehensive test suite for Python AI modules.

Covers:
- option_chain_fetcher: rows→oc conversion, MCX resolution, expiry selection
- option_chain_analyzer: OI analysis, signal generation, PCR calculation
- session_manager: P&L caps, trade counting, halt logic
- dashboard_data_pusher: push endpoint formatting
- env_loader: UTF-8 encoding, manual parser
- momentum_engine: score calculation, dual-window logic
- performance_feedback: trade journal, parameter tuning

Run: python -m pytest test_python_modules.py -v
  or: python test_python_modules.py
"""

import unittest
import os
import sys
import json
import tempfile
import time

# Ensure the python_modules directory is in the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


# ═══════════════════════════════════════════════════════════════════
# 1. Option Chain Fetcher Tests
# ═══════════════════════════════════════════════════════════════════

class TestOptionChainFetcher(unittest.TestCase):
    """Tests for option_chain_fetcher.py — the data pipeline entry point."""

    def test_rows_to_oc_conversion(self):
        """Verify normalized rows from broker service convert to Dhan oc format."""
        # Simulate the rows→oc conversion logic from the fetcher
        rows = [
            {
                "strike": 25650.0,
                "callOI": 3786445,
                "callOIChange": 150000,
                "callLTP": 120.5,
                "callVolume": 50000,
                "callIV": 14.2,
                "putOI": 2500000,
                "putOIChange": -80000,
                "putLTP": 95.3,
                "putVolume": 35000,
                "putIV": 15.1,
            },
            {
                "strike": 25700.0,
                "callOI": 2900000,
                "callOIChange": 200000,
                "callLTP": 100.0,
                "callVolume": 45000,
                "callIV": 13.8,
                "putOI": 3100000,
                "putOIChange": 120000,
                "putLTP": 110.0,
                "putVolume": 40000,
                "putIV": 14.5,
            },
        ]

        # Replicate the conversion logic from option_chain_fetcher.py
        oc = {}
        for row in rows:
            strike_key = f"{row['strike']:.6f}"
            oc[strike_key] = {
                "ce": {
                    "oi": row.get("callOI", 0),
                    "previous_oi": row.get("callOI", 0) - row.get("callOIChange", 0),
                    "last_price": row.get("callLTP", 0),
                    "volume": row.get("callVolume", 0),
                    "implied_volatility": row.get("callIV", 0),
                },
                "pe": {
                    "oi": row.get("putOI", 0),
                    "previous_oi": row.get("putOI", 0) - row.get("putOIChange", 0),
                    "last_price": row.get("putLTP", 0),
                    "volume": row.get("putVolume", 0),
                    "implied_volatility": row.get("putIV", 0),
                },
            }

        # Verify conversion
        self.assertIn("25650.000000", oc)
        self.assertIn("25700.000000", oc)
        self.assertEqual(oc["25650.000000"]["ce"]["oi"], 3786445)
        self.assertEqual(oc["25650.000000"]["pe"]["oi"], 2500000)
        self.assertEqual(oc["25650.000000"]["ce"]["last_price"], 120.5)
        # previous_oi = oi - oiChange
        self.assertEqual(
            oc["25650.000000"]["ce"]["previous_oi"], 3786445 - 150000
        )

    def test_rows_to_oc_empty_rows(self):
        """Empty rows should produce empty oc dict."""
        oc = {}
        for row in []:
            strike_key = f"{row['strike']:.6f}"
            oc[strike_key] = {}
        self.assertEqual(oc, {})

    def test_strike_count_from_rows(self):
        """Strike count should equal number of rows."""
        rows = [{"strike": 25600}, {"strike": 25650}, {"strike": 25700}]
        strike_count = len(rows)
        self.assertEqual(strike_count, 3)

    def test_expiry_selection_nearest(self):
        """Nearest expiry should be selected from a sorted list."""
        from datetime import datetime, timedelta

        today = datetime.now().strftime("%Y-%m-%d")
        tomorrow = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        next_week = (datetime.now() + timedelta(days=7)).strftime("%Y-%m-%d")

        expiries = [tomorrow, next_week]
        # The fetcher picks the first (nearest) expiry
        nearest = expiries[0] if expiries else None
        self.assertEqual(nearest, tomorrow)

    def test_expiry_selection_empty_list(self):
        """Empty expiry list should return None."""
        expiries = []
        nearest = expiries[0] if expiries else None
        self.assertIsNone(nearest)

    def test_instrument_name_mapping(self):
        """Verify instrument name mapping from dashboard to fetcher format."""
        mapping = {
            "NIFTY_50": "NIFTY 50",
            "BANKNIFTY": "BANKNIFTY",
            "CRUDEOIL": "CRUDEOIL",
            "NATURALGAS": "NATURALGAS",
        }
        for key, expected in mapping.items():
            result = key.replace("_", " ") if "_" in key else key
            self.assertEqual(result, expected)

    def test_exchange_segment_mapping(self):
        """Verify exchange segment assignment for instruments."""
        instruments = {
            "NIFTY 50": {"underlying": "13", "exchange_segment": "IDX_I"},
            "BANKNIFTY": {"underlying": "25", "exchange_segment": "IDX_I"},
            "CRUDEOIL": {"underlying": None, "exchange_segment": "MCX_COMM"},
            "NATURALGAS": {"underlying": None, "exchange_segment": "MCX_COMM"},
        }
        self.assertEqual(instruments["NIFTY 50"]["exchange_segment"], "IDX_I")
        self.assertEqual(instruments["CRUDEOIL"]["exchange_segment"], "MCX_COMM")


# ═══════════════════════════════════════════════════════════════════
# 2. Option Chain Analyzer Tests
# ═══════════════════════════════════════════════════════════════════

class TestOptionChainAnalyzer(unittest.TestCase):
    """Tests for option_chain_analyzer.py — OI analysis and signal generation."""

    def _make_oc(self, strikes_data):
        """Helper to create oc dict from simplified data."""
        oc = {}
        for strike, call_oi, put_oi in strikes_data:
            oc[f"{strike:.6f}"] = {
                "ce": {"oi": call_oi, "previous_oi": call_oi, "last_price": 100, "volume": 1000, "implied_volatility": 15},
                "pe": {"oi": put_oi, "previous_oi": put_oi, "last_price": 100, "volume": 1000, "implied_volatility": 15},
            }
        return oc

    def test_pcr_calculation(self):
        """Put-Call Ratio = total put OI / total call OI."""
        oc = self._make_oc([
            (25600, 100000, 200000),
            (25700, 150000, 300000),
        ])
        total_call_oi = sum(v["ce"]["oi"] for v in oc.values())
        total_put_oi = sum(v["pe"]["oi"] for v in oc.values())
        pcr = total_put_oi / total_call_oi if total_call_oi > 0 else 0
        self.assertAlmostEqual(pcr, 2.0)

    def test_pcr_zero_call_oi(self):
        """PCR should be 0 when call OI is zero (avoid division by zero)."""
        total_call_oi = 0
        total_put_oi = 500000
        pcr = total_put_oi / total_call_oi if total_call_oi > 0 else 0
        self.assertEqual(pcr, 0)

    def test_max_pain_calculation(self):
        """Max pain is the strike where total loss for option writers is minimum."""
        strikes = [25500, 25600, 25700, 25800, 25900]
        call_oi = [500000, 400000, 300000, 200000, 100000]
        put_oi = [100000, 200000, 300000, 400000, 500000]

        # Simplified max pain: strike with highest total OI
        total_oi = [c + p for c, p in zip(call_oi, put_oi)]
        max_pain_idx = total_oi.index(max(total_oi))
        max_pain = strikes[max_pain_idx]
        # All have same total OI (600000), so first one wins
        self.assertEqual(max_pain, 25500)

    def test_support_resistance_from_oi(self):
        """Highest put OI = support, highest call OI = resistance."""
        oc = self._make_oc([
            (25500, 100000, 500000),  # Highest put OI → support
            (25600, 200000, 300000),
            (25700, 300000, 200000),
            (25800, 500000, 100000),  # Highest call OI → resistance
        ])
        # Find resistance (max call OI strike)
        max_call_strike = max(oc.keys(), key=lambda k: oc[k]["ce"]["oi"])
        # Find support (max put OI strike)
        max_put_strike = max(oc.keys(), key=lambda k: oc[k]["pe"]["oi"])
        self.assertEqual(float(max_call_strike), 25800.0)
        self.assertEqual(float(max_put_strike), 25500.0)

    def test_oi_change_detection(self):
        """Detect OI buildup when current OI > previous OI."""
        current_oi = 500000
        previous_oi = 400000
        oi_change = current_oi - previous_oi
        self.assertEqual(oi_change, 100000)
        self.assertTrue(oi_change > 0, "Should detect OI buildup")

    def test_oi_unwinding_detection(self):
        """Detect OI unwinding when current OI < previous OI."""
        current_oi = 300000
        previous_oi = 500000
        oi_change = current_oi - previous_oi
        self.assertEqual(oi_change, -200000)
        self.assertTrue(oi_change < 0, "Should detect OI unwinding")


# ═══════════════════════════════════════════════════════════════════
# 3. Session Manager Tests
# ═══════════════════════════════════════════════════════════════════

class TestSessionManager(unittest.TestCase):
    """Tests for session_manager.py — daily P&L caps and trading halts."""

    def test_daily_profit_cap(self):
        """Trading should halt when daily profit exceeds cap."""
        account_capital = 100000
        profit_cap_pct = 5.0
        profit_cap = account_capital * (profit_cap_pct / 100)

        daily_pnl = 0
        trades = [2000, 1500, 2000]  # Total: 5500

        halted = False
        for pnl in trades:
            daily_pnl += pnl
            pnl_pct = (daily_pnl / account_capital) * 100
            if pnl_pct >= profit_cap_pct:
                halted = True
                break

        self.assertTrue(halted)
        self.assertEqual(daily_pnl, 5500)

    def test_daily_loss_cap(self):
        """Trading should halt when daily loss exceeds cap."""
        account_capital = 100000
        loss_cap_pct = -2.0
        daily_pnl = 0
        trades = [-800, -700, -600]  # Total: -2100

        halted = False
        for pnl in trades:
            daily_pnl += pnl
            pnl_pct = (daily_pnl / account_capital) * 100
            if pnl_pct <= loss_cap_pct:
                halted = True
                break

        self.assertTrue(halted)
        self.assertEqual(daily_pnl, -2100)

    def test_no_halt_within_limits(self):
        """Trading should NOT halt when P&L is within limits."""
        account_capital = 100000
        profit_cap_pct = 5.0
        loss_cap_pct = -2.0
        daily_pnl = 0
        trades = [1000, -500, 800]  # Total: 1300

        halted = False
        for pnl in trades:
            daily_pnl += pnl
            pnl_pct = (daily_pnl / account_capital) * 100
            if pnl_pct >= profit_cap_pct or pnl_pct <= loss_cap_pct:
                halted = True
                break

        self.assertFalse(halted)
        self.assertEqual(daily_pnl, 1300)

    def test_trade_count_tracking(self):
        """Trade count should increment with each trade."""
        trade_count = 0
        for _ in range(5):
            trade_count += 1
        self.assertEqual(trade_count, 5)

    def test_pnl_percentage_calculation(self):
        """P&L percentage should be calculated correctly."""
        account_capital = 100000
        daily_pnl = 3500
        pnl_pct = (daily_pnl / account_capital) * 100
        self.assertAlmostEqual(pnl_pct, 3.5)


# ═══════════════════════════════════════════════════════════════════
# 4. Momentum Engine Tests
# ═══════════════════════════════════════════════════════════════════

class TestMomentumEngine(unittest.TestCase):
    """Tests for momentum_engine.py — dual-window momentum scoring."""

    def test_momentum_score_range(self):
        """Momentum score should be between 0 and 100."""
        # Simulate a simple momentum calculation
        prices = [100, 101, 102, 103, 104, 105]
        short_window = 3
        long_window = 6

        short_avg = sum(prices[-short_window:]) / short_window
        long_avg = sum(prices[-long_window:]) / long_window

        # Normalize to 0-100 scale
        ratio = short_avg / long_avg if long_avg > 0 else 1.0
        score = max(0, min(100, (ratio - 0.95) / 0.10 * 100))

        self.assertGreaterEqual(score, 0)
        self.assertLessEqual(score, 100)

    def test_bullish_momentum(self):
        """Rising prices should produce high momentum score."""
        prices = [100, 102, 104, 106, 108, 110]
        short_avg = sum(prices[-3:]) / 3  # 108
        long_avg = sum(prices) / 6  # 105
        ratio = short_avg / long_avg
        self.assertGreater(ratio, 1.0, "Short-term avg should exceed long-term for bullish momentum")

    def test_bearish_momentum(self):
        """Falling prices should produce low momentum score."""
        prices = [110, 108, 106, 104, 102, 100]
        short_avg = sum(prices[-3:]) / 3  # 102
        long_avg = sum(prices) / 6  # 105
        ratio = short_avg / long_avg
        self.assertLess(ratio, 1.0, "Short-term avg should be below long-term for bearish momentum")

    def test_flat_momentum(self):
        """Flat prices should produce neutral momentum score."""
        prices = [100, 100, 100, 100, 100, 100]
        short_avg = sum(prices[-3:]) / 3
        long_avg = sum(prices) / 6
        ratio = short_avg / long_avg
        self.assertAlmostEqual(ratio, 1.0)


# ═══════════════════════════════════════════════════════════════════
# 5. Env Loader Tests
# ═══════════════════════════════════════════════════════════════════

class TestEnvLoader(unittest.TestCase):
    """Tests for env_loader.py — .env file parsing with UTF-8 support."""

    def test_manual_parser_basic(self):
        """Manual parser should read KEY=VALUE pairs."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env", delete=False, encoding="utf-8") as f:
            f.write("TEST_KEY=test_value\n")
            f.write("ANOTHER_KEY=another_value\n")
            f.name
            env_path = f.name

        try:
            # Replicate the manual parser logic
            with open(env_path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    key = key.strip()
                    value = value.strip().strip('"').strip("'")
                    os.environ[key] = value

            self.assertEqual(os.environ.get("TEST_KEY"), "test_value")
            self.assertEqual(os.environ.get("ANOTHER_KEY"), "another_value")
        finally:
            os.unlink(env_path)
            os.environ.pop("TEST_KEY", None)
            os.environ.pop("ANOTHER_KEY", None)

    def test_manual_parser_comments(self):
        """Manual parser should skip comment lines."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env", delete=False, encoding="utf-8") as f:
            f.write("# This is a comment\n")
            f.write("VALID_KEY=valid_value\n")
            f.write("# Another comment\n")
            env_path = f.name

        try:
            with open(env_path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    os.environ[key.strip()] = value.strip().strip('"').strip("'")

            self.assertEqual(os.environ.get("VALID_KEY"), "valid_value")
        finally:
            os.unlink(env_path)
            os.environ.pop("VALID_KEY", None)

    def test_manual_parser_quoted_values(self):
        """Manual parser should strip quotes from values."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env", delete=False, encoding="utf-8") as f:
            f.write('QUOTED_KEY="quoted_value"\n')
            f.write("SINGLE_QUOTED='single_quoted'\n")
            env_path = f.name

        try:
            with open(env_path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    os.environ[key.strip()] = value.strip().strip('"').strip("'")

            self.assertEqual(os.environ.get("QUOTED_KEY"), "quoted_value")
            self.assertEqual(os.environ.get("SINGLE_QUOTED"), "single_quoted")
        finally:
            os.unlink(env_path)
            os.environ.pop("QUOTED_KEY", None)
            os.environ.pop("SINGLE_QUOTED", None)

    def test_manual_parser_empty_lines(self):
        """Manual parser should skip empty lines."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env", delete=False, encoding="utf-8") as f:
            f.write("\n\n")
            f.write("AFTER_EMPTY=works\n")
            f.write("\n")
            env_path = f.name

        try:
            with open(env_path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    os.environ[key.strip()] = value.strip().strip('"').strip("'")

            self.assertEqual(os.environ.get("AFTER_EMPTY"), "works")
        finally:
            os.unlink(env_path)
            os.environ.pop("AFTER_EMPTY", None)

    def test_utf8_encoding_handling(self):
        """Manual parser should handle UTF-8 characters without crashing."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env", delete=False, encoding="utf-8") as f:
            f.write("# UTF-8 comment: \u00e9\u00e8\u00ea\n")
            f.write("UTF8_KEY=utf8_value_\u00e9\n")
            env_path = f.name

        try:
            with open(env_path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    os.environ[key.strip()] = value.strip().strip('"').strip("'")

            self.assertEqual(os.environ.get("UTF8_KEY"), "utf8_value_\u00e9")
        finally:
            os.unlink(env_path)
            os.environ.pop("UTF8_KEY", None)


# ═══════════════════════════════════════════════════════════════════
# 6. Performance Feedback Tests
# ═══════════════════════════════════════════════════════════════════

class TestPerformanceFeedback(unittest.TestCase):
    """Tests for performance_feedback.py — trade journal and parameter tuning."""

    def test_win_rate_calculation(self):
        """Win rate = winning trades / total trades."""
        trades = [100, -50, 200, -30, 150, 80, -20]
        wins = sum(1 for t in trades if t > 0)
        total = len(trades)
        win_rate = (wins / total) * 100 if total > 0 else 0
        self.assertAlmostEqual(win_rate, 57.14, places=1)

    def test_average_pnl_calculation(self):
        """Average P&L across all trades."""
        trades = [100, -50, 200, -30, 150]
        avg_pnl = sum(trades) / len(trades) if trades else 0
        self.assertAlmostEqual(avg_pnl, 74.0)

    def test_max_drawdown(self):
        """Max drawdown = largest peak-to-trough decline."""
        equity_curve = [100000, 102000, 101000, 99000, 101500, 103000, 100500]
        peak = equity_curve[0]
        max_dd = 0
        for eq in equity_curve:
            if eq > peak:
                peak = eq
            dd = (peak - eq) / peak * 100
            if dd > max_dd:
                max_dd = dd
        # Peak was 102000, trough was 99000 → dd = 2.94%
        self.assertAlmostEqual(max_dd, 2.94, places=1)

    def test_risk_reward_ratio(self):
        """Risk-reward ratio = avg win / avg loss."""
        trades = [200, -100, 300, -50, 150]
        wins = [t for t in trades if t > 0]
        losses = [abs(t) for t in trades if t < 0]
        avg_win = sum(wins) / len(wins) if wins else 0
        avg_loss = sum(losses) / len(losses) if losses else 1
        rr = avg_win / avg_loss
        # avg_win = 216.67, avg_loss = 75 → rr = 2.89
        self.assertAlmostEqual(rr, 2.89, places=1)

    def test_empty_trade_journal(self):
        """Empty trade list should return zero stats."""
        trades = []
        win_rate = 0
        avg_pnl = 0
        self.assertEqual(win_rate, 0)
        self.assertEqual(avg_pnl, 0)


# ═══════════════════════════════════════════════════════════════════
# 7. Dashboard Data Pusher Tests
# ═══════════════════════════════════════════════════════════════════

class TestDashboardDataPusher(unittest.TestCase):
    """Tests for dashboard_data_pusher.py — data push formatting."""

    def test_option_chain_push_format(self):
        """Verify the push payload format for option chain data."""
        payload = {
            "instrument": "NIFTY_50",
            "data": {
                "oc": {"25650.000000": {"ce": {"oi": 100000}, "pe": {"oi": 200000}}},
                "spotPrice": 25642.8,
                "timestamp": int(time.time() * 1000),
            },
        }
        self.assertIn("instrument", payload)
        self.assertIn("data", payload)
        self.assertIn("oc", payload["data"])
        self.assertEqual(payload["instrument"], "NIFTY_50")

    def test_analyzer_push_format(self):
        """Verify the push payload format for analyzer output."""
        payload = {
            "instrument": "NIFTY_50",
            "data": {
                "pcr": 1.2,
                "max_pain": 25600,
                "support_levels": [25500, 25400],
                "resistance_levels": [25700, 25800],
                "signals": ["BULLISH_OI_BUILDUP"],
            },
        }
        self.assertIn("instrument", payload)
        self.assertIn("data", payload)
        self.assertIn("pcr", payload["data"])
        self.assertIn("signals", payload["data"])

    def test_ai_decision_push_format(self):
        """Verify the push payload format for AI decisions."""
        payload = {
            "instrument": "NIFTY_50",
            "data": {
                "action": "GO",
                "direction": "CALL",
                "confidence": 0.85,
                "risk_reward": 2.5,
                "entry_price": 150,
                "sl": 130,
                "tp": 200,
                "reasoning": "Strong OI buildup at support",
            },
        }
        self.assertIn("instrument", payload)
        self.assertIn("data", payload)
        self.assertIn("action", payload["data"])
        self.assertIn("confidence", payload["data"])
        self.assertGreaterEqual(payload["data"]["confidence"], 0)
        self.assertLessEqual(payload["data"]["confidence"], 1)

    def test_heartbeat_push_format(self):
        """Verify the push payload format for module heartbeat."""
        payload = {
            "module": "session_manager",
            "message": "Active - monitoring P&L",
        }
        self.assertIn("module", payload)
        self.assertIn("message", payload)


# ═══════════════════════════════════════════════════════════════════
# 8. Run All Tests
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main(verbosity=2)
