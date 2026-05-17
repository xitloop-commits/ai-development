"""
tests/test_levels_store.py — Unit tests for state/levels_store.py.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_levels_store.py -v
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.state.levels_store import (  # noqa: E402
    CrossDayLevels,
    load,
    save,
    update,
)


# ── load() ────────────────────────────────────────────────────────────────────


class TestLoad:

    def test_missing_file_returns_empty_state(self, tmp_path):
        state = load(tmp_path / "does_not_exist.json")
        assert isinstance(state, CrossDayLevels)
        assert state.prev_day_high is None
        assert state.prev_day_low is None
        assert state.swing_5d_high is None
        assert state.swing_5d_low is None
        assert state.history == []

    def test_malformed_json_returns_empty_state(self, tmp_path):
        p = tmp_path / "bad.json"
        p.write_text("{not valid json at all", encoding="utf-8")
        state = load(p)
        assert isinstance(state, CrossDayLevels)
        assert state.history == []
        assert state.prev_day_high is None

    def test_non_dict_root_returns_empty_state(self, tmp_path):
        p = tmp_path / "list.json"
        p.write_text("[1, 2, 3]", encoding="utf-8")
        state = load(p)
        assert state == CrossDayLevels()

    def test_malformed_history_rows_dropped(self, tmp_path):
        p = tmp_path / "mixed.json"
        p.write_text(
            json.dumps(
                {
                    "history": [
                        {"date": "2026-05-13", "high": 100.0, "low": 90.0},
                        "not a dict",
                        {"date": "", "high": 110.0, "low": 95.0},  # empty date
                        {"date": "2026-05-14", "high": -1.0, "low": 95.0},  # bad high
                        {"date": "2026-05-15", "high": 120.0, "low": 100.0},
                    ]
                }
            ),
            encoding="utf-8",
        )
        state = load(p)
        assert len(state.history) == 2
        assert [r["date"] for r in state.history] == ["2026-05-13", "2026-05-15"]


# ── save() / round-trip ──────────────────────────────────────────────────────


class TestSaveLoadRoundTrip:

    def test_round_trip_populated_state(self, tmp_path):
        original = CrossDayLevels(
            prev_day_high=24380.5,
            prev_day_low=24105.2,
            swing_5d_high=24500.0,
            swing_5d_low=23980.0,
            history=[
                {"date": "2026-05-13", "high": 24210.1, "low": 24005.0},
                {"date": "2026-05-14", "high": 24380.5, "low": 24105.2},
            ],
        )
        p = tmp_path / "nifty_levels.json"
        save(original, p)
        loaded = load(p)
        assert loaded.prev_day_high == pytest.approx(24380.5)
        assert loaded.prev_day_low == pytest.approx(24105.2)
        assert loaded.swing_5d_high == pytest.approx(24500.0)
        assert loaded.swing_5d_low == pytest.approx(23980.0)
        assert loaded.history == original.history

    def test_save_is_pretty_printed(self, tmp_path):
        state = CrossDayLevels(prev_day_high=100.0, prev_day_low=90.0)
        p = tmp_path / "out.json"
        save(state, p)
        text = p.read_text(encoding="utf-8")
        # Pretty-print = at least one newline + indentation
        assert "\n" in text
        assert "  " in text

    def test_save_no_tmp_file_remains(self, tmp_path):
        state = CrossDayLevels(prev_day_high=100.0, prev_day_low=90.0)
        p = tmp_path / "atomic.json"
        save(state, p)
        # No leftover .tmp file
        leftovers = list(tmp_path.glob("*.tmp"))
        assert leftovers == []
        assert p.exists()

    def test_save_uses_atomic_replace(self, tmp_path, monkeypatch):
        """Verify save() writes to <path>.tmp first, then calls os.replace()."""
        import os
        from tick_feature_agent.state import levels_store as ls

        observed: dict = {"tmp_exists_at_replace": False, "called": False}

        original_replace = os.replace

        def spy_replace(src, dst):
            observed["called"] = True
            observed["tmp_exists_at_replace"] = Path(src).exists()
            observed["src"] = str(src)
            observed["dst"] = str(dst)
            return original_replace(src, dst)

        monkeypatch.setattr(ls.os, "replace", spy_replace)

        state = CrossDayLevels(prev_day_high=100.0, prev_day_low=90.0)
        p = tmp_path / "atomic.json"
        save(state, p)

        assert observed["called"] is True
        assert observed["tmp_exists_at_replace"] is True
        assert observed["src"].endswith(".tmp")
        assert observed["dst"] == str(p)

    def test_save_creates_parent_directory(self, tmp_path):
        state = CrossDayLevels(prev_day_high=100.0, prev_day_low=90.0)
        nested = tmp_path / "data" / "state" / "NIFTY_levels.json"
        save(state, nested)
        assert nested.exists()


# ── update() ─────────────────────────────────────────────────────────────────


class TestUpdate:

    def test_first_close_seeds_state(self):
        s = CrossDayLevels()
        out = update(s, "2026-05-13", 100.0, 90.0)
        assert out.prev_day_high == pytest.approx(100.0)
        assert out.prev_day_low == pytest.approx(90.0)
        assert out.swing_5d_high == pytest.approx(100.0)
        assert out.swing_5d_low == pytest.approx(90.0)
        assert len(out.history) == 1
        assert out.history[0] == {"date": "2026-05-13", "high": 100.0, "low": 90.0}

    def test_five_consecutive_days_retained(self):
        s = CrossDayLevels()
        days = [
            ("2026-05-11", 100.0, 90.0),
            ("2026-05-12", 110.0, 95.0),
            ("2026-05-13", 105.0, 92.0),
            ("2026-05-14", 120.0, 100.0),
            ("2026-05-15", 115.0, 98.0),
        ]
        for d, hi, lo in days:
            s = update(s, d, hi, lo)
        assert len(s.history) == 5
        assert s.swing_5d_high == pytest.approx(120.0)  # max of all 5
        assert s.swing_5d_low == pytest.approx(90.0)    # min of all 5

    def test_sixth_day_drops_oldest(self):
        s = CrossDayLevels()
        for d, hi, lo in [
            ("2026-05-11", 100.0, 90.0),  # this should be dropped
            ("2026-05-12", 110.0, 95.0),
            ("2026-05-13", 105.0, 92.0),
            ("2026-05-14", 120.0, 100.0),
            ("2026-05-15", 115.0, 98.0),
        ]:
            s = update(s, d, hi, lo)
        s = update(s, "2026-05-16", 125.0, 105.0)
        assert len(s.history) == 5
        dates = [r["date"] for r in s.history]
        assert "2026-05-11" not in dates
        assert dates == ["2026-05-12", "2026-05-13", "2026-05-14", "2026-05-15", "2026-05-16"]
        assert s.swing_5d_high == pytest.approx(125.0)
        assert s.swing_5d_low == pytest.approx(92.0)  # no longer 90.0; the 11th was dropped

    def test_re_update_same_date_replaces_not_duplicates(self):
        s = CrossDayLevels()
        s = update(s, "2026-05-13", 100.0, 90.0)
        s = update(s, "2026-05-13", 105.0, 88.0)  # late revision of same day
        assert len(s.history) == 1
        assert s.history[0] == {"date": "2026-05-13", "high": 105.0, "low": 88.0}
        assert s.prev_day_high == pytest.approx(105.0)
        assert s.prev_day_low == pytest.approx(88.0)

    @pytest.mark.parametrize(
        "hi, lo",
        [
            (None, 90.0),
            (100.0, None),
            (float("nan"), 90.0),
            (100.0, float("nan")),
            (0.0, 90.0),
            (100.0, 0.0),
            (-1.0, 90.0),
            (100.0, -1.0),
            (float("inf"), 90.0),
        ],
    )
    def test_invalid_high_or_low_leaves_state_unchanged(self, hi, lo):
        s = CrossDayLevels(
            prev_day_high=100.0,
            prev_day_low=90.0,
            swing_5d_high=100.0,
            swing_5d_low=90.0,
            history=[{"date": "2026-05-13", "high": 100.0, "low": 90.0}],
        )
        out = update(s, "2026-05-14", hi, lo)
        # Same state object semantically (no change).
        assert out.prev_day_high == pytest.approx(100.0)
        assert out.prev_day_low == pytest.approx(90.0)
        assert out.history == s.history

    def test_invalid_session_date_leaves_state_unchanged(self):
        s = CrossDayLevels(
            prev_day_high=100.0,
            prev_day_low=90.0,
            history=[{"date": "2026-05-13", "high": 100.0, "low": 90.0}],
        )
        out_empty = update(s, "", 110.0, 95.0)
        assert out_empty == s
        out_none = update(s, None, 110.0, 95.0)  # type: ignore[arg-type]
        assert out_none == s

    def test_prev_day_h_l_reflect_just_passed_session(self):
        """After update(), prev_day_high == the session_high just passed —
        NOT whatever prev_day_high was on the input state."""
        s = CrossDayLevels(prev_day_high=999.0, prev_day_low=1.0)  # stale
        out = update(s, "2026-05-14", 110.0, 95.0)
        assert out.prev_day_high == pytest.approx(110.0)
        assert out.prev_day_low == pytest.approx(95.0)

    def test_swing_recomputed_from_history(self):
        s = CrossDayLevels()
        for d, hi, lo in [
            ("2026-05-12", 100.0, 80.0),
            ("2026-05-13", 130.0, 95.0),
            ("2026-05-14", 110.0, 70.0),  # introduces the global low
        ]:
            s = update(s, d, hi, lo)
        assert s.swing_5d_high == pytest.approx(130.0)
        assert s.swing_5d_low == pytest.approx(70.0)

    def test_history_sorted_ascending_after_each_update(self):
        s = CrossDayLevels()
        # Intentionally insert out of order
        s = update(s, "2026-05-15", 115.0, 98.0)
        s = update(s, "2026-05-11", 100.0, 90.0)
        s = update(s, "2026-05-13", 105.0, 92.0)
        s = update(s, "2026-05-12", 110.0, 95.0)
        dates = [r["date"] for r in s.history]
        assert dates == sorted(dates)
        assert dates == ["2026-05-11", "2026-05-12", "2026-05-13", "2026-05-15"]

    def test_update_returns_new_object_not_mutated_input(self):
        s = CrossDayLevels()
        out = update(s, "2026-05-13", 100.0, 90.0)
        assert s.history == []  # input untouched
        assert out is not s
        assert out.history != s.history

    def test_save_load_after_multi_day_update(self, tmp_path):
        """End-to-end: 6 updates → save → load → state identical."""
        s = CrossDayLevels()
        for d, hi, lo in [
            ("2026-05-11", 100.0, 90.0),
            ("2026-05-12", 110.0, 95.0),
            ("2026-05-13", 105.0, 92.0),
            ("2026-05-14", 120.0, 100.0),
            ("2026-05-15", 115.0, 98.0),
            ("2026-05-16", 125.0, 105.0),
        ]:
            s = update(s, d, hi, lo)
        p = tmp_path / "nifty.json"
        save(s, p)
        loaded = load(p)
        assert loaded.prev_day_high == pytest.approx(125.0)
        assert loaded.prev_day_low == pytest.approx(105.0)
        assert loaded.swing_5d_high == pytest.approx(125.0)
        assert loaded.swing_5d_low == pytest.approx(92.0)
        assert len(loaded.history) == 5
        assert [r["date"] for r in loaded.history] == [
            "2026-05-12",
            "2026-05-13",
            "2026-05-14",
            "2026-05-15",
            "2026-05-16",
        ]
