"""
Tests for T14 (scope F) ATM premium-acceleration drop detector.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PY_MODULES = _HERE.parents[1]
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from tick_feature_agent.features.premium_acceleration import (  # noqa: E402
    PremiumAccelerationState,
    _drop_signal,
)


# ── _drop_signal pure helper ─────────────────────────────────────────────────


def test_drop_signal_first_tick_returns_nan() -> None:
    """No prev value → NaN."""
    assert math.isnan(_drop_signal(None, 5.0))


def test_drop_signal_nan_inputs_return_nan() -> None:
    assert math.isnan(_drop_signal(float("nan"), 5.0))
    assert math.isnan(_drop_signal(5.0, float("nan")))


def test_drop_signal_zero_or_negative_prev_returns_zero() -> None:
    """Prev <= 0 means premium WASN'T gaining → no drop signal of
    interest. Output 0 (not NaN) so the model sees a concrete value."""
    assert _drop_signal(0.0, -5.0) == 0.0
    assert _drop_signal(-2.0, -10.0) == 0.0


def test_drop_signal_current_at_or_above_prev_returns_zero() -> None:
    """Premium accelerating (current >= prev) → no drop."""
    assert _drop_signal(3.0, 3.0) == 0.0
    assert _drop_signal(3.0, 5.0) == 0.0


def test_drop_signal_positive_drop_returns_magnitude() -> None:
    """The headline case: prev was rising, current slowed → return the
    magnitude of the drop."""
    assert _drop_signal(10.0, 4.0) == 6.0
    assert _drop_signal(3.0, 1.0) == 2.0


def test_drop_signal_positive_drop_to_negative_includes_both_halves() -> None:
    """If prev was +5 and cur is -2, the drop is 7 (full magnitude of
    the change), not just the positive half. Premium went from rising
    to falling."""
    assert _drop_signal(5.0, -2.0) == 7.0


# ── PremiumAccelerationState ─────────────────────────────────────────────────


def test_state_first_update_returns_nan() -> None:
    s = PremiumAccelerationState()
    out = s.update(ce_momentum=5.0, pe_momentum=3.0)
    assert math.isnan(out["premium_acceleration_drop_atm_ce"])
    assert math.isnan(out["premium_acceleration_drop_atm_pe"])


def test_state_second_update_detects_drop_per_leg() -> None:
    s = PremiumAccelerationState()
    s.update(ce_momentum=10.0, pe_momentum=2.0)
    out = s.update(ce_momentum=3.0, pe_momentum=2.0)
    # CE: prev 10 → cur 3, drop 7
    assert out["premium_acceleration_drop_atm_ce"] == 7.0
    # PE: prev 2 → cur 2, no drop
    assert out["premium_acceleration_drop_atm_pe"] == 0.0


def test_state_nan_input_does_not_overwrite_prev() -> None:
    """A warmup / staleness NaN reading mid-stream must not wipe the
    last good prev value — otherwise a single bad tick would set
    state back to None and the next valid reading would emit NaN."""
    s = PremiumAccelerationState()
    s.update(ce_momentum=10.0, pe_momentum=5.0)  # prev now 10/5
    out_nan = s.update(ce_momentum=float("nan"), pe_momentum=float("nan"))
    # NaN inputs → NaN outputs this tick, but prev held intact.
    assert math.isnan(out_nan["premium_acceleration_drop_atm_ce"])
    out_next = s.update(ce_momentum=3.0, pe_momentum=2.0)
    # prev was still 10 / 5 — drops should compute correctly.
    assert out_next["premium_acceleration_drop_atm_ce"] == 7.0
    assert out_next["premium_acceleration_drop_atm_pe"] == 3.0


def test_state_reset_clears_history() -> None:
    s = PremiumAccelerationState()
    s.update(ce_momentum=10.0, pe_momentum=5.0)
    s.reset()
    out = s.update(ce_momentum=3.0, pe_momentum=2.0)
    # After reset, no prev → both NaN.
    assert math.isnan(out["premium_acceleration_drop_atm_ce"])
    assert math.isnan(out["premium_acceleration_drop_atm_pe"])
