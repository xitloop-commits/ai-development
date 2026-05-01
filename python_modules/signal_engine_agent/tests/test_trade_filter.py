"""
tests/test_trade_filter.py — Phase E10 PR2 lock for the legacy 4-stage filter.

`trade_filter.TradeFilter` is on its way out (the canonical SEA filter is
the 3-condition gate in `thresholds.py`), but it remains reachable via
`--filter=legacy` for one A/B cycle. These tests pin the current
behaviour so anyone still on the legacy path gets a regression-free
transition; they will be deleted alongside the module.

Stages, in order:
    1. Sustained direction — same non-WAIT action for `sustained_n` ticks
    2. Confidence gate     — rolling avg + min conviction probability
    3. Multi-model consensus — scoring across direction / upside / RR /
                                regime / magnitude (out of 6, threshold 4)
    4. Direction-change block — once a BULLISH or BEARISH rec has fired,
                                further recs of that same trade direction
                                are suppressed until the side flips
    + Cooldown gate         — minimum seconds between recs

Run: python -m pytest python_modules/signal_engine_agent/tests/test_trade_filter.py -v
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent  # python_modules/
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from signal_engine_agent.trade_filter import (
    TickDecision,
    TradeRecommendation,
    TradeFilter,
    _action_direction,
    _conviction_prob,
    _regime_matches_action,
    _BULLISH_ACTIONS,
    _BEARISH_ACTIONS,
)


# ── helpers ───────────────────────────────────────────────────────────────

def _tick(
    *,
    ts: float = 0.0,
    action: str = "LONG_CE",
    direction_prob: float = 0.80,
    max_upside_pred: float = 5.0,
    max_drawdown_pred: float = -3.0,
    risk_reward_pred: float = 2.0,
    magnitude_pred: float = 1.0,
    regime: str | None = "TREND",
    entry: float = 100.0,
    tp: float = 105.0,
    sl: float = 97.0,
    rr: float = 2.0,
) -> TickDecision:
    """Build a TickDecision that, by default, satisfies every stage and
    every consensus criterion. Tests override only the field that matters."""
    return TickDecision(
        timestamp=ts,
        action=action,
        direction_prob=direction_prob,
        max_upside_pred=max_upside_pred,
        max_drawdown_pred=max_drawdown_pred,
        risk_reward_pred=risk_reward_pred,
        magnitude_pred=magnitude_pred,
        regime=regime,
        entry=entry,
        tp=tp,
        sl=sl,
        rr=rr,
    )


def _push_n(filt: TradeFilter, n: int, *, start_ts: float = 0.0,
            step: float = 1.0, **tick_kwargs):
    """Push n ticks (each one timestamped start_ts, start_ts+step, ...)
    and return the list of returned values (mostly None)."""
    out = []
    for i in range(n):
        out.append(filt.evaluate(_tick(ts=start_ts + i * step, **tick_kwargs)))
    return out


# ── dataclass round-trip ──────────────────────────────────────────────────

def test_tick_decision_dataclass_roundtrip():
    t = TickDecision(
        timestamp=1.5, action="LONG_CE", direction_prob=0.7,
        max_upside_pred=2.0, max_drawdown_pred=-1.0,
        risk_reward_pred=2.0, magnitude_pred=0.6,
        regime="TREND", entry=100.0, tp=102.0, sl=99.0, rr=2.0,
    )
    assert t.timestamp == 1.5
    assert t.action == "LONG_CE"
    assert t.direction_prob == 0.7
    assert t.regime == "TREND"


def test_trade_recommendation_dataclass_roundtrip():
    r = TradeRecommendation(
        timestamp=1.5, action="LONG_CE", confidence="HIGH", score=5,
        entry=100.0, tp=102.0, sl=99.0, rr=2.0,
        sustained_ticks=5, avg_prob=0.72, min_prob=0.66,
        reasoning="score=5/6: dir=0.72, up=2.0",
    )
    assert r.confidence == "HIGH"
    assert r.score == 5
    assert r.reasoning.startswith("score=5/6")


# ── pure helpers: _action_direction ────────────────────────────────────────

@pytest.mark.parametrize("action, expected", [
    ("LONG_CE",  "BULLISH"),
    ("SHORT_PE", "BULLISH"),
    ("LONG_PE",  "BEARISH"),
    ("SHORT_CE", "BEARISH"),
    ("WAIT",     ""),
    ("",         ""),
])
def test_action_direction_mapping(action, expected):
    assert _action_direction(action) == expected


def test_bullish_and_bearish_sets_disjoint():
    assert _BULLISH_ACTIONS.isdisjoint(_BEARISH_ACTIONS)


# ── pure helpers: _conviction_prob ─────────────────────────────────────────

@pytest.mark.parametrize("action, prob, expected", [
    ("LONG_CE",  0.80, 0.80),  # bullish: passthrough
    ("SHORT_PE", 0.80, 0.80),  # bullish: passthrough
    ("LONG_PE",  0.80, 0.20),  # bearish: 1 - p
    ("SHORT_CE", 0.80, 0.20),  # bearish: 1 - p
    ("WAIT",     0.99, 0.50),  # neutral
])
def test_conviction_prob(action, prob, expected):
    assert _conviction_prob(prob, action) == pytest.approx(expected)


# ── pure helpers: _regime_matches_action ──────────────────────────────────

@pytest.mark.parametrize("regime, action, expected", [
    ("TREND",   "LONG_CE",  True),
    ("TREND",   "LONG_PE",  True),
    ("TREND",   "SHORT_CE", False),
    ("TREND",   "SHORT_PE", False),
    ("RANGE",   "SHORT_CE", True),
    ("RANGE",   "SHORT_PE", True),
    ("RANGE",   "LONG_CE",  False),
    ("DEAD",    "SHORT_CE", True),
    ("DEAD",    "LONG_CE",  False),
    ("NEUTRAL", "LONG_CE",  False),  # neutral never matches
    (None,      "LONG_CE",  False),
    ("",        "LONG_CE",  False),
    ("trend",   "LONG_CE",  True),   # case-insensitive
])
def test_regime_matches_action(regime, action, expected):
    assert _regime_matches_action(regime, action) is expected


# ── stage 1: sustained direction ──────────────────────────────────────────

def test_stage1_below_sustained_n_returns_none():
    filt = TradeFilter(sustained_n=3)
    # 2 LONG_CE ticks isn't enough for sustained_n=3
    out = _push_n(filt, 2, action="LONG_CE")
    assert all(r is None for r in out)
    assert filt.stage1_passed == 0


def test_stage1_wait_resets_streak():
    filt = TradeFilter(sustained_n=3)
    filt.evaluate(_tick(ts=0, action="LONG_CE"))
    filt.evaluate(_tick(ts=1, action="LONG_CE"))
    # WAIT must reset the streak
    filt.evaluate(_tick(ts=2, action="WAIT"))
    # Two more LONG_CE should NOT trigger stage1 (streak = 2 < 3)
    filt.evaluate(_tick(ts=3, action="LONG_CE"))
    filt.evaluate(_tick(ts=4, action="LONG_CE"))
    assert filt.stage1_passed == 0


def test_stage1_action_change_resets_streak():
    filt = TradeFilter(sustained_n=3)
    filt.evaluate(_tick(ts=0, action="LONG_CE"))
    filt.evaluate(_tick(ts=1, action="LONG_CE"))
    # Different action wipes the streak and starts a new one of length 1
    filt.evaluate(_tick(ts=2, action="LONG_PE"))
    assert filt.stage1_passed == 0
    # Two more LONG_PE → streak still only 3, but now stage 1 passes for the new action
    filt.evaluate(_tick(ts=3, action="LONG_PE"))
    filt.evaluate(_tick(ts=4, action="LONG_PE"))
    assert filt.stage1_passed >= 1


def test_stage1_passes_at_exactly_sustained_n():
    """With min_consensus=0, stage 1 should fire on the Nth identical tick."""
    filt = TradeFilter(
        sustained_n=3,
        avg_prob_threshold=0.0,
        min_prob_threshold=0.0,
        min_consensus_score=0,
        cooldown_sec=0.0,
    )
    # 3rd tick should flip stage1_passed at least once
    filt.evaluate(_tick(ts=0, action="LONG_CE"))
    filt.evaluate(_tick(ts=1, action="LONG_CE"))
    assert filt.stage1_passed == 0
    filt.evaluate(_tick(ts=2, action="LONG_CE"))
    assert filt.stage1_passed == 1


# ── stage 2: confidence gate ──────────────────────────────────────────────

def test_stage2_avg_below_threshold_blocks():
    filt = TradeFilter(
        sustained_n=3,
        avg_prob_threshold=0.65,
        min_prob_threshold=0.55,
        min_consensus_score=0,
        cooldown_sec=0.0,
    )
    # All probs at 0.60 — passes min (0.55) but fails avg (0.65)
    _push_n(filt, 3, action="LONG_CE", direction_prob=0.60)
    assert filt.stage1_passed == 1
    assert filt.stage2_passed == 0


def test_stage2_min_below_threshold_blocks():
    filt = TradeFilter(
        sustained_n=3,
        avg_prob_threshold=0.65,
        min_prob_threshold=0.55,
        min_consensus_score=0,
        cooldown_sec=0.0,
    )
    # avg = (0.80 + 0.80 + 0.50) / 3 = 0.70 → passes avg, but min=0.50 < 0.55
    filt.evaluate(_tick(ts=0, action="LONG_CE", direction_prob=0.80))
    filt.evaluate(_tick(ts=1, action="LONG_CE", direction_prob=0.80))
    filt.evaluate(_tick(ts=2, action="LONG_CE", direction_prob=0.50))
    assert filt.stage1_passed == 1
    assert filt.stage2_passed == 0


def test_stage2_passes_at_exact_threshold():
    """Stage 2 uses `>=` for both avg and min."""
    filt = TradeFilter(
        sustained_n=3,
        avg_prob_threshold=0.65,
        min_prob_threshold=0.65,
        min_consensus_score=0,
        cooldown_sec=0.0,
    )
    _push_n(filt, 3, action="LONG_CE", direction_prob=0.65)
    assert filt.stage2_passed == 1


def test_stage2_uses_conviction_for_bearish_action():
    """For LONG_PE the conviction is 1 - direction_prob, so dir_prob=0.20
    yields conviction=0.80 which clears the 0.65 thresholds."""
    filt = TradeFilter(
        sustained_n=3,
        avg_prob_threshold=0.65,
        min_prob_threshold=0.55,
        min_consensus_score=0,
        cooldown_sec=0.0,
    )
    _push_n(filt, 3, action="LONG_PE", direction_prob=0.20, regime="RANGE")
    assert filt.stage2_passed == 1


# ── stage 3: multi-model consensus scoring ────────────────────────────────

def test_stage3_full_six_score_yields_high():
    """All 5 score components hit (dir=2, upside=1, rr=1, regime=1, mag=1)
    → score 6, confidence HIGH."""
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=4, cooldown_sec=0.0,
    )
    out = _push_n(
        filt, 3,
        action="LONG_CE", direction_prob=0.80,
        max_upside_pred=5.0, max_drawdown_pred=-2.0,
        risk_reward_pred=2.5, magnitude_pred=1.0,
        regime="TREND",
    )
    rec = next(r for r in out if r is not None)
    assert rec.score == 6
    assert rec.confidence == "HIGH"


def test_stage3_score_5_is_high():
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=4, cooldown_sec=0.0,
    )
    # NEUTRAL regime → no regime point, score = 2+1+1+0+1 = 5
    out = _push_n(
        filt, 3,
        action="LONG_CE", direction_prob=0.80,
        max_upside_pred=5.0, risk_reward_pred=2.5, magnitude_pred=1.0,
        regime="NEUTRAL",
    )
    rec = next(r for r in out if r is not None)
    assert rec.score == 5
    assert rec.confidence == "HIGH"


def test_stage3_score_4_is_medium():
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=4, cooldown_sec=0.0,
    )
    # NEUTRAL regime + tiny magnitude → score = 2 + 1 + 1 + 0 + 0 = 4
    out = _push_n(
        filt, 3,
        action="LONG_CE", direction_prob=0.80,
        max_upside_pred=5.0, risk_reward_pred=2.5, magnitude_pred=0.1,
        regime="NEUTRAL",
    )
    rec = next(r for r in out if r is not None)
    assert rec.score == 4
    assert rec.confidence == "MEDIUM"


def test_stage3_below_min_consensus_blocks():
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=5, cooldown_sec=0.0,
    )
    # NEUTRAL + tiny magnitude → score 4, threshold 5 → blocked
    out = _push_n(
        filt, 3,
        action="LONG_CE", direction_prob=0.80,
        max_upside_pred=5.0, risk_reward_pred=2.5, magnitude_pred=0.1,
        regime="NEUTRAL",
    )
    assert all(r is None for r in out)
    assert filt.stage2_passed == 1
    assert filt.stage3_passed == 0


def test_stage3_dir_prob_below_threshold_short_circuits():
    """If conviction < avg_prob_threshold the entire stage 3 fails with
    'direction_prob below threshold' — it's a required gate, not just
    the +2 score component. Tested directly against `_stage3_consensus`
    so we don't have to fight stage-2 thresholds at the same time."""
    filt = TradeFilter(avg_prob_threshold=0.65, min_consensus_score=2)
    tick = _tick(action="LONG_CE", direction_prob=0.60,
                 max_upside_pred=5.0, risk_reward_pred=2.5,
                 magnitude_pred=1.0, regime="TREND")
    filt._current_action = "LONG_CE"
    passed, score, reasoning = filt._stage3_consensus(tick)
    assert passed is False
    assert score == 0
    assert "direction_prob below threshold" in reasoning


def test_stage3_upside_nan_does_not_score():
    """Per implementation: NaN upside skips the +1 component (does not
    crash, does not count). Locked behaviour."""
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=0.0,
    )
    out = _push_n(
        filt, 3,
        action="LONG_CE", direction_prob=0.80,
        max_upside_pred=float("nan"),
        risk_reward_pred=2.5, magnitude_pred=1.0,
        regime="TREND",
    )
    rec = next(r for r in out if r is not None)
    # 2 (dir) + 0 (up NaN) + 1 (rr) + 1 (regime TREND) + 1 (mag) = 5
    assert rec.score == 5


def test_stage3_magnitude_nan_does_not_score():
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=0.0,
    )
    out = _push_n(
        filt, 3,
        action="LONG_CE", direction_prob=0.80,
        max_upside_pred=5.0, risk_reward_pred=2.5,
        magnitude_pred=float("nan"),
        regime="TREND",
    )
    rec = next(r for r in out if r is not None)
    assert rec.score == 5  # 2+1+1+1+0


def test_stage3_rr_falls_back_to_tick_rr_when_pred_is_nan():
    """If risk_reward_pred is NaN the scorer falls back to `tick.rr`."""
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=0.0, min_rr_ratio=1.5,
    )
    out = _push_n(
        filt, 3,
        action="LONG_CE", direction_prob=0.80,
        max_upside_pred=5.0,
        risk_reward_pred=float("nan"),
        rr=2.0,  # falls back to this
        magnitude_pred=1.0,
        regime="TREND",
    )
    rec = next(r for r in out if r is not None)
    # All 5 components should fire because rr falls back to 2.0 ≥ 1.5
    assert rec.score == 6


def test_stage3_upside_below_min_amount_no_score():
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=0.0, min_upside_amount=1.5,
    )
    # |max_upside_pred| = 1.0 < 1.5 → no +1 component
    out = _push_n(
        filt, 3,
        action="LONG_CE", direction_prob=0.80,
        max_upside_pred=1.0,
        risk_reward_pred=2.5, magnitude_pred=1.0,
        regime="TREND",
    )
    rec = next(r for r in out if r is not None)
    assert rec.score == 5  # 2 (dir) + 0 (up below) + 1 (rr) + 1 (regime) + 1 (mag)


def test_stage3_reasoning_string_includes_components():
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=0.0,
    )
    out = _push_n(
        filt, 3,
        action="LONG_CE", direction_prob=0.80,
        max_upside_pred=5.0, risk_reward_pred=2.5,
        magnitude_pred=1.0, regime="TREND",
    )
    rec = next(r for r in out if r is not None)
    assert "dir=" in rec.reasoning
    assert "up=" in rec.reasoning
    assert "rr=" in rec.reasoning
    assert "regime=TREND" in rec.reasoning
    assert "mag=" in rec.reasoning


# ── stage 4: direction-change block ───────────────────────────────────────

def test_stage4_blocks_consecutive_same_direction():
    """Once a BULLISH rec fires, further BULLISH recs are suppressed by
    stage 4 (until the trade direction flips). Locks behaviour for
    `_last_rec_direction`."""
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=0.0,
    )
    # Burst 1 → fires
    rec1 = None
    for r in _push_n(filt, 3, action="LONG_CE", direction_prob=0.80):
        if r is not None:
            rec1 = r
    assert rec1 is not None
    assert rec1.action == "LONG_CE"

    # Burst 2 → same BULLISH direction; stage 4 blocks
    out = _push_n(filt, 3, start_ts=10, action="LONG_CE", direction_prob=0.80)
    assert all(r is None for r in out)
    assert filt.stage4_blocked >= 1


def test_stage4_lets_opposite_direction_through():
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=0.0,
    )
    # Burst 1 → BULLISH (LONG_CE) fires
    for r in _push_n(filt, 3, action="LONG_CE", direction_prob=0.80):
        pass
    assert filt.total_passed == 1

    # Burst 2 → BEARISH (LONG_PE) — must pass stage 4
    rec2 = None
    for r in _push_n(filt, 3, start_ts=10,
                     action="LONG_PE", direction_prob=0.20,
                     regime="RANGE"):
        if r is not None:
            rec2 = r
    assert rec2 is not None
    assert rec2.action == "LONG_PE"
    assert filt.total_passed == 2


# ── cooldown gate ─────────────────────────────────────────────────────────

def test_cooldown_blocks_within_window():
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=60.0,
    )
    # Fire BULLISH at ts=0..2
    for r in _push_n(filt, 3, action="LONG_CE", direction_prob=0.80):
        pass
    assert filt.total_passed == 1

    # Try a BEARISH burst at ts=10..12 — passes stage 4 (direction flip)
    # but must be blocked by cooldown (10 - 2 = 8s < 60s).
    out = _push_n(filt, 3, start_ts=10,
                  action="LONG_PE", direction_prob=0.20, regime="RANGE")
    assert all(r is None for r in out)
    assert filt.cooldown_blocked >= 1


def test_cooldown_admits_after_window():
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=60.0,
    )
    for r in _push_n(filt, 3, action="LONG_CE", direction_prob=0.80):
        pass
    assert filt.total_passed == 1

    # 100s later → cooldown elapsed
    rec2 = None
    for r in _push_n(filt, 3, start_ts=100,
                     action="LONG_PE", direction_prob=0.20, regime="RANGE"):
        if r is not None:
            rec2 = r
    assert rec2 is not None
    assert filt.total_passed == 2


def test_first_rec_skips_cooldown():
    """Cooldown timer initialises to 0 — the first ever rec must NOT be
    blocked even if its timestamp is within `cooldown_sec` of zero."""
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=60.0,
    )
    out = _push_n(filt, 3, action="LONG_CE", direction_prob=0.80)
    assert sum(1 for r in out if r is not None) == 1
    assert filt.cooldown_blocked == 0


# ── stats() and reset() ───────────────────────────────────────────────────

def test_stats_exposes_counters():
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=0.0,
    )
    for r in _push_n(filt, 3, action="LONG_CE", direction_prob=0.80):
        pass
    s = filt.stats()
    assert s["total_ticks"] == 3
    assert s["total_passed"] == 1
    assert s["stage1_passed"] == 1
    assert s["stage2_passed"] == 1
    assert s["stage3_passed"] == 1
    assert "stage4_blocked" in s
    assert "cooldown_blocked" in s
    assert "pass_rate" in s


def test_pass_rate_division_by_zero_safe():
    """Empty filter must not divide-by-zero on stats()."""
    filt = TradeFilter()
    s = filt.stats()
    assert s["total_ticks"] == 0
    assert s["pass_rate"] == 0.0


def test_reset_clears_all_state():
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=0.0,
    )
    for r in _push_n(filt, 3, action="LONG_CE", direction_prob=0.80):
        pass
    assert filt.total_passed == 1
    filt.reset()
    s = filt.stats()
    assert s["total_ticks"] == 0
    assert s["total_passed"] == 0
    assert s["stage1_passed"] == 0
    assert filt._current_action == ""
    assert filt._sustained_count == 0
    assert filt._last_rec_ts == 0.0
    assert filt._last_rec_direction == ""


# ── post-emit reset behaviour ─────────────────────────────────────────────

def test_emit_resets_sustained_window():
    """After firing a rec the sustained counter resets to 0; the next
    burst must rebuild from scratch."""
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=0.0,
    )
    for r in _push_n(filt, 3, action="LONG_CE", direction_prob=0.80):
        pass
    # Internal state cleared after emit
    assert filt._sustained_count == 0
    assert len(filt._window) == 0
    assert filt._current_action == ""


def test_recommendation_carries_avg_and_min_prob_rounded():
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=0.0,
    )
    out = _push_n(filt, 3, action="LONG_CE", direction_prob=0.80)
    rec = next(r for r in out if r is not None)
    assert rec.avg_prob == pytest.approx(0.80, abs=1e-4)
    assert rec.min_prob == pytest.approx(0.80, abs=1e-4)
    assert rec.sustained_ticks >= 3


def test_recommendation_copies_pricing_from_tick():
    filt = TradeFilter(
        sustained_n=3, avg_prob_threshold=0.65, min_prob_threshold=0.55,
        min_consensus_score=0, cooldown_sec=0.0,
    )
    out = _push_n(
        filt, 3,
        action="LONG_CE", direction_prob=0.80,
        entry=123.45, tp=130.0, sl=120.0, rr=2.5,
    )
    rec = next(r for r in out if r is not None)
    assert rec.entry == 123.45
    assert rec.tp == 130.0
    assert rec.sl == 120.0
    assert rec.rr == 2.5


# ── edge cases ────────────────────────────────────────────────────────────

def test_only_wait_ticks_emit_nothing():
    filt = TradeFilter(sustained_n=3)
    out = _push_n(filt, 10, action="WAIT")
    assert all(r is None for r in out)
    assert filt.total_ticks == 10
    assert filt.total_passed == 0


def test_empty_window_is_safe():
    """`_stage2_confidence` early-exits cleanly on an empty window."""
    filt = TradeFilter(sustained_n=3)
    passed, avg_p, min_p = filt._stage2_confidence()
    assert passed is False
    assert avg_p == 0.0
    assert min_p == 0.0
