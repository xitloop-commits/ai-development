"""Train the sma-model heads + Gate-1 walk-forward backtest (v2: D14/D15).

Heads:
  entry — expected net ₹ of a pullback entry (regression)
  size  — expected favourable leg run in points (regression, D15)
  exit  — hold-vs-exit classifier at wrong-side closes

Entry fires only when BOTH expected ₹ ≥ EV floor AND expected points ≥ size
floor; the two floors are tuned on the tail of each fold's training days.

Walk-forward: chronological expanding-window folds; every traded day is
scored by a model that never saw it.

Artifacts → models/sma_model/nifty50/<timestamp>/ (never the MTA paths).

Usage:
    py -m python_modules.sma_model.train
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass

import lightgbm as lgb
import numpy as np
import pandas as pd

from .config import LOT_SIZE, MIN_DECISION_CANDLE, MODELS_ROOT
from .dataset import load_dataset, load_day_cached
from .events import PULLBACK_WINDOW, _trade_net, pullback_hit
from .features import (
    ENTRY_EXTRA_NAMES,
    EXIT_EXTRA_NAMES,
    FEATURE_NAMES,
    entry_extra_features,
    entry_features,
    exit_features,
)
from .pipeline import N_CANDLES

LGB_PARAMS = dict(
    objective="binary",
    learning_rate=0.05,
    num_leaves=31,
    min_data_in_leaf=50,
    feature_fraction=0.8,
    bagging_fraction=0.8,
    bagging_freq=1,
    verbosity=-1,
    seed=42,
)
N_ROUNDS = 300
EARLY_STOP = 40

N_FOLDS = 4               # expanding-window OOS folds
MIN_TRAIN_DAYS = 15       # earliest days never traded, only trained on
EV_GRID = [0.0, 25.0, 50.0]
SIZE_GRID = [6.0, 10.0, 14.0, 18.0]
TUNE_TAIL_DAYS = 8        # floors tuned on the last N train days
EV_CLIP = (-400.0, 600.0)
SIZE_CLIP = (-20.0, 120.0)

ENTRY_FEATS = FEATURE_NAMES + ENTRY_EXTRA_NAMES
EXIT_FEATS = FEATURE_NAMES + EXIT_EXTRA_NAMES

_DAY_CACHE: dict = {}


def _get_day(date: str):
    if date not in _DAY_CACHE:
        _DAY_CACHE[date] = load_day_cached(date)
    return _DAY_CACHE[date]


@dataclass
class FoldModel:
    entry: lgb.Booster
    size: lgb.Booster
    exit: lgb.Booster
    ev_threshold: float = 0.0
    size_threshold: float = 10.0


def _fit_reg(df: pd.DataFrame, feature_names: list[str], label_col: str,
             clip: tuple[float, float]):
    X = df[feature_names].values
    y = np.clip(df[label_col].values, *clip)
    params = dict(LGB_PARAMS, objective="regression")
    # No early stopping: weak-signal ₹/points heads collapse to a constant
    # under it (validation L2 barely moves).
    return lgb.train(params, lgb.Dataset(X, label=y), N_ROUNDS)


def _fit_bin(df: pd.DataFrame, feature_names: list[str]):
    X = df[feature_names].values
    y = df["label"].values
    if len(df) < 400:
        params = dict(LGB_PARAMS, min_data_in_leaf=20)
        return lgb.train(params, lgb.Dataset(X, label=y), 150)
    n_val = max(200, int(len(df) * 0.15))
    tr = lgb.Dataset(X[:-n_val], label=y[:-n_val])
    va = lgb.Dataset(X[-n_val:], label=y[-n_val:])
    return lgb.train(LGB_PARAMS, tr, N_ROUNDS, valid_sets=[va],
                     callbacks=[lgb.early_stopping(EARLY_STOP, verbose=False)])


def simulate_day(date: str, model: FoldModel, hold_threshold: float = 0.5):
    """Trade one day: pullback entries (D14), dual-floor gate (D15),
    exit-head-managed rides. Returns (net ₹, trades list)."""
    day = _get_day(date)
    if day is None:
        return 0.0, []
    side = day.side()
    trades = []
    last = N_CANDLES - 1
    in_pos = None            # (direction, strike, entry_candle, ev, size)
    cross = None             # (cross_candle, direction)
    for i in range(1, last + 1):
        # Track the most recent cross regardless of position state.
        if side[i] != 0 and side[i - 1] != 0 and side[i] != side[i - 1]:
            cross = (i, int(side[i]))
        if in_pos is None:
            if cross is not None:
                x, d = cross
                if side[i] != d or i - x > PULLBACK_WINDOW:
                    cross = None      # whipsawed away or window expired
                elif (i > x and i >= MIN_DECISION_CANDLE and i < last
                        and not np.isnan(day.spot[i])
                        and pullback_hit(day, i, d)):
                    atm = day.atm_strike(i)
                    if not np.isnan(atm):
                        strike = int(atm)
                        opt = "CE" if d > 0 else "PE"
                        if day.quote(strike, opt, i) is not None:
                            feats = np.array([
                                entry_features(day, i, d)
                                + entry_extra_features(day, i, d, x)
                            ])
                            ev = float(model.entry.predict(feats)[0])
                            sz = float(model.size.predict(feats)[0])
                            if ev >= model.ev_threshold and \
                                    sz >= model.size_threshold:
                                in_pos = (d, strike, i, ev, sz)
                            cross = None  # one shot per cross either way
        else:
            d, strike, i_in, ev, sz = in_pos
            wrong = side[i] != 0 and side[i] != d
            if i == last or (wrong and _decide_exit(day, i, d, i_in, strike,
                                                    model, hold_threshold)):
                opt = "CE" if d > 0 else "PE"
                res = _trade_net(day, strike, opt, i_in, i)
                if res is not None:
                    net, gross, ask, bid = res
                    trades.append(dict(date=date, direction=d, strike=strike,
                                       entry_candle=i_in, exit_candle=i,
                                       entry_ask=ask, exit_bid=bid,
                                       net_inr=net, entry_ev=ev,
                                       entry_size=sz))
                in_pos = None
    return sum(t["net_inr"] for t in trades), trades


def _decide_exit(day, i, d, i_in, strike, model: FoldModel, hold_threshold):
    feats = np.array([exit_features(day, i, d, i_in, strike)])
    p_hold = float(model.exit.predict(feats)[0])
    return p_hold < hold_threshold  # True → exit now


def _tune_floors(dates: list[str], model: FoldModel) -> tuple[float, float]:
    best = (EV_GRID[0], SIZE_GRID[0])
    best_pnl = -1e18
    for ev_t in EV_GRID:
        for sz_t in SIZE_GRID:
            model.ev_threshold, model.size_threshold = ev_t, sz_t
            pnl = sum(simulate_day(d, model)[0] for d in dates)
            if pnl > best_pnl:
                best_pnl, best = pnl, (ev_t, sz_t)
    return best


def main() -> None:
    entry_df = load_dataset("entry").sort_values(["date", "candle"]).reset_index(drop=True)
    exit_df = load_dataset("exit").sort_values(["date", "candle"]).reset_index(drop=True)
    dates = sorted(entry_df["date"].unique())
    print(f"dataset: {len(entry_df)} pullback-entry rows, {len(exit_df)} exit "
          f"rows, {len(dates)} days ({dates[0]} → {dates[-1]})")

    tradeable = dates[MIN_TRAIN_DAYS:]
    blocks = np.array_split(np.array(tradeable), N_FOLDS)

    all_trades: list[dict] = []
    fold_summaries = []
    final_model: FoldModel | None = None

    for f, block in enumerate(blocks):
        block = list(block)
        train_dates = [d for d in dates if d < block[0]]
        e_tr = entry_df[entry_df.date.isin(train_dates)]
        x_tr = exit_df[exit_df.date.isin(train_dates)]
        print(f"\nfold {f + 1}/{N_FOLDS}: train {len(train_dates)}d "
              f"({len(e_tr)}/{len(x_tr)} rows) → trade {block[0]}..{block[-1]}")
        fm = FoldModel(
            entry=_fit_reg(e_tr, ENTRY_FEATS, "net_inr", EV_CLIP),
            size=_fit_reg(e_tr, ENTRY_FEATS, "favorable_pts", SIZE_CLIP),
            exit=_fit_bin(x_tr, EXIT_FEATS),
        )
        fm.ev_threshold, fm.size_threshold = _tune_floors(
            train_dates[-TUNE_TAIL_DAYS:], fm)
        print(f"  tuned floors: EV ≥ ₹{fm.ev_threshold:.0f}, "
              f"size ≥ {fm.size_threshold:.0f} pts")

        fold_pnl = 0.0
        for date in block:
            day_pnl, trades = simulate_day(date, fm)
            all_trades.extend(trades)
            fold_pnl += day_pnl
            print(f"  {date}: {len(trades):3d} trades  ₹{day_pnl:+9.1f}")
        fold_summaries.append(dict(fold=f + 1, days=len(block),
                                   ev_threshold=fm.ev_threshold,
                                   size_threshold=fm.size_threshold,
                                   net_inr=round(fold_pnl, 1)))
        final_model = fm

    # ── report ─────────────────────────────────────────────────────────────
    tdf = pd.DataFrame(all_trades)
    total = tdf.net_inr.sum() if len(tdf) else 0.0
    wins = (tdf.net_inr > 0).sum() if len(tdf) else 0
    print("\n══ GATE 1 RESULT v2 (out-of-sample walk-forward) ══")
    print(f"days traded: {len(tradeable)} | trades: {len(tdf)} | "
          f"win rate: {wins / max(1, len(tdf)):.0%}")
    print(f"TOTAL NET: ₹{total:+.1f} | avg/trade ₹{total / max(1, len(tdf)):+.1f}")
    if len(tdf):
        by_day = tdf.groupby("date").net_inr.sum()
        print(f"best day ₹{by_day.max():+.1f} | worst day ₹{by_day.min():+.1f} | "
              f"green days {(by_day > 0).sum()}/{len(by_day)}")

    # ── persist artifacts ──────────────────────────────────────────────────
    ts = time.strftime("%Y%m%d_%H%M%S")
    out = MODELS_ROOT / "nifty50" / ts
    out.mkdir(parents=True, exist_ok=True)
    if final_model is not None:
        final_model.entry.save_model(str(out / "entry_head.lgbm"))
        final_model.size.save_model(str(out / "size_head.lgbm"))
        final_model.exit.save_model(str(out / "exit_head.lgbm"))
    tdf.to_parquet(out / "gate1_trades.parquet", index=False)
    manifest = dict(
        created=ts, instrument="nifty50", spec="docs/systems/11_sma_model.md",
        version="v2-pullback-biglegs",
        # final saved model trained on all days BEFORE this date; charts of
        # earlier dates are in-sample and must be labeled as such
        oos_start_date=(list(blocks[-1])[0] if len(blocks) else None),
        n_days=len(dates), n_entry_rows=int(len(entry_df)),
        n_exit_rows=int(len(exit_df)), folds=fold_summaries,
        gate1_total_net_inr=round(float(total), 1),
        gate1_trades=int(len(tdf)),
        gate1_win_rate=round(float(wins / max(1, len(tdf))), 4),
        ev_threshold=final_model.ev_threshold if final_model else None,
        size_threshold=final_model.size_threshold if final_model else None,
        feature_names=ENTRY_FEATS, exit_extra=EXIT_EXTRA_NAMES,
        lot_size=LOT_SIZE,
    )
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nartifacts → {out}")


if __name__ == "__main__":
    main()
