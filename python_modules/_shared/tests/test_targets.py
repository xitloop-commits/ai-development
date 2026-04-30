"""
tests/test_targets.py — Unit tests for `_shared.targets`.

These guarantee that the canonical 7×4 = 28 MVP target matrix stays
locked. Both the MTA trainer and the SEA model loader import from
`_shared.targets`; if anyone inadvertently breaks the invariant
(adds an orphan, removes a window, duplicates a name), CI fails here
before the trainer or loader can ship a bad target list.

Run: python -m pytest python_modules/_shared/tests/test_targets.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent  # python_modules/
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from _shared.targets import (
    LOOKAHEAD_WINDOWS_SECONDS,
    MVP_TARGETS,
    MVP_TARGET_NAMES,
    MVP_TARGET_OBJECTIVES,
    TargetSpec,
)


# ── Cardinality (the 7×4 = 28 invariant) ──────────────────────────────────

def test_mvp_targets_has_exactly_28_entries() -> None:
    assert len(MVP_TARGETS) == 28


def test_mvp_target_names_has_28_unique_entries() -> None:
    assert len(MVP_TARGET_NAMES) == 28
    assert len(set(MVP_TARGET_NAMES)) == 28, "duplicate target names"


def test_mvp_target_objectives_has_28_entries() -> None:
    assert len(MVP_TARGET_OBJECTIVES) == 28


# ── Window coverage ───────────────────────────────────────────────────────

def test_lookahead_windows_are_30_60_300_900() -> None:
    assert LOOKAHEAD_WINDOWS_SECONDS == (30, 60, 300, 900)


def test_every_window_has_exactly_seven_targets() -> None:
    by_window: dict[int, list[str]] = {}
    for spec in MVP_TARGETS:
        by_window.setdefault(spec.lookahead_seconds, []).append(spec.name)
    assert set(by_window) == set(LOOKAHEAD_WINDOWS_SECONDS)
    for w, names in by_window.items():
        assert len(names) == 7, f"window {w}s has {len(names)} targets, expected 7"


# ── Target-type families (locked Phase D4) ────────────────────────────────

_EXPECTED_TYPE_PREFIXES = {
    "direction": "binary",
    "direction_magnitude": "regression",
    "risk_reward_ratio": "regression",
    "max_upside": "regression",
    "max_drawdown": "regression",
    "total_premium_decay": "regression",
    "avg_decay_per_strike": "regression",
}


def test_each_window_contains_all_seven_target_types() -> None:
    for w in LOOKAHEAD_WINDOWS_SECONDS:
        names_for_w = {s.name for s in MVP_TARGETS if s.lookahead_seconds == w}
        # direction has no `_magnitude` tail; magnitudes do.
        expected = {
            f"direction_{w}s",
            f"direction_{w}s_magnitude",
            f"risk_reward_ratio_{w}s",
            f"max_upside_{w}s",
            f"max_drawdown_{w}s",
            f"total_premium_decay_{w}s",
            f"avg_decay_per_strike_{w}s",
        }
        assert names_for_w == expected, f"window {w}s mismatch: {names_for_w ^ expected}"


def test_direction_targets_are_binary_others_regression() -> None:
    for spec in MVP_TARGETS:
        if spec.name.startswith("direction_") and not spec.name.endswith("_magnitude"):
            assert spec.target_type == "binary", (
                f"{spec.name} should be binary, got {spec.target_type}"
            )
        else:
            assert spec.target_type == "regression", (
                f"{spec.name} should be regression, got {spec.target_type}"
            )


# ── Negative guard: orphans must not creep back in ────────────────────────

def test_orphan_upside_percentile_is_not_a_training_target() -> None:
    # `upside_percentile_30s` is a TFA-emitted live feature column (computed
    # session-rank); it must never re-enter MVP_TARGETS as a model target,
    # which is what Phase E9 fixed.
    assert "upside_percentile_30s" not in MVP_TARGET_NAMES
    assert "upside_percentile_30s" not in MVP_TARGET_OBJECTIVES


# ── Convenience-view consistency ──────────────────────────────────────────

def test_target_names_view_matches_mvp_targets() -> None:
    assert MVP_TARGET_NAMES == tuple(s.name for s in MVP_TARGETS)


def test_target_objectives_view_matches_mvp_targets() -> None:
    assert MVP_TARGET_OBJECTIVES == {s.name: s.target_type for s in MVP_TARGETS}


def test_target_spec_is_frozen_dataclass() -> None:
    spec = MVP_TARGETS[0]
    with pytest.raises(Exception):
        spec.name = "tampered"  # type: ignore[misc]


# ── Trainer + loader consume the same source ──────────────────────────────

def test_trainer_imports_shared_targets() -> None:
    """Regression test for the D4 29-vs-28 drift: trainer must use _shared.targets."""
    from model_training_agent import trainer
    # trainer aliases MVP_TARGET_OBJECTIVES → MVP_TARGETS; both must agree.
    assert trainer.MVP_TARGETS == MVP_TARGET_OBJECTIVES
    assert len(trainer.MVP_TARGETS) == 28


def test_model_loader_imports_shared_targets() -> None:
    """Regression test: SEA loader must use _shared.targets MVP_TARGET_NAMES."""
    from signal_engine_agent import model_loader
    assert model_loader.MVP_TARGETS == MVP_TARGET_NAMES
    assert len(model_loader.MVP_TARGETS) == 28
