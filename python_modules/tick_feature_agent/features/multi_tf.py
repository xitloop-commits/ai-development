"""
multi_tf.py — B1 / B2 / B4 multi-timeframe features (spec §2.1.3).

Pure function. Reads finalised bars from `bars.BarAggregator` across
the 1-min, 5-min, and 15-min timeframes plus current spot, and emits
11 features that let the gate read trend structure, strength, and
pattern context the same way a human chartist does.

Feature groups (11 outputs):

  B1 MA structure (5) — each as `(spot − ma) / spot`:
      ma_5_1min, ma_20_1min, ma_5_5min, ma_20_5min, ma_5_15min

  B2 Trend strength (3):
      adx_5min                  Wilder ADX(14) on 5-min bars ∈ [0, 100].
      momentum_5min             close_latest_5m / close_prev_5m.
      momentum_15min            close_latest_15m / close_prev_15m.

  B4 Multi-bar pattern (3):
      consecutive_higher_highs_5min   Run-length of bars whose high > prev.high.
      consecutive_higher_lows_5min    Run-length of bars whose low > prev.low.
      range_compression_ratio         Current-bar range ÷ mean of last 10
                                      prior-bar ranges. <1 = compression.

Null rules:
    Any feature whose window has insufficient bars → NaN. Bad closes
    (NaN, ≤0) are filtered upstream by `_clean_closes` so a single
    corrupt tick can't poison an MA or ADX.
"""

from __future__ import annotations

import math

from tick_feature_agent.features.bars import Bar

_NAN = float("nan")

_ADX_PERIOD = 14
_RANGE_COMPRESSION_BASELINE_BARS = 10
_HH_HL_MAX_LOOKBACK = 20  # cap how far back we look for the run


# ── Utilities ─────────────────────────────────────────────────────────────


def _safe_pos(v: float | None) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0:
        return None
    return f


def _clean_closes(bars: list[Bar]) -> list[float]:
    out: list[float] = []
    for b in bars:
        c = b.close
        if isinstance(c, (int, float)) and math.isfinite(c) and c > 0:
            out.append(float(c))
    return out


def _sma(values: list[float], n: int) -> float:
    """Simple moving average over the LAST n values; NaN if too few."""
    if len(values) < n or n <= 0:
        return _NAN
    return sum(values[-n:]) / n


# ── B1 MAs ────────────────────────────────────────────────────────────────


def _ma_ratio(spot: float | None, bars: list[Bar], n: int) -> float:
    """Return (spot − sma(n)) / spot. NaN if either input unavailable."""
    spot_v = _safe_pos(spot)
    if spot_v is None:
        return _NAN
    closes = _clean_closes(bars)
    ma = _sma(closes, n)
    if not math.isfinite(ma):
        return _NAN
    return (spot_v - ma) / spot_v


# ── B2 ADX(14) on 5-min bars ──────────────────────────────────────────────


def _wilder_adx_5m(bars: list[Bar]) -> float:
    """Standard Wilder ADX(14). NaN until ≥ 2·14 = 28 bars exist.

    Algorithm (Wilder 1978):
        TR  = max(H−L, |H−prevC|, |L−prevC|)
        +DM = max(H−prevH, 0) if (H−prevH) > (prevL−L) else 0
        −DM = max(prevL−L, 0) if (prevL−L) > (H−prevH) else 0
        Smooth TR, +DM, −DM with Wilder over 14 bars.
        +DI = 100·smooth(+DM)/smooth(TR);  −DI = mirror.
        DX  = 100·|+DI − (−DI)| / (+DI + −DI).
        ADX = Wilder smooth of DX over 14 bars.
    """
    if len(bars) < 2 * _ADX_PERIOD:
        return _NAN

    # Per-bar TR / DM series (skip bar 0 since we need a "prev" bar).
    trs: list[float] = []
    plus_dms: list[float] = []
    minus_dms: list[float] = []
    for i in range(1, len(bars)):
        prev = bars[i - 1]
        cur = bars[i]
        if not all(math.isfinite(v) for v in (cur.high, cur.low, prev.close, prev.high, prev.low)):
            return _NAN
        tr = max(
            cur.high - cur.low,
            abs(cur.high - prev.close),
            abs(cur.low - prev.close),
        )
        up_move = cur.high - prev.high
        down_move = prev.low - cur.low
        plus_dm = up_move if (up_move > down_move and up_move > 0) else 0.0
        minus_dm = down_move if (down_move > up_move and down_move > 0) else 0.0
        trs.append(tr)
        plus_dms.append(plus_dm)
        minus_dms.append(minus_dm)

    if len(trs) < 2 * _ADX_PERIOD - 1:
        return _NAN

    def _wilder_smooth(values: list[float]) -> list[float]:
        """Wilder smoothing: seed = sum of first n; thereafter rolling decay."""
        smoothed = [_NAN] * len(values)
        seed = sum(values[:_ADX_PERIOD])
        smoothed[_ADX_PERIOD - 1] = seed
        prev_s = seed
        for j in range(_ADX_PERIOD, len(values)):
            prev_s = prev_s - (prev_s / _ADX_PERIOD) + values[j]
            smoothed[j] = prev_s
        return smoothed

    str_smoothed = _wilder_smooth(trs)
    plus_smoothed = _wilder_smooth(plus_dms)
    minus_smoothed = _wilder_smooth(minus_dms)

    # DX series wherever all three smoothed series have valid values.
    dxs: list[float] = []
    for tr_s, plus_s, minus_s in zip(str_smoothed, plus_smoothed, minus_smoothed):
        if not (math.isfinite(tr_s) and math.isfinite(plus_s) and math.isfinite(minus_s)):
            continue
        if tr_s <= 0:
            continue
        plus_di = 100.0 * plus_s / tr_s
        minus_di = 100.0 * minus_s / tr_s
        di_sum = plus_di + minus_di
        if di_sum <= 0:
            dxs.append(0.0)
        else:
            dxs.append(100.0 * abs(plus_di - minus_di) / di_sum)

    if len(dxs) < _ADX_PERIOD:
        return _NAN

    # Wilder smoothing of DX → ADX. Seed with simple mean of first 14 DX.
    adx = sum(dxs[:_ADX_PERIOD]) / _ADX_PERIOD
    for d in dxs[_ADX_PERIOD:]:
        adx = (adx * (_ADX_PERIOD - 1) + d) / _ADX_PERIOD
    return adx


def _momentum_ratio(bars: list[Bar]) -> float:
    """latest_close / prev_close. NaN if fewer than 2 valid bars."""
    closes = _clean_closes(bars)
    if len(closes) < 2:
        return _NAN
    prev = closes[-2]
    if prev <= 0:
        return _NAN
    return closes[-1] / prev


# ── B4 Pattern flags ──────────────────────────────────────────────────────


def _consec_higher_highs(bars: list[Bar]) -> float:
    """Count of trailing bars whose high > prior bar's high."""
    n = len(bars)
    if n < 2:
        return _NAN
    count = 0
    for i in range(n - 1, 0, -1):
        if not (math.isfinite(bars[i].high) and math.isfinite(bars[i - 1].high)):
            break
        if bars[i].high > bars[i - 1].high:
            count += 1
            if count >= _HH_HL_MAX_LOOKBACK:
                break
        else:
            break
    return float(count)


def _consec_higher_lows(bars: list[Bar]) -> float:
    n = len(bars)
    if n < 2:
        return _NAN
    count = 0
    for i in range(n - 1, 0, -1):
        if not (math.isfinite(bars[i].low) and math.isfinite(bars[i - 1].low)):
            break
        if bars[i].low > bars[i - 1].low:
            count += 1
            if count >= _HH_HL_MAX_LOOKBACK:
                break
        else:
            break
    return float(count)


def _range_compression_ratio(bars: list[Bar]) -> float:
    """current.range ÷ mean(prior 10 bars' ranges). NaN if < 11 bars."""
    if len(bars) < _RANGE_COMPRESSION_BASELINE_BARS + 1:
        return _NAN
    cur = bars[-1]
    cur_range = cur.high - cur.low
    if not math.isfinite(cur_range) or cur_range < 0:
        return _NAN

    baseline_bars = bars[-(_RANGE_COMPRESSION_BASELINE_BARS + 1):-1]
    ranges = [b.high - b.low for b in baseline_bars if math.isfinite(b.high - b.low)]
    if len(ranges) < _RANGE_COMPRESSION_BASELINE_BARS:
        return _NAN
    avg_range = sum(ranges) / len(ranges)
    if avg_range <= 0:
        return _NAN
    return cur_range / avg_range


# ── Public API ────────────────────────────────────────────────────────────


def compute_multi_tf_features(
    spot: float | None,
    bars_1m: list[Bar] | None,
    bars_5m: list[Bar] | None,
    bars_15m: list[Bar] | None,
) -> dict[str, float]:
    """
    Compute all 11 B1/B2/B4 features in a single call.

    Args:
        spot:     Current underlying spot (for MA ratios).
        bars_1m:  Finalised 1-min bars from BarAggregator.
        bars_5m:  Finalised 5-min bars.
        bars_15m: Finalised 15-min bars.

    Returns:
        Dict of 11 float features. NaN where insufficient history.
    """
    bars_1m = bars_1m or []
    bars_5m = bars_5m or []
    bars_15m = bars_15m or []

    return {
        # B1
        "ma_5_1min": _ma_ratio(spot, bars_1m, 5),
        "ma_20_1min": _ma_ratio(spot, bars_1m, 20),
        "ma_5_5min": _ma_ratio(spot, bars_5m, 5),
        "ma_20_5min": _ma_ratio(spot, bars_5m, 20),
        "ma_5_15min": _ma_ratio(spot, bars_15m, 5),
        # B2
        "adx_5min": _wilder_adx_5m(bars_5m),
        "momentum_5min": _momentum_ratio(bars_5m),
        "momentum_15min": _momentum_ratio(bars_15m),
        # B4
        "consecutive_higher_highs_5min": _consec_higher_highs(bars_5m),
        "consecutive_higher_lows_5min": _consec_higher_lows(bars_5m),
        "range_compression_ratio": _range_compression_ratio(bars_5m),
    }
