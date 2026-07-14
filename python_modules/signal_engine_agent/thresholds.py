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
    # NB: empirical retraining (May 2026) showed this target is near-random
    # (val_AUC ≈ 0.57); per-instrument config typically sets this to 0.0 to
    # effectively disable the gate while keeping the field for back-compat.
    persists_300s_min: float = 0.50
    # W3: exit-signal probability cap — entry blocked if model says we'd
    # likely close the position within 60s anyway
    exit_signal_60s_max: float = 0.40
    # W4: breakout-imminent probability floor — only fire when model predicts
    # a directional break (above day high OR below day low) in the next 60s
    # is likely. Added May 2026 to leverage the AUC-0.95 breakout_in_60s head
    # the original Wave 2 gate ignored. Only enforced when prediction is
    # finite, so it's a no-op for legacy / Wave 1 callers.
    breakout_in_60s_min: float = 0.50
    # Magnitude scaling (2026-06-23): the trainer's `max_upside_*` and
    # `max_drawdown_*` regression heads systematically OVER-PREDICT move
    # size — empirical 06-19 banknifty backtest showed avg predicted
    # upside ≈ 2× actual. When TP is set at `entry + max_upside_pred`
    # it lands ~30 pts above current price but actual move only reaches
    # ~15 pts, so TP NEVER hits → trades time out → 0% precision even
    # when DIRECTION is correct 60-70% of the time. This factor scales
    # the predicted magnitude before TP/SL distance computation. Set
    # to 0.5 by default (matches the 2× overshoot). Tune per-instrument
    # via JSON config once observed precision is known.
    magnitude_scale: float = 0.5
    # Leg-aware quality gate (2026-06-25). The base C2 (risk_reward_ratio_60s)
    # and C3 (upside_percentile_60s) conditions are CE/UPSIDE metrics. Applied
    # to BOTH directions they let only calls through — a bearish (PUT) setup
    # scores low on CE upside, so it can never clear C3, even though the
    # direction head is balanced (~50/50). With this on, PUT candidates are
    # judged on the PE leg instead: C2 uses the PE-leg RR from the Wave 2
    # max_upside_pe / max_drawdown_pe heads, and C3 (CE percentile) is skipped
    # for puts (no PE-side percentile head exists yet). Set false to restore the
    # legacy call-only behaviour.
    leg_aware_quality_gate: bool = True
    # Scalp-trend alignment (Part B SEA filter, 2026-07-05). When on, a scalp
    # signal that fights a confident 30-min trend is vetoed (COUNTER_TREND) —
    # the scalp head flip-flops on 60s micro-moves, so only trend-aligned
    # scalps are kept. No-op when the trend is neutral or the trend heads are
    # absent. Applied in the engine after the scalp gate via
    # apply_trend_alignment(). Set false to run the scalp gate unconstrained.
    scalp_trend_align: bool = True
    # Structure-aware TP/SL (Part B SEA rule, 2026-07-06). When on, the model
    # TP/SL (magnitude) is clipped/blended toward real S/R structure (the
    # validated pivot levels + OI walls): TP is CAPPED so it never targets
    # beyond the nearest wall in the trade's favour, and SL is WIDENED (bounded)
    # to sit just beyond the nearest adverse wall so a wick doesn't stop us
    # early. Underlying levels → option premium via the leg delta. No-op when
    # off, when structure/delta inputs are missing, or when the result would be
    # nonsense (RR < structure_min_rr → falls back to the model TP/SL).
    structure_tp_sl: bool = False
    # Buffer placed just beyond the adverse wall for the SL, as a % of spot
    # (converted to premium via |delta|). Keeps the stop off the exact level.
    structure_sl_buffer_pct: float = 0.05
    # Cap on how far structure may WIDEN the SL, as a multiple of the model SL
    # distance. Stops a far wall from creating an absurd stop.
    structure_sl_widen_cap: float = 1.5
    # If the structure-adjusted RR drops below this, discard the structure
    # adjustment and keep the model TP/SL (the wall is too close to be useful).
    structure_min_rr: float = 0.8
    # Option-buildup veto (Part B SEA rule, 2026-07-06). Reads fresh directional
    # buildup by pairing each leg's 5-min OI change with that leg's ATM premium
    # momentum — the premium direction resolves the write-vs-buy ambiguity that
    # OI alone can't. Vetoes a scalp that fights a strong bias (COUNTER_BUILDUP).
    # Only OI-INCREASING states (fresh conviction) vote; unwinding/covering is
    # neutral. Off by default; applied in the engine after the scalp gate.
    buildup_filter: bool = False
    # Min |5-min OI change %| for a leg's buildup to count as "strong".
    buildup_min_oi_change_pct: float = 0.5
    # Min |ATM premium momentum| for the premium direction to count (0 = any).
    buildup_min_premium_mom: float = 0.0


@dataclass(frozen=True)
class StructureContext:
    """Real S/R structure for structure-aware TP/SL (Wave2Thresholds.structure_tp_sl).

    The engine resolves the nearest resistance (above spot) and support (below
    spot) in UNDERLYING price from the live feature row — the validated pivot
    levels + OI walls — and supplies the per-leg deltas so an underlying level
    can be converted to an option-premium target. All fields may be None/NaN;
    the helper degrades to the model TP/SL when so.
    """

    spot: float
    ce_delta: float
    pe_delta: float
    nearest_resistance: float | None  # underlying price strictly above spot
    nearest_support: float | None     # underlying price strictly below spot


def _apply_structure_tp_sl(
    *,
    is_call: bool,
    entry: float,
    delta: float,
    spot: float,
    nearest_resistance: float | None,
    nearest_support: float | None,
    model_tp: float,
    model_sl: float,
    cfg: Wave2Thresholds,
) -> tuple[float, float]:
    """Clip/blend the model TP/SL toward real structure. Pure; never raises.

    The model gives the magnitude (how far a move is realistic); structure
    gives the walls (where price actually stalls). The favourable wall (the one
    the trade profits INTO) caps the TP; the adverse wall widens the SL so a
    wick doesn't stop us early. For a CALL the favourable wall is resistance
    above and the adverse wall is support below; for a PUT (delta<0, premium
    rises as spot FALLS) it's the mirror. Premium at a level L is
    ``entry + delta * (L - spot)`` for both legs. Returns the model values
    unchanged if inputs are unusable or the adjusted RR < cfg.structure_min_rr.
    """
    if not (math.isfinite(delta) and delta != 0.0 and math.isfinite(spot) and spot > 0):
        return model_tp, model_sl

    tp_level = nearest_resistance if is_call else nearest_support
    sl_level = nearest_support if is_call else nearest_resistance

    tp = model_tp
    sl = model_sl

    # TP: cap at the favourable wall (never target beyond it). Only when the
    # wall maps to a premium above entry (correct positive-R direction).
    if tp_level is not None and math.isfinite(tp_level):
        tp_wall = entry + delta * (tp_level - spot)
        if tp_wall > entry:
            tp = min(model_tp, tp_wall)

    # SL: widen toward "just beyond" the adverse wall, bounded by widen_cap so a
    # far wall can't create an absurd stop. Never TIGHTEN (that would add
    # premature stops).
    if sl_level is not None and math.isfinite(sl_level):
        buffer_prem = abs(delta) * (cfg.structure_sl_buffer_pct / 100.0) * spot
        sl_target = entry + delta * (sl_level - spot) - buffer_prem
        model_sl_dist = entry - model_sl
        if sl_target < entry and model_sl_dist > 0:
            max_sl = entry - cfg.structure_sl_widen_cap * model_sl_dist
            sl_candidate = max(sl_target, max_sl)   # cap the widening
            sl = min(model_sl, sl_candidate)         # only widen, never tighten

    # Guardrail: a too-close wall can crush RR — discard structure then.
    sl_dist = entry - sl
    tp_dist = tp - entry
    if sl_dist <= 0 or tp_dist <= 0 or (tp_dist / sl_dist) < cfg.structure_min_rr:
        return model_tp, model_sl

    return tp, sl


def decide_action_wave2(
    predictions: Mapping[str, float],
    thresholds: Thresholds = Thresholds(),
    wave2_thresholds: Wave2Thresholds = Wave2Thresholds(),
    ce_ltp: float | None = None,
    pe_ltp: float | None = None,
    structure: "StructureContext | None" = None,
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
        W4_breakout_in               — no directional break expected in 60s
    """
    # ── Base gate on 60s window (was 30s pre-Wave-2) ────────────────────────
    dir_prob = predictions.get("direction_prob_60s")
    rr_pred = predictions.get("risk_reward_ratio_60s")
    pctile = predictions.get("upside_percentile_60s")

    # Only the CORE inputs (direction + RR) are required. `upside_percentile`
    # is a QUALITY filter (C3), not a core signal — and since the 2026-07 leak
    # fix serves it LAGGED, it is NaN for ~64% of the session (valid only mid-
    # day). Requiring it here turned every warmup/edge row into
    # MISSING_PREDICTION → the gate emitted 0 signals on OOS data. C3 below is
    # applied only when the percentile is actually present.
    if not (_is_finite(dir_prob) and _is_finite(rr_pred)):
        return SignalAction(
            action="WAIT", direction="WAIT",
            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
            gate_passed=False, gate_reasons=["MISSING_PREDICTION"],
        )

    dir_prob_f = float(dir_prob)
    rr_pred_f = float(rr_pred)
    prob = max(dir_prob_f, 1.0 - dir_prob_f)
    is_call = dir_prob_f > 0.5

    # ── Leg-aware quality gate ──────────────────────────────────────────────
    # C3 (upside_percentile_60s) is a CE/UPSIDE session-rank: a bearish (PUT)
    # setup scores low on it, so applying it to both directions blocked EVERY
    # put — the gate emitted calls only, even though the direction head is
    # balanced (~50/50). There is no PE-side percentile head yet, so for a put
    # candidate C3 is skipped (the put is still gated by C1 conviction, C2 RR,
    # and the W-conditions, same as a call). Set leg_aware_quality_gate=false to
    # restore the legacy call-only behaviour.
    enforce_c3 = is_call or not wave2_thresholds.leg_aware_quality_gate

    # Part B (2026-07-05): C2 now uses the leg-appropriate RR — the PE-leg
    # risk_reward_ratio_pe for PUTS (the CE risk_reward_ratio_60s is the wrong
    # leg for a put). Falls back to the CE RR when the PE head is missing
    # (pre-Part-B model), preserving old behaviour.
    rr_gate = rr_pred_f
    if not is_call:
        rr_pe = predictions.get("risk_reward_ratio_pe_60s")
        if _is_finite(rr_pe):
            rr_gate = float(rr_pe)

    reasons: list[str] = []
    if prob < thresholds.prob_min:
        reasons.append("C1_prob")
    if rr_gate < thresholds.rr_min:
        reasons.append("C2_rr")
    if enforce_c3 and _is_finite(pctile) and float(pctile) < thresholds.upside_percentile_min:
        reasons.append("C3_pct")

    # ── Wave 2 conditions ───────────────────────────────────────────────────
    persists_60 = predictions.get("direction_persists_60s")
    persists_300 = predictions.get("direction_persists_300s")
    exit_60 = predictions.get("exit_signal_60s")
    breakout_60 = predictions.get("breakout_in_60s")

    if _is_finite(persists_60) and float(persists_60) < wave2_thresholds.persists_60s_min:
        reasons.append("W1_persists_60s")
    if _is_finite(persists_300) and float(persists_300) < wave2_thresholds.persists_300s_min:
        reasons.append("W2_persists_300s")
    if _is_finite(exit_60) and float(exit_60) > wave2_thresholds.exit_signal_60s_max:
        reasons.append("W3_exit_signal")
    if _is_finite(breakout_60) and float(breakout_60) < wave2_thresholds.breakout_in_60s_min:
        reasons.append("W4_breakout_in")

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
    # 2026-06-23: scale predicted magnitudes before TP/SL placement.
    # See Wave2Thresholds.magnitude_scale docstring for rationale.
    scale = max(0.05, min(2.0, wave2_thresholds.magnitude_scale))
    tp_dist = abs(up_pred) * scale
    sl_dist = abs(dn_pred) * scale
    entry = leg_ltp_f
    tp = leg_ltp_f + tp_dist
    sl = leg_ltp_f - sl_dist

    # Structure-aware TP/SL (2026-07-06): clip TP to the nearest favourable
    # wall and widen SL just beyond the nearest adverse wall. Behind a flag;
    # no-op when off or when the structure context is absent.
    if wave2_thresholds.structure_tp_sl and structure is not None:
        leg_delta = structure.ce_delta if is_call else structure.pe_delta
        tp, sl = _apply_structure_tp_sl(
            is_call=is_call,
            entry=entry,
            delta=leg_delta,
            spot=structure.spot,
            nearest_resistance=structure.nearest_resistance,
            nearest_support=structure.nearest_support,
            model_tp=tp,
            model_sl=sl,
            cfg=wave2_thresholds,
        )

    # RR reflects the FINAL (possibly structure-adjusted) levels.
    final_sl_dist = entry - sl
    final_tp_dist = tp - entry
    actual_rr = round(final_tp_dist / final_sl_dist, 2) if final_sl_dist > 0 else 0.0

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


# ══════════════════════════════════════════════════════════════════════════════
# Scalp-trend alignment (Part B SEA filter, 2026-07-05)
# ══════════════════════════════════════════════════════════════════════════════


def trend_bias(predictions: Mapping[str, float], dir_prob_min: float) -> str:
    """The prevailing 30-min trend direction from the trend heads.

    Returns "up" / "down" / "neutral". Neutral when neither head clears
    `dir_prob_min` (or the heads are absent) — i.e. no trend to align to, so
    the scalp gate should run unconstrained. Needs the Part B down head to be
    meaningful for "down"; without it (pre-Part-B model) only "up"/"neutral"
    are reachable, which is safe (never blocks a scalp put on a stale up head).
    """
    up = predictions.get("trend_direction_1800s")
    down = predictions.get("trend_direction_down_1800s")
    up_ok = _is_finite(up) and float(up) >= dir_prob_min
    down_ok = _is_finite(down) and float(down) >= dir_prob_min
    if up_ok and (not down_ok or float(up) >= float(down)):
        return "up"
    if down_ok:
        return "down"
    return "neutral"


def apply_trend_alignment(
    sig: SignalAction,
    predictions: Mapping[str, float],
    dir_prob_min: float,
    *,
    enabled: bool = True,
) -> SignalAction:
    """Suppress a SCALP signal that fights a confident 30-min trend.

    The scalp gate predicts a 60s move; inside a trend it flip-flops call/put
    on every micro-pullback (73% of 60s moves are below the noise floor). This
    filter keeps only scalps aligned with the trend head's direction:
      trend up   → allow calls, veto puts
      trend down → allow puts, veto calls
      neutral    → allow both (pure scalp, no trend to align to)
    Returns `sig` untouched when disabled, when the signal isn't a scalp
    entry, or when the trend is neutral. A veto returns WAIT/COUNTER_TREND.
    """
    if not enabled or not sig.gate_passed or sig.action not in ("LONG_CE", "LONG_PE"):
        return sig
    bias = trend_bias(predictions, dir_prob_min)
    counter = (
        (sig.action == "LONG_CE" and bias == "down")
        or (sig.action == "LONG_PE" and bias == "up")
    )
    if counter:
        return SignalAction(
            action="WAIT", direction=sig.direction,
            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
            gate_passed=False, gate_reasons=["COUNTER_TREND"],
        )
    return sig


def buildup_bias(predictions: Mapping[str, float], cfg: Wave2Thresholds) -> str:
    """Directional bias for the UNDERLYING from per-leg option BUILDUP.

    Pairs each leg's 5-min OI change with that leg's ATM premium momentum. The
    premium direction resolves the write-vs-buy ambiguity OI alone can't: an OI
    rise with premium RISING is buyers lifting offers (longs); with premium
    FALLING it's writers hitting bids. Only OI-INCREASING states vote (fresh
    conviction); unwinding/covering (OI falling = exits) is neutral.

        call OI↑ & call prem↑ → call long buildup → bullish
        call OI↑ & call prem↓ → call writing      → bearish (resistance)
        put  OI↑ & put  prem↑ → put long buildup   → bearish
        put  OI↑ & put  prem↓ → put writing       → bullish (support)

    `predictions` here is the live feature ROW (buildup inputs are features, not
    model heads). Returns "bullish" / "bearish" / "neutral".
    """
    thr = cfg.buildup_min_oi_change_pct
    pthr = cfg.buildup_min_premium_mom
    bull = bear = 0

    ce_oi = predictions.get("ce_oi_change_5min_pct")
    ce_pm = predictions.get("opt_0_ce_premium_momentum")
    if _is_finite(ce_oi) and float(ce_oi) > thr and _is_finite(ce_pm) and abs(float(ce_pm)) > pthr:
        bull += 1 if float(ce_pm) > 0 else 0
        bear += 1 if float(ce_pm) < 0 else 0

    pe_oi = predictions.get("pe_oi_change_5min_pct")
    pe_pm = predictions.get("opt_0_pe_premium_momentum")
    if _is_finite(pe_oi) and float(pe_oi) > thr and _is_finite(pe_pm) and abs(float(pe_pm)) > pthr:
        bear += 1 if float(pe_pm) > 0 else 0
        bull += 1 if float(pe_pm) < 0 else 0

    if bull > bear:
        return "bullish"
    if bear > bull:
        return "bearish"
    return "neutral"


def apply_buildup_filter(
    sig: SignalAction,
    predictions: Mapping[str, float],
    cfg: Wave2Thresholds,
    *,
    enabled: bool = True,
) -> SignalAction:
    """Suppress a SCALP signal that fights a strong option-buildup bias.

    bullish buildup → allow calls, veto puts
    bearish buildup → allow puts, veto calls
    neutral         → allow both. No-op when disabled, when the signal isn't a
    scalp entry, or when the buildup is neutral. A veto returns
    WAIT/COUNTER_BUILDUP. `predictions` is the live feature row.
    """
    if not enabled or not sig.gate_passed or sig.action not in ("LONG_CE", "LONG_PE"):
        return sig
    bias = buildup_bias(predictions, cfg)
    counter = (
        (sig.action == "LONG_CE" and bias == "bearish")
        or (sig.action == "LONG_PE" and bias == "bullish")
    )
    if counter:
        return SignalAction(
            action="WAIT", direction=sig.direction,
            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
            gate_passed=False, gate_reasons=["COUNTER_BUILDUP"],
        )
    return sig


# ══════════════════════════════════════════════════════════════════════════════
# Trend gate — fires the LONG-HORIZON cohort (~30 min hold)
# (2026-06-22, added on top of the scalp-only Wave 2 stack)
# ══════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class TrendThresholds:
    """Trend-cohort gate configuration. Fires LONG_CE / LONG_PE signals
    tagged `cohort="trend"` driven by the trainer's longer-horizon heads:

      trend_direction_1800s     — P(direction == 1) over 30 minutes
      trend_continues_1800s     — P(trend will hold throughout 30 min)
      trend_breakout_imminent_1800s — P(directional break above day high
                                       or below day low in next 30 min)
      trend_magnitude_1800s     — Predicted move size (used for TP/SL)
      trend_max_drawdown_1800s  — Predicted adverse excursion (SL)

    All thresholds are NaN-tolerant — missing predictions fail-closed
    so the gate degrades gracefully on warmup / partial-recovery rows.

    Tunable in `config/sea_thresholds/<inst>.json` via:
      "trend": {
        "enabled": true,
        "dir_prob_min": 0.60,
        "continues_min": 0.55,
        "breakout_min": 0.0,
        "magnitude_scale": 0.5,
        "min_seconds_between_signals": 600
      }
    """
    # Master switch. Default OFF -- existing callers keep scalp-only
    # behaviour until per-instrument JSON flips this on.
    enabled: bool = False
    # T1: direction confidence on the 30-min horizon. Looser than scalp
    # because longer-horizon heads have lower per-tick AUC.
    dir_prob_min: float = 0.60
    # T2: model says the trend will hold for the full window (not just
    # the next tick). Without this the gate fires on any directional
    # spike that's about to reverse.
    continues_min: float = 0.55
    # T3: optional breakout-imminent filter -- defaults to 0 (off) since
    # trend can also be a mean-reversion play. Set > 0 to require the
    # model's breakout head agrees.
    breakout_min: float = 0.0
    # Same magnitude_scale knob as Wave2 -- the magnitude heads tend to
    # over-predict by ~2x on real data, so half is the empirical default.
    magnitude_scale: float = 0.5
    # Cooldown: SEA emits one trend signal at most every N seconds per
    # instrument. Trend horizon is 30 min, so spamming GO_CALL every
    # tick is meaningless -- the operator wants ONE entry per trend.
    min_seconds_between_signals: int = 600  # 10 min
    # Calls-only guard. Default True for safety / pre-Part-B models whose only
    # direction head is up-only ("big UP vs not" — a low value means flat OR
    # down, not "big down", so puts off it are unreliable). Part B (2026-07-05)
    # added the `trend_direction_down` head (val_auc ~0.63/0.64), so
    # `decide_action_trend` fires puts on genuine down-conviction — set
    # calls_only=false per-instrument (banknifty done) once the down head is
    # validated. Absent-down-head models keep the up-only fallback.
    calls_only: bool = True


def decide_action_trend(
    predictions: Mapping[str, float],
    trend_thresholds: TrendThresholds = TrendThresholds(),
    ce_ltp: float | None = None,
    pe_ltp: float | None = None,
) -> SignalAction:
    """Trend-cohort gate (30-min horizon).

    Required predictions:
        trend_direction_1800s          — P(direction == 1)
        trend_continues_1800s          — P(trend holds)
    Optional:
        trend_breakout_imminent_1800s  — P(breakout within 30 min)
        trend_magnitude_1800s          — Predicted move size for TP
        trend_max_drawdown_1800s       — Predicted drawdown for SL

    Returns a SignalAction with `direction` ∈ {GO_CALL, GO_PUT, WAIT}.
    Caller is responsible for the cohort label and the cooldown
    enforcement (decide_action_trend is pure / stateless).
    """
    if not trend_thresholds.enabled:
        return SignalAction(
            action="WAIT", direction="WAIT",
            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
            gate_passed=False, gate_reasons=["TREND_DISABLED"],
        )

    up_prob = predictions.get("trend_direction_1800s")
    down_prob = predictions.get("trend_direction_down_1800s")
    continues = predictions.get("trend_continues_1800s")
    breakout = predictions.get("trend_breakout_imminent_1800s")

    # Up head + continuation are MANDATORY. Missing → fail-closed.
    if not (_is_finite(up_prob) and _is_finite(continues)):
        return SignalAction(
            action="WAIT", direction="WAIT",
            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
            gate_passed=False, gate_reasons=["MISSING_TREND_PREDICTION"],
        )

    up_prob_f = float(up_prob)
    cont_f = float(continues)

    # Part B (2026-07-05): symmetric direction from the up + down heads.
    # When the down head is present, a PUT fires on genuine DOWN-conviction
    # (P(down) from trend_direction_down, val_auc ~0.63/0.64) — not the up
    # head's inverse (which meant "not up" = flat OR down). Falls back to the
    # old up-only conviction (max(p, 1−p)) when the down head is absent
    # (pre-Part-B model), so old models behave exactly as before.
    if _is_finite(down_prob):
        down_prob_f = float(down_prob)
        is_call = up_prob_f >= down_prob_f
        conviction = up_prob_f if is_call else down_prob_f
    else:
        conviction = max(up_prob_f, 1.0 - up_prob_f)
        is_call = up_prob_f > 0.5
    direction = "GO_CALL" if is_call else "GO_PUT"

    reasons: list[str] = []
    if conviction < trend_thresholds.dir_prob_min:
        reasons.append("T1_dir_prob")
    if cont_f < trend_thresholds.continues_min:
        reasons.append("T2_continues")
    if (
        trend_thresholds.breakout_min > 0
        and _is_finite(breakout)
        and float(breakout) < trend_thresholds.breakout_min
    ):
        reasons.append("T3_breakout")

    # Calls-only guard: retained for pre-Part-B models / safety. Per-instrument
    # config sets calls_only=false once the down head is validated, so puts
    # fire; with the down head present + calls_only=false this is a no-op.
    if not is_call and trend_thresholds.calls_only:
        return SignalAction(
            action="WAIT", direction="GO_PUT",
            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
            gate_passed=False, gate_reasons=["TREND_CALLS_ONLY"],
        )

    if reasons:
        return SignalAction(
            action="WAIT", direction=direction,
            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
            gate_passed=False, gate_reasons=reasons,
        )

    action = "LONG_CE" if is_call else "LONG_PE"
    leg_ltp = ce_ltp if is_call else pe_ltp

    # TP/SL from the trend-horizon magnitude heads. Fall back through
    # 1800s -> 900s when the longer head is missing.
    mag = _first_finite(predictions, ("trend_magnitude_1800s", "trend_magnitude_900s"))
    dd = _first_finite(predictions, (
        "trend_max_drawdown_1800s", "trend_max_drawdown_900s",
    ))

    if (
        not _is_finite(leg_ltp) or leg_ltp is None or leg_ltp <= 0
        or mag is None or dd is None
    ):
        # Gate passed but no executable price. Surface as WAIT so the
        # caller doesn't log a phantom signal.
        return SignalAction(
            action="WAIT", direction=direction,
            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
            gate_passed=True, gate_reasons=[],
        )

    leg_ltp_f = float(leg_ltp)
    scale = max(0.05, min(2.0, trend_thresholds.magnitude_scale))
    tp_dist = abs(mag) * scale
    sl_dist = abs(dd) * scale
    entry = leg_ltp_f
    tp = leg_ltp_f + tp_dist
    sl = leg_ltp_f - sl_dist
    actual_rr = round(tp_dist / sl_dist, 2) if sl_dist > 0 else 0.0

    return SignalAction(
        action=action, direction=direction,
        entry=round(entry, 2), tp=round(tp, 2), sl=round(sl, 2),
        rr=actual_rr, gate_passed=True, gate_reasons=[],
    )


# ── Per-instrument config loader ──────────────────────────────────────────


@dataclass(frozen=True)
class LegStartThresholds:
    """Leg-start gate configuration (gate_mode="legstart", 2026-07-10).

    Fires ONE trend-aligned signal at the start of a small directional leg on
    the 1-min Heikin-Ashi underlying, replacing the per-tick model gate's
    flood. See ``signal_engine_agent.leg_start.LegStartDetector`` for the
    algorithm.

    Tunable in `config/sea_thresholds/<inst>.json` via:
      "legstart": {
        "enabled": true,
        "ng_ce": 2, "dir_ce": 0.52,
        "ng_pe": 3, "pe_look": 5, "dir_pe": 0.42,
        "ema_period": 21, "trend_slope": 5,
        "sl_pct": 12.0, "tp_pct": 0.0, "maxhold_candles": 20
      }
    """
    # Master switch. Default OFF so the mode is inert unless the JSON opts in.
    enabled: bool = False
    # CALL (up-leg): N consecutive green HA candles + higher-low + model up-prob.
    ng_ce: int = 2
    dir_ce: float = 0.52
    # PUT (down-leg): N consecutive red HA candles + a FRESH lower-low over the
    # last `pe_look` candles + model down-conviction (up-prob <= dir_pe). Tighter
    # than the call side on purpose — puts on shallow dips are noise.
    ng_pe: int = 3
    pe_look: int = 5
    dir_pe: float = 0.42
    # Experiment toggle (2026-07-14): when True the PUT side MIRRORS the call
    # rule instead of the tighter default — `ng_pe` red candles + a lower-high
    # (vs the prior candle) + up-prob <= `dir_pe`, DROPPING the fresh-lower-low
    # (`pe_look`) breakdown test. Backtest says this is worse (floods low-quality
    # puts); left as a flip-back toggle, default False = keep the tight put rule.
    pe_mirror: bool = False
    # Trend line: EMA of HA-close. A call fires only when it is rising over the
    # last `trend_slope` candles, a put only when it is falling — kills
    # counter-trend entries.
    ema_period: int = 21
    trend_slope: int = 5
    # Exit (option B): fixed % stop-loss on the option premium. tp_pct <= 0 means
    # NO fixed target — ride the leg; the execution side's time/momentum exits
    # close it. maxhold_candles caps how long one leg holds the one-per-leg lock.
    sl_pct: float = 12.0
    tp_pct: float = 0.0
    maxhold_candles: int = 20


def load_thresholds_legstart(
    instrument: str,
    config_dir: Path = Path("config/sea_thresholds"),
) -> LegStartThresholds:
    """Load the per-instrument leg-start gate config. Returns defaults
    (enabled=False) when no ``legstart`` block is present in the JSON."""
    inst_path = config_dir / f"{instrument}.json"
    default_path = config_dir / "default.json"
    path = inst_path if inst_path.exists() else default_path
    if not path.exists():
        return LegStartThresholds()
    raw = json.loads(path.read_text(encoding="utf-8"))
    ls_raw = raw.get("legstart")
    return LegStartThresholds(**ls_raw) if ls_raw else LegStartThresholds()


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


def load_thresholds_trend(
    instrument: str,
    config_dir: Path = Path("config/sea_thresholds"),
) -> TrendThresholds:
    """Load the per-instrument trend gate config. Returns defaults
    (enabled=False) when no ``trend`` block is present in the JSON."""
    _, _, _, _, trend = _load_thresholds_v3(instrument, config_dir)
    return trend


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
          "exit_signal_60s_max": 0.40,
          "breakout_in_60s_min": 0.50
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
    # `trend` and `legstart` blocks belong to their own loaders; drop them here
    # so Thresholds(**raw) below doesn't choke on the unknown kwarg.
    raw.pop("trend", None)
    raw.pop("legstart", None)
    gate_mode = raw.pop("gate_mode", "current")
    if gate_mode not in ("current", "wave1", "wave2", "legstart"):
        raise ValueError(
            "gate_mode must be 'current', 'wave1', 'wave2', or 'legstart', "
            f"got {gate_mode!r}"
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


def _load_thresholds_v3(
    instrument: str,
    config_dir: Path = Path("config/sea_thresholds"),
) -> tuple[Thresholds, V2Thresholds, Wave2Thresholds, str, TrendThresholds]:
    """Internal v3 loader: returns (base, v2, wave2, gate_mode, trend).
    Wraps load_thresholds_full and additionally parses the optional
    ``trend`` block. Keeps load_thresholds_full's signature stable so
    existing callers don't break."""
    inst_path = config_dir / f"{instrument}.json"
    default_path = config_dir / "default.json"
    path = inst_path if inst_path.exists() else default_path
    raw = json.loads(path.read_text(encoding="utf-8"))
    trend_raw = raw.pop("trend", None)
    if trend_raw is None:
        trend = TrendThresholds()
    else:
        trend = TrendThresholds(**trend_raw)
    base, v2, wave2, gate_mode = load_thresholds_full(instrument, config_dir)
    return base, v2, wave2, gate_mode, trend
