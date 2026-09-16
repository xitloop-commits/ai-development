"""Claude cohort — per-contract option book cache.

WHY THIS EXISTS
---------------
The feature parquet's `opt_0_<leg>_*` columns are the ATM *slot*, not a contract.
Measured on nifty50 2026-09-11: the ATM strike changes **434 times in one day**,
and each change makes the premium jump instantly (CE 90.40 -> 69.15 across a
single row). Holding a position while reading that column means the price series
silently switches contracts underneath the trade.

The damage is not random, it is directional: when the underlying moves against a
PE trade the ATM rolls UP, and the higher strike's put is more expensive — so a
losing trade books a profit. The first backtest run showed 44 stop-loss exits
netting +Rs 3,391, which is impossible and is what exposed the bug.

This module extracts the REAL per-contract bid/ask series from the raw option
tick recordings, keyed by (strike, opt_type), so a trade can be priced on the
contract it actually bought from entry to exit.

Cost: ~104 s per instrument-day (3.5M lines, of which ~810k are in band), so the
cache is built once and reused. Output: one parquet per instrument-day, 1-second
resolution, float32.

Build:
  python -m claude_cohort.book --instrument nifty50
  python -m claude_cohort.book --instrument banknifty --limit 5
"""
from __future__ import annotations

import argparse
import glob
import gzip
import json
import os
import time
import zlib
from typing import Optional

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RAW_DIR = os.path.join(_ROOT, "data", "raw")
FEATURES_DIR = os.path.join(_ROOT, "data", "features")
BOOK_DIR = os.path.join(_ROOT, "data", "claude_cohort", "book")

# Keep strikes this far outside the day's spot range. We only ever trade the ATM
# strike, but the band gives room for the strike lock and for a spot that walks.
STRIKE_BAND_PTS = 300.0

# Store at this resolution. Stops are checked against the UNDERLYING (which keeps
# full tick resolution from the feature parquet); the option series is only used
# to price the fill, where one second is ample.
RESAMPLE_SEC = 1


def book_path(instrument: str, date: str) -> str:
    return os.path.join(BOOK_DIR, f"{instrument}_{date}.parquet")


def spot_range(instrument: str, date: str) -> Optional[tuple[float, float]]:
    import pandas as pd

    path = os.path.join(FEATURES_DIR, date, f"{instrument}_features.parquet")
    if not os.path.exists(path):
        return None
    s = pd.read_parquet(path, columns=["underlying_ltp"])["underlying_ltp"].dropna()
    if s.empty:
        return None
    return float(s.min()), float(s.max())


def build_day(instrument: str, date: str, force: bool = False) -> Optional[str]:
    """Extract the in-band option book for one instrument-day. Returns the path."""
    import pandas as pd

    out = book_path(instrument, date)
    if os.path.exists(out) and not force:
        return out

    ticks = os.path.join(RAW_DIR, date, f"{instrument}_option_ticks.ndjson.gz")
    if not os.path.exists(ticks):
        return None
    rng = spot_range(instrument, date)
    if rng is None:
        return None
    lo, hi = rng[0] - STRIKE_BAND_PTS, rng[1] + STRIKE_BAND_PTS

    rows: list[tuple] = []
    try:
        with gzip.open(ticks, "rt") as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                k = d.get("strike")
                if k is None or not (lo <= k <= hi):
                    continue
                ts = d.get("recv_ts")
                if ts is None:
                    continue
                rows.append(
                    (
                        float(ts),
                        float(k),
                        d.get("opt_type") or "",
                        d.get("bid") or 0.0,
                        d.get("ask") or 0.0,
                        d.get("ltp") or 0.0,
                    )
                )
    except (EOFError, zlib.error, OSError) as exc:
        # The findings doc is explicit that recordings can be truncated or
        # corrupt. Keep whatever was read rather than losing the whole day.
        print(f"    [truncated] {date}: {type(exc).__name__} after {len(rows):,} rows")

    if not rows:
        return None

    df = pd.DataFrame(rows, columns=["ts", "strike", "opt_type", "bid", "ask", "ltp"])
    df["sec"] = (df["ts"] // RESAMPLE_SEC).astype("int64")
    # last quote wins within the bucket
    df = df.sort_values("ts").groupby(["strike", "opt_type", "sec"], as_index=False).last()
    df = df[["sec", "strike", "opt_type", "bid", "ask", "ltp"]]
    for c in ("bid", "ask", "ltp"):
        df[c] = df[c].astype("float32")
    df["strike"] = df["strike"].astype("float32")

    os.makedirs(BOOK_DIR, exist_ok=True)
    df.to_parquet(out, index=False)
    return out


def load_book(instrument: str, date: str):
    """Return {(strike, opt_type): {sec: (bid, ask, ltp)}} for fast lookup."""
    import pandas as pd

    path = book_path(instrument, date)
    if not os.path.exists(path):
        return None
    df = pd.read_parquet(path)
    book: dict = {}
    for (strike, otype), g in df.groupby(["strike", "opt_type"]):
        book[(float(strike), str(otype))] = dict(
            zip(g["sec"].to_numpy(), zip(g["bid"].to_numpy(), g["ask"].to_numpy(), g["ltp"].to_numpy()))
        )
    return book


def quote_at(leg_series: dict, sec: int, max_stale_sec: int = 30) -> Optional[tuple]:
    """Latest quote at or before `sec`, or None if nothing recent enough.

    Walking backwards is deliberate: a missing quote must NOT silently reuse a
    stale price. Platform bug 2 in the findings doc is exactly this — a frozen
    ltp booked -Rs 1,949 on a trade that was really +Rs 6,800.
    """
    for back in range(max_stale_sec + 1):
        q = leg_series.get(sec - back)
        if q is not None:
            return q
    return None


def available_raw_dates(instrument: str) -> list[str]:
    pat = os.path.join(RAW_DIR, "*", f"{instrument}_option_ticks.ndjson.gz")
    dates = sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob(pat))
    # only days we also have features for (the rules need them)
    return [d for d in dates if os.path.exists(os.path.join(FEATURES_DIR, d, f"{instrument}_features.parquet"))]


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Build the per-contract option book cache")
    ap.add_argument("--instrument", default="nifty50")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)

    dates = available_raw_dates(args.instrument)
    if args.limit:
        dates = dates[: args.limit]
    print(f"{args.instrument}: {len(dates)} days to build -> {BOOK_DIR}")

    done = skipped = failed = 0
    t_start = time.time()
    for i, d in enumerate(dates, 1):
        if os.path.exists(book_path(args.instrument, d)) and not args.force:
            skipped += 1
            continue
        t0 = time.time()
        try:
            path = build_day(args.instrument, d, force=args.force)
        except Exception as exc:
            print(f"  [{i}/{len(dates)}] {d} FAILED {type(exc).__name__}: {exc}")
            failed += 1
            continue
        if path is None:
            print(f"  [{i}/{len(dates)}] {d} no data")
            failed += 1
            continue
        done += 1
        mb = os.path.getsize(path) / 1e6
        print(f"  [{i}/{len(dates)}] {d} ok {time.time() - t0:.0f}s {mb:.1f}MB", flush=True)

    print(f"\nbuilt {done}, skipped {skipped}, failed {failed} in {(time.time() - t_start) / 60:.0f} min")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
