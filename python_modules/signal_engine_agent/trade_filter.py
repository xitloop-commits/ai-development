"""
trade_filter.py — 3-stage trade signal filter.

Converts noisy tick-level SEA predictions into actionable trade recommendations.

Three stages:
  Stage 1 — Sustained Direction: same action for N consecutive ticks
  Stage 2 — Confidence Gate: avg + min probability above thresholds
  Stage 3 — Multi-Model Consensus: scoring across direction, upside, RR, regime, magnitude

Plus a cooldown gate (minimum seconds between recommendations).
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass


@dataclass
class TickDecision:
    """One tick's _decide() output plus all model predictions."""

    timestamp: float
    action: str  # LONG_CE / LONG_PE / SHORT_CE / SHORT_PE / WAIT
    direction_prob: float  # direction_30s probability (raw from model)
    max_upside_pred: float
    max_drawdown_pred: float
    risk_reward_pred: float
    magnitude_pred: float
    regime: str | None
    entry: float
    tp: float
    sl: float
    rr: float


@dataclass
class TradeRecommendation:
    """Output when all 3 filter stages pass."""

    timestamp: float
    action: str
    confidence: str  # "HIGH" / "MEDIUM"
    score: int  # consensus score out of 6
    entry: float
    tp: float
    sl: float
    rr: float
    sustained_ticks: int
    avg_prob: float
    min_prob: float
    reasoning: str


# ── Regime → action type mapping ─────────────────────────────────────────────

_LONG_ACTIONS = {"LONG_CE", "LONG_PE"}
_SHORT_ACTIONS = {"SHORT_CE", "SHORT_PE"}
_BULLISH_ACTIONS = {"LONG_CE", "SHORT_PE"}  # benefit from price going up
_BEARISH_ACTIONS = {"LONG_PE", "SHORT_CE"}  # benefit from price going down


def _action_direction(action: str) -> str:
    """Map action to BULLISH or BEARISH direction."""
    if action in _BULLISH_ACTIONS:
        return "BULLISH"
    if action in _BEARISH_ACTIONS:
        return "BEARISH"
    return ""


def _regime_matches_action(regime: str | None, action: str) -> bool:
    """Check if the market regime supports the action type."""
    regime = (regime or "").upper()
    if regime == "TREND":
        return action in _LONG_ACTIONS
    if regime in ("RANGE", "DEAD"):
        return action in _SHORT_ACTIONS
    # NEUTRAL — no strong opinion
    return False


def _conviction_prob(direction_prob: float, action: str) -> float:
    """
    Convert raw direction probability to conviction for the given action.
    For bullish actions (LONG_CE, SHORT_PE): conviction = direction_prob
    For bearish actions (LONG_PE, SHORT_CE): conviction = 1 - direction_prob
    """
    if action in _BULLISH_ACTIONS:
        return direction_prob
    if action in _BEARISH_ACTIONS:
        return 1.0 - direction_prob
    return 0.5  # WAIT — neutral


class TradeFilter:
    """
    3-stage filter that converts tick-level decisions into trade recommendations.

    Usage:
        filt = TradeFilter()
        for tick in tick_stream:
            rec = filt.evaluate(tick)
            if rec is not None:
                # Actionable trade recommendation
    """

    def __init__(
        self,
        sustained_n: int = 5,
        avg_prob_threshold: float = 0.65,
        min_prob_threshold: float = 0.55,
        min_consensus_score: int = 4,
        min_upside_amount: float = 1.5,
        min_rr_ratio: float = 1.5,
        min_magnitude: float = 0.5,
        cooldown_sec: float = 60.0,
    ):
        self.sustained_n = sustained_n
        self.avg_prob_threshold = avg_prob_threshold
        self.min_prob_threshold = min_prob_threshold
        self.min_consensus_score = min_consensus_score
        self.min_upside_amount = min_upside_amount
        self.min_rr_ratio = min_rr_ratio
        self.min_magnitude = min_magnitude
        self.cooldown_sec = cooldown_sec

        # Internal state
        self._window: deque[TickDecision] = deque(maxlen=sustained_n)
        self._current_action: str = ""
        self._sustained_count: int = 0
        self._last_rec_ts: float = 0.0
        self._last_rec_direction: str = ""  # "BULLISH" or "BEARISH"

        # Stats
        self.total_ticks: int = 0
        self.total_passed: int = 0
        self.stage1_passed: int = 0
        self.stage2_passed: int = 0
        self.stage3_passed: int = 0
        self.stage4_blocked: int = 0
        self.cooldown_blocked: int = 0

    def evaluate(self, tick: TickDecision) -> TradeRecommendation | None:
        """
        Push one tick through the 3-stage filter.
        Returns TradeRecommendation if all stages pass, else None.
        """
        self.total_ticks += 1

        # WAIT resets the sustained counter
        if tick.action == "WAIT":
            self._sustained_count = 0
            self._current_action = ""
            self._window.clear()
            return None

        # Track sustained direction
        if tick.action != self._current_action:
            # Action changed — reset
            self._current_action = tick.action
            self._sustained_count = 1
            self._window.clear()
            self._window.append(tick)
            return None
        else:
            self._sustained_count += 1
            self._window.append(tick)

        # ── Stage 1: Sustained Direction ─────────────────────────────
        if not self._stage1_sustained():
            return None
        self.stage1_passed += 1

        # ── Stage 2: Confidence Gate ─────────────────────────────────
        passed, avg_prob, min_prob = self._stage2_confidence()
        if not passed:
            return None
        self.stage2_passed += 1

        # ── Stage 3: Multi-Model Consensus ───────────────────────────
        passed, score, reasoning = self._stage3_consensus(tick)
        if not passed:
            return None
        self.stage3_passed += 1

        # ── Stage 4: Direction Change ────────────────────────────────
        # Only emit when trade direction (BULLISH/BEARISH) changes
        # from the last recommendation. Prevents repeated same-direction signals.
        tick_direction = _action_direction(tick.action)
        if tick_direction == self._last_rec_direction:
            self.stage4_blocked += 1
            return None

        # ── Cooldown Gate ────────────────────────────────────────────
        if not self._check_cooldown(tick.timestamp):
            self.cooldown_blocked += 1
            return None

        # All stages passed — emit recommendation
        self._last_rec_ts = tick.timestamp
        self._last_rec_direction = tick_direction
        self.total_passed += 1

        confidence = "HIGH" if score >= 5 else "MEDIUM"

        rec = TradeRecommendation(
            timestamp=tick.timestamp,
            action=tick.action,
            confidence=confidence,
            score=score,
            entry=tick.entry,
            tp=tick.tp,
            sl=tick.sl,
            rr=tick.rr,
            sustained_ticks=self._sustained_count,
            avg_prob=round(avg_prob, 4),
            min_prob=round(min_prob, 4),
            reasoning=reasoning,
        )

        # Reset sustained counter after emitting (require fresh buildup)
        self._sustained_count = 0
        self._current_action = ""
        self._window.clear()

        return rec

    def _stage1_sustained(self) -> bool:
        """Stage 1: same action for N consecutive non-WAIT ticks."""
        return self._sustained_count >= self.sustained_n

    def _stage2_confidence(self) -> tuple[bool, float, float]:
        """
        Stage 2: average and minimum conviction probability across window.
        Returns (passed, avg_prob, min_prob).
        """
        if len(self._window) == 0:
            return False, 0.0, 0.0

        action = self._current_action
        probs = [_conviction_prob(t.direction_prob, action) for t in self._window]

        avg_prob = sum(probs) / len(probs)
        min_prob = min(probs)

        passed = avg_prob >= self.avg_prob_threshold and min_prob >= self.min_prob_threshold
        return passed, avg_prob, min_prob

    def _stage3_consensus(self, tick: TickDecision) -> tuple[bool, int, str]:
        """
        Stage 3: multi-model consensus scoring.
        Returns (passed, score, reasoning_string).
        """
        score = 0
        reasons: list[str] = []

        # Direction probability (required gate, +2)
        conv = _conviction_prob(tick.direction_prob, tick.action)
        if conv >= self.avg_prob_threshold:
            score += 2
            reasons.append(f"dir={conv:.2f}")
        else:
            # Required check failed — entire stage fails
            return False, 0, "direction_prob below threshold"

        # Max upside prediction (+1)
        up = tick.max_upside_pred
        if not math.isnan(up) and abs(up) > self.min_upside_amount:
            score += 1
            reasons.append(f"up={up:.2f}")

        # Risk-reward ratio (+1)
        rr = tick.risk_reward_pred if not math.isnan(tick.risk_reward_pred) else tick.rr
        if rr >= self.min_rr_ratio:
            score += 1
            reasons.append(f"rr={rr:.2f}")

        # Regime matches action type (+1)
        if _regime_matches_action(tick.regime, tick.action):
            score += 1
            reasons.append(f"regime={tick.regime}")

        # Magnitude prediction (+1)
        mag = tick.magnitude_pred
        if not math.isnan(mag) and abs(mag) > self.min_magnitude:
            score += 1
            reasons.append(f"mag={mag:.2f}")

        passed = score >= self.min_consensus_score
        reasoning = f"score={score}/6: " + ", ".join(reasons)
        return passed, score, reasoning

    def _check_cooldown(self, timestamp: float) -> bool:
        """True if enough time since last recommendation."""
        if self._last_rec_ts == 0.0:
            return True
        return (timestamp - self._last_rec_ts) >= self.cooldown_sec

    def reset(self) -> None:
        """Reset all state for a new session."""
        self._window.clear()
        self._current_action = ""
        self._sustained_count = 0
        self._last_rec_ts = 0.0
        self._last_rec_direction = ""
        self.total_ticks = 0
        self.total_passed = 0
        self.stage1_passed = 0
        self.stage2_passed = 0
        self.stage3_passed = 0
        self.stage4_blocked = 0
        self.cooldown_blocked = 0

    def stats(self) -> dict:
        """Return filter statistics."""
        return {
            "total_ticks": self.total_ticks,
            "total_passed": self.total_passed,
            "stage1_passed": self.stage1_passed,
            "stage2_passed": self.stage2_passed,
            "stage3_passed": self.stage3_passed,
            "stage4_blocked": self.stage4_blocked,
            "cooldown_blocked": self.cooldown_blocked,
            "pass_rate": round(self.total_passed / max(self.total_ticks, 1) * 100, 2),
        }
