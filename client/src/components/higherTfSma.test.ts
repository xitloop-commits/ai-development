/**
 * higherTfSma — the SMA5 line computed on the SIGNAL's timeframe and mapped back
 * onto finer display candles (so the drawn line matches the fires on 2m/3m/5m).
 */
import { describe, it, expect } from "vitest";
import { higherTfSma } from "./TickChart";
import type { Candle } from "@/lib/signalChart";

// 1-minute display candles at t = 0,60,120,… (raw closes rising by 10).
const mk = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 1000 + i * 10;
    return { time: (i * 60) as Candle["time"], open: c, high: c, low: c, close: c };
  });

describe("higherTfSma", () => {
  it("tfSec === display interval reduces to the plain per-candle SMA", () => {
    const r = higherTfSma(mk(6), 60, 3, false); // 60s buckets = one per display candle
    // period-3 SMA of 1000,1010,1020,… ready at index 2 = mean(1000,1010,1020)=1010
    expect(r.sma[0]).toBeNull();
    expect(r.sma[1]).toBeNull();
    expect(r.sma[2]).toBeCloseTo(1010, 6);
    expect(r.sma[5]).toBeCloseTo(1040, 6);
  });

  it("3m buckets: the line is a STEP that holds across the 3 display candles of each signal candle", () => {
    // 9 one-minute candles → 3 three-minute signal candles.
    // signal closes = last raw close of each bucket = 1020, 1050, 1080.
    // period-3 SMA ready only on the 3rd signal candle = mean(1020,1050,1080)=1050.
    const r = higherTfSma(mk(9), 180, 3, false);
    // display candles 0-5 fall in signal candles 0-1 (SMA not ready) → null.
    expect(r.sma.slice(0, 6).every((v) => v === null)).toBe(true);
    // display candles 6,7,8 fall in signal candle 2 → all show 1050 (a flat step).
    expect(r.sma[6]).toBeCloseTo(1050, 6);
    expect(r.sma[7]).toBeCloseTo(1050, 6);
    expect(r.sma[8]).toBeCloseTo(1050, 6);
    // the "close" used for colouring is the signal candle's close (1080), held flat.
    expect(r.close[6]).toBeCloseTo(1080, 6);
    expect(r.close[8]).toBeCloseTo(1080, 6);
  });

  it("empty input is safe", () => {
    expect(higherTfSma([], 180, 5, true)).toEqual({ sma: [], close: [] });
  });
});
