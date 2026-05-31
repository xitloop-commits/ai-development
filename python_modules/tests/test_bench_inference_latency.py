"""
Tests for ``scripts/bench_inference_latency.py``.

Uses the same synthetic LightGBM model fixture as
``test_feature_importance.py`` — train a small binary classifier,
persist as a one-head bundle, then exercise ``bench_instrument`` and
the CLI end-to-end.

We can't assert on absolute latency numbers (CI machines vary
wildly), so we assert on shape: per-head dicts have the right fields,
percentiles satisfy p50 ≤ p95 ≤ p99 ≤ max, and the total-per-eval
math matches the sum of per-head means.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pytest

# Reuse the bundle-building helper from the feature-importance test
# rather than duplicating it. It lives in the same tests/ tree once
# pytest collection runs, so importing by module path works.
_HERE = Path(__file__).resolve().parent
_PY_MODULES = _HERE.parent
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

_REPO = _PY_MODULES.parent
_SCRIPTS = _REPO / "scripts"


def _load_bench_module():
    """Import the CLI script as a module so its public functions can
    be unit-tested directly. The script lives outside python_modules/
    so a normal `import` won't find it.

    Registers the module in sys.modules BEFORE exec_module — without
    that, dataclasses introspection (which does
    ``sys.modules.get(cls.__module__).__dict__``) crashes on Python
    3.14 when resolving field annotations.
    """
    if "bench_inference_latency" in sys.modules:
        return sys.modules["bench_inference_latency"]
    spec = importlib.util.spec_from_file_location(
        "bench_inference_latency",
        _SCRIPTS / "bench_inference_latency.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["bench_inference_latency"] = module
    spec.loader.exec_module(module)
    return module


def _train_tiny_binary(seed: int = 1) -> lgb.Booster:
    rng = np.random.default_rng(seed=seed)
    n_rows = 800
    feature_names = [f"feat_{i}" for i in range(12)]
    X = rng.normal(size=(n_rows, len(feature_names)))
    logits = 1.5 * X[:, 0] + 1.0 * X[:, 1] - 0.5
    y = (rng.uniform(size=n_rows) < 1 / (1 + np.exp(-logits))).astype(np.int32)
    train = lgb.Dataset(X, label=y, feature_name=feature_names)
    return lgb.train(
        {"objective": "binary", "verbose": -1, "num_leaves": 7,
         "learning_rate": 0.1, "min_data_in_leaf": 20},
        train, num_boost_round=20,
    )


def _make_instrument_bundle(
    instrument_dir: Path,
    instrument: str,
    head_models: dict[str, lgb.Booster],
) -> None:
    timestamp = "20260530_120000"
    dated = instrument_dir / timestamp
    dated.mkdir(parents=True, exist_ok=True)
    head_meta = {}
    for head_name, booster in head_models.items():
        booster.save_model(str(dated / f"{head_name}.lgbm"))
        head_meta[head_name] = {
            "head_type": "scalp",
            "objective": "binary",
            "lookahead_seconds": 30,
            "lgbm_path": f"{head_name}.lgbm",
            "calibration_path": None,
            "schema_version": 8,
        }
    (instrument_dir / "LATEST_HEADS.json").write_text(json.dumps({
        "version": 1, "instrument": instrument,
        "timestamp": timestamp, "schema_version": 8,
        "head_count": len(head_models), "heads": head_meta,
    }), encoding="utf-8")
    # MTA-style LATEST text-file pointer (no admin needed on Windows).
    (instrument_dir / "LATEST").write_text(timestamp, encoding="utf-8")


# --- _percentile -----------------------------------------------------------

def test_percentile_matches_numpy():
    bench = _load_bench_module()
    values = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
    assert bench._percentile(values, 50) == pytest.approx(5.5)
    assert bench._percentile(values, 95) == pytest.approx(
        float(np.percentile(values, 95))
    )


def test_percentile_empty_returns_nan():
    bench = _load_bench_module()
    assert np.isnan(bench._percentile([], 50))


# --- bench_instrument ------------------------------------------------------

def test_bench_instrument_shape(tmp_path):
    bench = _load_bench_module()
    m1 = _train_tiny_binary(seed=1)
    m2 = _train_tiny_binary(seed=2)
    instrument_dir = tmp_path / "nifty50"
    _make_instrument_bundle(instrument_dir, "nifty50", {
        "direction_30s": m1,
        "direction_60s": m2,
    })

    result = bench.bench_instrument(
        instrument="nifty50",
        instrument_dir=instrument_dir,
        n_evals=50,
        warmup=5,
        feature_seed=42,
    )
    assert result.instrument == "nifty50"
    assert result.n_heads == 2
    assert result.n_evals == 50
    assert len(result.heads) == 2

    # Percentile ordering invariant per head.
    for h in result.heads:
        assert h.n_evals == 50
        assert h.mean_ms > 0
        assert h.p50_ms <= h.p95_ms <= h.p99_ms <= h.max_ms
        assert h.n_features == 12

    # Totals should be self-consistent.
    assert result.total_per_eval_mean_ms == pytest.approx(
        sum(h.mean_ms for h in result.heads), rel=1e-6,
    )
    assert (
        result.total_per_eval_p50_ms
        <= result.total_per_eval_p95_ms
        <= result.total_per_eval_p99_ms
        <= result.total_per_eval_max_ms
    )


def test_bench_instrument_head_filter(tmp_path):
    bench = _load_bench_module()
    m = _train_tiny_binary()
    instrument_dir = tmp_path / "banknifty"
    _make_instrument_bundle(instrument_dir, "banknifty", {
        "direction_30s": m,
        "direction_60s": m,
        "direction_300s": m,
    })
    result = bench.bench_instrument(
        instrument="banknifty",
        instrument_dir=instrument_dir,
        n_evals=20, warmup=2,
        head_filter={"direction_30s", "direction_300s"},
    )
    assert {h.head_name for h in result.heads} == {
        "direction_30s", "direction_300s",
    }


def test_bench_instrument_missing_model_skipped(tmp_path):
    """A head whose .lgbm file is absent should be silently skipped,
    NOT crash the benchmark for the whole instrument.
    """
    bench = _load_bench_module()
    m = _train_tiny_binary()
    instrument_dir = tmp_path / "nifty50"
    _make_instrument_bundle(instrument_dir, "nifty50", {
        "direction_30s": m,
    })
    # Add a manifest entry pointing at a non-existent file.
    manifest_path = instrument_dir / "LATEST_HEADS.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["heads"]["ghost_head"] = {
        "head_type": "scalp",
        "objective": "binary",
        "lookahead_seconds": 30,
        "lgbm_path": "missing.lgbm",
        "calibration_path": None,
        "schema_version": 8,
    }
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = bench.bench_instrument(
        instrument="nifty50",
        instrument_dir=instrument_dir,
        n_evals=10, warmup=2,
    )
    assert result.n_heads == 1
    assert {h.head_name for h in result.heads} == {"direction_30s"}


# --- render_markdown -------------------------------------------------------

def test_render_markdown_contains_expected_sections(tmp_path):
    bench = _load_bench_module()
    m = _train_tiny_binary()
    instrument_dir = tmp_path / "nifty50"
    _make_instrument_bundle(instrument_dir, "nifty50", {
        "direction_30s": m,
        "direction_60s": m,
    })
    result = bench.bench_instrument(
        instrument="nifty50", instrument_dir=instrument_dir,
        n_evals=20, warmup=2,
    )
    md = bench.render_markdown([result])
    assert "T35 Inference latency benchmark" in md
    assert "Per-instrument total eval latency" in md
    assert "nifty50" in md
    assert "direction_30s" in md
    assert "p95 (ms)" in md


def test_render_markdown_empty():
    bench = _load_bench_module()
    md = bench.render_markdown([])
    assert "No instruments" in md


# --- CLI integration -------------------------------------------------------

def test_cli_end_to_end(tmp_path):
    bench = _load_bench_module()
    m1 = _train_tiny_binary(seed=1)
    m2 = _train_tiny_binary(seed=2)
    models_root = tmp_path / "models"
    _make_instrument_bundle(models_root / "nifty50", "nifty50", {
        "direction_30s": m1, "direction_60s": m2,
    })
    output_json = tmp_path / "out" / "latency.json"

    result = subprocess.run(
        [
            sys.executable, str(_SCRIPTS / "bench_inference_latency.py"),
            "--models-root", str(models_root),
            "--n-evals", "30",
            "--warmup", "3",
            "--output-json", str(output_json),
        ],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, (
        f"CLI exited {result.returncode}; stderr:\n{result.stderr}"
    )
    # Markdown went to stdout.
    assert "nifty50" in result.stdout
    assert "direction_30s" in result.stdout
    # JSON file written.
    assert output_json.exists()
    payload = json.loads(output_json.read_text(encoding="utf-8"))
    assert payload["n_evals"] == 30
    assert len(payload["results"]) == 1
    inst = payload["results"][0]
    assert inst["instrument"] == "nifty50"
    assert inst["n_heads"] == 2


def test_cli_no_instruments_returns_nonzero(tmp_path):
    result = subprocess.run(
        [
            sys.executable, str(_SCRIPTS / "bench_inference_latency.py"),
            "--models-root", str(tmp_path / "empty"),
            "--n-evals", "10", "--warmup", "1",
        ],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "no instruments" in result.stderr.lower()
