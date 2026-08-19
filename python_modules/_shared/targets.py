"""
_shared.targets — single source of truth for the MVP target set.

The MTA model trainer (`model_training_agent.trainer`) and the SEA model
loader (`signal_engine_agent.model_loader`) both need the same canonical
list of ML targets. Before this module they each kept private copies that
silently drifted.

T166 (2026-08-19) — Nifty/Bank 3-cohort option-premium retrain
-------------------------------------------------------------
The head set is now OPTION-PREMIUM ONLY across four forward windows. The old
spot-based trend/swing layers (900/1800/3600/7200s on the SPOT series) are
RETIRED — every head predicts an option-leg (CE/PE) premium move.

    52 heads per instrument = 13 target types x 4 windows (60/300/600/900s)

Window -> trading cohort (see signal_engine_agent/cohort.py):

    60s   -> scalp   (crude/natgas `wave1` gate reads this; unused by indices,
                      retained so MCX behaviour is 100% unchanged)
    300s  -> scalp   (Nifty/Bank 5-min cohort)
    600s  -> trend   (Nifty/Bank 10-min cohort — NEW, never trained before)
    900s  -> swing   (Nifty/Bank 15-min cohort)

The `head_type` field is now "scalp" for EVERY head (all option-premium label
semantics). The *trading* cohort (scalp/trend/swing) is derived from the
forward window by `cohort.classify_window_seconds`, NOT from `head_type`.

Deploy note: the SEA model loader silently skips heads whose `.lgbm` is not on
disk, so shipping this registry ahead of the retrain is safe — crude/natgas
keep loading their surviving 60s/300s heads (their `wave1` gate reads only
60s), and the new 600s/900s heads stay absent (nan) until the first retrain
produces them. The matching `config/instrument_profiles/*.json`
`target_windows_sec` edit ([60,300,600,900]) must land WITH that retrain, not
before it — it changes the live feature schema.

Each `TargetSpec` carries a `head_type` (currently always "scalp") so callers
can still route per-layer logic (calibration grouping, SHAP) without name
parsing.

Target types (option-leg, locked Phase D4 + Wave 2 + Part B):
    direction              binary       (was the trade up or down?)
    direction_magnitude    regression   (how much did it move?)
    direction_persists     binary       (did direction hold — no intra-flip?)
    risk_reward_ratio      regression   (predicted RR, CE-leg)
    risk_reward_ratio_pe   regression   (predicted RR, PE-leg — Part B)
    max_upside             regression   (predicted rupee upside, CE-leg)
    max_drawdown           regression   (predicted rupee downside, CE-leg)
    max_upside_pe          regression   (predicted rupee upside, PE-leg)
    max_drawdown_pe        regression   (predicted rupee downside, PE-leg)
    total_premium_decay    regression   (theta-burn over the window)
    avg_decay_per_strike   regression   (premium decay normalised per-strike)
    breakout_in            binary       (did spot cross day_high/low in window?)
    exit_signal            binary       (should an open position close —
                                         direction flip OR drawdown > 1%?)

Naming convention:
    direction         -> `direction_{Ws}` (e.g. `direction_300s`)
    direction-mag     -> `direction_{Ws}_magnitude`
    everything else   -> `{type}_{Ws}` (e.g. `max_upside_300s`)

Scalp names are preserved verbatim from prior copies so existing .lgbm
artifacts for the 60s/300s windows keep loading; 600s is a brand-new window.

`upside_percentile_{w}s` is a TFA-emitted live feature column (session-rank of
`max_upside_{w}s`); it stays in the feature schema but is NOT a trained head.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class TargetSpec:
    """One row of the target matrix.

    Fields:
        name              the .lgbm filename root + the metrics.json key
        target_type       LightGBM objective family (binary / regression)
        lookahead_seconds the forward window this target predicts
        head_type         label-semantics layer. Now always "scalp" (all heads
                          are option-leg / option-premium). Kept for backward
                          compatibility with per-layer routing callers.
    """

    name: str
    target_type: Literal["binary", "regression"]
    lookahead_seconds: int
    head_type: Literal["scalp", "trend", "swing"] = "scalp"


# Forward-looking option-premium windows (T166, 2026-08-19).
#   60s  — crude/natgas `wave1` gate; retained so MCX behaviour is unchanged.
#   300s — Nifty/Bank scalp cohort (5 min).
#   600s — Nifty/Bank trend cohort (10 min) — NEW, never trained before.
#   900s — Nifty/Bank swing cohort (15 min).
# Ordered shortest -> longest for stable trainer/loader iteration order.
# MUST equal `target_windows_sec` in every config/instrument_profiles/*.json
# at retrain time (they build, respectively, the head list and the parquet
# columns the trainer reads).
LOOKAHEAD_WINDOWS_SECONDS: tuple[int, ...] = (60, 300, 600, 900)

# The 13 option-leg target types, one set per window. Order preserved from the
# prior scalp layer so existing .lgbm iteration order / filenames are stable.
# The "direction_magnitude" entry is written with the irregular inline suffix
# `direction_{w}s_magnitude` (see _build_mvp_targets); every other type uses
# the regular `{type}_{w}s` tail.
_SCALP_TYPES: tuple[tuple[str, Literal["binary", "regression"]], ...] = (
    ("direction",            "binary"),
    ("direction_magnitude",  "regression"),
    ("risk_reward_ratio",    "regression"),
    ("max_upside",           "regression"),
    ("max_drawdown",         "regression"),
    ("total_premium_decay",  "regression"),
    ("avg_decay_per_strike", "regression"),
    ("direction_persists",   "binary"),
    ("breakout_in",          "binary"),
    ("exit_signal",          "binary"),
    ("max_upside_pe",        "regression"),
    ("max_drawdown_pe",      "regression"),
    ("risk_reward_ratio_pe", "regression"),
)

# How many target types per window — used by the self-validation guard below.
_TYPES_PER_WINDOW = len(_SCALP_TYPES)


def _build_mvp_targets() -> tuple[TargetSpec, ...]:
    """Build the 52-head option-premium target list deterministically.

    Built once at import time. `direction` uses an inline `_magnitude` suffix
    (`direction_{w}s_magnitude`) rather than a regular `_magnitude_{w}s` tail —
    preserved verbatim from previous loader copies so existing scalp .lgbm
    files retain their naming.
    """
    out: list[TargetSpec] = []
    for w in LOOKAHEAD_WINDOWS_SECONDS:
        for type_name, obj in _SCALP_TYPES:
            if type_name == "direction_magnitude":
                name = f"direction_{w}s_magnitude"
            else:
                name = f"{type_name}_{w}s"
            out.append(TargetSpec(name, obj, w, "scalp"))
    return tuple(out)


MVP_TARGETS: tuple[TargetSpec, ...] = _build_mvp_targets()


# ── Convenience views on MVP_TARGETS for callers ──────────────────────────

MVP_TARGET_NAMES: tuple[str, ...] = tuple(t.name for t in MVP_TARGETS)
"""Just the names, in canonical iteration order. Used by SEA model_loader."""


MVP_TARGET_OBJECTIVES: dict[str, str] = {t.name: t.target_type for t in MVP_TARGETS}
"""{name: 'binary' | 'regression'} — used by MTA trainer to pick LGBM_PARAMS."""


MVP_TARGET_HEAD_TYPES: dict[str, str] = {t.name: t.head_type for t in MVP_TARGETS}
"""{name: 'scalp'} — every head is option-premium now. Kept for per-layer
routing callers (calibration grouping, SHAP-by-layer); the trading cohort
(scalp/trend/swing) is derived from the window, not this field."""


# ── Self-validation at import time ────────────────────────────────────────

# Fail-fast guards: if anyone edits this file and breaks the option-premium
# head invariant (13 types x 4 windows = 52, all scalp), the import explodes
# immediately rather than letting the trainer/loader run with a malformed set.
_EXPECTED_HEADS = len(LOOKAHEAD_WINDOWS_SECONDS) * _TYPES_PER_WINDOW  # 4 x 13 = 52
assert len(MVP_TARGETS) == _EXPECTED_HEADS, (
    f"MVP_TARGETS must be {_EXPECTED_HEADS}, got {len(MVP_TARGETS)}"
)
assert len(set(MVP_TARGET_NAMES)) == _EXPECTED_HEADS, "MVP_TARGETS contains duplicates"

# Every head is option-premium ("scalp") now.
assert all(t.head_type == "scalp" for t in MVP_TARGETS), (
    "T166: every head must be option-premium (head_type 'scalp')"
)

# Each window carries exactly the 13 option-leg types.
_by_window: dict[int, int] = {}
for _t in MVP_TARGETS:
    _by_window[_t.lookahead_seconds] = _by_window.get(_t.lookahead_seconds, 0) + 1
assert set(_by_window) == set(LOOKAHEAD_WINDOWS_SECONDS), (
    f"window mismatch: {set(_by_window)} vs {set(LOOKAHEAD_WINDOWS_SECONDS)}"
)
assert all(n == _TYPES_PER_WINDOW for n in _by_window.values()), (
    f"each window must have {_TYPES_PER_WINDOW} types, got {_by_window}"
)
