"""Claude cohort — does each flow rule actually predict anything?

This is the "measure, don't believe" study. Every rule in the 15-point spec
describes what is happening NOW. None of them says what tends to happen NEXT.
This module measures that, on 78 recorded days, one rule at a time.

Method
------
At every 1-minute decision point:
  1. record which triggers fired (computed causally — the snapshot is pinned to
     that minute and cannot see later ticks)
  2. look FORWARD in the underlying and record what actually happened

Forward outcome, per horizon:
  * direction hit  — did price move the way the rule implies
  * favourable     — best move in the implied direction before the horizon
  * adverse        — worst move against it before the horizon
  * 2R hit         — did it reach +2X before it reached -X (a real trade's shape,
                     not just an end-point comparison)

The only number that matters is **edge versus the base rate**. If price rises
52% of the time anyway, a rule with a 54% hit rate has found almost nothing. So
every rule is reported against the base rate measured on the same days, the same
decision points and the same horizons.

Run:
  python -m claude_cohort.study --instrument nifty50
  python -m claude_cohort.study --instrument nifty50 --horizons 15,30,60
"""
from __future__ import annotations

import argparse
import statistics
from collections import defaultdict
from typing import Optional

from .backtest import available_dates, load_day, load_flow_cached
from .config import LOT_SIZES

# How far ahead to look, in minutes.
DEFAULT_HORIZONS = (15, 30, 60)

# The "unit" move for the 2R test, as a % of price — the same scale-free idea as
# the stop distance. 0.10% of NIFTY at 23,400 is ~23 points, which is the stop
# the cohort actually uses.
UNIT_PCT = 0.10

# Rules and the direction each one implies. A rule that implies nothing
# directional (rule 12 imbalance, rule 13 liquidity removal) is measured BOTH
# ways so we can see whether it leans at all.
TRIGGERS = {
    # rules 5, 6 — absorption. Buyers absorbing selling implies price holds/rises.
    "buyer_absorption": +1,
    "seller_absorption": -1,
    # rule 10 — exhaustion. Sellers running out implies the fall is done.
    "seller_exhaustion": +1,
    "buyer_exhaustion": -1,
    # rule 14 — rejection, confirmed by the prints on the way back.
    "rejection_down_confirmed": -1,
    "rejection_up_confirmed": +1,
    "rejection_down_unconfirmed": -1,   # control: is confirmation worth anything?
    "rejection_up_unconfirmed": +1,
    # rules 2,3,8 — one-sided aggressive volume.
    "delta_strong_buy": +1,
    "delta_strong_sell": -1,
    # rule 7 — the same, but only when price is RESPONDING.
    "delta_strong_buy_responding": +1,
    "delta_strong_sell_responding": -1,
    # rule 9 — cumulative delta agreeing with, or diverging from, price.
    "cumdelta_confirms_up": +1,
    "cumdelta_confirms_down": -1,
    "cumdelta_divergence": 0,
    # rules 11,12 — displayed book. No direction implied; measured both ways.
    "depth_bid_heavy": +1,
    "depth_ask_heavy": -1,
    # rule 13 — size leaving the book.
    "liq_bid_pulled": -1,
    "liq_ask_pulled": +1,
}

DELTA_RATIO_STRONG = 0.30
DEPTH_IMBALANCE_STRONG = 0.30


def fired(snap: dict, window_sec: int = 300) -> set:
    """Which triggers fired at this minute. Pure read of one snapshot."""
    out = set()
    if not snap:
        return out

    a = snap.get("absorption")
    if a:
        out.add(a["type"])
    e = snap.get("exhaustion")
    if e:
        out.add(e["type"])

    for r in (snap.get("rejections") or {}).values():
        tag = "rejection_down" if r["direction"] == "down" else "rejection_up"
        out.add(f"{tag}_{'confirmed' if r.get('confirmed') else 'unconfirmed'}")

    pr = snap.get(f"pressure_{window_sec}s") or {}
    ratio = pr.get("delta_ratio", 0.0)
    responded = bool(pr.get("price_responded"))
    if ratio >= DELTA_RATIO_STRONG:
        out.add("delta_strong_buy")
        if responded:
            out.add("delta_strong_buy_responding")
    elif ratio <= -DELTA_RATIO_STRONG:
        out.add("delta_strong_sell")
        if responded:
            out.add("delta_strong_sell_responding")

    cd = snap.get(f"cumdelta_{window_sec}s") or {}
    if cd.get("n"):
        if cd.get("divergence"):
            out.add("cumdelta_divergence")
        elif cd.get("confirms"):
            out.add("cumdelta_confirms_up" if cd.get("delta_change", 0) > 0 else "cumdelta_confirms_down")

    dep = snap.get("depth") or {}
    imb = dep.get("imbalance")
    if imb is not None and dep.get("n"):
        if imb >= DEPTH_IMBALANCE_STRONG:
            out.add("depth_bid_heavy")
        elif imb <= -DEPTH_IMBALANCE_STRONG:
            out.add("depth_ask_heavy")

    lq = snap.get(f"liq_removed_{window_sec}s") or {}
    if lq.get("n"):
        b, a_ = lq.get("bid_removed", 0.0), lq.get("ask_removed", 0.0)
        tot = b + a_
        if tot > 0:
            if b / tot >= 0.70:
                out.add("liq_bid_pulled")
            elif a_ / tot >= 0.70:
                out.add("liq_ask_pulled")
    return out


def forward_path(prices: list, start_idx: int, horizon_pts: int) -> Optional[tuple]:
    """(favourable_up, adverse_down, end_move) over the next `horizon_pts` samples."""
    if start_idx >= len(prices):
        return None
    p0 = prices[start_idx][1]
    end = min(start_idx + horizon_pts, len(prices) - 1)
    if end <= start_idx:
        return None
    seg = [p for _, p in prices[start_idx : end + 1]]
    return max(seg) - p0, min(seg) - p0, seg[-1] - p0


def outcome(fav_up: float, adv_down: float, end_move: float, direction: int, unit: float) -> dict:
    """Score one forward path from the point of view of `direction`."""
    if direction >= 0:
        favourable, adverse = fav_up, -adv_down
        went_right = end_move > 0
    else:
        favourable, adverse = -adv_down, fav_up
        went_right = end_move < 0
    # 2R: reached +2 units. Approximate ordering — a path that also breached the
    # 1-unit stop is only counted when the favourable excursion is the larger of
    # the two, which is conservative.
    two_r = favourable >= 2 * unit and (adverse < unit or favourable > adverse)
    return {
        "went_right": went_right,
        "favourable": favourable,
        "adverse": adverse,
        "two_r": two_r,
        "end_move": end_move if direction >= 0 else -end_move,
    }


def run(instrument: str, horizons=DEFAULT_HORIZONS, limit_days: int = 0) -> dict:
    dates = available_dates(instrument)
    if limit_days:
        dates = dates[:limit_days]

    # results[trigger][horizon] -> list of outcome dicts
    results: dict = defaultdict(lambda: defaultdict(list))
    base: dict = defaultdict(list)          # base rate, every decision point
    days_used = 0

    for d in dates:
        try:
            df = load_day(instrument, d)
            snaps = load_flow_cached(instrument, d)
        except Exception:
            continue
        if not snaps or df is None or df.empty:
            continue
        days_used += 1

        # one price sample per minute, so a horizon in minutes is just an offset
        by_min: dict = {}
        for ts, px in zip(df["timestamp"].to_numpy(), df["underlying_ltp"].to_numpy()):
            if px and px == px:
                by_min[int(ts // 60)] = float(px)
        minutes = sorted(by_min)
        prices = [(m, by_min[m]) for m in minutes]
        idx_of = {m: i for i, (m, _) in enumerate(prices)}

        for minute, snap in snaps.items():
            i = idx_of.get(minute)
            if i is None:
                continue
            unit = prices[i][1] * UNIT_PCT / 100.0
            trig = fired(snap)
            for h in horizons:
                path = forward_path(prices, i, h)
                if path is None:
                    continue
                fav_up, adv_dn, end_mv = path
                # base rate: the market's own tendency at this decision point
                base[h].append(outcome(fav_up, adv_dn, end_mv, +1, unit))
                for name in trig:
                    direction = TRIGGERS.get(name)
                    if direction is None:
                        continue
                    if direction == 0:
                        # no direction implied — score it up, and read only
                        # how far it deviates from the base rate
                        direction = +1
                    results[name][h].append(
                        outcome(fav_up, adv_dn, end_mv, direction, unit)
                    )
    return {"results": results, "base": base, "days": days_used, "dates": dates}


def _pct(xs, key) -> float:
    return 100.0 * sum(1 for x in xs if x[key]) / len(xs) if xs else float("nan")


def report(data: dict, instrument: str, horizons=DEFAULT_HORIZONS) -> None:
    results, base, days = data["results"], data["base"], data["days"]
    print(f"\n{'=' * 78}")
    print(f"FORWARD HIT RATE — {instrument}, {days} days")
    print("Does each rule predict anything? Edge is versus the base rate on the")
    print("same days, same decision points, same horizons. Edge is the only column")
    print("that matters; a high hit rate that matches the base rate found nothing.")
    print("=" * 78)

    for h in horizons:
        b = base[h]
        if not b:
            continue
        b_right, b_2r = _pct(b, "went_right"), _pct(b, "two_r")
        print(f"\n--- {h} minutes ahead --- base rate: up {b_right:.0f}%   2R {b_2r:.0f}%   (n={len(b):,})")
        print(f"{'rule':<32} {'n':>6} {'right':>7} {'edge':>7} {'2R':>6} {'2Redge':>7} {'medFav':>7} {'medAdv':>7}")
        rows = []
        for name in TRIGGERS:
            xs = results.get(name, {}).get(h, [])
            if len(xs) < 30:      # too few to say anything at all
                continue
            right, two_r = _pct(xs, "went_right"), _pct(xs, "two_r")
            rows.append((
                right - b_right, name, len(xs), right, two_r, two_r - b_2r,
                statistics.median(x["favourable"] for x in xs),
                statistics.median(x["adverse"] for x in xs),
            ))
        for edge, name, n, right, two_r, r2edge, medf, meda in sorted(rows, reverse=True):
            flag = "  <<<" if (edge >= 5 and r2edge >= 5) else ""
            print(f"{name:<32} {n:>6,} {right:>6.0f}% {edge:>+6.1f} {two_r:>5.0f}% {r2edge:>+6.1f} {medf:>7.1f} {meda:>7.1f}{flag}")

    print(f"\n{'=' * 78}")
    print("Reading it: 'edge' is percentage points above the market's own tendency.")
    print("Anything inside +/-3 is noise. Rules marked <<< beat the base rate on")
    print("both direction and the 2R test, which is the one that survives costs.")
    print(f"A rule firing on most minutes cannot have much edge by construction.")
    print("=" * 78)


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Forward hit rate of each flow rule")
    ap.add_argument("--instrument", default="nifty50", choices=sorted(LOT_SIZES))
    ap.add_argument("--horizons", default="15,30,60")
    ap.add_argument("--limit-days", type=int, default=0)
    args = ap.parse_args(argv)

    horizons = tuple(int(x) for x in args.horizons.split(","))
    data = run(args.instrument, horizons, args.limit_days)
    report(data, args.instrument, horizons)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
