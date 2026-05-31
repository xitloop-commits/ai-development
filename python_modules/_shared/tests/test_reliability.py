"""
Tests for ``_shared.reliability`` + CLI integration for
``scripts/trade_quality_report_weekly.py``.

Covers:
  - binary-head detection (positive cases, regression-magnitude exclusion,
    unknown head names).
  - decile slicing for evenly + unevenly divisible row counts.
  - PASS verdict on a perfectly-calibrated synthetic distribution.
  - FAIL verdict on a deliberately miscalibrated one.
  - SKIPPED verdict when there aren't enough outcomes.
  - score_all_heads filters non-binary heads automatically.
  - markdown summary mentions PASS / FAIL / SKIPPED + cohort table.
  - CLI script reads a week of synthetic parquets and writes md+csv.
"""

from __future__ import annotations

import subprocess
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq

from _shared.reliability import (
    DecileBucket,
    HeadCalibrationReport,
    _equal_size_decile_indices,
    is_binary_classifier_head,
    render_markdown_summary,
    score_all_heads,
    score_head_calibration,
)


def _make_df(
    head_name: str,
    head_type: str | None,
    probs: list[float],
    directions: list[int | None],
) -> pl.DataFrame:
    """Build a one-head synthetic predictions df matching T41's schema-ish
    (only the columns reliability.py reads).
    """
    return pl.DataFrame({
        "head_name": [head_name] * len(probs),
        "head_type": [head_type] * len(probs),
        "calibrated_prob": probs,
        "outcome_direction": directions,
    }, schema={
        "head_name": pl.Utf8,
        "head_type": pl.Utf8,
        "calibrated_prob": pl.Float64,
        "outcome_direction": pl.Int8,
    })


# --- binary-head detection -------------------------------------------------

def test_is_binary_classifier_head_direction():
    assert is_binary_classifier_head("direction_30s")
    assert is_binary_classifier_head("direction_60s")


def test_is_binary_classifier_head_direction_persists():
    assert is_binary_classifier_head("direction_persists_60s")
    assert is_binary_classifier_head("direction_persists_300s")


def test_is_binary_classifier_head_breakout():
    assert is_binary_classifier_head("breakout_in_60s")
    assert is_binary_classifier_head("breakout_in_300s")


def test_is_binary_classifier_head_exit():
    assert is_binary_classifier_head("exit_signal_60s")
    assert is_binary_classifier_head("exit_signal_300s")


def test_direction_magnitude_excluded():
    """direction_30s_magnitude shares the direction_ prefix but emits a
    regression value, not a probability. Must not be treated as binary.
    """
    assert not is_binary_classifier_head("direction_30s_magnitude")
    assert not is_binary_classifier_head("direction_60s_magnitude")


def test_unknown_heads_excluded():
    assert not is_binary_classifier_head("max_upside_60s")
    assert not is_binary_classifier_head("max_drawdown_300s")
    assert not is_binary_classifier_head("risk_reward_ratio_60s")
    assert not is_binary_classifier_head("foo_bar_baz")


# --- decile-index slicing --------------------------------------------------

def test_decile_slices_even_division():
    slices = _equal_size_decile_indices(100, 10)
    assert len(slices) == 10
    assert slices[0] == (0, 10)
    assert slices[-1] == (90, 100)
    # No overlap, fully covered.
    assert sum(end - start for start, end in slices) == 100


def test_decile_slices_uneven_division():
    """123 rows over 10 deciles → some deciles get 13, others 12."""
    slices = _equal_size_decile_indices(123, 10)
    sizes = [end - start for start, end in slices]
    assert sum(sizes) == 123
    assert max(sizes) - min(sizes) <= 1  # at most 1-row difference


def test_decile_slices_empty():
    assert _equal_size_decile_indices(0, 10) == []
    assert _equal_size_decile_indices(50, 0) == []


# --- score_head_calibration --------------------------------------------------

def test_perfectly_calibrated_passes():
    """When the predicted prob in decile k matches the actual win rate
    in decile k, the calibration score is ~0 and the head passes.

    Uses N=5000 → 500 rows per decile. With p≈0.5, binomial std is
    sqrt(0.25/500) ≈ 0.022, well below the 0.05 tolerance, so the
    test is robust against rng seed noise.
    """
    rng = np.random.default_rng(seed=42)
    n = 5000
    probs = rng.uniform(0, 1, n)
    outcomes = (rng.uniform(0, 1, n) < probs).astype(np.int8)

    df = _make_df("direction_30s", "scalp", probs.tolist(), outcomes.tolist())
    report = score_head_calibration(df, "direction_30s", "scalp")
    assert report.skipped_reason is None
    assert len(report.buckets) == 10
    assert report.passed, (
        f"perfectly-calibrated head should PASS, got "
        f"score={report.calibration_score:.4f} > tol={report.tolerance}"
    )
    sizes = [b.n_rows for b in report.buckets]
    assert min(sizes) >= 499 and max(sizes) <= 501


def test_miscalibrated_fails():
    """A head that always predicts 0.5 but where actuals are 90% positive
    should fail with score ~0.4.
    """
    n = 500
    probs = [0.5] * n
    outcomes = [1] * int(n * 0.9) + [0] * (n - int(n * 0.9))

    df = _make_df("direction_60s", "scalp", probs, outcomes)
    report = score_head_calibration(df, "direction_60s", "scalp")
    assert report.skipped_reason is None
    assert not report.passed
    # The decile with all the 1s should have ~|0.5 - 1.0| = 0.5 diff;
    # all-zero decile gives ~|0.5 - 0.0| = 0.5. Either way > 0.05.
    assert report.calibration_score > 0.05


def test_skipped_when_too_few_outcomes():
    """Heads with fewer than n_deciles × min_rows_per_decile populated
    outcomes are skipped with a non-None reason.
    """
    probs = [0.1, 0.2, 0.3, 0.4, 0.5]   # only 5 rows total
    outcomes = [0, 0, 1, 1, 1]
    df = _make_df("direction_30s", "scalp", probs, outcomes)
    report = score_head_calibration(df, "direction_30s", "scalp")
    assert report.skipped_reason is not None
    assert "insufficient" in report.skipped_reason.lower()
    assert not report.passed
    assert np.isnan(report.calibration_score)
    assert report.buckets == []


def test_null_outcomes_excluded_from_score():
    """Rows with outcome_direction NULL are dropped before scoring —
    these are predictions whose lookahead window hasn't closed yet.
    """
    n = 200
    probs = list(np.linspace(0, 1, n))
    # Half of outcomes are NULL (not yet backfilled).
    outcomes = [1 if i % 2 == 0 else None for i in range(n)]
    df = _make_df("direction_30s", "scalp", probs, outcomes)
    report = score_head_calibration(df, "direction_30s", "scalp")
    assert report.n_rows_total == 200
    assert report.n_rows_with_outcome == 100
    # No assertion about pass/fail — just that NULLs were filtered.


# --- score_all_heads ----------------------------------------------------------

def test_score_all_heads_filters_non_binary():
    """A multi-head df with a regression head and a binary head should
    yield only one report (for the binary one).
    """
    rng = np.random.default_rng(seed=0)
    n = 200
    binary = pl.DataFrame({
        "head_name": ["direction_30s"] * n,
        "head_type": ["scalp"] * n,
        "calibrated_prob": rng.uniform(0, 1, n),
        "outcome_direction": rng.integers(-1, 2, n).astype(np.int8),
    })
    regression = pl.DataFrame({
        "head_name": ["max_upside_60s"] * n,
        "head_type": ["scalp"] * n,
        "calibrated_prob": rng.uniform(0, 100, n),  # not a prob
        "outcome_direction": rng.integers(-1, 2, n).astype(np.int8),
    })
    combined = pl.concat([binary, regression], how="vertical")
    reports = score_all_heads(combined)
    assert len(reports) == 1
    assert reports[0].head_name == "direction_30s"


def test_score_all_heads_empty_input():
    assert score_all_heads(pl.DataFrame()) == []


# --- markdown rendering -------------------------------------------------------

def test_markdown_summary_mentions_pass_fail_skipped():
    passed = HeadCalibrationReport(
        head_name="direction_30s", head_type="scalp",
        n_rows_total=200, n_rows_with_outcome=200,
        buckets=[DecileBucket(0, 20, 0.1, 0.1, 0.0)],
        calibration_score=0.01, passed=True, tolerance=0.05,
        skipped_reason=None,
    )
    failed = HeadCalibrationReport(
        head_name="direction_60s", head_type="scalp",
        n_rows_total=200, n_rows_with_outcome=200,
        buckets=[DecileBucket(0, 20, 0.5, 0.9, 0.4)],
        calibration_score=0.4, passed=False, tolerance=0.05,
        skipped_reason=None,
    )
    skipped = HeadCalibrationReport(
        head_name="breakout_in_60s", head_type="trend",
        n_rows_total=5, n_rows_with_outcome=5,
        buckets=[], calibration_score=float("nan"), passed=False,
        tolerance=0.05,
        skipped_reason="insufficient outcome rows (5 < 100)",
    )
    md = render_markdown_summary([passed, failed, skipped])
    assert "PASS" in md
    assert "FAIL" in md
    assert "SKIPPED" in md
    # Cohort table renders both non-skipped cohorts.
    assert "scalp" in md
    # FAIL drill-down section shows the failing head's decile table.
    assert "FAIL drill-down" in md
    assert "direction_60s" in md
    # Skipped head doesn't show a decile drill-down (no buckets).
    assert "breakout_in_60s" in md  # but only in the verdict table


def test_markdown_summary_empty():
    md = render_markdown_summary([])
    assert "No binary-classifier head data" in md


# --- regression: head_type None doesn't crash --------------------------------

def test_score_handles_null_head_type():
    """Until T33's wire-in fully populates head_type, it can be None for
    some/all rows. Scoring should still work.
    """
    rng = np.random.default_rng(seed=1)
    n = 200
    df = pl.DataFrame({
        "head_name": ["direction_30s"] * n,
        "head_type": [None] * n,
        "calibrated_prob": rng.uniform(0, 1, n),
        "outcome_direction": rng.integers(-1, 2, n).astype(np.int8),
    }, schema={
        "head_name": pl.Utf8,
        "head_type": pl.Utf8,
        "calibrated_prob": pl.Float64,
        "outcome_direction": pl.Int8,
    })
    reports = score_all_heads(df)
    assert len(reports) == 1
    assert reports[0].head_type is None
    # Should not raise, and markdown should still render with cohort '—'.
    md = render_markdown_summary(reports)
    assert "direction_30s" in md


# --- CLI integration ---------------------------------------------------------

def _write_synthetic_predictions_parquet(
    path: Path,
    *,
    instrument: str,
    head_name: str,
    head_type: str,
    n_rows: int,
    seed: int,
) -> None:
    """Write a T41-shaped parquet under ``path``.

    Generates a perfectly-calibrated head so the CLI smoke test ends up
    in PASS — easier to assert on a known-good outcome than chase
    binomial noise.
    """
    rng = np.random.default_rng(seed=seed)
    probs = rng.uniform(0, 1, n_rows)
    outcomes = (rng.uniform(0, 1, n_rows) < probs).astype(np.int8)

    table = pa.table({
        "prediction_id": pa.array(range(n_rows), type=pa.uint64()),
        "ts_ns": pa.array([0] * n_rows, type=pa.int64()),
        "instrument": pa.array([instrument] * n_rows, type=pa.string()),
        "head_name": pa.array([head_name] * n_rows, type=pa.string()),
        "head_type": pa.array([head_type] * n_rows, type=pa.string()),
        "raw_prob": pa.array(probs, type=pa.float64()),
        "calibrated_prob": pa.array(probs, type=pa.float64()),
        "gate_decision": pa.array(["WAIT"] * n_rows, type=pa.string()),
        "regime_tag": pa.array(["NEUTRAL"] * n_rows, type=pa.string()),
        "feature_snapshot_hash": pa.array(["0" * 16] * n_rows, type=pa.string()),
        "lookahead_seconds": pa.array([30] * n_rows, type=pa.int32()),
        "outcome_direction": pa.array(outcomes.tolist(), type=pa.int8()),
        "outcome_magnitude": pa.array([0.0] * n_rows, type=pa.float64()),
        "outcome_max_excursion": pa.array([0.0] * n_rows, type=pa.float64()),
        "outcome_max_drawdown": pa.array([0.0] * n_rows, type=pa.float64()),
        "outcome_filled_ts_ns": pa.array([1] * n_rows, type=pa.int64()),
    })
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path)


def test_cli_end_to_end(tmp_path):
    """Full CLI invocation against synthetic data:

    Sets up data/predictions/<DATE>/<inst>_predictions.parquet for two
    consecutive dates, runs the script with --end-date matching the
    second date, and verifies the markdown + csv outputs exist and
    contain the expected head.
    """
    repo = Path(__file__).resolve().parents[3]
    predictions_root = tmp_path / "predictions"
    output_dir = tmp_path / "reports"

    # Two days × 5000 rows = ample data for the 10-decile / 10-row min.
    for date_str, seed in [("2026-05-29", 7), ("2026-05-30", 11)]:
        day_dir = predictions_root / date_str
        _write_synthetic_predictions_parquet(
            day_dir / "nifty50_predictions.parquet",
            instrument="nifty50",
            head_name="direction_30s",
            head_type="scalp",
            n_rows=5000,
            seed=seed,
        )

    cli_script = repo / "scripts" / "trade_quality_report_weekly.py"
    assert cli_script.exists(), f"CLI script missing at {cli_script}"

    result = subprocess.run(
        [
            sys.executable, str(cli_script),
            "--days", "2",
            "--end-date", "2026-05-30",
            "--predictions-root", str(predictions_root),
            "--output-dir", str(output_dir),
        ],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, (
        f"CLI exited {result.returncode}; stderr:\n{result.stderr}"
    )

    md_path = output_dir / "reliability_weekly_2026-05-30.md"
    csv_path = output_dir / "reliability_weekly_2026-05-30.csv"
    assert md_path.exists(), f"markdown not written: {md_path}"
    assert csv_path.exists(), f"csv not written: {csv_path}"

    md_text = md_path.read_text(encoding="utf-8")
    assert "direction_30s" in md_text
    assert "PASS" in md_text

    csv_df = pl.read_csv(csv_path)
    assert "head_name" in csv_df.columns
    assert "calibration_score" in csv_df.columns
    assert (csv_df["head_name"] == "direction_30s").any()


def test_cli_no_data_returns_nonzero(tmp_path):
    """Empty predictions root should make the CLI exit non-zero so a
    scheduled-task wrapper can alert on missing data.
    """
    repo = Path(__file__).resolve().parents[3]
    cli_script = repo / "scripts" / "trade_quality_report_weekly.py"

    result = subprocess.run(
        [
            sys.executable, str(cli_script),
            "--days", "7",
            "--end-date", "2026-05-30",
            "--predictions-root", str(tmp_path / "nonexistent"),
            "--output-dir", str(tmp_path / "reports"),
        ],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "no prediction data" in result.stderr.lower()
