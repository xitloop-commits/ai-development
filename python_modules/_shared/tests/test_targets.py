"""
tests/test_targets.py — Unit tests for `_shared.targets`.

These guarantee the canonical option-premium head matrix stays locked. Both
the MTA trainer and the SEA model loader import from `_shared.targets`; if
anyone inadvertently breaks the invariant (adds an orphan, removes a window,
duplicates a name, mis-tags a head_type), CI fails here before the trainer or
loader can ship a bad target list.

T166 (2026-08-19) composition — option-premium ONLY:
    52 heads = 13 option-leg types x 4 windows (60/300/600/900s)
    The old spot trend/swing layers (900/1800/3600/7200s) are RETIRED.
    Every head is head_type "scalp" (option-premium); the trading cohort
    (scalp/trend/swing) is derived from the window by cohort.py, not head_type.

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
    MVP_TARGET_HEAD_TYPES,
    MVP_TARGET_NAMES,
    MVP_TARGET_OBJECTIVES,
    MVP_TARGETS,
    TargetSpec,
)

_N = 52  # 13 types x 4 windows


# ── Cardinality (the 52-head option-premium invariant) ──────────────────────


def test_mvp_targets_has_exactly_52_entries() -> None:
    assert len(MVP_TARGETS) == _N


def test_mvp_target_names_has_52_unique_entries() -> None:
    assert len(MVP_TARGET_NAMES) == _N
    assert len(set(MVP_TARGET_NAMES)) == _N, "duplicate target names"


def test_mvp_target_objectives_has_52_entries() -> None:
    assert len(MVP_TARGET_OBJECTIVES) == _N


def test_mvp_target_head_types_has_52_entries() -> None:
    assert len(MVP_TARGET_HEAD_TYPES) == _N


# ── Window coverage ─────────────────────────────────────────────────────────


def test_lookahead_windows_are_60_300_600_900() -> None:
    assert LOOKAHEAD_WINDOWS_SECONDS == (60, 300, 600, 900)


def test_every_window_has_exactly_thirteen_targets() -> None:
    by_window: dict[int, list[str]] = {}
    for spec in MVP_TARGETS:
        by_window.setdefault(spec.lookahead_seconds, []).append(spec.name)
    assert set(by_window) == set(LOOKAHEAD_WINDOWS_SECONDS)
    for w, names in by_window.items():
        assert len(names) == 13, f"window {w}s has {len(names)} targets, expected 13"


def test_every_head_is_option_premium_scalp() -> None:
    """T166: every head is option-premium; head_type is 'scalp' throughout."""
    assert all(s.head_type == "scalp" for s in MVP_TARGETS)


# ── Target-type families (option-leg, locked Phase D4 + Wave 2 + Part B) ─────


def test_each_window_contains_all_thirteen_target_types() -> None:
    for w in LOOKAHEAD_WINDOWS_SECONDS:
        names_for_w = {s.name for s in MVP_TARGETS if s.lookahead_seconds == w}
        # direction has no `_magnitude` tail; the magnitude head does.
        expected = {
            f"direction_{w}s",
            f"direction_{w}s_magnitude",
            f"risk_reward_ratio_{w}s",
            f"max_upside_{w}s",
            f"max_drawdown_{w}s",
            f"total_premium_decay_{w}s",
            f"avg_decay_per_strike_{w}s",
            f"direction_persists_{w}s",
            f"breakout_in_{w}s",
            f"exit_signal_{w}s",
            f"max_upside_pe_{w}s",
            f"max_drawdown_pe_{w}s",
            f"risk_reward_ratio_pe_{w}s",
        }
        assert names_for_w == expected, f"window {w}s mismatch: {names_for_w ^ expected}"


def test_binary_vs_regression_objectives() -> None:
    """Binary: direction (raw), direction_persists, breakout_in, exit_signal.
    Regression: everything else (incl. direction_magnitude + all RR/upside/
    drawdown/decay heads)."""
    binary_prefixes = {
        "direction_persists",
        "breakout_in",
        "exit_signal",
    }
    for spec in MVP_TARGETS:
        # `direction_{w}s` (no magnitude tail) is binary
        if spec.name.startswith("direction_") and not spec.name.endswith("_magnitude") \
                and not any(spec.name.startswith(p + "_") for p in binary_prefixes):
            assert spec.target_type == "binary", f"{spec.name} should be binary"
            continue
        if any(spec.name.startswith(p + "_") for p in binary_prefixes):
            assert spec.target_type == "binary", f"{spec.name} should be binary"
            continue
        assert spec.target_type == "regression", \
            f"{spec.name} should be regression, got {spec.target_type}"


def test_wave2_target_types_present_at_every_window() -> None:
    """The 5 Wave-2 additions exist at all 4 windows (incl. the new 600s)."""
    for w in LOOKAHEAD_WINDOWS_SECONDS:
        for new_type in (
            "direction_persists", "breakout_in", "exit_signal",
            "max_upside_pe", "max_drawdown_pe",
        ):
            assert f"{new_type}_{w}s" in MVP_TARGET_NAMES


def test_new_600s_window_is_fully_populated() -> None:
    """The brand-new 10-min (600s) trend cohort horizon carries the full set."""
    heads_600 = {s.name for s in MVP_TARGETS if s.lookahead_seconds == 600}
    assert len(heads_600) == 13
    assert "direction_600s" in heads_600
    assert "exit_signal_600s" in heads_600


def test_retired_spot_layers_are_absent() -> None:
    """T166 retired the spot trend/swing heads — they must not reappear."""
    for name in MVP_TARGET_NAMES:
        assert not name.startswith("trend_"), f"retired spot head resurfaced: {name}"
        assert not name.startswith("swing_"), f"retired spot head resurfaced: {name}"
    # Their old horizons must not exist as any head either.
    for w in (120, 180, 240, 1800, 3600, 7200):
        assert not any(s.lookahead_seconds == w for s in MVP_TARGETS), \
            f"retired window {w}s still present"


# ── Negative guard: orphans must not creep back in ──────────────────────────


def test_orphan_upside_percentile_is_not_a_training_target() -> None:
    # `upside_percentile_{w}s` is a TFA-emitted live feature column (session-
    # rank); it must never re-enter MVP_TARGETS as a model target.
    assert "upside_percentile_30s" not in MVP_TARGET_NAMES
    assert "upside_percentile_300s" not in MVP_TARGET_NAMES
    assert "upside_percentile_300s" not in MVP_TARGET_OBJECTIVES


# ── Convenience-view consistency ────────────────────────────────────────────


def test_target_names_view_matches_mvp_targets() -> None:
    assert MVP_TARGET_NAMES == tuple(s.name for s in MVP_TARGETS)


def test_target_objectives_view_matches_mvp_targets() -> None:
    assert MVP_TARGET_OBJECTIVES == {s.name: s.target_type for s in MVP_TARGETS}


def test_target_head_types_view_matches_mvp_targets() -> None:
    assert MVP_TARGET_HEAD_TYPES == {s.name: s.head_type for s in MVP_TARGETS}


def test_target_spec_is_frozen_dataclass() -> None:
    spec = MVP_TARGETS[0]
    with pytest.raises(Exception):
        spec.name = "tampered"  # type: ignore[misc]


def test_target_spec_default_head_type_is_scalp() -> None:
    """Backwards compatibility: existing positional `TargetSpec(...)` calls
    that didn't pass head_type must continue to default to 'scalp'."""
    spec = TargetSpec("foo_60s", "binary", 60)
    assert spec.head_type == "scalp"


# ── Trainer + loader consume the same source ────────────────────────────────


def test_trainer_imports_shared_targets() -> None:
    """Regression: trainer must use _shared.targets."""
    from model_training_agent import trainer

    # trainer aliases MVP_TARGET_OBJECTIVES -> MVP_TARGETS; both must agree.
    assert trainer.MVP_TARGETS == MVP_TARGET_OBJECTIVES
    assert len(trainer.MVP_TARGETS) == _N


def test_model_loader_imports_shared_targets() -> None:
    """Regression: SEA loader must use _shared.targets MVP_TARGET_NAMES."""
    from signal_engine_agent import model_loader

    assert model_loader.MVP_TARGETS == MVP_TARGET_NAMES
    assert len(model_loader.MVP_TARGETS) == _N
