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


# Direction-classification: per-horizon dynamic thresholds.
#
# Default behaviour up to 2026-06-21 used hardcoded 0.52 / 0.48 thresholds
# for every horizon, which broke on flat days: trend / swing heads have a
# narrow effective range (e.g. 0.38-0.44 on a NEUTRAL session) and stayed
# permanently below the 0.48 down-line -- the chart drew DOWN arrows on
# every single tick even though the model wasn't expressing real
# conviction.
#
# Fix: compute thresholds per horizon as `mean ± std * _STDS_FROM_MEAN`
# using the day's actual prediction distribution. An UP arrow now only
# appears when a horizon's probability is meaningfully ABOVE its OWN
# average for the day, and similarly for DOWN. Flat-day baselines stop
# producing arrow-spam; high-conviction excursions still pop.
#
# Floor: at least 0.02 (2 percentage points) of band so a near-constant
# horizon (std ≈ 0) doesn't trip every tick as either UP or DOWN.
_STDS_FROM_MEAN = 1.0
_MIN_BAND = 0.02

# Fallback when a horizon column is entirely missing or all-NaN.
_FALLBACK_UP_TH = 0.55
_FALLBACK_DN_TH = 0.45

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


def _compute_horizon_thresholds(rows: list[dict]) -> dict[str, tuple[float, float]]:
    """Return ``{horizon: (up_th, dn_th)}`` derived from each horizon's
    own per-day prob distribution. See module docstring for rationale.

    Statistics: mean + sample std on the non-null values; up = mean +
    _STDS_FROM_MEAN * std, dn = mean - _STDS_FROM_MEAN * std. Band is
    floored at ``_MIN_BAND`` so a near-constant horizon doesn't draw
    every tick.
    """
    import math
    out: dict[str, tuple[float, float]] = {}
    for horizon, prob_key in _HORIZON_PROB_KEY.items():
        vals = [float(r[prob_key]) for r in rows
                if r.get(prob_key) is not None]
        if not vals:
            out[horizon] = (_FALLBACK_UP_TH, _FALLBACK_DN_TH)
            continue
        n = len(vals)
        mean = sum(vals) / n
        var = sum((v - mean) ** 2 for v in vals) / max(1, n - 1)
        std = math.sqrt(var)
        band = max(_MIN_BAND, _STDS_FROM_MEAN * std)
        out[horizon] = (mean + band, mean - band)
    return out


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
    thresholds: dict[str, tuple[float, float]],
    price_range: float,
) -> list[go.Scattergl]:
    """Build one (UP, DOWN) trace per horizon. Two traces per horizon
    so the legend can toggle direction independently. `thresholds` maps
    each horizon to its (up_th, dn_th) computed from the day's data.

    Arrows are offset off the price line: UP arrows BELOW the price
    (pointing up at it), DOWN arrows ABOVE the price (pointing down at
    it) -- TradingView convention. Per-horizon offsets stack so all
    three horizons remain readable when they fire on the same tick.
    """
    traces: list[go.Scattergl] = []
    for horizon, style in _HORIZON_STYLES.items():
        prob_key = _HORIZON_PROB_KEY[horizon]
        up_th, dn_th = thresholds[horizon]
        offset = price_range * _HORIZON_OFFSET_FRACTION[horizon]
        up_x, up_y, up_text = [], [], []
        dn_x, dn_y, dn_text = [], [], []
        for i, r in enumerate(rows):
            if i % marker_every_n != 0:
                continue
            prob = r.get(prob_key)
            price = r.get("spot_price")
            if prob is None or price is None:
                continue
            x = _to_dt(r.get("timestamp"))
            # Multi-horizon tooltip body: show ALL three horizons at this
            # tick so the operator can spot agreement / disagreement.
            tip = _build_tooltip(r, thresholds)
            if prob >= up_th:
                # UP arrow BELOW price (points up at it)
                up_x.append(x)
                up_y.append(float(price) - offset)
                up_text.append(tip)
            elif prob <= dn_th:
                # DOWN arrow ABOVE price (points down at it)
                dn_x.append(x)
                dn_y.append(float(price) + offset)
                dn_text.append(tip)
        if up_x:
            traces.append(go.Scattergl(
                x=up_x, y=up_y, mode="markers",
                marker=dict(symbol="triangle-up", color=style["up"],
                            size=style["size"],
                            line=dict(width=1, color=style["up"])),
                name=f"▲ {style['label']}",
                text=up_text,
                hovertemplate="<b>%{x}</b><br>price=%{y:.2f}<br>%{text}<extra></extra>",
            ))
        if dn_x:
            traces.append(go.Scattergl(
                x=dn_x, y=dn_y, mode="markers",
                marker=dict(symbol="triangle-down", color=style["dn"],
                            size=style["size"],
                            line=dict(width=1, color=style["dn"])),
                name=f"▼ {style['label']}",
                text=dn_text,
                hovertemplate="<b>%{x}</b><br>price=%{y:.2f}<br>%{text}<extra></extra>",
            ))
    return traces


def _build_tooltip(r: dict, thresholds: dict[str, tuple[float, float]]) -> str:
    """Compact 3-line multi-horizon prob summary for the hover card.

    Direction arrow is decided per-horizon using THAT horizon's threshold
    rather than a shared 0.50 midpoint -- matches the marker logic.
    """
    def _fmt(key, label, horizon):
        v = r.get(key)
        if v is None:
            return f"{label}: n/a"
        up_th, dn_th = thresholds[horizon]
        arrow = "▲" if v >= up_th else ("▼" if v <= dn_th else "·")
        return f"{label}: {arrow} {v:.3f}"
    return (
        f"{_fmt('pred_dir_60s',         'scalp 60s', 'scalp_60s')}<br>"
        f"{_fmt('pred_trend_dir_1800s', 'trend 30m', 'trend_1800s')}<br>"
        f"{_fmt('pred_swing_dir_7200s', 'swing 2h',  'swing_7200s')}"
    )


def _format_threshold_summary(thresholds: dict[str, tuple[float, float]]) -> str:
    """Build the small subtitle line that lists each horizon's actual
    up/dn thresholds so the operator can see what classifications
    they're looking at."""
    parts = []
    for horizon, (up_th, dn_th) in thresholds.items():
        label = _HORIZON_STYLES[horizon]["label"]
        parts.append(f"{label} ≥{up_th:.3f} / ≤{dn_th:.3f}")
    return "  ·  ".join(parts)


def _build_layout(
    *, instrument: str, date: str, model_version: str, mode_label: str,
    thresholds: dict[str, tuple[float, float]],
) -> dict:
    # type="date" pins the X axis to a continuous time scale, so candle
    # buckets and tick-level marker timestamps land on the same timeline.
    # tickformat="%H:%M:%S" keeps the human-readable IST label without
    # the date prefix (the day is in the title).
    return dict(
        title=(f"Backtest predictions ({mode_label}) — {instrument} {date}<br>"
               f"<sub>model {model_version}</sub><br>"
               f"<sub>{_format_threshold_summary(thresholds)}</sub>"),
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


def build_tick_chart(
    rows: list[dict],
    *, instrument: str, date: str, model_version: str,
    marker_every_n: int,
    thresholds: dict[str, tuple[float, float]],
    price_range: float,
) -> go.Figure:
    """Tick-line variant: continuous price line + marker layers."""
    xs = [_to_dt(r.get("timestamp")) for r in rows
          if r.get("spot_price") is not None]
    ys = [float(r["spot_price"]) for r in rows
          if r.get("spot_price") is not None]
    fig = go.Figure()
    fig.add_trace(go.Scattergl(
        x=xs, y=ys, mode="lines",
        line=dict(color="#888888", width=1),
        name="price (tick)",
        hoverinfo="x+y",
    ))
    for tr in _marker_traces_per_horizon(rows, marker_every_n, thresholds, price_range):
        fig.add_trace(tr)
    fig.update_layout(**_build_layout(
        instrument=instrument, date=date,
        model_version=model_version, mode_label="tick line",
        thresholds=thresholds,
    ))
    return fig


def build_candlestick_chart(
    rows: list[dict],
    *, instrument: str, date: str, model_version: str,
    interval_sec: int, mode_label: str, marker_every_n: int,
    thresholds: dict[str, tuple[float, float]],
    price_range: float,
) -> go.Figure:
    """OHLC candlestick variant at `interval_sec` resolution."""
    xs, o, h, l, c = _aggregate_ohlc(rows, interval_sec)
    fig = go.Figure()
    fig.add_trace(go.Candlestick(
        x=xs, open=o, high=h, low=l, close=c,
        increasing_line_color="#3a8f5a", decreasing_line_color="#9c4444",
        name=f"OHLC {mode_label}",
        showlegend=True,
    ))
    for tr in _marker_traces_per_horizon(rows, marker_every_n, thresholds, price_range):
        fig.add_trace(tr)
    fig.update_layout(**_build_layout(
        instrument=instrument, date=date,
        model_version=model_version, mode_label=mode_label,
        thresholds=thresholds,
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

    # Compute per-horizon up/dn thresholds from this day's data ONCE so
    # all 3 chart variants classify markers identically. price_range
    # sizes the arrow vertical offsets per horizon.
    thresholds = _compute_horizon_thresholds(rows)
    price_range = _price_range(rows)

    common = dict(
        instrument=args.instrument, date=args.date,
        model_version=model_version, marker_every_n=args.marker_every,
        thresholds=thresholds, price_range=price_range,
    )

    variants = [
        ("chart_tick.html", build_tick_chart(rows, **common), "Tick line"),
        ("chart_30s.html",  build_candlestick_chart(
            rows, interval_sec=30, mode_label="30s candles", **common),
         "30-second candles"),
        ("chart_1m.html",   build_candlestick_chart(
            rows, interval_sec=60, mode_label="1m candles", **common),
         "1-minute candles"),
    ]

    written: list[tuple[str, Path]] = []
    for fname, fig, label in variants:
        out_path = bt_dir / fname
        fig.write_html(str(out_path), include_plotlyjs="cdn", auto_open=False)
        written.append((label, out_path))

    print()
    print("  " + "=" * 56)
    print(f"   Charts written ({len(written)} variants):")
    for label, path in written:
        print(f"     {label:20s}  {path.name}")
    print()
    print(f"   Open in browser (Ctrl+click in Windows Terminal):")
    for label, path in written:
        url = "file:///" + str(path).replace("\\", "/")
        print(f"     {label:20s}  {url}")
    print("  " + "=" * 56)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
