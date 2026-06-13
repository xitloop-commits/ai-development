"""
Tests for T14 (scope F) strike-migration persistence counter.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PY_MODULES = _HERE.parents[1]
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from tick_feature_agent.features.strike_migration_persistence import (  # noqa: E402
    StrikeMigrationPersistenceState,
)


def test_first_valid_reading_starts_counter_at_1() -> None:
    s = StrikeMigrationPersistenceState()
    assert s.update(+1.0) == 1.0


def test_same_direction_increments() -> None:
    s = StrikeMigrationPersistenceState()
    s.update(+1.0)
    s.update(+1.0)
    s.update(+1.0)
    assert s.update(+1.0) == 4.0


def test_negative_direction_increments_independently() -> None:
    s = StrikeMigrationPersistenceState()
    s.update(-1.0)
    s.update(-1.0)
    assert s.update(-1.0) == 3.0


def test_sign_flip_resets_to_1() -> None:
    s = StrikeMigrationPersistenceState()
    s.update(+1.0)
    s.update(+1.0)
    s.update(+1.0)
    # Flip to -1 — fresh run.
    assert s.update(-1.0) == 1.0


def test_zero_direction_resets_to_0() -> None:
    """An explicit no-shift tick wipes the run — the next non-zero
    direction starts fresh, not as a continuation."""
    s = StrikeMigrationPersistenceState()
    s.update(+1.0)
    s.update(+1.0)
    assert s.update(0.0) == 0.0
    # Next +1 must be a fresh run, not 3.
    assert s.update(+1.0) == 1.0


def test_nan_input_holds_state_emits_nan_until_first_valid() -> None:
    """Before any valid reading, NaN inputs emit NaN. After a valid
    reading, NaN inputs hold the counter at its last value."""
    s = StrikeMigrationPersistenceState()
    assert math.isnan(s.update(float("nan")))
    # Seed with +1.
    s.update(+1.0)
    s.update(+1.0)
    # NaN mid-stream → hold the counter, return 2.
    assert s.update(float("nan")) == 2.0


def test_none_input_treated_as_nan() -> None:
    s = StrikeMigrationPersistenceState()
    assert math.isnan(s.update(None))


def test_reset_clears_state() -> None:
    s = StrikeMigrationPersistenceState()
    s.update(+1.0)
    s.update(+1.0)
    s.update(+1.0)
    s.reset()
    # After reset, next +1 is a fresh run starting at 1.
    assert s.update(+1.0) == 1.0


def test_extended_run_counts_correctly() -> None:
    """30 same-direction ticks → count reaches 30."""
    s = StrikeMigrationPersistenceState()
    for i in range(30):
        out = s.update(+1.0)
    assert out == 30.0
