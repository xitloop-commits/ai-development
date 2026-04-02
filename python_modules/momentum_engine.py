#!/usr/bin/env python3
"""
Momentum Engine
---------------
Calculates a real-time Momentum Score (0-100) using a dual-window approach.

Two windows:
  - Fast Window (30s-1m): Captures immediate price velocity and volume spikes.
  - Slow Window (2-3m): Captures sustained trend and OI confirmation.

Four factors (each scored 0-100, then weighted):
  1. Price Velocity (40%): Rate of price change in the direction of the trade.
  2. Volume Surge (25%): Current volume vs recent average.
  3. OI Change (20%): Open interest buildup confirming the move.
  4. Candle Strength (15%): Ratio of body to total range of recent candles.

Momentum Score Interpretation:
  > 70: STRONG — HOLD / ADD (Pyramiding eligible)
  50-70: MODERATE — HOLD (tighten SL)
  30-50: WEAK — PARTIAL EXIT
  < 30: DYING — FULL EXIT

Usage:
    from momentum_engine import MomentumEngine
    engine = MomentumEngine(tick_feed)
    score = engine.calculate(security_id, direction="CALL")
"""

import time
import math
from collections import defaultdict


# --- Configuration ---

# Window sizes in seconds
FAST_WINDOW = 45       # 45 seconds (between 30s-1m)
SLOW_WINDOW = 150      # 2.5 minutes (between 2-3m)

# Factor weights (must sum to 1.0)
WEIGHT_PRICE_VELOCITY = 0.40
WEIGHT_VOLUME_SURGE = 0.25
WEIGHT_OI_CHANGE = 0.20
WEIGHT_CANDLE_STRENGTH = 0.15

# Thresholds for action
MOMENTUM_STRONG = 70
MOMENTUM_MODERATE = 50
MOMENTUM_WEAK = 30


class MomentumEngine:
    """
    Calculates real-time Momentum Score from tick history.
    Requires a TickFeed instance (or any object with get_tick_history(key, seconds)).
    """

    def __init__(self, tick_feed):
        """
        Args:
            tick_feed: Object with get_tick_history(key, seconds) method
                       returning list of {timestamp, ltp, volume, oi}.
        """
        self.tick_feed = tick_feed

    def calculate(self, security_key, direction="CALL"):
        """
        Calculate the Momentum Score for a security.

        Args:
            security_key: The key used in the tick store (e.g., "12345" or "NSE_FNO:12345")
            direction: "CALL" (bullish) or "PUT" (bearish) — determines sign of price velocity

        Returns:
            dict with:
                score: float 0-100
                action: str (STRONG_HOLD, HOLD, PARTIAL_EXIT, FULL_EXIT)
                fast_score: float 0-100
                slow_score: float 0-100
                factors: dict of individual factor scores
                detail: str human-readable summary
        """
        fast_history = self.tick_feed.get_tick_history(security_key, FAST_WINDOW)
        slow_history = self.tick_feed.get_tick_history(security_key, SLOW_WINDOW)

        if len(fast_history) < 2:
            return self._empty_result("Insufficient tick data for momentum calculation")

        # Calculate fast window factors
        fast_factors = self._calculate_factors(fast_history, direction)

        # Calculate slow window factors
        if len(slow_history) >= 2:
            slow_factors = self._calculate_factors(slow_history, direction)
        else:
            slow_factors = fast_factors  # fallback to fast if slow not available

        # Combine: Fast window 60%, Slow window 40%
        fast_score = self._weighted_score(fast_factors)
        slow_score = self._weighted_score(slow_factors)
        combined_score = fast_score * 0.6 + slow_score * 0.4

        # Clamp to 0-100
        combined_score = max(0, min(100, combined_score))

        # Determine action
        action = self._score_to_action(combined_score)

        return {
            "score": round(combined_score, 1),
            "action": action,
            "fast_score": round(fast_score, 1),
            "slow_score": round(slow_score, 1),
            "factors": {
                "fast": {k: round(v, 1) for k, v in fast_factors.items()},
                "slow": {k: round(v, 1) for k, v in slow_factors.items()},
            },
            "detail": f"Momentum {combined_score:.0f}/100 ({action}) — Fast: {fast_score:.0f}, Slow: {slow_score:.0f}",
        }

    def get_action(self, security_key, direction="CALL"):
        """Convenience: returns just the action string."""
        result = self.calculate(security_key, direction)
        return result["action"]

    def get_score(self, security_key, direction="CALL"):
        """Convenience: returns just the numeric score."""
        result = self.calculate(security_key, direction)
        return result["score"]

    # --- Internal Calculations ---

    def _calculate_factors(self, history, direction):
        """Calculate the 4 momentum factors from tick history."""
        if len(history) < 2:
            return {"price_velocity": 50, "volume_surge": 50, "oi_change": 50, "candle_strength": 50}

        price_velocity = self._calc_price_velocity(history, direction)
        volume_surge = self._calc_volume_surge(history)
        oi_change = self._calc_oi_change(history, direction)
        candle_strength = self._calc_candle_strength(history, direction)

        return {
            "price_velocity": price_velocity,
            "volume_surge": volume_surge,
            "oi_change": oi_change,
            "candle_strength": candle_strength,
        }

    def _calc_price_velocity(self, history, direction):
        """
        Price Velocity (0-100): Rate of price change in the trade's direction.
        A +1% move in 30s scores ~80. Negative moves score below 50.
        """
        if len(history) < 2:
            return 50

        first_ltp = history[0].get("ltp", 0)
        last_ltp = history[-1].get("ltp", 0)

        if first_ltp <= 0:
            return 50

        pct_change = (last_ltp - first_ltp) / first_ltp * 100

        # Flip sign for PUT direction (price going down is bullish for PUT)
        if direction == "PUT":
            pct_change = -pct_change

        # Time-normalize: per-minute velocity
        time_span = history[-1]["timestamp"] - history[0]["timestamp"]
        if time_span > 0:
            velocity_per_min = pct_change / (time_span / 60)
        else:
            velocity_per_min = 0

        # Map velocity to 0-100 score
        # 0% per min = 50 (neutral), +2% per min = 100, -2% per min = 0
        score = 50 + (velocity_per_min / 2.0) * 50
        return max(0, min(100, score))

    def _calc_volume_surge(self, history):
        """
        Volume Surge (0-100): Compare recent volume to average.
        1.5x average = 75, 2x = 90, 0.5x = 25.
        """
        if len(history) < 3:
            return 50

        volumes = [h.get("volume", 0) for h in history]

        # Use the volume delta (change between ticks) as proxy for recent activity
        volume_deltas = []
        for i in range(1, len(volumes)):
            delta = volumes[i] - volumes[i - 1]
            if delta > 0:
                volume_deltas.append(delta)

        if not volume_deltas:
            return 50

        # Compare last few deltas to the average
        avg_delta = sum(volume_deltas) / len(volume_deltas)
        recent_deltas = volume_deltas[-min(5, len(volume_deltas)):]
        recent_avg = sum(recent_deltas) / len(recent_deltas) if recent_deltas else 0

        if avg_delta <= 0:
            return 50

        ratio = recent_avg / avg_delta

        # Map ratio to score: 1.0x = 50, 1.5x = 75, 2.0x = 90, 0.5x = 25
        score = 50 + (ratio - 1.0) * 50
        return max(0, min(100, score))

    def _calc_oi_change(self, history, direction):
        """
        OI Change (0-100): Open interest buildup confirming the move.
        Rising OI + price moving in direction = strong confirmation.
        """
        if len(history) < 2:
            return 50

        first_oi = history[0].get("oi", 0)
        last_oi = history[-1].get("oi", 0)
        first_ltp = history[0].get("ltp", 0)
        last_ltp = history[-1].get("ltp", 0)

        if first_oi <= 0:
            return 50  # No OI data

        oi_change_pct = (last_oi - first_oi) / first_oi * 100
        price_change = last_ltp - first_ltp

        # For CALL: rising OI + rising price = long buildup (bullish) = high score
        # For PUT: rising OI + falling price = short buildup (bearish for underlying) = high score
        if direction == "CALL":
            confirming = oi_change_pct > 0 and price_change > 0
            contradicting = oi_change_pct > 0 and price_change < 0
        else:
            confirming = oi_change_pct > 0 and price_change < 0
            contradicting = oi_change_pct > 0 and price_change > 0

        if confirming:
            # OI buildup confirms direction
            score = 50 + min(abs(oi_change_pct) * 10, 50)
        elif contradicting:
            # OI buildup contradicts direction (short buildup for CALL, long buildup for PUT)
            score = 50 - min(abs(oi_change_pct) * 10, 40)
        else:
            # Falling OI (unwinding) — mildly negative
            score = 50 - min(abs(oi_change_pct) * 5, 20)

        return max(0, min(100, score))

    def _calc_candle_strength(self, history, direction):
        """
        Candle Strength (0-100): How strong are the recent price bars.
        Strong body (close near high for CALL, close near low for PUT) = high score.
        """
        if len(history) < 3:
            return 50

        ltps = [h.get("ltp", 0) for h in history]

        # Create synthetic candle from the window
        open_price = ltps[0]
        close_price = ltps[-1]
        high_price = max(ltps)
        low_price = min(ltps)

        total_range = high_price - low_price
        if total_range <= 0:
            return 50  # No movement

        body = close_price - open_price
        body_ratio = abs(body) / total_range

        # Direction alignment
        if direction == "CALL":
            # Bullish candle: close > open, close near high
            if body > 0:
                # Upper wick ratio (smaller = better)
                upper_wick = (high_price - close_price) / total_range
                score = 50 + body_ratio * 40 - upper_wick * 20
            else:
                # Bearish candle against CALL direction
                score = 50 - body_ratio * 30
        else:
            # Bearish candle: close < open, close near low
            if body < 0:
                lower_wick = (close_price - low_price) / total_range
                score = 50 + body_ratio * 40 - lower_wick * 20
            else:
                score = 50 - body_ratio * 30

        return max(0, min(100, score))

    def _weighted_score(self, factors):
        """Calculate weighted average of factor scores."""
        return (
            factors["price_velocity"] * WEIGHT_PRICE_VELOCITY +
            factors["volume_surge"] * WEIGHT_VOLUME_SURGE +
            factors["oi_change"] * WEIGHT_OI_CHANGE +
            factors["candle_strength"] * WEIGHT_CANDLE_STRENGTH
        )

    def _score_to_action(self, score):
        """Map momentum score to action."""
        if score >= MOMENTUM_STRONG:
            return "STRONG_HOLD"
        elif score >= MOMENTUM_MODERATE:
            return "HOLD"
        elif score >= MOMENTUM_WEAK:
            return "PARTIAL_EXIT"
        else:
            return "FULL_EXIT"

    def _empty_result(self, detail=""):
        return {
            "score": 50.0,
            "action": "HOLD",
            "fast_score": 50.0,
            "slow_score": 50.0,
            "factors": {
                "fast": {"price_velocity": 50, "volume_surge": 50, "oi_change": 50, "candle_strength": 50},
                "slow": {"price_velocity": 50, "volume_surge": 50, "oi_change": 50, "candle_strength": 50},
            },
            "detail": detail or "No data available",
        }


# --- Standalone test ---

if __name__ == "__main__":
    # Mock tick feed for testing
    class MockTickFeed:
        def get_tick_history(self, key, seconds=None):
            now = time.time()
            # Simulate a bullish move: price going up with volume
            return [
                {"timestamp": now - 60, "ltp": 100.0, "volume": 1000, "oi": 50000},
                {"timestamp": now - 50, "ltp": 100.5, "volume": 1200, "oi": 50100},
                {"timestamp": now - 40, "ltp": 101.0, "volume": 1500, "oi": 50300},
                {"timestamp": now - 30, "ltp": 101.2, "volume": 1800, "oi": 50500},
                {"timestamp": now - 20, "ltp": 101.8, "volume": 2200, "oi": 50800},
                {"timestamp": now - 10, "ltp": 102.5, "volume": 2800, "oi": 51200},
                {"timestamp": now, "ltp": 103.0, "volume": 3500, "oi": 51500},
            ]

    feed = MockTickFeed()
    engine = MomentumEngine(feed)

    print("=== Momentum Engine Test ===")
    result = engine.calculate("TEST_SECURITY", direction="CALL")
    print(f"Score: {result['score']}")
    print(f"Action: {result['action']}")
    print(f"Fast: {result['fast_score']}, Slow: {result['slow_score']}")
    print(f"Detail: {result['detail']}")
    print(f"Factors: {result['factors']}")

    print("\n--- PUT direction (should be lower) ---")
    result_put = engine.calculate("TEST_SECURITY", direction="PUT")
    print(f"Score: {result_put['score']}")
    print(f"Action: {result_put['action']}")
