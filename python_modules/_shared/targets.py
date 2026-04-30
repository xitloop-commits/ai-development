"""
_shared.targets — single source of truth for the MVP target set.

Per IMPLEMENTATION_PLAN_v2.md §6 D4 + §7 E9: the MTA model trainer
(`model_training_agent.trainer`) and the SEA model loader
(`signal_engine_agent.model_loader`) both need the same canonical list
of 28 ML targets. Before this module they each kept a private copy and
had silently drifted to 29 entries (an orphan `upside_percentile_30s`
that did not fit the locked 7×4 matrix).

The 28 targets are the cartesian product of:

    7 target types  ×  4 lookahead windows  =  28

Target types (locked Phase D4, MTA Spec §4):
    direction              binary       (was the trade up or down?)
    direction_magnitude    regression   (how much did it move?)
    risk_reward_ratio      regression   (predicted RR if we'd taken it)
    max_upside             regression   (predicted ₹ upside)
    max_drawdown           regression   (predicted ₹ downside)
    total_premium_decay    regression   (theta-burn over the window)
    avg_decay_per_strike   regression   (premium decay normalised per-strike)

Lookahead windows (locked Phase D4):
    30s   — fast direction signal
    60s   — confirmation
    300s  — 5-minute swing (TP/SL anchor)
    900s  — 15-minute swing (main trading timeframe)

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
LOOKAHEAD_WINDOWS_SECONDS: tuple[int, ...] = (30, 60, 300, 900)


def _build_mvp_targets() -> tuple[TargetSpec, ...]:
    """Build the 7×4 = 28 MVP target list deterministically.

    Built once at import time. The naming convention is intentionally
    not regular across the seven types (direction uses an inline
    suffix, magnitudes have a `_magnitude` tail) — preserved verbatim
    from the previous trainer + loader copies so no model files need
    renaming on disk.
    """
    out: list[TargetSpec] = []
    for w in LOOKAHEAD_WINDOWS_SECONDS:
        out.append(TargetSpec(f"direction_{w}s",                "binary",     w))
        out.append(TargetSpec(f"direction_{w}s_magnitude",      "regression", w))
        out.append(TargetSpec(f"risk_reward_ratio_{w}s",        "regression", w))
        out.append(TargetSpec(f"max_upside_{w}s",               "regression", w))
        out.append(TargetSpec(f"max_drawdown_{w}s",             "regression", w))
        out.append(TargetSpec(f"total_premium_decay_{w}s",      "regression", w))
        out.append(TargetSpec(f"avg_decay_per_strike_{w}s",     "regression", w))
    return tuple(out)


MVP_TARGETS: tuple[TargetSpec, ...] = _build_mvp_targets()


# ── Convenience views on MVP_TARGETS for callers ──────────────────────────

MVP_TARGET_NAMES: tuple[str, ...] = tuple(t.name for t in MVP_TARGETS)
"""Just the names, in canonical iteration order. Used by SEA model_loader."""


MVP_TARGET_OBJECTIVES: dict[str, str] = {t.name: t.target_type for t in MVP_TARGETS}
"""{name: 'binary' | 'regression'} — used by MTA trainer to pick LGBM_PARAMS."""


# ── Self-validation at import time ────────────────────────────────────────

# Fail-fast guards: if anyone edits this file and breaks the 7×4 = 28
# invariant, the import explodes immediately rather than letting the
# trainer/loader run with a malformed target set.
assert len(MVP_TARGETS) == 28, f"MVP_TARGETS must be 28, got {len(MVP_TARGETS)}"
assert len(set(MVP_TARGET_NAMES)) == 28, "MVP_TARGETS contains duplicates"
assert {t.lookahead_seconds for t in MVP_TARGETS} == set(LOOKAHEAD_WINDOWS_SECONDS), (
    "MVP_TARGETS missing one or more lookahead windows"
)
