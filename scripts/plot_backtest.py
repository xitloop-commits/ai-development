"""
scripts/plot_backtest.py — visualize multi-horizon model predictions.

Reads a completed scored-backtest's `predictions.ndjson` and renders THREE
interactive Plotly HTML charts side-by-side as separate files:

  * chart_tick.html  - tick-by-tick price line  + markers
  * chart_30s.html   - 30-second OHLC candles   + markers
  * chart_1m.html    - 1-minute OHLC candles    + markers

Each chart layers THREE prediction horizons on top of the price:

  ▲   small  green    = scalp (60s)   predicted UP
  ▼   small  red      = scalp (60s)   predicted DOWN
  ▲   medium yellow   = trend (1800s) predicted UP
  ▼   medium orange   = trend (1800s) predicted DOWN
  ▲   large  cyan     = swing (7200s) predicted UP
  ▼   large  magenta  = swing (7200s) predicted DOWN

When all three horizon arrows STACK in the same direction at a given
moment, that's the model's highest-conviction zone -- exactly what the
operator wants to see before deploying capital. When they DISAGREE,
that's chop or a regime change.

Hover tooltip on any marker shows all six probabilities for that tick.

Usage::

    py scripts/plot_backtest.py <instrument> <date>
    py scripts/plot_backtest.py nifty50 2026-06-19

Output: `data/backtests/<instrument>/<model_version>/<date>/gate/`
containing chart_tick.html, chart_30s.html, chart_1m.html.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import plotly.graph_objects as go

_REPO_ROOT = Path(__file__).resolve().parent.parent
_IST = timezone(timedelta(hours=5, minutes=30))


# Direction-classification: honest 0.5 cutoff.
#
# Earlier iterations (1σ/2σ-from-mean thresholds, dead bands, etc.)
# attempted to suppress "noise" markers. That was wrong for an accuracy-
# measurement tool: curating which predictions to display hides exactly
# the misses the operator is trying to count. Now the chart obeys the
# model's natural decision boundary: prob > 0.5 → predicted UP,
# prob < 0.5 → predicted DOWN, prob == 0.5 → no commit (rare).
#
# Correctness is encoded separately: filled marker = prediction matched
# the actual outcome, hollow marker = prediction was wrong. The
# operator can scan the chart and see misses vs hits directly.
_UP_TH = 0.5
_DN_TH = 0.5

# Marker per-horizon style. Size escalates with horizon so longer-term
# views are visually heavier (matches how the operator should weight
# them in entry decisions).
_HORIZON_STYLES = {
    "scalp_60s":   dict(up="#1ea453", dn="#d6443c",
                         size=8,  label="scalp 60s"),
    "trend_1800s": dict(up="#e7c83d", dn="#e88a1a",
                         size=12, label="trend 30m"),
    "swing_7200s": dict(up="#3dc1d3", dn="#d63d9c",
                         size=16, label="swing 2h"),
}

# What probability column maps to each horizon. The backtest scorer
# writes these into predictions.ndjson (multi-horizon emit landed
# 2026-06-21).
_HORIZON_PROB_KEY = {
    "scalp_60s":   "pred_dir_60s",
    "trend_1800s": "pred_trend_dir_1800s",
    "swing_7200s": "pred_swing_dir_7200s",
}

# Ground-truth key per horizon -- used to decide whether a prediction
# was correct. `direction_*` columns in the parquet are 1 / -1 / 0 (or
# NaN) per the trainer's labeling: 1 = price moved up over the
# lookahead, -1 = down, 0 / NaN = no resolution. The backtest writes
# these into pred_rec as `actual_*` fields.
_HORIZON_ACTUAL_KEY = {
    "scalp_60s":   "actual_dir_60s",
    "trend_1800s": "actual_trend_dir_1800s",
    "swing_7200s": "actual_swing_dir_7200s",
}


def _find_backtest_dir(
    instrument: str,
    date: str,
    model_version: str | None,
) -> Path:
    """Locate the backtest output dir for (instrument, date, model_version).

    When model_version is None, picks the lexicographically-largest
    timestamped dir that has a predictions.ndjson for this date.
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


def _to_dt(ts: float | None) -> datetime | None:
    """Convert epoch seconds to an IST-aware datetime.

    Plotly aligns traces correctly when X values are real datetime
    objects -- mixing string timestamps from different sources (candles
    at 30s boundaries, markers at tick-level) puts the markers AFTER
    the candles in categorical X-axis ordering. Datetime axis cures
    that by treating both as points on a continuous timeline.
    """
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(ts, _IST)
    except Exception:
        return None


def _bucket_ts(ts: float, interval_sec: int) -> int:
    """Floor a timestamp to the start of its interval bucket."""
    return int(ts // interval_sec) * interval_sec


def _price_range(rows: list[dict]) -> float:
    """Return the day's high − low for the spot price, used to size
    arrow vertical offsets so they don't sit on top of the candle body."""
    prices = [float(r["spot_price"]) for r in rows
              if r.get("spot_price") is not None]
    if not prices:
        return 0.0
    return max(prices) - min(prices)


def _aggregate_ohlc(
    rows: list[dict],
    interval_sec: int,
) -> tuple[list[datetime], list[float], list[float], list[float], list[float]]:
    """Group ticks into OHLC bars at `interval_sec` resolution.

    Returns parallel arrays (timestamps, open, high, low, close) for a
    Plotly Candlestick trace. X values are datetime objects so Plotly
    aligns them on a continuous time axis -- mixing string-formatted
    times with the marker traces caused the markers to land off the
    chart end (categorical-axis grouping bug).
    """
    buckets: dict[int, dict] = {}
    for r in rows:
        ts = r.get("timestamp")
        price = r.get("spot_price")
        if ts is None or price is None:
            continue
        ts = float(ts)
        price = float(price)
        bucket_ts = _bucket_ts(ts, interval_sec)
        if bucket_ts not in buckets:
            buckets[bucket_ts] = {
                "open": price, "high": price, "low": price, "close": price,
            }
        else:
            b = buckets[bucket_ts]
            b["high"] = max(b["high"], price)
            b["low"] = min(b["low"], price)
            b["close"] = price

    sorted_ts = sorted(buckets.keys())
    xs = [_to_dt(t) for t in sorted_ts]
    o = [buckets[t]["open"] for t in sorted_ts]
    h = [buckets[t]["high"] for t in sorted_ts]
    l = [buckets[t]["low"] for t in sorted_ts]
    c = [buckets[t]["close"] for t in sorted_ts]
    return xs, o, h, l, c


# How far above/below the price each horizon's arrow sits, as a fraction
# of the day's high-low range. Scalp arrows ride closest to the price;
# trend and swing sit further out so all three layers stack visibly when
# they fire together at the same tick.
_HORIZON_OFFSET_FRACTION = {
    "scalp_60s":   0.015,  # ~1.5% of day's price range
    "trend_1800s": 0.030,  # ~3%
    "swing_7200s": 0.045,  # ~4.5%
}


def _marker_traces_per_horizon(
    rows: list[dict],
    marker_every_n: int,
    price_range: float,
) -> list[go.Scattergl]:
    """Build four traces per horizon: up-correct, up-wrong, down-correct,
    down-wrong. Filled marker = prediction matched the actual outcome,
    hollow marker = prediction was wrong. Direction encoded by triangle
    orientation (▲/▼) and color (green/red).

    Arrows are offset off the price line: UP arrows BELOW the price
    (pointing up at it), DOWN arrows ABOVE the price (pointing down at
    it) -- TradingView convention. Per-horizon offsets stack so all
    three horizons remain readable when they fire on the same tick.
    """
    traces: list[go.Scattergl] = []
    for horizon, style in _HORIZON_STYLES.items():
        prob_key = _HORIZON_PROB_KEY[horizon]
        actual_key = _HORIZON_ACTUAL_KEY[horizon]
        offset = price_range * _HORIZON_OFFSET_FRACTION[horizon]
        # 4 buckets keyed by (predicted_dir, correct_or_unknown).
        buckets: dict[tuple[str, str], dict[str, list]] = {
            ("up",   "correct"): {"x": [], "y": [], "text": []},
            ("up",   "wrong"):   {"x": [], "y": [], "text": []},
            ("down", "correct"): {"x": [], "y": [], "text": []},
            ("down", "wrong"):   {"x": [], "y": [], "text": []},
        }
        for i, r in enumerate(rows):
            if i % marker_every_n != 0:
                continue
            prob = r.get(prob_key)
            price = r.get("spot_price")
            if prob is None or price is None:
                continue
            actual = r.get(actual_key)
            # Predict direction by the model's own decision boundary.
            # prob == 0.5 exactly is treated as no-commit (skipped).
            if prob > 0.5:
                pred_dir = "up"
                y = float(price) - offset
            elif prob < 0.5:
                pred_dir = "down"
                y = float(price) + offset
            else:
                continue
            # Correctness: unresolved actuals (None / NaN / 0) are a
            # MISSING ground-truth, NOT a wrong prediction -- happens
            # near session end when the lookahead horizon extends past
            # market close, and on flat days where the future move
            # didn't cross the trainer's "direction" threshold. Skip
            # those ticks so the chart only counts what's actually
            # measurable. Labeling them "wrong" hollow would lie:
            # the accuracy denominator would inflate with unmeasurable
            # rows.
            if actual is None:
                continue
            try:
                actual_f = float(actual)
            except (TypeError, ValueError):
                continue
            if actual_f != actual_f:  # NaN
                continue
            if actual_f > 0:
                corr = "correct" if pred_dir == "up" else "wrong"
            elif actual_f < 0:
                corr = "correct" if pred_dir == "down" else "wrong"
            else:
                # actual_f == 0 → unresolved; can't grade this tick.
                continue
            x = _to_dt(r.get("timestamp"))
            tip = _build_tooltip(r)
            buckets[(pred_dir, corr)]["x"].append(x)
            buckets[(pred_dir, corr)]["y"].append(y)
            buckets[(pred_dir, corr)]["text"].append(tip)

        # Emit one trace per bucket so the legend can toggle each
        # (direction × correctness) combination independently.
        for (pred_dir, corr), data in buckets.items():
            if not data["x"]:
                continue
            color = style["up"] if pred_dir == "up" else style["dn"]
            symbol = ("triangle-up" if pred_dir == "up" else "triangle-down")
            if corr == "wrong":
                symbol += "-open"  # hollow variant
            arrow = "▲" if pred_dir == "up" else "▼"
            corr_label = "✓" if corr == "correct" else "✗"
            traces.append(go.Scattergl(
                x=data["x"], y=data["y"], mode="markers",
                marker=dict(symbol=symbol, color=color,
                            size=style["size"],
                            line=dict(width=1, color=color)),
                name=f"{arrow}{corr_label} {style['label']}",
                text=data["text"],
                hovertemplate="<b>%{x}</b><br>price=%{y:.2f}<br>%{text}<extra></extra>",
            ))
    return traces


def _build_tooltip(r: dict) -> str:
    """Compact 3-line multi-horizon prob summary for the hover card.

    Arrow uses the model's natural 0.5 decision boundary -- same logic
    as the marker direction so hover text matches what the operator
    sees on the chart.
    """
    def _fmt(key, label):
        v = r.get(key)
        if v is None:
            return f"{label}: n/a"
        arrow = "▲" if v > 0.5 else ("▼" if v < 0.5 else "·")
        return f"{label}: {arrow} {v:.3f}"
    return (
        f"{_fmt('pred_dir_60s',         'scalp 60s')}<br>"
        f"{_fmt('pred_trend_dir_1800s', 'trend 30m')}<br>"
        f"{_fmt('pred_swing_dir_7200s', 'swing 2h')}"
    )


def _build_layout(
    *, instrument: str, date: str, model_version: str,
) -> dict:
    # type="date" pins the X axis to a continuous time scale; tickformat
    # "%H:%M:%S" keeps the human-readable IST label without the date
    # prefix (the day is in the title).
    return dict(
        title=(f"Backtest predictions — {instrument} {date}<br>"
               f"<sub>model {model_version}  ·  "
               f"1-minute candles  ·  "
               f"every prediction shown (no threshold)</sub>"),
        xaxis=dict(
            title="time (IST)",
            type="date",
            tickformat="%H:%M:%S",
            showgrid=True, gridcolor="#222",
            rangeslider=dict(visible=False),
        ),
        yaxis=dict(title="spot price", showgrid=True, gridcolor="#222"),
        template="plotly_dark",
        height=720,
        hovermode="x unified",
        legend=dict(orientation="h", y=-0.20),
    )


def build_candlestick_chart(
    rows: list[dict],
    *, instrument: str, date: str, model_version: str,
    interval_sec: int, marker_every_n: int,
    price_range: float,
) -> go.Figure:
    """1-minute OHLC candlestick + per-horizon correctness markers."""
    xs, o, h, l, c = _aggregate_ohlc(rows, interval_sec)
    fig = go.Figure()
    fig.add_trace(go.Candlestick(
        x=xs, open=o, high=h, low=l, close=c,
        increasing_line_color="#3a8f5a", decreasing_line_color="#9c4444",
        name="OHLC 1m",
        showlegend=True,
    ))
    for tr in _marker_traces_per_horizon(rows, marker_every_n, price_range):
        fig.add_trace(tr)
    fig.update_layout(**_build_layout(
        instrument=instrument, date=date, model_version=model_version,
    ))
    return fig


def main() -> int:
    p = argparse.ArgumentParser(
        prog="plot_backtest",
        description="Render multi-horizon Plotly charts of model predictions.",
    )
    p.add_argument("instrument", help="nifty50 / banknifty / crudeoil / naturalgas")
    p.add_argument("date", help="YYYY-MM-DD (a date you've already backtested)")
    p.add_argument(
        "--model-version",
        help="Pin a specific model (default: most recent backtested run).",
    )
    p.add_argument(
        "--marker-every", type=int, default=30,
        help="Draw a prediction marker every N ticks (default 30 ~ 30s).",
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

    # Filter to rows with usable price (warmup ticks may be missing it).
    rows = [r for r in predictions if r.get("spot_price") is not None]
    if not rows:
        print("\n  ERROR: predictions.ndjson has no rows with spot_price.\n")
        return 4

    # price_range sizes the arrow vertical offsets per horizon so they
    # sit just outside the candle body rather than on top of it.
    price_range = _price_range(rows)

    fig = build_candlestick_chart(
        rows,
        instrument=args.instrument, date=args.date,
        model_version=model_version,
        interval_sec=60,  # 1-minute candles
        marker_every_n=args.marker_every,
        price_range=price_range,
    )

    out_path = bt_dir / "chart.html"
    fig.write_html(str(out_path), include_plotlyjs="cdn", auto_open=False)

    # Clean up the older variant filenames if they're hanging around
    # from a previous run -- keeps the backtest dir tidy.
    for stale in ("chart_tick.html", "chart_30s.html", "chart_1m.html"):
        old = bt_dir / stale
        if old.exists():
            try:
                old.unlink()
            except Exception:
                pass

    url = "file:///" + str(out_path).replace("\\", "/")
    print()
    print("  " + "=" * 56)
    print(f"   Chart written:")
    print(f"     {out_path}")
    print()
    print(f"   Open in browser (Ctrl+click in Windows Terminal):")
    print(f"     {url}")
    print("  " + "=" * 56)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
