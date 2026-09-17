"""Market Status Screen — turn flow measurements into a positive / negative read.

Spec: docs/systems/12_market_status_screen.md

Every rule reports POSITIVE, NEGATIVE, WATCH or NEUTRAL from the live tape, at
each of Partha's confirmation windows, and carries three things beside it:

  * the numbers behind it
  * `meaning` — what it actually says, in plain English
  * its MEASURED track record

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
Rule 15 says never one tick, and names 1 / 2 / 5 minutes. Putting every window
side by side answers the question a single window hides: is this read CONSISTENT
or does it exist in one timeframe only? A push positive at 1-10 min and negative
at 30 min is a bounce inside a move going the other way.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

POSITIVE = "POSITIVE"
NEGATIVE = "NEGATIVE"
NEUTRAL = "NEUTRAL"
WATCH = "WATCH"          # something is happening but it does not imply a side

# Partha's confirmation windows, in seconds. "now" is NOT one of these — it is
# the current tick, handled separately by read_now().
WINDOWS = (60, 120, 300, 600, 900, 1800)
WINDOW_LABELS = ("1m", "2m", "5m", "10m", "15m", "30m")
ALL_COLUMNS = ("now",) + WINDOW_LABELS
DEFAULT_WINDOW = 300

# Shown in the "now" column for rules that cannot be answered by one tick.
# Absorption, exhaustion, pressure and rejection all need size over time and a
# before/after comparison; a single trade cannot supply either. Distinct from
# blank ("no data yet") and from a dot ("nothing is happening").
NOT_APPLICABLE = "—"

SYMBOL = {POSITIVE: "▲", NEGATIVE: "▼", WATCH: "◆", NEUTRAL: "·"}

# Shown when a window has less history than it needs: NOTHING. Blank reads as
# "no data yet"; "·" reads as "nothing is happening". They are different facts
# and must not share a glyph — a cold 30m window printing a dot is the same
# silent-failure shape as the security-id bug and the empty relay.
#
# A window fills in on its own as the tape reaches its length, so the table
# populates left to right through the first half hour of a session.
COLD = ""

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
# it shows its number instead of an arrow. Rule 1 is the raw print count.
NUMERIC_ONLY = {1, 2, 3, 8}


@dataclass
class Read:
    rule: int
    name: str
    verdict: str
    detail: str
    value: str = ""                 # compact cell text for the numeric rows
    edge: Optional[float] = None
    meaning: str = ""               # what this reading MEANS, in plain English
    warm: bool = True               # False = window has less history than it needs

    @property
    def symbol(self) -> str:
        if not self.warm:
            return COLD
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


# Plain-English explanation of each rule, for the tooltips. Written for someone
# who does not read code: what the rule watches, and what it does NOT mean.
RULE_HELP = {
    1: ("TRADE SIDE\n\n"
        "Every trade happens either at the price a seller is asking, or at the "
        "price a buyer is bidding. We record which one, on every trade.\n\n"
        "Shown as buys/sells by COUNT - how many trades went each way. Rules 2 "
        "and 3 split the same window by VOLUME.\n\nWhen those two disagree it is "
        "worth noticing. Lots of small buys against a few large sells means "
        "somebody substantial is unloading into eager buying, and summing volume "
        "alone hides that completely. The explanation on the right says which "
        "side is trading in bigger clips."),
    2: ("AGGRESSIVE BUYING\n\n"
        "Somebody wanted in badly enough to pay the seller's asking price rather "
        "than wait for a better one.\n\n"
        "More of it means buyers are getting impatient. It does NOT mean price "
        "will go up - measured over 77 days, it was slightly worse than a coin."),
    3: ("AGGRESSIVE SELLING\n\n"
        "Somebody wanted out badly enough to accept the buyer's lower price "
        "rather than hold out for more.\n\n"
        "More of it means sellers are getting impatient. Same caveat: measured, "
        "it did not predict price falling."),
    4: ("PRICE AND QUANTITY TOGETHER\n\n"
        "Heavy volume should move price. When a lot trades and price barely "
        "budges, somebody large is quietly taking the other side.\n\n"
        "That stalling is the interesting part, not the volume itself."),
    5: ("BUYER ABSORPTION\n\n"
        "Heavy selling is hitting the market, but price refuses to fall. Buyers "
        "are quietly soaking up everything being sold.\n\n"
        "Of all fifteen rules this was the only one measurably positive at every "
        "horizon - though by about one percentage point, which is too small to "
        "trade on by itself."),
    6: ("SELLER ABSORPTION\n\n"
        "Heavy buying is hitting the market, but price refuses to rise. Sellers "
        "are quietly soaking up everything being bought.\n\n"
        "Often a sign a push is about to fail."),
    7: ("PRESSURE\n\n"
        "One side is pushing harder than the other. The question this asks is "
        "whether price is actually RESPONDING to that push, or just sitting "
        "there while it happens.\n\n"
        "Careful: measured over 77 days this was the WORST of all fifteen rules, "
        "about 4 points below a coin. Pressure that has already moved price "
        "means you are looking at the second half of a move."),
    8: ("DELTA\n\n"
        "Aggressive buying minus aggressive selling. Positive means more "
        "impatient buyers, negative more impatient sellers.\n\n"
        "This is a fact about what just happened, not advice about what to do. "
        "It is shown as a number, never an arrow, for that reason."),
    9: ("CUMULATIVE DELTA\n\n"
        "The running total of delta since the market opened, compared against "
        "where price actually went.\n\n"
        "When the two agree, pressure is producing movement. When they pull "
        "apart - lots of buying but price flat or falling - somebody is "
        "absorbing it, or the push is running out."),
    10: ("EXHAUSTION\n\n"
         "The side that was pushing hard is running out of steam, and price has "
         "stopped moving in their favour.\n\n"
         "Sellers exhausting is potentially the end of a fall; buyers "
         "exhausting, the end of a rise. Fires on roughly one minute in five, "
         "which is too often to be a trigger - treat it as context."),
    11: ("MARKET DEPTH\n\n"
         "Orders sitting and waiting to trade on each side, right now.\n\n"
         "These are intentions, not trades. They can be cancelled in an instant "
         "and frequently are. This is the book as it stands, not history - so it "
         "has no 1-minute or 30-minute version."),
    12: ("ORDER IMBALANCE\n\n"
         "One side of the book is showing more waiting size than the other.\n\n"
         "Do NOT read this as direction. Displayed size is the easiest thing in "
         "the market to fake, and large resting orders are often there to be "
         "seen rather than filled."),
    13: ("LIQUIDITY REMOVAL\n\n"
         "Waiting orders that were on the book a moment ago have gone.\n\n"
         "They were either filled by trades, or pulled by whoever placed them. "
         "The book alone cannot tell us which, so this never claims a direction. "
         "Cross-check it against the trades above."),
    14: ("REJECTION\n\n"
         "Price broke through a level - the day's high, the opening range - "
         "could not hold there, and came back.\n\n"
         "It only counts as confirmed when the actual trades on the way back are "
         "on the other side. A poke that drifts back with no trades behind it is "
         "not a rejection, it is just noise."),
    15: ("COMBINED\n\n"
         "How many rules currently point the same way, at this window.\n\n"
         "This describes what IS HAPPENING on the tape. It is not a forecast and "
         "not a trade signal. Measured over 26,671 decision points, no rule here "
         "predicted direction better than a coin.\n\n"
         "The honest use of this screen is deciding when to STAY OUT."),
}

# Tooltips for the column headers.
COLUMN_HELP = {
    "now": ("THE CURRENT TICK - not a timeframe.\n\nWhat just happened: which "
            "side the latest trade hit, its size, the price move on that tick, "
            "the running delta since the open, and the book as it stands.\n\n"
            "An em-dash means the rule cannot be answered by one trade. "
            "Absorption, exhaustion, pressure and rejection all need size over "
            "time and a before-and-after comparison, and a single trade supplies "
            "neither. Use the timeframe columns for those.\n\nAbout two thirds "
            "of market updates carry no trade at all, so 'the current tick' here "
            "means the most recent tick that actually traded. The book is "
            "genuinely current."),
    "edge": ("MEASURED TRACK RECORD\n\n"
             "How often this rule was right about direction, compared with the "
             "market's own base rate. Measured over 77 days and 26,671 decision "
             "points.\n\n"
             "Percentage points. Anything inside plus or minus 3 is labelled "
             "noise, meaning the rule found nothing.\n\n"
             "It is on screen so a green light can never look more confident "
             "than the evidence behind it."),
    "window": ("A confirmation window.\n\nRule 15 says never judge from one "
               "tick. Every reading here is measured over this much time.\n\n"
               "Blank means the window does not have that much history yet - it "
               "will fill in as the session runs. Blank is 'no data', a dot is "
               "'nothing happening'."),
    "rule": ("Partha's 15 order-flow rules.\n\nHover any rule name for what it "
             "watches and what it does not mean."),
}


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
    """All 15 rules at one confirmation window, straight off the FlowState.

    Every Read carries a `meaning`: what the number actually says, in plain
    English. The arrow gives the direction, the meaning gives the why — so the
    screen is readable without knowing which field produced it.
    """
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
    mins = sec // 60
    buy_pct = 100 * buy / total if total else 0.0
    sell_pct = 100 * sell / total if total else 0.0
    out: list[Read] = []

    # 1 — trade side. Shows the COUNT split by side, not just how many trades.
    #
    # This is deliberately different from rules 2 and 3, which split by VOLUME.
    # Counts one way while the size goes the other is a real tell: many small
    # buys against a few large sells means retail is lifting offers while
    # somebody substantial is unloading into them. Summing volume alone hides it.
    buy_n = pr.get("buy_n", 0)
    sell_n = pr.get("sell_n", 0)
    out.append(Read(
        1, "Trade side",
        POSITIVE if buy_n > sell_n else (NEGATIVE if sell_n > buy_n else NEUTRAL),
        f"{n} prints: {buy_n} buy / {sell_n} sell" if n else "no prints yet",
        value=f"{buy_n}/{sell_n}" if n else "",
        meaning=(f"{buy_n} trades at the ask, {sell_n} at the bid"
                 + (f", {n - buy_n - sell_n} inside the spread" if n - buy_n - sell_n else "")
                 + (f" - {100 * buy_n / (buy_n + sell_n):.0f}% of TRADES are buys "
                    f"vs {buy_pct:.0f}% of VOLUME"
                    f"{'; sells are the bigger clips' if 100 * buy_n / (buy_n + sell_n) - buy_pct > 8 else ''}"
                    f"{'; buys are the bigger clips' if buy_pct - 100 * buy_n / (buy_n + sell_n) > 8 else ''}"
                    if (buy_n + sell_n) else "")
                 if n else "no trades yet in this window"),
    ))

    # 2 — aggressive buying
    buy_pct = 100 * buy / total if total else 0.0
    # Rules 2 and 3 are mirror images - only one can dominate - so showing an
    # arrow on one and a bare dot on the other wasted half the information and
    # read as "nothing here". Both now show their SHARE at every window, and
    # colour only when that side is the dominant one.
    out.append(Read(
        2, "Aggr buying",
        POSITIVE if total and buy > sell else NEUTRAL,
        f"{buy:,.0f} at ask ({buy_pct:.0f}%)" if total else "-",
        value=f"{buy_pct:.0f}%" if total else "",
        edge=MEASURED_EDGE_60M[2],
        meaning=(f"{buy_pct:.0f}% of volume lifted the ask - buyers paying up"
                 if total and buy > sell
                 else (f"only {buy_pct:.0f}% lifted the ask" if total else "nothing traded")),
    ))

    # 3 — aggressive selling
    sell_pct = 100 * sell / total if total else 0.0
    out.append(Read(
        3, "Aggr selling",
        NEGATIVE if total and sell > buy else NEUTRAL,
        f"{sell:,.0f} at bid ({sell_pct:.0f}%)" if total else "-",
        value=f"{sell_pct:.0f}%" if total else "",
        edge=MEASURED_EDGE_60M[3],
        meaning=(f"{sell_pct:.0f}% of volume hit the bid - sellers accepting less"
                 if total and sell > buy
                 else (f"only {sell_pct:.0f}% hit the bid" if total else "nothing traded")),
    ))

    # 4 — price and quantity together
    if not total:
        out.append(Read(4, "Price + qty", NEUTRAL, "-", meaning="no volume to judge"))
    elif absorb:
        out.append(Read(
            4, "Price + qty", WATCH,
            f"qty {total:,.0f}, price {move:+.1f} - absorbing",
            meaning=f"{total:,.0f} traded but price moved only {move:+.1f} - "
                    f"someone is absorbing it",
        ))
    else:
        out.append(Read(
            4, "Price + qty", _dir(move),
            f"qty {total:,.0f}, price {move:+.1f}",
            meaning=f"price {move:+.1f} on {total:,.0f} traded - the move is "
                    f"backed by volume",
        ))

    # 5 / 6 — absorption
    ba = bool(absorb and absorb["type"] == "buyer_absorption")
    sa = bool(absorb and absorb["type"] == "seller_absorption")
    out.append(Read(
        5, "Buyer absorb", POSITIVE if ba else NEUTRAL,
        f"{absorb['qty']:,.0f} sold, price {absorb['price_move']:+.1f}" if ba else "-",
        edge=MEASURED_EDGE_60M[5],
        meaning=(f"{absorb['qty']:,.0f} sold into the bid and price only moved "
                 f"{absorb['price_move']:+.1f} - buyers soaking it up"
                 if ba else "no heavy selling being absorbed"),
    ))
    out.append(Read(
        6, "Seller absorb", NEGATIVE if sa else NEUTRAL,
        f"{absorb['qty']:,.0f} bought, price {absorb['price_move']:+.1f}" if sa else "-",
        edge=MEASURED_EDGE_60M[6],
        meaning=(f"{absorb['qty']:,.0f} bought at the ask and price only moved "
                 f"{absorb['price_move']:+.1f} - sellers soaking it up"
                 if sa else "no heavy buying being absorbed"),
    ))

    # 7 — pressure, and whether price is responding to it
    side = "buying" if delta > 0 else "selling"
    if not total:
        out.append(Read(7, "Pressure", NEUTRAL, "-", edge=MEASURED_EDGE_60M[7],
                        meaning="no pressure either way"))
    elif pr.get("price_responded"):
        out.append(Read(
            7, "Pressure", _dir(delta),
            f"delta {delta:+,.0f}, price following",
            edge=MEASURED_EDGE_60M[7],
            meaning=f"net {side} of {delta:+,.0f} and price is following it",
        ))
    else:
        out.append(Read(
            7, "Pressure", WATCH,
            f"delta {delta:+,.0f}, price NOT following",
            edge=MEASURED_EDGE_60M[7],
            meaning=f"net {side} of {delta:+,.0f} but price is NOT following - watch",
        ))

    # 8 — delta. Rule 8: an observation, never a signal. Number, not an arrow.
    out.append(Read(
        8, "Delta (obs)", NEUTRAL,
        f"{delta:+,.0f} = {buy:,.0f} buy - {sell:,.0f} sell" if total else "-",
        value=_compact(delta) if total else "-",
        meaning=(f"{buy:,.0f} bought minus {sell:,.0f} sold = {delta:+,.0f} - an "
                 f"observation, not a signal" if total else "nothing traded"),
    ))

    # 9 — cumulative delta vs price
    if not cd.get("n"):
        out.append(Read(9, "Cum delta", NEUTRAL, "-", edge=MEASURED_EDGE_60M[9],
                        meaning="not enough history yet"))
    elif cd.get("divergence"):
        out.append(Read(
            9, "Cum delta", WATCH,
            f"delta {cd['delta_change']:+,.0f} vs price {cd['price_change']:+.1f} - DIVERGING",
            edge=MEASURED_EDGE_60M[9],
            meaning=f"delta {cd['delta_change']:+,.0f} but price {cd['price_change']:+.1f} - "
                    f"they disagree, possible absorption or exhaustion",
        ))
    else:
        out.append(Read(
            9, "Cum delta", _dir(cd.get("delta_change", 0.0)),
            f"session {cd.get('cum_delta', 0):+,.0f}, confirming",
            edge=MEASURED_EDGE_60M[9],
            meaning=f"delta {cd['delta_change']:+,.0f} and price {cd['price_change']:+.1f} "
                    f"agree - pressure is producing movement",
        ))

    # 10 — exhaustion. Sellers running out is bullish, buyers running out bearish.
    if exh:
        bullish = exh["type"] == "seller_exhaustion"
        fading = "selling" if bullish else "buying"
        out.append(Read(
            10, "Exhaustion", POSITIVE if bullish else NEGATIVE,
            f"{exh['type'].replace('_', ' ')}: {exh['early']:,.0f} -> {exh['late']:,.0f}",
            edge=MEASURED_EDGE_60M[10],
            meaning=f"aggressive {fading} fading from {exh['early']:,.0f} to "
                    f"{exh['late']:,.0f} while price stalled",
        ))
    else:
        out.append(Read(10, "Exhaustion", NEUTRAL, "-", edge=MEASURED_EDGE_60M[10],
                        meaning="aggression steady, nobody running out"))

    # 11 — depth. The book NOW; no window applies.
    bq, aq = dep.get("bid_qty", 0.0), dep.get("ask_qty", 0.0)
    out.append(Read(
        11, "Depth   (now)", NEUTRAL,
        f"bid {bq:,.0f} / ask {aq:,.0f}" if dep.get("n") else "-",
        meaning=(f"{bq:,.0f} resting to buy vs {aq:,.0f} to sell right now - "
                 f"orders on the book, not trades" if dep.get("n") else "no book"),
    ))

    # 12 — imbalance. Rule 12: never directional on its own.
    imb = dep.get("imbalance")
    if imb is not None and dep.get("n"):
        heavier = "buy" if imb > 0 else "sell"
        out.append(Read(
            12, "Imbalance (now)", NEUTRAL,
            f"{imb:+.2f} ({'bid' if imb > 0 else 'ask'} heavier)",
            edge=MEASURED_EDGE_60M[12],
            meaning=f"{heavier} side shows {abs(imb) * 100:.0f}% more resting size - "
                    f"NOT a direction signal on its own",
        ))
    else:
        out.append(Read(12, "Imbalance (now)", NEUTRAL, "-",
                        edge=MEASURED_EDGE_60M[12], meaning="no book"))

    # 13 — liquidity removal. Cannot tell cancel from execution, so no direction.
    if lq.get("n"):
        b, a = lq.get("bid_removed", 0.0), lq.get("ask_removed", 0.0)
        heavier = "bid" if b > a else "ask"
        out.append(Read(
            13, "Liq removed", NEUTRAL,
            f"bid -{b:,.0f} / ask -{a:,.0f} ({lq['n']} events)",
            edge=MEASURED_EDGE_60M[13],
            meaning=f"size left the {heavier} side ({b:,.0f} bid / {a:,.0f} ask) - "
                    f"cancelled or filled, the book cannot tell which",
        ))
    else:
        out.append(Read(13, "Liq removed", NEUTRAL, "-", edge=MEASURED_EDGE_60M[13],
                        meaning="book steady, no size pulled"))

    # 14 — rejection, confirmed by the prints on the way back
    confirmed = [(k, r) for k, r in rejections.items() if r.get("confirmed")]
    if confirmed:
        k, r = confirmed[0]
        up = r["direction"] == "up"
        where = k.replace("_", " ")
        out.append(Read(
            14, "Rejection", POSITIVE if up else NEGATIVE,
            f"{k} rejected, back {r['back_by']:.1f} pts, confirmed",
            edge=MEASURED_EDGE_60M[14],
            meaning=f"price broke the {where}, came back {r['back_by']:.1f} pts, and "
                    f"the trades on the way back confirm it",
        ))
    elif rejections:
        k, r = next(iter(rejections.items()))
        out.append(Read(
            14, "Rejection", WATCH, f"{k} poked, NOT confirmed",
            edge=MEASURED_EDGE_60M[14],
            meaning=f"price poked the {k.replace('_', ' ')} and came back, but the "
                    f"trades do NOT confirm it yet",
        ))
    else:
        out.append(Read(14, "Rejection", NEUTRAL, "-", edge=MEASURED_EDGE_60M[14],
                        meaning="no level being tested and rejected"))

    out.append(combined(out))

    # How much history do we actually have? On a restart mid-session TailSource
    # re-reads today's whole recording, so the windows refill immediately. But at
    # the open, or if TFA is not recording, a 30m window has nothing in it — and
    # a cold window must say so rather than print "nothing happening".
    span = fs.data_span()
    # Every column here is a real timeframe, so it needs that much tape before it
    # can say anything. "now" is not one of these — it is the current tick, and
    # read_now() is live from the first trade.
    warm = span >= sec

    for rd in out:
        if rd.rule in INSTANTANEOUS:
            continue                      # the book is always "now"
        if not warm:
            rd.warm = False
            have = int(span // 60)
            rd.meaning = (f"waiting - {have}m of tape so far, this window needs {mins}m"
                          if span else "waiting for the first trades")
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
        verdict = NEUTRAL
        detail = f"nothing firing ({watch} watching)"
        meaning = "the tape is quiet - no rule is saying anything"
    elif pos > neg:
        verdict = POSITIVE
        detail = f"{pos} up vs {neg} down, {watch} watching"
        meaning = (f"{pos} rules point up, {neg} down - buying is what is HAPPENING, "
                   f"not a forecast that price will rise")
    elif neg > pos:
        verdict = NEGATIVE
        detail = f"{neg} down vs {pos} up, {watch} watching"
        meaning = (f"{neg} rules point down, {pos} up - selling is what is HAPPENING, "
                   f"not a forecast that price will fall")
    else:
        verdict = NEUTRAL
        detail = f"split {pos}-{neg}, {watch} watching"
        meaning = f"rules disagree {pos}-{neg} - no agreement on the tape"
    return Read(15, "COMBINED", verdict, detail, meaning=meaning)


def read_now(fs) -> list[Read]:
    """The CURRENT TICK — not a short window.

    "now" answers "what just happened", so it reports the most recent trade and
    the book as it stands. Rules that need size over time (absorption,
    exhaustion, pressure, rejection, and the combined read) cannot be answered
    by one trade and say so with an em-dash rather than pretending.

    One caveat worth knowing: about two thirds of market updates carry no trade
    at all, so "the current tick" here means the most recent tick that actually
    traded. The book, by contrast, is genuinely current.
    """
    dep = fs.depth_imbalance() or {}
    last = fs.prints[-1] if getattr(fs, "prints", None) else None
    prev = fs.prints[-2] if fs and len(getattr(fs, "prints", [])) >= 2 else None

    def na(rule: int, name: str, edge=None) -> Read:
        return Read(rule, name, NEUTRAL, "-", value=NOT_APPLICABLE, edge=edge,
                    meaning="needs time - one trade cannot answer this")

    out: list[Read] = []

    if last is None:
        blank = [Read(r, "", NEUTRAL, "-", value="", meaning="waiting for the first trade")
                 for r in range(1, 16)]
        return blank

    side_txt = "buy" if last.side > 0 else ("sell" if last.side < 0 else "mid")
    side_verdict = (POSITIVE if last.side > 0 else
                    (NEGATIVE if last.side < 0 else NEUTRAL))
    tick_move = (last.price - prev.price) if prev else 0.0

    # 1 — which side the latest trade happened on
    out.append(Read(1, "Trade side", side_verdict, f"{side_txt} {last.qty:,.0f}",
                    value=side_txt,
                    meaning=f"the last trade was {last.qty:,.0f} at the "
                            f"{'ask' if last.side > 0 else 'bid' if last.side < 0 else 'mid'} "
                            f"@ {last.price:,.2f}"))

    # 2 / 3 — was that latest trade an aggressive buy or sell
    out.append(Read(2, "Aggr buying", POSITIVE if last.side > 0 else NEUTRAL,
                    f"{last.qty:,.0f} at ask" if last.side > 0 else "-",
                    edge=MEASURED_EDGE_60M[2],
                    meaning=("the last trade lifted the ask" if last.side > 0
                             else "the last trade was not a buy")))
    out.append(Read(3, "Aggr selling", NEGATIVE if last.side < 0 else NEUTRAL,
                    f"{last.qty:,.0f} at bid" if last.side < 0 else "-",
                    edge=MEASURED_EDGE_60M[3],
                    meaning=("the last trade hit the bid" if last.side < 0
                             else "the last trade was not a sell")))

    # 4 — this tick's price move against its size
    out.append(Read(4, "Price + qty", _dir(tick_move),
                    f"{last.qty:,.0f} @ {tick_move:+.2f}",
                    meaning=f"{last.qty:,.0f} traded and price moved {tick_move:+.2f} "
                            f"on this tick"))

    # 5, 6 — absorption needs sustained size against a stalling price
    out.append(na(5, "Buyer absorb", MEASURED_EDGE_60M[5]))
    out.append(na(6, "Seller absorb", MEASURED_EDGE_60M[6]))

    # 7 — pressure is a balance over time, not one trade
    out.append(na(7, "Pressure", MEASURED_EDGE_60M[7]))

    # 8 — this tick's own delta is just its signed size
    out.append(Read(8, "Delta (obs)", NEUTRAL,
                    f"{last.side * last.qty:+,.0f}",
                    value=_compact(last.side * last.qty),
                    meaning=f"this single trade contributed "
                            f"{last.side * last.qty:+,.0f} to delta"))

    # 9 — the session running total IS a now value
    out.append(Read(9, "Cum delta", _dir(fs.cum_delta), f"{fs.cum_delta:+,.0f}",
                    value=_compact(fs.cum_delta), edge=MEASURED_EDGE_60M[9],
                    meaning=f"{fs.cum_delta:+,.0f} net since the open - the running "
                            f"total right now"))

    # 10 — exhaustion is a fade over time
    out.append(na(10, "Exhaustion", MEASURED_EDGE_60M[10]))

    # 11, 12 — the book, which is genuinely current
    bq, aq = dep.get("bid_qty", 0.0), dep.get("ask_qty", 0.0)
    out.append(Read(11, "Depth   (now)", NEUTRAL,
                    f"bid {bq:,.0f} / ask {aq:,.0f}" if dep.get("n") else "-",
                    meaning=(f"{bq:,.0f} resting to buy vs {aq:,.0f} to sell right now"
                             if dep.get("n") else "no book")))
    imb = dep.get("imbalance")
    out.append(Read(12, "Imbalance (now)", NEUTRAL,
                    f"{imb:+.2f}" if imb is not None and dep.get("n") else "-",
                    edge=MEASURED_EDGE_60M[12],
                    meaning=(f"{'buy' if imb > 0 else 'sell'} side has "
                             f"{abs(imb) * 100:.0f}% more resting size - not a "
                             f"direction signal on its own"
                             if imb is not None and dep.get("n") else "no book")))

    # 13 — what left the book on the latest update
    recent = [r for r in getattr(fs, "liq_removals", [])
              if fs.depth_hist and r[0] >= fs.depth_hist[-1].ts]
    if recent:
        b = sum(r[3] for r in recent if r[1] == "bid")
        a = sum(r[3] for r in recent if r[1] == "ask")
        out.append(Read(13, "Liq removed", NEUTRAL, f"bid -{b:,.0f} / ask -{a:,.0f}",
                        edge=MEASURED_EDGE_60M[13],
                        meaning=f"on the latest book update, {b:,.0f} left the bid and "
                                f"{a:,.0f} left the ask"))
    else:
        out.append(Read(13, "Liq removed", NEUTRAL, "-", edge=MEASURED_EDGE_60M[13],
                        meaning="nothing left the book on the latest update"))

    # 14, 15 — a level test and a combined read both need history
    out.append(na(14, "Rejection", MEASURED_EDGE_60M[14]))
    out.append(na(15, "COMBINED"))
    return out


def agreement(grid: dict, r: int, sel: int) -> str:
    """How many windows read the same way as the selected one.

    This is the question the grid exists to answer: a rule saying the same thing
    on 6 of 6 windows is a different animal from one saying it on 1 of 6.
    """
    ref = grid[sel][r].verdict
    if ref == NEUTRAL:
        return ""
    same = sum(1 for sec in WINDOWS if grid[sec][r].verdict == ref)
    return f"{same}/{len(WINDOWS)}"


def read_grid(fs, now: Optional[float] = None) -> dict:
    """{window_sec: [Read, ...]} for every window. One call per redraw."""
    return {sec: read_window(fs, sec, now) for sec in WINDOWS}
