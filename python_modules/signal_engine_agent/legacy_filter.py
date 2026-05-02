"""
legacy_filter.py — Pre-Phase E5 SEA decision pipeline (DEPRECATED).

Bundles the two pieces that the 3-condition gate (`thresholds.py`)
replaces:

    1. The regime-aware action router formerly in `engine._decide` —
       TREND/RANGE/DEAD/NEUTRAL routing to LONG_CE / LONG_PE / SHORT_CE /
       SHORT_PE based on `direction_prob` thresholds.
    2. The 4-stage `TradeFilter` (sustained direction, confidence gate,
       multi-model consensus, cooldown) wrapped around it.

Retained behind the SEA / backtest `--filter=legacy` CLI switch for
**one cycle** so we can A/B compare the new gate against the old
pipeline on the same parquet day. **This module will be removed**
once the new gate is validated on a full backtest cycle (see Phase
E5 PR body for the comparison numbers).

Do NOT add new functionality here. New work goes in `thresholds.py`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# ── Legacy regime-router defaults (pre-D4 hardcoded values) ───────────────
LEGACY_DIRECTION_PROB_CALL = 0.55
LEGACY_DIRECTION_PROB_PUT = 0.45
LEGACY_NEUTRAL_HIGH_PROB = 0.72


@dataclass
class LegacyDecision:
    """Output of the legacy regime router. Mirrors the old `_decide`
    return-dict but typed."""

    action: str  # LONG_CE / LONG_PE / SHORT_CE / SHORT_PE / WAIT
    entry: float
    tp: float
    sl: float
    rr: float


def legacy_decide(
    dir_prob: float,
    up_pred: float,
    dn_pred: float,
    regime: str | None,
    ce_ltp: float | None,
    pe_ltp: float | None,
    call_thresh: float = LEGACY_DIRECTION_PROB_CALL,
    put_thresh: float = LEGACY_DIRECTION_PROB_PUT,
    up_pred_swing: float = float("nan"),
    dn_pred_swing: float = float("nan"),
) -> LegacyDecision:
    """Verbatim port of the pre-E5 `engine._decide()` regime router.

    Routing:
      TREND    → LONG (directional, movement-driven)
      RANGE    → SHORT (premium selling, decay-driven)
      DEAD     → SHORT (if there's an edge) or WAIT
      NEUTRAL  → LONG only if prob very high (>0.72), else WAIT

    TP/SL uses swing predictions (5min/15min) if available, falls back to 30s.
    """
    result = LegacyDecision(action="WAIT", entry=0.0, tp=0.0, sl=0.0, rr=0.0)

    if math.isnan(dir_prob):
        return result

    tp_up = up_pred_swing if not math.isnan(up_pred_swing) else up_pred
    tp_dn = dn_pred_swing if not math.isnan(dn_pred_swing) else dn_pred

    regime = (regime or "").upper()
    is_bullish = dir_prob >= call_thresh
    is_bearish = dir_prob <= put_thresh

    if regime == "TREND":
        if is_bullish and ce_ltp:
            result.action = "LONG_CE"
            result.entry = float(ce_ltp)
            result.tp = result.entry + abs(tp_up)
            result.sl = result.entry - abs(tp_dn)
        elif is_bearish and pe_ltp:
            result.action = "LONG_PE"
            result.entry = float(pe_ltp)
            result.tp = result.entry + abs(tp_up)
            result.sl = result.entry - abs(tp_dn)

    elif regime in ("RANGE", "DEAD"):
        if is_bearish and ce_ltp:
            result.action = "SHORT_CE"
            result.entry = float(ce_ltp)
            result.sl = result.entry + abs(tp_up)
            result.tp = result.entry - abs(tp_dn)
        elif is_bullish and pe_ltp:
            result.action = "SHORT_PE"
            result.entry = float(pe_ltp)
            result.sl = result.entry + abs(tp_up)
            result.tp = result.entry - abs(tp_dn)

    elif regime == "NEUTRAL" or not regime:
        if dir_prob >= LEGACY_NEUTRAL_HIGH_PROB and ce_ltp:
            result.action = "LONG_CE"
            result.entry = float(ce_ltp)
            result.tp = result.entry + abs(tp_up)
            result.sl = result.entry - abs(tp_dn)
        elif dir_prob <= (1 - LEGACY_NEUTRAL_HIGH_PROB) and pe_ltp:
            result.action = "LONG_PE"
            result.entry = float(pe_ltp)
            result.tp = result.entry + abs(tp_up)
            result.sl = result.entry - abs(tp_dn)

    if result.action != "WAIT" and result.entry > 0:
        tp_dist = abs(result.tp - result.entry)
        sl_dist = abs(result.sl - result.entry)
        result.rr = round(tp_dist / sl_dist, 2) if sl_dist > 0 else 0.0

    return result


# Re-export the 4-stage TradeFilter / TickDecision for the legacy code
# path so engine.py + backtest_scored.py can do a single import.
from signal_engine_agent.trade_filter import (  # noqa: E402,F401
    TickDecision,
    TradeFilter,
    TradeRecommendation,
)
