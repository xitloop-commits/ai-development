"""Dataset builder — one pass over a day's raw recordings → one parquet.

Decision clock: the futures 1-minute candle close (regular, always ticking).
At each close, for each locked leg (CE and PE) emit one row:
  - premium HH/HL structure at 1m/2m/5m (the gate lens)
  - futures momentum + 1m structure (spot circumstances)
  - the leg's greeks + chain aggregates (PCR, ATM IV, distance to ATM)
  - per-strike ladder features for the row's side across ATM±L:
    greeks + fast-flow velocity (OI rate, volume burst, buildup class) +
    order-book imbalance — the "where is the fast money" lens
  - labels: blast / drop on the locked premium (NaN when the window is cut off)

Run:  python -m blast_model.dataset --date 2026-09-01
      python -m blast_model.dataset --all
(from python_modules/, or with python_modules on PYTHONPATH)
"""
from __future__ import annotations

import argparse
import heapq
import os
import time
from typing import Any, Iterator

from .candles import CandleBuilder, structure_features
from .config import BlastConfig
from .flow import FlowTracker
from .greeks import bs_greeks, expected_hourly_move, years_to_expiry
from .labels import blast_labels
from .raw_reader import (
    compute_day_lock,
    iter_chain,
    iter_options,
    iter_underlying,
    list_recorded_dates,
    session_open_ts,
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


class ChainState:
    """Latest chain view: spot, expiry, per-strike IV/OI, ATM, PCR."""

    def __init__(self) -> None:
        self.spot = 0.0
        self.expiry = ""
        self.rows: dict[float, dict[str, Any]] = {}
        self.atm = 0.0
        self.pcr = float("nan")
        self.strikes: list[float] = []

    def update(self, snap: dict[str, Any]) -> None:
        rows = snap.get("rows") or []
        spot = snap.get("spotPrice") or 0
        if not rows or spot <= 0:
            return
        self.spot = float(spot)
        self.expiry = str(snap.get("expiry", self.expiry))
        self.rows = {float(r["strike"]): r for r in rows if r.get("strike")}
        self.strikes = sorted(self.rows)
        self.atm = min(self.strikes, key=lambda s: abs(s - self.spot))
        call_oi = sum(r.get("callOI") or 0 for r in self.rows.values())
        put_oi = sum(r.get("putOI") or 0 for r in self.rows.values())
        self.pcr = put_oi / call_oi if call_oi > 0 else float("nan")

    def ladder(self, ladder: int) -> list[float]:
        if not self.strikes or self.atm not in self.rows:
            return []
        i = self.strikes.index(self.atm)
        lo = max(0, i - ladder)
        hi = min(len(self.strikes), i + ladder + 1)
        return self.strikes[lo:hi]


def build_day(date: str, cfg: BlastConfig | None = None, verbose: bool = True):
    import pandas as pd

    cfg = cfg or BlastConfig()
    t0 = time.time()
    lock = compute_day_lock(date, cfg.lock_offset, cfg.instrument, cfg.session_open_hhmm)
    if lock is None:
        if verbose:
            print(f"{date}: no usable chain snapshot — skipped")
        return None

    open_ts = session_open_ts(date, cfg.session_open_hhmm)
    locked = {"CE": lock.ce_strike, "PE": lock.pe_strike}

    # Premium candle builders for the locked legs, one per structure timeframe.
    prem: dict[str, dict[int, CandleBuilder]] = {
        side: {tf: CandleBuilder(tf) for tf in cfg.structure_tfs_sec} for side in ("CE", "PE")
    }
    fut_1m = CandleBuilder(cfg.decision_candle_sec)
    flows: dict[tuple[float, str], FlowTracker] = {}
    chain = ChainState()
    rows_out: list[dict[str, Any]] = []
    pending: list[tuple[int, str, int]] = []  # (row_idx, side, decision candle idx)

    def leg_flow(strike: float, side: str) -> FlowTracker:
        key = (strike, side)
        ft = flows.get(key)
        if ft is None:
            ft = flows[key] = FlowTracker(cfg.flow_windows_sec)
        return ft

    def decide(now_ts: float) -> None:
        """Called at each futures 1m close INSIDE the session."""
        if chain.spot <= 0 or not chain.expiry:
            return
        tte = years_to_expiry(chain.expiry, now_ts, cfg.session_close_hhmm)
        exp_move_hr = expected_hourly_move(chain.spot, _atm_iv(), cfg.session_hours)
        fut_candles = fut_1m.candles
        fut_struct = structure_features(fut_candles, cfg.swing_window, cfg.range_lookback, "fut1m")
        fut_ret_1m = _ret(fut_candles, 1)
        fut_ret_5m = _ret(fut_candles, 5)
        for side in ("CE", "PE"):
            b1 = prem[side][cfg.decision_candle_sec]
            if not b1.candles:
                continue
            i = len(b1.candles) - 1
            c = b1.candles[i]
            row: dict[str, Any] = {
                "date": date, "ts": now_ts, "side": side, "candle_t": c.t,
                "strike": locked[side], "premium": c.close,
                "spot": chain.spot, "atm": chain.atm,
                "dist_atm_strikes": _strike_dist(locked[side], side),
                "pcr": chain.pcr, "atm_iv": _atm_iv(),
                "tte_years": tte, "exp_move_hr": exp_move_hr,
                "fut_ret_1m": fut_ret_1m, "fut_ret_5m": fut_ret_5m,
            }
            row.update(fut_struct)
            for tf in cfg.structure_tfs_sec:
                row.update(structure_features(
                    prem[side][tf].candles, cfg.swing_window, cfg.range_lookback, f"p{tf}s"))
            # The leg's own greeks.
            g = _leg_greeks(locked[side], side, tte)
            row["leg_delta"] = g["delta"] if g else float("nan")
            row["leg_gamma"] = g["gamma"] if g else float("nan")
            row["leg_theta_day"] = g["theta_day"] if g else float("nan")
            # Ladder: per-strike greeks + fast-flow for this side, ATM±L.
            for k, strike in enumerate(chain.ladder(cfg.ladder)):
                p = f"lad{k - cfg.ladder:+d}"
                gg = _leg_greeks(strike, side, tte)
                row[f"{p}_delta"] = gg["delta"] if gg else float("nan")
                row[f"{p}_theta_day"] = gg["theta_day"] if gg else float("nan")
                r = chain.rows.get(strike, {})
                row[f"{p}_oi"] = (r.get("callOI") if side == "CE" else r.get("putOI")) or float("nan")
                row[f"{p}_iv"] = (r.get("callIV") if side == "CE" else r.get("putIV")) or float("nan")
                row.update(leg_flow(strike, side).features(now_ts, p))
            rows_out.append(row)
            pending.append((len(rows_out) - 1, side, i))

    def _ret(candles, n):
        if len(candles) <= n:
            return float("nan")
        a, b = candles[-1 - n].close, candles[-1].close
        return (b - a) / a if a > 0 else float("nan")

    def _atm_iv() -> float:
        r = chain.rows.get(chain.atm)
        if not r:
            return float("nan")
        ivs = [v for v in (r.get("callIV"), r.get("putIV")) if v and v > 0]
        return sum(ivs) / len(ivs) if ivs else float("nan")

    def _strike_dist(strike: float, side: str) -> float:
        if not chain.strikes or chain.atm not in chain.rows:
            return float("nan")
        step = chain.strikes[1] - chain.strikes[0] if len(chain.strikes) > 1 else 1
        d = (strike - chain.atm) / step
        return d if side == "CE" else -d  # + = OTM for both sides

    def _leg_greeks(strike: float, side: str, tte: float):
        r = chain.rows.get(strike)
        if not r:
            return None
        iv = r.get("callIV") if side == "CE" else r.get("putIV")
        if not iv or iv <= 0:
            return None
        return bs_greeks(chain.spot, strike, float(iv), tte, side == "CE")

    n_ticks = 0
    for ts, kind, d in _merged(date, cfg.instrument):
        n_ticks += 1
        if kind == "chain":
            chain.update(d)
        elif kind == "fut":
            closed = fut_1m.add(ts, d.get("ltp") or 0, d.get("ltq") or 0)
            if closed is not None and closed.t >= open_ts:
                decide(ts)
        else:  # option tick
            strike = d.get("strike")
            side = d.get("opt_type")
            if strike is None or side not in ("CE", "PE"):
                continue
            strike = float(strike)
            ltp = d.get("ltp") or 0
            if strike == locked[side]:
                for tf in cfg.structure_tfs_sec:
                    prem[side][tf].add(ts, ltp, d.get("ltq") or 0)
            leg_flow(strike, side).add(
                ts, d.get("oi") or 0, d.get("volume") or 0, ltp,
                d.get("total_buy") or 0, d.get("total_sell") or 0)

    # Labels (post-pass: needs each leg's full candle list).
    w_enter = cfg.blast_window_min * 60
    w_exit = cfg.drop_window_min * 60
    for row_idx, side, ci in pending:
        enter, exit_ = blast_labels(
            prem[side][cfg.decision_candle_sec].candles, ci,
            cfg.blast_pct, w_enter, cfg.drop_pct, w_exit)
        rows_out[row_idx]["label_enter"] = enter
        rows_out[row_idx]["label_exit"] = exit_

    if not rows_out:
        if verbose:
            print(f"{date}: 0 rows (no session data)")
        return None
    df = pd.DataFrame(rows_out)
    from .raw_reader import _ROOT
    out_dir = cfg.out_dir if os.path.isabs(cfg.out_dir) else os.path.join(_ROOT, cfg.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    # Locked-leg 1m candles → label sweeps recompute any threshold cheaply
    # (dataset v2, 2026-09-07) without re-reading the raw ticks.
    cand_rows = [
        {"side": side, "t": c.t, "open": c.open, "high": c.high,
         "low": c.low, "close": c.close, "volume": c.volume}
        for side in ("CE", "PE")
        for c in prem[side][cfg.decision_candle_sec].candles
    ]
    pd.DataFrame(cand_rows).to_parquet(os.path.join(out_dir, f"{date}_candles1m.parquet"), index=False)
    out = os.path.join(out_dir, f"{date}_{cfg.label_tag()}.parquet")
    df.to_parquet(out, index=False)
    if verbose:
        lab = df["label_enter"].dropna()
        print(f"{date}: {len(df)} rows, {df.shape[1]} cols, blast rate "
              f"{lab.mean():.1%} ({int(lab.sum())}/{len(lab)}), "
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
