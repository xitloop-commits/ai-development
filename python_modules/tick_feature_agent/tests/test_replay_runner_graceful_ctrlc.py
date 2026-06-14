"""
Test for Ctrl+C graceful drain support in replay_runner.

Covers:
  - _worker_sigint_ignore actually installs SIG_IGN on SIGINT (so pool
    workers don't blow up with a traceback on console Ctrl+C).

The pause-for-keypress helper that used to live alongside this was
removed on 2026-06-14 — the dashboard now replays its final frame as
static text on the primary screen during __exit__, so no in-process
wait-for-key is needed; the `start-tfa.bat` wrapper's `pause` handles
the cmd-window-close case.

Does NOT cover the in-process drain loop end-to-end — that needs a
real ProcessPoolExecutor + a worker that blocks long enough to be
interrupted. Smoke-tested manually instead; the helper exercised here
is the bit where the behavioural change lives.
"""

from __future__ import annotations

import signal
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PY_MODULES = _HERE.parents[1]
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from tick_feature_agent.replay.replay_runner import (  # noqa: E402
    _start_esc_watcher,
    _worker_sigint_ignore,
)


def test_esc_watcher_returns_none_on_non_windows(monkeypatch):
    """ESC-key watcher is Windows-only (Lubas is Windows-only by design)
    so on POSIX hosts the helper must no-op gracefully and return None.
    Skipping on the actual Windows host because we can't fake
    sys.platform after import without breaking msvcrt resolution.
    """
    if sys.platform == "win32":
        import pytest
        pytest.skip("Can't fake non-windows path on Windows host")
    import threading as _t
    stop = _t.Event()
    result = _start_esc_watcher(stop)
    assert result is None


def test_esc_watcher_returns_thread_on_windows():
    """On Windows the watcher returns a daemon Thread that we can ask
    to stop via the event. Verifies the basic plumbing without
    simulating a keypress (that requires a console).
    """
    if sys.platform != "win32":
        import pytest
        pytest.skip("Windows-only test")
    import threading as _t
    stop = _t.Event()
    t = _start_esc_watcher(stop)
    assert t is not None
    assert t.is_alive()
    assert t.daemon is True
    stop.set()
    t.join(timeout=1.0)
    assert not t.is_alive(), "watcher thread must exit promptly when stop_event set"


def test_worker_sigint_ignore_installs_sig_ign(monkeypatch):
    """Running ``_worker_sigint_ignore`` swaps the SIGINT handler
    on the calling process to ``SIG_IGN``. We capture + restore so we
    don't kill the pytest runner's own Ctrl+C handling.
    """
    prev = signal.getsignal(signal.SIGINT)
    try:
        _worker_sigint_ignore()
        # After the initializer runs, the calling process should ignore
        # SIGINT — i.e. signal.getsignal returns signal.SIG_IGN.
        assert signal.getsignal(signal.SIGINT) == signal.SIG_IGN
    finally:
        # Restore so pytest's own Ctrl+C handler survives.
        signal.signal(signal.SIGINT, prev)
