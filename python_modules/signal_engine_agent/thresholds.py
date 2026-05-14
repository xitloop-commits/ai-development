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
    # The `max_upside_*` / `max_drawdown_*` models are trained on CE-leg LTP
    # swings only (see tick_feature_agent/features/targets.py). For LONG_PE,
    # the directional sense inverts: an underlying down-move makes CE drop
    # AND PE rise, so the CE-drawdown magnitude is the PE-upside (TP) and
    # the CE-upside magnitude is the PE-downside (SL). For LONG_CE the model
    # already speaks for the leg being traded, so use the magnitudes as-is.
    if is_call:
        tp_dist = abs(up_pred)
        sl_dist = abs(dn_pred)
    else:
        tp_dist = abs(dn_pred)
        sl_dist = abs(up_pred)
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


@dataclass(frozen=True)
class V2Thresholds:
    """Wave 1 deterministic-gate add-on thresholds.

    Layered on top of the existing 3-condition gate. All deterministic —
    no model dependency on the new fields, so works across all instruments
    without retraining.
    """

    # C5: minimum momentum_persistence_ticks (TFA-emitted, capped at 20)
    momentum_persistence_min: int = 5
    # C6: skip LONG_CE if within this many percent of day high (resistance)
    sr_clearance_pct: float = 0.05
    # C4 forbidden regimes — entries blocked when regime ∈ this set
    forbidden_regimes: tuple[str, ...] = ("REVERSAL",)


def decide_action_v2(
    predictions: Mapping[str, float],
    thresholds: Thresholds = Thresholds(),
    v2_thresholds: V2Thresholds = V2Thresholds(),
    ce_ltp: float | None = None,
    pe_ltp: float | None = None,
    *,
    regime: str | None = None,
    momentum_persistence_ticks: float | None = None,
    distance_to_day_high_pct: float | None = None,
    distance_to_day_low_pct: float | None = None,
) -> SignalAction:
    """Wave 1 gate: existing 3 conditions + 3 deterministic conditions.

    Adds on top of `decide_action`:
        C4: regime not in forbidden set (skip REVERSAL)
        C5: momentum_persistence_ticks >= threshold (direction has held)
        C6: S/R clearance — skip LONG_CE near day high; LONG_PE near day low

    All new conditions are NaN-tolerant: missing values fail-open (don't
    block the trade), so the gate degrades gracefully when TFA hasn't
    populated the new feature columns yet.

    Returns a fully-populated SignalAction; never raises.
    """
    base = decide_action(predictions, thresholds, ce_ltp=ce_ltp, pe_ltp=pe_ltp)
    if not base.gate_passed:
        return base

    extra: list[str] = []

    # C4 — regime check
    if regime is not None and regime in v2_thresholds.forbidden_regimes:
        extra.append("C4_regime")

    # C5 — momentum persistence
    if momentum_persistence_ticks is not None and _is_finite(momentum_persistence_ticks):
        if float(momentum_persistence_ticks) < v2_thresholds.momentum_persistence_min:
            extra.append("C5_momentum")

    # C6 — S/R clearance.
    # distance_to_day_high_pct: negative when below high, ~0 at high, positive above.
    # For LONG_CE near day high → reject.
    # For LONG_PE near day low → reject (use distance_to_day_low_pct similarly).
    is_call = base.action == "LONG_CE"
    is_put = base.action == "LONG_PE"
    if is_call and _is_finite(distance_to_day_high_pct):
        # within `sr_clearance_pct` of high (≥ -clearance, since it's negative when below)
        if float(distance_to_day_high_pct) >= -v2_thresholds.sr_clearance_pct:
            extra.append("C6_sr_resistance")
    if is_put and _is_finite(distance_to_day_low_pct):
        # within clearance of low: distance is positive when above; small positive = near low
        if float(distance_to_day_low_pct) <= v2_thresholds.sr_clearance_pct:
            extra.append("C6_sr_support")

    if extra:
        return SignalAction(
            action="WAIT",
            direction=base.direction,  # preserve "would-be" direction for diagnostic
            entry=0.0,
            tp=0.0,
            sl=0.0,
            rr=0.0,
            gate_passed=False,
            gate_reasons=base.gate_reasons + extra,
        )

    return base


# ══════════════════════════════════════════════════════════════════════════════
# Wave 2 — model-driven gate
# ══════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class Wave2Thresholds:
    """Wave 2 model-driven gate configuration.

    Replaces Wave 1's deterministic regime / momentum_persistence / S/R rules
    with direct consumption of the new model predictions:
      - direction_persists_*  — model says direction holds throughout window
      - exit_signal_*         — model says position would close in window
      - max_upside_pe_*       — accurate PE-leg upside (replaces first-order swap)
      - max_drawdown_pe_*     — accurate PE-leg downside

    The base 3-condition gate (prob/RR/pctile) still runs first as a coarse
    filter. Wave 2 adds 3 conditions on top.
    """

    # W1: persistence at 60s — "will direction hold for at least 1 minute?"
    persists_60s_min: float = 0.60
    # W2: persistence at 300s — "will direction hold for 5 minutes?"
    persists_300s_min: float = 0.50
    # W3: exit-signal probability cap — entry blocked if model says we'd
    # likely close the position within 60s anyway
    exit_signal_60s_max: float = 0.40


def decide_action_wave2(
    predictions: Mapping[str, float],
    thresholds: Thresholds = Thresholds(),
    wave2_thresholds: Wave2Thresholds = Wave2Thresholds(),
    ce_ltp: float | None = None,
    pe_ltp: float | None = None,
) -> SignalAction:
    """Wave 2 model-driven gate.

    Required predictions:
        direction_prob_60s, risk_reward_ratio_60s, upside_percentile_60s
            (base 3-condition gate — windows shifted from 30s → 60s per
             Wave 2 spec; 30s window was dropped)
        direction_persists_60s    — P(direction holds throughout 60s)
        direction_persists_300s   — P(direction holds throughout 5 min)
        exit_signal_60s           — P(position would close within 60s)

    Optional predictions (used for TP/SL when present):
        max_upside_{60s,120s,180s,240s,300s}        — CE-leg upside
        max_drawdown_{60s,120s,180s,240s,300s}      — CE-leg drawdown
        max_upside_pe_{60s,...,300s}                — PE-leg upside (Wave 2)
        max_drawdown_pe_{60s,...,300s}              — PE-leg drawdown (Wave 2)

    Returns a fully-populated SignalAction; never raises. Reasons codes:
        C1_prob, C2_rr, C3_pct       — base 3-cond failures
        MISSING_PREDICTION           — base input missing/NaN
        W1_persists_60s              — direction won't hold 1 min
        W2_persists_300s             — direction won't hold 5 min
        W3_exit_signal               — model says we'd exit shortly
    """
    # ── Base 3-cond gate on 60s window (was 30s pre-Wave-2) ─────────────────
    dir_prob = predictions.get("direction_prob_60s")
    rr_pred = predictions.get("risk_reward_ratio_60s")
    pctile = predictions.get("upside_percentile_60s")

    if not (_is_finite(dir_prob) and _is_finite(rr_pred) and _is_finite(pctile)):
        return SignalAction(
            action="WAIT", direction="WAIT",
            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
            gate_passed=False, gate_reasons=["MISSING_PREDICTION"],
        )

    dir_prob_f = float(dir_prob)
    rr_pred_f = float(rr_pred)
    pctile_f = float(pctile)
    prob = max(dir_prob_f, 1.0 - dir_prob_f)

    reasons: list[str] = []
    if prob < thresholds.prob_min:
        reasons.append("C1_prob")
    if rr_pred_f < thresholds.rr_min:
        reasons.append("C2_rr")
    if pctile_f < thresholds.upside_percentile_min:
        reasons.append("C3_pct")

    # ── Wave 2 conditions ───────────────────────────────────────────────────
    persists_60 = predictions.get("direction_persists_60s")
    persists_300 = predictions.get("direction_persists_300s")
    exit_60 = predictions.get("exit_signal_60s")

    if _is_finite(persists_60) and float(persists_60) < wave2_thresholds.persists_60s_min:
        reasons.append("W1_persists_60s")
    if _is_finite(persists_300) and float(persists_300) < wave2_thresholds.persists_300s_min:
        reasons.append("W2_persists_300s")
    if _is_finite(exit_60) and float(exit_60) > wave2_thresholds.exit_signal_60s_max:
        reasons.append("W3_exit_signal")

    is_call = dir_prob_f > 0.5
    direction = "GO_CALL" if is_call else "GO_PUT"

    if reasons:
        return SignalAction(
            action="WAIT", direction=direction,
            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
            gate_passed=False, gate_reasons=reasons,
        )

    # ── Gate passed — compute entry/TP/SL using per-leg targets ────────────
    action = "LONG_CE" if is_call else "LONG_PE"
    leg_ltp = ce_ltp if is_call else pe_ltp

    # Per-leg upside/drawdown — prefer longest finite window (300s → 60s).
    # CE leg uses CE targets; PE leg uses Wave 2 max_upside_pe / max_drawdown_pe
    # targets directly (no more first-order swap of CE targets).
    if is_call:
        up_pred = _first_finite(predictions, (
            "max_upside_300s", "max_upside_240s", "max_upside_180s",
            "max_upside_120s", "max_upside_60s",
        ))
        dn_pred = _first_finite(predictions, (
            "max_drawdown_300s", "max_drawdown_240s", "max_drawdown_180s",
            "max_drawdown_120s", "max_drawdown_60s",
        ))
    else:
        up_pred = _first_finite(predictions, (
            "max_upside_pe_300s", "max_upside_pe_240s", "max_upside_pe_180s",
            "max_upside_pe_120s", "max_upside_pe_60s",
        ))
        dn_pred = _first_finite(predictions, (
            "max_drawdown_pe_300s", "max_drawdown_pe_240s", "max_drawdown_pe_180s",
            "max_drawdown_pe_120s", "max_drawdown_pe_60s",
        ))

    if (
        not _is_finite(leg_ltp) or leg_ltp is None or leg_ltp <= 0
        or up_pred is None or dn_pred is None
    ):
        return SignalAction(
            action="WAIT", direction=direction,
            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
            gate_passed=True, gate_reasons=[],
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
    """Load `<config_dir>/<instrument>.json`, falling back to `default.json`.
    Returns ONLY the base 3-condition Thresholds (backward-compatible API).
    Use `load_thresholds_v2()` to get the per-instrument V2 add-on too.
    """
    base, _ = load_thresholds_v2(instrument, config_dir)
    return base


def load_thresholds_v2(
    instrument: str,
    config_dir: Path = Path("config/sea_thresholds"),
) -> tuple[Thresholds, V2Thresholds]:
    """Backward-compat 3-tuple loader. Use `load_thresholds_full` for the
    complete tuple including Wave 2 add-on + gate_mode."""
    base, v2, _, _ = load_thresholds_full(instrument, config_dir)
    return base, v2


def load_thresholds_full(
    instrument: str,
    config_dir: Path = Path("config/sea_thresholds"),
) -> tuple[Thresholds, V2Thresholds, Wave2Thresholds, str]:
    """Load `<config_dir>/<instrument>.json`, falling back to `default.json`.

    Schema:
      {
        "prob_min": 0.65, "rr_min": 1.5, "upside_percentile_min": 60.0,
        "gate_mode": "wave2" | "wave1" | "current",   # optional, default "current"
        "v2": {                                       # optional, used iff gate_mode == "wave1"
          "momentum_persistence_min": 5,
          "sr_clearance_pct": 0.05,
          "forbidden_regimes": ["REVERSAL"]
        },
        "wave2": {                                    # optional, used iff gate_mode == "wave2"
          "persists_60s_min": 0.60,
          "persists_300s_min": 0.50,
          "exit_signal_60s_max": 0.40
        }
      }

    Returns (Thresholds, V2Thresholds, Wave2Thresholds, gate_mode).
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
    v2_raw = raw.pop("v2", None)
    wave2_raw = raw.pop("wave2", None)
    gate_mode = raw.pop("gate_mode", "current")
    if gate_mode not in ("current", "wave1", "wave2"):
        raise ValueError(
            f"gate_mode must be 'current', 'wave1', or 'wave2', got {gate_mode!r}"
        )
    base = Thresholds(**raw)

    # V2 add-on
    if v2_raw is None:
        v2 = V2Thresholds()
    else:
        if "forbidden_regimes" in v2_raw and isinstance(v2_raw["forbidden_regimes"], list):
            v2_raw["forbidden_regimes"] = tuple(v2_raw["forbidden_regimes"])
        v2 = V2Thresholds(**v2_raw)

    # Wave 2 add-on
    wave2 = Wave2Thresholds(**wave2_raw) if wave2_raw else Wave2Thresholds()

    return base, v2, wave2, gate_mode
