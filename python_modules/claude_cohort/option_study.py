"""Futures flow versus option flow - which gives the better signal, rule by rule?

Partha 2026-09-19: the Market Status Screen computes all 15 order-flow rules
from the FUTURES tape. Would the OPTION tape give a more accurate signal?

This runs both side by side on the same days, the same decision points and the
same forward test, so the only thing that differs is where the flow comes from.

  futures flow   exactly what the screen uses today: every futures packet,
                 classified at the bid or ask
  option flow    every option trade within ATM +/-3 strikes, classified at the
                 bid or ask, then DELTA-WEIGHTED into underlying-equivalent
                 quantity and signed:

                     buy call  -> +   sell call -> -
                     buy put   -> -   sell put  -> +

                 one formula (side x quantity x signed delta) handles every
                 case. Summing raw option quantities instead would treat 10,000
                 contracts of a Rs 2 far option the same as 10,000 of a Rs 200
                 ATM option.

In BOTH cases the price used for "did price respond", levels and rejection is
the underlying futures price. So a difference in edge is attributable to the
flow source alone.

Rules 11-13 (depth, imbalance, liquidity removal) are properties of a single
order book and are not tested on the option side.

Delta: Black-Scholes, IV from the nearest preceding chain snapshot, spot from
the same snapshot, time to the chain's expiry at 15:30. Weekly options were
verified on 2026-09-18 to price around spot, not futures, so spot is the right
input here.

Run:
  python -m claude_cohort.option_study                 # all available days
  python -m claude_cohort.option_study --limit-days 3  # quick check
"""
from __future__ import annotations

import argparse
import bisect
import glob
import gzip
import math
import os
import time
import zlib
from collections import defaultdict
from datetime import datetime

try:
    import orjson as _json
    _loads = _json.loads
except ImportError:          # pragma: no cover
    import json as _json
    _loads = _json.loads

from .flow import FlowState, classify
from .study import TRIGGERS, fired, forward_path, outcome

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RAW = os.path.join(_ROOT, "data", "raw")
OUT = os.path.join(_ROOT, "data", "claude_cohort", "option_study.txt")

HORIZONS = (15, 30, 60)
BAND_STRIKES = 3             # ATM +/- this many strikes
STRIKE_STEP = 50             # nifty50
BUCKET_SEC = 5               # option trades aggregated per 5 s, bull and bear separately
RISK_FREE = 0.065
UNIT_PCT = 0.10              # same 2R unit as study.py
# 2026-09-18: recorder stopped at 10:00 and left a corrupt member; exclude.
EXCLUDE = {"2026-09-18"}


def _ncdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_delta(spot: float, strike: float, t_years: float, iv_pct: float, is_call: bool) -> float:
    """Signed Black-Scholes delta. Calls in [0, 1], puts in [-1, 0]."""
    if spot <= 0 or strike <= 0 or t_years <= 0 or iv_pct <= 0:
        # Fall back to a moneyness step rather than dropping the trade.
        itm = spot > strike if is_call else spot < strike
        d = 0.75 if itm else 0.25
        return d if is_call else -d
    sig = iv_pct / 100.0
    d1 = (math.log(spot / strike) + (RISK_FREE + 0.5 * sig * sig) * t_years) / (sig * math.sqrt(t_years))
    nd = _ncdf(d1)
    return nd if is_call else nd - 1.0


def _iter_gz(path: str):
    """Stream lines. Corrupt tails are tolerated (a whole-file decode of a
    700 MB option file would not fit in memory, so gz_reader is not used here;
    the one known corrupt nifty day is excluded instead)."""
    try:
        with gzip.open(path, "rb") as fh:
            for line in fh:
                yield line
    except (EOFError, zlib.error, OSError):
        return


def load_chain(day: str):
    """[(ts, spot, expiry_epoch, {(strike, 'CE'|'PE'): iv})] sorted by ts."""
    out = []
    for line in _iter_gz(os.path.join(RAW, day, "nifty50_chain_snapshots.ndjson.gz")):
        try:
            d = _loads(line)
        except Exception:
            continue
        try:
            exp = datetime.strptime(d["expiry"], "%Y-%m-%d").replace(hour=15, minute=30).timestamp()
        except Exception:
            continue
        ivs = {}
        for r in d.get("rows", []):
            k = float(r["strike"])
            if r.get("callIV"):
                ivs[(k, "CE")] = float(r["callIV"])
            if r.get("putIV"):
                ivs[(k, "PE")] = float(r["putIV"])
        out.append((float(d["recv_ts"]), float(d.get("spotPrice") or 0), exp, ivs))
    out.sort(key=lambda x: x[0])
    return out


def load_futures(day: str):
    ticks = []
    for line in _iter_gz(os.path.join(RAW, day, "nifty50_underlying_ticks.ndjson.gz")):
        try:
            t = _loads(line)
        except Exception:
            continue
        if t.get("recv_ts") and t.get("ltp"):
            ticks.append(t)
    ticks.sort(key=lambda t: t["recv_ts"])
    return ticks


def option_buckets(day: str, chain, fut_ts, fut_px):
    """{bucket: [bull_qty, bear_qty, last_ts]} of delta-weighted option flow."""
    chain_ts = [c[0] for c in chain]
    prev_vol: dict = {}
    buckets: dict = defaultdict(lambda: [0.0, 0.0, 0.0])
    for line in _iter_gz(os.path.join(RAW, day, "nifty50_option_ticks.ndjson.gz")):
        # Cheap reject before a full parse: most lines are far strikes.
        try:
            t = _loads(line)
        except Exception:
            continue
        ts = t.get("recv_ts")
        k = t.get("strike")
        typ = t.get("opt_type")
        vol = t.get("volume")
        if ts is None or k is None or typ not in ("CE", "PE") or vol is None:
            continue
        key = (float(k), typ)
        pv = prev_vol.get(key)
        prev_vol[key] = vol
        if pv is None or vol <= pv:
            continue
        dv = vol - pv
        i = bisect.bisect_right(chain_ts, ts) - 1
        if i < 0:
            continue
        _, spot, exp, ivs = chain[i]
        if abs(key[0] - spot) > BAND_STRIKES * STRIKE_STEP:
            continue
        side = classify(float(t.get("ltp") or 0), float(t.get("bid") or 0), float(t.get("ask") or 0))
        if side == 0:
            continue
        d = bs_delta(spot, key[0], (exp - ts) / (365.0 * 86400.0), ivs.get(key, 0.0), typ == "CE")
        eff = side * dv * d
        b = buckets[int(ts // BUCKET_SEC)]
        if eff > 0:
            b[0] += eff
        else:
            b[1] += -eff
        b[2] = max(b[2], ts)
    return buckets


# "Strong" must be relative to each source's OWN distribution. Measured on
# 2026-09-17 at the 5m window:
#
#               median |delta_ratio|   p80    share above a fixed 0.30
#     futures        0.27              0.45        43%
#     options        0.07              0.13         1%
#
# Option flow is naturally far more balanced - calls against puts, and market
# makers on the other side. study.py's fixed 0.30 would fire on 43% of futures
# minutes and 1% of option minutes, so the comparison would measure the
# threshold, not the market. Both sources therefore use the same adaptive rule:
# top 20% of what THAT source has shown earlier in the session. Causal - the
# current reading is judged against history, then added to it.
STRONG_PCTILE = 0.80
MIN_HISTORY = 30
ADAPTIVE = {"delta_strong_buy", "delta_strong_sell", "delta_strong_buy_responding",
            "delta_strong_sell_responding", "buyer_absorption", "seller_absorption"}


def _pctile(xs: list, p: float) -> float:
    ys = sorted(xs)
    return ys[min(len(ys) - 1, int(p * len(ys)))]


def fired_fair(fs: FlowState, hist: dict, now: float) -> set:
    """study.fired, with the two fixed-threshold rules made relative to source."""
    snap = fs.snapshot(now=now)
    out = {n for n in fired(snap) if n not in ADAPTIVE}

    pr = snap.get("pressure_300s") or {}
    if pr.get("n"):
        ratio = pr.get("delta_ratio", 0.0)
        rh = hist["ratio"]
        if len(rh) >= MIN_HISTORY:
            thr = _pctile(rh, STRONG_PCTILE)
            responded = bool(pr.get("price_responded"))
            if ratio >= thr:
                out.add("delta_strong_buy")
                if responded:
                    out.add("delta_strong_buy_responding")
            elif ratio <= -thr:
                out.add("delta_strong_sell")
                if responded:
                    out.add("delta_strong_sell_responding")
        rh.append(abs(ratio))

    p2 = fs.pressure(120.0, now) or {}
    tot = p2.get("buy_qty", 0.0) + p2.get("sell_qty", 0.0)
    if tot > 0:
        share = max(p2["buy_qty"], p2["sell_qty"]) / tot
        sh = hist["share"]
        if len(sh) >= MIN_HISTORY:
            a = fs.absorption(sec=120.0, min_side_share=_pctile(sh, STRONG_PCTILE), now=now)
            if a:
                out.add(a["type"])
        sh.append(share)
    return out


def run_day(day: str, res: dict, base: dict) -> bool:
    chain = load_chain(day)
    fut = load_futures(day)
    if len(chain) < 20 or len(fut) < 500:
        return False
    fut_ts = [t["recv_ts"] for t in fut]
    fut_px = [t["ltp"] for t in fut]

    buckets = option_buckets(day, chain, fut_ts, fut_px)
    opt_events = []
    for bk, (bull, bear, _) in buckets.items():
        ts = (bk + 1) * BUCKET_SEC
        j = bisect.bisect_right(fut_ts, ts) - 1
        if j < 0:
            continue
        opt_events.append((ts, bull, bear, fut_px[j]))
    opt_events.sort()

    # one futures price per minute, for the forward test (same as study.py)
    by_min: dict = {}
    for ts, px in zip(fut_ts, fut_px):
        by_min[int(ts // 60)] = float(px)
    minutes = sorted(by_min)
    prices = [(m, by_min[m]) for m in minutes]
    idx_of = {m: i for i, (m, _) in enumerate(prices)}

    ff, fo = FlowState(), FlowState()
    hist = {"futures": {"ratio": [], "share": []}, "options": {"ratio": [], "share": []}}
    fi = oi = 0
    for m in minutes:
        cut = (m + 1) * 60
        while fi < len(fut) and fut[fi]["recv_ts"] < cut:
            ff.on_tick(fut[fi]); fi += 1
        while oi < len(opt_events) and opt_events[oi][0] < cut:
            ts, bull, bear, px = opt_events[oi]
            fo.on_print(ts, +1, bull, px)
            fo.on_print(ts + 0.001, -1, bear, px)
            oi += 1
        if fi < 50 or oi < 10:
            continue
        i = idx_of[m]
        unit = prices[i][1] * UNIT_PCT / 100.0
        paths = {h: forward_path(prices, i, h) for h in HORIZONS}
        for h, path in paths.items():
            if path:
                base[h].append(outcome(*path, +1, unit))
        for src, fs in (("futures", ff), ("options", fo)):
            for name in fired_fair(fs, hist[src], float(cut)):
                direction = TRIGGERS.get(name)
                if direction is None:
                    continue
                for h, path in paths.items():
                    if path:
                        res[src][name][h].append(outcome(*path, direction or +1, unit))
    return True


def _pct(xs, key):
    return 100.0 * sum(1 for x in xs if x[key]) / len(xs) if xs else float("nan")


def write_report(res, base, days_done, fh):
    fh.write(f"\n{'=' * 96}\nFUTURES FLOW vs OPTION FLOW - nifty50, {days_done} days\n")
    fh.write("Same days, decision points and forward test. Only the flow source differs.\n")
    fh.write("edge = direction hit-rate minus base rate, percentage points. inside +/-3 = noise.\n")
    fh.write(f"{'=' * 96}\n")
    for h in HORIZONS:
        b = base[h]
        if not b:
            continue
        br = _pct(b, "went_right")
        fh.write(f"\n--- {h} min ahead   base rate up {br:.0f}%   (n={len(b):,}) ---\n")
        fh.write(f"{'rule':<30}{'futures n':>10}{'fut edge':>10}{'options n':>11}{'opt edge':>10}   better\n")
        for name in TRIGGERS:
            xf = res["futures"].get(name, {}).get(h, [])
            xo = res["options"].get(name, {}).get(h, [])
            ef = _pct(xf, "went_right") - br if len(xf) >= 30 else None
            eo = _pct(xo, "went_right") - br if len(xo) >= 30 else None
            if ef is None and eo is None:
                continue
            s_f = f"{ef:+.1f}" if ef is not None else "-"
            s_o = f"{eo:+.1f}" if eo is not None else "-"
            if ef is not None and eo is not None:
                better = "OPTIONS" if eo - ef > 2 else ("futures" if ef - eo > 2 else "same")
            else:
                better = ""
            fh.write(f"{name:<30}{len(xf):>10,}{s_f:>10}{len(xo):>11,}{s_o:>10}   {better}\n")
    fh.flush()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit-days", type=int, default=0)
    args = ap.parse_args(argv)

    days = []
    for d in sorted(glob.glob(os.path.join(RAW, "2026-*"))):
        day = os.path.basename(d)
        if day in EXCLUDE:
            continue
        if all(os.path.exists(os.path.join(d, f"nifty50_{n}.ndjson.gz"))
               for n in ("underlying_ticks", "option_ticks", "chain_snapshots")):
            days.append(day)
    if args.limit_days:
        days = days[-args.limit_days:]

    res = {"futures": defaultdict(lambda: defaultdict(list)),
           "options": defaultdict(lambda: defaultdict(list))}
    base = defaultdict(list)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    done = 0
    t0 = time.time()
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(f"# {len(days)} days queued\n")
        for k, day in enumerate(days, 1):
            t1 = time.time()
            try:
                ok = run_day(day, res, base)
            except Exception as exc:
                fh.write(f"# {day} FAILED {type(exc).__name__}: {exc}\n"); fh.flush()
                continue
            done += ok
            fh.write(f"# [{k}/{len(days)}] {day} {'ok' if ok else 'skipped'} "
                     f"{time.time() - t1:.0f}s  (elapsed {(time.time() - t0) / 60:.0f} min)\n")
            fh.flush()
            if ok and done % 10 == 0:
                write_report(res, base, done, fh)
        write_report(res, base, done, fh)
        fh.write(f"# DONE {done} days in {(time.time() - t0) / 60:.0f} min\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
