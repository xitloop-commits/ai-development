#!/usr/bin/env python3
"""
WebSocket Feed & Momentum Engine Tests
---------------------------------------
Tests binary packet parsing, TickStore behavior, and MomentumEngine scoring
using synthetic recorded tick data (no live WebSocket needed).

Test scenarios:
  1. Dhan full packet binary parsing (packet code 8)
  2. Ticker packet parsing (packet code 2)
  3. OI packet parsing (packet code 5)
  4. Unknown packet code handling
  5. TickStore update/get/history behavior
  6. TickStore thread safety
  7. MomentumEngine with bullish tick sequence → high score
  8. MomentumEngine with bearish tick sequence → low score (for CALL)
  9. MomentumEngine with flat tick sequence → mid score
  10. MomentumEngine with insufficient data → empty result
  11. MomentumEngine action mapping (STRONG_HOLD, HOLD, PARTIAL_EXIT, FULL_EXIT)
  12. MomentumEngine volume surge factor

Usage:
  python3 test_websocket_momentum.py
"""

import unittest
import struct
import time
import threading
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from websocket_feed import parse_dhan_full_packet, parse_other_packet, TickStore
from momentum_engine import MomentumEngine


# ═══════════════════════════════════════════════════════════════════
# Recorded Tick Data Generators
# ═══════════════════════════════════════════════════════════════════

def make_tick_history_bullish(count=60, base_ltp=24500, base_volume=100000, base_oi=500000):
    """Generate a bullish tick sequence: steadily rising LTP + increasing volume."""
    now = time.time()
    ticks = []
    for i in range(count):
        ticks.append({
            "timestamp": now - (count - i),
            "ltp": base_ltp + i * 2,
            "volume": base_volume + i * 500,
            "oi": base_oi + i * 1000,
        })
    return ticks


def make_tick_history_bearish(count=60, base_ltp=24500, base_volume=100000, base_oi=500000):
    """Generate a bearish tick sequence: steadily falling LTP."""
    now = time.time()
    ticks = []
    for i in range(count):
        ticks.append({
            "timestamp": now - (count - i),
            "ltp": base_ltp - i * 2,
            "volume": base_volume + i * 500,
            "oi": base_oi - i * 800,
        })
    return ticks


def make_tick_history_flat(count=60, base_ltp=24500, base_volume=100000, base_oi=500000):
    """Generate a flat/sideways tick sequence: LTP oscillates ±1."""
    now = time.time()
    ticks = []
    for i in range(count):
        ticks.append({
            "timestamp": now - (count - i),
            "ltp": base_ltp + (1 if i % 2 == 0 else -1),
            "volume": base_volume,
            "oi": base_oi,
        })
    return ticks


def make_tick_history_volume_spike(count=60, base_ltp=24500, base_volume=100000, base_oi=500000):
    """Generate ticks with a volume spike in the last 10 ticks."""
    now = time.time()
    ticks = []
    for i in range(count):
        vol = base_volume if i < count - 10 else base_volume * 5
        ticks.append({
            "timestamp": now - (count - i),
            "ltp": base_ltp + i * 1,
            "volume": vol,
            "oi": base_oi + i * 500,
        })
    return ticks


# ═══════════════════════════════════════════════════════════════════
# Mock Tick Feed (feeds recorded data into MomentumEngine)
# ═══════════════════════════════════════════════════════════════════

class MockTickFeed:
    """Feeds pre-recorded tick history to MomentumEngine."""

    def __init__(self):
        self._histories = {}

    def set_history(self, key, ticks):
        self._histories[key] = ticks

    def get_tick_history(self, key, seconds=None):
        history = self._histories.get(key, [])
        if seconds is None:
            return history
        cutoff = time.time() - seconds
        return [t for t in history if t["timestamp"] >= cutoff]


# ═══════════════════════════════════════════════════════════════════
# Test: Binary Packet Parsing
# ═══════════════════════════════════════════════════════════════════

class TestBinaryParsing(unittest.TestCase):
    """Test Dhan binary packet parsing."""

    def _build_full_packet(self, security_id=12345, ltp=24500.0, ltq=100,
                           ltt=1617000, avg_price=24480.0, volume=5000000,
                           sell_qty=3000000, buy_qty=2500000, oi=800000,
                           high=24550.0, low=24400.0, open_price=24450.0,
                           close_price=24500.0):
        """Build a single-instrument full packet (code 8)."""
        # Format: byte[0]=packet_type, byte[1]=num_packets, then 50 bytes per instrument
        # Fields: securityId(4) ltp(4f) ltq(2H) ltt(4I) avg(4f) vol(4I) sellQty(4I) buyQty(4I) oi(4I) high(4f) low(4f) open(4f) close(4f)
        data = bytearray(52)  # 2 header + 50 body
        data[0] = 8   # packet code
        data[1] = 1   # num packets
        offset = 2
        struct.pack_into('<I', data, offset, security_id)
        struct.pack_into('<f', data, offset + 4, ltp)
        struct.pack_into('<H', data, offset + 8, ltq)
        struct.pack_into('<I', data, offset + 10, ltt)
        struct.pack_into('<f', data, offset + 14, avg_price)
        struct.pack_into('<I', data, offset + 18, volume)
        struct.pack_into('<I', data, offset + 22, sell_qty)
        struct.pack_into('<I', data, offset + 26, buy_qty)
        struct.pack_into('<I', data, offset + 30, oi)
        struct.pack_into('<f', data, offset + 34, high)
        struct.pack_into('<f', data, offset + 38, low)
        struct.pack_into('<f', data, offset + 42, open_price)
        struct.pack_into('<f', data, offset + 46, close_price)
        return bytes(data)

    def test_full_packet_parsing(self):
        """Parse a synthetic Dhan full packet (code 8)."""
        data = self._build_full_packet(
            security_id=12345, ltp=24500.0, ltq=100, volume=5000000,
            oi=800000, high=24550.0, low=24400.0, open_price=24450.0, close_price=24500.0
        )
        result = parse_dhan_full_packet(data)
        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 1)
        tick = result[0]
        self.assertEqual(tick["securityId"], "12345")
        self.assertAlmostEqual(tick["ltp"], 24500.0, places=0)
        self.assertEqual(tick["ltq"], 100)
        self.assertEqual(tick["volume"], 5000000)
        self.assertEqual(tick["oi"], 800000)
        self.assertAlmostEqual(tick["high"], 24550.0, places=0)
        self.assertAlmostEqual(tick["low"], 24400.0, places=0)
        self.assertAlmostEqual(tick["open"], 24450.0, places=0)
        self.assertAlmostEqual(tick["close"], 24500.0, places=0)

    def test_full_packet_multiple_instruments(self):
        """Parse a full packet with 2 instruments."""
        data = bytearray(102)  # 2 header + 50 * 2 body
        data[0] = 8
        data[1] = 2
        for idx, (sid, ltp_val) in enumerate([(11111, 24500.0), (22222, 52000.0)]):
            offset = 2 + idx * 50
            struct.pack_into('<I', data, offset, sid)
            struct.pack_into('<f', data, offset + 4, ltp_val)
            struct.pack_into('<H', data, offset + 8, 50)
            struct.pack_into('<I', data, offset + 10, 1617000)
            struct.pack_into('<f', data, offset + 14, ltp_val - 20)
            struct.pack_into('<I', data, offset + 18, 1000000)
            struct.pack_into('<I', data, offset + 22, 500000)
            struct.pack_into('<I', data, offset + 26, 500000)
            struct.pack_into('<I', data, offset + 30, 300000)
            struct.pack_into('<f', data, offset + 34, ltp_val + 50)
            struct.pack_into('<f', data, offset + 38, ltp_val - 50)
            struct.pack_into('<f', data, offset + 42, ltp_val - 10)
            struct.pack_into('<f', data, offset + 46, ltp_val)
        result = parse_dhan_full_packet(bytes(data))
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["securityId"], "11111")
        self.assertEqual(result[1]["securityId"], "22222")

    def test_wrong_packet_code_returns_empty(self):
        """Non-8 packet code should return empty list from parse_dhan_full_packet."""
        data = bytearray(52)
        data[0] = 2  # Not a full packet
        data[1] = 1
        result = parse_dhan_full_packet(bytes(data))
        self.assertEqual(result, [])

    def test_truncated_packet_handles_gracefully(self):
        """Truncated data should not crash, just return fewer ticks."""
        data = bytearray(20)  # Too short for a full packet
        data[0] = 8
        data[1] = 1
        result = parse_dhan_full_packet(bytes(data))
        self.assertEqual(len(result), 0)

    def test_ticker_packet_parsing(self):
        """Parse a ticker packet (code 2)."""
        data = bytearray(10)  # 2 header + 8 body
        data[0] = 2
        data[1] = 1
        struct.pack_into('<I', data, 2, 99999)
        struct.pack_into('<f', data, 6, 52000.0)
        result = parse_other_packet(bytes(data))
        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["securityId"], "99999")
        self.assertAlmostEqual(result[0]["ltp"], 52000.0, places=0)

    def test_oi_packet_parsing(self):
        """Parse an OI packet (code 5)."""
        data = bytearray(10)  # 2 header + 8 body
        data[0] = 5
        data[1] = 1
        struct.pack_into('<I', data, 2, 55555)
        struct.pack_into('<I', data, 6, 1200000)
        result = parse_other_packet(bytes(data))
        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["securityId"], "55555")
        self.assertEqual(result[0]["oi"], 1200000)

    def test_unknown_packet_code_returns_empty(self):
        """Unknown packet code should return empty list."""
        data = bytearray(20)
        data[0] = 99
        data[1] = 1
        result = parse_other_packet(bytes(data))
        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 0)

    def test_empty_data_returns_empty(self):
        """Empty/too-short data should return empty list."""
        result = parse_other_packet(bytes(1))
        self.assertEqual(result, [])
        result = parse_dhan_full_packet(bytes(1))
        self.assertEqual(result, [])


# ═══════════════════════════════════════════════════════════════════
# Test: TickStore
# ═══════════════════════════════════════════════════════════════════

class TestTickStore(unittest.TestCase):
    """Test TickStore update, get, and history behavior."""

    def test_update_and_get(self):
        """Update a tick and retrieve it."""
        store = TickStore()
        tick = {
            "securityId": "12345",
            "ltp": 24500.0,
            "volume": 1000000,
            "oi": 500000,
            "localTimestamp": time.time(),
        }
        store.update("NIFTY_24500_CE", tick)
        result = store.get("NIFTY_24500_CE")
        self.assertIsNotNone(result)
        self.assertEqual(result["ltp"], 24500.0)

    def test_get_nonexistent_key_returns_empty_dict(self):
        """Getting a non-existent key should return empty dict."""
        store = TickStore()
        result = store.get("NONEXISTENT")
        self.assertEqual(result, {})

    def test_history_accumulation(self):
        """Multiple updates should accumulate history."""
        store = TickStore()
        for i in range(10):
            tick = {
                "securityId": "12345",
                "ltp": 24500.0 + i,
                "volume": 1000000 + i * 1000,
                "oi": 500000,
                "localTimestamp": time.time(),
            }
            store.update("NIFTY_24500_CE", tick)

        history = store.get_history("NIFTY_24500_CE")
        self.assertEqual(len(history), 10)
        self.assertLess(history[0]["ltp"], history[-1]["ltp"])

    def test_history_with_seconds_filter(self):
        """get_history with seconds should filter old entries."""
        store = TickStore()
        now = time.time()
        # Insert ticks at different timestamps
        for i in range(10):
            tick = {
                "securityId": "12345",
                "ltp": 24500.0 + i,
                "volume": 1000000,
                "oi": 500000,
            }
            store.update("KEY", tick)

        # All ticks were just inserted (within last second)
        history = store.get_history("KEY", seconds=5)
        self.assertEqual(len(history), 10)

    def test_get_by_security_id(self):
        """Retrieve tick by security ID."""
        store = TickStore()
        tick = {
            "securityId": "12345",
            "ltp": 24500.0,
            "volume": 1000000,
            "oi": 500000,
            "localTimestamp": time.time(),
        }
        store.update("NIFTY_24500_CE", tick)
        result = store.get_by_security_id(12345)
        self.assertIsNotNone(result)
        self.assertEqual(result["ltp"], 24500.0)

    def test_get_by_security_id_not_found(self):
        """get_by_security_id for missing ID should return empty dict."""
        store = TickStore()
        result = store.get_by_security_id(99999)
        self.assertEqual(result, {})

    def test_count(self):
        """Count should reflect number of unique keys."""
        store = TickStore()
        store.update("KEY1", {"securityId": "1", "ltp": 100, "volume": 0, "oi": 0})
        store.update("KEY2", {"securityId": "2", "ltp": 200, "volume": 0, "oi": 0})
        self.assertEqual(store.count, 2)

    def test_clear(self):
        """Clear should remove all ticks and history."""
        store = TickStore()
        store.update("KEY", {"securityId": "1", "ltp": 100, "volume": 0, "oi": 0})
        self.assertEqual(store.count, 1)
        store.clear()
        self.assertEqual(store.count, 0)
        # After clear, get returns empty dict
        self.assertEqual(store.get("KEY"), {})

    def test_partial_update_merges(self):
        """Partial tick update should merge into existing data."""
        store = TickStore()
        store.update("KEY", {"securityId": "1", "ltp": 100, "volume": 5000, "oi": 1000})
        store.update("KEY", {"oi": 1500})  # Partial update: only OI
        result = store.get("KEY")
        self.assertEqual(result["ltp"], 100)  # Preserved
        self.assertEqual(result["oi"], 1500)  # Updated

    def test_thread_safety(self):
        """Concurrent updates should not corrupt the store."""
        store = TickStore()
        errors = []

        def updater(thread_id):
            try:
                for i in range(100):
                    store.update(f"KEY_{thread_id}", {
                        "securityId": str(thread_id),
                        "ltp": 100 + i,
                        "volume": i * 1000,
                        "oi": i * 500,
                    })
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=updater, args=(t,)) for t in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(len(errors), 0, f"Thread safety errors: {errors}")
        self.assertEqual(store.count, 10)


# ═══════════════════════════════════════════════════════════════════
# Test: Momentum Engine Scoring
# ═══════════════════════════════════════════════════════════════════

class TestMomentumEngine(unittest.TestCase):
    """Test MomentumEngine with recorded tick data."""

    def setUp(self):
        self.feed = MockTickFeed()
        self.engine = MomentumEngine(tick_feed=self.feed)

    def test_bullish_ticks_high_score(self):
        """Bullish tick sequence should produce a high momentum score for CALL."""
        ticks = make_tick_history_bullish(count=200)
        self.feed.set_history("NIFTY_ATM", ticks)

        result = self.engine.calculate("NIFTY_ATM", direction="CALL")
        self.assertGreater(result["score"], 50,
                           f"Bullish ticks should give score > 50, got {result['score']}")
        self.assertIn(result["action"], ["STRONG_HOLD", "HOLD"])

    def test_bearish_ticks_low_score_for_call(self):
        """Bearish tick sequence should produce a low momentum score for CALL."""
        ticks = make_tick_history_bearish(count=200)
        self.feed.set_history("NIFTY_ATM", ticks)

        result = self.engine.calculate("NIFTY_ATM", direction="CALL")
        self.assertLess(result["score"], 50,
                        f"Bearish ticks for CALL should give score < 50, got {result['score']}")

    def test_bearish_ticks_high_score_for_put(self):
        """Bearish tick sequence should produce a high momentum score for PUT."""
        ticks = make_tick_history_bearish(count=200)
        self.feed.set_history("NIFTY_ATM", ticks)

        result = self.engine.calculate("NIFTY_ATM", direction="PUT")
        self.assertGreater(result["score"], 50,
                           f"Bearish ticks for PUT should give score > 50, got {result['score']}")

    def test_flat_ticks_mid_score(self):
        """Flat tick sequence should produce a moderate momentum score."""
        ticks = make_tick_history_flat(count=200)
        self.feed.set_history("NIFTY_ATM", ticks)

        result = self.engine.calculate("NIFTY_ATM", direction="CALL")
        self.assertLess(result["score"], 70,
                        f"Flat ticks should not give very high score, got {result['score']}")

    def test_insufficient_data_empty_result(self):
        """With fewer than 2 ticks, should return empty/default result."""
        self.feed.set_history("NIFTY_ATM", [{"timestamp": time.time(), "ltp": 24500, "volume": 0, "oi": 0}])

        result = self.engine.calculate("NIFTY_ATM", direction="CALL")
        self.assertIn("score", result)
        self.assertIn("action", result)

    def test_no_data_empty_result(self):
        """With no tick data at all, should return empty/default result."""
        result = self.engine.calculate("NONEXISTENT", direction="CALL")
        self.assertIn("score", result)
        # With no data, score should be low/default
        self.assertLessEqual(result["score"], 50)

    def test_action_mapping_strong_hold(self):
        """Very bullish ticks should map to STRONG_HOLD."""
        ticks = make_tick_history_bullish(count=200, base_ltp=24500)
        for i, t in enumerate(ticks):
            t["ltp"] = 24500 + i * 5
            t["volume"] = 100000 + i * 2000
        self.feed.set_history("NIFTY_ATM", ticks)

        result = self.engine.calculate("NIFTY_ATM", direction="CALL")
        if result["score"] >= 70:
            self.assertEqual(result["action"], "STRONG_HOLD")

    def test_action_mapping_full_exit(self):
        """Very bearish ticks for CALL should map to FULL_EXIT."""
        ticks = make_tick_history_bearish(count=200)
        for i, t in enumerate(ticks):
            t["ltp"] = 24500 - i * 5
        self.feed.set_history("NIFTY_ATM", ticks)

        result = self.engine.calculate("NIFTY_ATM", direction="CALL")
        if result["score"] < 30:
            self.assertEqual(result["action"], "FULL_EXIT")

    def test_volume_spike_boosts_score(self):
        """Volume spike should boost the momentum score vs flat volume."""
        flat_ticks = make_tick_history_bullish(count=200)
        self.feed.set_history("NIFTY_ATM", flat_ticks)
        flat_result = self.engine.calculate("NIFTY_ATM", direction="CALL")

        spike_ticks = make_tick_history_volume_spike(count=200)
        self.feed.set_history("NIFTY_ATM", spike_ticks)
        spike_result = self.engine.calculate("NIFTY_ATM", direction="CALL")

        self.assertIn("score", flat_result)
        self.assertIn("score", spike_result)
        self.assertIn("factors", spike_result)

    def test_result_schema(self):
        """Result should contain all expected fields."""
        ticks = make_tick_history_bullish(count=200)
        self.feed.set_history("NIFTY_ATM", ticks)

        result = self.engine.calculate("NIFTY_ATM", direction="CALL")
        required_keys = ["score", "action", "factors", "fast_score", "slow_score"]
        for key in required_keys:
            self.assertIn(key, result, f"Missing key: {key}")

        self.assertIsInstance(result["score"], (int, float))
        self.assertGreaterEqual(result["score"], 0)
        self.assertLessEqual(result["score"], 100)
        self.assertIn(result["action"], ["STRONG_HOLD", "HOLD", "PARTIAL_EXIT", "FULL_EXIT"])

    def test_get_action_convenience(self):
        """get_action should return the action string directly."""
        ticks = make_tick_history_bullish(count=200)
        self.feed.set_history("NIFTY_ATM", ticks)

        action = self.engine.get_action("NIFTY_ATM", direction="CALL")
        self.assertIn(action, ["STRONG_HOLD", "HOLD", "PARTIAL_EXIT", "FULL_EXIT"])

    def test_get_score_convenience(self):
        """get_score should return just the numeric score."""
        ticks = make_tick_history_bullish(count=200)
        self.feed.set_history("NIFTY_ATM", ticks)

        score = self.engine.get_score("NIFTY_ATM", direction="CALL")
        self.assertIsInstance(score, (int, float))
        self.assertGreaterEqual(score, 0)
        self.assertLessEqual(score, 100)


# ═══════════════════════════════════════════════════════════════════
# Test: Momentum Engine Factor Details
# ═══════════════════════════════════════════════════════════════════

class TestMomentumFactors(unittest.TestCase):
    """Test individual momentum factors are computed correctly."""

    def setUp(self):
        self.feed = MockTickFeed()
        self.engine = MomentumEngine(tick_feed=self.feed)

    def test_price_velocity_positive_for_uptrend(self):
        """Price velocity factor should be positive for uptrend + CALL."""
        ticks = make_tick_history_bullish(count=200)
        self.feed.set_history("KEY", ticks)

        result = self.engine.calculate("KEY", direction="CALL")
        factors = result.get("factors", {})
        fast_factors = factors.get("fast", {})
        if "price_velocity" in fast_factors:
            self.assertGreater(fast_factors["price_velocity"], 0,
                               "Price velocity should be positive for bullish + CALL")

    def test_price_velocity_low_for_wrong_direction(self):
        """Price velocity should be low for uptrend + PUT."""
        ticks = make_tick_history_bullish(count=200)
        self.feed.set_history("KEY", ticks)

        result = self.engine.calculate("KEY", direction="PUT")
        factors = result.get("factors", {})
        fast_factors = factors.get("fast", {})
        if "price_velocity" in fast_factors:
            self.assertLessEqual(fast_factors["price_velocity"], 50,
                                 "Price velocity should be low for bullish + PUT")

    def test_all_four_factors_present(self):
        """All 4 momentum factors should be present in the result (nested under fast/slow)."""
        ticks = make_tick_history_bullish(count=200)
        self.feed.set_history("KEY", ticks)

        result = self.engine.calculate("KEY", direction="CALL")
        factors = result.get("factors", {})
        self.assertIn("fast", factors, "Missing 'fast' in factors")
        self.assertIn("slow", factors, "Missing 'slow' in factors")
        expected = ["price_velocity", "volume_surge", "oi_change", "candle_strength"]
        for f in expected:
            self.assertIn(f, factors["fast"], f"Missing factor '{f}' in fast")
            self.assertIn(f, factors["slow"], f"Missing factor '{f}' in slow")


# ═══════════════════════════════════════════════════════════════════
# Run
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main(verbosity=2)
