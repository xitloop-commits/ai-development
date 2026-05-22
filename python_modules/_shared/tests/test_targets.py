"""
tests/test_targets.py — Unit tests for `_shared.targets`.

These guarantee that the canonical 84-head MVP target matrix stays
locked. Both the MTA trainer and the SEA model loader import from
`_shared.targets`; if anyone inadvertently breaks the invariant
(adds an orphan, removes a window, duplicates a name, mis-tags a
head_type), CI fails here before the trainer or loader can ship a
bad target list.

Composition (V2_MASTER_SPEC §2.2 / D55, locked 2026-05-17):
    60 scalp  =  12 types × 5 windows (60/120/180/240/300s)
    12 trend  =   6 types × 2 windows (900/1800s)
    12 swing  =   6 types × 2 windows (3600/7200s)

Wave 2 lock May 11 2026: scalp windows (60,120,180,240,300), 12 types.
Trend/swing addition May 17 2026: spot-based, 6 types per horizon.

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
    SWING_HORIZONS_SEC,
    TREND_HORIZONS_SEC,
    TargetSpec,
)

# ── Cardinality (the 84-head invariant: 60 scalp + 12 trend + 12 swing) ────


def test_mvp_targets_has_exactly_84_entries() -> None:
    assert len(MVP_TARGETS) == 84


def test_mvp_target_names_has_84_unique_entries() -> None:
    assert len(MVP_TARGET_NAMES) == 84
    assert len(set(MVP_TARGET_NAMES)) == 84, "duplicate target names"


def test_mvp_target_objectives_has_84_entries() -> None:
    assert len(MVP_TARGET_OBJECTIVES) == 84


def test_mvp_target_head_types_has_84_entries() -> None:
    assert len(MVP_TARGET_HEAD_TYPES) == 84


# ── Window coverage ───────────────────────────────────────────────────────


def test_lookahead_windows_are_60_120_180_240_300() -> None:
    assert LOOKAHEAD_WINDOWS_SECONDS == (60, 120, 180, 240, 300)


def test_trend_horizons_are_900_1800() -> None:
    assert TREND_HORIZONS_SEC == (900, 1800)


def test_swing_horizons_are_3600_7200() -> None:
    assert SWING_HORIZONS_SEC == (3600, 7200)


def test_every_scalp_window_has_exactly_twelve_targets() -> None:
    by_window: dict[int, list[str]] = {}
    for spec in MVP_TARGETS:
        if spec.head_type != "scalp":
            continue
        by_window.setdefault(spec.lookahead_seconds, []).append(spec.name)
    assert set(by_window) == set(LOOKAHEAD_WINDOWS_SECONDS)
    for w, names in by_window.items():
        assert len(names) == 12, f"scalp window {w}s has {len(names)} targets, expected 12"


def test_every_trend_horizon_has_exactly_six_targets() -> None:
    by_w: dict[int, list[str]] = {}
    for spec in MVP_TARGETS:
        if spec.head_type != "trend":
            continue
        by_w.setdefault(spec.lookahead_seconds, []).append(spec.name)
    assert set(by_w) == set(TREND_HORIZONS_SEC)
    for w, names in by_w.items():
        assert len(names) == 6, f"trend horizon {w}s has {len(names)} targets, expected 6"


def test_every_swing_horizon_has_exactly_six_targets() -> None:
    by_w: dict[int, list[str]] = {}
    for spec in MVP_TARGETS:
        if spec.head_type != "swing":
            continue
        by_w.setdefault(spec.lookahead_seconds, []).append(spec.name)
    assert set(by_w) == set(SWING_HORIZONS_SEC)
    for w, names in by_w.items():
        assert len(names) == 6, f"swing horizon {w}s has {len(names)} targets, expected 6"


# ── Target-type families (locked Phase D4 + Wave 2) ──────────────────────

_EXPECTED_TYPE_PREFIXES = {
    "direction":              "binary",      # original 7
    "direction_magnitude":    "regression",
    "risk_reward_ratio":      "regression",
    "max_upside":             "regression",
    "max_drawdown":           "regression",
    "total_premium_decay":    "regression",
    "avg_decay_per_strike":   "regression",
    "direction_persists":     "binary",      # Wave 2 additions (5)
    "breakout_in":            "binary",
    "exit_signal":            "binary",
    "max_upside_pe":          "regression",
    "max_drawdown_pe":        "regression",
}


def test_each_window_contains_all_twelve_target_types() -> None:
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
            f"direction_persists_{w}s",
            f"breakout_in_{w}s",
            f"exit_signal_{w}s",
            f"max_upside_pe_{w}s",
            f"max_drawdown_pe_{w}s",
        }
        assert names_for_w == expected, f"window {w}s mismatch: {names_for_w ^ expected}"


def test_binary_vs_regression_objectives() -> None:
    """Scalp heads only — Binary: direction (raw), direction_persists,
    breakout_in, exit_signal. Regression: everything else.

    Trend/swing objectives are tested separately in
    `test_trend_swing_objectives`.
    """
    binary_prefixes = {
        "direction_persists",
        "breakout_in",
        "exit_signal",
    }
    for spec in MVP_TARGETS:
        if spec.head_type != "scalp":
            continue
        # `direction_{w}s` (no magnitude tail) is binary
        if spec.name.startswith("direction_") and not spec.name.endswith("_magnitude") \
                and not any(spec.name.startswith(p + "_") for p in binary_prefixes):
            assert spec.target_type == "binary", f"{spec.name} should be binary"
            continue
        # Wave 2 binary additions
        if any(spec.name.startswith(p + "_") for p in binary_prefixes):
            assert spec.target_type == "binary", f"{spec.name} should be binary"
            continue
        # All other scalp targets are regression
        assert spec.target_type == "regression", \
            f"{spec.name} should be regression, got {spec.target_type}"


# ── Wave 2 additions are present ─────────────────────────────────────────


def test_wave2_target_types_present() -> None:
    """Sanity check that Wave 2 added the 5 new types at all 5 scalp windows."""
    for w in LOOKAHEAD_WINDOWS_SECONDS:
        for new_type in (
            "direction_persists", "breakout_in", "exit_signal",
            "max_upside_pe", "max_drawdown_pe",
        ):
            assert f"{new_type}_{w}s" in MVP_TARGET_NAMES


# ── Trend + swing additions (D55, locked 2026-05-17) ─────────────────────


def test_trend_target_names_match_tfa_writer() -> None:
    """Trend column names registered here MUST match what
    `tick_feature_agent.features.trend_swing_targets` writes to parquet."""
    expected_types = (
        "direction", "magnitude", "max_excursion",
        "max_drawdown", "continues", "breakout_imminent",
    )
    for w in TREND_HORIZONS_SEC:
        for t in expected_types:
            assert f"trend_{t}_{w}s" in MVP_TARGET_NAMES


def test_swing_target_names_match_tfa_writer() -> None:
    expected_types = (
        "direction", "magnitude", "max_excursion",
        "max_drawdown", "continues", "breakout_imminent",
    )
    for w in SWING_HORIZONS_SEC:
        for t in expected_types:
            assert f"swing_{t}_{w}s" in MVP_TARGET_NAMES


def test_head_type_distribution_is_60_scalp_12_trend_12_swing() -> None:
    counts = {
        ht: sum(1 for s in MVP_TARGETS if s.head_type == ht)
        for ht in ("scalp", "trend", "swing")
    }
    assert counts == {"scalp": 60, "trend": 12, "swing": 12}


def test_trend_swing_objectives() -> None:
    """direction/continues/breakout_imminent = binary; mag/exc/draw = regression."""
    binary_types = {"direction", "continues", "breakout_imminent"}
    regression_types = {"magnitude", "max_excursion", "max_drawdown"}
    for spec in MVP_TARGETS:
        if spec.head_type == "scalp":
            continue
        # Strip layer + horizon suffix
        # e.g. "trend_max_excursion_900s" → "max_excursion"
        prefix = spec.name.split("_", 1)[1]  # drop "trend_" / "swing_"
        base = prefix.rsplit("_", 1)[0]      # drop "_900s"
        if base in binary_types:
            assert spec.target_type == "binary", f"{spec.name} should be binary"
        elif base in regression_types:
            assert spec.target_type == "regression", \
                f"{spec.name} should be regression"
        else:
            raise AssertionError(f"unknown trend/swing type in {spec.name}: {base}")


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


# ── Trainer + loader consume the same source ──────────────────────────────


def test_trainer_imports_shared_targets() -> None:
    """Regression: trainer must use _shared.targets."""
    from model_training_agent import trainer

    # trainer aliases MVP_TARGET_OBJECTIVES → MVP_TARGETS; both must agree.
    assert trainer.MVP_TARGETS == MVP_TARGET_OBJECTIVES
    assert len(trainer.MVP_TARGETS) == 84


def test_model_loader_imports_shared_targets() -> None:
    """Regression: SEA loader must use _shared.targets MVP_TARGET_NAMES."""
    from signal_engine_agent import model_loader

    assert model_loader.MVP_TARGETS == MVP_TARGET_NAMES
    assert len(model_loader.MVP_TARGETS) == 84
