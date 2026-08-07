"""Visualize the sma-model's decisions for one day.

Runs the latest trained heads over a chosen date (same simulate loop as the
Gate-1 backtest) and renders the HA candle chart + SMA5 with every entry and
exit marked, one connector per trade coloured by its net ₹.

Usage:
    py -m python_modules.sma_model.plot_day 2026-08-06 [out.png]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import lightgbm as lgb
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from .config import MODELS_ROOT, PROJECT_ROOT
from .dataset import load_day_cached
from .train import FoldModel, simulate_day

# Palette: candles use the domain-standard up/down pair; trade annotations use
# a distinct blue/violet family so entries never blend into candle colours.
C_UP = "#1a9850"
C_DOWN = "#d73027"
C_SMA = "#2166ac"
C_CALL = "#0b5394"
C_PUT = "#7b3294"
C_WIN = "#1a9850"
C_LOSS = "#d73027"
INK = "#222222"
MUT = "#777777"


def latest_model_dir() -> Path:
    root = MODELS_ROOT / "nifty50"
    dirs = sorted(d for d in root.iterdir() if (d / "entry_head.lgbm").exists())
    if not dirs:
        raise SystemExit("no trained sma-model found — run train first")
    return dirs[-1]


def load_model(model_dir: Path) -> FoldModel:
    manifest = json.loads((model_dir / "manifest.json").read_text())
    fm = FoldModel(
        entry=lgb.Booster(model_file=str(model_dir / "entry_head.lgbm")),
        exit=lgb.Booster(model_file=str(model_dir / "exit_head.lgbm")),
        entry_threshold=float(manifest.get("entry_threshold") or 0.0),
    )
    return fm


def plot(date: str, out_path: Path | None = None) -> Path:
    model_dir = latest_model_dir()
    fm = load_model(model_dir)
    day = load_day_cached(date)
    if day is None:
        raise SystemExit(f"no raw data for {date}")
    net, trades = simulate_day(date, fm)

    ok = ~np.isnan(day.ha_c)
    idx = np.arange(len(day.ha_c))

    fig, ax = plt.subplots(figsize=(22, 9), dpi=140)
    fig.patch.set_facecolor("white")

    # HA candles: thin wick line + body bar
    for i in idx[ok]:
        up = day.ha_c[i] >= day.ha_o[i]
        color = C_UP if up else C_DOWN
        ax.vlines(i, day.ha_l[i], day.ha_h[i], color=color, linewidth=0.7, alpha=0.8)
        lo, hi = sorted((day.ha_o[i], day.ha_c[i]))
        ax.add_patch(plt.Rectangle((i - 0.36, lo), 0.72, max(hi - lo, 0.05),
                                   facecolor=color, edgecolor="none", alpha=0.9))

    ax.plot(idx[ok], day.sma[ok], color=C_SMA, linewidth=1.6, label="SMA5 (HA close)")

    # Trades: entry marker, exit marker, connector + ₹ label
    for t in trades:
        i_in, i_out = t["entry_candle"], t["exit_candle"]
        d = t["direction"]
        win = t["net_inr"] > 0
        cc = C_WIN if win else C_LOSS
        mcolor = C_CALL if d > 0 else C_PUT
        y_in = day.ha_l[i_in] - 6 if d > 0 else day.ha_h[i_in] + 6
        marker = "^" if d > 0 else "v"
        ax.plot([i_in], [y_in], marker=marker, markersize=11, color=mcolor,
                markeredgecolor="white", markeredgewidth=1.2, zorder=5)
        y_out = day.ha_c[i_out]
        ax.plot([i_out], [y_out], marker="x", markersize=9, color=INK,
                markeredgewidth=2.2, zorder=5)
        ax.plot([i_in, i_out], [day.ha_c[i_in], y_out], color=cc,
                linewidth=1.4, alpha=0.65, zorder=4)
        mid = (i_in + i_out) / 2
        y_lab = max(day.ha_c[i_in], y_out) + 9
        ax.annotate(f"{'+' if win else ''}{t['net_inr']:.0f}",
                    (mid, y_lab), ha="center", fontsize=8.5, color=cc,
                    fontweight="bold")

    # Axes cosmetics: recessive grid, IST time labels every 30 min
    ax.grid(axis="y", color="#e8e8e8", linewidth=0.7)
    ax.set_axisbelow(True)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ticks = np.arange(0, len(idx), 30)
    labels = []
    for i in ticks:
        m = 9 * 60 + 15 + int(i)
        labels.append(f"{m // 60:02d}:{m % 60:02d}")
    ax.set_xticks(ticks)
    ax.set_xticklabels(labels, fontsize=9, color=MUT)
    ax.tick_params(axis="y", labelsize=9, colors=MUT)
    ax.set_ylabel("NIFTY futures", fontsize=10, color=INK)

    wins = sum(1 for t in trades if t["net_inr"] > 0)
    ax.set_title(
        f"sma-model decisions — {date}   |   {len(trades)} trades, "
        f"{wins} wins, net ₹{net:+,.0f}   |   model {model_dir.name}",
        fontsize=13, color=INK, loc="left", pad=14,
    )
    handles = [
        plt.Line2D([], [], color=C_SMA, linewidth=1.6, label="SMA5 (HA close)"),
        plt.Line2D([], [], marker="^", linestyle="", color=C_CALL,
                   markeredgecolor="white", markersize=10, label="enter CALL"),
        plt.Line2D([], [], marker="v", linestyle="", color=C_PUT,
                   markeredgecolor="white", markersize=10, label="enter PUT"),
        plt.Line2D([], [], marker="x", linestyle="", color=INK,
                   markeredgewidth=2, markersize=9, label="exit"),
        plt.Line2D([], [], color=C_WIN, linewidth=2, label="winning trade"),
        plt.Line2D([], [], color=C_LOSS, linewidth=2, label="losing trade"),
    ]
    ax.legend(handles=handles, loc="upper left", frameon=False, fontsize=9,
              ncols=6)

    fig.tight_layout()
    out = out_path or (PROJECT_ROOT.parent / f"sma_model_{date}_chart.png")
    fig.savefig(out, bbox_inches="tight")
    plt.close(fig)
    print(f"trades: {len(trades)} | net ₹{net:+,.1f}")
    print(f"chart → {out}")
    return out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: py -m python_modules.sma_model.plot_day <YYYY-MM-DD> [out.png]")
    plot(sys.argv[1], Path(sys.argv[2]) if len(sys.argv) > 2 else None)
