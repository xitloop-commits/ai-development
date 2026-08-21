/**
 * swingLevels — server-side swing pivots (T169/T171 Rider).
 *
 * Mirror of client/src/lib/swingLevels.ts, so the server computes the SAME
 * higher-high / lower-low structure the chart draws. A swing HIGH (peak) is a
 * candle whose high is strictly greater than the highs of `strength` candles on
 * each side; a swing LOW (trough) mirrors it on lows. Used by:
 *   - the Rider stop's SUPPORT-START (nearest swing low below entry), and
 *   - (later) the Next-T TP (nearest swing high above price).
 *
 * A pivot needs `strength` candles AFTER it to confirm, so the most recent
 * `strength` candles are never pivots yet (a small, expected confirmation lag).
 */

export interface SwingLevel {
  /** Pivot price (candle high for a peak, candle low for a trough). */
  price: number;
  /** Pivot candle's bucket-start epoch seconds. */
  t: number;
}

export interface SwingBar {
  t: number;
  high: number;
  low: number;
}

export interface SwingLevels {
  /** Swing peaks, oldest -> newest. */
  highs: SwingLevel[];
  /** Swing troughs, oldest -> newest. */
  lows: SwingLevel[];
}

/**
 * Compute the last `count` swing highs + lows from `bars`.
 *
 * @param strength candles required on each side to confirm a pivot (>=1).
 * @param count    how many of each to keep (the most recent).
 */
export function computeSwingLevels(
  bars: SwingBar[],
  strength = 2,
  count = 3,
): SwingLevels {
  const s = Math.max(1, Math.floor(strength));
  const n = bars.length;
  const highs: SwingLevel[] = [];
  const lows: SwingLevel[] = [];
  for (let i = s; i < n - s; i++) {
    const c = bars[i];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= s; j++) {
      if (bars[i - j].high >= c.high || bars[i + j].high >= c.high) isHigh = false;
      if (bars[i - j].low <= c.low || bars[i + j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ price: c.high, t: c.t });
    if (isLow) lows.push({ price: c.low, t: c.t });
  }
  const k = Math.max(1, Math.floor(count));
  return { highs: highs.slice(-k), lows: lows.slice(-k) };
}

/**
 * The Rider stop's support-start: the nearest swing LOW strictly BELOW `entry`
 * (a real support to place the initial stop at). Returns null when no swing low
 * qualifies — the caller then falls back to the x-back candle low.
 */
export function nearestSupportBelow(
  bars: SwingBar[],
  entry: number,
  strength = 2,
  count = 3,
): number | null {
  const { lows } = computeSwingLevels(bars, strength, count);
  const below = lows.map((l) => l.price).filter((p) => p < entry);
  return below.length ? Math.max(...below) : null; // nearest = highest low still below entry
}
