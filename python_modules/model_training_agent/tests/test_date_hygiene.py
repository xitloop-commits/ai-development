"""
Tests for date_hygiene.py — Phase 4 validator pre-flight.

Builds fake validation JSONs in tmp_path and confirms:
  - PASS / WARN / FAIL / MISSING classification
  - Default policy: drop FAILs, keep WARNs + MISSINGs
  - Flag overrides flip each independently
  - Summary lines are operator-readable + correct counts
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from model_training_agent.date_hygiene import (
    DateClassification,
    classify_dates,
    filter_for_training,
    format_summary_lines,
)


def _make_validation_json(
    root: Path,
    date: str,
    instrument: str,
    verdict: str,
    *,
    reason_check: str | None = None,
    reason_status: str | None = None,
) -> None:
    """Write a minimal validation JSON in the same shape the validator produces."""
    folder = root / date
    folder.mkdir(parents=True, exist_ok=True)
    layers: dict[str, dict] = {"data": {"checks": {}}}
    if reason_check and reason_status:
        layers["data"]["checks"][reason_check] = reason_status
    payload = {"date": date, "instrument": instrument, "verdict": verdict, "layers": layers}
    (folder / f"{instrument}_validation.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )


class TestClassifyDates:
    def test_pass_warn_fail_missing_split(self, tmp_path):
        root = tmp_path / "validation"
        _make_validation_json(root, "2026-06-01", "nifty50", "PASS")
        _make_validation_json(root, "2026-06-02", "nifty50", "WARN",
                              reason_check="regime",
                              reason_status="WARN — always 'NEUTRAL'")
        _make_validation_json(root, "2026-06-03", "nifty50", "FAIL",
                              reason_check="chain_pcr_atm",
                              reason_status="FAIL — 100.0% null post warm-up")
        # 2026-06-04 has no JSON file → MISSING
        dates = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"]

        cls = classify_dates(dates, "nifty50", root)
        assert cls.pass_dates == ["2026-06-01"]
        assert cls.warn_dates == ["2026-06-02"]
        assert cls.fail_dates == ["2026-06-03"]
        assert cls.missing_dates == ["2026-06-04"]
        assert "2026-06-02" in cls.reasons
        assert "always 'NEUTRAL'" in cls.reasons["2026-06-02"]
        assert "2026-06-03" in cls.reasons
        assert "chain_pcr_atm" in cls.reasons["2026-06-03"]

    def test_per_instrument_independence(self, tmp_path):
        """A FAIL for one instrument doesn't affect another."""
        root = tmp_path / "validation"
        _make_validation_json(root, "2026-06-01", "nifty50", "FAIL")
        _make_validation_json(root, "2026-06-01", "banknifty", "PASS")
        cls_nifty = classify_dates(["2026-06-01"], "nifty50", root)
        cls_bank = classify_dates(["2026-06-01"], "banknifty", root)
        assert cls_nifty.fail_dates == ["2026-06-01"]
        assert cls_bank.pass_dates == ["2026-06-01"]

    def test_malformed_json_treated_as_missing(self, tmp_path):
        root = tmp_path / "validation"
        folder = root / "2026-06-01"
        folder.mkdir(parents=True)
        (folder / "nifty50_validation.json").write_text("{not json", encoding="utf-8")
        cls = classify_dates(["2026-06-01"], "nifty50", root)
        assert cls.missing_dates == ["2026-06-01"]


class TestFilterForTraining:
    def setup_method(self):
        self._dates = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"]

    def _make_mixed_set(self, root: Path) -> None:
        _make_validation_json(root, "2026-06-01", "nifty50", "PASS")
        _make_validation_json(root, "2026-06-02", "nifty50", "WARN")
        _make_validation_json(root, "2026-06-03", "nifty50", "FAIL")
        # 2026-06-04: no file -> MISSING

    def test_default_drops_fails_keeps_warns_and_missing(self, tmp_path):
        root = tmp_path / "validation"
        self._make_mixed_set(root)
        kept, cls = filter_for_training(self._dates, "nifty50", root)
        assert kept == ["2026-06-01", "2026-06-02", "2026-06-04"]
        assert cls.fail_dates == ["2026-06-03"]

    def test_no_warns_flag_drops_warns(self, tmp_path):
        root = tmp_path / "validation"
        self._make_mixed_set(root)
        kept, _ = filter_for_training(
            self._dates, "nifty50", root, include_warns=False,
        )
        assert "2026-06-02" not in kept
        assert "2026-06-01" in kept

    def test_include_fails_flag_keeps_fails(self, tmp_path):
        root = tmp_path / "validation"
        self._make_mixed_set(root)
        kept, _ = filter_for_training(
            self._dates, "nifty50", root, include_fails=True,
        )
        assert "2026-06-03" in kept

    def test_missing_drop_policy(self, tmp_path):
        root = tmp_path / "validation"
        self._make_mixed_set(root)
        kept, _ = filter_for_training(
            self._dates, "nifty50", root, missing_policy="drop",
        )
        assert "2026-06-04" not in kept

    def test_returned_list_is_sorted(self, tmp_path):
        root = tmp_path / "validation"
        _make_validation_json(root, "2026-06-03", "nifty50", "PASS")
        _make_validation_json(root, "2026-06-01", "nifty50", "PASS")
        _make_validation_json(root, "2026-06-02", "nifty50", "WARN")
        kept, _ = filter_for_training(
            ["2026-06-03", "2026-06-01", "2026-06-02"], "nifty50", root,
        )
        assert kept == ["2026-06-01", "2026-06-02", "2026-06-03"]


class TestFormatSummaryLines:
    def test_contains_counts_and_dropped_fails(self, tmp_path):
        cls = DateClassification(
            pass_dates=["2026-06-01"],
            warn_dates=["2026-06-02"],
            fail_dates=["2026-06-03"],
            missing_dates=["2026-06-04"],
            reasons={
                "2026-06-02": "regime: WARN — always 'NEUTRAL'",
                "2026-06-03": "chain_pcr_atm: FAIL — 100.0% null",
            },
        )
        kept = ["2026-06-01", "2026-06-02", "2026-06-04"]
        lines = format_summary_lines(
            cls, kept,
            include_warns=True, include_fails=False, missing_policy="include",
        )
        blob = "\n".join(lines)
        assert "PASS 1" in blob and "WARN 1" in blob and "FAIL 1" in blob
        assert "Auto-dropped 1 FAIL" in blob
        assert "2026-06-03" in blob
        assert "Kept 1 WARN" in blob
        assert "2026-06-02" in blob

    def test_quiet_when_only_passes(self, tmp_path):
        cls = DateClassification(pass_dates=["2026-06-01", "2026-06-02"])
        kept = ["2026-06-01", "2026-06-02"]
        lines = format_summary_lines(
            cls, kept,
            include_warns=True, include_fails=False, missing_policy="include",
        )
        blob = "\n".join(lines)
        assert "PASS 2" in blob
        # No "Auto-dropped" / "Kept WARN" lines when there's nothing to report
        assert "Auto-dropped" not in blob
        assert "Kept" not in blob

    def test_warning_banner_when_include_fails_set(self, tmp_path):
        cls = DateClassification(
            pass_dates=["2026-06-01"],
            fail_dates=["2026-06-03"],
        )
        kept = ["2026-06-01", "2026-06-03"]  # FAIL kept
        lines = format_summary_lines(
            cls, kept,
            include_warns=True, include_fails=True, missing_policy="include",
        )
        blob = "\n".join(lines)
        assert "--include-fails in effect" in blob
