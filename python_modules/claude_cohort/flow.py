"""Claude cohort — order-flow / tape reading.

Implements Partha's 15-point order-flow spec (2026-09-17) over the recorded
underlying tick stream. See docs/systems/13_claude_cohort.md §15.

WHAT THE DATA CAN AND CANNOT DO
-------------------------------
Rule 1 asks to classify every individual trade as bid-side or ask-side. That is
NOT literally possible on this feed and pretending otherwise would be dishonest.

Measured on nifty50 2026-09-11:
  * packets arrive ~74/min, median gap 0.81 s, p90 1.48 s
  * between two packets a MEDIAN of 130 contracts (2 lots) trades,
    p90 780 (12 lots), max 12,935 (199 lots)
  * 65% of packets carry no new volume at all

So each packet gives the LAST print's price plus the cumulative volume. All
volume since the previous packet is attributed to that one print's side. At the
median (2 lots) that is nearly exact; in the tail it is coarse, because a
199-lot block certainly traded on both sides.

What survives this: everything measured over Rule 15's 1–5 minute confirmation
windows — pressure, delta, cumulative delta, absorption, exhaustion, rejection.
What does not: per-trade granularity. We never claim it.

SCALE-FREE BY CONSTRUCTION
--------------------------
Every threshold is expressed against the session's OWN distribution so far
(medians and percentiles of what has already happened today), never as an
absolute quantity. Raw flow numbers are not comparable between NIFTY and
BANKNIFTY, and an absolute threshold silently becomes a different rule on each
instrument. This is the same mistake as findings bug 8 (a flat 0.2% stop being
36 ticks on one instrument and under 1 tick on another), and the same mistake
that made the first flow-flip exit fire on noise.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from statistics import median
from typing import Optional

# Trade side (rules 1-3)
BUY = 1      # print at or above the ask -> aggressive buyer lifted the offer
SELL = -1    # print at or below the bid -> aggressive seller hit the bid
PASSIVE = 0  # inside the spread, or no book yet

# Rule 15: never one tick. These are the confirmation windows.
WINDOWS_SEC = (60, 120, 300)

# Opening range length. The session filter already blocks entries inside this
# window, so the range is always frozen before any rule reads it.
OR_MINUTES = 15.0


def classify(ltp: float, bid: float, ask: float) -> int:
    """Rule 1 — which side of the book did this print happen on.

    Matches TFA's `underlying_trade_direction` exactly (features/ofi.py) so the
    live feature row and this offline module never disagree.
    """
    if bid == 0.0 and ask == 0.0:
        return PASSIVE          # pre-depth packet: no book, not a passive trade
    if ltp >= ask:
        return BUY
    if ltp <= bid:
        return SELL
    return PASSIVE


@dataclass
class Print:
    ts: float
    side: int
    qty: float      # volume added since the previous packet
    price: float


@dataclass
class DepthSnapshot:
    ts: float
    bid_levels: dict   # price -> qty
    ask_levels: dict
    bid_sum: float
    ask_sum: float


@dataclass
class FlowState:
    """Rolling tape state for one instrument-session. Causal throughout.

    Feed it every underlying tick in order via `on_tick`, then read any of the
    rule outputs. Nothing here looks forward.
    """

    prints: deque = field(default_factory=lambda: deque(maxlen=20000))
    depth_hist: deque = field(default_factory=lambda: deque(maxlen=8))
    cum_delta: float = 0.0                    # rule 9, from session open
    cum_delta_hist: deque = field(default_factory=lambda: deque(maxlen=20000))
    liq_removals: deque = field(default_factory=lambda: deque(maxlen=4000))
    _prev_volume: Optional[float] = None
    _session_qty: list = field(default_factory=list)   # for scale-free thresholds
    _last_price: Optional[float] = None
    # Session levels, built from the tape itself rather than read from a feature
    # column — the rejection rule needs absolute prices, and deriving them here
    # avoids depending on another module's sign convention.
    first_ts: Optional[float] = None
    session_high: Optional[float] = None
    session_low: Optional[float] = None
    or_high: Optional[float] = None      # opening range, frozen after OR_MINUTES
    or_low: Optional[float] = None
    _or_frozen: bool = False

    # ── ingest ───────────────────────────────────────────────────────────

    def on_tick(self, tick: dict) -> None:
        ts = tick.get("recv_ts")
        ltp = tick.get("ltp")
        if ts is None or not ltp:
            return
        bid = tick.get("bid") or 0.0
        ask = tick.get("ask") or 0.0
        vol = tick.get("volume")

        # Rules 2-3: aggressive side, and how much traded since we last looked.
        dv = 0.0
        if vol is not None:
            if self._prev_volume is not None and vol >= self._prev_volume:
                dv = float(vol) - self._prev_volume
            self._prev_volume = float(vol)

        side = classify(float(ltp), float(bid), float(ask))
        if dv > 0:
            self.prints.append(Print(float(ts), side, dv, float(ltp)))
            self._session_qty.append(dv)
            # Rule 8 -> 9: delta accumulates from the open.
            self.cum_delta += side * dv
            self.cum_delta_hist.append((float(ts), self.cum_delta, float(ltp)))

        self._track_levels(float(ts), float(ltp))
        self._ingest_depth(tick, float(ts))
        self._last_price = float(ltp)

    def on_print(self, ts: float, side: int, qty: float, price: float) -> None:
        """Feed an already-classified print.

        Used for DERIVED flows that do not come from a single instrument's own
        tick stream - e.g. delta-weighted option flow, where each option trade
        has been converted to its equivalent underlying exposure and signed
        bullish (+1) or bearish (-1). `price` is the underlying price at that
        moment, so the price-response rules compare the flow against the
        underlying exactly as they do for futures.

        No depth is fed, so rules 11-13 stay silent for such a flow - they are
        properties of one instrument's order book and have no meaning here.
        """
        if qty <= 0 or not price:
            return
        self.prints.append(Print(float(ts), int(side), float(qty), float(price)))
        self._session_qty.append(float(qty))
        self.cum_delta += side * qty
        self.cum_delta_hist.append((float(ts), self.cum_delta, float(price)))
        self._track_levels(float(ts), float(price))
        self._last_price = float(price)

    def _track_levels(self, ts: float, px: float) -> None:
        if self.first_ts is None:
            self.first_ts = ts
            self.session_high = self.session_low = px
            self.or_high = self.or_low = px
            return
        self.session_high = max(self.session_high, px)
        self.session_low = min(self.session_low, px)
        if not self._or_frozen:
            if ts - self.first_ts <= OR_MINUTES * 60.0:
                self.or_high = max(self.or_high, px)
                self.or_low = min(self.or_low, px)
            else:
                self._or_frozen = True

    def levels(self) -> dict:
        return {
            "session_high": self.session_high,
            "session_low": self.session_low,
            "or_high": self.or_high,
            "or_low": self.or_low,
            "or_frozen": self._or_frozen,
        }

    def _ingest_depth(self, tick: dict, ts: float) -> None:
        """Rules 11-13 — the visible book, and what disappears from it."""
        levels = tick.get("depth") or []
        if not levels:
            return
        bid_levels, ask_levels = {}, {}
        for lv in levels:
            bp, bq = lv.get("bid_price"), lv.get("bid_qty")
            ap, aq = lv.get("ask_price"), lv.get("ask_qty")
            if bp:
                bid_levels[round(float(bp), 2)] = float(bq or 0)
            if ap:
                ask_levels[round(float(ap), 2)] = float(aq or 0)

        snap = DepthSnapshot(
            ts=ts,
            bid_levels=bid_levels,
            ask_levels=ask_levels,
            bid_sum=sum(bid_levels.values()),
            ask_sum=sum(ask_levels.values()),
        )

        # Rule 13 — liquidity removal. Compare like-for-like: only price levels
        # present in BOTH snapshots, so a level scrolling out of the top 5 is
        # not mistaken for size being pulled. We deliberately do NOT claim
        # whether it was cancelled or executed; that needs the trade prints.
        if self.depth_hist:
            prev = self.depth_hist[-1]
            for side_name, cur_lv, prev_lv in (
                ("bid", bid_levels, prev.bid_levels),
                ("ask", ask_levels, prev.ask_levels),
            ):
                for price, qty in cur_lv.items():
                    was = prev_lv.get(price)
                    if was is not None and was > 0 and qty < was:
                        self.liq_removals.append((ts, side_name, price, was - qty))
        self.depth_hist.append(snap)

    # ── scale-free yardsticks ────────────────────────────────────────────

    def data_span(self) -> float:
        """Seconds of tape held, oldest print to newest.

        The screen uses this to tell a genuinely quiet window apart from one that
        simply has no history yet.
        """
        if len(self.prints) < 2:
            return 0.0
        return self.prints[-1].ts - self.prints[0].ts

    def _qty_yardstick(self) -> float:
        """Median trade size so far today. All size thresholds are multiples of
        this, so the same rule means the same thing on NIFTY and BANKNIFTY."""
        return median(self._session_qty) if self._session_qty else float("nan")

    def _window(self, sec: float, now: Optional[float] = None) -> list:
        if not self.prints:
            return []
        t_end = now if now is not None else self.prints[-1].ts
        # Both bounds. Filtering only the lower bound let prints from AFTER
        # `now` into the window — a look-ahead leak caught by
        # test_everything_is_causal.
        return [p for p in self.prints if 0.0 <= t_end - p.ts <= sec]

    # ── rules 2,3,7,8 — pressure and delta ───────────────────────────────

    def pressure(self, sec: float = 60.0, now: Optional[float] = None) -> dict:
        """Rules 2, 3, 7, 8 over one confirmation window.

        `delta` is aggressive-buy qty minus aggressive-sell qty. Rule 8 is
        explicit that this is an OBSERVATION, not an entry signal — which is why
        `price_responded` sits next to it and why nothing here returns a verdict.
        """
        w = self._window(sec, now)
        if not w:
            return {"n": 0}
        buy = sum(p.qty for p in w if p.side == BUY)
        sell = sum(p.qty for p in w if p.side == SELL)
        # Counts as well as quantity. Many small trades one way while the size
        # goes the other is a real tell, and invisible if you only sum volume.
        buy_n = sum(1 for p in w if p.side == BUY)
        sell_n = sum(1 for p in w if p.side == SELL)
        total = buy + sell
        px_move = w[-1].price - w[0].price
        yard = self._qty_yardstick()
        return {
            "n": len(w),
            "buy_qty": buy,
            "sell_qty": sell,
            "buy_n": buy_n,
            "sell_n": sell_n,
            "delta": buy - sell,                                   # rule 8
            "delta_ratio": (buy - sell) / total if total else 0.0,
            "price_move": px_move,                                 # rule 4
            "price_responded": _same_sign(buy - sell, px_move),    # rule 7
            "size_vs_normal": (total / (yard * len(w))) if (yard and len(w)) else float("nan"),
        }

    def cumulative_delta(self, sec: Optional[float] = None, now: Optional[float] = None) -> dict:
        """Rule 9 — cumulative delta versus price over the same stretch."""
        if not self.cum_delta_hist:
            return {"n": 0}
        hist = list(self.cum_delta_hist)
        t_end = now if now is not None else hist[-1][0]
        hist = [h for h in hist if h[0] <= t_end]          # never read the future
        if sec is not None:
            hist = [h for h in hist if t_end - h[0] <= sec]
        if not hist:
            return {"n": 0}
        d_delta = hist[-1][1] - hist[0][1]
        d_price = hist[-1][2] - hist[0][2]
        return {
            "n": len(hist),
            # cum_delta AS OF t_end, not the session total — the session total
            # already contains ticks that have not happened yet at t_end.
            "cum_delta": hist[-1][1],
            "delta_change": d_delta,
            "price_change": d_price,
            "confirms": _same_sign(d_delta, d_price),
            # delta building while price refuses to follow is the classic
            # absorption / exhaustion tell (rules 5, 6, 10)
            "divergence": abs(d_delta) > 0 and not _same_sign(d_delta, d_price),
        }

    # ── rules 5,6 — absorption ───────────────────────────────────────────

    def absorption(
        self,
        sec: float = 120.0,
        min_side_share: float = 0.65,
        max_price_move_pts: float = 5.0,
        min_size_mult: float = 1.5,
        now: Optional[float] = None,
    ) -> Optional[dict]:
        """Rules 5, 6 — one side keeps hitting and price refuses to go.

        Buyer absorption: sustained aggressive SELLING, meaningful size, price
        does not continue down -> buyers are soaking it up.
        Seller absorption is the mirror.

        Returns None when there is nothing to say. Thresholds are deliberately
        conservative: absorption is only interesting when the size is genuinely
        above the session's own normal.
        """
        p = self.pressure(sec, now)
        if not p.get("n"):
            return None
        total = p["buy_qty"] + p["sell_qty"]
        if total <= 0:
            return None
        yard = self._qty_yardstick()
        if not yard or math.isnan(yard):
            return None
        if total < yard * p["n"] * min_size_mult:
            return None          # not enough size for anyone to be absorbing

        sell_share = p["sell_qty"] / total
        buy_share = p["buy_qty"] / total
        move = p["price_move"]

        if sell_share >= min_side_share and move >= -max_price_move_pts:
            return {"type": "buyer_absorption", "side_share": sell_share,
                    "qty": p["sell_qty"], "price_move": move}
        if buy_share >= min_side_share and move <= max_price_move_pts:
            return {"type": "seller_absorption", "side_share": buy_share,
                    "qty": p["buy_qty"], "price_move": move}
        return None

    # ── rule 10 — exhaustion ─────────────────────────────────────────────

    def exhaustion(
        self,
        sec: float = 300.0,
        decay: float = 0.6,
        max_price_move_pts: float = 5.0,
        now: Optional[float] = None,
    ) -> Optional[dict]:
        """Rule 10 — aggression that was strong and is fading while price stalls.

        Splits the window in half and compares the later half with the earlier.
        Seller exhaustion: aggressive selling falling away while price stops
        dropping. Buyer exhaustion is the mirror.
        """
        w = self._window(sec, now)
        if len(w) < 8:
            return None
        mid = w[0].ts + (w[-1].ts - w[0].ts) / 2.0
        early = [p for p in w if p.ts <= mid]
        late = [p for p in w if p.ts > mid]
        if not early or not late:
            return None

        e_sell = sum(p.qty for p in early if p.side == SELL)
        l_sell = sum(p.qty for p in late if p.side == SELL)
        e_buy = sum(p.qty for p in early if p.side == BUY)
        l_buy = sum(p.qty for p in late if p.side == BUY)
        move = w[-1].price - w[0].price

        if e_sell > 0 and l_sell < e_sell * decay and move >= -max_price_move_pts:
            return {"type": "seller_exhaustion", "early": e_sell, "late": l_sell,
                    "price_move": move}
        if e_buy > 0 and l_buy < e_buy * decay and move <= max_price_move_pts:
            return {"type": "buyer_exhaustion", "early": e_buy, "late": l_buy,
                    "price_move": move}
        return None

    # ── rules 11,12 — depth and imbalance ────────────────────────────────

    def depth_imbalance(self) -> dict:
        """Rules 11, 12 — visible liquidity on each side.

        Rule 12 is explicit that imbalance alone is not a directional signal, so
        this returns the measurement and no verdict.
        """
        if not self.depth_hist:
            return {"n": 0}
        s = self.depth_hist[-1]
        total = s.bid_sum + s.ask_sum
        return {
            "n": len(s.bid_levels),
            "bid_qty": s.bid_sum,
            "ask_qty": s.ask_sum,
            "imbalance": (s.bid_sum - s.ask_sum) / total if total else 0.0,
        }

    def liquidity_removed(self, sec: float = 60.0, now: Optional[float] = None) -> dict:
        """Rule 13 — size that disappeared from displayed levels.

        Cancellation, modification and execution are indistinguishable from the
        book alone, so this reports the reduction only. Cross-check against
        `pressure()` prints before reading anything into it.
        """
        if not self.liq_removals:
            return {"n": 0}
        t_end = now if now is not None else self.liq_removals[-1][0]
        w = [r for r in self.liq_removals if 0.0 <= t_end - r[0] <= sec]
        if not w:
            return {"n": 0}
        return {
            "n": len(w),
            "bid_removed": sum(r[3] for r in w if r[1] == "bid"),
            "ask_removed": sum(r[3] for r in w if r[1] == "ask"),
        }

    # ── rule 14 — rejection ──────────────────────────────────────────────

    def rejection(
        self, level: float, sec: float = 300.0, now: Optional[float] = None
    ) -> Optional[dict]:
        """Rule 14 — price reached or broke `level` and could not hold there.

        Confirmed the way rule 14 asks: by the subsequent prints, not by the
        poke alone. Direction "down" means it failed on the upside.
        """
        w = self._window(sec, now)
        if len(w) < 5:
            return None
        broke_up = any(p.price > level for p in w)
        broke_down = any(p.price < level for p in w)
        last = w[-1].price

        if broke_up and last < level:
            after = [p for p in w if p.ts >= max(p2.ts for p2 in w if p2.price > level)]
            sell = sum(p.qty for p in after if p.side == SELL)
            buy = sum(p.qty for p in after if p.side == BUY)
            return {"direction": "down", "level": level, "back_by": level - last,
                    "confirm_sell_qty": sell, "confirm_buy_qty": buy,
                    "confirmed": sell > buy}
        if broke_down and last > level:
            after = [p for p in w if p.ts >= max(p2.ts for p2 in w if p2.price < level)]
            sell = sum(p.qty for p in after if p.side == SELL)
            buy = sum(p.qty for p in after if p.side == BUY)
            return {"direction": "up", "level": level, "back_by": last - level,
                    "confirm_sell_qty": sell, "confirm_buy_qty": buy,
                    "confirmed": buy > sell}
        return None

    # ── rule 15 — the combined read ──────────────────────────────────────

    def snapshot(self, now: Optional[float] = None) -> dict:
        """Everything at once, over all confirmation windows.

        Rule 15: never one tick, never one measure. This is what a rule should
        consume — not any single field above.
        """
        out = {
            "cum_delta": self.cum_delta,
            "price": self._last_price,
            "levels": self.levels(),
            "depth": self.depth_imbalance(),
            "absorption": self.absorption(now=now),
            "exhaustion": self.exhaustion(now=now),
        }
        # Rule 14 against each session level that is actually established.
        rej = {}
        for name in ("or_high", "or_low", "session_high", "session_low"):
            lv = self.levels().get(name)
            if lv:
                r = self.rejection(lv, now=now)
                if r:
                    rej[name] = r
        out["rejections"] = rej
        for sec in WINDOWS_SEC:
            out[f"pressure_{sec}s"] = self.pressure(sec, now)
            out[f"cumdelta_{sec}s"] = self.cumulative_delta(sec, now)
            out[f"liq_removed_{sec}s"] = self.liquidity_removed(sec, now)
        return out


def _same_sign(a: float, b: float) -> bool:
    return (a > 0 and b > 0) or (a < 0 and b < 0)


# ── per-day snapshot cache ───────────────────────────────────────────────
#
# The backtest needs the flow read at each 1-minute decision point. Streaming
# the tick file once per day and emitting a snapshot per minute is far cheaper
# than re-deriving it, and keeps the decision points identical between the
# baseline and the flow-based setups.

import glob
import gzip
import json
import os
import zlib

_FLOW_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
UNDERLYING_GLOB = os.path.join(_FLOW_ROOT, "data", "raw", "{date}", "{inst}_underlying_ticks.ndjson.gz")


def build_day_snapshots(instrument: str, date: str, cadence_sec: float = 60.0) -> dict:
    """Stream one day's underlying ticks, emitting a flow snapshot per minute.

    Returns {minute_index: snapshot}, where minute_index is int(ts // 60) — the
    same key the backtest uses for its decision points, so a rule can look up
    "the flow as of this minute" with no alignment guesswork.

    Each snapshot is taken with `now` pinned to that minute, so it can never
    contain prints from later in the day.
    """
    path = UNDERLYING_GLOB.format(date=date, inst=instrument)
    if not os.path.exists(path):
        return {}

    fs = FlowState()
    out: dict = {}
    last_emit = None
    try:
        with gzip.open(path, "rt") as fh:
            for line in fh:
                try:
                    t = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                fs.on_tick(t)
                ts = t.get("recv_ts")
                if ts is None:
                    continue
                if last_emit is None or ts - last_emit >= cadence_sec:
                    last_emit = ts
                    out[int(ts // 60)] = fs.snapshot(now=ts)
    except (EOFError, zlib.error, OSError):
        pass  # truncated recording — keep what we have, same as book.py
    return out


def available_flow_dates(instrument: str) -> list:
    pat = UNDERLYING_GLOB.format(date="*", inst=instrument)
    return sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob(pat))
