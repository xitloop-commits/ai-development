"""
Tests for ``market_calendar`` — covers the original holiday-set behaviour
plus the T35 partial-session extensions.

Strategy: monkey-patch ``market_calendar._HOLIDAYS_JSON`` at the module
level to point at a per-test temporary file. Avoids depending on the
real ``config/market_holidays.json`` which is hand-edited annually and
would make these tests brittle.
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

import market_calendar as mc  # noqa: E402


@pytest.fixture
def write_holidays(tmp_path, monkeypatch):
    """Return a writer that puts JSON content into a temp file and
    re-points the module's _HOLIDAYS_JSON constant at it.
    """
    def _writer(content: dict) -> Path:
        path = tmp_path / "market_holidays.json"
        path.write_text(json.dumps(content), encoding="utf-8")
        monkeypatch.setattr(mc, "_HOLIDAYS_JSON", path)
        return path
    return _writer


# --- legacy holiday-set behaviour --------------------------------------------

def test_is_market_holiday_true_for_listed_date(write_holidays):
    write_holidays({"2026": ["2026-08-15"], "2027": []})
    assert mc.is_market_holiday(dt.date(2026, 8, 15))


def test_is_market_holiday_false_for_trading_date(write_holidays):
    write_holidays({"2026": ["2026-08-15"], "2027": []})
    assert not mc.is_market_holiday(dt.date(2026, 8, 14))


def test_is_market_holiday_handles_missing_file(monkeypatch, tmp_path):
    monkeypatch.setattr(mc, "_HOLIDAYS_JSON", tmp_path / "does_not_exist.json")
    # Fail-open: missing file should NOT mark today as a holiday.
    assert not mc.is_market_holiday(dt.date(2026, 8, 14))


def test_is_market_holiday_handles_corrupt_json(write_holidays, tmp_path, monkeypatch, capsys):
    bad = tmp_path / "bad.json"
    bad.write_text("{ not valid json", encoding="utf-8")
    monkeypatch.setattr(mc, "_HOLIDAYS_JSON", bad)
    # Fail-open + WARN on stderr.
    assert not mc.is_market_holiday(dt.date(2026, 8, 14))
    captured = capsys.readouterr()
    assert "failed to parse" in captured.err


def test_partial_sessions_key_excluded_from_holiday_set(write_holidays):
    """The new partial_sessions block must NOT leak into the
    holiday-date set — partial-session days are still trading days.
    """
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-11-12": {"session_end_sec": 69300, "reason": "Muhurat"},
        },
    })
    assert not mc.is_market_holiday(dt.date(2026, 11, 12))


# --- get_session_end_sec ----------------------------------------------------

def test_get_session_end_sec_default_nse(write_holidays):
    write_holidays({"2026": [], "partial_sessions": {}})
    assert mc.get_session_end_sec(dt.date(2026, 5, 30)) == mc.NSE_DEFAULT_END_SEC
    assert mc.NSE_DEFAULT_END_SEC == 55800  # 15:30 IST


def test_get_session_end_sec_default_mcx(write_holidays):
    write_holidays({"2026": [], "partial_sessions": {}})
    assert mc.get_session_end_sec(
        dt.date(2026, 5, 30), exchange="MCX",
    ) == mc.MCX_DEFAULT_END_SEC
    assert mc.MCX_DEFAULT_END_SEC == 84600  # 23:30 IST


def test_get_session_end_sec_partial_no_exchange_filter(write_holidays):
    """An entry with no `exchanges` field applies to all exchanges."""
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-11-12": {
                "session_end_sec": 69300,
                "reason": "Muhurat Diwali",
            },
        },
    })
    assert mc.get_session_end_sec(dt.date(2026, 11, 12)) == 69300
    assert mc.get_session_end_sec(dt.date(2026, 11, 12), exchange="MCX") == 69300


def test_get_session_end_sec_partial_with_exchange_filter(write_holidays):
    """An entry scoped to NSE only must NOT clamp MCX traders."""
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-11-12": {
                "session_end_sec": 69300,
                "reason": "Muhurat NSE only",
                "exchanges": ["NSE"],
            },
        },
    })
    assert mc.get_session_end_sec(
        dt.date(2026, 11, 12), exchange="NSE",
    ) == 69300
    # MCX should get its default close, NOT the partial-session value.
    assert mc.get_session_end_sec(
        dt.date(2026, 11, 12), exchange="MCX",
    ) == mc.MCX_DEFAULT_END_SEC


def test_get_session_end_sec_no_entry_returns_default(write_holidays):
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-11-12": {"session_end_sec": 69300, "reason": "Muhurat"},
        },
    })
    # Date not in partial_sessions → default end.
    assert mc.get_session_end_sec(
        dt.date(2026, 11, 13),
    ) == mc.NSE_DEFAULT_END_SEC


# --- is_partial_session_day -------------------------------------------------

def test_is_partial_session_day_true_no_exchange_filter(write_holidays):
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-11-12": {"session_end_sec": 69300, "reason": "Muhurat"},
        },
    })
    assert mc.is_partial_session_day(dt.date(2026, 11, 12))
    assert mc.is_partial_session_day(dt.date(2026, 11, 12), exchange="NSE")
    assert mc.is_partial_session_day(dt.date(2026, 11, 12), exchange="MCX")


def test_is_partial_session_day_exchange_scoped(write_holidays):
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-11-12": {
                "session_end_sec": 69300,
                "reason": "Muhurat",
                "exchanges": ["NSE"],
            },
        },
    })
    assert mc.is_partial_session_day(dt.date(2026, 11, 12), exchange="NSE")
    assert not mc.is_partial_session_day(
        dt.date(2026, 11, 12), exchange="MCX",
    )


def test_is_partial_session_day_false_for_normal_day(write_holidays):
    write_holidays({"2026": [], "partial_sessions": {}})
    assert not mc.is_partial_session_day(dt.date(2026, 5, 30))


# --- malformed partial_sessions entries -------------------------------------

def test_malformed_partial_session_missing_end_sec_skipped(
    write_holidays, capsys,
):
    """Entry without session_end_sec should be skipped silently + warn,
    NOT crash, and NOT pollute the loaded dict.
    """
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-11-12": {"reason": "typo, forgot session_end_sec"},
            "2026-11-13": {"session_end_sec": 69300, "reason": "ok"},
        },
    })
    assert mc.get_session_end_sec(
        dt.date(2026, 11, 12),
    ) == mc.NSE_DEFAULT_END_SEC
    assert mc.get_session_end_sec(dt.date(2026, 11, 13)) == 69300
    err = capsys.readouterr().err
    assert "missing 'session_end_sec'" in err


def test_malformed_partial_session_non_int_end_sec(write_holidays, capsys):
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-11-12": {"session_end_sec": "not a number", "reason": "x"},
        },
    })
    assert mc.get_session_end_sec(
        dt.date(2026, 11, 12),
    ) == mc.NSE_DEFAULT_END_SEC
    assert "non-int" in capsys.readouterr().err


def test_malformed_partial_session_out_of_range(write_holidays, capsys):
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-11-12": {"session_end_sec": 99999, "reason": "bad"},
            "2026-11-13": {"session_end_sec": -1, "reason": "bad"},
        },
    })
    assert mc.get_session_end_sec(
        dt.date(2026, 11, 12),
    ) == mc.NSE_DEFAULT_END_SEC
    assert mc.get_session_end_sec(
        dt.date(2026, 11, 13),
    ) == mc.NSE_DEFAULT_END_SEC
    err = capsys.readouterr().err
    assert "out of range" in err


def test_partial_sessions_not_a_dict(write_holidays):
    """A typo where partial_sessions is accidentally a list should be
    treated as absent rather than crashing.
    """
    write_holidays({
        "2026": [],
        "partial_sessions": ["2026-11-12"],  # wrong shape
    })
    assert not mc.is_partial_session_day(dt.date(2026, 11, 12))
    assert mc.get_session_end_sec(
        dt.date(2026, 11, 12),
    ) == mc.NSE_DEFAULT_END_SEC


# --- get_partial_session_reason ---------------------------------------------

def test_get_partial_session_reason(write_holidays):
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-11-12": {"session_end_sec": 69300, "reason": "Muhurat Diwali"},
        },
    })
    assert mc.get_partial_session_reason(
        dt.date(2026, 11, 12),
    ) == "Muhurat Diwali"
    assert mc.get_partial_session_reason(dt.date(2026, 11, 13)) is None


def test_get_partial_session_reason_empty_string_treated_as_none(write_holidays):
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-11-12": {"session_end_sec": 69300, "reason": ""},
        },
    })
    assert mc.get_partial_session_reason(dt.date(2026, 11, 12)) is None


# --- effective_session_end_epoch (T35-FU1) ----------------------------------

def _ist_epoch(year, month, day, hour, minute):
    """Helper: epoch seconds for a given IST wallclock time."""
    tz = dt.timezone(dt.timedelta(hours=5, minutes=30))
    return dt.datetime(year, month, day, hour, minute, tzinfo=tz).timestamp()


def test_effective_end_normal_day_returns_profile_default(write_holidays):
    """On a non-partial day, the helper must return the profile's
    default_hhmm converted to epoch — no partial-session lookup applies.
    """
    write_holidays({"2026": [], "partial_sessions": {}})
    epoch = mc.effective_session_end_epoch(
        "2026-05-29", exchange="NSE", default_hhmm="15:30",
    )
    assert epoch == _ist_epoch(2026, 5, 29, 15, 30)


def test_effective_end_normal_day_mcx(write_holidays):
    write_holidays({"2026": [], "partial_sessions": {}})
    epoch = mc.effective_session_end_epoch(
        "2026-05-29", exchange="MCX", default_hhmm="23:30",
    )
    assert epoch == _ist_epoch(2026, 5, 29, 23, 30)


def test_effective_end_muhurat_uses_later_close(write_holidays):
    """NSE Muhurat 19:15 IST is LATER than the default 15:30.
    The helper must use the partial value (19:15), not min(15:30, 19:15)
    — Muhurat sessions are shifted, not shortened.
    """
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-11-08": {
                "session_end_sec": 69300,   # 19:15 IST
                "reason": "Muhurat",
                "exchanges": ["NSE"],
            },
        },
    })
    epoch = mc.effective_session_end_epoch(
        "2026-11-08", exchange="NSE", default_hhmm="15:30",
    )
    assert epoch == _ist_epoch(2026, 11, 8, 19, 15)


def test_effective_end_mcx_morning_only_uses_earlier_close(write_holidays):
    """MCX morning-only at 17:00 IST is earlier than the default 23:30.
    The helper must return 17:00.
    """
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-01-01": {
                "session_end_sec": 61200,   # 17:00 IST
                "reason": "MCX morning-only",
                "exchanges": ["MCX"],
            },
        },
    })
    epoch = mc.effective_session_end_epoch(
        "2026-01-01", exchange="MCX", default_hhmm="23:30",
    )
    assert epoch == _ist_epoch(2026, 1, 1, 17, 0)


def test_effective_end_exchange_scoped_does_not_leak(write_holidays):
    """A partial-session entry scoped to NSE only must NOT change MCX's
    effective end on the same date — MCX gets its default.
    """
    write_holidays({
        "2026": [],
        "partial_sessions": {
            "2026-11-08": {
                "session_end_sec": 69300,
                "reason": "NSE Muhurat",
                "exchanges": ["NSE"],
            },
        },
    })
    # NSE clamps to 19:15.
    nse = mc.effective_session_end_epoch(
        "2026-11-08", exchange="NSE", default_hhmm="15:30",
    )
    assert nse == _ist_epoch(2026, 11, 8, 19, 15)
    # MCX gets the default 23:30 — not the NSE-scoped Muhurat value.
    mcx = mc.effective_session_end_epoch(
        "2026-11-08", exchange="MCX", default_hhmm="23:30",
    )
    assert mcx == _ist_epoch(2026, 11, 8, 23, 30)


def test_effective_end_handles_missing_partial_block(write_holidays):
    """JSON without a partial_sessions key at all — helper should fall
    back to the profile default for every date.
    """
    write_holidays({"2026": []})
    epoch = mc.effective_session_end_epoch(
        "2026-05-29", exchange="NSE", default_hhmm="15:30",
    )
    assert epoch == _ist_epoch(2026, 5, 29, 15, 30)
