"""TCS2 - tests for health reporting.

Spec: docs/systems/14_tcs2.md  D16, D17, D30

The case every test here circles: on 2026-09-18 the recorder stopped at 10:00
and nobody noticed for two and a half hours, with someone at the desk, because
the screen still looked alive.
"""
from __future__ import annotations

import json

import pytest

from tcs2.health import DEAD, IDLE, LATE, OK, Beat, Health

T0 = 1790000000.0


def health(**kw) -> Health:
    h = Health(instrument="nifty50", trade_date="2026-10-01", **kw)
    h.started_at = T0
    return h


# -- a single beat -------------------------------------------------------

def test_a_thread_that_never_beat_is_idle_not_ok():
    assert Beat("feed").status(T0) == IDLE


def test_a_fresh_beat_is_ok():
    b = Beat("feed")
    b.beat(T0)
    assert b.status(T0) == OK
    assert b.status(T0 + 59) == OK


def test_a_thread_goes_late_then_dead():
    b = Beat("feed")
    b.beat(T0)
    assert b.status(T0 + 61) == LATE
    assert b.status(T0 + 400) == DEAD


def test_beats_are_counted_and_the_first_sets_the_start():
    b = Beat("feed")
    b.beat(T0)
    b.beat(T0 + 1)
    assert b.beats == 2
    assert b.started_at == T0


def test_age_of_a_silent_thread_is_infinite_not_zero():
    """Zero would read as 'just beaten', which is the opposite of the truth."""
    assert Beat("recorder").age(T0) == float("inf")


# -- the three threads report separately --------------------------------

def test_a_live_gui_does_not_make_a_stopped_recorder_look_alive():
    """This is the 2026-09-18 failure, asserted.

    The GUI keeps repainting; the recorder stopped two hours ago. The recorder
    must read DEAD regardless of how healthy the GUI is.
    """
    h = health()
    h.feed.beat(T0)
    h.gui.beat(T0)
    h.recorder.beat(T0 - 7200)

    now = T0 + 1
    assert h.gui.status(now) == OK
    assert h.feed.status(now) == OK
    assert h.recorder.status(now) == DEAD
    assert h.worst(now) == DEAD


def test_a_frozen_gui_does_not_make_the_feed_look_dead():
    h = health()
    h.feed.beat(T0)
    h.recorder.beat(T0)
    h.gui.beat(T0 - 7200)
    now = T0 + 1
    assert h.feed.status(now) == OK
    assert h.gui.status(now) == DEAD


def test_worst_is_the_worst_of_the_three():
    h = health()
    h.feed.beat(T0)
    h.recorder.beat(T0 - 90)          # late
    h.gui.beat(T0)
    assert h.worst(T0) == LATE


def test_worst_is_ok_only_when_all_three_are():
    h = health()
    for b in h.threads:
        b.beat(T0)
    assert h.worst(T0) == OK


# -- derived numbers -----------------------------------------------------

def test_tick_rate_is_per_second_of_actual_data():
    h = health()
    h.ticks = 1200
    h.first_tick_at = T0
    h.last_tick_at = T0 + 60
    assert h.tick_rate() == pytest.approx(20.0)


def test_tick_rate_is_zero_before_any_ticks():
    assert health().tick_rate(T0) == 0.0


def test_coverage_is_legs_seen_over_legs_subscribed():
    h = health()
    h.legs_subscribed = 1500
    h.legs_seen = 1498
    assert h.coverage() == pytest.approx(1498 / 1500)


def test_coverage_is_zero_before_subscribing():
    assert health().coverage() == 0.0


# -- the structured object (D17) ----------------------------------------

def test_to_dict_carries_every_thread_with_age_and_status():
    h = health()
    h.feed.beat(T0)
    d = h.to_dict(T0 + 5)
    for name in ("feed", "recorder", "gui"):
        assert name in d
        assert "age" in d[name] and "status" in d[name]
    assert d["feed"]["status"] == OK
    assert d["recorder"]["status"] == IDLE


def test_to_dict_is_json_serialisable():
    """It has to be: the file record and any later consumer both need it."""
    h = health()
    h.feed.beat(T0)
    json.dumps(h.to_dict(T0))


def test_health_is_data_with_no_formatting_in_it():
    """D17: the screen renders it, a file records it, Telegram may later read it.

    So nothing here may bake in a presentation choice.
    """
    d = health().to_dict(T0)
    assert isinstance(d["worst"], str)
    assert isinstance(d["ticks"], int)
    assert isinstance(d["tick_rate"], float)


# -- the file record -----------------------------------------------------

def test_append_writes_one_json_line_per_call(tmp_path):
    h = health()
    p = tmp_path / "2026-10-01" / "nifty50.ndjson"
    h.feed.beat(T0)
    h.append_to(p, T0)
    h.append_to(p, T0 + 10)
    lines = p.read_text(encoding="utf-8").strip().split("\n")
    assert len(lines) == 2
    assert json.loads(lines[0])["ts"] == T0
    assert json.loads(lines[1])["ts"] == T0 + 10


def test_the_record_appends_rather_than_overwriting(tmp_path):
    """The value is the timeline - the screen already has the current value.

    T186 is unsolved largely because no such timeline exists for 2026-09-18.
    """
    h = health()
    p = tmp_path / "h.ndjson"
    for i in range(5):
        h.ticks = i * 100
        h.append_to(p, T0 + i)
    rows = [json.loads(x) for x in p.read_text(encoding="utf-8").strip().split("\n")]
    assert [r["ticks"] for r in rows] == [0, 100, 200, 300, 400]


def test_append_creates_the_directory(tmp_path):
    p = tmp_path / "deep" / "deeper" / "h.ndjson"
    health().append_to(p, T0)
    assert p.exists()


# -- counters ------------------------------------------------------------

def test_dropped_gui_updates_are_counted_not_hidden():
    """D16 allows dropping GUI frames, never ticks - so it must be visible."""
    h = health()
    h.gui_updates_dropped = 37
    assert h.to_dict(T0)["gui_updates_dropped"] == 37


def test_unknown_prints_are_surfaced():
    """T195: nobody has ever counted bookless prints. Now they are on screen."""
    h = health()
    h.unknown_prints = 812
    assert h.to_dict(T0)["unknown_prints"] == 812


def test_disconnects_are_recorded_with_their_reason():
    h = health()
    h.disconnects = 1
    h.last_disconnect = "804: Instruments exceed limit"
    d = h.to_dict(T0)
    assert d["disconnects"] == 1
    assert "804" in d["last_disconnect"]


def test_summary_is_one_readable_line():
    h = health()
    h.feed.beat(T0)
    h.recorder.beat(T0)
    h.gui.beat(T0)
    h.ticks, h.first_tick_at, h.last_tick_at = 600, T0, T0 + 60
    h.legs_seen, h.legs_subscribed = 1498, 1500
    line = h.summary(T0 + 60)
    assert "nifty50" in line and "feed" in line and "1,498/1,500" in line
