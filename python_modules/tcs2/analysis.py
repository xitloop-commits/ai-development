"""TCS2 - the 25 analysis points.

Spec: docs/systems/15_detection_decision.md  (the points)
      docs/systems/14_tcs2.md  (D14, D27, D43 - own code, no imports)

**Every score here DESCRIBES, it does not predict.** Spec 15 §5.4 is not a
caveat, it is the contract: a score of 80 means *"this condition is strongly
present"*, never *"80% chance price rises"*. The reason is measured, not
cautious - over 77 days and 26,671 decision points, **not one** of the fifteen
order-flow rules beat the base rate on both direction and reward-to-risk at any
horizon. The best was +2.6 points, inside noise; "pressure with price responding"
was the **worst** at -4.4.

So point 25 produces a verdict and a reason, and that verdict is **recorded**
(kind D, D28) so it can be scored after roughly 60 live days. It does not size
capital. Spec 15 §5.5 sets the bar it must clear first: >=60 out-of-sample days,
a majority of months positive judged independently, survives removing the top 3
trades, no look-ahead, and not explained by market direction.

Points that cannot be computed return `None` rather than a number. A missing
reading and a reading of zero are different things, and conflating them is how a
screen ends up looking confident about nothing.
"""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .chain import Chain, ChainSummary
from .flow import BUY, SELL, FlowState

# Windows the points are evaluated over, in seconds. Spec 15 asks for
# 1/2/3/5/10/15/30 minutes.
WINDOWS = (60, 120, 180, 300, 600, 900, 1800)

UP, DOWN, FLAT = "UP", "DOWN", "FLAT"
NOT_READY, BUILDING, READY = "NOT_READY", "BUILDING", "READY"
CONFIRMED, SUSPECT, FALSE = "CONFIRMED", "SUSPECT", "FALSE"
WEAK, NORMAL, STRONG = "WEAK", "NORMAL", "STRONG"
POOR, ACCEPTABLE = "POOR", "ACCEPTABLE"
CONTINUATION, WEAKENING, REVERSAL = "CONTINUATION", "WEAKENING", "REVERSAL"
EXPANSION, CONTRACTION, NEUTRAL = "EXPANSION", "CONTRACTION", "NEUTRAL"
TRADE, NO_TRADE = "TRADE", "NO_TRADE"

# Points 5-8 leg definition. Spec 15 §5.3 left three options open and recommended
# B with A alongside; this is that recommendation, implemented and flagged.
#   A  the broker convention - infer from price direction alone
#   B  the actual aggressor - who crossed the spread, which we record per trade
# Both are reported. A disagreement between them is not a bug: it is price
# implying buying while the aggressor was the writer, which may be the
# interesting moment rather than the error.
LEG_CONVENTION = "A"
LEG_AGGRESSOR = "B"


@dataclass
class Point:
    """One reading. `value` is the finding; `score` is how strongly it is present."""

    n: int
    name: str
    value: Any = None
    score: float | None = None        # 0-100, DESCRIPTIVE ONLY
    detail: dict = field(default_factory=dict)
    note: str = ""

    @property
    def available(self) -> bool:
        return self.value is not None


def _pct(x: float, lo: float, hi: float) -> float:
    """Map a value onto 0-100 by where it sits between lo and hi."""
    if hi <= lo:
        return 0.0
    return float(max(0.0, min(100.0, (x - lo) / (hi - lo) * 100.0)))


def _safe_div(a: float, b: float) -> float:
    return a / b if b else 0.0


class Analysis:
    """The 25 points for one instrument, from its chain and its flow states."""

    def __init__(self, chain: Chain, flow: dict[int, FlowState],
                 futures_ids: tuple[int, ...] = ()) -> None:
        self.chain = chain
        self.flow = flow
        self.futures_ids = futures_ids or tuple(chain._futures_ids)

    # -- helpers ---------------------------------------------------------

    @property
    def fut(self) -> FlowState | None:
        """The futures' flow state - where structure and volume come from.

        Spec 15 lists "S1 + S2" for structure, but the index arrives in ticker
        mode with no volume, no OI and no book (spec 15 §5.1), so **all volume and
        structure must come from the futures**. On MCX the futures IS the
        underlying, so this is the same object either way.
        """
        for sid in self.futures_ids:
            fs = self.flow.get(sid)
            if fs is not None and fs.ticks > 0:
                return fs
        return None

    def _prices(self, seconds: int) -> list[float]:
        fs = self.fut
        return [p.price for p in fs._in(seconds)] if fs else []

    def _expiry(self) -> str:
        return self.chain.expiries[0] if self.chain.expiries else ""

    # -- 1, 2, 15: direction, momentum, persistence ----------------------

    def p1_direction(self, seconds: int = 300) -> Point:
        """Higher highs and higher lows, or the reverse, with persistence."""
        px = self._prices(seconds)
        if len(px) < 12:
            return Point(1, "direction", note="not enough prints")
        n = len(px) // 4
        quarters = [px[i * n:(i + 1) * n] for i in range(4)]
        highs = [max(q) for q in quarters if q]
        lows = [min(q) for q in quarters if q]
        if len(highs) < 3:
            return Point(1, "direction", note="not enough prints")
        hh = sum(1 for a, b in zip(highs, highs[1:]) if b > a)
        hl = sum(1 for a, b in zip(lows, lows[1:]) if b > a)
        ll = sum(1 for a, b in zip(lows, lows[1:]) if b < a)
        lh = sum(1 for a, b in zip(highs, highs[1:]) if b < a)
        steps = len(highs) - 1
        up, down = (hh + hl) / (2 * steps), (ll + lh) / (2 * steps)
        if up > down and up >= 0.5:
            return Point(1, "direction", UP, up * 100.0,
                         {"hh": hh, "hl": hl, "steps": steps})
        if down > up and down >= 0.5:
            return Point(1, "direction", DOWN, down * 100.0,
                         {"ll": ll, "lh": lh, "steps": steps})
        return Point(1, "direction", FLAT, abs(up - down) * 100.0,
                     {"up": up, "down": down})

    def p2_momentum(self, seconds: int = 300) -> Point:
        """Speed and acceleration, scaled by this session's own movement.

        Scale-free: the raw point move is divided by the session's typical move,
        so the number means the same on NATURALGAS at 270 as on BANKNIFTY.
        """
        px = self._prices(seconds)
        if len(px) < 8:
            return Point(2, "momentum", note="not enough prints")
        half = len(px) // 2
        first, second = px[:half], px[half:]
        move_1 = first[-1] - first[0]
        move_2 = second[-1] - second[0]
        span = max(px) - min(px)
        if span <= 0:
            return Point(2, "momentum", 0.0, 0.0, {"span": 0.0})
        speed = abs(move_2) / span
        accel = (abs(move_2) - abs(move_1)) / span
        return Point(2, "momentum", round(speed * 100.0, 1),
                     _pct(speed, 0.0, 1.0),
                     {"move": move_2, "accel": round(accel, 4), "span": span})

    def p15_persistence(self, seconds: int = 900) -> Point:
        """Is the move continuing, weakening, or turning?"""
        d = self.p1_direction(seconds)
        if not d.available:
            return Point(15, "persistence", note=d.note)
        px = self._prices(seconds)
        half = len(px) // 2
        recent = px[half:]
        move_all = px[-1] - px[0]
        move_recent = recent[-1] - recent[0] if recent else 0.0
        if move_all == 0:
            return Point(15, "persistence", WEAKENING, 50.0)
        same_way = (move_all > 0) == (move_recent > 0)
        ratio = abs(move_recent) / abs(move_all)
        if not same_way:
            return Point(15, "persistence", REVERSAL, _pct(ratio, 0, 1),
                         {"move": move_all, "recent": move_recent})
        if ratio >= 0.4:
            return Point(15, "persistence", CONTINUATION, _pct(ratio, 0.4, 1.0),
                         {"ratio": round(ratio, 3)})
        return Point(15, "persistence", WEAKENING, _pct(1 - ratio, 0.6, 1.0),
                     {"ratio": round(ratio, 3)})

    # -- 3, 4: buyer and seller activity ---------------------------------

    def p3_buyers(self, seconds: int = 300) -> Point:
        fs = self.fut
        if fs is None:
            return Point(3, "buyer_activity", note="no futures flow")
        a = fs.aggression(seconds)
        if a["total_qty"] == 0:
            return Point(3, "buyer_activity", note="no prints in window")
        return Point(3, "buyer_activity", round(a["buy_share"] * 100.0, 1),
                     a["buy_share"] * 100.0,
                     {"qty": a["total_qty"], "prints": a["prints"]})

    def p4_sellers(self, seconds: int = 300) -> Point:
        fs = self.fut
        if fs is None:
            return Point(4, "seller_activity", note="no futures flow")
        a = fs.aggression(seconds)
        if a["total_qty"] == 0:
            return Point(4, "seller_activity", note="no prints in window")
        return Point(4, "seller_activity", round(a["sell_share"] * 100.0, 1),
                     a["sell_share"] * 100.0,
                     {"qty": a["total_qty"], "prints": a["prints"]})

    # -- 5-8: the price/OI table, per leg --------------------------------

    def _build_table(self, expiry: str | None = None) -> dict:
        """Points 5-8 for every leg, by BOTH definitions (spec 15 §5.3).

        On a futures contract the table is unambiguous. On an option strike it is
        not: a call premium rising with rising OI can be new buyers **or** writers
        selling into demand - the same two rows describe opposite participants.

        So both readings are produced:
          A  the broker convention, inferred from price direction alone
          B  the actual aggressor, from who crossed the spread on each print

        A disagreement is not an error. It is price implying buying while the
        aggressor was the writer, and that may be the interesting moment.
        """
        ch = self.chain
        exp = expiry or self._expiry()
        m = ch.expiry == exp
        out = {
            "long_buildup": {LEG_CONVENTION: 0, LEG_AGGRESSOR: 0},
            "short_buildup": {LEG_CONVENTION: 0, LEG_AGGRESSOR: 0},
            "long_unwind": {LEG_CONVENTION: 0, LEG_AGGRESSOR: 0},
            "short_cover": {LEG_CONVENTION: 0, LEG_AGGRESSOR: 0},
            "legs": 0, "disagreements": 0,
        }
        for i in np.flatnonzero(m):
            if ch.tick_count[i] == 0 or ch.oi_open[i] < 0:
                continue
            d_oi = int(ch.oi[i] - ch.oi_open[i])
            d_px = float(ch.ltp[i] - ch.day_open[i]) if ch.day_open[i] else 0.0
            if d_oi == 0 or d_px == 0.0:
                continue
            out["legs"] += 1
            qty = abs(d_oi)

            # A: price up + OI up = longs building; price down + OI up = writing.
            key_a = ("long_buildup" if (d_px > 0 and d_oi > 0) else
                     "short_buildup" if (d_px < 0 and d_oi > 0) else
                     "long_unwind" if (d_px < 0 and d_oi < 0) else "short_cover")
            out[key_a][LEG_CONVENTION] += qty

            # B: who was actually aggressive on this leg.
            fs = self.flow.get(int(ch.security_id[i]))
            if fs is None or not fs.prints:
                continue
            agg = fs.aggression(1800)
            aggressive_buy = agg["buy_share"] > agg["sell_share"]
            key_b = ("long_buildup" if (aggressive_buy and d_oi > 0) else
                     "short_buildup" if (not aggressive_buy and d_oi > 0) else
                     "long_unwind" if (not aggressive_buy and d_oi < 0)
                     else "short_cover")
            out[key_b][LEG_AGGRESSOR] += qty
            if key_a != key_b:
                out["disagreements"] += 1
        return out

    def p5_to_p8(self, expiry: str | None = None) -> list[Point]:
        t = self._build_table(expiry)
        if t["legs"] == 0:
            return [Point(n, name, note="no legs with both OI and price change")
                    for n, name in ((5, "long_buildup"), (6, "short_buildup"),
                                    (7, "long_unwind"), (8, "short_cover"))]
        total = sum(sum(t[k].values()) for k in
                    ("long_buildup", "short_buildup", "long_unwind", "short_cover"))
        points = []
        for n, key in ((5, "long_buildup"), (6, "short_buildup"),
                       (7, "long_unwind"), (8, "short_cover")):
            share = _safe_div(t[key][LEG_AGGRESSOR] * 2.0, total)
            points.append(Point(
                n, key, int(t[key][LEG_AGGRESSOR]), _pct(share, 0.0, 1.0),
                {"by_convention": int(t[key][LEG_CONVENTION]),
                 "by_aggressor": int(t[key][LEG_AGGRESSOR]),
                 "legs": t["legs"], "disagreements": t["disagreements"]},
                note=("the two definitions disagree on "
                      f"{t['disagreements']} of {t['legs']} legs"
                      if t["disagreements"] else "")))
        return points

    # -- 9, 10: support and resistance ----------------------------------

    def _levels(self, seconds: int = 1800) -> tuple[list[float], list[float]]:
        """Prices that were tested more than once, from the futures tape."""
        px = self._prices(seconds)
        if len(px) < 20:
            return [], []
        span = max(px) - min(px)
        if span <= 0:
            return [], []
        bucket = span / 20.0
        counts: dict[int, int] = {}
        for p in px:
            counts[int(p / bucket)] = counts.get(int(p / bucket), 0) + 1
        busy = sorted(counts.items(), key=lambda kv: -kv[1])[:6]
        levels = sorted((k + 0.5) * bucket for k, _ in busy)
        last = px[-1]
        return ([v for v in levels if v < last], [v for v in levels if v > last])

    def p9_support(self, seconds: int = 1800) -> Point:
        below, _ = self._levels(seconds)
        fs = self.fut
        if not below or fs is None:
            return Point(9, "support", note="no level found")
        level = below[-1]
        rej = fs.rejection(seconds)
        wall = self.chain.summary(self._expiry()).put_wall_strike
        return Point(9, "support", round(level, 2),
                     80.0 if rej["rejected_low"] else 40.0,
                     {"levels": [round(v, 2) for v in below],
                      "put_wall": wall, "rejected_low": rej["rejected_low"]})

    def p10_resistance(self, seconds: int = 1800) -> Point:
        _, above = self._levels(seconds)
        fs = self.fut
        if not above or fs is None:
            return Point(10, "resistance", note="no level found")
        level = above[0]
        rej = fs.rejection(seconds)
        wall = self.chain.summary(self._expiry()).call_wall_strike
        return Point(10, "resistance", round(level, 2),
                     80.0 if rej["rejected_high"] else 40.0,
                     {"levels": [round(v, 2) for v in above],
                      "call_wall": wall, "rejected_high": rej["rejected_high"]})

    # -- 11, 12, 13: OI map, strike and expiry migration ----------------

    def p11_oi_map(self, expiry: str | None = None) -> Point:
        """Change in open interest at every strike. A ladder, not one number."""
        ch = self.chain
        exp = expiry or self._expiry()
        m = ch.expiry == exp
        if not m.any():
            return Point(11, "oi_map", note="no legs")
        rows = []
        for k in np.unique(ch.strike[m]):
            entry: dict = {"strike": float(k)}
            for side, flag in (("ce", True), ("pe", False)):
                sel = m & (ch.strike == k) & (ch.is_call == flag)
                if sel.any():
                    i = int(np.flatnonzero(sel)[0])
                    entry[side] = {"oi": int(ch.oi[i]),
                                   "change": int(ch.oi_change[i])}
            rows.append(entry)
        moved = sum(abs(r.get(s, {}).get("change", 0))
                    for r in rows for s in ("ce", "pe"))
        return Point(11, "oi_map", rows, None, {"total_abs_change": moved})

    def p12_strike_migration(self, expiry: str | None = None,
                             top: int = 3) -> Point:
        """Where open interest left and where it went.

        Positioning moving BETWEEN strikes is the thing D5 refused to risk missing
        by watching only a band around the money - measured 2026-09-24, a crude
        put 4,040 points out of the money carried 499 OI and 682 candles.
        """
        ch = self.chain
        exp = expiry or self._expiry()
        m = ch.expiry == exp
        gained, lost = [], []
        for i in np.flatnonzero(m):
            if ch.oi_open[i] < 0:
                continue
            chg = int(ch.oi_change[i])
            if chg == 0:
                continue
            row = {"strike": float(ch.strike[i]),
                   "side": "CE" if bool(ch.is_call[i]) else "PE",
                   "change": chg}
            (gained if chg > 0 else lost).append(row)
        if not gained and not lost:
            return Point(12, "strike_migration", note="no OI change yet")
        gained.sort(key=lambda r: -r["change"])
        lost.sort(key=lambda r: r["change"])
        moves = [{"from": a["strike"], "to": b["strike"], "side": b["side"],
                  "size": min(abs(a["change"]), b["change"])}
                 for a, b in zip(lost[:top], gained[:top])]
        return Point(12, "strike_migration", moves,
                     _pct(len(moves), 0, top),
                     {"gained": gained[:top], "lost": lost[:top]})

    def p13_expiry_migration(self) -> Point:
        """Which expiry the flow went to. Needs more than one expiry to exist.

        Returns None with a reason for banknifty, crude and gas: they have no
        weekly, so there is no week-to-month move to detect (D11/D19).
        """
        ch = self.chain
        if len(ch.expiries) < 2:
            return Point(13, "expiry_migration",
                         note="only one expiry watched - nothing to compare")
        by_expiry = []
        for e in ch.expiries:
            m = ch.expiry == e
            chg = int(np.abs(ch.oi_change[m]).sum())
            vol = int(ch.volume[m].sum())
            by_expiry.append({"exp": e, "abs_oi_change": chg, "volume": vol})
        total = sum(b["volume"] for b in by_expiry)
        if total == 0:
            return Point(13, "expiry_migration", note="no volume yet")
        for b in by_expiry:
            b["volume_share"] = round(_safe_div(b["volume"], total), 4)
        leader = max(by_expiry, key=lambda b: b["volume"])
        return Point(13, "expiry_migration", leader["exp"],
                     leader["volume_share"] * 100.0, {"by_expiry": by_expiry})

    # -- 14: volatility state -------------------------------------------

    def p14_volatility(self, seconds: int = 900) -> Point:
        px = self._prices(seconds)
        if len(px) < 20:
            return Point(14, "volatility", note="not enough prints")
        half = len(px) // 2
        r1 = max(px[:half]) - min(px[:half])
        r2 = max(px[half:]) - min(px[half:])
        if r1 <= 0:
            return Point(14, "volatility", NEUTRAL, 0.0)
        ratio = r2 / r1
        state = (EXPANSION if ratio > 1.3 else
                 CONTRACTION if ratio < 0.7 else NEUTRAL)
        sm = self.chain.summary(self._expiry())
        return Point(14, "volatility", state,
                     _pct(abs(math.log(max(ratio, 1e-9))), 0.0, 1.0),
                     {"range_ratio": round(ratio, 3),
                      "atm_iv": None if sm.atm_iv != sm.atm_iv else sm.atm_iv})

    # -- 16, 17, 18: breakout, false breakout, pullback -----------------

    def p16_breakout_ready(self, seconds: int = 900) -> Point:
        """Evidence BEFORE a breakout: a tight range with flow leaning one way."""
        vol = self.p14_volatility(seconds)
        px = self._prices(seconds)
        fs = self.fut
        if not vol.available or fs is None or len(px) < 20:
            return Point(16, "breakout_ready", note="not enough prints")
        a = fs.aggression(seconds)
        lean = abs(a["buy_share"] - a["sell_share"])
        compressing = vol.value == CONTRACTION
        score = _pct(lean, 0.0, 0.6) * (1.0 if compressing else 0.5)
        state = (READY if score >= 60 else
                 BUILDING if score >= 30 else NOT_READY)
        return Point(16, "breakout_ready", state, score,
                     {"compressing": compressing, "lean": round(lean, 3)})

    def p17_false_breakout(self, seconds: int = 300) -> Point:
        """Did price hold beyond the level, or come straight back?"""
        fs = self.fut
        if fs is None:
            return Point(17, "false_breakout", note="no futures flow")
        rej = fs.rejection(seconds)
        px = self._prices(seconds)
        if len(px) < 10:
            return Point(17, "false_breakout", note="not enough prints")
        if rej["rejected_high"] or rej["rejected_low"]:
            return Point(17, "false_breakout", FALSE, 80.0, dict(rej))
        hi, lo, last = max(px), min(px), px[-1]
        span = hi - lo
        if span <= 0:
            return Point(17, "false_breakout", SUSPECT, 50.0)
        near_edge = min(abs(last - hi), abs(last - lo)) / span
        if near_edge <= 0.1:
            return Point(17, "false_breakout", CONFIRMED,
                         _pct(1 - near_edge, 0.9, 1.0), {"near_edge": near_edge})
        return Point(17, "false_breakout", SUSPECT, 50.0,
                     {"near_edge": round(near_edge, 3)})

    def p18_pullback(self, seconds: int = 900) -> Point:
        px = self._prices(seconds)
        if len(px) < 20:
            return Point(18, "pullback", note="not enough prints")
        peak = max(px)
        trough = min(px)
        last = px[-1]
        up_leg = peak - px[0]
        down_leg = px[0] - trough
        if abs(up_leg) >= abs(down_leg) and up_leg > 0:
            retrace = _safe_div(peak - last, up_leg)
        elif down_leg > 0:
            retrace = _safe_div(last - trough, down_leg)
        else:
            return Point(18, "pullback", NORMAL, 50.0)
        strength = (WEAK if retrace < 0.33 else
                    NORMAL if retrace < 0.66 else STRONG)
        return Point(18, "pullback", strength, _pct(retrace, 0.0, 1.0),
                     {"retrace": round(retrace, 3)})

    # -- 19, 20: entry timing and confirmation --------------------------

    def p19_timing(self) -> Point:
        """Do the short and long clocks agree? Alignment, not prediction."""
        dirs = [self.p1_direction(w).value for w in (60, 300, 900)]
        known = [d for d in dirs if d]
        if len(known) < 2:
            return Point(19, "entry_timing", note="not enough prints")
        agree = len(set(known)) == 1
        score = 100.0 if agree else _pct(
            max(known.count(x) for x in set(known)) / len(known), 0.33, 1.0)
        quality = (STRONG if agree and known[0] != FLAT else
                   ACCEPTABLE if score >= 60 else POOR)
        return Point(19, "entry_timing", quality, score,
                     {"by_window": {w: d for w, d in zip((60, 300, 900), dirs)}})

    def p20_confirmation(self, seconds: int = 120) -> Point:
        """Has the reading HELD, or did it just appear?

        Rule 15 of the flow layer, applied to the direction. A single tick is not
        a signal: an earlier design exited on a bare sign change when the flow
        measure flipped 762 times in one day.
        """
        fs = self.fut
        d = self.p1_direction(seconds)
        if fs is None or not d.available:
            return Point(20, "confirmation", note="not enough prints")
        held = fs.confirm(f"dir_{d.value}", d.value in (UP, DOWN))
        return Point(20, "confirmation",
                     CONFIRMED if held else BUILDING if d.value != FLAT else NOT_READY,
                     100.0 if held else 40.0,
                     {"direction": d.value,
                      "held_for": round(fs.held_for(f"dir_{d.value}"), 1)})

    # -- 21, 22, 23: absorption, exhaustion, liquidity ------------------

    def p21_absorption(self, seconds: int = 300) -> Point:
        fs = self.fut
        if fs is None:
            return Point(21, "absorption", note="no futures flow")
        ab = fs.absorption(seconds)
        if ab["buyer_absorbed"]:
            return Point(21, "absorption", "BUYERS_ABSORBED", 75.0, dict(ab))
        if ab["seller_absorbed"]:
            return Point(21, "absorption", "SELLERS_ABSORBED", 75.0, dict(ab))
        return Point(21, "absorption", "NONE", 0.0, dict(ab))

    def p22_exhaustion(self, seconds: int = 600) -> Point:
        fs = self.fut
        if fs is None:
            return Point(22, "exhaustion", note="no futures flow")
        ex = fs.exhaustion(seconds)
        return Point(22, "exhaustion", bool(ex["exhausted"]),
                     _pct(1.0 - ex["flow_ratio"], 0.4, 1.0) if ex["flow_ratio"]
                     else None, dict(ex))

    def p23_liquidity(self) -> Point:
        fs = self.fut
        if fs is None:
            return Point(23, "liquidity", note="no futures flow")
        d = fs.depth()
        liq = fs.liquidity_removed()
        if not d["valid"]:
            return Point(23, "liquidity", note="no book")
        spread = d["spread"]
        px = self._prices(60)
        rel = _safe_div(spread, px[-1]) if px else 0.0
        quality = "GOOD" if rel < 0.001 else "FAIR" if rel < 0.003 else "POOR"
        return Point(23, "liquidity", quality,
                     _pct(1.0 - min(rel / 0.003, 1.0), 0.0, 1.0),
                     {"spread": spread, "relative": round(rel, 6),
                      "bid_depth": d["bid_depth"], "ask_depth": d["ask_depth"],
                      "imbalance": round(fs.imbalance(), 3), **liq})

    # -- 24: big-player footprint ---------------------------------------

    def p24_footprint(self, seconds: int = 900) -> Point:
        """Unusual size, bursts, absorption and OI shifts together.

        **Never claims participant identity** (spec 15 point 24). It says the
        footprint is large, not who left it.
        """
        fs = self.fut
        if fs is None:
            return Point(24, "footprint", note="no futures flow")
        ps = fs.print_size(seconds)
        ab = fs.absorption(seconds)
        mig = self.p12_strike_migration()
        signals = 0
        if ps["large_share"] > 0.3:
            signals += 1
        if ab["buyer_absorbed"] or ab["seller_absorbed"]:
            signals += 1
        if mig.available and mig.value:
            signals += 1
        if abs(fs.imbalance()) > 0.5:
            signals += 1
        return Point(24, "footprint", signals, _pct(signals, 0, 4),
                     {"large_share": round(ps["large_share"], 3),
                      "absorption": ab["buyer_absorbed"] or ab["seller_absorbed"],
                      "migration": bool(mig.value) if mig.available else False,
                      "imbalance": round(fs.imbalance(), 3)},
                     note="size only - never participant identity")

    # -- 25: the verdict ------------------------------------------------

    def p25_decision(self, points: dict[int, Point] | None = None) -> Point:
        """TRADE / NO TRADE, with the reason - and with no authority to size.

        Spec 15 §5.5: before this sizes any capital it must clear >=60
        out-of-sample days, a majority of months positive judged independently,
        survival of removing the top 3 trades, no look-ahead, and not being
        explained by market direction. Rules-based directional entry has already
        failed three independent measurements.

        So the verdict is produced and **recorded** (kind D) to be scored later.
        `advisory` is True always, and nothing downstream may treat it otherwise.
        """
        pts = points or self.all()
        reasons: list[str] = []

        d = pts.get(1)
        t = pts.get(19)
        c = pts.get(20)
        ab = pts.get(21)
        ex = pts.get(22)
        lq = pts.get(23)

        direction = d.value if d and d.available else None
        if direction in (None, FLAT):
            reasons.append("no clear direction")
        if t and t.available and t.value == POOR:
            reasons.append("clocks disagree")
        if c and c.available and c.value != CONFIRMED:
            reasons.append("direction not confirmed yet")
        if ab and ab.available and ab.value != "NONE":
            reasons.append(f"{ab.value.lower().replace('_', ' ')}")
        if ex and ex.available and ex.value:
            reasons.append("flow exhausting")
        if lq and lq.available and lq.value == "POOR":
            reasons.append("spread too wide to trade")

        verdict = NO_TRADE if reasons else TRADE
        strike = None
        if verdict == TRADE and direction in (UP, DOWN):
            sm = self.chain.summary(self._expiry())
            strike = {"strike": sm.atm_strike,
                      "side": "CE" if direction == UP else "PE",
                      "expiry": self._expiry()}

        scores = [p.score for p in pts.values()
                  if p.score is not None and p.n in (1, 2, 19, 20)]
        confidence = round(statistics.mean(scores), 1) if scores else 0.0
        return Point(25, "decision", verdict, confidence,
                     {"direction": direction, "strike": strike,
                      "reasons": reasons or ["all gates clear"],
                      "advisory": True},
                     note="ADVISORY ONLY - spec 15 §5.5 bar not yet cleared")

    # -- everything ------------------------------------------------------

    def all(self, window: int = 300) -> dict[int, Point]:
        """All 25 points. Point 25 is computed from the other 24."""
        pts: dict[int, Point] = {}
        for p in (self.p1_direction(window), self.p2_momentum(window),
                  self.p3_buyers(window), self.p4_sellers(window)):
            pts[p.n] = p
        for p in self.p5_to_p8():
            pts[p.n] = p
        for p in (self.p9_support(), self.p10_resistance(), self.p11_oi_map(),
                  self.p12_strike_migration(), self.p13_expiry_migration(),
                  self.p14_volatility(), self.p15_persistence(),
                  self.p16_breakout_ready(), self.p17_false_breakout(),
                  self.p18_pullback(), self.p19_timing(), self.p20_confirmation(),
                  self.p21_absorption(), self.p22_exhaustion(),
                  self.p23_liquidity(), self.p24_footprint()):
            pts[p.n] = p
        pts[25] = self.p25_decision(pts)
        return pts

    def record(self, window: int = 300) -> dict:
        """Kind D's row: what the analyser said, at this moment (D28).

        Written even when the verdict is NO TRADE - the rejected setups are half
        the evidence, and without them the 25 points can never be scored.
        """
        pts = self.all(window)
        return {
            "window": window,
            "points": {p.n: {"name": p.name, "value": p.value, "score": p.score,
                             "note": p.note} for p in pts.values()},
            "verdict": pts[25].value,
            "confidence": pts[25].score,
            "reasons": pts[25].detail.get("reasons", []),
            "advisory": True,
        }
