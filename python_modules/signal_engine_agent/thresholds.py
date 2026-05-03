"""
thresholds.py — SEA 3-condition gate (Phase E5).

Per Phase D4 (decision committed 2026-04-30) the canonical SEA filter
pipeline is the **3-condition gate**: a tick emits a directional signal
iff all three conditions hold simultaneously.

    C1: prob              ≥ 0.65    (P(direction) confidence floor)
    C2: RR                ≥ 1.5     (predicted risk_reward_ratio_30s)
    C3: upside_percentile ≥ 60      (session-rank floor, 0-100)

where:
    prob              = max(direction_prob_30s, 1 - direction_prob_30s)
    RR                = predictions["risk_reward_ratio_30s"]
    upside_percentile = predictions["upside_percentile_30s"]

If the gate passes, direction is selected by the side of
`direction_prob_30s` relative to 0.5: > 0.5 → GO_CALL, ≤ 0.5 → GO_PUT.

If the gate fails, the returned `SignalAction` has `action = "WAIT"`
and `gate_reasons` lists the failed condition codes (C1_prob / C2_rr /
C3_pct), used downstream to populate `_filtered_signals.log` for
diagnostic review.

This module is pure: no I/O, no LTP wiring inside `decide_action` itself
beyond the optional `ce_ltp` / `pe_ltp` arguments used to derive entry
TP/SL prices. Per-instrument thresholds live in JSON under
`config/sea_thresholds/{instrument}.json`; `load_thresholds()` is the
only function that touches the filesystem.

The legacy 4-stage MVP filter (`trade_filter.TradeFilter` + the regime
router formerly in `engine._decide`) is retained behind a CLI
`--filter=legacy` switch in `legacy_filter.py` for one cycle and will
be removed once the gate is validated on a full backtest cycle.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

# ── Defaults locked Phase D4 ──────────────────────────────────────────────
DEFAULT_DIRECTION_PROB_THRESHOLD = 0.65
DEFAULT_MIN_RISK_REWARD = 1.5
DEFAULT_MIN_UPSIDE_PERCENTILE = 60.0


@dataclass(frozen=True)
class Thresholds:
    """Per-instrument gate configuration. Keep field names stable —
    the JSON config file maps directly onto these names via **kwargs."""

    prob_min: float = DEFAULT_DIRECTION_PROB_THRESHOLD
    rr_min: float = DEFAULT_MIN_RISK_REWARD
    upside_percentile_min: float = DEFAULT_MIN_UPSIDE_PERCENTILE


@dataclass
class SignalAction:
    """Output of `decide_action`. `action` is one of:
        LONG_CE   — gate passed, direction_prob > 0.5 (a.k.a. GO_CALL)
        LONG_PE   — gate passed, direction_prob ≤ 0.5 (a.k.a. GO_PUT)
        WAIT      — gate failed (or required predictions missing)

    `direction` mirrors the spec's GO_CALL / GO_PUT / WAIT vocabulary
    so the diagnostic stream stays readable.

    `gate_reasons` is empty on PASS, otherwise a sorted list of failed
    condition codes drawn from `{"C1_prob", "C2_rr", "C3_pct"}`. Always
    populated, even when the action is non-WAIT, so callers can log
    near-miss diagnostics uniformly.
    """

    action: str
    direction: str
    entry: float
    tp: float
    sl: float
    rr: float
    gate_passed: bool
    gate_reasons: list[str] = field(default_factory=list)


def _is_finite(v) -> bool:
    """True iff v is a finite real number. NaN/Inf/None all fail."""
    if v is None:
        return False
    try:
        f = float(v)
    except (TypeError, ValueError):
        return False
    return math.isfinite(f)


def decide_action(
    predictions: Mapping[str, float],
    thresholds: Thresholds = Thresholds(),
    ce_ltp: float | None = None,
    pe_ltp: float | None = None,
) -> SignalAction:
    """Pure 3-condition gate.

    Required keys in `predictions`:
        direction_prob_30s     (P(direction == 1) in [0, 1])
        risk_reward_ratio_30s  (predicted RR, dimensionless)
        upside_percentile_30s  (session-rank in [0, 100])

    Optional keys (used only for entry/TP/SL on a passed signal):
        max_upside_30s       (fallback TP magnitude)
        max_drawdown_30s     (fallback SL magnitude)
        max_upside_300s      (preferred over 30s for TP)
        max_drawdown_300s    (preferred over 30s for SL)
        max_upside_900s      (preferred over 300s for TP — final priority)
        max_drawdown_900s    (preferred over 300s for SL — final priority)

    `ce_ltp` / `pe_ltp` come from the live tick (TFA-emitted ATM strike
    LTPs); they are NOT model outputs and not part of `predictions`.
    Passing None for either side disables the corresponding trade leg
    (you can still pass the gate but `entry/tp/sl/rr` will be 0 on
    that side, signalling no executable trade).

    Returns a fully-populated `SignalAction`; never raises.
    """
    dir_prob = predictions.get("direction_prob_30s")
    rr_pred = predictions.get("risk_reward_ratio_30s")
    pctile = predictions.get("upside_percentile_30s")

    # If any required prediction is missing/NaN we cannot evaluate the
    # gate at all — fail closed (WAIT) with a sentinel reason. This is
    # distinct from "gate evaluated and failed".
    if not (_is_finite(dir_prob) and _is_finite(rr_pred) and _is_finite(pctile)):
        return SignalAction(
            action="WAIT",
            direction="WAIT",
            entry=0.0,
            tp=0.0,
            sl=0.0,
            rr=0.0,
            gate_passed=False,
            gate_reasons=["MISSING_PREDICTION"],
        )

    dir_prob = float(dir_prob)
    rr_pred = float(rr_pred)
    pctile = float(pctile)

    # `prob` is the conviction in the chosen side, regardless of which
    # side that is — so the gate is symmetric for GO_CALL and GO_PUT.
    prob = max(dir_prob, 1.0 - dir_prob)

    reasons: list[str] = []
    if prob < thresholds.prob_min:
        reasons.append("C1_prob")
    if rr_pred < thresholds.rr_min:
        reasons.append("C2_rr")
    if pctile < thresholds.upside_percentile_min:
        reasons.append("C3_pct")

    if reasons:
        return SignalAction(
            action="WAIT",
            direction="WAIT",
            entry=0.0,
            tp=0.0,
            sl=0.0,
            rr=0.0,
            gate_passed=False,
            gate_reasons=reasons,
        )

    # Gate passed — pick side. Edge case: dir_prob == 0.5 falls to PUT,
    # which is consistent with the SEA spec's `> 0.5` / `≤ 0.5` split.
    is_call = dir_prob > 0.5
    direction = "GO_CALL" if is_call else "GO_PUT"
    action = "LONG_CE" if is_call else "LONG_PE"
    leg_ltp = ce_ltp if is_call else pe_ltp

    # Build TP/SL using the longest swing window with a finite prediction;
    # fall back through 300s → 30s. Magnitudes are signed in the model
    # output (drawdown is negative) but TP/SL distances must be absolute.
    up_pred = _first_finite(predictions, ("max_upside_900s", "max_upside_300s", "max_upside_30s"))
    dn_pred = _first_finite(
        predictions, ("max_drawdown_900s", "max_drawdown_300s", "max_drawdown_30s")
    )

    if (
        not _is_finite(leg_ltp)
        or leg_ltp is None
        or leg_ltp <= 0
        or up_pred is None
        or dn_pred is None
    ):
        # Gate passed but we cannot price the trade. Caller still gets
        # gate_passed=True so it can log the near-miss; entry/TP/SL=0
        # signals "no executable trade".
        return SignalAction(
            action="WAIT",
            direction=direction,
            entry=0.0,
            tp=0.0,
            sl=0.0,
            rr=0.0,
            gate_passed=True,
            gate_reasons=[],
        )

    leg_ltp_f = float(leg_ltp)
    tp_dist = abs(up_pred)
    sl_dist = abs(dn_pred)
    entry = leg_ltp_f
    tp = leg_ltp_f + tp_dist
    sl = leg_ltp_f - sl_dist
    actual_rr = round(tp_dist / sl_dist, 2) if sl_dist > 0 else 0.0

    return SignalAction(
        action=action,
        direction=direction,
        entry=round(entry, 2),
        tp=round(tp, 2),
        sl=round(sl, 2),
        rr=actual_rr,
        gate_passed=True,
        gate_reasons=[],
    )


def _first_finite(predictions: Mapping[str, float], keys: tuple[str, ...]) -> float | None:
    """Return the first finite prediction in `keys` order, or None."""
    for k in keys:
        v = predictions.get(k)
        if _is_finite(v):
            return float(v)
    return None


# ── Per-instrument config loader ──────────────────────────────────────────


def load_thresholds(
    instrument: str,
    config_dir: Path = Path("config/sea_thresholds"),
) -> Thresholds:
    """Load `<config_dir>/<instrument>.json`, falling back to `default.json`
    if no instrument-specific file exists. Both must be valid JSON
    objects whose keys match `Thresholds` field names.

    Raises FileNotFoundError if neither file exists — callers should not
    silently run with hardcoded defaults; the project ships default.json.
    """
    inst_path = config_dir / f"{instrument}.json"
    default_path = config_dir / "default.json"
    path = inst_path if inst_path.exists() else default_path
    if not path.exists():
        raise FileNotFoundError(
            f"No SEA thresholds config found.\n"
            f"  Looked for: {inst_path}\n"
            f"  And:        {default_path}\n"
            f"  Ship a default.json with prob_min/rr_min/upside_percentile_min."
        )
    raw = json.loads(path.read_text(encoding="utf-8"))
    return Thresholds(**raw)
