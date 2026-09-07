"""Dataset builder — one pass over a day's raw recordings → one parquet.

All feature computation lives in FeatureEngine (shared verbatim with the live
paper runner). This file only: merges the day's three raw streams by recv_ts,
drives the engine, attaches labels post-pass, and writes
  <date>_<labeltag>.parquet   (feature rows + default labels)
  <date>_candles1m.parquet    (locked-leg 1m candles — cheap label sweeps)

Run:  python -m blast_model.dataset --date 2026-09-01
      python -m blast_model.dataset --all
"""
from __future__ import annotations

import argparse
import heapq
import os
import time
from typing import Any, Iterator

from .config import BlastConfig
from .feature_engine import FeatureEngine
from .labels import blast_labels
from .raw_reader import (
    _ROOT,
    compute_day_lock,
    iter_chain,
    iter_options,
    iter_underlying,
    list_recorded_dates,
)


def _merged(date: str, instrument: str) -> Iterator[tuple[float, str, dict[str, Any]]]:
    """Heap-merge the three raw streams by recv_ts → (ts, kind, payload)."""
    def tag(kind: str, it):
        for d in it:
            ts = d.get("recv_ts")
            if ts is not None:
                yield (float(ts), kind, d)

    yield from heapq.merge(
        tag("fut", iter_underlying(date, instrument)),
        tag("opt", iter_options(date, instrument)),
        tag("chain", iter_chain(date, instrument)),
        key=lambda x: x[0],
    )


def build_day(date: str, cfg: BlastConfig | None = None, verbose: bool = True):
    import pandas as pd

    cfg = cfg or BlastConfig()
    t0 = time.time()
    lock = compute_day_lock(date, cfg.lock_offset, cfg.instrument, cfg.session_open_hhmm)
    if lock is None:
        if verbose:
            print(f"{date}: no usable chain snapshot - skipped")
        return None

    eng = FeatureEngine(date, lock, cfg)
    rows_out: list[dict[str, Any]] = []
    n_ticks = 0
    for ts, kind, d in _merged(date, cfg.instrument):
        n_ticks += 1
        if kind == "chain":
            eng.on_chain(d)
        elif kind == "fut":
            rows_out.extend(eng.on_fut(ts, d))
        else:
            eng.on_option(ts, d)

    # Labels post-pass (needs each leg's full candle list).
    w_enter = cfg.blast_window_min * 60
    w_exit = cfg.drop_window_min * 60
    for row in rows_out:
        lst = eng.prem[row["side"]][cfg.decision_candle_sec].candles
        idx = next((i for i in range(len(lst) - 1, -1, -1) if lst[i].t == row["candle_t"]), -1)
        enter, exit_ = blast_labels(lst, idx, cfg.blast_pct, w_enter, cfg.drop_pct, w_exit)
        row["label_enter"] = enter
        row["label_exit"] = exit_

    if not rows_out:
        if verbose:
            print(f"{date}: 0 rows (no session data)")
        return None
    df = pd.DataFrame(rows_out)
    out_dir = cfg.out_dir if os.path.isabs(cfg.out_dir) else os.path.join(_ROOT, cfg.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    cand_rows = [
        {"side": side, "t": c.t, "open": c.open, "high": c.high,
         "low": c.low, "close": c.close, "volume": c.volume}
        for side in ("CE", "PE")
        for c in eng.prem[side][cfg.decision_candle_sec].candles
    ]
    pd.DataFrame(cand_rows).to_parquet(os.path.join(out_dir, f"{date}_candles1m.parquet"), index=False)
    out = os.path.join(out_dir, f"{date}_{cfg.label_tag()}.parquet")
    df.to_parquet(out, index=False)
    if verbose:
        lab = df["label_enter"].dropna()
        rate = lab.mean() if len(lab) else float("nan")
        print(f"{date}: {len(df)} rows, {df.shape[1]} cols, blast rate "
              f"{rate:.1%} ({int(lab.sum())}/{len(lab)}), "
              f"lock CE {lock.ce_strike:g} / PE {lock.pe_strike:g}, "
              f"{n_ticks:,} ticks, {time.time() - t0:.0f}s -> {out}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Build blast-model dataset parquets from raw recordings")
    ap.add_argument("--date", help="YYYY-MM-DD (one day)")
    ap.add_argument("--all", action="store_true", help="every recorded day")
    args = ap.parse_args()
    cfg = BlastConfig()
    dates = list_recorded_dates(cfg.instrument) if args.all else ([args.date] if args.date else [])
    if not dates:
        ap.error("pass --date YYYY-MM-DD or --all")
    for d in dates:
        build_day(d, cfg)


if __name__ == "__main__":
    main()
