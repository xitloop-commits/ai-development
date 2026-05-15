"""Smoke tests for holdout_utils — config policy resolution and leak detection."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

from holdout_utils import (  # noqa: E402
    check_train_holdout_leak,
    load_holdout_config,
    resolve_holdout_dates,
)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _make_features_tree(root: Path, dates_by_inst: dict[str, list[str]]) -> None:
    """Create data/features/<DATE>/<inst>_features.parquet layout (the real one
    used by the project — date is top-level, parquet files per-instrument)."""
    for inst, days in dates_by_inst.items():
        for d in days:
            day_dir = root / d
            day_dir.mkdir(parents=True, exist_ok=True)
            (day_dir / f"{inst}_features.parquet").touch()


# ── load_holdout_config ──────────────────────────────────────────────────────

def test_load_config_missing_file_returns_none_policy(tmp_path):
    cfg = load_holdout_config(tmp_path / "does_not_exist.json")
    assert cfg == {"policy": "none"}


def test_load_config_malformed_returns_none_policy(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text("{not valid json")
    cfg = load_holdout_config(p)
    assert cfg == {"policy": "none"}


def test_load_config_round_trip(tmp_path):
    p = tmp_path / "h.json"
    p.write_text(json.dumps({"policy": "last_n_complete_dates", "n": 3}))
    cfg = load_holdout_config(p)
    assert cfg["policy"] == "last_n_complete_dates"
    assert cfg["n"] == 3


# ── resolve_holdout_dates: last_n_complete_dates ────────────────────────────

def test_resolve_last_n_picks_most_recent_intersection(tmp_path):
    _make_features_tree(tmp_path, {
        "nifty50":    ["2026-05-10", "2026-05-11", "2026-05-12", "2026-05-13"],
        "banknifty":  ["2026-05-10", "2026-05-11", "2026-05-12", "2026-05-13"],
        "crudeoil":   ["2026-05-10", "2026-05-11", "2026-05-12", "2026-05-13"],
        "naturalgas": ["2026-05-10", "2026-05-11", "2026-05-12", "2026-05-13"],
    })
    cfg = {"policy": "last_n_complete_dates", "n": 2}
    out = resolve_holdout_dates(features_root=tmp_path, config=cfg)
    assert out == ["2026-05-12", "2026-05-13"]


def test_resolve_last_n_ignores_dates_missing_for_an_instrument(tmp_path):
    # 05-13 is missing from naturalgas → should NOT be in the intersection.
    _make_features_tree(tmp_path, {
        "nifty50":    ["2026-05-12", "2026-05-13"],
        "banknifty":  ["2026-05-12", "2026-05-13"],
        "crudeoil":   ["2026-05-12", "2026-05-13"],
        "naturalgas": ["2026-05-12"],
    })
    cfg = {"policy": "last_n_complete_dates", "n": 2}
    out = resolve_holdout_dates(features_root=tmp_path, config=cfg)
    assert out == ["2026-05-12"]   # only one complete date exists


def test_resolve_last_n_zero_returns_empty(tmp_path):
    _make_features_tree(tmp_path, {i: ["2026-05-12"] for i in
                                   ("nifty50", "banknifty", "crudeoil", "naturalgas")})
    cfg = {"policy": "last_n_complete_dates", "n": 0}
    assert resolve_holdout_dates(features_root=tmp_path, config=cfg) == []


def test_resolve_no_features_returns_empty(tmp_path):
    cfg = {"policy": "last_n_complete_dates", "n": 2}
    assert resolve_holdout_dates(features_root=tmp_path, config=cfg) == []


# ── resolve_holdout_dates: last_n_per_instrument ────────────────────────────

def _make_raw_tree(root: Path, dates_by_inst: dict[str, list[str]]) -> None:
    """Create data/raw/<DATE>/<inst>_*.ndjson.gz layout (mirrors the project)."""
    for inst, days in dates_by_inst.items():
        for d in days:
            day_dir = root / d
            day_dir.mkdir(parents=True, exist_ok=True)
            (day_dir / f"{inst}_session.ndjson.gz").touch()


def test_resolve_per_instrument_picks_latest_per_inst(tmp_path):
    raw_root = tmp_path / "raw"
    feat_root = tmp_path / "features"
    _make_raw_tree(raw_root, {
        "nifty50":    ["2026-05-11", "2026-05-15"],
        "banknifty":  ["2026-05-11", "2026-05-15"],
        "crudeoil":   ["2026-05-06", "2026-05-11", "2026-05-15"],
        "naturalgas": ["2026-05-06", "2026-05-11", "2026-05-15"],
    })
    cfg = {"policy": "last_n_per_instrument", "n": 1}

    # Per-instrument: each gets its own most-recent N=1 date.
    assert resolve_holdout_dates(
        features_root=feat_root, raw_root=raw_root,
        instrument="nifty50", config=cfg,
    ) == ["2026-05-15"]
    assert resolve_holdout_dates(
        features_root=feat_root, raw_root=raw_root,
        instrument="crudeoil", config=cfg,
    ) == ["2026-05-15"]

    # No instrument → union across all 4 (all happen to share 05-15 here).
    union = resolve_holdout_dates(
        features_root=feat_root, raw_root=raw_root, config=cfg,
    )
    assert union == ["2026-05-15"]


def test_resolve_per_instrument_n2_returns_two_per_inst(tmp_path):
    raw_root = tmp_path / "raw"
    feat_root = tmp_path / "features"
    _make_raw_tree(raw_root, {
        "nifty50":    ["2026-05-10", "2026-05-11", "2026-05-15"],
        "banknifty":  ["2026-05-10", "2026-05-11", "2026-05-15"],
        "crudeoil":   ["2026-05-10", "2026-05-11", "2026-05-15"],
        "naturalgas": ["2026-05-10", "2026-05-11", "2026-05-15"],
    })
    cfg = {"policy": "last_n_per_instrument", "n": 2}
    out = resolve_holdout_dates(
        features_root=feat_root, raw_root=raw_root,
        instrument="nifty50", config=cfg,
    )
    assert out == ["2026-05-11", "2026-05-15"]


def test_resolve_per_instrument_unions_distinct_calendars(tmp_path):
    """If instruments have non-overlapping recent dates, union spans all."""
    raw_root = tmp_path / "raw"
    feat_root = tmp_path / "features"
    _make_raw_tree(raw_root, {
        "nifty50":    ["2026-05-14"],
        "banknifty":  ["2026-05-14"],
        "crudeoil":   ["2026-05-15"],   # MCX trades when NSE is closed
        "naturalgas": ["2026-05-15"],
    })
    cfg = {"policy": "last_n_per_instrument", "n": 1}
    union = resolve_holdout_dates(
        features_root=feat_root, raw_root=raw_root, config=cfg,
    )
    assert union == ["2026-05-14", "2026-05-15"]


# ── resolve_holdout_dates: explicit ─────────────────────────────────────────

def test_resolve_explicit(tmp_path):
    cfg = {"policy": "explicit", "dates": ["2026-04-29", "2026-05-06"]}
    out = resolve_holdout_dates(features_root=tmp_path, config=cfg)
    assert out == ["2026-04-29", "2026-05-06"]


def test_resolve_explicit_filters_non_strings(tmp_path):
    cfg = {"policy": "explicit", "dates": ["2026-05-13", None, 123, "2026-05-14"]}
    out = resolve_holdout_dates(features_root=tmp_path, config=cfg)
    assert out == ["2026-05-13", "2026-05-14"]


# ── resolve_holdout_dates: edge cases ───────────────────────────────────────

def test_resolve_unknown_policy_fails_safe(tmp_path):
    cfg = {"policy": "magic_future_policy"}
    assert resolve_holdout_dates(features_root=tmp_path, config=cfg) == []


def test_resolve_none_policy(tmp_path):
    cfg = {"policy": "none"}
    assert resolve_holdout_dates(features_root=tmp_path, config=cfg) == []


# ── check_train_holdout_leak ────────────────────────────────────────────────

def test_leak_detection_finds_overlap(tmp_path):
    _make_features_tree(tmp_path, {i: ["2026-05-12", "2026-05-13"] for i in
                                   ("nifty50", "banknifty", "crudeoil", "naturalgas")})
    cfg = {"policy": "last_n_complete_dates", "n": 2}
    leaks = check_train_holdout_leak(
        ["2026-05-10", "2026-05-12", "2026-05-13"],
        features_root=tmp_path,
        config=cfg,
    )
    assert leaks == ["2026-05-12", "2026-05-13"]


def test_leak_detection_no_overlap_returns_empty(tmp_path):
    _make_features_tree(tmp_path, {i: ["2026-05-12", "2026-05-13"] for i in
                                   ("nifty50", "banknifty", "crudeoil", "naturalgas")})
    cfg = {"policy": "last_n_complete_dates", "n": 2}
    leaks = check_train_holdout_leak(
        ["2026-05-08", "2026-05-09", "2026-05-10"],
        features_root=tmp_path,
        config=cfg,
    )
    assert leaks == []


def test_leak_detection_no_holdout_configured(tmp_path):
    cfg = {"policy": "none"}
    assert check_train_holdout_leak(["2026-05-13"], tmp_path, config=cfg) == []
