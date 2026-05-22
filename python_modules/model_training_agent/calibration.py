"""
calibration.py — Per-head isotonic calibration for binary model heads.

Per V2_MASTER_SPEC §2.3 D72 (locked 2026-05-17, scope narrowed by D75 Gap 4
on 2026-05-18 to BINARY heads only — regression heads emit point estimates
where calibration is meaningless).

WHY
---
Raw LightGBM `predict()` outputs are not honest probabilities. A model
that emits "0.70" may correspond to a real-world win rate of 0.55 or 0.82,
depending on class imbalance, `scale_pos_weight`, and feature noise. The
gate logic (T29 — `decide_action_*`) and future EV-floor (T8) both treat
predict() output as a probability, so without calibration their decisions
ride on lies.

HOW
---
1. Fit a monotone isotonic regression on (raw_prob, y_true) pairs from
   the held-out CALIBRATION fold (T24a carved this out — see
   `trainer.train_instrument` cal_days param).
2. Serialize the learned step function as (x_knots, y_knots) arrays in
   `<head>.calibration.json` next to each `.lgbm`.
3. At inference (SEA model_loader), `apply_calibration(raw_prob, ...)`
   uses `numpy.interp` for the lookup — O(log N) per call, N ≤ ~100.

A missing sidecar means the head ships without calibration; consumers
fall back to raw `predict()`. This is graceful (matches the missing-
.lgbm semantics of model_loader) but flagged in WARN logs at training
end so we know which heads lack a calibration map.

SCOPE NARROWING (D75 Gap 4, 2026-05-18)
---------------------------------------
Only binary heads get calibration. Regression heads (magnitude,
max_upside, max_drawdown, max_excursion, total_premium_decay,
avg_decay_per_strike, risk_reward_ratio) emit signed point estimates
where "calibration" has no semantic meaning. This narrows the per-
instrument fit count from 84 → 32 (20 scalp binary + 6 trend binary
+ 6 swing binary), keeping the Saturday compute cost trivial
(~2-3 min total across 4 instruments).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sklearn.isotonic import IsotonicRegression


SIDECAR_VERSION = 1
SIDECAR_SUFFIX = ".calibration.json"


@dataclass(frozen=True)
class CalibrationMap:
    """The fitted isotonic step function for one binary head.

    `x_knots` and `y_knots` are equal-length 1-D arrays describing the
    piecewise-linear mapping raw_prob → calibrated_prob. Both are sorted
    ascending in `x_knots`. `y_knots` is monotone non-decreasing in
    [0, 1] (the isotonic constraint guarantees this).

    `apply(raw_prob)` clips to the convex hull of `x_knots` and runs
    `numpy.interp` for the lookup.
    """

    head_name: str
    x_knots: np.ndarray
    y_knots: np.ndarray
    n_samples: int
    """How many (raw_prob, y_true) pairs the isotonic was fitted on.
    Saved so reliability reports can weight calibration confidence."""

    def apply(self, raw_prob: float | np.ndarray) -> float | np.ndarray:
        """Map raw probability(ies) to calibrated probability(ies).

        Inputs outside [x_knots[0], x_knots[-1]] are clipped to the
        endpoint y_knot — matches sklearn's `out_of_bounds='clip'` behavior.
        Inputs that are NaN propagate to NaN.
        """
        return np.interp(raw_prob, self.x_knots, self.y_knots)


def fit_isotonic_for_head(
    raw_probs: np.ndarray,
    y_true: np.ndarray,
    head_name: str,
) -> CalibrationMap:
    """Fit `IsotonicRegression(out_of_bounds='clip')` on (raw_probs, y_true).

    Skips invalid rows (NaN raw_probs or NaN y_true) before fitting.
    Raises `ValueError` if fewer than 10 valid pairs survive — too sparse
    for a meaningful calibration. Callers should catch this and log a
    skip rather than aborting the whole training run.
    """
    if raw_probs.shape != y_true.shape:
        raise ValueError(
            f"shape mismatch: raw_probs={raw_probs.shape} y_true={y_true.shape}"
        )

    raw_arr = np.asarray(raw_probs, dtype=np.float64)
    y_arr = np.asarray(y_true, dtype=np.float64)

    mask = np.isfinite(raw_arr) & np.isfinite(y_arr)
    raw_arr = raw_arr[mask]
    y_arr = y_arr[mask]

    if len(raw_arr) < 10:
        raise ValueError(
            f"only {len(raw_arr)} valid samples for {head_name!r}; "
            "need >= 10 for isotonic fit"
        )

    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
    iso.fit(raw_arr, y_arr)

    return CalibrationMap(
        head_name=head_name,
        x_knots=np.asarray(iso.X_thresholds_, dtype=np.float64),
        y_knots=np.asarray(iso.y_thresholds_, dtype=np.float64),
        n_samples=int(len(raw_arr)),
    )


def write_calibration_sidecar(path: Path, cmap: CalibrationMap) -> None:
    """Serialize a CalibrationMap to a versioned JSON sidecar.

    Format (deterministic, ASCII):
        {
          "version": 1,
          "head_name": "...",
          "x_knots": [...],
          "y_knots": [...],
          "n_samples": N
        }
    """
    payload = {
        "version": SIDECAR_VERSION,
        "head_name": cmap.head_name,
        "x_knots": cmap.x_knots.tolist(),
        "y_knots": cmap.y_knots.tolist(),
        "n_samples": cmap.n_samples,
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def read_calibration_sidecar(path: Path) -> CalibrationMap | None:
    """Read a `.calibration.json` sidecar into a CalibrationMap.

    Returns `None` if the file does not exist (signals "no calibration —
    use raw probability"). Raises `ValueError` for malformed payloads,
    version mismatch, or sidecar files whose contents fail invariants.
    """
    if not path.exists():
        return None

    payload = json.loads(path.read_text(encoding="utf-8"))

    version = payload.get("version")
    if version != SIDECAR_VERSION:
        raise ValueError(
            f"{path}: unsupported sidecar version {version!r} "
            f"(expected {SIDECAR_VERSION})"
        )

    head_name = payload.get("head_name")
    x_knots = np.asarray(payload.get("x_knots", []), dtype=np.float64)
    y_knots = np.asarray(payload.get("y_knots", []), dtype=np.float64)
    n_samples = int(payload.get("n_samples", 0))

    if x_knots.shape != y_knots.shape:
        raise ValueError(
            f"{path}: x_knots / y_knots shape mismatch "
            f"({x_knots.shape} vs {y_knots.shape})"
        )
    if x_knots.ndim != 1 or len(x_knots) < 2:
        raise ValueError(
            f"{path}: need >= 2 knot points, got {len(x_knots)}"
        )
    if not isinstance(head_name, str) or not head_name:
        raise ValueError(f"{path}: missing or empty head_name")

    return CalibrationMap(
        head_name=head_name,
        x_knots=x_knots,
        y_knots=y_knots,
        n_samples=n_samples,
    )


def calibration_sidecar_path(model_path: Path) -> Path:
    """Sidecar path for a `.lgbm` model path.

    e.g. `models/nifty50/v_2026/direction_60s.lgbm`
       → `models/nifty50/v_2026/direction_60s.calibration.json`
    """
    return model_path.with_suffix("").with_suffix(SIDECAR_SUFFIX) \
        if model_path.suffix == ".lgbm" \
        else model_path.parent / (model_path.name + SIDECAR_SUFFIX)
