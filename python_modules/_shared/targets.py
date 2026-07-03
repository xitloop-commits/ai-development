"""
_shared.targets — single source of truth for the MVP target set.

Per IMPLEMENTATION_PLAN_v2.md §6 D4 + §7 E9 (Wave 2 lock May 11 2026) and
V2_MASTER_SPEC §2.2 D55 (trend+swing addition lock May 17 2026): the MTA
model trainer (`model_training_agent.trainer`) and the SEA model loader
(`signal_engine_agent.model_loader`) both need the same canonical list
of 84 ML targets. Before this module they each kept private copies that
silently drifted.

The 88 targets per instrument:

    60 scalp  =  12 target types × 5 windows (60/120/180/240/300s)
    14 trend  =   7 target types × 2 windows (900/1800s)        ← D55 + Part B
    14 swing  =   7 target types × 2 windows (3600/7200s)       ← D55 + Part B
    ────────────────────────────────────────────────
    88 heads total  (Part B 2026-07-02 added direction_down to trend + swing)

Each `TargetSpec` carries a `head_type ∈ {scalp, trend, swing}` so
callers can route per-layer logic (gate selection, isotonic calibration,
SHAP grouping) without name-pattern parsing.

Scalp target types (locked Phase D4 + Wave 2):
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

Trend + swing target types (V2_MASTER_SPEC §2.2.2 D75 — added 2026-05-17):
    direction              binary       (spot move clears noise floor up?)
    magnitude              regression   (signed spot(t+w) − spot(t))
    max_excursion          regression   (best upward move in window)
    max_drawdown           regression   (worst dip in window)
    continues              binary       (direction at t+w matches dominant
                                         direction over [t-300s, t])
    breakout_imminent      binary       (max excursion ≥ noise_floor × scale;
                                         scale=3 for trend, 6 for swing)

Trend / swing names MUST match the columns written by
`tick_feature_agent.features.trend_swing_targets` to parquet — pattern
`{trend|swing}_{type}_{w}s`. Both modules ultimately agree on this set
via column-name string match at parquet load time, so any drift here
breaks training silently.

`upside_percentile_30s` is a TFA-emitted live feature column (computed
session-rank of `max_upside_30s`); keeping it in the parquet feature
schema is correct, but training a model to PREDICT it was a leftover
from before the spec lock and is no longer in scope.

Naming convention:
    scalp direction         → `direction_{Ws}` (e.g. `direction_60s`)
    scalp direction-mag     → `direction_{Ws}_magnitude`
    scalp regression        → `{type}_{Ws}` (e.g. `max_upside_60s`)
    trend/swing             → `{layer}_{type}_{Ws}` (e.g. `trend_magnitude_900s`)

Scalp names preserved verbatim from prior copies so existing .lgbm
artifacts on disk keep loading.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class TargetSpec:
    """One row of the 88-head target matrix.

    Fields:
        name              the .lgbm filename root + the metrics.json key
        target_type       LightGBM objective family (binary / regression)
        lookahead_seconds the window this target predicts forward
        head_type         which layer this head belongs to — scalp (option-leg,
                          60s-300s), trend (spot, 900s/1800s), swing (spot,
                          3600s/7200s). Defaulted to "scalp" so existing
                          positional constructors keep working.
    """

    name: str
    target_type: Literal["binary", "regression"]
    lookahead_seconds: int
    head_type: Literal["scalp", "trend", "swing"] = "scalp"


# Scalp lookahead windows — keep this tuple ordered shortest → longest for
# stable iteration order in trainer logs / loader output.
#
# Wave 2 (May 11 2026): drop 30s (below 1m persistence floor) and 900s
# (long-horizon direction models flat on commodities — see Wave 1
# benchmark report). Add 120/180/240 to densely cover the 1m–5m range
# where the user wants signals to persist.
LOOKAHEAD_WINDOWS_SECONDS: tuple[int, ...] = (60, 120, 180, 240, 300)

# Trend + swing horizons (V2_MASTER_SPEC §2.2.1 / D55, locked 2026-05-17).
# Must match `tick_feature_agent.features.trend_swing_targets.{TREND,SWING}_HORIZONS_SEC`
# — both sides agree on the parquet column-name pattern `{layer}_{type}_{w}s`.
TREND_HORIZONS_SEC: tuple[int, ...] = (900, 1800)
SWING_HORIZONS_SEC: tuple[int, ...] = (3600, 7200)

# Trend + swing target types (7 per horizon — V2_MASTER_SPEC §2.2.2 + Part B).
# Listed in the same order as `trend_swing_target_column_names()` writes them
# to parquet so trainer iteration order matches column order.
_TREND_SWING_TYPES: tuple[tuple[str, Literal["binary", "regression"]], ...] = (
    ("direction",         "binary"),
    # Part B (2026-07-02): mirror of `direction` for the DOWN leg. `direction`
    # is up-only (1 iff move > +noise_floor), so a low value means "not up"
    # (flat OR down) — it can't call a down-leg. `direction_down` is the
    # symmetric 1-iff-(move < −noise_floor) head, letting the trend gate fire
    # puts on genuine down-legs instead of guessing from (1 − up_prob).
    ("direction_down",    "binary"),
    ("magnitude",         "regression"),
    ("max_excursion",     "regression"),
    ("max_drawdown",      "regression"),
    ("continues",         "binary"),
    ("breakout_imminent", "binary"),
)


def _build_mvp_targets() -> tuple[TargetSpec, ...]:
    """Build the 88-head target list deterministically.

    Built once at import time. The naming convention is intentionally
    irregular within scalp (direction uses an inline `_magnitude` suffix
    rather than a regular `_magnitude_{w}s` tail) — preserved verbatim
    from previous loader copies so existing scalp .lgbm files retain
    naming. Trend / swing names follow the regular `{layer}_{type}_{w}s`
    pattern that matches the parquet columns written by
    `tick_feature_agent.features.trend_swing_targets`.
    """
    out: list[TargetSpec] = []

    # ── Scalp: 60 heads (12 types × 5 windows) ──────────────────────────
    for w in LOOKAHEAD_WINDOWS_SECONDS:
        # Original 7 (CE-leg only)
        out.append(TargetSpec(f"direction_{w}s", "binary", w, "scalp"))
        out.append(TargetSpec(f"direction_{w}s_magnitude", "regression", w, "scalp"))
        out.append(TargetSpec(f"risk_reward_ratio_{w}s", "regression", w, "scalp"))
        out.append(TargetSpec(f"max_upside_{w}s", "regression", w, "scalp"))
        out.append(TargetSpec(f"max_drawdown_{w}s", "regression", w, "scalp"))
        out.append(TargetSpec(f"total_premium_decay_{w}s", "regression", w, "scalp"))
        out.append(TargetSpec(f"avg_decay_per_strike_{w}s", "regression", w, "scalp"))
        # Wave 2 additions (5 new types)
        out.append(TargetSpec(f"direction_persists_{w}s", "binary", w, "scalp"))
        out.append(TargetSpec(f"breakout_in_{w}s", "binary", w, "scalp"))
        out.append(TargetSpec(f"exit_signal_{w}s", "binary", w, "scalp"))
        out.append(TargetSpec(f"max_upside_pe_{w}s", "regression", w, "scalp"))
        out.append(TargetSpec(f"max_drawdown_pe_{w}s", "regression", w, "scalp"))

    # ── Trend: 14 heads (7 types × 2 horizons, on SPOT not option leg) ──
    for w in TREND_HORIZONS_SEC:
        for type_name, obj in _TREND_SWING_TYPES:
            out.append(TargetSpec(f"trend_{type_name}_{w}s", obj, w, "trend"))

    # ── Swing: 14 heads (7 types × 2 horizons, on SPOT not option leg) ──
    for w in SWING_HORIZONS_SEC:
        for type_name, obj in _TREND_SWING_TYPES:
            out.append(TargetSpec(f"swing_{type_name}_{w}s", obj, w, "swing"))

    return tuple(out)


MVP_TARGETS: tuple[TargetSpec, ...] = _build_mvp_targets()


# ── Convenience views on MVP_TARGETS for callers ──────────────────────────

MVP_TARGET_NAMES: tuple[str, ...] = tuple(t.name for t in MVP_TARGETS)
"""Just the names, in canonical iteration order. Used by SEA model_loader."""


MVP_TARGET_OBJECTIVES: dict[str, str] = {t.name: t.target_type for t in MVP_TARGETS}
"""{name: 'binary' | 'regression'} — used by MTA trainer to pick LGBM_PARAMS."""


MVP_TARGET_HEAD_TYPES: dict[str, str] = {t.name: t.head_type for t in MVP_TARGETS}
"""{name: 'scalp' | 'trend' | 'swing'} — for per-layer routing (T29 gates,
T25 calibration grouping, T34 SHAP-by-layer reports)."""


# ── Self-validation at import time ────────────────────────────────────────

# Fail-fast guards: if anyone edits this file and breaks the 88-head
# invariant (60 scalp + 14 trend + 14 swing — Part B added direction_down
# to trend + swing, 2026-07-02), the import explodes immediately rather
# than letting the trainer/loader run with a malformed target set.
assert len(MVP_TARGETS) == 88, f"MVP_TARGETS must be 88, got {len(MVP_TARGETS)}"
assert len(set(MVP_TARGET_NAMES)) == 88, "MVP_TARGETS contains duplicates"

# Per-layer window coverage
_scalp_windows = {t.lookahead_seconds for t in MVP_TARGETS if t.head_type == "scalp"}
assert _scalp_windows == set(LOOKAHEAD_WINDOWS_SECONDS), (
    f"scalp window mismatch: {_scalp_windows} vs {set(LOOKAHEAD_WINDOWS_SECONDS)}"
)
_trend_windows = {t.lookahead_seconds for t in MVP_TARGETS if t.head_type == "trend"}
assert _trend_windows == set(TREND_HORIZONS_SEC), (
    f"trend window mismatch: {_trend_windows} vs {set(TREND_HORIZONS_SEC)}"
)
_swing_windows = {t.lookahead_seconds for t in MVP_TARGETS if t.head_type == "swing"}
assert _swing_windows == set(SWING_HORIZONS_SEC), (
    f"swing window mismatch: {_swing_windows} vs {set(SWING_HORIZONS_SEC)}"
)

# Head-type distribution
_by_layer = {
    ht: sum(1 for t in MVP_TARGETS if t.head_type == ht)
    for ht in ("scalp", "trend", "swing")
}
assert _by_layer == {"scalp": 60, "trend": 14, "swing": 14}, (
    f"head_type distribution wrong: {_by_layer}"
)
