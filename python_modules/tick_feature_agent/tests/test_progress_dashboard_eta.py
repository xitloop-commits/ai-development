"""
Tests for ``ProgressDashboard`` Overall row — aggregate ETA + bar fill.

Regression coverage for two bugs surfaced the same morning (2026-06-04):

  1. **Overall ETA stuck at --:--:--** until at least one date
     completed. With one worker per date (the common case), this
     meant the operator saw no overall ETA at all until the run was
     effectively done.

  2. **Overall bar empty** until at least one date completed. Same
     ``completed_dates / total`` formula. The bar would jump 0% →
     33% → 67% → 100% on date-level boundaries while the operator
     could see each per-date bar climbing steadily.

The fix on both: derive Overall from currently-running per-date
progress + ETA, falling back to "completed-only" only when no
running date has a measured rate yet. These tests pin the new
behaviour by rendering ``_render()`` to plaintext via
``Console.capture`` and asserting on the resulting ``Overall``
line.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

_ANSI = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")

_HERE = Path(__file__).resolve().parent
_PY_MODULES = _HERE.parent.parent
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from tick_feature_agent.replay.progress_dashboard import (  # noqa: E402
    ProgressDashboard,
)


def _render_plain(dash: ProgressDashboard) -> str:
    # Force a wide console so the 24-char Overall bar isn't truncated
    # under the default 79-column terminal. Without this, rich
    # squeezes the bar column down to ~18 cells and a 0.99 fill ends
    # up indistinguishable from 1.0 — the very state we're testing.
    dash._console.width = 200
    with dash._console.capture() as cap:
        dash._console.print(dash._render())
    # ``Console.capture`` preserves ANSI escapes; strip them for stable
    # substring assertions.
    return _ANSI.sub("", cap.get())


def _overall_eta_token(rendered: str) -> str:
    """Extract the Overall row's ETA token from rendered plaintext.

    The Overall row is the only line containing both ``Overall`` and
    ``ETA ``; the ETA value sits after ``ETA `` and runs to end-of-line.
    """
    for line in rendered.splitlines():
        if "Overall" in line and "ETA " in line:
            idx = line.find("ETA ")
            return line[idx + 4:].strip()
    raise AssertionError(
        f"no Overall ETA line found in rendered output:\n{rendered}"
    )


def _overall_bar_fill_count(rendered: str) -> tuple[int, int]:
    """Return ``(filled_chars, total_chars)`` for the Overall row's
    bar. Filled cells are rich's BLOCK ``█`` glyph (any style); empty
    cells are the SHADE ``░`` glyph from ``_render_bar``. Other text
    in the Overall row is ignored.
    """
    for line in rendered.splitlines():
        if "Overall" in line and "ETA " in line:
            filled = line.count("█")
            empty = line.count("░")
            return filled, filled + empty
    raise AssertionError(
        f"no Overall bar line found in rendered output:\n{rendered}"
    )


def test_eta_blank_when_no_workers_have_rate_yet():
    """Worker just spun up — no rate measurement yet → ETA stays --:--:--."""
    dates = ["2026-05-20", "2026-05-21", "2026-05-22"]
    progress_dict = {
        d: {"status": "running", "event_idx": 0,
            "total_events_est": 0, "rate": 0.0}
        for d in dates
    }
    dash = ProgressDashboard("nifty50", dates, workers=3, progress_dict=progress_dict)
    out = _render_plain(dash)
    assert _overall_eta_token(out) == "--:--:--"


def test_eta_derives_from_running_per_date_etas():
    """3 dates running concurrently, 3 workers, no pending → overall
    ETA equals max(per_date_eta). The slowest worker dictates wall-clock
    finish.
    """
    dates = ["2026-05-20", "2026-05-21", "2026-05-22"]
    # Concrete numbers that produce predictable ETAs:
    #   date A: 1,000,000 events, rate 5,000/s, processed 100,000
    #           → remaining 900,000 / 5,000 = 180 s
    #   date B: 1,000,000 events, rate 5,000/s, processed 500,000
    #           → remaining 500,000 / 5,000 = 100 s
    #   date C: 1,000,000 events, rate 5,000/s, processed 700,000
    #           →  60 s
    # max(180, 100, 60) = 180 s = 00:03:00 — should be the overall ETA.
    progress_dict = {
        "2026-05-20": {"status": "running", "event_idx": 100_000,
                       "total_events_est": 1_000_000, "rate": 5_000.0},
        "2026-05-21": {"status": "running", "event_idx": 500_000,
                       "total_events_est": 1_000_000, "rate": 5_000.0},
        "2026-05-22": {"status": "running", "event_idx": 700_000,
                       "total_events_est": 1_000_000, "rate": 5_000.0},
    }
    dash = ProgressDashboard("nifty50", dates, workers=3, progress_dict=progress_dict)
    out = _render_plain(dash)
    assert _overall_eta_token(out) == "00:03:00"


def test_eta_adds_pending_estimate_when_more_dates_than_workers():
    """5 dates total, 2 workers — 2 running, 3 pending. Overall ETA
    must include the time the pending dates will take after the
    currently-running ones finish (averaged full per-date duration
    fanned out over the worker pool).
    """
    dates = ["d1", "d2", "d3", "d4", "d5"]
    # Running:
    #   d1: 1M events, rate 10k/s, processed 100k → remaining 90s,
    #       full duration 100s
    #   d2: 1M events, rate 10k/s, processed 200k → remaining 80s,
    #       full duration 100s
    # max(running_eta) = 90s
    # pending 3 dates / 2 workers = ceil(3/2) = 2 batches
    # avg_full = 100s → pending_eta = 200s
    # total = 90 + 200 = 290s = 00:04:50
    progress_dict = {
        "d1": {"status": "running", "event_idx": 100_000,
               "total_events_est": 1_000_000, "rate": 10_000.0},
        "d2": {"status": "running", "event_idx": 200_000,
               "total_events_est": 1_000_000, "rate": 10_000.0},
        "d3": {"status": "pending"},
        "d4": {"status": "pending"},
        "d5": {"status": "pending"},
    }
    dash = ProgressDashboard("nifty50", dates, workers=2, progress_dict=progress_dict)
    out = _render_plain(dash)
    assert _overall_eta_token(out) == "00:04:50"


def test_eta_uses_completed_average_when_any_date_finished():
    """Even when running dates have per-date ETAs, the
    `completed_dates > 0` path takes priority — it's more accurate
    because it reflects real cost (including merge, validation,
    overhead) of finished dates.
    """
    dates = ["d1", "d2", "d3"]
    progress_dict = {
        "d1": {"status": "pass", "event_idx": 1_000_000},  # finished
        "d2": {"status": "running", "event_idx": 500_000,
               "total_events_est": 1_000_000, "rate": 5_000.0},
        "d3": {"status": "pending"},
    }
    dash = ProgressDashboard("nifty50", dates, workers=2, progress_dict=progress_dict)
    # Pin elapsed = 60s so the math is testable:
    #   avg_per_date = elapsed / completed = 60 / 1 = 60s
    #   remaining_dates = 3 - 1 = 2
    #   agg_eta = 2 * 60 = 120s = 00:02:00
    import time as _time
    dash._started_monotonic = _time.monotonic() - 60.0
    out = _render_plain(dash)
    # Allow ±1s slack for the elapsed snap inside _render.
    assert _overall_eta_token(out) in ("00:02:00", "00:02:01")


def test_eta_skips_running_dates_with_no_rate_estimate():
    """A running date whose rate is still 0 (first-tick startup)
    must not skew the overall ETA toward zero. Only running dates
    with a measured rate contribute.
    """
    dates = ["d1", "d2"]
    progress_dict = {
        # Has rate — contributes ETA = 60s
        "d1": {"status": "running", "event_idx": 100_000,
               "total_events_est": 700_000, "rate": 10_000.0},
        # No rate yet — must be ignored
        "d2": {"status": "running", "event_idx": 0,
               "total_events_est": 0, "rate": 0.0},
    }
    dash = ProgressDashboard("nifty50", dates, workers=2, progress_dict=progress_dict)
    out = _render_plain(dash)
    # (700k - 100k) / 10k = 60s = 00:01:00
    assert _overall_eta_token(out) == "00:01:00"


# ── Overall BAR fill — same root cause as ETA ───────────────────────────────

def test_bar_empty_when_no_running_progress():
    dates = ["d1", "d2", "d3"]
    progress_dict = {d: {"status": "pending"} for d in dates}
    dash = ProgressDashboard("nifty50", dates, workers=3, progress_dict=progress_dict)
    filled, total = _overall_bar_fill_count(_render_plain(dash))
    assert filled == 0 and total > 0


def test_bar_reflects_running_partial_progress():
    """Three dates running at 25%, 50%, 75% with no completions.
    Overall fill = (0.25 + 0.50 + 0.75) / 3 = 0.5 = 50% of bar.
    Render bar width is 24 chars → expect 12 filled.
    """
    dates = ["d1", "d2", "d3"]
    progress_dict = {
        "d1": {"status": "running", "event_idx": 250_000,
               "total_events_est": 1_000_000, "rate": 5_000.0},
        "d2": {"status": "running", "event_idx": 500_000,
               "total_events_est": 1_000_000, "rate": 5_000.0},
        "d3": {"status": "running", "event_idx": 750_000,
               "total_events_est": 1_000_000, "rate": 5_000.0},
    }
    dash = ProgressDashboard("nifty50", dates, workers=3, progress_dict=progress_dict)
    filled, total = _overall_bar_fill_count(_render_plain(dash))
    # 50% of 24 = 12 filled, give a tight ±1 tolerance for rounding.
    assert 11 <= filled <= 13, f"expected ~12 filled, got {filled}/{total}"


def test_bar_full_only_when_all_dates_completed():
    """Fill caps at 100% — guards against the running-partial pathway
    over-counting if a worker reports event_idx > total_events_est
    (which happens; the per-date estimator under-counts the trailing
    MCX session). All 3 terminal → full bar regardless.
    """
    dates = ["d1", "d2", "d3"]
    progress_dict = {
        "d1": {"status": "pass", "event_idx": 1_000_000},
        "d2": {"status": "warn", "event_idx": 1_000_000},
        "d3": {"status": "pass", "event_idx": 1_000_000},
    }
    dash = ProgressDashboard("nifty50", dates, workers=3, progress_dict=progress_dict)
    filled, total = _overall_bar_fill_count(_render_plain(dash))
    assert filled == total, f"expected full bar, got {filled}/{total}"


def test_bar_caps_at_full_on_estimator_overshoot():
    """If a worker's event_idx exceeds total_events_est (the per-date
    estimator under-counts MCX evening sessions; pct > 100% seen in
    real runs), the Overall bar must NOT reach full while the worker
    is still in `running` status — the cmd window is still busy in
    flush_all / merge / validate at that point. Cap at 99% so the
    operator sees "almost done" not "done".
    """
    dates = ["d1"]
    progress_dict = {
        "d1": {"status": "running", "event_idx": 2_500_000,  # 250%
               "total_events_est": 1_000_000, "rate": 5_000.0},
    }
    dash = ProgressDashboard("crudeoil", dates, workers=1, progress_dict=progress_dict)
    filled, total = _overall_bar_fill_count(_render_plain(dash))
    assert filled < total, (
        f"bar must cap below full while running; got {filled}/{total}"
    )


# ── Overshoot + "still running" UX rules ─────────────────────────────────────

def test_bar_caps_at_99_while_any_date_running_even_if_all_overshoot():
    """Three dates running, all at >100% (estimator overshoot). Overall
    bar still must NOT show full — that's reserved for "all terminal".
    """
    dates = ["d1", "d2", "d3"]
    progress_dict = {
        d: {"status": "running", "event_idx": 1_500_000,
            "total_events_est": 1_000_000, "rate": 5_000.0}
        for d in dates
    }
    dash = ProgressDashboard("crudeoil", dates, workers=3, progress_dict=progress_dict)
    filled, total = _overall_bar_fill_count(_render_plain(dash))
    assert filled < total
    # The clamp is at 99%, so we expect MOST of the bar full but not all.
    # Width 24 × 0.99 ≈ 23 filled cells.
    assert filled >= 22, f"99% cap should leave only ~1 cell empty; got {filled}/{total}"


def test_overall_eta_stays_nonzero_on_overshoot():
    """Single running date burning past its estimate must keep the
    Overall ETA above 00:00 — worker is still finalising (flush_all
    + merge + validate, ~15s typical) and the operator needs to know
    it isn't done yet.
    """
    dates = ["d1"]
    progress_dict = {
        "d1": {"status": "running", "event_idx": 1_500_000,
               "total_events_est": 1_000_000, "rate": 5_000.0},
    }
    dash = ProgressDashboard("crudeoil", dates, workers=1, progress_dict=progress_dict)
    out = _render_plain(dash)
    eta = _overall_eta_token(out)
    assert eta != "00:00:00", f"ETA must not collapse to 00:00 on overshoot, got {eta!r}"
    assert eta != "--:--:--", f"ETA must not be unknown on overshoot, got {eta!r}"


def test_per_date_finalising_marker_on_overshoot():
    """When a running date overshoots, the per-date chunk/status text
    column shows 'finalising (estimate exceeded)' so the operator
    knows the event loop is done and the worker is in tail phases.
    """
    dates = ["d1"]
    progress_dict = {
        "d1": {"status": "running", "event_idx": 1_500_000,
               "total_events_est": 1_000_000, "rate": 5_000.0},
    }
    dash = ProgressDashboard("crudeoil", dates, workers=1, progress_dict=progress_dict)
    rendered = _render_plain(dash)
    assert "finalising" in rendered.lower(), (
        f"expected per-date 'finalising' marker on overshoot, got:\n{rendered}"
    )


def test_bar_reaches_full_only_when_all_dates_terminal():
    """The 99% cap applies ONLY while at least one date is `running`.
    When every date is in a terminal verdict the Overall bar must be
    fully filled.
    """
    dates = ["d1", "d2"]
    progress_dict = {
        "d1": {"status": "pass", "event_idx": 1_000_000},
        "d2": {"status": "warn", "event_idx": 1_000_000},
    }
    dash = ProgressDashboard("nifty50", dates, workers=2, progress_dict=progress_dict)
    filled, total = _overall_bar_fill_count(_render_plain(dash))
    assert filled == total