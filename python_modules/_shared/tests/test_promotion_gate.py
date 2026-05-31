"""
Tests for ``_shared.promotion_gate`` + CLI integration for
``scripts/saturday_promote.py``.

Strategy: build synthetic bundle directories on tmp_path with
hand-crafted ``training_manifest.json`` files, then assert on the
``PromotionDecision`` shape + the LATEST-pointer side effect.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from _shared.promotion_gate import (
    DEFAULT_BASELINE_MULTIPLIER,
    DEFAULT_MIN_EXPECTANCY_INR,
    PromotionDecision,
    Verdict,
    decide_promotion,
    format_decision_for_telegram,
    list_dated_bundles,
    load_manifest,
    newest_bundle,
    resolve_current_latest_bundle,
    update_latest_pointer,
)


def _manifest(
    *,
    instrument: str = "nifty50",
    timestamp: str = "20260530_120000",
    sim_pnl_total_inr: float = 1000.0,
    sim_pnl_expectancy_inr: float = 10.0,
    sim_pnl_signals: int = 50,
    sim_pnl_wins: int = 30,
    sim_pnl_win_rate: float = 0.6,
    sim_pnl_max_drawdown_inr: float = -200.0,
    **extras,
) -> dict:
    """Minimal manifest dict covering the keys the gate reads."""
    return {
        "instrument": instrument,
        "timestamp": timestamp,
        "sim_pnl_total_inr": sim_pnl_total_inr,
        "sim_pnl_expectancy_inr": sim_pnl_expectancy_inr,
        "sim_pnl_signals": sim_pnl_signals,
        "sim_pnl_wins": sim_pnl_wins,
        "sim_pnl_win_rate": sim_pnl_win_rate,
        "sim_pnl_max_drawdown_inr": sim_pnl_max_drawdown_inr,
        **extras,
    }


# --- decide_promotion: PASS paths -------------------------------------------

def test_pass_when_candidate_beats_baseline_by_20pct():
    cand = _manifest(sim_pnl_total_inr=1500.0, sim_pnl_expectancy_inr=12.0)
    base = _manifest(timestamp="20260523_120000", sim_pnl_total_inr=1000.0)
    d = decide_promotion(candidate_manifest=cand, baseline_manifest=base)
    assert d.verdict is Verdict.PASS
    assert "1500" in d.reason and "1200" in d.reason


def test_pass_exactly_at_multiplier_boundary():
    cand = _manifest(sim_pnl_total_inr=1200.0, sim_pnl_expectancy_inr=10.0)
    base = _manifest(timestamp="20260523_120000", sim_pnl_total_inr=1000.0)
    d = decide_promotion(candidate_manifest=cand, baseline_manifest=base)
    assert d.verdict is Verdict.PASS  # ≥ is the contract


def test_pass_first_ever_bundle_no_baseline():
    cand = _manifest(sim_pnl_total_inr=500.0, sim_pnl_expectancy_inr=10.0)
    d = decide_promotion(candidate_manifest=cand, baseline_manifest=None)
    assert d.verdict is Verdict.PASS
    assert "first-ever" in d.reason
    assert d.baseline_timestamp is None


def test_pass_when_baseline_total_is_zero_or_negative():
    """Baseline of 0 means previous model was unprofitable. Any
    candidate clearing the expectancy floor should PASS — the
    multiplier comparison is degenerate.
    """
    cand = _manifest(sim_pnl_total_inr=500.0, sim_pnl_expectancy_inr=10.0)
    base_zero = _manifest(timestamp="20260523_120000", sim_pnl_total_inr=0.0)
    base_neg = _manifest(timestamp="20260523_120000", sim_pnl_total_inr=-500.0)
    for base in (base_zero, base_neg):
        d = decide_promotion(candidate_manifest=cand, baseline_manifest=base)
        assert d.verdict is Verdict.PASS, d.reason


# --- decide_promotion: FAIL paths -------------------------------------------

def test_fail_when_candidate_under_multiplier():
    cand = _manifest(sim_pnl_total_inr=1100.0, sim_pnl_expectancy_inr=10.0)
    base = _manifest(timestamp="20260523_120000", sim_pnl_total_inr=1000.0)
    d = decide_promotion(candidate_manifest=cand, baseline_manifest=base)
    assert d.verdict is Verdict.FAIL
    assert "1200" in d.reason  # required total


def test_fail_when_expectancy_below_floor():
    cand = _manifest(sim_pnl_total_inr=2000.0, sim_pnl_expectancy_inr=5.0)
    base = _manifest(timestamp="20260523_120000", sim_pnl_total_inr=1000.0)
    d = decide_promotion(candidate_manifest=cand, baseline_manifest=base)
    assert d.verdict is Verdict.FAIL
    assert "expectancy" in d.reason


def test_fail_first_ever_bundle_below_expectancy_floor():
    cand = _manifest(sim_pnl_total_inr=500.0, sim_pnl_expectancy_inr=3.0)
    d = decide_promotion(candidate_manifest=cand, baseline_manifest=None)
    assert d.verdict is Verdict.FAIL
    assert "first bundle" in d.reason


# --- decide_promotion: SKIP paths -------------------------------------------

def test_skip_when_candidate_already_latest():
    """If LATEST already points at the candidate, nothing to do."""
    cand = _manifest(timestamp="20260530_120000")
    base = _manifest(timestamp="20260530_120000")  # same timestamp
    d = decide_promotion(candidate_manifest=cand, baseline_manifest=base)
    assert d.verdict is Verdict.SKIP
    assert "already LATEST" in d.reason


def test_skip_when_candidate_older_than_baseline():
    cand = _manifest(timestamp="20260520_120000")
    base = _manifest(timestamp="20260530_120000")
    d = decide_promotion(candidate_manifest=cand, baseline_manifest=base)
    assert d.verdict is Verdict.SKIP
    assert "older" in d.reason


def test_skip_when_sim_pnl_skipped_flag_set():
    cand = _manifest(
        sim_pnl_skipped=True,
        sim_pnl_skipped_reason="val parquet lacks opt_atm_ce_bid",
    )
    base = _manifest(timestamp="20260523_120000")
    d = decide_promotion(candidate_manifest=cand, baseline_manifest=base)
    assert d.verdict is Verdict.SKIP
    assert "skipped" in d.reason.lower()
    assert "opt_atm_ce_bid" in d.reason


def test_skip_when_zero_signals():
    cand = _manifest(sim_pnl_signals=0)
    base = _manifest(timestamp="20260523_120000")
    d = decide_promotion(candidate_manifest=cand, baseline_manifest=base)
    assert d.verdict is Verdict.SKIP
    assert "0 signals" in d.reason


# --- bundle discovery + manifest I/O ----------------------------------------

def test_list_dated_bundles_skips_non_timestamped(tmp_path):
    instrument_dir = tmp_path / "nifty50"
    instrument_dir.mkdir()
    (instrument_dir / "20260524_115037").mkdir()
    (instrument_dir / "20260530_120000").mkdir()
    (instrument_dir / "LATEST").write_text("20260524_115037")  # text file, not a dir
    (instrument_dir / "_scratch").mkdir()  # not timestamp-shaped
    bundles = list_dated_bundles(instrument_dir)
    assert [b.name for b in bundles] == ["20260524_115037", "20260530_120000"]


def test_newest_bundle_returns_latest_timestamp(tmp_path):
    instrument_dir = tmp_path / "nifty50"
    instrument_dir.mkdir()
    for ts in ("20260524_115037", "20260530_120000", "20260524_114120"):
        (instrument_dir / ts).mkdir()
    assert newest_bundle(instrument_dir).name == "20260530_120000"


def test_newest_bundle_none_when_empty(tmp_path):
    instrument_dir = tmp_path / "nifty50"
    instrument_dir.mkdir()
    assert newest_bundle(instrument_dir) is None


def test_load_manifest_round_trip(tmp_path):
    bundle = tmp_path / "20260530_120000"
    bundle.mkdir()
    (bundle / "training_manifest.json").write_text(
        json.dumps({"instrument": "nifty50", "timestamp": "20260530_120000"}),
    )
    m = load_manifest(bundle)
    assert m["instrument"] == "nifty50"


def test_load_manifest_returns_none_when_missing(tmp_path):
    assert load_manifest(tmp_path / "nonexistent") is None


def test_load_manifest_returns_none_when_corrupt(tmp_path):
    bundle = tmp_path / "20260530_120000"
    bundle.mkdir()
    (bundle / "training_manifest.json").write_text("{ broken json")
    assert load_manifest(bundle) is None


def test_resolve_current_latest_from_text_pointer(tmp_path):
    instrument_dir = tmp_path / "nifty50"
    instrument_dir.mkdir()
    (instrument_dir / "20260524_115037").mkdir()
    (instrument_dir / "LATEST").write_text("20260524_115037")
    resolved = resolve_current_latest_bundle(instrument_dir)
    assert resolved.name == "20260524_115037"


def test_resolve_current_latest_none_when_pointer_dangling(tmp_path):
    instrument_dir = tmp_path / "nifty50"
    instrument_dir.mkdir()
    (instrument_dir / "LATEST").write_text("20260101_000000")  # no such dir
    assert resolve_current_latest_bundle(instrument_dir) is None


def test_resolve_current_latest_none_when_no_pointer(tmp_path):
    instrument_dir = tmp_path / "nifty50"
    instrument_dir.mkdir()
    assert resolve_current_latest_bundle(instrument_dir) is None


def test_update_latest_pointer_atomic(tmp_path):
    instrument_dir = tmp_path / "nifty50"
    instrument_dir.mkdir()
    (instrument_dir / "LATEST").write_text("20260101_000000")
    update_latest_pointer(instrument_dir, "20260530_120000")
    assert (instrument_dir / "LATEST").read_text() == "20260530_120000"
    # No .tmp left over after the move.
    assert not (instrument_dir / "LATEST.tmp").exists()


# --- format_decision_for_telegram -------------------------------------------

def test_telegram_format_contains_key_fields():
    cand = _manifest(sim_pnl_total_inr=1500.0, sim_pnl_expectancy_inr=12.0)
    base = _manifest(timestamp="20260523_120000", sim_pnl_total_inr=1000.0)
    d = decide_promotion(candidate_manifest=cand, baseline_manifest=base)
    text = format_decision_for_telegram(d)
    assert "PASS" in text
    assert "nifty50" in text
    assert "20260530_120000" in text  # candidate ts
    assert "20260523_120000" in text  # baseline ts
    assert "cand:" in text and "base:" in text


def test_telegram_format_skip_first_bundle():
    cand = _manifest()
    d = decide_promotion(candidate_manifest=cand, baseline_manifest=None)
    text = format_decision_for_telegram(d)
    assert "PASS" in text
    assert "base:" not in text  # no baseline → no baseline line


# --- CLI integration --------------------------------------------------------

def _write_bundle(
    instrument_dir: Path,
    timestamp: str,
    manifest_overrides: dict | None = None,
    instrument: str = "nifty50",
) -> Path:
    bundle = instrument_dir / timestamp
    bundle.mkdir(parents=True, exist_ok=True)
    m = _manifest(instrument=instrument, timestamp=timestamp)
    if manifest_overrides:
        m.update(manifest_overrides)
    (bundle / "training_manifest.json").write_text(json.dumps(m))
    return bundle


def test_cli_dry_run_does_not_touch_latest(tmp_path):
    repo = Path(__file__).resolve().parents[3]
    cli = repo / "scripts" / "saturday_promote.py"
    models_root = tmp_path / "models"
    inst_dir = models_root / "nifty50"
    _write_bundle(inst_dir, "20260523_120000", {"sim_pnl_total_inr": 1000.0})
    _write_bundle(inst_dir, "20260530_120000", {
        "sim_pnl_total_inr": 1500.0, "sim_pnl_expectancy_inr": 12.0,
    })
    (inst_dir / "LATEST").write_text("20260523_120000")

    result = subprocess.run(
        [sys.executable, str(cli),
         "--models-root", str(models_root),
         "--dry-run"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert "PASS" in result.stdout
    # LATEST not flipped under --dry-run.
    assert (inst_dir / "LATEST").read_text() == "20260523_120000"


def test_cli_promotes_on_pass(tmp_path):
    repo = Path(__file__).resolve().parents[3]
    cli = repo / "scripts" / "saturday_promote.py"
    models_root = tmp_path / "models"
    inst_dir = models_root / "nifty50"
    _write_bundle(inst_dir, "20260523_120000", {"sim_pnl_total_inr": 1000.0})
    _write_bundle(inst_dir, "20260530_120000", {
        "sim_pnl_total_inr": 1500.0, "sim_pnl_expectancy_inr": 12.0,
    })
    (inst_dir / "LATEST").write_text("20260523_120000")

    result = subprocess.run(
        [sys.executable, str(cli),
         "--models-root", str(models_root),
         "--no-telegram"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert (inst_dir / "LATEST").read_text() == "20260530_120000"


def test_cli_fail_exits_nonzero_and_does_not_promote(tmp_path):
    repo = Path(__file__).resolve().parents[3]
    cli = repo / "scripts" / "saturday_promote.py"
    models_root = tmp_path / "models"
    inst_dir = models_root / "nifty50"
    _write_bundle(inst_dir, "20260523_120000", {"sim_pnl_total_inr": 1000.0})
    _write_bundle(inst_dir, "20260530_120000", {
        "sim_pnl_total_inr": 1100.0,  # only +10%, fails 20% bar
        "sim_pnl_expectancy_inr": 10.0,
    })
    (inst_dir / "LATEST").write_text("20260523_120000")

    result = subprocess.run(
        [sys.executable, str(cli),
         "--models-root", str(models_root),
         "--no-telegram"],
        capture_output=True, text=True,
    )
    assert result.returncode == 1
    assert "FAIL" in result.stdout
    assert (inst_dir / "LATEST").read_text() == "20260523_120000"


def test_cli_no_promote_keeps_latest_on_pass(tmp_path):
    repo = Path(__file__).resolve().parents[3]
    cli = repo / "scripts" / "saturday_promote.py"
    models_root = tmp_path / "models"
    inst_dir = models_root / "nifty50"
    _write_bundle(inst_dir, "20260523_120000", {"sim_pnl_total_inr": 1000.0})
    _write_bundle(inst_dir, "20260530_120000", {
        "sim_pnl_total_inr": 1500.0, "sim_pnl_expectancy_inr": 12.0,
    })
    (inst_dir / "LATEST").write_text("20260523_120000")

    result = subprocess.run(
        [sys.executable, str(cli),
         "--models-root", str(models_root),
         "--no-promote", "--no-telegram"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    # PASS verdict but LATEST not flipped because --no-promote.
    assert (inst_dir / "LATEST").read_text() == "20260523_120000"
    assert "PASS" in result.stdout
    assert "would PROMOTE" in result.stderr


def test_cli_no_models_returns_nonzero(tmp_path):
    repo = Path(__file__).resolve().parents[3]
    cli = repo / "scripts" / "saturday_promote.py"
    result = subprocess.run(
        [sys.executable, str(cli),
         "--models-root", str(tmp_path / "empty"),
         "--no-telegram"],
        capture_output=True, text=True,
    )
    assert result.returncode == 2
    assert "no instruments" in result.stderr.lower()


def test_cli_explicit_instrument_list(tmp_path):
    repo = Path(__file__).resolve().parents[3]
    cli = repo / "scripts" / "saturday_promote.py"
    models_root = tmp_path / "models"
    for inst in ("nifty50", "banknifty"):
        inst_dir = models_root / inst
        _write_bundle(inst_dir, "20260523_120000", {
            "sim_pnl_total_inr": 1000.0,
        }, instrument=inst)
        _write_bundle(inst_dir, "20260530_120000", {
            "sim_pnl_total_inr": 1500.0, "sim_pnl_expectancy_inr": 12.0,
        }, instrument=inst)
        (inst_dir / "LATEST").write_text("20260523_120000")

    result = subprocess.run(
        [sys.executable, str(cli),
         "--models-root", str(models_root),
         "--instruments", "nifty50",
         "--no-telegram"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    # Only nifty50 promoted; banknifty untouched.
    assert (models_root / "nifty50" / "LATEST").read_text() == "20260530_120000"
    assert (models_root / "banknifty" / "LATEST").read_text() == "20260523_120000"
