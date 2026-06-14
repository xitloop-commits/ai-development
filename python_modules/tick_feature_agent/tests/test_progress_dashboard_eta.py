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


def test_per_date_overshoot_label_is_honest_not_finalising():
    """When a running date overshoots its event-count estimate, the
    per-date chunk/status text column must HONESTLY say the event-loop
    is still running with a wrong estimate — NOT 'finalising', which
    incorrectly implies the loop is done (2026-06-15 fix). The "real"
    finalising phases (flushing/merging/validating) emit their own
    phase= callback above and don't reach this branch.
    """
    dates = ["d1"]
    progress_dict = {
        "d1": {"status": "running", "event_idx": 1_500_000,
               "total_events_est": 1_000_000, "rate": 5_000.0},
    }
    dash = ProgressDashboard("crudeoil", dates, workers=1, progress_dict=progress_dict)
    rendered = _render_plain(dash)
    # New honest label
    assert "event-loop" in rendered.lower(), (
        f"expected per-date 'event-loop' marker on overshoot, got:\n{rendered}"
    )
    # And the misleading old label must NOT appear
    assert "finalising" not in rendered.lower(), (
        f"'finalising' label is misleading on overshoot — should be 'event-loop +X%' instead. Got:\n{rendered}"
    )
    # The ETA cell shows "?" (genuinely unknown) instead of "--:--:--"
    # (which reads as "we just haven't computed it yet").
    assert " ?" in rendered or "?" in rendered.split("\n")[-1] or " ? " in rendered, (
        f"expected ETA '?' for overshoot+running phase, got:\n{rendered}"
    )


def test_phase_flushing_rendered_visibly():
    """Worker emits ``phase: 'flushing'`` between event loop exit and
    the chunk merge. Dashboard must show "flushing pending rows..."
    in the per-date row so the operator can see what's happening.
    """
    dates = ["d1"]
    progress_dict = {
        "d1": {"status": "running", "event_idx": 1_000_000,
               "total_events_est": 1_000_000, "rate": 5_000.0,
               "phase": "flushing"},
    }
    dash = ProgressDashboard("nifty50", dates, workers=1, progress_dict=progress_dict)
    rendered = _render_plain(dash)
    assert "flushing" in rendered.lower(), (
        f"phase=flushing must surface a visible 'flushing' marker; got:\n{rendered}"
    )


def test_phase_flushing_shows_row_progress():
    """When the chunked flush_all surfaces rows_done/rows_total via
    ``chunk_done`` + ``chunks_total_est``, the dashboard renders
    ``flushing pending N,NNN/M,MMM rows...`` — operator can see the
    deque draining in real time during the 30s+ flush on long sessions.
    """
    dates = ["d1"]
    progress_dict = {
        "d1": {"status": "running", "event_idx": 1_000_000,
               "total_events_est": 1_000_000, "rate": 5_000.0,
               "phase": "flushing",
               "chunk_done": 8000, "chunks_total_est": 30000},
    }
    dash = ProgressDashboard("nifty50", dates, workers=1, progress_dict=progress_dict)
    rendered = _render_plain(dash)
    assert "8,000/30,000" in rendered, (
        f"flushing progress must surface as comma-formatted N/M; got:\n{rendered}"
    )


def test_phase_merging_shows_chunk_progress():
    """During chunk merge, the worker pushes (i, N) so the dashboard
    can show "merging chunks 42/55..." — actual movement during the
    10-30s merge instead of a static label.
    """
    dates = ["d1"]
    progress_dict = {
        "d1": {"status": "running", "event_idx": 1_000_000,
               "total_events_est": 1_000_000, "rate": 5_000.0,
               "phase": "merging",
               "chunk_done": 42, "chunks_total_est": 55},
    }
    dash = ProgressDashboard("nifty50", dates, workers=1, progress_dict=progress_dict)
    rendered = _render_plain(dash)
    assert "merging" in rendered.lower()
    assert "42/55" in rendered, (
        f"merging-phase row must show chunk progress; got:\n{rendered}"
    )


def test_phase_validating_rendered_visibly():
    dates = ["d1"]
    progress_dict = {
        "d1": {"status": "running", "event_idx": 1_000_000,
               "total_events_est": 1_000_000, "rate": 5_000.0,
               "phase": "validating"},
    }
    dash = ProgressDashboard("nifty50", dates, workers=1, progress_dict=progress_dict)
    assert "validating" in _render_plain(dash).lower()


def test_phase_stopping_rendered_in_red_with_marker():
    """2026-06-14 Ctrl+C graceful drain: worker emits phase=stopping
    just before the partial-chunk flush. Dashboard must surface the
    STOPPING marker text + paint the row in red so the operator can
    see at a glance which dates are mid-flush.
    """
    dates = ["d1"]
    progress_dict = {
        "d1": {"status": "running", "event_idx": 800_000,
               "total_events_est": 1_000_000, "rate": 5_000.0,
               "phase": "stopping"},
    }
    dash = ProgressDashboard("nifty50", dates, workers=1, progress_dict=progress_dict)
    rendered = _render_plain(dash)
    assert "stopping" in rendered.lower()
    assert "flushing partial chunk" in rendered.lower()


def test_phase_exited_rendered_with_state_saved_marker():
    """Worker emits phase=exited after the partial-chunk flush
    completes. Dashboard shows "EXITED (state saved, resumable)"
    so the operator confirms the date can be resumed cleanly.
    """
    dates = ["d1"]
    progress_dict = {
        "d1": {"status": "running", "event_idx": 800_000,
               "total_events_est": 1_000_000, "rate": 5_000.0,
               "phase": "exited"},
    }
    dash = ProgressDashboard("nifty50", dates, workers=1, progress_dict=progress_dict)
    rendered = _render_plain(dash)
    assert "exited" in rendered.lower()
    assert "state saved" in rendered.lower()
    assert "resumable" in rendered.lower()


def test_fail_row_inlines_reason_text():
    """2026-06-14: a failed date's row must show the failure reason
    inline (last column) so the operator can see WHY without depending
    on the Warnings & errors block — which can be clipped by narrow
    terminals or hidden by rich rendering quirks.
    """
    dates = ["2026-05-19"]
    progress_dict = {
        "2026-05-19": {
            "status": "fail",
            "reason": "worker process crashed: Error -3 while decompressing data: invalid block type",
        }
    }
    dash = ProgressDashboard("nifty50", dates, workers=1, progress_dict=progress_dict)
    rendered = _render_plain(dash)
    # The row itself must carry a recognisable slice of the reason —
    # truncated to 60 chars so it doesn't overflow narrow terminals.
    assert "worker process crashed" in rendered or "Error -3" in rendered


def test_warn_row_inlines_reason_text():
    """Same protection for WARN-verdict rows so validator-flagged
    anomalies (e.g. "always NEUTRAL regime", "null rates 10%+") show
    up inline as well.
    """
    dates = ["2026-06-02"]
    progress_dict = {
        "2026-06-02": {
            "status": "warn",
            "reason": "[regime.coverage] always NEUTRAL — 0 trend ticks",
        }
    }
    dash = ProgressDashboard("nifty50", dates, workers=1, progress_dict=progress_dict)
    rendered = _render_plain(dash)
    assert "NEUTRAL" in rendered


def test_pass_row_keeps_done_label():
    """PASS rows still show "done" — only fail/warn get the inline
    reason treatment (a passed date has nothing to apologise for).
    """
    dates = ["d1"]
    progress_dict = {"d1": {"status": "pass", "reason": "this should NOT appear"}}
    dash = ProgressDashboard("nifty50", dates, workers=1, progress_dict=progress_dict)
    rendered = _render_plain(dash)
    assert "this should NOT appear" not in rendered


def test_mode_str_rendered_in_header_when_provided():
    """2026-06-14: replay banner moved into the dashboard. When
    `mode_str` is supplied, the dashboard renders a "Mode  …" line so
    the operator sees instrument / mode / dates inside the alt-screen
    frame (and never sees a stale primary-screen banner after Ctrl+C
    tear-down).
    """
    dates = ["d1"]
    progress_dict = {"d1": {"status": "running"}}
    label = "replay  2026-06-09 … 2026-06-13  (5 dates)  ·  BANKNIFTY  (NSE)"
    dash = ProgressDashboard(
        "banknifty", dates, workers=1, progress_dict=progress_dict,
        mode_str=label,
    )
    rendered = _render_plain(dash)
    assert "Mode" in rendered
    assert "BANKNIFTY" in rendered
    assert "5 dates" in rendered


def test_mode_str_absent_when_not_provided():
    """Live mode and tests that don't pass `mode_str` must not get a
    "Mode  None" line by accident.
    """
    dates = ["d1"]
    progress_dict = {"d1": {"status": "running"}}
    dash = ProgressDashboard("nifty50", dates, workers=1, progress_dict=progress_dict)
    rendered = _render_plain(dash)
    # The literal "Mode  " label is added ONLY when mode_str is set.
    assert "Mode  " not in rendered


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