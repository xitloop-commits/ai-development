"""
Tests for esc_watcher.py — Phase 2 graceful Esc-stop UX (2026-06-20).

The watcher's interesting behavior (key polling, two-press confirmation,
SIGINT delivery) is Windows-only and not practically unit-testable
without simulating keyboard input. These tests cover the import + the
non-Windows no-op path, plus a small smoke test that asserts the
returned stop_event responds to .set().
"""
from __future__ import annotations

import sys
import threading
from unittest.mock import patch

from model_training_agent.esc_watcher import start_esc_watcher


class TestStartEscWatcher:
    def test_non_windows_returns_none_pair(self):
        """On non-Windows the watcher is a no-op and returns (None, None)."""
        with patch.object(sys, "platform", "linux"):
            stop_event, thread = start_esc_watcher(set_banner=None)
        assert stop_event is None
        assert thread is None

    def test_missing_set_banner_does_not_raise(self):
        """The watcher must accept set_banner=None without raising at
        start. On Windows this still spawns a thread; on non-Windows it's
        the no-op path. Either is fine — what matters is no exception."""
        stop_event, thread = start_esc_watcher(set_banner=None)
        if stop_event is not None:
            # Windows path — clean up the thread we just spawned.
            stop_event.set()
            if thread is not None:
                thread.join(timeout=1)

    def test_returned_event_terminates_thread(self):
        """When start_esc_watcher does return a thread (Windows), setting
        the event must let it exit promptly. On non-Windows this skips."""
        stop_event, thread = start_esc_watcher(set_banner=None)
        if stop_event is None:
            return  # non-Windows — no thread to stop
        assert isinstance(stop_event, threading.Event)
        assert thread is not None
        stop_event.set()
        thread.join(timeout=2)
        assert not thread.is_alive(), "watcher thread should exit when event is set"

    def test_set_banner_callback_signature(self):
        """The callback receives (text, style) where text can be None to
        clear the banner. We can't trigger a real keypress in a test, but
        we can verify the callback isn't invoked at startup (no banner
        until first Esc)."""
        calls: list[tuple] = []

        def _capture(text, style):
            calls.append((text, style))

        stop_event, thread = start_esc_watcher(set_banner=_capture)
        if stop_event is None:
            return  # non-Windows
        # Give the polling thread a slice to run — no Esc was pressed,
        # so no banner call should occur.
        import time
        time.sleep(0.1)
        stop_event.set()
        if thread is not None:
            thread.join(timeout=1)
        assert calls == [], (
            f"expected no banner calls without Esc input, got {calls!r}"
        )
