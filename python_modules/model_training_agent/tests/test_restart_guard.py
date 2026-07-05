"""
tests/test_restart_guard.py — regression guard for the spurious auto-restart
bug (2026-07-06).

A parallel training run finished successfully (both models written), then the
train-parallel.bat exit-75 loop re-launched the whole run from scratch. Root
cause: a late Esc-watcher SIGINT firing near the completion boundary landed on
the CLI's top-level `except KeyboardInterrupt`, which returned 75 ("restart
requested") — so the .bat looped.

The fix makes the restart decision completion-aware: once `_STATE["completed"]`
is set, a KeyboardInterrupt at the top level exits 0 instead of prompting /
returning 75. These tests lock that contract, plus the esc_watcher guard that
suppresses the SIGINT after stop has been requested.
"""

from __future__ import annotations

import pytest

from model_training_agent import cli


@pytest.fixture(autouse=True)
def _reset_state():
    prev = cli._STATE["completed"]
    cli._STATE["completed"] = False
    yield
    cli._STATE["completed"] = prev


def test_completed_run_interrupt_exits_zero(monkeypatch):
    # Guard the case the bug hit: model(s) written, then a stray SIGINT.
    cli._STATE["completed"] = True
    # If the prompt is ever reached, fail loudly (it must be bypassed).
    monkeypatch.setattr(
        "_shared.restart_prompt.prompt_restart_or_exit",
        lambda name: pytest.fail("restart prompt must not run after completion"),
    )
    assert cli._exit_code_after_interrupt() == 0


def test_incomplete_run_interrupt_prompts(monkeypatch):
    # A genuine mid-run Ctrl+C still routes to the R/X prompt.
    cli._STATE["completed"] = False
    monkeypatch.setattr(
        "_shared.restart_prompt.prompt_restart_or_exit", lambda name: 75
    )
    assert cli._exit_code_after_interrupt() == 75


def test_esc_watcher_rechecks_stop_before_firing_sigint():
    """The confirmed-Esc branch must re-check stop_event right before the
    os.kill (the SIGINT that used to land post-completion). The Windows fire
    path can't be driven without simulating keystrokes, so we lock the guard
    structurally: the block between the "STOPPING" banner and os.kill must
    contain a stop_event.is_set() bail-out."""
    import inspect

    import model_training_agent.esc_watcher as ew

    src = inspect.getsource(ew.start_esc_watcher)
    kill_at = src.index("os.kill")
    # The guard added by the fix sits in the confirmed-stop block, just above
    # the kill. Look in the window immediately preceding os.kill.
    window = src[max(0, kill_at - 400):kill_at]
    assert "stop_event.is_set()" in window, (
        "esc_watcher must re-check stop_event immediately before firing SIGINT"
    )
