"""
Tests for the T28 hyperparameter override read path.

Pins the contract:
  - empty / missing / malformed config → hardcoded base verbatim
    (zero behaviour change from pre-T28)
  - per-head override merges on top of the base (only specified keys
    change; the rest fall through to the base)
  - binary vs regression objectives pick the matching base
  - parsed dict is what flows into ``_fit_one`` so joblib workers
    don't each re-read the file
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PY_MODULES = _HERE.parents[1]
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from model_training_agent.trainer import (  # noqa: E402
    LGBM_PARAMS_BINARY,
    LGBM_PARAMS_REGRESSION,
    _load_hyperparams_overrides,
    _resolve_lgbm_params,
)


# ── _load_hyperparams_overrides ──────────────────────────────────────────────


def test_load_missing_file_returns_empty_dict(tmp_path: Path) -> None:
    assert _load_hyperparams_overrides(tmp_path / "does_not_exist.json") == {}


def test_load_malformed_json_returns_empty_dict(tmp_path: Path) -> None:
    p = tmp_path / "broken.json"
    p.write_text("{ this is not valid json", encoding="utf-8")
    assert _load_hyperparams_overrides(p) == {}


def test_load_empty_heads_block_returns_empty_dict(tmp_path: Path) -> None:
    p = tmp_path / "empty.json"
    p.write_text(json.dumps({"_schema_version": 1, "heads": {}}), encoding="utf-8")
    assert _load_hyperparams_overrides(p) == {}


def test_load_missing_heads_block_returns_empty_dict(tmp_path: Path) -> None:
    """A config that's syntactically valid JSON but missing ``heads``
    must NOT crash — operator may comment out a section while editing."""
    p = tmp_path / "no_heads.json"
    p.write_text(json.dumps({"_schema_version": 1}), encoding="utf-8")
    assert _load_hyperparams_overrides(p) == {}


def test_load_heads_block_wrong_type_returns_empty_dict(tmp_path: Path) -> None:
    """A ``heads`` block that's e.g. a list (operator typo) must
    degrade gracefully, not raise."""
    p = tmp_path / "bad_type.json"
    p.write_text(
        json.dumps({"_schema_version": 1, "heads": ["nope"]}),
        encoding="utf-8",
    )
    assert _load_hyperparams_overrides(p) == {}


def test_load_returns_per_head_dicts(tmp_path: Path) -> None:
    p = tmp_path / "hyperparams.json"
    p.write_text(json.dumps({
        "_schema_version": 1,
        "heads": {
            "direction_30s": {"learning_rate": 0.03, "num_leaves": 31},
            "max_upside_60s": {"num_leaves": 127},
        },
    }), encoding="utf-8")
    out = _load_hyperparams_overrides(p)
    assert out == {
        "direction_30s": {"learning_rate": 0.03, "num_leaves": 31},
        "max_upside_60s": {"num_leaves": 127},
    }


def test_load_skips_non_dict_per_head_entries(tmp_path: Path) -> None:
    """If a head's override is a string / list / number (typo), drop it
    silently rather than crash the whole load."""
    p = tmp_path / "mixed.json"
    p.write_text(json.dumps({
        "_schema_version": 1,
        "heads": {
            "direction_30s": {"learning_rate": 0.03},
            "broken_head": "this should have been a dict",
            "also_broken": 42,
        },
    }), encoding="utf-8")
    out = _load_hyperparams_overrides(p)
    assert out == {"direction_30s": {"learning_rate": 0.03}}


# ── _resolve_lgbm_params ─────────────────────────────────────────────────────


def test_resolve_no_overrides_returns_binary_base_verbatim() -> None:
    params = _resolve_lgbm_params("direction_30s", "binary", None)
    assert params == LGBM_PARAMS_BINARY
    # Defensive copy: must not be the same object (caller will mutate
    # later by adding n_jobs).
    assert params is not LGBM_PARAMS_BINARY


def test_resolve_no_overrides_returns_regression_base_verbatim() -> None:
    params = _resolve_lgbm_params("max_upside_60s", "regression", None)
    assert params == LGBM_PARAMS_REGRESSION
    assert params is not LGBM_PARAMS_REGRESSION


def test_resolve_empty_overrides_returns_base() -> None:
    params = _resolve_lgbm_params("direction_30s", "binary", {})
    assert params == LGBM_PARAMS_BINARY


def test_resolve_head_absent_returns_base() -> None:
    """Override dict has entries, but not for the current head — fall
    through to the base verbatim."""
    overrides = {"some_other_head": {"learning_rate": 0.01}}
    params = _resolve_lgbm_params("direction_30s", "binary", overrides)
    assert params == LGBM_PARAMS_BINARY


def test_resolve_override_merges_on_top_of_base() -> None:
    """Per-head override merges: specified keys win, all others inherit
    from the base dict."""
    overrides = {"direction_30s": {"learning_rate": 0.03, "num_leaves": 31}}
    params = _resolve_lgbm_params("direction_30s", "binary", overrides)
    # Overridden keys take the per-head values.
    assert params["learning_rate"] == 0.03
    assert params["num_leaves"] == 31
    # Non-overridden keys stay at the binary base.
    assert params["objective"] == "binary"
    assert params["metric"] == "auc"
    assert params["bagging_fraction"] == LGBM_PARAMS_BINARY["bagging_fraction"]
    assert params["n_estimators"] == LGBM_PARAMS_BINARY["n_estimators"]


def test_resolve_override_can_add_new_lightgbm_keys() -> None:
    """Optuna may surface params the base doesn't list (e.g.
    min_data_in_leaf). Resolver must accept those rather than filter
    to the base's key set."""
    overrides = {
        "direction_30s": {
            "min_data_in_leaf": 20,
            "lambda_l2": 0.1,
        },
    }
    params = _resolve_lgbm_params("direction_30s", "binary", overrides)
    assert params["min_data_in_leaf"] == 20
    assert params["lambda_l2"] == 0.1
    # Base keys still present.
    assert params["objective"] == "binary"


def test_resolve_per_head_does_not_leak_to_other_heads() -> None:
    """A successful override on one head must NOT change another head's
    resolved params — isolation per call.
    """
    overrides = {"direction_30s": {"learning_rate": 0.99}}
    a = _resolve_lgbm_params("direction_30s", "binary", overrides)
    b = _resolve_lgbm_params("direction_60s", "binary", overrides)
    assert a["learning_rate"] == 0.99
    assert b["learning_rate"] == LGBM_PARAMS_BINARY["learning_rate"]
