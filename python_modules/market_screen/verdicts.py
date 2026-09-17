"""Market Status Screen — turn flow measurements into a positive / negative read.

Spec: docs/systems/12_market_status_screen.md

Every rule here reports POSITIVE, NEGATIVE, or NEUTRAL from the live tape, and
carries its own MEASURED track record alongside it.

WHY THE TRACK RECORD IS ON SCREEN
---------------------------------
On 2026-09-17 we measured all 15 rules against what actually happened next:
77 nifty50 days, 26,671 decision points, horizons 15 / 30 / 60 minutes
(`claude_cohort/study.py`). Not one rule beat the base rate on both direction
and reward-to-risk at any horizon.

So a green light here means "aggressive buying is happening", NOT "price will
rise". Showing the measured edge next to each light is what keeps the screen
honest — a rule with -4.4 measured edge is not something to trade on, however
green it looks right now.

The one thing order flow demonstrably does well is stop you taking bad trades:
it turned a setup that won 25% (far worse than a coin) into one that wins 46%
(near random). Read the screen as a reason to STAY OUT, not a reason to enter.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

POSITIVE = "POSITIVE"
NEGATIVE = "NEGATIVE"
NEUTRAL = "NEUTRAL"
WATCH = "WATCH"          # something is happening but it does not imply a side

# Measured directional edge in percentage points vs the base rate, nifty50,
# 60-minute horizon (claude_cohort/study.py, 2026-09-17). Anything inside +/-3
# is noise. These are FACTS about the rule, not opinions, and they are displayed
# verbatim so a green light can never look more authoritative than it is.
MEASURED_EDGE_60M = {
    "aggressive_buying": -3.2,
    "aggressive_selling": -3.9,
    "price_quantity": None,          # composite, not measured as one trigger
    "buyer_absorption": +1.3,
    "seller_absorption": -3.0,
    "pressure": -4.4,                # delta_strong_*_responding — the worst of all
    "delta": None,                   # rule 8: observation only, by Partha's own spec
    "cumulative_delta": -2.4,
    "exhaustion": -2.1,              # buyer_exhaustion; seller_exhaustion -1.0
    "depth": None,
    "imbalance": -0.3,               # depth_bid_heavy
    "liquidity_removal": +2.6,       # liq_ask_pulled — best measured, still noise
    "rejection": -3.8,               # rejection_up_confirmed
}

# Rules that must never show a direction, because Partha's own spec says so.
NO_DIRECTION = {"delta", "imbalance", "depth", "trade_side", "liquidity_removal"}


@dataclass
class Read:
    """One rule's current state."""

    rule: int
    name: str
    verdict: str
    detail: str
    edge: Optional[float] = None      # measured percentage points, None = not measured

    @property
    def edge_label(self) -> str:
        if self.edge is None:
            return "not measured"
        if abs(self.edge) < 3.0:
            return f"{self.edge:+.1f}pp (noise)"
        return f"{self.edge:+.1f}pp"


def _dir(value: float, tol: float = 0.0) -> str:
    if value > tol:
        return POSITIVE
    if value < -tol:
        return NEGATIVE
    return NEUTRAL


def read_all(snap: dict, window_sec: int = 300) -> list[Read]:
    """Every rule's current read, in Partha's numbering."""
    if not snap:
        return [Read(0, "waiting for ticks", NEUTRAL, "no data yet")]

    pr = snap.get(f"pressure_{window_sec}s") or {}
    cd = snap.get(f"cumdelta_{window_sec}s") or {}
    lq = snap.get(f"liq_removed_{window_sec}s") or {}
    dep = snap.get("depth") or {}
    absorb = snap.get("absorption")
    exh = snap.get("exhaustion")
    rejections = snap.get("rejections") or {}
    out: list[Read] = []

    # 1 — trade side. The raw input; no verdict, by design.
    n = pr.get("n", 0)
    out.append(Read(
        1, "Trade side", NEUTRAL,
        f"{n} prints in {window_sec // 60}m" if n else "no prints yet",
    ))

    # 2 — aggressive buying
    buy = pr.get("buy_qty", 0.0)
    sell = pr.get("sell_qty", 0.0)
    total = buy + sell
    out.append(Read(
        2, "Aggressive buying",
        POSITIVE if total and buy > sell else NEUTRAL,
        f"{buy:,.0f} at ask ({100 * buy / total:.0f}%)" if total else "-",
        MEASURED_EDGE_60M["aggressive_buying"],
    ))

    # 3 — aggressive selling
    out.append(Read(
        3, "Aggressive selling",
        NEGATIVE if total and sell > buy else NEUTRAL,
        f"{sell:,.0f} at bid ({100 * sell / total:.0f}%)" if total else "-",
        MEASURED_EDGE_60M["aggressive_selling"],
    ))

    # 4 — price + quantity together
    move = pr.get("price_move", 0.0)
    if not total:
        out.append(Read(4, "Price + quantity", NEUTRAL, "-"))
    elif abs(move) < 0.05 * max(abs(move), 1.0) or (absorb and abs(move) < 5):
        out.append(Read(4, "Price + quantity", WATCH,
                        f"qty {total:,.0f}, price {move:+.1f} - possible absorption"))
    else:
        out.append(Read(4, "Price + quantity", _dir(move),
                        f"qty {total:,.0f}, price {move:+.1f}"))

    # 5 / 6 — absorption
    ba = absorb and absorb["type"] == "buyer_absorption"
    sa = absorb and absorb["type"] == "seller_absorption"
    out.append(Read(
        5, "Buyer absorption", POSITIVE if ba else NEUTRAL,
        f"{absorb['qty']:,.0f} sold, price {absorb['price_move']:+.1f}" if ba else "-",
        MEASURED_EDGE_60M["buyer_absorption"],
    ))
    out.append(Read(
        6, "Seller absorption", NEGATIVE if sa else NEUTRAL,
        f"{absorb['qty']:,.0f} bought, price {absorb['price_move']:+.1f}" if sa else "-",
        MEASURED_EDGE_60M["seller_absorption"],
    ))

    # 7 — pressure, and whether price is actually responding
    delta = pr.get("delta", 0.0)
    responded = pr.get("price_responded")
    if not total:
        out.append(Read(7, "Pressure", NEUTRAL, "-"))
    elif responded:
        out.append(Read(7, "Pressure", _dir(delta),
                        f"delta {delta:+,.0f}, price following",
                        MEASURED_EDGE_60M["pressure"]))
    else:
        out.append(Read(7, "Pressure", WATCH,
                        f"delta {delta:+,.0f}, price NOT following",
                        MEASURED_EDGE_60M["pressure"]))

    # 8 — delta. Partha's spec: an observation, never a signal on its own.
    out.append(Read(8, "Delta (observation)", NEUTRAL,
                    f"{delta:+,.0f} = {buy:,.0f} buy - {sell:,.0f} sell" if total else "-"))

    # 9 — cumulative delta vs price
    if not cd.get("n"):
        out.append(Read(9, "Cumulative delta", NEUTRAL, "-"))
    elif cd.get("divergence"):
        out.append(Read(9, "Cumulative delta", WATCH,
                        f"delta {cd['delta_change']:+,.0f} vs price {cd['price_change']:+.1f} - DIVERGING",
                        MEASURED_EDGE_60M["cumulative_delta"]))
    else:
        out.append(Read(9, "Cumulative delta", _dir(cd.get("delta_change", 0.0)),
                        f"session {snap.get('cum_delta', 0):+,.0f}, confirming",
                        MEASURED_EDGE_60M["cumulative_delta"]))

    # 10 — exhaustion. Sellers running out is bullish; buyers running out bearish.
    if exh:
        bullish = exh["type"] == "seller_exhaustion"
        out.append(Read(10, "Exhaustion", POSITIVE if bullish else NEGATIVE,
                        f"{exh['type'].replace('_', ' ')}: {exh['early']:,.0f} -> {exh['late']:,.0f}",
                        MEASURED_EDGE_60M["exhaustion"]))
    else:
        out.append(Read(10, "Exhaustion", NEUTRAL, "-"))

    # 11 — depth
    out.append(Read(11, "Market depth", NEUTRAL,
                    f"bid {dep.get('bid_qty', 0):,.0f} / ask {dep.get('ask_qty', 0):,.0f}"
                    if dep.get("n") else "-"))

    # 12 — imbalance. Spec: never directional on its own.
    imb = dep.get("imbalance")
    out.append(Read(12, "Order imbalance", NEUTRAL,
                    f"{imb:+.2f} ({'bid' if imb and imb > 0 else 'ask'} heavier)"
                    if imb is not None and dep.get("n") else "-",
                    MEASURED_EDGE_60M["imbalance"]))

    # 13 — liquidity removal. Cannot tell cancel from execution; no direction.
    if lq.get("n"):
        b, a = lq.get("bid_removed", 0.0), lq.get("ask_removed", 0.0)
        out.append(Read(13, "Liquidity removal", NEUTRAL,
                        f"bid -{b:,.0f} / ask -{a:,.0f} ({lq['n']} events)",
                        MEASURED_EDGE_60M["liquidity_removal"]))
    else:
        out.append(Read(13, "Liquidity removal", NEUTRAL, "-"))

    # 14 — rejection, confirmed by the prints on the way back
    confirmed = [(k, r) for k, r in rejections.items() if r.get("confirmed")]
    if confirmed:
        k, r = confirmed[0]
        up = r["direction"] == "up"
        out.append(Read(14, "Rejection", POSITIVE if up else NEGATIVE,
                        f"{k} rejected, back {r['back_by']:.1f} pts, confirmed",
                        MEASURED_EDGE_60M["rejection"]))
    elif rejections:
        k, r = next(iter(rejections.items()))
        out.append(Read(14, "Rejection", WATCH, f"{k} poked, NOT confirmed",
                        MEASURED_EDGE_60M["rejection"]))
    else:
        out.append(Read(14, "Rejection", NEUTRAL, "-"))

    # 15 — the combined read
    out.append(combined(out))
    return out


def combined(reads: list[Read]) -> Read:
    """Rule 15 — never one data point. Counts only rules allowed a direction.

    Deliberately NOT a trade signal. The study found no rule predicts direction,
    so this is a summary of what the tape is doing, not a forecast.
    """
    pos = sum(1 for r in reads if r.verdict == POSITIVE and r.name.lower().replace(" ", "_") not in NO_DIRECTION)
    neg = sum(1 for r in reads if r.verdict == NEGATIVE and r.name.lower().replace(" ", "_") not in NO_DIRECTION)
    watch = sum(1 for r in reads if r.verdict == WATCH)

    if pos == 0 and neg == 0:
        verdict, detail = NEUTRAL, f"nothing firing ({watch} watching)"
    elif pos > neg:
        verdict, detail = POSITIVE, f"{pos} positive vs {neg} negative, {watch} watching"
    elif neg > pos:
        verdict, detail = NEGATIVE, f"{neg} negative vs {pos} positive, {watch} watching"
    else:
        verdict, detail = NEUTRAL, f"split {pos}-{neg}, {watch} watching"
    return Read(15, "COMBINED", verdict, detail)
