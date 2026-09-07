"""Charge-aware premium backtest on the candle clock (build-order step 4).

Verdict in RUPEES, not AUC. Strictly out-of-sample: predictions come from the
same day-ordered walk-forward as train.py — each fold's model has seen only
days BEFORE the days it trades. Fills at the decision candle's premium close
with a spread cost each way; every order pays real charges.

Trade rule (v0 — every piece sweepable):
  flat  → enter long when the HH+HL gate holds AND p_enter ≥ enter_floor
          (one position at a time across both legs; ties → higher p_enter)
  long  → exit when p_exit ≥ exit_floor, or after max_hold_min, or at EOD cut
Charges per order (Dhan, NSE options): brokerage ₹20, txn 0.05030%, GST 18%
on (brokerage+txn), SEBI ₹10/cr, stamp 0.003% (buy), STT 0.0625% (sell).

Run:  python -m blast_model.backtest                (build/reuse OOS preds + sim)
      python -m blast_model.backtest --enter-floor 0.6 --exit-floor 0.6
      python -m blast_model.backtest --rebuild-preds
"""
from __future__ import annotations

import argparse
import glob
import os

from .config import BlastConfig
from .raw_reader import _ROOT
from .train import DROP_COLS, MIN_LABELED_ROWS_PER_DAY, MIN_TRAIN_DAYS, TEST_CHUNK_DAYS, _fit

LOT_SIZE = 65          # NIFTY lot (matches the live book's records)
EOD_CUT_HHMM = "15:20"  # square off before close


def dhan_option_charges(buy_value: float, sell_value: float) -> float:
    """Round-trip charges for one buy + one sell order of given ₹ values."""
    brokerage = 20.0 * 2
    txn = (buy_value + sell_value) * 0.0005030
    gst = 0.18 * (brokerage + txn)
    sebi = (buy_value + sell_value) * 10.0 / 1e7
    stamp = buy_value * 0.00003
    stt = sell_value * 0.000625
    return brokerage + txn + gst + sebi + stamp + stt


def _load_rows(cfg: BlastConfig):
    import pandas as pd

    files = sorted(glob.glob(os.path.join(_ROOT, cfg.out_dir, f"*_{cfg.label_tag()}.parquet")))
    frames = [pd.read_parquet(f) for f in files]
    frames = [f for f in frames if f["label_enter"].notna().sum() >= MIN_LABELED_ROWS_PER_DAY]
    df = pd.concat(frames, ignore_index=True).sort_values(["ts", "side"]).reset_index(drop=True)
    df["is_call"] = (df["side"] == "CE").astype(float)
    feats = [c for c in df.columns if c not in DROP_COLS and df[c].dtype.kind in "fiu"]
    return df, feats


def build_oos_preds(cfg: BlastConfig, rebuild: bool = False):
    """Per-row OOS p_enter/p_exit via the walk-forward folds; cached."""
    import pandas as pd

    cache = os.path.join(_ROOT, cfg.out_dir, f"oos_preds_{cfg.label_tag()}.parquet")
    if os.path.exists(cache) and not rebuild:
        return pd.read_parquet(cache)
    df, feats = _load_rows(cfg)
    days = sorted(df["date"].unique())
    df["p_enter"] = float("nan")
    df["p_exit"] = float("nan")
    i = MIN_TRAIN_DAYS
    while i < len(days):
        test_days = days[i : i + TEST_CHUNK_DAYS]
        train = df[df["date"] < test_days[0]]
        mask = df["date"].isin(test_days)
        for label, col in (("label_enter", "p_enter"), ("label_exit", "p_exit")):
            model = _fit(train, feats, label)
            df.loc[mask, col] = model.predict_proba(df.loc[mask, feats])[:, 1]
        print(f"  preds {test_days[0]}..{test_days[-1]} done")
        i += TEST_CHUNK_DAYS
    out = df[["date", "ts", "side", "strike", "premium",
              "p60s_hh", "p60s_hl", "p_enter", "p_exit"]].dropna(subset=["p_enter"])
    out.to_parquet(cache, index=False)
    return out


def simulate(preds, enter_floor: float, exit_floor: float, max_hold_min: int,
             spread: float, require_gate: bool = True, side_filter: str | None = None):
    """One position at a time, long premium only. Returns (trades_df, summary)."""
    import pandas as pd
    from datetime import datetime, timedelta, timezone

    ist = timezone(timedelta(hours=5, minutes=30))
    trades = []
    pos = None  # dict(side, strike, entry_ts, entry_px, day)
    for day, g in preds.groupby("date", sort=True):
        h, m = EOD_CUT_HHMM.split(":")
        eod = datetime.strptime(day, "%Y-%m-%d").replace(
            hour=int(h), minute=int(m), tzinfo=ist).timestamp()
        pos = None
        last_px: dict[str, float] = {}
        for r in g.itertuples():
            last_px[r.side] = r.premium
            if pos is not None and r.side == pos["side"]:
                held_min = (r.ts - pos["entry_ts"]) / 60.0
                if r.p_exit >= exit_floor or held_min >= max_hold_min or r.ts >= eod:
                    trades.append(_close(pos, r.ts, r.premium, spread,
                                         "exit" if r.p_exit >= exit_floor
                                         else ("time" if held_min >= max_hold_min else "eod")))
                    pos = None
            if pos is None and r.ts < eod:
                if side_filter and r.side != side_filter:
                    continue
                gate = (r.p60s_hh == 1.0 and r.p60s_hl == 1.0) if require_gate else True
                if gate and r.p_enter >= enter_floor and r.premium > 0:
                    pos = {"side": r.side, "strike": r.strike, "day": day,
                           "entry_ts": r.ts, "entry_px": r.premium, "p_enter": r.p_enter}
        if pos is not None:  # safety: mark closed at last seen price
            px = last_px.get(pos["side"], pos["entry_px"])
            trades.append(_close(pos, eod, px, spread, "eod"))
            pos = None
    t = pd.DataFrame(trades)
    if t.empty:
        return t, {"trades": 0, "net": 0.0}
    summary = {
        "trades": len(t),
        "win_rate": float((t["net"] > 0).mean()),
        "gross": float(t["gross"].sum()),
        "charges": float(t["charges"].sum()),
        "net": float(t["net"].sum()),
        "avg_net": float(t["net"].mean()),
        "days": t["day"].nunique(),
        "net_per_day": float(t.groupby("day")["net"].sum().mean()),
        "worst_day": float(t.groupby("day")["net"].sum().min()),
        "best_day": float(t.groupby("day")["net"].sum().max()),
    }
    return t, summary


def _close(pos, ts, px, spread, reason):
    buy = (pos["entry_px"] + spread) * LOT_SIZE
    sell = max(px - spread, 0.05) * LOT_SIZE
    charges = dhan_option_charges(buy, sell)
    gross = sell - buy
    return {"day": pos["day"], "side": pos["side"], "strike": pos["strike"],
            "entry_ts": pos["entry_ts"], "exit_ts": ts,
            "entry_px": pos["entry_px"], "exit_px": px, "hold_min": (ts - pos["entry_ts"]) / 60.0,
            "reason": reason, "p_enter": pos["p_enter"],
            "gross": gross, "charges": charges, "net": gross - charges}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--enter-floor", type=float, default=0.55)
    ap.add_argument("--exit-floor", type=float, default=0.60)
    ap.add_argument("--max-hold-min", type=int, default=10)
    ap.add_argument("--spread", type=float, default=0.10, help="₹ paid each way vs close")
    ap.add_argument("--no-gate", action="store_true", help="drop the HH+HL gate")
    ap.add_argument("--rebuild-preds", action="store_true")
    args = ap.parse_args()
    cfg = BlastConfig()
    preds = build_oos_preds(cfg, rebuild=args.rebuild_preds)
    print(f"OOS rows: {len(preds):,} over {preds['date'].nunique()} days")
    t, s = simulate(preds, args.enter_floor, args.exit_floor, args.max_hold_min,
                    args.spread, require_gate=not args.no_gate)
    if not s.get("trades"):
        print("no trades at these floors")
        return
    print(f"\ntrades {s['trades']}  win {s['win_rate']:.0%}  "
          f"gross ₹{s['gross']:,.0f}  charges ₹{s['charges']:,.0f}  NET ₹{s['net']:,.0f}")
    print(f"per-trade ₹{s['avg_net']:,.0f}   per-day ₹{s['net_per_day']:,.0f} "
          f"(worst {s['worst_day']:,.0f} / best {s['best_day']:,.0f}) over {s['days']} traded days")
    print("\nexit reasons:", t["reason"].value_counts().to_dict())
    print("by side:", t.groupby("side")["net"].sum().round(0).to_dict())


if __name__ == "__main__":
    main()
