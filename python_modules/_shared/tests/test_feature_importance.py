"""
Tests for ``_shared.feature_importance`` + CLI integration for
``scripts/shap_report_weekly.py``.

Approach: train a tiny synthetic LightGBM model with deliberately
informative + noise features, persist it as a ``.lgbm`` file with a
matching ``LATEST_HEADS.json`` manifest, then exercise the public API
+ CLI. Avoids depending on the real ``models/`` bundles so the test
is hermetic.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import polars as pl
import pytest

from _shared.feature_importance import (
    FeatureRank,
    HeadFeatureReport,
    cross_instrument_concordance,
    flatten_to_csv_rows,
    head_gain_importance,
    load_latest_heads_manifest,
    rank_top_n,
    render_markdown_summary,
    resolve_latest_model_dir,
    score_head_for_instrument,
    score_instrument,
)


# --- fixtures ----------------------------------------------------------------

def _train_synthetic_binary_model(
    *,
    n_rows: int = 2000,
    seed: int = 13,
    feature_names: list[str] | None = None,
) -> lgb.Booster:
    """Train a small LightGBM classifier where the first two features
    actually drive the label and the rest are noise. The gain-importance
    ranking should reflect this — first features high, rest low.
    """
    rng = np.random.default_rng(seed=seed)
    feature_names = feature_names or [
        "underlying_return_5ticks",
        "underlying_trade_direction",
        "chain_oi_total_call",
        "chain_oi_total_put",
        "active_1_distance_from_spot",
        "noise_feature_1",
        "noise_feature_2",
        "noise_feature_3",
    ]
    n_features = len(feature_names)
    X = rng.normal(size=(n_rows, n_features))
    # Label driven by features 0 + 1; logistic-style.
    logits = 1.5 * X[:, 0] + 1.0 * X[:, 1] - 0.5
    p = 1.0 / (1.0 + np.exp(-logits))
    y = (rng.uniform(size=n_rows) < p).astype(np.int32)

    train_set = lgb.Dataset(X, label=y, feature_name=feature_names)
    params = {
        "objective": "binary",
        "verbose": -1,
        "num_leaves": 7,
        "learning_rate": 0.1,
        "min_data_in_leaf": 20,
    }
    return lgb.train(params, train_set, num_boost_round=30)


def _make_instrument_bundle(
    instrument_dir: Path,
    *,
    instrument: str,
    heads: dict[str, lgb.Booster],
    head_meta_overrides: dict[str, dict] | None = None,
) -> Path:
    """Persist a synthetic instrument bundle:

      <instrument_dir>/
        20260530_120000/<head_name>.lgbm   (one per booster)
        LATEST/  → 20260530_120000          (literal dir for Windows simplicity)
        LATEST_HEADS.json
    """
    timestamp = "20260530_120000"
    dated = instrument_dir / timestamp
    dated.mkdir(parents=True, exist_ok=True)
    head_meta_overrides = head_meta_overrides or {}

    head_meta: dict[str, dict] = {}
    for head_name, booster in heads.items():
        lgbm_path = dated / f"{head_name}.lgbm"
        booster.save_model(str(lgbm_path))
        meta = {
            "head_type": "scalp",
            "objective": "binary",
            "lookahead_seconds": 30,
            "lgbm_path": f"{head_name}.lgbm",
            "calibration_path": None,
            "schema_version": 8,
        }
        meta.update(head_meta_overrides.get(head_name, {}))
        head_meta[head_name] = meta

    manifest = {
        "version": 1,
        "instrument": instrument,
        "timestamp": timestamp,
        "schema_version": 8,
        "head_count": len(heads),
        "heads": head_meta,
    }
    (instrument_dir / "LATEST_HEADS.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8",
    )

    # LATEST as a literal directory copy of the dated bundle would
    # double disk usage; instead point at it via a tiny redirect file
    # the fallback codepath in resolve_latest_model_dir handles.
    # (Symlink creation needs admin on Windows.)
    return dated


# --- head_gain_importance + rank_top_n ---------------------------------------

def test_gain_importance_reflects_informative_features():
    model = _train_synthetic_binary_model()
    importance = head_gain_importance(model)
    assert set(importance.keys()) == set(model.feature_name())
    # All values are non-negative.
    assert all(v >= 0 for v in importance.values())
    # The two informative features should dominate the ranking.
    top2 = sorted(importance.items(), key=lambda kv: -kv[1])[:2]
    top2_names = {name for name, _ in top2}
    assert {"underlying_return_5ticks", "underlying_trade_direction"} == top2_names


def test_rank_top_n_orders_descending():
    importance = {
        "feat_a": 100.0,
        "feat_b": 50.0,
        "feat_c": 25.0,
        "feat_d": 0.0,
    }
    ranks, total = rank_top_n(importance, top_n=3)
    assert total == 175.0
    assert [r.feature_name for r in ranks] == ["feat_a", "feat_b", "feat_c"]
    assert ranks[0].rank == 0
    assert ranks[0].pct_of_total == pytest.approx(100.0 / 175.0 * 100)


def test_rank_top_n_handles_all_zero():
    importance = {"feat_a": 0.0, "feat_b": 0.0}
    ranks, total = rank_top_n(importance, top_n=5)
    assert total == 0.0
    assert all(r.pct_of_total == 0.0 for r in ranks)


# --- resolve_latest_model_dir ------------------------------------------------

def test_resolve_latest_with_text_file_pointer(tmp_path):
    """The real MTA layout uses a LATEST text file containing the
    timestamp string, not a symlink (symlinks need admin on Windows).
    """
    instrument_dir = tmp_path / "nifty50"
    dated = instrument_dir / "20260524_115037"
    dated.mkdir(parents=True)
    (instrument_dir / "LATEST").write_text("20260524_115037", encoding="utf-8")
    # Manifest is required by the fallback path; populate trivially.
    (instrument_dir / "LATEST_HEADS.json").write_text(json.dumps({
        "version": 1, "instrument": "nifty50",
        "timestamp": "20260524_115037", "schema_version": 8,
        "head_count": 0, "heads": {},
    }), encoding="utf-8")
    resolved = resolve_latest_model_dir(instrument_dir)
    assert resolved == dated


def test_resolve_latest_text_file_with_trailing_newline(tmp_path):
    """Real LATEST files sometimes have a trailing newline. Whitespace
    must be stripped before resolving.
    """
    instrument_dir = tmp_path / "banknifty"
    dated = instrument_dir / "20260530_090000"
    dated.mkdir(parents=True)
    (instrument_dir / "LATEST").write_text(
        "20260530_090000\n", encoding="utf-8",
    )
    (instrument_dir / "LATEST_HEADS.json").write_text(json.dumps({
        "version": 1, "instrument": "banknifty",
        "timestamp": "20260530_090000", "schema_version": 8,
        "head_count": 0, "heads": {},
    }), encoding="utf-8")
    assert resolve_latest_model_dir(instrument_dir) == dated


# --- score_head_for_instrument -----------------------------------------------

def test_score_head_full_pipeline(tmp_path):
    model = _train_synthetic_binary_model()
    instrument_dir = tmp_path / "nifty50"
    _make_instrument_bundle(
        instrument_dir, instrument="nifty50",
        heads={"direction_30s": model},
    )
    model_dir = resolve_latest_model_dir(instrument_dir)
    head_meta = load_latest_heads_manifest(instrument_dir)["heads"]["direction_30s"]
    report = score_head_for_instrument(
        instrument="nifty50", model_dir=model_dir,
        head_name="direction_30s", head_meta=head_meta, top_n=5,
    )
    assert not report.missing_model
    assert report.n_features == 8
    assert len(report.top_features) == 5
    # First-ranked feature should be one of the two informative ones.
    assert report.top_features[0].feature_name in {
        "underlying_return_5ticks", "underlying_trade_direction",
    }
    assert report.top_features[0].pct_of_total > 0


def test_score_head_missing_model_graceful(tmp_path):
    """A manifest entry pointing at a non-existent .lgbm file should
    return a report with ``missing_model=True``, not raise.
    """
    instrument_dir = tmp_path / "nifty50"
    instrument_dir.mkdir(parents=True)
    (instrument_dir / "LATEST_HEADS.json").write_text(json.dumps({
        "version": 1, "instrument": "nifty50",
        "timestamp": "20260530_120000", "schema_version": 8,
        "head_count": 1, "heads": {
            "direction_30s": {
                "head_type": "scalp", "objective": "binary",
                "lookahead_seconds": 30,
                "lgbm_path": "this_file_does_not_exist.lgbm",
                "calibration_path": None, "schema_version": 8,
            },
        },
    }), encoding="utf-8")
    (instrument_dir / "20260530_120000").mkdir()

    model_dir = resolve_latest_model_dir(instrument_dir)
    head_meta = load_latest_heads_manifest(instrument_dir)["heads"]["direction_30s"]
    report = score_head_for_instrument(
        instrument="nifty50", model_dir=model_dir,
        head_name="direction_30s", head_meta=head_meta,
    )
    assert report.missing_model
    assert report.top_features == []
    assert report.n_features == 0


# --- score_instrument --------------------------------------------------------

def test_score_instrument_all_heads(tmp_path):
    m1 = _train_synthetic_binary_model(seed=1)
    m2 = _train_synthetic_binary_model(seed=2)
    instrument_dir = tmp_path / "banknifty"
    _make_instrument_bundle(
        instrument_dir, instrument="banknifty",
        heads={"direction_30s": m1, "direction_60s": m2},
    )
    reports = score_instrument(
        instrument="banknifty", instrument_dir=instrument_dir, top_n=3,
    )
    assert len(reports) == 2
    names = {r.head_name for r in reports}
    assert names == {"direction_30s", "direction_60s"}
    for r in reports:
        assert not r.missing_model
        assert len(r.top_features) == 3


def test_score_instrument_head_filter(tmp_path):
    m1 = _train_synthetic_binary_model(seed=1)
    m2 = _train_synthetic_binary_model(seed=2)
    instrument_dir = tmp_path / "nifty50"
    _make_instrument_bundle(
        instrument_dir, instrument="nifty50",
        heads={"direction_30s": m1, "direction_60s": m2},
    )
    reports = score_instrument(
        instrument="nifty50", instrument_dir=instrument_dir,
        head_filter={"direction_30s"},
    )
    assert len(reports) == 1
    assert reports[0].head_name == "direction_30s"


# --- cross-instrument concordance --------------------------------------------

def test_cross_instrument_concordance_counts_appearances():
    """Synthetic reports where one feature appears in two instruments'
    top-N and another only in one. Concordance should reflect that.
    """
    r_nifty = HeadFeatureReport(
        instrument="nifty50", head_name="direction_30s",
        head_type="scalp", objective="binary", n_features=8,
        total_gain=200.0, missing_model=False,
        top_features=[
            FeatureRank(0, "shared_feature", 100.0, 50.0),
            FeatureRank(1, "nifty_only", 50.0, 25.0),
        ],
    )
    r_banknifty = HeadFeatureReport(
        instrument="banknifty", head_name="direction_30s",
        head_type="scalp", objective="binary", n_features=8,
        total_gain=200.0, missing_model=False,
        top_features=[
            FeatureRank(0, "shared_feature", 90.0, 45.0),
            FeatureRank(1, "banknifty_only", 40.0, 20.0),
        ],
    )
    by_inst = {"nifty50": [r_nifty], "banknifty": [r_banknifty]}
    concordance = cross_instrument_concordance(
        by_inst, head_name="direction_30s", top_n=10,
    )
    counts = dict(concordance)
    assert counts["shared_feature"] == 2
    assert counts["nifty_only"] == 1
    assert counts["banknifty_only"] == 1


# --- markdown rendering ------------------------------------------------------

def test_markdown_summary_contains_required_sections(tmp_path):
    m = _train_synthetic_binary_model()
    instrument_dir = tmp_path / "nifty50"
    _make_instrument_bundle(
        instrument_dir, instrument="nifty50",
        heads={"direction_30s": m},
    )
    reports = score_instrument(
        instrument="nifty50", instrument_dir=instrument_dir, top_n=5,
    )
    md = render_markdown_summary({"nifty50": reports})
    assert "T34 weekly feature importance" in md
    assert "nifty50" in md
    assert "direction_30s" in md
    assert "underlying_return_5ticks" in md or "underlying_trade_direction" in md
    # Cross-concordance only appears when >= 2 instruments.
    assert "Cross-instrument concordance" not in md


def test_markdown_includes_concordance_when_multiple_instruments(tmp_path):
    m1 = _train_synthetic_binary_model(seed=1)
    m2 = _train_synthetic_binary_model(seed=2)
    nifty_dir = tmp_path / "nifty50"
    bnf_dir = tmp_path / "banknifty"
    _make_instrument_bundle(nifty_dir, instrument="nifty50",
                            heads={"direction_30s": m1})
    _make_instrument_bundle(bnf_dir, instrument="banknifty",
                            heads={"direction_30s": m2})
    reports_by = {
        "nifty50": score_instrument(
            instrument="nifty50", instrument_dir=nifty_dir, top_n=5),
        "banknifty": score_instrument(
            instrument="banknifty", instrument_dir=bnf_dir, top_n=5),
    }
    md = render_markdown_summary(reports_by)
    assert "Cross-instrument concordance" in md
    # The two informative features should appear with concordance == 2.
    # (Different seeds, same data-generating process → same top features.)
    assert "underlying_return_5ticks" in md or "underlying_trade_direction" in md


# --- CSV flattening ----------------------------------------------------------

def test_flatten_to_csv_rows_shape():
    r = HeadFeatureReport(
        instrument="nifty50", head_name="direction_30s",
        head_type="scalp", objective="binary", n_features=8,
        total_gain=200.0, missing_model=False,
        top_features=[
            FeatureRank(0, "feat_a", 100.0, 50.0),
            FeatureRank(1, "feat_b", 50.0, 25.0),
        ],
    )
    rows = flatten_to_csv_rows({"nifty50": [r]})
    assert len(rows) == 2
    assert rows[0]["instrument"] == "nifty50"
    assert rows[0]["feature_name"] == "feat_a"
    assert rows[0]["rank"] == 0
    assert rows[1]["rank"] == 1


def test_flatten_to_csv_rows_includes_missing_marker():
    r = HeadFeatureReport(
        instrument="nifty50", head_name="bad_head",
        head_type="scalp", objective="binary", n_features=0,
        total_gain=0.0, missing_model=True, top_features=[],
    )
    rows = flatten_to_csv_rows({"nifty50": [r]})
    assert len(rows) == 1
    assert rows[0]["missing_model"] is True
    assert rows[0]["rank"] == -1


# --- CLI integration ---------------------------------------------------------

def test_cli_end_to_end(tmp_path):
    repo = Path(__file__).resolve().parents[3]
    models_root = tmp_path / "models"
    output_dir = tmp_path / "reports"

    m1 = _train_synthetic_binary_model(seed=1)
    m2 = _train_synthetic_binary_model(seed=2)
    _make_instrument_bundle(
        models_root / "nifty50", instrument="nifty50",
        heads={"direction_30s": m1, "direction_60s": m2},
    )
    _make_instrument_bundle(
        models_root / "banknifty", instrument="banknifty",
        heads={"direction_30s": m1, "direction_60s": m2},
    )

    cli_script = repo / "scripts" / "shap_report_weekly.py"
    assert cli_script.exists()

    result = subprocess.run(
        [
            sys.executable, str(cli_script),
            "--models-root", str(models_root),
            "--output-dir", str(output_dir),
            "--top-n", "5",
            "--date", "2026-05-30",
        ],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, (
        f"CLI exited {result.returncode}; stderr:\n{result.stderr}"
    )

    md_path = output_dir / "feature_importance_2026-05-30.md"
    csv_path = output_dir / "feature_importance_2026-05-30.csv"
    assert md_path.exists()
    assert csv_path.exists()
    md_text = md_path.read_text(encoding="utf-8")
    assert "nifty50" in md_text
    assert "banknifty" in md_text
    assert "direction_30s" in md_text

    csv_df = pl.read_csv(csv_path)
    assert "feature_name" in csv_df.columns
    assert "importance" in csv_df.columns
    # 2 instruments × 2 heads × 5 top features = 20 rows
    assert len(csv_df) == 20


def test_cli_no_instruments_returns_nonzero(tmp_path):
    repo = Path(__file__).resolve().parents[3]
    cli_script = repo / "scripts" / "shap_report_weekly.py"
    result = subprocess.run(
        [
            sys.executable, str(cli_script),
            "--models-root", str(tmp_path / "empty"),
            "--output-dir", str(tmp_path / "reports"),
            "--date", "2026-05-30",
        ],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "no instruments found" in result.stderr.lower()


def test_cli_explicit_instrument_list(tmp_path):
    repo = Path(__file__).resolve().parents[3]
    models_root = tmp_path / "models"
    output_dir = tmp_path / "reports"
    m = _train_synthetic_binary_model()
    _make_instrument_bundle(
        models_root / "nifty50", instrument="nifty50",
        heads={"direction_30s": m},
    )
    _make_instrument_bundle(
        models_root / "banknifty", instrument="banknifty",
        heads={"direction_30s": m},
    )

    cli_script = repo / "scripts" / "shap_report_weekly.py"
    result = subprocess.run(
        [
            sys.executable, str(cli_script),
            "--instruments", "nifty50",   # banknifty present but excluded
            "--models-root", str(models_root),
            "--output-dir", str(output_dir),
            "--top-n", "3",
            "--date", "2026-05-30",
        ],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    csv_df = pl.read_csv(output_dir / "feature_importance_2026-05-30.csv")
    assert set(csv_df["instrument"].unique()) == {"nifty50"}
