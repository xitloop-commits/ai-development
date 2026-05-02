"""
session.py — Session lifecycle management for TFA.

SessionManager fires exactly once per calendar day when the IST wall-clock
crosses session_start. It coordinates:
  - Buffer resets (underlying + option)
  - State machine transition
  - Expiry rollover lifecycle

All methods are called from the asyncio event loop thread — no locks needed.

IST = UTC+5:30
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import date as _date
from datetime import datetime, timedelta, timezone

from tick_feature_agent.buffers.option_buffer import OptionBufferStore
from tick_feature_agent.buffers.tick_buffer import CircularBuffer
from tick_feature_agent.instrument_profile import InstrumentProfile
from tick_feature_agent.state_machine import StateMachine

_IST = timezone(timedelta(hours=5, minutes=30))


def _now_ist() -> datetime:
    return datetime.now(_IST)


class SessionManager:
    """
    Edge-triggered session lifecycle coordinator.

    Call `on_tick()` on every incoming underlying tick. It checks the IST
    wall-clock and fires the session_start edge trigger exactly once per day.

    Usage:
        sm   = StateMachine(...)
        tbuf = CircularBuffer(50)
        obuf = OptionBufferStore()
        sess = SessionManager(profile, sm, tbuf, obuf,
                              on_session_start=my_callback,
                              on_rollover=my_rollover_callback)

        # in the tick handler:
        is_open = sess.on_tick()   # True once market is open
    """

    # Grace period after expiry rollover: discard old-expiry ticks for 5s
    _ROLLOVER_GRACE_SEC = 5.0

    def __init__(
        self,
        profile: InstrumentProfile,
        state_machine: StateMachine,
        tick_buffer: CircularBuffer,
        option_buffer: OptionBufferStore,
        on_session_start: Callable[[], None] | None = None,
        on_session_end: Callable[[], None] | None = None,
        on_rollover: Callable[[], None] | None = None,
    ) -> None:
        """
        Args:
            profile:          InstrumentProfile with session_start/end times.
            state_machine:    StateMachine to transition on session start.
            tick_buffer:      Underlying CircularBuffer to clear on session start.
            option_buffer:    OptionBufferStore to clear on session start + rollover.
            on_session_start: Optional callback fired when session opens.
            on_session_end:   Optional callback fired when session closes.
            on_rollover:      Optional callback fired after expiry rollover completes.
        """
        self._profile = profile
        self._sm = state_machine
        self._tick_buf = tick_buffer
        self._opt_buf = option_buffer
        self._on_session_start = on_session_start
        self._on_session_end = on_session_end
        self._on_rollover = on_rollover

        # Session state
        self._session_date: _date | None = None  # calendar day of last session start
        self._market_open: bool = False
        self._session_ended: bool = False

        # Rollover state
        self._rolled_over: bool = False
        self._rollover_grace_until: float | None = None  # monotonic time

    # ── Public properties ─────────────────────────────────────────────────────

    @property
    def is_market_open(self) -> bool:
        """True from session_start to session_end IST, else False."""
        return self._market_open

    @property
    def rolled_over(self) -> bool:
        """True after expiry rollover has fired for this session."""
        return self._rolled_over

    @property
    def in_rollover_grace(self) -> bool:
        """True for 5s after expiry rollover — old-expiry ticks should be discarded."""
        if self._rollover_grace_until is None:
            return False
        return time.monotonic() < self._rollover_grace_until

    # ── Main tick hook ────────────────────────────────────────────────────────

    def on_tick(self) -> bool:
        """
        Call on every incoming underlying tick.

        Checks IST wall-clock and fires edge triggers as needed.

        Returns:
            True if the market is currently open (session_start ≤ now < session_end).
            False for pre-session and post-session ticks.
        """
        now = _now_ist()
        now_time = now.time()
        today = now.date()

        t_start = self._profile.session_start_time()
        t_end = self._profile.session_end_time()

        # ── Session START edge trigger ────────────────────────────────────────
        # Fires exactly once per calendar day when we first cross session_start.
        # _session_date != today is the sole dedup guard — not self._market_open,
        # because _market_open may still be True when TFA runs across midnight
        # and the previous session_end was never received.
        if now_time >= t_start and self._session_date != today:
            self._session_date = today
            self._market_open = True
            self._session_ended = False
            self._rolled_over = False
            self._rollover_grace_until = None
            self._on_session_open()

        # ── Session END edge trigger ──────────────────────────────────────────
        elif self._market_open and not self._session_ended and now_time >= t_end:
            self._market_open = False
            self._session_ended = True
            self._on_session_close()

        return self._market_open

    # ── Rollover lifecycle ────────────────────────────────────────────────────

    def trigger_expiry_rollover(self) -> None:
        """
        Called by chain_poller.py when it detects the expiry rollover condition
        (snapshot_time ≥ 14:30 IST, expiry == today, not yet rolled over).

        Coordinates the 7-step rollover sequence (spec §5.1):
          1. Clear option tick buffers + reset tick_available flags.
          2. Set chain_available = False (caller must re-fetch chain).
          3. Force state machine → FEED_STALE.
          4. Start 5s grace timer for old-expiry tick discard.
          5. Set rolled_over flag.
          6. Fire on_rollover callback.
        """
        if self._rolled_over:
            return  # guard: fire once per session

        self._opt_buf.clear_all()
        self._sm.on_expiry_rollover()
        self._rolled_over = True
        self._rollover_grace_until = time.monotonic() + self._ROLLOVER_GRACE_SEC

        if self._on_rollover:
            self._on_rollover()

    # ── Internal ──────────────────────────────────────────────────────────────

    def _on_session_open(self) -> None:
        """
        Fired exactly once at session_start each calendar day.
        Clears all buffers and drives the state machine to WARMING_UP
        (via FEED_STALE) so the first real tick starts the warm-up timer.
        """
        self._tick_buf.clear()
        self._opt_buf.clear_all()
        # Ensure we start from a known FEED_STALE so the first tick after
        # open drives the WARMING_UP transition correctly.
        self._sm.on_feed_disconnect()  # idempotent if already FEED_STALE

        if self._on_session_start:
            self._on_session_start()

    def _on_session_close(self) -> None:
        if self._on_session_end:
            self._on_session_end()
