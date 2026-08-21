/**
 * candles.ts (shared) — the ONE candle bucketer used by both the client chart
 * and the server's authoritative line/swing computation (T169-B).
 *
 * Buckets chronological ticks (epoch SECONDS, UTC) into OHLC candles of
 * `bucketSec`. Kept deliberately tiny + dependency-free so client and server run
 * the identical aggregation — no drift between "what the chart draws" and "what
 * the server computes". Times are RAW bucket-start epoch seconds (no IST shift);
 * the chart applies its own display offset where it needs one.
 */

export interface OhlcCandle {
  /** Bucket-start epoch seconds (raw, UTC). */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Bucket in-order ticks into OHLC candles of `bucketSec` seconds. Ignores
 * non-positive timestamps/prices. Assumes ticks are time-ordered (recorded
 * append order is).
 */
export function bucketTicksToCandles(
  t: number[],
  ltp: number[],
  bucketSec: number,
): OhlcCandle[] {
  const n = Math.min(t.length, ltp.length);
  if (n === 0 || bucketSec <= 0) return [];
  const out: OhlcCandle[] = [];
  let curStart = -1;
  let cur: OhlcCandle | null = null;
  for (let i = 0; i < n; i++) {
    const ts = t[i];
    const price = ltp[i];
    if (!(ts > 0) || !(price > 0)) continue;
    const bucketStart = Math.floor(ts / bucketSec) * bucketSec;
    if (bucketStart !== curStart) {
      if (cur) out.push(cur);
      curStart = bucketStart;
      cur = { t: bucketStart, open: price, high: price, low: price, close: price };
    } else if (cur) {
      if (price > cur.high) cur.high = price;
      if (price < cur.low) cur.low = price;
      cur.close = price;
    }
  }
  if (cur) out.push(cur);
  return out;
}
