"""
_shared.targets — single source of truth for the MVP target set.

Per IMPLEMENTATION_PLAN_v2.md §6 D4 + §7 E9 (and Wave 2 lock May 11 2026):
the MTA model trainer (`model_training_agent.trainer`) and the SEA model
loader (`signal_engine_agent.model_loader`) both need the same canonical
list of 60 ML targets. Before this module they each kept a private copy
and had silently drifted (e.g. an orphan `upside_percentile_30s` that
didn't fit the locked matrix).

The 60 targets are the cartesian product of:

    12 target types  ×  5 lookahead windows  =  60

Target types (locked Phase D4 + Wave 2):
    direction              binary       (was the trade up or down?)
    direction_magnitude    regression   (how much did it move?)
    direction_persists     binary       (did direction hold throughout
                                         the window — no intra-window flip?)
    risk_reward_ratio      regression   (predicted RR if we'd taken it)
    max_upside             regression   (predicted ₹ upside, CE-leg)
    max_drawdown           regression   (predicted ₹ downside, CE-leg)
    max_upside_pe          regression   (predicted ₹ upside, PE-leg)
    max_drawdown_pe        regression   (predicted ₹ downside, PE-leg)
    total_premium_decay    regression   (theta-burn over the window)
    avg_decay_per_strike   regression   (premium decay normalised per-strike)
    breakout_in            binary       (did spot cross day_high or
                                         day_low within the window?)
    exit_signal            binary       (should an open position close —
                                         direction flip OR drawdown > 1%?)

Lookahead windows (Wave 2 lock May 11 2026):
    60s, 120s, 180s, 240s, 300s — densely covers the 1m–5m persistence
    range. Drops 30s (below 1m floor) and 900s (long-horizon direction
    models flat on commodities, see Wave 1 benchmark report).

`upside_percentile_30s` is a TFA-emitted live feature column (computed
session-rank of `max_upside_30s`); keeping it in the parquet feature
schema is correct, but training a model to PREDICT it was a leftover
from before the spec lock and is no longer in scope.

Naming convention:
    direction targets       → `direction_{Ws}` (e.g. `direction_30s`)
    direction magnitudes    → `direction_{Ws}_magnitude`
    other regression targets → `{type}_{Ws}` (e.g. `max_upside_60s`)

This naming is preserved verbatim from the previous local copies so
no .lgbm files on disk need renaming.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class TargetSpec:
    """One row of the 7×4 target matrix.

    Fields:
        name              the .lgbm filename root + the metrics.json key
        target_type       LightGBM objective family (binary / regression)
        lookahead_seconds the window this target predicts forward
    """

    name: str
    target_type: Literal["binary", "regression"]
    lookahead_seconds: int


# Lookahead windows — keep this tuple ordered shortest → longest for
# stable iteration order in trainer logs / loader output.
#
# Wave 2 (May 11 2026): drop 30s (below 1m persistence floor) and 900s
# (long-horizon direction models flat on commodities — see Wave 1
# benchmark report). Add 120/180/240 to densely cover the 1m–5m range
# where the user wants signals to persist.
LOOKAHEAD_WINDOWS_SECONDS: tuple[int, ...] = (60, 120, 180, 240, 300)


def _build_mvp_targets() -> tuple[TargetSpec, ...]:
    """Build the 12×5 = 60 target list deterministically.

    Built once at import time. The naming convention is intentionally
    not regular across the types (direction uses an inline suffix,
    magnitudes have a `_magnitude` tail) — preserved verbatim from the
    previous loader copies so existing model files retain naming.

    Wave 2 (May 11 2026) added 5 new target types beyond the original 7:
        direction_persists  binary  — does direction hold throughout
                                      the window without intra-window flip?
        breakout_in         binary  — does spot cross day_high or
                                      day_low within the window?
        exit_signal         binary  — should an open position close in
                                      the window? Triggers on direction
                                      flip OR drawdown > 1%.
        max_upside_pe       regression — best swing on PE leg
        max_drawdown_pe     regression — worst dip on PE leg
    """
    out: list[TargetSpec] = []
    for w in LOOKAHEAD_WINDOWS_SECONDS:
        # Original 7 (CE-leg only)
        out.append(TargetSpec(f"direction_{w}s", "binary", w))
        out.append(TargetSpec(f"direction_{w}s_magnitude", "regression", w))
        out.append(TargetSpec(f"risk_reward_ratio_{w}s", "regression", w))
        out.append(TargetSpec(f"max_upside_{w}s", "regression", w))
        out.append(TargetSpec(f"max_drawdown_{w}s", "regression", w))
        out.append(TargetSpec(f"total_premium_decay_{w}s", "regression", w))
        out.append(TargetSpec(f"avg_decay_per_strike_{w}s", "regression", w))
        # Wave 2 additions (5 new types)
        out.append(TargetSpec(f"direction_persists_{w}s", "binary", w))
        out.append(TargetSpec(f"breakout_in_{w}s", "binary", w))
        out.append(TargetSpec(f"exit_signal_{w}s", "binary", w))
        out.append(TargetSpec(f"max_upside_pe_{w}s", "regression", w))
        out.append(TargetSpec(f"max_drawdown_pe_{w}s", "regression", w))
    return tuple(out)


MVP_TARGETS: tuple[TargetSpec, ...] = _build_mvp_targets()


# ── Convenience views on MVP_TARGETS for callers ──────────────────────────

MVP_TARGET_NAMES: tuple[str, ...] = tuple(t.name for t in MVP_TARGETS)
"""Just the names, in canonical iteration order. Used by SEA model_loader."""


MVP_TARGET_OBJECTIVES: dict[str, str] = {t.name: t.target_type for t in MVP_TARGETS}
"""{name: 'binary' | 'regression'} — used by MTA trainer to pick LGBM_PARAMS."""


# ── Self-validation at import time ────────────────────────────────────────

# Fail-fast guards: if anyone edits this file and breaks the 12×5 = 60
# invariant, the import explodes immediately rather than letting the
# trainer/loader run with a malformed target set.
assert len(MVP_TARGETS) == 60, f"MVP_TARGETS must be 60, got {len(MVP_TARGETS)}"
assert len(set(MVP_TARGET_NAMES)) == 60, "MVP_TARGETS contains duplicates"
assert {t.lookahead_seconds for t in MVP_TARGETS} == set(
    LOOKAHEAD_WINDOWS_SECONDS
), "MVP_TARGETS missing one or more lookahead windows"
