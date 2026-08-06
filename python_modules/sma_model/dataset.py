"""Per-day dataset builder with on-disk cache (parquet per date).

Usage:
    py -m python_modules.sma_model.dataset               # all dates
    py -m python_modules.sma_model.dataset 2026-08-06    # one date
"""
from __future__ import annotations

import pickle
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed

import numpy as np
import pandas as pd

from .config import DATASET_ROOT, RAW_ROOT
from .events import extract_events
from .features import EXIT_EXTRA_NAMES, FEATURE_NAMES, entry_features, exit_features
from .pipeline import DayData, load_day


def day_pickle_path(date: str):
    return DATASET_ROOT / f"{date}_day.pkl"


def load_day_cached(date: str) -> DayData | None:
    """DayData from the per-day pickle cache (built by build_date), else raw."""
    p = day_pickle_path(date)
    if p.exists():
        with open(p, "rb") as f:
            return pickle.load(f)
    day = load_day(date)
    if day is not None:
        DATASET_ROOT.mkdir(parents=True, exist_ok=True)
        with open(p, "wb") as f:
            pickle.dump(day, f)
    return day


def build_date(date: str, force: bool = False) -> tuple[str, int, int] | None:
    DATASET_ROOT.mkdir(parents=True, exist_ok=True)
    f_entry = DATASET_ROOT / f"{date}_entry.parquet"
    f_exit = DATASET_ROOT / f"{date}_exit.parquet"
    if f_entry.exists() and f_exit.exists() and \
            day_pickle_path(date).exists() and not force:
        return date, -1, -1  # cached

    day = load_day(date)
    if day is None:
        return None
    with open(day_pickle_path(date), "wb") as f:
        pickle.dump(day, f)
    entries, exits = extract_events(day)

    e_rows = []
    for ev in entries:
        feats = entry_features(day, ev.candle, ev.direction)
        e_rows.append({
            "date": ev.date, "candle": ev.candle, "direction": ev.direction,
            "is_leg_start": int(ev.is_leg_start), "strike": ev.strike,
            "exit_candle": ev.exit_candle, "entry_ask": ev.entry_ask,
            "exit_bid": ev.exit_bid, "net_inr": ev.net_inr,
            "gross_inr": ev.gross_inr, "label": int(ev.net_inr > 0),
            **dict(zip(FEATURE_NAMES, feats)),
        })
    x_rows = []
    for ev in exits:
        feats = exit_features(day, ev.candle, ev.direction, ev.entry_candle,
                              ev.strike)
        x_rows.append({
            "date": ev.date, "candle": ev.candle, "direction": ev.direction,
            "entry_candle": ev.entry_candle, "strike": ev.strike,
            "exit_now_net": ev.exit_now_net, "hold_net": ev.hold_net,
            "label": ev.hold_better,
            **dict(zip(FEATURE_NAMES + EXIT_EXTRA_NAMES, feats)),
        })

    pd.DataFrame(e_rows).to_parquet(f_entry, index=False)
    pd.DataFrame(x_rows).to_parquet(f_exit, index=False)
    return date, len(e_rows), len(x_rows)


def all_dates() -> list[str]:
    out = []
    for p in sorted(RAW_ROOT.iterdir()):
        if (p / "nifty50_underlying_ticks.ndjson.gz").exists() and \
           (p / "nifty50_chain_snapshots.ndjson.gz").exists():
            out.append(p.name)
    return out


def load_dataset(kind: str) -> pd.DataFrame:
    """Concatenate all cached parquets of one kind ('entry' | 'exit')."""
    frames = []
    for p in sorted(DATASET_ROOT.glob(f"*_{kind}.parquet")):
        df = pd.read_parquet(p)
        if len(df):
            frames.append(df)
    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    force = "--force" in sys.argv
    dates = args if args else all_dates()
    print(f"building {len(dates)} date(s) → {DATASET_ROOT}")
    done = 0
    with ProcessPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(build_date, d, force): d for d in dates}
        for fut in as_completed(futs):
            d = futs[fut]
            try:
                res = fut.result()
            except Exception as e:  # keep going; report at end
                print(f"  {d}: FAILED {type(e).__name__}: {e}")
                continue
            done += 1
            if res is None:
                print(f"  {d}: skipped (missing files)  [{done}/{len(dates)}]")
            elif res[1] < 0:
                print(f"  {d}: cached  [{done}/{len(dates)}]")
            else:
                print(f"  {d}: {res[1]} entry / {res[2]} exit  [{done}/{len(dates)}]")


if __name__ == "__main__":
    main()
