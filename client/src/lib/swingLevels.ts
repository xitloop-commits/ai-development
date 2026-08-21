/**
 * swingLevels — T168 higher-high / lower-low swing pivots for the chart.
 *
 * Pure market-structure analysis of a candle series, INDEPENDENT of any trade or
 * entry. A swing HIGH (peak) is a candle whose high is strictly greater than the
 * highs of `strength` candles on EACH side; a swing LOW (trough) mirrors it on
 * lows. We return the last `count` of each — drawn as horizontal S/R lines
 * (green highs = T1..Tn, red lows = S1..Sn).
 *
 * A pivot needs `strength` candles AFTER it to confirm, so the most recent
 * `strength` candles are never pivots yet (a small, expected confirmation lag).
 */

export interface SwingLevel {
  /** The pivot price (candle high for a peak, candle low for a trough). */
  price: number;
  /** The pivot candle's time (chart units — already IST-shifted by the caller). */
  time: number;
}

export interface SwingLevels {
  /** Swing peaks, oldest→newest (label T1..Tn: T1 = oldest of the kept set). */
  highs: SwingLevel[];
  /** Swing troughs, oldest→newest (label S1..Sn). */
  lows: SwingLevel[];
}

export interface Bar {
  time: number;
  high: number;
  low: number;
}

/**
 * Compute the last `count` swing highs + lows from `bars`.
 *
 * @param strength candles required on each side to confirm a pivot (>=1).
 * @param count    how many of each to keep (the most recent).
 */
export function computeSwingLevels(
  bars: Bar[],
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
    if (isHigh) highs.push({ price: c.high, time: c.time });
    if (isLow) lows.push({ price: c.low, time: c.time });
  }
  const k = Math.max(1, Math.floor(count));
  return { highs: highs.slice(-k), lows: lows.slice(-k) };
}
