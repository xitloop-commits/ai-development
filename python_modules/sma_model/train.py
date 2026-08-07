"""Train the sma-model entry/exit heads + Gate-1 walk-forward backtest.

Walk-forward: chronological expanding-window folds over recorded days. Each
fold trains on all days before its validation block, tunes the entry
confidence threshold on the tail of its own training days, then trades the
validation days out-of-sample. Every traded day is therefore scored by a
model that never saw it.

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

from .config import LOT_SIZE, MODELS_ROOT
from .dataset import load_dataset, load_day_cached
from .events import _trade_net
from .features import EXIT_EXTRA_NAMES, FEATURE_NAMES, entry_features, exit_features
from .pipeline import N_CANDLES

_DAY_CACHE: dict = {}


def _get_day(date: str):
    if date not in _DAY_CACHE:
        _DAY_CACHE[date] = load_day_cached(date)
    return _DAY_CACHE[date]

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
N_ROUNDS = 400
EARLY_STOP = 40

N_FOLDS = 4               # expanding-window OOS folds
MIN_TRAIN_DAYS = 15       # earliest days never traded, only trained on
# Entry head predicts expected ₹ per trade; grid = minimum EV to act on.
THRESH_GRID = [0.0, 25.0, 50.0, 75.0]
TUNE_TAIL_DAYS = 8        # threshold tuned on the last N train days
EV_CLIP = (-400.0, 600.0)  # tame label outliers for the regression head


@dataclass
class FoldModel:
    entry: lgb.Booster
    exit: lgb.Booster
    entry_threshold: float


def _fit(df: pd.DataFrame, feature_names: list[str], val_frac=0.15,
         objective="binary", label_col="label"):
    X = df[feature_names].values
    y = df[label_col].values
    if objective == "regression":
        y = np.clip(y, *EV_CLIP)
    params = dict(LGB_PARAMS, objective=objective)
    if objective == "regression":
        # Early stopping collapses the weak-signal ₹ head to a constant
        # (validation L2 barely moves) — fit fixed rounds instead.
        return lgb.train(params, lgb.Dataset(X, label=y), 300)
    n_val = max(200, int(len(df) * val_frac))
    tr = lgb.Dataset(X[:-n_val], label=y[:-n_val])
    va = lgb.Dataset(X[-n_val:], label=y[-n_val:])
    return lgb.train(params, tr, N_ROUNDS, valid_sets=[va],
                     callbacks=[lgb.early_stopping(EARLY_STOP, verbose=False)])


def simulate_day(date: str, model: FoldModel, hold_threshold: float = 0.5):
    """Trade one day with the trained heads. Returns (net ₹, trades list)."""
    day = _get_day(date)
    if day is None:
        return 0.0, []
    side = day.side()
    trades = []
    i = 14
    last = N_CANDLES - 1
    in_pos = None  # (direction, strike, entry_candle)
    while i <= last:
        if in_pos is None:
            d = int(side[i])
            if d != 0 and i < last and not np.isnan(day.spot[i]):
                atm = day.atm_strike(i)
                if not np.isnan(atm):
                    feats = np.array([entry_features(day, i, d)])
                    p = float(model.entry.predict(feats)[0])
                    if p >= model.entry_threshold:
                        opt = "CE" if d > 0 else "PE"
                        if day.quote(int(atm), opt, i) is not None:
                            in_pos = (d, int(atm), i, p)
        else:
            d, strike, i_in, p_in = in_pos
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
                                       net_inr=net, entry_conf=p_in))
                in_pos = None
        i += 1
    return sum(t["net_inr"] for t in trades), trades


def _decide_exit(day, i, d, i_in, strike, model: FoldModel, hold_threshold):
    feats = np.array([exit_features(day, i, d, i_in, strike)])
    p_hold = float(model.exit.predict(feats)[0])
    return p_hold < hold_threshold  # True → exit now


def _tune_threshold(dates: list[str], model: FoldModel) -> float:
    best_t, best_pnl = THRESH_GRID[0], -1e18
    for t in THRESH_GRID:
        model.entry_threshold = float(t)
        pnl = 0.0
        for date in dates:
            day_pnl, _ = simulate_day(date, model)
            pnl += day_pnl
        if pnl > best_pnl:
            best_pnl, best_t = pnl, float(t)
    return best_t


def main() -> None:
    entry_df = load_dataset("entry").sort_values(["date", "candle"]).reset_index(drop=True)
    exit_df = load_dataset("exit").sort_values(["date", "candle"]).reset_index(drop=True)
    dates = sorted(entry_df["date"].unique())
    print(f"dataset: {len(entry_df)} entry rows, {len(exit_df)} exit rows, "
          f"{len(dates)} days ({dates[0]} → {dates[-1]})")

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
        entry_m = _fit(e_tr, FEATURE_NAMES, objective="regression",
                       label_col="net_inr")
        exit_m = _fit(x_tr, FEATURE_NAMES + EXIT_EXTRA_NAMES) if len(x_tr) > 400 \
            else _fit_all(x_tr, FEATURE_NAMES + EXIT_EXTRA_NAMES)
        fm = FoldModel(entry=entry_m, exit=exit_m, entry_threshold=0.0)
        fm.entry_threshold = _tune_threshold(train_dates[-TUNE_TAIL_DAYS:], fm)
        print(f"  tuned entry threshold: {fm.entry_threshold:.2f}")

        fold_pnl = 0.0
        for date in block:
            day_pnl, trades = simulate_day(date, fm)
            all_trades.extend(trades)
            fold_pnl += day_pnl
            print(f"  {date}: {len(trades):3d} trades  ₹{day_pnl:+9.1f}")
        fold_summaries.append(dict(fold=f + 1, days=len(block),
                                   threshold=fm.entry_threshold,
                                   net_inr=round(fold_pnl, 1)))
        final_model = fm

    # ── report ─────────────────────────────────────────────────────────────
    tdf = pd.DataFrame(all_trades)
    total = tdf.net_inr.sum() if len(tdf) else 0.0
    wins = (tdf.net_inr > 0).sum() if len(tdf) else 0
    print("\n══ GATE 1 RESULT (out-of-sample walk-forward) ══")
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
        final_model.exit.save_model(str(out / "exit_head.lgbm"))
    tdf.to_parquet(out / "gate1_trades.parquet", index=False)
    manifest = dict(
        created=ts, instrument="nifty50", spec="docs/systems/11_sma_model.md",
        # final saved model trained on all days BEFORE this date; charts of
        # earlier dates are in-sample and must be labeled as such
        oos_start_date=(list(blocks[-1])[0] if len(blocks) else None),
        n_days=len(dates), n_entry_rows=int(len(entry_df)),
        n_exit_rows=int(len(exit_df)), folds=fold_summaries,
        gate1_total_net_inr=round(float(total), 1),
        gate1_trades=int(len(tdf)), gate1_win_rate=round(float(wins / max(1, len(tdf))), 4),
        entry_threshold=final_model.entry_threshold if final_model else None,
        feature_names=FEATURE_NAMES, exit_extra=EXIT_EXTRA_NAMES,
        lot_size=LOT_SIZE,
    )
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nartifacts → {out}")


def _fit_all(df: pd.DataFrame, feature_names: list[str]):
    """Small-data fallback: no early-stopping split, fixed rounds."""
    X = df[feature_names].values
    y = df["label"].values
    tr = lgb.Dataset(X, label=y)
    params = dict(LGB_PARAMS, min_data_in_leaf=20)
    return lgb.train(params, tr, 150)


if __name__ == "__main__":
    main()
