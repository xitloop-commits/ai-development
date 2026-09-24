"""TCS2 - order flow and tape reading, one instance per security.

Spec: docs/systems/14_tcs2.md  (D27)

Our own implementation. `claude_cohort/flow.py` is a reference to copy the rules
from, never an import, and agreement on trade-side classification is enforced by
a test (D27).

The fifteen readings, in the order Partha listed them:

     1  trade side                which side of the book a print happened on
     2  aggressive buying         share of traded quantity lifting the offer
     3  aggressive selling        share hitting the bid
     4  price + quantity          how big the prints are, against this session
     5  buyer absorption          buyers aggressive, price refusing to rise
     6  seller absorption         sellers aggressive, price refusing to fall
     7  pressure with response    one-sided flow AND price moving with it
     8  delta                     signed traded quantity over a window
     9  cumulative delta          the running total for the session
    10  exhaustion                flow weakening while price stops progressing
    11  market depth              displayed quantity, both sides
    12  order imbalance           how lopsided the displayed book is
    13  liquidity removal         a side's displayed quantity being pulled
    14  rejection                 price reaching a level and being pushed back
    15  confirmation              a reading that has persisted, not a single tick

Two rules the whole module obeys
--------------------------------
**Thresholds are scale-free.** Every "big" or "one-sided" judgement is made
against this session's own median, never an absolute number. BANKNIFTY and
NATURALGAS differ by orders of magnitude in price, quantity and tick size, and
one instrument's normal is another's extreme.

**No book means unknown, not passive.** When a packet carries no depth, both bid
and ask read 0.00. Treating that as a passive print would silently label real
trades as neutral, so it is counted separately and excluded from every share.

**Memory is bounded.** One of these can exist per subscribed leg, so prints are
kept in a deque trimmed to a time window rather than for the whole day.
"""
from __future__ import annotations

import collections
import statistics
from dataclasses import dataclass, field

from .wire import ResponseCode, Tick

BUY = 1
SELL = -1
PASSIVE = 0
UNKNOWN = 2

# A reading has to hold for this long before rule 15 calls it confirmed.
DEFAULT_CONFIRM_SEC = 10.0

# How lopsided flow must be before it counts as one-sided. 0.65 of traded
# quantity on one side is a judgement, and it is a *share*, so it carries across
# instruments unchanged.
ONE_SIDED = 0.65

# A print is "large" at this multiple of the session's median print size.
LARGE_MULTIPLE = 3.0


@dataclass(frozen=True)
class Print:
    ts: float
    side: int
    qty: int
    price: float


@dataclass
class Book:
    ts: float = 0.0
    bid: float = 0.0
    ask: float = 0.0
    bid_size: int = 0
    ask_size: int = 0
    bid_depth: int = 0      # summed across all 5 levels
    ask_depth: int = 0

    @property
    def valid(self) -> bool:
        return self.bid > 0.0 and self.ask > 0.0

    @property
    def spread(self) -> float:
        return self.ask - self.bid if self.valid else float("nan")


def classify(ltp: float, bid: float, ask: float) -> int:
    """Rule 1 - which side of the book this print happened on.

    Lee-Ready: a trade at or above the offer means the buyer crossed; at or below
    the bid means the seller did. Anything between is passive.

    A packet with no book at all returns UNKNOWN rather than PASSIVE. Calling it
    passive would quietly relabel real aggression as neutral, and pre-depth
    packets are common at the open.
    """
    if bid == 0.0 and ask == 0.0:
        return UNKNOWN
    if ltp >= ask:
        return BUY
    if ltp <= bid:
        return SELL
    return PASSIVE


class FlowState:
    """Rolling order-flow state for ONE security."""

    def __init__(self, window_sec: float = 1800.0, max_prints: int = 20000,
                 confirm_sec: float = DEFAULT_CONFIRM_SEC) -> None:
        self.window_sec = window_sec
        self.confirm_sec = confirm_sec
        self.prints: collections.deque[Print] = collections.deque(maxlen=max_prints)
        self.book = Book()
        self.prev_book = Book()

        self._prev_volume = -1
        self._prev_ltp = 0.0
        self.cum_delta = 0
        self.session_high = 0.0
        self.session_low = 0.0
        self.unknown_prints = 0
        self.ticks = 0
        self.last_ts = 0.0

        # Session medians, for the scale-free thresholds.
        self._qty_samples: list[int] = []
        self._depth_samples: list[int] = []

        # Rule 15 - when each named reading first became true.
        self._since: dict[str, float] = {}

    # -- ingest ----------------------------------------------------------

    def on_tick(self, t: Tick) -> Print | None:
        """Apply one tick. Returns the print it produced, if any."""
        self.ticks += 1
        self.last_ts = t.recv_ts

        if t.has_book:
            self.prev_book = self.book
            self.book = Book(
                ts=t.recv_ts, bid=t.bid, ask=t.ask,
                bid_size=t.bid_size, ask_size=t.ask_size,
                bid_depth=sum(l.bid_qty for l in t.depth) or t.bid_size,
                ask_depth=sum(l.ask_qty for l in t.depth) or t.ask_size)
            total = self.book.bid_depth + self.book.ask_depth
            if total > 0:
                self._depth_samples.append(total)

        if t.ltp > 0:
            if self.session_high == 0.0 or t.ltp > self.session_high:
                self.session_high = t.ltp
            if self.session_low == 0.0 or t.ltp < self.session_low:
                self.session_low = t.ltp

        if t.kind not in (ResponseCode.FULL, ResponseCode.QUOTE):
            return None

        # Quantity from the CHANGE in cumulative volume, not from ltq. ltq is the
        # last trade only, so two trades between packets would lose one; the
        # volume difference captures both.
        qty = 0
        if t.volume > 0:
            if self._prev_volume >= 0:
                qty = t.volume - self._prev_volume
            self._prev_volume = t.volume
        if qty <= 0:
            qty = t.ltq if t.ltq > 0 else 0
        if qty <= 0 or t.ltp <= 0:
            return None

        side = classify(t.ltp, t.bid, t.ask)
        if side == UNKNOWN:
            self.unknown_prints += 1
            self._prev_ltp = t.ltp
            return None

        p = Print(ts=t.recv_ts, side=side, qty=int(qty), price=t.ltp)
        self.prints.append(p)
        self._qty_samples.append(int(qty))
        self.cum_delta += side * int(qty)
        self._prev_ltp = t.ltp
        self._trim(t.recv_ts)
        return p

    def _trim(self, now: float) -> None:
        cutoff = now - self.window_sec
        while self.prints and self.prints[0].ts < cutoff:
            self.prints.popleft()

    # -- windows ---------------------------------------------------------

    def _in(self, seconds: float, now: float | None = None) -> list[Print]:
        now = now if now is not None else self.last_ts
        cutoff = now - seconds
        return [p for p in self.prints if p.ts >= cutoff]

    @property
    def median_qty(self) -> float:
        return statistics.median(self._qty_samples) if self._qty_samples else 0.0

    @property
    def median_depth(self) -> float:
        return statistics.median(self._depth_samples) if self._depth_samples else 0.0

    # -- rules 2, 3, 4 ---------------------------------------------------

    def aggression(self, seconds: float, now: float | None = None) -> dict:
        """Rules 2 and 3 - the share of traded quantity on each side.

        Shares, not counts, so the reading means the same thing on NATURALGAS as
        on BANKNIFTY.
        """
        ps = self._in(seconds, now)
        buy = sum(p.qty for p in ps if p.side == BUY)
        sell = sum(p.qty for p in ps if p.side == SELL)
        passive = sum(p.qty for p in ps if p.side == PASSIVE)
        total = buy + sell + passive
        if total == 0:
            return {"buy_share": 0.0, "sell_share": 0.0, "passive_share": 0.0,
                    "total_qty": 0, "prints": 0}
        return {"buy_share": buy / total, "sell_share": sell / total,
                "passive_share": passive / total, "total_qty": total,
                "prints": len(ps)}

    def print_size(self, seconds: float, now: float | None = None) -> dict:
        """Rule 4 - how big the prints are, measured against this session."""
        ps = self._in(seconds, now)
        if not ps:
            return {"mean_qty": 0.0, "max_qty": 0, "large_prints": 0,
                    "large_share": 0.0}
        med = self.median_qty
        thresh = med * LARGE_MULTIPLE if med > 0 else float("inf")
        large = [p for p in ps if p.qty >= thresh]
        total = sum(p.qty for p in ps)
        return {
            "mean_qty": total / len(ps),
            "max_qty": max(p.qty for p in ps),
            "large_prints": len(large),
            "large_share": (sum(p.qty for p in large) / total) if total else 0.0,
        }

    # -- rules 8, 9 ------------------------------------------------------

    def delta(self, seconds: float, now: float | None = None) -> int:
        """Rule 8 - signed traded quantity over a window."""
        return sum(p.side * p.qty for p in self._in(seconds, now))

    def cumulative_delta(self) -> int:
        """Rule 9 - the running session total."""
        return self.cum_delta

    # -- rules 5, 6 ------------------------------------------------------

    def absorption(self, seconds: float, now: float | None = None) -> dict:
        """Rules 5 and 6 - one side aggressive while price refuses to follow.

        Buyers absorbing means: heavy lifting of the offer, and price flat or
        lower anyway. Someone is selling into all of it, and that someone is
        bigger than the buyers.
        """
        ps = self._in(seconds, now)
        if len(ps) < 2:
            return {"buyer_absorbed": False, "seller_absorbed": False,
                    "price_change": 0.0}
        agg = self.aggression(seconds, now)
        move = ps[-1].price - ps[0].price
        med = self.median_qty
        heavy = agg["total_qty"] >= med * len(ps) if med > 0 else False
        return {
            # Buyers were aggressive AND price did not rise.
            "buyer_absorbed": agg["buy_share"] >= ONE_SIDED and move <= 0 and heavy,
            "seller_absorbed": agg["sell_share"] >= ONE_SIDED and move >= 0 and heavy,
            "price_change": move,
        }

    # -- rule 7 ----------------------------------------------------------

    def pressure(self, seconds: float, now: float | None = None) -> dict:
        """Rule 7 - one-sided flow WITH price responding.

        The opposite of absorption: flow is lopsided and price is going where the
        flow is pushing it.
        """
        ps = self._in(seconds, now)
        if len(ps) < 2:
            return {"direction": 0, "responding": False, "price_change": 0.0}
        agg = self.aggression(seconds, now)
        move = ps[-1].price - ps[0].price
        direction = 0
        if agg["buy_share"] >= ONE_SIDED:
            direction = BUY
        elif agg["sell_share"] >= ONE_SIDED:
            direction = SELL
        responding = (direction == BUY and move > 0) or (direction == SELL and move < 0)
        return {"direction": direction, "responding": responding,
                "price_change": move}

    # -- rule 10 ---------------------------------------------------------

    def exhaustion(self, seconds: float, now: float | None = None) -> dict:
        """Rule 10 - flow weakening while price stops progressing.

        The window is split in half: activity falling away while price has gone
        nowhere is a move running out of participants.
        """
        now = now if now is not None else self.last_ts
        half = seconds / 2.0
        recent = self._in(half, now)
        earlier = [p for p in self.prints
                   if now - seconds <= p.ts < now - half]
        if not recent or not earlier:
            return {"exhausted": False, "flow_ratio": 0.0, "price_progress": 0.0}
        q_recent = sum(p.qty for p in recent)
        q_earlier = sum(p.qty for p in earlier)
        ratio = q_recent / q_earlier if q_earlier else 0.0
        progress = recent[-1].price - earlier[0].price
        span = max(p.price for p in self.prints) - min(p.price for p in self.prints)
        stalled = abs(progress) <= 0.25 * span if span > 0 else True
        return {"exhausted": ratio < 0.6 and stalled, "flow_ratio": ratio,
                "price_progress": progress}

    # -- rules 11, 12 ----------------------------------------------------

    def depth(self) -> dict:
        """Rule 11 - displayed quantity on each side, right now."""
        b = self.book
        return {"bid_depth": b.bid_depth, "ask_depth": b.ask_depth,
                "bid_size": b.bid_size, "ask_size": b.ask_size,
                "spread": b.spread, "valid": b.valid}

    def imbalance(self) -> float:
        """Rule 12 - how lopsided the displayed book is.

        +1 is all bid, -1 is all ask, 0 is balanced. A ratio, so it compares
        across instruments.
        """
        b = self.book
        total = b.bid_depth + b.ask_depth
        if total <= 0:
            return 0.0
        return (b.bid_depth - b.ask_depth) / total

    # -- rule 13 ---------------------------------------------------------

    def liquidity_removed(self, frac: float = 0.4) -> dict:
        """Rule 13 - a side's displayed quantity being pulled.

        Measured against the previous book rather than against a fixed size, so
        it means the same thing on any instrument.
        """
        a, b = self.prev_book, self.book
        if not (a.valid and b.valid):
            return {"bid_pulled": False, "ask_pulled": False}
        bid_drop = (a.bid_depth - b.bid_depth) / a.bid_depth if a.bid_depth else 0.0
        ask_drop = (a.ask_depth - b.ask_depth) / a.ask_depth if a.ask_depth else 0.0
        return {"bid_pulled": bid_drop >= frac, "ask_pulled": ask_drop >= frac,
                "bid_drop": bid_drop, "ask_drop": ask_drop}

    # -- rule 14 ---------------------------------------------------------

    def rejection(self, seconds: float = 300.0, touch_frac: float = 0.001,
                  now: float | None = None) -> dict:
        """Rule 14 - price reached a level and was pushed back.

        `touch_frac` is a FRACTION of price, not a number of points, so 0.1% is
        0.1% whether the instrument trades at 270 or at 56,000.
        """
        ps = self._in(seconds, now)
        if len(ps) < 3:
            return {"rejected_high": False, "rejected_low": False}
        hi = max(p.price for p in ps)
        lo = min(p.price for p in ps)
        last = ps[-1].price
        tol_hi, tol_lo = hi * touch_frac, lo * touch_frac
        return {
            "rejected_high": (hi - last) > tol_hi and hi >= self.session_high - tol_hi,
            "rejected_low": (last - lo) > tol_lo and lo <= self.session_low + tol_lo,
            "window_high": hi, "window_low": lo,
        }

    # -- rule 15 ---------------------------------------------------------

    def confirm(self, name: str, is_true: bool, now: float | None = None) -> bool:
        """Rule 15 - has this reading HELD, or did it just flicker on?

        Not decoration. A single sign change fired an exit on every noise tick in
        an earlier design: the underlying flow measure flipped sign 762 times in
        one day, about every 30 seconds, turning a 15-minute-to-2-hour design into
        a 1-minute median hold. Nothing acts on an unconfirmed reading.
        """
        now = now if now is not None else self.last_ts
        if not is_true:
            self._since.pop(name, None)
            return False
        first = self._since.setdefault(name, now)
        return (now - first) >= self.confirm_sec

    def held_for(self, name: str, now: float | None = None) -> float:
        now = now if now is not None else self.last_ts
        first = self._since.get(name)
        return (now - first) if first is not None else 0.0

    # -- readout ---------------------------------------------------------

    def snapshot(self, windows: tuple[float, ...] = (60.0, 120.0, 300.0, 900.0),
                 now: float | None = None) -> dict:
        """All fifteen readings, per window. The screen's input."""
        out: dict = {
            "ticks": self.ticks,
            "prints": len(self.prints),
            "unknown_prints": self.unknown_prints,
            "cum_delta": self.cumulative_delta(),
            "median_qty": self.median_qty,
            "session_high": self.session_high,
            "session_low": self.session_low,
            "depth": self.depth(),
            "imbalance": self.imbalance(),
            "liquidity": self.liquidity_removed(),
            "windows": {},
        }
        for w in windows:
            out["windows"][int(w)] = {
                "aggression": self.aggression(w, now),
                "print_size": self.print_size(w, now),
                "delta": self.delta(w, now),
                "absorption": self.absorption(w, now),
                "pressure": self.pressure(w, now),
                "exhaustion": self.exhaustion(w, now),
                "rejection": self.rejection(w, now=now),
            }
        return out

    def data_span(self) -> float:
        """Seconds of prints actually held - so a window can say COLD honestly."""
        if len(self.prints) < 2:
            return 0.0
        return self.prints[-1].ts - self.prints[0].ts
