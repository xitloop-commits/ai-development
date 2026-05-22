"""
tests/test_calibration.py — Unit tests for `model_training_agent.calibration`.

Covers the T25 isotonic-calibration module in isolation:

  - fit_isotonic_for_head: shape, validity checks, monotonicity guarantee.
  - CalibrationMap.apply: round-trip, clipping at endpoints, NaN propagation.
  - write/read_calibration_sidecar: JSON round-trip + version mismatch + path resolution.

Run:
  python -m pytest python_modules/model_training_agent/tests/test_calibration.py -v
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent  # python_modules/
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import numpy as np
import pytest

from model_training_agent.calibration import (
    SIDECAR_SUFFIX,
    SIDECAR_VERSION,
    CalibrationMap,
    calibration_sidecar_path,
    fit_isotonic_for_head,
    read_calibration_sidecar,
    write_calibration_sidecar,
)


# ── fit_isotonic_for_head ─────────────────────────────────────────────────


def test_fit_returns_calibration_map_with_monotone_y_knots() -> None:
    rng = np.random.default_rng(42)
    # Over-confident model: raw_probs concentrated near 0.7 but only ~0.5 win rate.
    raw_probs = np.clip(rng.normal(0.7, 0.1, 200), 0.01, 0.99)
    y_true = (rng.random(200) < 0.5).astype(int)

    cmap = fit_isotonic_for_head(raw_probs, y_true, "direction_60s")

    assert isinstance(cmap, CalibrationMap)
    assert cmap.head_name == "direction_60s"
    assert cmap.n_samples == 200
    # Isotonic constraint: y_knots non-decreasing
    assert np.all(np.diff(cmap.y_knots) >= -1e-12)
    # Output range bounded [0, 1]
    assert cmap.y_knots.min() >= -1e-9
    assert cmap.y_knots.max() <= 1 + 1e-9


def test_fit_skips_nan_rows() -> None:
    # 13 entries; 1 NaN per side at disjoint positions → 11 valid pairs.
    raw_probs = np.array([0.1, 0.5, np.nan, 0.7, 0.9, 0.2, 0.4, 0.6, 0.8, 0.3, 0.55, 0.42, 0.85])
    y_true = np.array([0.0, 1.0, 1.0, np.nan, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0])
    cmap = fit_isotonic_for_head(raw_probs, y_true, "direction_60s")
    assert cmap.n_samples == 11


def test_fit_raises_when_too_few_samples() -> None:
    raw_probs = np.array([0.1, 0.2, 0.3])
    y_true = np.array([0.0, 1.0, 0.0])
    with pytest.raises(ValueError, match="need >= 10"):
        fit_isotonic_for_head(raw_probs, y_true, "direction_60s")


def test_fit_raises_on_shape_mismatch() -> None:
    raw_probs = np.zeros(50)
    y_true = np.zeros(40)
    with pytest.raises(ValueError, match="shape mismatch"):
        fit_isotonic_for_head(raw_probs, y_true, "direction_60s")


# ── CalibrationMap.apply ──────────────────────────────────────────────────


def test_apply_round_trip_at_knot_points() -> None:
    rng = np.random.default_rng(7)
    raw_probs = np.clip(rng.uniform(0, 1, 100), 0.01, 0.99)
    y_true = (rng.random(100) < raw_probs).astype(int)
    cmap = fit_isotonic_for_head(raw_probs, y_true, "head_x")

    # At each x_knot, apply must produce the corresponding y_knot.
    out = cmap.apply(cmap.x_knots)
    np.testing.assert_allclose(out, cmap.y_knots, atol=1e-9)


def test_apply_clips_outside_range() -> None:
    x_knots = np.array([0.2, 0.4, 0.6, 0.8])
    y_knots = np.array([0.1, 0.3, 0.5, 0.9])
    cmap = CalibrationMap(
        head_name="h", x_knots=x_knots, y_knots=y_knots, n_samples=20,
    )
    # Below the first x_knot
    assert cmap.apply(0.0) == pytest.approx(0.1)
    # Above the last x_knot
    assert cmap.apply(1.0) == pytest.approx(0.9)


def test_apply_returns_nan_for_nan_input() -> None:
    x_knots = np.array([0.0, 0.5, 1.0])
    y_knots = np.array([0.0, 0.4, 1.0])
    cmap = CalibrationMap(head_name="h", x_knots=x_knots, y_knots=y_knots, n_samples=10)
    assert np.isnan(cmap.apply(float("nan")))


# ── write/read sidecar round-trip ─────────────────────────────────────────


def test_sidecar_round_trip(tmp_path: Path) -> None:
    cmap = CalibrationMap(
        head_name="direction_60s",
        x_knots=np.array([0.05, 0.3, 0.55, 0.78, 0.95]),
        y_knots=np.array([0.10, 0.35, 0.50, 0.72, 0.93]),
        n_samples=500,
    )
    sidecar = tmp_path / "direction_60s.calibration.json"
    write_calibration_sidecar(sidecar, cmap)

    loaded = read_calibration_sidecar(sidecar)
    assert loaded is not None
    assert loaded.head_name == "direction_60s"
    assert loaded.n_samples == 500
    np.testing.assert_allclose(loaded.x_knots, cmap.x_knots)
    np.testing.assert_allclose(loaded.y_knots, cmap.y_knots)


def test_read_sidecar_returns_none_when_missing(tmp_path: Path) -> None:
    assert read_calibration_sidecar(tmp_path / "nope.calibration.json") is None


def test_read_sidecar_raises_on_version_mismatch(tmp_path: Path) -> None:
    bad = tmp_path / "bad.calibration.json"
    bad.write_text(
        json.dumps({
            "version": SIDECAR_VERSION + 99,
            "head_name": "h",
            "x_knots": [0.0, 1.0],
            "y_knots": [0.0, 1.0],
            "n_samples": 50,
        }),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="unsupported sidecar version"):
        read_calibration_sidecar(bad)


def test_read_sidecar_raises_on_too_few_knots(tmp_path: Path) -> None:
    bad = tmp_path / "tiny.calibration.json"
    bad.write_text(
        json.dumps({
            "version": SIDECAR_VERSION,
            "head_name": "h",
            "x_knots": [0.5],
            "y_knots": [0.5],
            "n_samples": 10,
        }),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="need >= 2 knot points"):
        read_calibration_sidecar(bad)


def test_read_sidecar_raises_on_shape_mismatch(tmp_path: Path) -> None:
    bad = tmp_path / "mismatch.calibration.json"
    bad.write_text(
        json.dumps({
            "version": SIDECAR_VERSION,
            "head_name": "h",
            "x_knots": [0.0, 0.5, 1.0],
            "y_knots": [0.0, 1.0],
            "n_samples": 10,
        }),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="shape mismatch"):
        read_calibration_sidecar(bad)


# ── path helper ───────────────────────────────────────────────────────────


def test_sidecar_path_for_lgbm() -> None:
    model = Path("models/nifty50/v_2026_07_04/direction_60s.lgbm")
    sidecar = calibration_sidecar_path(model)
    assert sidecar == model.parent / f"direction_60s{SIDECAR_SUFFIX}"


def test_sidecar_path_for_non_lgbm_appends() -> None:
    other = Path("models/nifty50/v_2026/something.weird")
    sidecar = calibration_sidecar_path(other)
    assert sidecar == other.parent / f"something.weird{SIDECAR_SUFFIX}"
