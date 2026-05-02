"""
state_machine.py — TFA trading state machine.

Tracks whether TFA is allowed to emit features with trading_allowed=1.
All state mutations happen on the asyncio event loop thread — no locks needed.

States
------
WARMING_UP   : Feed just reconnected. Warming up buffers. trading_allowed = 0.
TRADING      : Feed healthy, chain healthy, warm-up done. trading_allowed = 1.
FEED_STALE   : Underlying feed disconnected or ticked out. trading_allowed = 0.
CHAIN_STALE  : Chain snapshot missing > 30s (feed still live). trading_allowed = 0.

Transitions
-----------
See transition table in spec §4 and implementation plan Phase 4.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from enum import StrEnum


class TradingState(StrEnum):
    WARMING_UP = "WARMING_UP"
    TRADING = "TRADING"
    FEED_STALE = "FEED_STALE"
    CHAIN_STALE = "CHAIN_STALE"


class StateMachine:
    """
    Deterministic state machine for one TFA process.

    Usage (called from the asyncio event loop):
        sm = StateMachine(warm_up_duration_sec=15, on_state_change=log_fn)

        sm.on_feed_disconnect()          # → FEED_STALE
        sm.on_feed_reconnect_tick()      # → WARMING_UP, starts timer
        sm.on_warm_up_complete()         # → TRADING
        sm.on_chain_stale()              # → CHAIN_STALE
        sm.on_chain_recovered()          # → TRADING (if feed healthy)
        sm.on_expiry_rollover()          # → FEED_STALE, aborts warm-up

        sm.trading_allowed               # True only in TRADING state
        sm.state                         # current TradingState
    """

    def __init__(
        self,
        warm_up_duration_sec: int,
        on_state_change: Callable[[TradingState, TradingState, str], None] | None = None,
    ) -> None:
        """
        Args:
            warm_up_duration_sec: Seconds to spend in WARMING_UP before → TRADING.
                                  Comes from InstrumentProfile.warm_up_duration_sec.
            on_state_change:      Optional callback(old_state, new_state, reason).
                                  Called synchronously on every transition.
        """
        if warm_up_duration_sec <= 0:
            raise ValueError(f"warm_up_duration_sec must be > 0, got {warm_up_duration_sec}")

        self._warm_up_duration_sec = warm_up_duration_sec
        self._on_state_change = on_state_change

        # Initial state — TFA starts in FEED_STALE until the first tick arrives
        self._state: TradingState = TradingState.FEED_STALE
        self._trading_allowed: bool = False

        # Warm-up timer: perf_counter timestamp when WARMING_UP started, or None
        self._warm_up_started_at: float | None = None

        # Chain staleness flag — tracked independently of feed state
        self._chain_stale: bool = False

    # ── Public read-only properties ───────────────────────────────────────────

    @property
    def state(self) -> TradingState:
        return self._state

    @property
    def trading_allowed(self) -> bool:
        return self._trading_allowed

    @property
    def warm_up_remaining_sec(self) -> float | None:
        """Seconds remaining in warm-up, or None if not warming up."""
        if self._state != TradingState.WARMING_UP or self._warm_up_started_at is None:
            return None
        elapsed = time.monotonic() - self._warm_up_started_at
        remaining = self._warm_up_duration_sec - elapsed
        return max(0.0, remaining)

    @property
    def is_warming_up(self) -> bool:
        return self._state == TradingState.WARMING_UP

    # ── Trigger methods (called from asyncio coroutines) ──────────────────────

    def on_feed_disconnect(self) -> None:
        """
        Underlying WS disconnected or tick timeout exceeded.
        TRADING / WARMING_UP / CHAIN_STALE → FEED_STALE.
        Aborts any in-progress warm-up timer.
        """
        if self._state == TradingState.FEED_STALE:
            return  # already stale, no transition needed
        self._abort_warm_up()
        self._transition(TradingState.FEED_STALE, "feed_disconnect")

    def on_feed_reconnect_tick(self) -> None:
        """
        Dhan WS reconnected and first tick confirmed received after FEED_STALE.
        FEED_STALE → WARMING_UP, starts the warm-up countdown.
        No-op if already WARMING_UP or TRADING.
        """
        if self._state != TradingState.FEED_STALE:
            return
        self._warm_up_started_at = time.monotonic()
        self._transition(TradingState.WARMING_UP, "feed_reconnect_first_tick")

    def on_warm_up_complete(self) -> None:
        """
        Warm-up timer expired.
        WARMING_UP → TRADING (unless chain is currently stale).
        If chain is stale, goes to CHAIN_STALE instead and waits for recovery.
        """
        if self._state != TradingState.WARMING_UP:
            return
        self._abort_warm_up()
        if self._chain_stale:
            self._transition(TradingState.CHAIN_STALE, "warm_up_complete_chain_stale")
        else:
            self._transition(TradingState.TRADING, "warm_up_complete")

    def on_chain_stale(self) -> None:
        """
        Chain snapshot not received for > 30s.
        TRADING → CHAIN_STALE.
        Does not affect FEED_STALE or WARMING_UP (chain staleness latched separately).
        """
        self._chain_stale = True
        if self._state == TradingState.TRADING:
            self._transition(TradingState.CHAIN_STALE, "chain_snapshot_timeout")

    def on_chain_recovered(self) -> None:
        """
        Fresh chain snapshot received.
        CHAIN_STALE → TRADING (only if feed is healthy and warm-up is done).
        Clears the chain_stale latch.
        """
        self._chain_stale = False
        if self._state == TradingState.CHAIN_STALE:
            self._transition(TradingState.TRADING, "chain_snapshot_received")

    def on_expiry_rollover(self) -> None:
        """
        Option expiry rollover at ~14:30 IST.
        Any state → FEED_STALE. Buffers will be cleared by session manager.
        TFA re-subscribes to new expiry contracts, then resumes from FEED_STALE.
        Aborts warm-up timer.
        """
        self._abort_warm_up()
        self._chain_stale = False  # chain will be refreshed after rollover
        if self._state != TradingState.FEED_STALE:
            self._transition(TradingState.FEED_STALE, "expiry_rollover")

    def tick(self) -> None:
        """
        Call on every incoming underlying tick.
        Checks whether the warm-up timer has expired and auto-transitions
        WARMING_UP → TRADING when the duration is reached.

        This avoids needing a separate asyncio timer task — the tick dispatcher
        calls this naturally at the tick rate.
        """
        if self._state == TradingState.WARMING_UP and self._warm_up_started_at is not None:
            elapsed = time.monotonic() - self._warm_up_started_at
            if elapsed >= self._warm_up_duration_sec:
                self.on_warm_up_complete()

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _transition(self, new_state: TradingState, reason: str) -> None:
        old_state = self._state
        self._state = new_state
        self._trading_allowed = new_state == TradingState.TRADING
        if self._on_state_change is not None:
            self._on_state_change(old_state, new_state, reason)

    def _abort_warm_up(self) -> None:
        self._warm_up_started_at = None

    def __repr__(self) -> str:
        return (
            f"StateMachine(state={self._state.value}, "
            f"trading_allowed={self._trading_allowed}, "
            f"chain_stale={self._chain_stale})"
        )
