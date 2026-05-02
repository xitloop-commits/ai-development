"""
test_session.py — Unit tests for session.py.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_session.py -v
"""

from __future__ import annotations

import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pytest

from tick_feature_agent.buffers.option_buffer import OptionBufferStore, OptionTick
from tick_feature_agent.buffers.tick_buffer import CircularBuffer, UnderlyingTick
from tick_feature_agent.instrument_profile import load_profile
from tick_feature_agent.session import SessionManager, _now_ist
from tick_feature_agent.state_machine import StateMachine, TradingState

_IST = timezone(timedelta(hours=5, minutes=30))


# ── Helpers ───────────────────────────────────────────────────────────────────


def _load_nifty_profile():
    path = Path(__file__).resolve().parents[3] / "config/instrument_profiles/nifty50_profile.json"
    return load_profile(path)


def _make_components(warm_up_sec: int = 5):
    profile = _load_nifty_profile()
    sm = StateMachine(warm_up_duration_sec=warm_up_sec)
    tbuf = CircularBuffer(maxlen=50)
    obuf = OptionBufferStore()
    return profile, sm, tbuf, obuf


def _ist_dt(h: int, m: int, s: int = 0, day: date | None = None) -> datetime:
    """Create a datetime in IST at the given time on today (or given day)."""
    d = day or date(2026, 4, 13)
    return datetime(d.year, d.month, d.day, h, m, s, tzinfo=_IST)


def _utick() -> UnderlyingTick:
    return UnderlyingTick(timestamp=time.time(), ltp=22000.0, bid=21999.9, ask=22000.1, volume=1000)


def _otick() -> OptionTick:
    return OptionTick(
        timestamp=time.time(), ltp=100.0, bid=99.9, ask=100.1, bid_size=50, ask_size=60, volume=200
    )


# ══════════════════════════════════════════════════════════════════════════════
# Session start edge trigger
# ══════════════════════════════════════════════════════════════════════════════


class TestSessionStartEdgeTrigger:

    def test_market_closed_before_session_start(self):
        profile, sm, tbuf, obuf = _make_components()
        sess = SessionManager(profile, sm, tbuf, obuf)
        # 08:00 IST — before 09:15
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(8, 0)):
            assert sess.on_tick() is False
            assert sess.is_market_open is False

    def test_market_opens_at_session_start(self):
        profile, sm, tbuf, obuf = _make_components()
        sess = SessionManager(profile, sm, tbuf, obuf)
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(9, 15)):
            assert sess.on_tick() is True
            assert sess.is_market_open is True

    def test_session_start_fires_only_once_per_day(self):
        profile, sm, tbuf, obuf = _make_components()
        calls: list[int] = []
        sess = SessionManager(profile, sm, tbuf, obuf, on_session_start=lambda: calls.append(1))
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(9, 15)):
            sess.on_tick()
            sess.on_tick()
            sess.on_tick()
        assert len(calls) == 1  # fired exactly once

    def test_session_start_fires_again_next_day(self):
        profile, sm, tbuf, obuf = _make_components()
        calls: list[int] = []
        sess = SessionManager(profile, sm, tbuf, obuf, on_session_start=lambda: calls.append(1))
        day1 = date(2026, 4, 13)
        day2 = date(2026, 4, 14)
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(9, 15, day=day1)):
            sess.on_tick()
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(9, 15, day=day2)):
            sess.on_tick()
        assert len(calls) == 2

    def test_tick_after_session_start_returns_true(self):
        profile, sm, tbuf, obuf = _make_components()
        sess = SessionManager(profile, sm, tbuf, obuf)
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(10, 0)):
            assert sess.on_tick() is True


# ══════════════════════════════════════════════════════════════════════════════
# Session end
# ══════════════════════════════════════════════════════════════════════════════


class TestSessionEnd:

    def test_market_closes_at_session_end(self):
        profile, sm, tbuf, obuf = _make_components()
        sess = SessionManager(profile, sm, tbuf, obuf)
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(9, 15)):
            sess.on_tick()
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(15, 30)):
            result = sess.on_tick()
        assert result is False
        assert sess.is_market_open is False

    def test_session_end_callback_fires_once(self):
        profile, sm, tbuf, obuf = _make_components()
        calls: list[int] = []
        sess = SessionManager(profile, sm, tbuf, obuf, on_session_end=lambda: calls.append(1))
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(9, 15)):
            sess.on_tick()
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(15, 30)):
            sess.on_tick()
            sess.on_tick()
        assert len(calls) == 1


# ══════════════════════════════════════════════════════════════════════════════
# Buffer clearing on session start
# ══════════════════════════════════════════════════════════════════════════════


class TestBufferClearOnSessionStart:

    def test_tick_buffer_cleared(self):
        profile, sm, tbuf, obuf = _make_components()
        # Pre-populate the buffer
        for i in range(10):
            tbuf.push(_utick())
        assert len(tbuf) == 10

        sess = SessionManager(profile, sm, tbuf, obuf)
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(9, 15)):
            sess.on_tick()

        assert len(tbuf) == 0

    def test_option_buffer_cleared(self):
        profile, sm, tbuf, obuf = _make_components()
        obuf.register_strikes([21800, 21850])
        obuf.push(21800, "CE", _otick())
        assert obuf.tick_available(21800, "CE")

        sess = SessionManager(profile, sm, tbuf, obuf)
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(9, 15)):
            sess.on_tick()

        assert not obuf.tick_available(21800, "CE")

    def test_state_machine_reset_to_feed_stale(self):
        profile, sm, tbuf, obuf = _make_components()
        # Put state machine into TRADING
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()
        assert sm.state == TradingState.TRADING

        sess = SessionManager(profile, sm, tbuf, obuf)
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(9, 15)):
            sess.on_tick()

        assert sm.state == TradingState.FEED_STALE
        assert sm.trading_allowed is False


# ══════════════════════════════════════════════════════════════════════════════
# Expiry rollover
# ══════════════════════════════════════════════════════════════════════════════


class TestExpiryRollover:

    def _open_session(self, sess):
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(9, 15)):
            sess.on_tick()

    def test_rollover_clears_option_buffers(self):
        profile, sm, tbuf, obuf = _make_components()
        obuf.register_strikes([21800])
        obuf.push(21800, "CE", _otick())
        assert obuf.tick_available(21800, "CE")

        sess = SessionManager(profile, sm, tbuf, obuf)
        self._open_session(sess)
        obuf.push(21800, "CE", _otick())  # re-populate after session start clear

        sess.trigger_expiry_rollover()
        assert not obuf.tick_available(21800, "CE")

    def test_rollover_forces_state_machine_to_feed_stale(self):
        profile, sm, tbuf, obuf = _make_components()
        sess = SessionManager(profile, sm, tbuf, obuf)
        self._open_session(sess)
        sm.on_feed_reconnect_tick()
        sm.on_warm_up_complete()
        assert sm.state == TradingState.TRADING

        sess.trigger_expiry_rollover()
        assert sm.state == TradingState.FEED_STALE

    def test_rollover_fires_once(self):
        profile, sm, tbuf, obuf = _make_components()
        calls: list[int] = []
        sess = SessionManager(profile, sm, tbuf, obuf, on_rollover=lambda: calls.append(1))
        self._open_session(sess)
        sess.trigger_expiry_rollover()
        sess.trigger_expiry_rollover()  # second call is a no-op
        assert len(calls) == 1

    def test_rollover_sets_rolled_over_flag(self):
        profile, sm, tbuf, obuf = _make_components()
        sess = SessionManager(profile, sm, tbuf, obuf)
        self._open_session(sess)
        assert not sess.rolled_over
        sess.trigger_expiry_rollover()
        assert sess.rolled_over

    def test_rolled_over_resets_on_new_session(self):
        profile, sm, tbuf, obuf = _make_components()
        sess = SessionManager(profile, sm, tbuf, obuf)
        day1 = date(2026, 4, 13)
        day2 = date(2026, 4, 14)

        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(9, 15, day=day1)):
            sess.on_tick()
        sess.trigger_expiry_rollover()
        assert sess.rolled_over

        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(9, 15, day=day2)):
            sess.on_tick()
        assert not sess.rolled_over  # reset by new session start

    def test_in_rollover_grace_true_immediately_after_rollover(self):
        profile, sm, tbuf, obuf = _make_components()
        sess = SessionManager(profile, sm, tbuf, obuf)
        self._open_session(sess)
        assert not sess.in_rollover_grace
        sess.trigger_expiry_rollover()
        assert sess.in_rollover_grace

    def test_in_rollover_grace_false_after_grace_period(self):
        profile, sm, tbuf, obuf = _make_components()
        sess = SessionManager(profile, sm, tbuf, obuf)
        self._open_session(sess)
        # Patch the grace period to be very short
        sess._ROLLOVER_GRACE_SEC = 0.05
        sess.trigger_expiry_rollover()
        time.sleep(0.1)
        assert not sess.in_rollover_grace

    def test_rollover_callback_fired(self):
        profile, sm, tbuf, obuf = _make_components()
        calls: list[int] = []
        sess = SessionManager(profile, sm, tbuf, obuf, on_rollover=lambda: calls.append(1))
        self._open_session(sess)
        sess.trigger_expiry_rollover()
        assert len(calls) == 1


# ══════════════════════════════════════════════════════════════════════════════
# Pre-session tick handling
# ══════════════════════════════════════════════════════════════════════════════


class TestPreSessionTicks:

    def test_pre_session_tick_returns_false(self):
        profile, sm, tbuf, obuf = _make_components()
        sess = SessionManager(profile, sm, tbuf, obuf)
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(8, 0)):
            assert sess.on_tick() is False

    def test_multiple_pre_session_ticks_do_not_open_market(self):
        profile, sm, tbuf, obuf = _make_components()
        sess = SessionManager(profile, sm, tbuf, obuf)
        with patch("tick_feature_agent.session._now_ist", return_value=_ist_dt(8, 0)):
            for _ in range(10):
                result = sess.on_tick()
                assert result is False
        assert not sess.is_market_open
