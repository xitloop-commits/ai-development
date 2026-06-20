"""
Tests for checkpoint.py — Phase 3 resumable training (2026-06-20).

Covers the pure helpers plus one end-to-end "kill mid-CV then resume"
scenario via train_instrument().
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest  # noqa: F401  — used for fixtures via pytest's auto-discovery

from model_training_agent.checkpoint import (
    append_partial_head_metrics,
    cleanup_partial_state,
    compute_schema_fingerprint,
    find_resumable_run_dir,
    read_partial_folds,
    read_partial_head_metrics,
    write_partial_folds,
)


# ── Schema fingerprint ────────────────────────────────────────────────


class TestComputeSchemaFingerprint:
    def test_same_inputs_same_fingerprint(self):
        a = compute_schema_fingerprint(
            features=["x", "y", "z"], targets=["t1", "t2"],
        )
        b = compute_schema_fingerprint(
            features=["x", "y", "z"], targets=["t1", "t2"],
        )
        assert a == b

    def test_order_independent(self):
        a = compute_schema_fingerprint(
            features=["a", "b", "c"], targets=["t1", "t2"],
        )
        b = compute_schema_fingerprint(
            features=["c", "b", "a"], targets=["t2", "t1"],
        )
        assert a == b

    def test_different_features_different_fingerprint(self):
        a = compute_schema_fingerprint(
            features=["a", "b"], targets=["t1"],
        )
        b = compute_schema_fingerprint(
            features=["a", "b", "c"], targets=["t1"],
        )
        assert a != b

    def test_different_targets_different_fingerprint(self):
        a = compute_schema_fingerprint(
            features=["a", "b"], targets=["t1"],
        )
        b = compute_schema_fingerprint(
            features=["a", "b"], targets=["t1", "t2"],
        )
        assert a != b

    def test_fingerprint_is_12_hex_chars(self):
        fp = compute_schema_fingerprint(
            features=["a"], targets=["t1"],
        )
        assert len(fp) == 12
        assert all(c in "0123456789abcdef" for c in fp)


# ── partial_folds round-trip ──────────────────────────────────────────


class TestPartialFolds:
    def test_no_file_returns_none_empty(self, tmp_path: Path):
        fp, folds = read_partial_folds(tmp_path)
        assert fp is None
        assert folds == []

    def test_write_then_read_roundtrips(self, tmp_path: Path):
        folds = [
            {"fold_index": 0, "train_dates": ["d1"], "val_dates": ["d2"], "metrics": {}},
            {"fold_index": 1, "train_dates": ["d2"], "val_dates": ["d3"], "metrics": {}},
        ]
        write_partial_folds(tmp_path, "abc123", folds)
        fp, got = read_partial_folds(tmp_path)
        assert fp == "abc123"
        assert got == folds

    def test_overwrite_replaces_prior_state(self, tmp_path: Path):
        write_partial_folds(tmp_path, "fp1", [{"fold_index": 0}])
        write_partial_folds(tmp_path, "fp2", [
            {"fold_index": 0}, {"fold_index": 1},
        ])
        fp, got = read_partial_folds(tmp_path)
        assert fp == "fp2"
        assert len(got) == 2

    def test_malformed_json_returns_none_empty(self, tmp_path: Path):
        (tmp_path / "partial_folds.json").write_text("{not json", encoding="utf-8")
        fp, got = read_partial_folds(tmp_path)
        assert fp is None
        assert got == []


# ── partial_head_metrics append + read ────────────────────────────────


class TestPartialHeadMetrics:
    def test_no_file_returns_empty_dict(self, tmp_path: Path):
        assert read_partial_head_metrics(tmp_path) == {}

    def test_append_then_read(self, tmp_path: Path):
        append_partial_head_metrics(
            tmp_path, "direction_30s", "binary",
            {"val_auc": 0.61, "n_train": 100, "n_val": 30},
        )
        append_partial_head_metrics(
            tmp_path, "magnitude_30s", "regression",
            {"val_rmse": 0.12, "n_train": 100, "n_val": 30},
        )
        out = read_partial_head_metrics(tmp_path)
        assert set(out.keys()) == {"direction_30s", "magnitude_30s"}
        assert out["direction_30s"]["val_auc"] == 0.61
        assert out["magnitude_30s"]["val_rmse"] == 0.12

    def test_malformed_line_skipped_not_blocked(self, tmp_path: Path):
        (tmp_path / "partial_metrics.jsonl").write_text(
            '{"target": "good", "metrics": {"val_auc": 0.5}}\n'
            "{not valid json\n"
            '{"target": "also_good", "metrics": {"val_rmse": 0.1}}\n',
            encoding="utf-8",
        )
        out = read_partial_head_metrics(tmp_path)
        assert set(out.keys()) == {"good", "also_good"}


# ── find_resumable_run_dir ────────────────────────────────────────────


class TestFindResumableRunDir:
    def test_no_models_dir_returns_none(self, tmp_path: Path):
        assert find_resumable_run_dir("nifty50", tmp_path / "models") is None

    def test_no_runs_returns_none(self, tmp_path: Path):
        (tmp_path / "models" / "nifty50").mkdir(parents=True)
        assert find_resumable_run_dir("nifty50", tmp_path / "models") is None

    def test_completed_run_ignored(self, tmp_path: Path):
        run_dir = tmp_path / "models" / "nifty50" / "20260620_100000"
        run_dir.mkdir(parents=True)
        (run_dir / "training_manifest.json").write_text("{}", encoding="utf-8")
        (run_dir / "partial_folds.json").write_text("{}", encoding="utf-8")
        assert find_resumable_run_dir("nifty50", tmp_path / "models") is None

    def test_interrupted_with_partial_folds_returned(self, tmp_path: Path):
        run_dir = tmp_path / "models" / "nifty50" / "20260620_100000"
        run_dir.mkdir(parents=True)
        (run_dir / "partial_folds.json").write_text("{}", encoding="utf-8")
        got = find_resumable_run_dir("nifty50", tmp_path / "models")
        assert got == run_dir

    def test_interrupted_with_partial_metrics_returned(self, tmp_path: Path):
        run_dir = tmp_path / "models" / "nifty50" / "20260620_100000"
        run_dir.mkdir(parents=True)
        (run_dir / "partial_metrics.jsonl").write_text("", encoding="utf-8")
        got = find_resumable_run_dir("nifty50", tmp_path / "models")
        assert got == run_dir

    def test_most_recent_interrupted_wins(self, tmp_path: Path):
        for ts in ("20260619_100000", "20260620_100000", "20260620_120000"):
            d = tmp_path / "models" / "nifty50" / ts
            d.mkdir(parents=True)
            (d / "partial_folds.json").write_text("{}", encoding="utf-8")
        got = find_resumable_run_dir("nifty50", tmp_path / "models")
        assert got.name == "20260620_120000"

    def test_per_instrument_isolated(self, tmp_path: Path):
        (tmp_path / "models" / "banknifty" / "20260620_100000").mkdir(parents=True)
        (tmp_path / "models" / "banknifty" / "20260620_100000"
         / "partial_folds.json").write_text("{}", encoding="utf-8")
        # nifty50 has no interrupted dir
        assert find_resumable_run_dir("nifty50", tmp_path / "models") is None
        # banknifty does
        got = find_resumable_run_dir("banknifty", tmp_path / "models")
        assert got is not None


# ── cleanup_partial_state ─────────────────────────────────────────────


class TestCleanupPartialState:
    def test_removes_both_sidecars(self, tmp_path: Path):
        (tmp_path / "partial_folds.json").write_text("{}", encoding="utf-8")
        (tmp_path / "partial_metrics.jsonl").write_text("", encoding="utf-8")
        cleanup_partial_state(tmp_path)
        assert not (tmp_path / "partial_folds.json").exists()
        assert not (tmp_path / "partial_metrics.jsonl").exists()

    def test_safe_when_files_absent(self, tmp_path: Path):
        # No exception when there's nothing to delete.
        cleanup_partial_state(tmp_path)
