"""Market Status Screen — turn flow measurements into a positive / negative read.

Spec: docs/systems/12_market_status_screen.md

Every rule reports POSITIVE, NEGATIVE, WATCH or NEUTRAL from the live tape, at
each of Partha's confirmation windows, and carries its own MEASURED track
record alongside it.

WHY THE TRACK RECORD IS ON SCREEN
---------------------------------
On 2026-09-17 we measured all 15 rules against what actually happened next:
77 nifty50 days, 26,671 decision points, horizons 15 / 30 / 60 minutes
(`claude_cohort/study.py`). Not one rule beat the base rate on both direction
and reward-to-risk at any horizon.

So a green light means "aggressive buying is happening", NOT "price will rise".
Showing the measured edge beside each light is what keeps the screen honest — a
rule at -4.4 is not something to trade on, however green it looks right now.

The one thing order flow demonstrably does well is stop you taking bad trades:
it turned a setup that won 25% (far worse than a coin) into one that wins 46%
(near random). Read the screen as a reason to STAY OUT, not a reason to enter.

WHY MULTIPLE WINDOWS
--------------------
Rule 15 says never one tick, and names 1 / 2 / 5 minutes. Showing every window
side by side answers the question a single window hides: is this read CONSISTENT
or does it exist in one timeframe only? A push that is positive at 1-10 min and
negative at 30 min is a bounce inside a move going the other way — invisible if
you only ever look at 5 minutes.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

POSITIVE = "POSITIVE"
NEGATIVE = "NEGATIVE"
NEUTRAL = "NEUTRAL"
WATCH = "WATCH"          # something is happening but it does not imply a side

# The six confirmation windows, in seconds.
WINDOWS = (60, 120, 300, 600, 900, 1800)
WINDOW_LABELS = ("1m", "2m", "5m", "10m", "15m", "30m")
DEFAULT_WINDOW = 300

SYMBOL = {POSITIVE: "▲", NEGATIVE: "▼", WATCH: "◆", NEUTRAL: "·"}

# Measured directional edge in percentage points vs the base rate, nifty50,
# 60-minute horizon (claude_cohort/study.py, 2026-09-17). Anything inside +/-3
# is noise. Facts about the rule, not opinions, displayed verbatim so a green
# light can never look more authoritative than it is.
MEASURED_EDGE_60M = {
    2: -3.2,    # aggressive buying   (delta_strong_buy)
    3: -3.9,    # aggressive selling  (delta_strong_sell)
    5: +1.3,    # buyer absorption    — only rule positive at all three horizons
    6: -3.0,    # seller absorption
    7: -4.4,    # pressure w/ response — the WORST of all fifteen
    9: -2.4,    # cumulative delta
    10: -2.1,   # exhaustion
    12: -0.3,   # order imbalance
    13: +2.6,   # liquidity removal   — best measured, still inside noise
    14: -3.8,   # rejection
}

# Rules that are a snapshot of the book right now, not a windowed measurement.
# Faking a 30-minute depth reading would be inventing data.
INSTANTANEOUS = {11, 12}

# Rule 8 is an observation by Partha's own spec, so it never gets a direction —
# it shows its number instead of an arrow.
NUMERIC_ONLY = {1, 8}


@dataclass
class Read:
    rule: int
    name: str
    verdict: str
    detail: str
    value: str = ""                 # compact cell text for the numeric rows
    edge: Optional[float] = None

    @property
    def symbol(self) -> str:
        if self.value:
            return self.value
        return SYMBOL.get(self.verdict, SYMBOL[NEUTRAL])

    @property
    def edge_label(self) -> str:
        if self.edge is None:
            return ""
        if abs(self.edge) < 3.0:
            return f"{self.edge:+.1f} noise"
        return f"{self.edge:+.1f}"


def _dir(v: float) -> str:
    return POSITIVE if v > 0 else (NEGATIVE if v < 0 else NEUTRAL)


def _compact(n: float) -> str:
    a = abs(n)
    if a >= 1_000_000:
        return f"{n / 1e6:+.1f}M"
    if a >= 1_000:
        return f"{n / 1e3:+.1f}k"
    return f"{n:+.0f}"


def read_window(fs, sec: int, now: Optional[float] = None) -> list[Read]:
    """All 15 rules at one confirmation window, straight off the FlowState."""
    pr = fs.pressure(sec, now) or {}
    cd = fs.cumulative_delta(sec, now) or {}
    lq = fs.liquidity_removed(sec, now) or {}
    dep = fs.depth_imbalance() or {}
    absorb = fs.absorption(sec=sec, now=now)
    exh = fs.exhaustion(sec=sec, now=now)

    levels = fs.levels() if hasattr(fs, "levels") else {}
    rejections = {}
    for name in ("or_high", "or_low", "session_high", "session_low"):
        lv = levels.get(name)
        if lv:
            r = fs.rejection(lv, sec=sec, now=now)
            if r:
                rejections[name] = r

    n = pr.get("n", 0)
    buy = pr.get("buy_qty", 0.0)
    sell = pr.get("sell_qty", 0.0)
    total = buy + sell
    delta = pr.get("delta", 0.0)
    move = pr.get("price_move", 0.0)
    out: list[Read] = []

    # 1 — trade side: the raw input, no verdict by design
    out.append(Read(1, "Trade side", NEUTRAL,
                    f"{n} prints" if n else "no prints yet",
                    value=f"{n}" if n else "-"))

    # 2 — aggressive buying
    out.append(Read(2, "Aggr buying",
                    POSITIVE if total and buy > sell else NEUTRAL,
                    f"{buy:,.0f} at ask ({100 * buy / total:.0f}%)" if total else "-",
                    edge=MEASURED_EDGE_60M[2]))

    # 3 — aggressive selling
    out.append(Read(3, "Aggr selling",
                    NEGATIVE if total and sell > buy else NEUTRAL,
                    f"{sell:,.0f} at bid ({100 * sell / total:.0f}%)" if total else "-",
                    edge=MEASURED_EDGE_60M[3]))

    # 4 — price and quantity together
    if not total:
        out.append(Read(4, "Price + qty", NEUTRAL, "-"))
    elif absorb:
        out.append(Read(4, "Price + qty", WATCH,
                        f"qty {total:,.0f}, price {move:+.1f} - absorbing"))
    else:
        out.append(Read(4, "Price + qty", _dir(move),
                        f"qty {total:,.0f}, price {move:+.1f}"))

    # 5 / 6 — absorption
    ba = bool(absorb and absorb["type"] == "buyer_absorption")
    sa = bool(absorb and absorb["type"] == "seller_absorption")
    out.append(Read(5, "Buyer absorb", POSITIVE if ba else NEUTRAL,
                    f"{absorb['qty']:,.0f} sold, price {absorb['price_move']:+.1f}" if ba else "-",
                    edge=MEASURED_EDGE_60M[5]))
    out.append(Read(6, "Seller absorb", NEGATIVE if sa else NEUTRAL,
                    f"{absorb['qty']:,.0f} bought, price {absorb['price_move']:+.1f}" if sa else "-",
                    edge=MEASURED_EDGE_60M[6]))

    # 7 — pressure, and whether price is responding to it
    if not total:
        out.append(Read(7, "Pressure", NEUTRAL, "-", edge=MEASURED_EDGE_60M[7]))
    elif pr.get("price_responded"):
        out.append(Read(7, "Pressure", _dir(delta),
                        f"delta {delta:+,.0f}, price following",
                        edge=MEASURED_EDGE_60M[7]))
    else:
        out.append(Read(7, "Pressure", WATCH,
                        f"delta {delta:+,.0f}, price NOT following",
                        edge=MEASURED_EDGE_60M[7]))

    # 8 — delta. Rule 8: an observation, never a signal. Number, not an arrow.
    out.append(Read(8, "Delta (obs)", NEUTRAL,
                    f"{delta:+,.0f} = {buy:,.0f} buy - {sell:,.0f} sell" if total else "-",
                    value=_compact(delta) if total else "-"))

    # 9 — cumulative delta vs price
    if not cd.get("n"):
        out.append(Read(9, "Cum delta", NEUTRAL, "-", edge=MEASURED_EDGE_60M[9]))
    elif cd.get("divergence"):
        out.append(Read(9, "Cum delta", WATCH,
                        f"delta {cd['delta_change']:+,.0f} vs price {cd['price_change']:+.1f} - DIVERGING",
                        edge=MEASURED_EDGE_60M[9]))
    else:
        out.append(Read(9, "Cum delta", _dir(cd.get("delta_change", 0.0)),
                        f"session {cd.get('cum_delta', 0):+,.0f}, confirming",
                        edge=MEASURED_EDGE_60M[9]))

    # 10 — exhaustion. Sellers running out is bullish, buyers running out bearish.
    if exh:
        bullish = exh["type"] == "seller_exhaustion"
        out.append(Read(10, "Exhaustion", POSITIVE if bullish else NEGATIVE,
                        f"{exh['type'].replace('_', ' ')}: {exh['early']:,.0f} -> {exh['late']:,.0f}",
                        edge=MEASURED_EDGE_60M[10]))
    else:
        out.append(Read(10, "Exhaustion", NEUTRAL, "-", edge=MEASURED_EDGE_60M[10]))

    # 11 — depth. The book NOW; no window applies.
    out.append(Read(11, "Depth   (now)", NEUTRAL,
                    f"bid {dep.get('bid_qty', 0):,.0f} / ask {dep.get('ask_qty', 0):,.0f}"
                    if dep.get("n") else "-"))

    # 12 — imbalance. Rule 12: never directional on its own.
    imb = dep.get("imbalance")
    out.append(Read(12, "Imbalance (now)", NEUTRAL,
                    f"{imb:+.2f} ({'bid' if imb > 0 else 'ask'} heavier)"
                    if imb is not None and dep.get("n") else "-",
                    edge=MEASURED_EDGE_60M[12]))

    # 13 — liquidity removal. Cannot tell cancel from execution, so no direction.
    if lq.get("n"):
        b, a = lq.get("bid_removed", 0.0), lq.get("ask_removed", 0.0)
        out.append(Read(13, "Liq removed", NEUTRAL,
                        f"bid -{b:,.0f} / ask -{a:,.0f} ({lq['n']} events)",
                        edge=MEASURED_EDGE_60M[13]))
    else:
        out.append(Read(13, "Liq removed", NEUTRAL, "-", edge=MEASURED_EDGE_60M[13]))

    # 14 — rejection, confirmed by the prints on the way back
    confirmed = [(k, r) for k, r in rejections.items() if r.get("confirmed")]
    if confirmed:
        k, r = confirmed[0]
        up = r["direction"] == "up"
        out.append(Read(14, "Rejection", POSITIVE if up else NEGATIVE,
                        f"{k} rejected, back {r['back_by']:.1f} pts, confirmed",
                        edge=MEASURED_EDGE_60M[14]))
    elif rejections:
        k, r = next(iter(rejections.items()))
        out.append(Read(14, "Rejection", WATCH, f"{k} poked, NOT confirmed",
                        edge=MEASURED_EDGE_60M[14]))
    else:
        out.append(Read(14, "Rejection", NEUTRAL, "-", edge=MEASURED_EDGE_60M[14]))

    out.append(combined(out))
    return out


def combined(reads: list[Read]) -> Read:
    """Rule 15 — never one data point. Counts only rules allowed a direction.

    Deliberately NOT a trade signal. No rule was found to predict direction, so
    this summarises what the tape is doing; it does not forecast.
    """
    directional = [r for r in reads
                   if r.rule not in INSTANTANEOUS and r.rule not in NUMERIC_ONLY]
    pos = sum(1 for r in directional if r.verdict == POSITIVE)
    neg = sum(1 for r in directional if r.verdict == NEGATIVE)
    watch = sum(1 for r in directional if r.verdict == WATCH)

    if pos == 0 and neg == 0:
        verdict, detail = NEUTRAL, f"nothing firing ({watch} watching)"
    elif pos > neg:
        verdict, detail = POSITIVE, f"{pos} up vs {neg} down, {watch} watching"
    elif neg > pos:
        verdict, detail = NEGATIVE, f"{neg} down vs {pos} up, {watch} watching"
    else:
        verdict, detail = NEUTRAL, f"split {pos}-{neg}, {watch} watching"
    return Read(15, "COMBINED", verdict, detail)


def read_grid(fs, now: Optional[float] = None) -> dict:
    """{window_sec: [Read, ...]} for every window. One call per redraw."""
    return {sec: read_window(fs, sec, now) for sec in WINDOWS}
