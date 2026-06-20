"""
scripts/plot_backtest.py — visualize model predictions on top of price.

Reads a completed scored-backtest's `predictions.ndjson` and renders a
single-pane interactive Plotly chart: spot_price line with prediction
arrows superimposed at regular intervals, colored by predicted direction.

Usage::

    py scripts/plot_backtest.py <instrument> <date>
    py scripts/plot_backtest.py nifty50 2026-06-19

By default the script auto-discovers the latest model version under
`data/backtests/<instrument>/`. Pass --model-version to pick a specific
historical run.

Output: `data/backtests/<instrument>/<model_version>/<date>/chart.html`.

Why interactive HTML (not PNG): hover-tooltips expose per-tick probability
and actual outcome — essential for the "is the model getting these
RIGHT?" eyeball check that motivated this script. Plotly's webgl scatter
handles 25k+ points without lag.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import plotly.graph_objects as go

_REPO_ROOT = Path(__file__).resolve().parent.parent


# Confidence band thresholds. The actual SEA gate uses 0.55/0.45 (we
# tightened earlier today), but for VISUAL inspection we show a wider
# band so the operator can see what the model wanted to say even when
# the gate would have suppressed it. Tuning later: pass --threshold.
_DEFAULT_UP_THRESHOLD = 0.52
_DEFAULT_DN_THRESHOLD = 0.48


def _find_backtest_dir(
    instrument: str,
    date: str,
    model_version: str | None,
) -> Path:
    """Locate the backtest output dir for (instrument, date, model_version).

    When model_version is None, picks the lexicographically-largest
    timestamped dir that has a predictions.ndjson for this date — i.e.
    the most recent run.
    """
    root = _REPO_ROOT / "data" / "backtests" / instrument
    if not root.is_dir():
        raise FileNotFoundError(
            f"No backtests root for {instrument} at {root}. "
            f"Run startup\\backtest-scored.bat {instrument} {date} first."
        )

    if model_version is not None:
        bt_dir = root / model_version / date / "gate"
        if not (bt_dir / "predictions.ndjson").exists():
            raise FileNotFoundError(
                f"No predictions.ndjson at {bt_dir}. "
                f"Was a backtest run for this model+date combination?"
            )
        return bt_dir

    candidates: list[tuple[str, Path]] = []
    for model_dir in root.iterdir():
        if not model_dir.is_dir():
            continue
        cand = model_dir / date / "gate" / "predictions.ndjson"
        if cand.exists():
            candidates.append((model_dir.name, cand.parent))
    if not candidates:
        raise FileNotFoundError(
            f"No backtest found for {instrument} on {date}. "
            f"Run startup\\backtest-scored.bat {instrument} {date} first."
        )
    candidates.sort(key=lambda t: t[0], reverse=True)
    return candidates[0][1]


def _load_predictions(path: Path) -> list[dict]:
    """Parse the NDJSON stream into a list of prediction records."""
    out: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def _classify(prob: float | None, up_th: float, dn_th: float) -> str:
    """Return 'up', 'down', or 'neutral' for a calibrated prob."""
    if prob is None:
        return "neutral"
    if prob >= up_th:
        return "up"
    if prob <= dn_th:
        return "down"
    return "neutral"


def _correctness(prob: float | None, actual: float | None,
                 up_th: float, dn_th: float) -> str | None:
    """'correct', 'wrong', or None when ground truth is missing.

    `actual_dir_60s` in the predictions file is the same signed direction
    target the trainer uses: positive → price moved up over the lookahead,
    negative → down, zero/None → flat or missing.
    """
    if actual is None or prob is None:
        return None
    pred = _classify(prob, up_th, dn_th)
    if pred == "neutral":
        return None  # model didn't commit; correctness undefined
    actual_up = actual > 0
    return ("correct" if (pred == "up" and actual_up) or
                          (pred == "down" and not actual_up) else "wrong")


def build_chart(
    predictions: list[dict],
    instrument: str,
    date: str,
    model_version: str,
    up_threshold: float,
    dn_threshold: float,
    marker_every_n: int,
) -> go.Figure:
    """Assemble the Plotly figure."""
    # Filter to ticks with a usable price (the trainer skips a few warmup
    # rows; their predictions records can have None spot_price).
    rows = [r for r in predictions if r.get("spot_price") is not None]
    if not rows:
        raise RuntimeError("predictions.ndjson has no rows with a spot_price")

    # X axis = wall-clock HH:MM:SS for readability. timestamp in the
    # backtest file is epoch seconds (IST) per the trainer's writer.
    from datetime import datetime, timezone, timedelta
    _IST = timezone(timedelta(hours=5, minutes=30))

    def _fmt_ts(ts):
        if ts is None:
            return None
        try:
            return datetime.fromtimestamp(ts, _IST).strftime("%H:%M:%S")
        except Exception:
            return str(ts)

    xs = [_fmt_ts(r.get("timestamp")) for r in rows]
    ys = [float(r["spot_price"]) for r in rows]

    fig = go.Figure()

    # Underlying price line (webgl for performance on 25k pts).
    fig.add_trace(go.Scattergl(
        x=xs, y=ys, mode="lines",
        line=dict(color="#888888", width=1),
        name="spot_price",
        hoverinfo="x+y",
    ))

    # Predictions as scatter markers, downsampled by `marker_every_n`.
    # Split into 4 traces by (predicted direction × correctness) so the
    # legend doubles as a filter.
    by_bucket: dict[str, list[tuple]] = {
        "up_correct":   [], "up_wrong":   [],
        "down_correct": [], "down_wrong": [],
        "neutral":      [],
    }
    for i, r in enumerate(rows):
        if i % marker_every_n != 0:
            continue
        prob = r.get("pred_dir_60s")
        actual = r.get("actual_dir_60s")
        klass = _classify(prob, up_threshold, dn_threshold)
        if klass == "neutral":
            by_bucket["neutral"].append((xs[i], ys[i], prob, actual))
            continue
        corr = _correctness(prob, actual, up_threshold, dn_threshold)
        if corr is None:
            # No ground truth — bucket as wrong-bucket so it's visible
            # but the symbol differs (hollow vs filled).
            by_bucket[f"{klass}_wrong"].append((xs[i], ys[i], prob, None))
        else:
            by_bucket[f"{klass}_{corr}"].append((xs[i], ys[i], prob, actual))

    marker_styles = {
        "up_correct":   dict(symbol="triangle-up",   color="#1ea453",  size=10,
                              name="↑ correct"),
        "up_wrong":     dict(symbol="triangle-up-open", color="#1ea453", size=10,
                              name="↑ wrong"),
        "down_correct": dict(symbol="triangle-down", color="#d6443c",  size=10,
                              name="↓ correct"),
        "down_wrong":   dict(symbol="triangle-down-open", color="#d6443c", size=10,
                              name="↓ wrong"),
        "neutral":      dict(symbol="circle",         color="#777777",  size=4,
                              name="·  no-signal"),
    }

    for bucket, items in by_bucket.items():
        if not items:
            continue
        x_b = [it[0] for it in items]
        y_b = [it[1] for it in items]
        probs = [it[2] for it in items]
        actuals = [it[3] for it in items]
        style = marker_styles[bucket]
        text = [
            f"prob_up={p:.3f}<br>actual_60s={'+' if (a is not None and a > 0) else ('−' if (a is not None and a < 0) else '?')}"
            if p is not None else "no prob"
            for p, a in zip(probs, actuals)
        ]
        fig.add_trace(go.Scattergl(
            x=x_b, y=y_b,
            mode="markers",
            marker=dict(symbol=style["symbol"], color=style["color"],
                        size=style["size"],
                        line=dict(width=1, color=style["color"])),
            name=style["name"],
            text=text,
            hovertemplate="%{x}<br>price=%{y:.2f}<br>%{text}<extra></extra>",
        ))

    fig.update_layout(
        title=(f"Backtest predictions — {instrument} {date}<br>"
               f"<sub>model {model_version}  ·  "
               f"up≥{up_threshold:.2f}  dn≤{dn_threshold:.2f}  ·  "
               f"marker every {marker_every_n} ticks</sub>"),
        xaxis=dict(title="time (IST)", showgrid=True, gridcolor="#222"),
        yaxis=dict(title="spot price", showgrid=True, gridcolor="#222"),
        template="plotly_dark",
        height=720,
        hovermode="x unified",
        legend=dict(orientation="h", y=-0.18),
    )
    return fig


def main() -> int:
    p = argparse.ArgumentParser(
        prog="plot_backtest",
        description="Render a Plotly HTML chart of model predictions on top of price.",
    )
    p.add_argument("instrument", help="nifty50 / banknifty / crudeoil / naturalgas")
    p.add_argument("date", help="YYYY-MM-DD (a date you've already backtested)")
    p.add_argument(
        "--model-version",
        help="Pin a specific model (default: most recent backtested run).",
    )
    p.add_argument(
        "--up-threshold", type=float, default=_DEFAULT_UP_THRESHOLD,
        help=f"Calibrated prob ≥ this is a predicted UP marker. Default {_DEFAULT_UP_THRESHOLD}.",
    )
    p.add_argument(
        "--dn-threshold", type=float, default=_DEFAULT_DN_THRESHOLD,
        help=f"Calibrated prob ≤ this is a predicted DOWN marker. Default {_DEFAULT_DN_THRESHOLD}.",
    )
    p.add_argument(
        "--marker-every", type=int, default=30,
        help="Draw a prediction marker every N ticks (default 30 = ~30s on a 1Hz tick stream).",
    )
    args = p.parse_args()

    try:
        bt_dir = _find_backtest_dir(args.instrument, args.date, args.model_version)
    except FileNotFoundError as e:
        print(f"\n  ERROR: {e}\n")
        return 2

    model_version = bt_dir.parent.parent.name
    pred_path = bt_dir / "predictions.ndjson"
    predictions = _load_predictions(pred_path)
    if not predictions:
        print(f"\n  ERROR: no predictions parsed from {pred_path}\n")
        return 3

    fig = build_chart(
        predictions,
        instrument=args.instrument,
        date=args.date,
        model_version=model_version,
        up_threshold=args.up_threshold,
        dn_threshold=args.dn_threshold,
        marker_every_n=args.marker_every,
    )

    out_path = bt_dir / "chart.html"
    fig.write_html(str(out_path), include_plotlyjs="cdn", auto_open=False)

    # Print a file:// URL — Windows Terminal turns this into a clickable
    # link (Ctrl+click in classic conhost, plain click in WT).
    file_url = "file:///" + str(out_path).replace("\\", "/")
    print()
    print("  " + "=" * 56)
    print(f"   Chart written:")
    print(f"     {out_path}")
    print()
    print(f"   Open in browser:")
    print(f"     {file_url}")
    print("  " + "=" * 56)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
