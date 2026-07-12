/**
 * indicators — pure technical-indicator math for the instrument chart window.
 *
 * All functions take a `closes` (or OHLC) array aligned to the candle array and
 * return a same-length array with `null` during the warm-up period. The page
 * maps non-null points to lightweight-charts line data ({ time, value }).
 */

/** Simple moving average. */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period`. */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length === 0) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) {
      sum += values[i];
      if (i === period - 1) {
        prev = sum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI (0–100). */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface OHLC {
  high: number;
  low: number;
  close: number;
}

/** Wilder's ATR (average true range). */
export function atr(candles: OHLC[], period = 14): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n === 0) return out;
  const tr: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = i > 0 ? candles[i - 1].close : candles[i].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  if (n <= period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export interface SupertrendPoint {
  value: number | null;
  /** 1 = uptrend (support line below price), -1 = downtrend, null = warm-up. */
  dir: 1 | -1 | null;
}

/**
 * Supertrend (ATR bands). Standard formulation:
 *   basicUB = hl2 + mult*ATR, basicLB = hl2 − mult*ATR
 *   finalUB/finalLB carry forward unless price breaks them
 *   line flips between finalLB (uptrend) and finalUB (downtrend) on close cross.
 */
export function supertrend(candles: OHLC[], period = 10, mult = 3): SupertrendPoint[] {
  const n = candles.length;
  const out: SupertrendPoint[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { value: null, dir: null };
  const a = atr(candles, period);

  let finalUB = 0;
  let finalLB = 0;
  let prevFinalUB = 0;
  let prevFinalLB = 0;
  let prevST = 0;
  let started = false;

  for (let i = 0; i < n; i++) {
    const av = a[i];
    if (av == null) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUB = hl2 + mult * av;
    const basicLB = hl2 - mult * av;
    const prevClose = i > 0 ? candles[i - 1].close : candles[i].close;

    if (!started) {
      finalUB = basicUB;
      finalLB = basicLB;
      prevST = basicUB;
      out[i] = { value: basicUB, dir: -1 };
      prevFinalUB = finalUB;
      prevFinalLB = finalLB;
      started = true;
      continue;
    }

    finalUB = basicUB < prevFinalUB || prevClose > prevFinalUB ? basicUB : prevFinalUB;
    finalLB = basicLB > prevFinalLB || prevClose < prevFinalLB ? basicLB : prevFinalLB;

    const close = candles[i].close;
    let st: number;
    if (prevST === prevFinalUB) {
      st = close <= finalUB ? finalUB : finalLB;
    } else {
      st = close >= finalLB ? finalLB : finalUB;
    }
    out[i] = { value: st, dir: st === finalLB ? 1 : -1 };

    prevST = st;
    prevFinalUB = finalUB;
    prevFinalLB = finalLB;
  }
  return out;
}
