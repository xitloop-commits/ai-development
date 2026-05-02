"""
test_state_machine.py — Unit tests for state_machine.py.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_state_machine.py -v
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pytest

from tick_feature_agent.state_machine import StateMachine, TradingState

# ── Helpers ───────────────────────────────────────────────────────────────────


def _sm(warm_up_sec: int = 5) -> tuple[StateMachine, list[tuple]]:
    """Return a StateMachine + a list that records all state-change events."""
    events: list[tuple] = []
    sm = StateMachine(
        warm_up_duration_sec=warm_up_sec,
        on_state_change=lambda old, new, reason: events.append((old, new, reason)),
    )
    return sm, events


# ══════════════════════════════════════════════════════════════════════════════
# Initialisation
# ══════════════════════════════════════════════════════════════════════════════


class TestInit:
    def test_initial_state_is_feed_stale(self):
        sm, _ = _sm()
        assert sm.state == TradingState.FEED_STALE

    def test_trading_not_allowed_initially(self):
        sm, _ = _sm()
        assert sm.trading_allowed is False

    def test_zero_warm_up_raises(self):
        with pytest.raises(ValueError):
            StateMachine(warm_up_duration_sec=0)

    def test_negative_warm_up_raises(self):
        with pytest.raises(ValueError):
            StateMachine(warm_up_duration_sec=-1)


# ══════════════════════════════════════════════════════════════════════════════
# Feed disconnect → reconnect → warm-up → trading
# ══════════════════════════════════════════════════════════════════════════════


class TestFeedCycle:
    def test_reconnect_tick_moves_to_warming_up(self):
        sm, _ = _sm()
        sm.on_feed_reconnect_tick()
        assert sm.state == TradingState.WARMING_UP
        assert sm.trading_allowed is False

    def test_warm_up_complete_moves_to_trading(self):
        sm, _ = _sm()
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()
        assert sm.state == TradingState.TRADING
        assert sm.trading_allowed is True

    def test_disconnect_from_trading_moves_to_feed_stale(self):
        sm, _ = _sm()
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()
        sm.on_feed_disconnect()
        assert sm.state == TradingState.FEED_STALE
        assert sm.trading_allowed is False

    def test_disconnect_from_warming_up_moves_to_feed_stale(self):
        sm, _ = _sm()
        sm.on_feed_reconnect_tick()
        assert sm.state == TradingState.WARMING_UP
        sm.on_feed_disconnect()
        assert sm.state == TradingState.FEED_STALE

    def test_reconnect_tick_ignored_when_not_feed_stale(self):
        sm, events = _sm()
        sm.on_feed_reconnect_tick()  # FEED_STALE → WARMING_UP
        count_before = len(events)
        sm.on_feed_reconnect_tick()  # already WARMING_UP — no-op
        assert len(events) == count_before  # no new transition

    def test_disconnect_noop_when_already_feed_stale(self):
        sm, events = _sm()
        # starts as FEED_STALE
        count_before = len(events)
        sm.on_feed_disconnect()
        assert len(events) == count_before  # no-op

    def test_full_cycle_state_sequence(self):
        sm, events = _sm()
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()
        sm.on_feed_disconnect()
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()

        states = [(e[0], e[1]) for e in events]
        assert states == [
            (TradingState.FEED_STALE, TradingState.WARMING_UP),
            (TradingState.WARMING_UP, TradingState.TRADING),
            (TradingState.TRADING, TradingState.FEED_STALE),
            (TradingState.FEED_STALE, TradingState.WARMING_UP),
            (TradingState.WARMING_UP, TradingState.TRADING),
        ]


# ══════════════════════════════════════════════════════════════════════════════
# Chain staleness
# ══════════════════════════════════════════════════════════════════════════════


class TestChainStaleness:
    def _trading_sm(self):
        sm, events = _sm()
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()
        assert sm.state == TradingState.TRADING
        return sm, events

    def test_chain_stale_from_trading(self):
        sm, _ = self._trading_sm()
        sm.on_chain_stale()
        assert sm.state == TradingState.CHAIN_STALE
        assert sm.trading_allowed is False

    def test_chain_recovered_from_chain_stale(self):
        sm, _ = self._trading_sm()
        sm.on_chain_stale()
        sm.on_chain_recovered()
        assert sm.state == TradingState.TRADING
        assert sm.trading_allowed is True

    def test_chain_stale_during_warming_up_does_not_transition(self):
        sm, _ = _sm()
        sm.on_feed_reconnect_tick()
        assert sm.state == TradingState.WARMING_UP
        sm.on_chain_stale()
        assert sm.state == TradingState.WARMING_UP  # not transitioned

    def test_chain_stale_during_feed_stale_does_not_transition(self):
        sm, _ = _sm()
        sm.on_chain_stale()
        assert sm.state == TradingState.FEED_STALE  # not transitioned

    def test_warm_up_complete_with_chain_stale_goes_to_chain_stale(self):
        """If chain was stale during warm-up, finishing warm-up → CHAIN_STALE not TRADING."""
        sm, _ = _sm()
        sm.on_feed_reconnect_tick()
        sm.on_chain_stale()  # chain goes stale during warm-up
        sm.on_warm_up_complete()
        assert sm.state == TradingState.CHAIN_STALE
        assert sm.trading_allowed is False

    def test_chain_recovered_ignored_when_not_chain_stale(self):
        sm, events = _sm()
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()
        count_before = len(events)
        sm.on_chain_recovered()  # chain is not stale — no transition
        assert len(events) == count_before

    def test_chain_stale_does_not_affect_feed_disconnect(self):
        sm, _ = self._trading_sm()
        sm.on_chain_stale()
        sm.on_feed_disconnect()
        assert sm.state == TradingState.FEED_STALE

    def test_chain_stale_flag_cleared_on_recovery(self):
        sm, _ = self._trading_sm()
        sm.on_chain_stale()
        sm.on_chain_recovered()
        # Now chain is healthy — another chain_recovered should be a no-op
        sm.on_chain_recovered()  # should not raise or transition again
        assert sm.state == TradingState.TRADING


# ══════════════════════════════════════════════════════════════════════════════
# Expiry rollover
# ══════════════════════════════════════════════════════════════════════════════


class TestExpiryRollover:
    def test_rollover_from_trading(self):
        sm, _ = _sm()
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()
        sm.on_expiry_rollover()
        assert sm.state == TradingState.FEED_STALE
        assert sm.trading_allowed is False

    def test_rollover_from_warming_up(self):
        sm, _ = _sm()
        sm.on_feed_reconnect_tick()
        sm.on_expiry_rollover()
        assert sm.state == TradingState.FEED_STALE

    def test_rollover_from_chain_stale(self):
        sm, _ = _sm()
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()
        sm.on_chain_stale()
        sm.on_expiry_rollover()
        assert sm.state == TradingState.FEED_STALE

    def test_rollover_aborts_warm_up_timer(self):
        sm, _ = _sm(warm_up_sec=60)
        sm.on_feed_reconnect_tick()
        assert sm.warm_up_remaining_sec is not None
        sm.on_expiry_rollover()
        assert sm.warm_up_remaining_sec is None

    def test_rollover_clears_chain_stale_flag(self):
        """After rollover, a fresh chain recovery should not be ignored."""
        sm, _ = _sm()
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()
        sm.on_chain_stale()
        sm.on_expiry_rollover()
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()
        # chain_stale was cleared by rollover, so we should reach TRADING
        assert sm.state == TradingState.TRADING

    def test_rollover_from_feed_stale_is_noop(self):
        sm, events = _sm()
        # already FEED_STALE
        count_before = len(events)
        sm.on_expiry_rollover()
        assert len(events) == count_before


# ══════════════════════════════════════════════════════════════════════════════
# tick() auto warm-up expiry
# ══════════════════════════════════════════════════════════════════════════════


class TestTickAutoWarmUp:
    def test_tick_does_not_trigger_before_warm_up_expires(self):
        sm, _ = _sm(warm_up_sec=60)
        sm.on_feed_reconnect_tick()
        assert sm.state == TradingState.WARMING_UP
        sm.tick()  # timer not expired
        assert sm.state == TradingState.WARMING_UP

    def test_tick_triggers_warm_up_complete_after_duration(self):
        sm, _ = _sm(warm_up_sec=1)
        sm.on_feed_reconnect_tick()
        assert sm.state == TradingState.WARMING_UP
        time.sleep(1.05)  # wait for timer to expire
        sm.tick()
        assert sm.state == TradingState.TRADING

    def test_tick_noop_when_not_warming_up(self):
        sm, events = _sm()
        # FEED_STALE — tick should be a no-op
        count_before = len(events)
        sm.tick()
        assert len(events) == count_before


# ══════════════════════════════════════════════════════════════════════════════
# Warm-up remaining
# ══════════════════════════════════════════════════════════════════════════════


class TestWarmUpRemaining:
    def test_none_when_not_warming_up(self):
        sm, _ = _sm()
        assert sm.warm_up_remaining_sec is None

    def test_positive_when_warming_up(self):
        sm, _ = _sm(warm_up_sec=60)
        sm.on_feed_reconnect_tick()
        remaining = sm.warm_up_remaining_sec
        assert remaining is not None
        assert 55.0 < remaining <= 60.0

    def test_none_after_warm_up_complete(self):
        sm, _ = _sm()
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()
        assert sm.warm_up_remaining_sec is None

    def test_none_after_disconnect_aborts_warm_up(self):
        sm, _ = _sm(warm_up_sec=60)
        sm.on_feed_reconnect_tick()
        sm.on_feed_disconnect()
        assert sm.warm_up_remaining_sec is None


# ══════════════════════════════════════════════════════════════════════════════
# Callback
# ══════════════════════════════════════════════════════════════════════════════


class TestCallback:
    def test_callback_receives_old_new_reason(self):
        events: list[tuple] = []
        sm = StateMachine(
            warm_up_duration_sec=5,
            on_state_change=lambda old, new, reason: events.append((old, new, reason)),
        )
        sm.on_feed_reconnect_tick()
        assert events[0] == (
            TradingState.FEED_STALE,
            TradingState.WARMING_UP,
            "feed_reconnect_first_tick",
        )

    def test_no_callback_when_none(self):
        sm = StateMachine(warm_up_duration_sec=5, on_state_change=None)
        sm.on_feed_reconnect_tick()  # should not raise
        assert sm.state == TradingState.WARMING_UP

    def test_callback_fired_on_every_transition(self):
        sm, events = _sm()
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()
        sm.on_chain_stale()
        sm.on_chain_recovered()
        assert len(events) == 4


# ══════════════════════════════════════════════════════════════════════════════
# trading_allowed invariant
# ══════════════════════════════════════════════════════════════════════════════


class TestTradingAllowedInvariant:
    """trading_allowed must be True if and only if state == TRADING."""

    def _check(self, sm: StateMachine) -> None:
        assert sm.trading_allowed == (sm.state == TradingState.TRADING)

    def test_invariant_across_all_transitions(self):
        sm, _ = _sm()
        self._check(sm)
        sm.on_feed_reconnect_tick()
        self._check(sm)
        sm.on_warm_up_complete()
        self._check(sm)
        sm.on_chain_stale()
        self._check(sm)
        sm.on_chain_recovered()
        self._check(sm)
        sm.on_feed_disconnect()
        self._check(sm)
        sm.on_feed_reconnect_tick()
        self._check(sm)
        sm.on_warm_up_complete()
        self._check(sm)
        sm.on_expiry_rollover()
        self._check(sm)
