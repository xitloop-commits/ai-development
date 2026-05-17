"""
technical.py — C2 technical-oscillator features on 5-min bars (spec §2.1.4 C2).

Pure function. Reads finalised 5-min bars from `bars.BarAggregator`
and emits 5 oscillator / divergence features. Lets the trend gate read
the same momentum signals a human chartist would.

Features (5 outputs):
    rsi_14_5min                    Wilder-smoothed 14-period RSI on 5-min
                                   closes ∈ [0, 100]. NaN until 15 bars
                                   are available.
    macd_5min                      EMA(12) − EMA(26) of 5-min closes.
                                   NaN until 26 bars available.
    macd_signal_5min               EMA(9) of macd_5min. NaN until 26+8
                                   bars accumulated (i.e. 9 MACD values
                                   exist to seed the signal EMA).
    macd_histogram_5min            macd_5min − macd_signal_5min.
                                   NaN if either component is NaN.
    volume_price_divergence_5min   Categorical ∈ {−1, 0, +1}:
                                     +1 → directional 5-min bar (close
                                          ≠ open) with volume above the
                                          5-bar volume baseline.
                                          "Volume confirms the move."
                                     −1 → directional bar but volume
                                          below baseline. "Move on thin
                                          volume — divergent."
                                      0 → flat bar OR exactly-baseline
                                          volume.
                                   NaN until 6 finalised 5-min bars exist
                                   (5 baseline + 1 current).

Why this:
    Today the model only sees tick-level momentum; multi-minute bar
    momentum is a different signal. 5-min RSI/MACD are standard inputs
    for trend confirmation. volume_price_divergence catches the
    "rally on falling volume" pattern that hand-tagged Wave 1 logs
    repeatedly flagged as a no-trade condition.

Null rules:
    Insufficient history → NaN. Bar close ≤ 0 or non-finite → that bar
    is skipped (we'd rather emit a slightly stale RSI than poison the
    series with a broken tick).
"""

from __future__ import annotations

import math

from tick_feature_agent.features.bars import Bar

_NAN = float("nan")

_RSI_PERIOD = 14
_MACD_FAST = 12
_MACD_SLOW = 26
_MACD_SIGNAL = 9
_VOL_BASELINE_BARS = 5


def _clean_closes(bars: list[Bar]) -> list[float]:
    """Drop bars with non-finite / non-positive closes."""
    out: list[float] = []
    for b in bars:
        c = b.close
        if isinstance(c, (int, float)) and math.isfinite(c) and c > 0:
            out.append(float(c))
    return out


def _wilder_rsi(closes: list[float]) -> float:
    """Standard textbook Wilder RSI on the FINAL element of `closes`.

    Returns NaN if fewer than RSI_PERIOD+1 closes are available.
    """
    if len(closes) < _RSI_PERIOD + 1:
        return _NAN

    # Seed: average of the first 14 gains / losses.
    gains: list[float] = []
    losses: list[float] = []
    for i in range(1, _RSI_PERIOD + 1):
        d = closes[i] - closes[i - 1]
        gains.append(max(0.0, d))
        losses.append(max(0.0, -d))

    avg_gain = sum(gains) / _RSI_PERIOD
    avg_loss = sum(losses) / _RSI_PERIOD

    # Recursive Wilder smoothing for the remainder.
    for i in range(_RSI_PERIOD + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        gain = max(0.0, d)
        loss = max(0.0, -d)
        avg_gain = (avg_gain * (_RSI_PERIOD - 1) + gain) / _RSI_PERIOD
        avg_loss = (avg_loss * (_RSI_PERIOD - 1) + loss) / _RSI_PERIOD

    if avg_loss == 0.0:
        # All-gain window — RSI is 100 by definition.
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def _ema_series(values: list[float], period: int) -> list[float]:
    """Return a list of EMA values, indexed against `values`.

    Indices 0 .. period-2 are NaN (seed not ready). Index period-1 is
    the SMA seed; from there the standard EMA recursion runs.
    """
    if period <= 0:
        return []
    n = len(values)
    out = [_NAN] * n
    if n < period:
        return out
    alpha = 2.0 / (period + 1.0)
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    prev = seed
    for i in range(period, n):
        prev = alpha * values[i] + (1.0 - alpha) * prev
        out[i] = prev
    return out


def _macd_components(closes: list[float]) -> tuple[float, float, float]:
    """Return (macd, signal, histogram). NaN entries when not ready."""
    if len(closes) < _MACD_SLOW:
        return _NAN, _NAN, _NAN

    ema_fast = _ema_series(closes, _MACD_FAST)
    ema_slow = _ema_series(closes, _MACD_SLOW)
    macd_series: list[float] = []
    for f, s in zip(ema_fast, ema_slow):
        macd_series.append(f - s if (math.isfinite(f) and math.isfinite(s)) else _NAN)

    macd_val = macd_series[-1]
    # Strip leading NaNs before computing the signal EMA.
    cleaned = [v for v in macd_series if math.isfinite(v)]
    signal_series = _ema_series(cleaned, _MACD_SIGNAL)
    signal_val = signal_series[-1] if signal_series else _NAN

    if math.isfinite(macd_val) and math.isfinite(signal_val):
        hist = macd_val - signal_val
    else:
        hist = _NAN
    return macd_val, signal_val, hist


def _volume_price_divergence(bars: list[Bar]) -> float:
    """Categorical {−1, 0, +1} confirmation score on the latest bar."""
    if len(bars) < _VOL_BASELINE_BARS + 1:
        return _NAN
    cur = bars[-1]
    baseline_bars = bars[-(_VOL_BASELINE_BARS + 1):-1]  # last 5 prior
    baseline = sum(b.volume for b in baseline_bars) / _VOL_BASELINE_BARS

    # Direction
    if cur.close > cur.open:
        price_sign = 1
    elif cur.close < cur.open:
        price_sign = -1
    else:
        return 0.0

    if baseline <= 0:
        # No baseline to compare against → treat as neutral.
        return 0.0

    if cur.volume > baseline:
        vol_sign = 1
    elif cur.volume < baseline:
        vol_sign = -1
    else:
        return 0.0

    return float(price_sign * vol_sign)


def compute_technical_features(bars: list[Bar] | None) -> dict[str, float]:
    """
    Compute the 5 C2 technical features from a list of finalised 5-min bars.

    Args:
        bars: Bars from `BarAggregator.get_recent_bars(300)`, oldest → newest.

    Returns:
        Dict of 5 float features. NaN where insufficient history exists.
    """
    out: dict[str, float] = {
        "rsi_14_5min": _NAN,
        "macd_5min": _NAN,
        "macd_signal_5min": _NAN,
        "macd_histogram_5min": _NAN,
        "volume_price_divergence_5min": _NAN,
    }
    if not bars:
        return out

    closes = _clean_closes(bars)
    out["rsi_14_5min"] = _wilder_rsi(closes)
    macd, signal, hist = _macd_components(closes)
    out["macd_5min"] = macd
    out["macd_signal_5min"] = signal
    out["macd_histogram_5min"] = hist
    out["volume_price_divergence_5min"] = _volume_price_divergence(bars)
    return out
