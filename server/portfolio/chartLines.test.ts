/**
 * chartLines.test.ts — the server-authoritative chart-line pipeline (T169-B):
 * the shared tick→candle bucketer, and its composition with the swing pivots the
 * `chartSwingLevels` tRPC query returns. Pure functions (no file/tick I/O), so
 * this pins the maths the chart now draws.
 */
import { describe, it, expect } from "vitest";
import { bucketTicksToCandles, type OhlcCandle } from "../../shared/candles";
import { sma5SignalLine, maRibbonSignal } from "../../shared/chartLines";
import { computeSwingLevels } from "./swingLevels";

/** A flat OHLC candle at `close` on bucket `t` (open=high=low=close). */
const K = (t: number, close: number): OhlcCandle => ({ t, open: close, high: close, low: close, close });

describe("bucketTicksToCandles", () => {
  it("returns [] for empty input or a non-positive bucket", () => {
    expect(bucketTicksToCandles([], [], 60)).toEqual([]);
    expect(bucketTicksToCandles([100], [10], 0)).toEqual([]);
  });

  it("collapses ticks inside one bucket into a single OHLC candle", () => {
    const t = [60, 70, 80, 90, 110]; // all in floor(ts/60)*60 = 60
    const ltp = [10, 15, 8, 12, 11];
    expect(bucketTicksToCandles(t, ltp, 60)).toEqual([
      { t: 60, open: 10, high: 15, low: 8, close: 11 },
    ]);
  });

  it("splits ticks across bucket boundaries with correct OHLC each", () => {
    const t = [60, 90, 120, 150];
    const ltp = [10, 20, 5, 7];
    expect(bucketTicksToCandles(t, ltp, 60)).toEqual([
      { t: 60, open: 10, high: 20, low: 10, close: 20 },
      { t: 120, open: 5, high: 7, low: 5, close: 7 },
    ]);
  });

  it("ignores non-positive timestamps and prices", () => {
    const t = [0, 60, -5, 70];
    const ltp = [99, 10, 99, 12];
    expect(bucketTicksToCandles(t, ltp, 60)).toEqual([
      { t: 60, open: 10, high: 12, low: 10, close: 12 },
    ]);
  });

  it("honours the bucket size (300s = 5-min candles)", () => {
    const t = [0, 240, 300, 540];
    const ltp = [1, 4, 6, 2];
    expect(bucketTicksToCandles(t, ltp, 300).map((x) => x.t)).toEqual([0, 300]);
  });
});

describe("chartSwingLevels pipeline (bucket → swing pivots)", () => {
  // Build a per-second tick stream whose 60s candles have a clear peak then
  // trough, so the swing detector (strength 1) confirms one high + one low.
  function ticksFor(candleHighsLows: Array<[number, number]>): { t: number[]; ltp: number[] } {
    const t: number[] = [];
    const ltp: number[] = [];
    candleHighsLows.forEach(([hi, lo], i) => {
      const base = i * 60;
      // open, high, low, close within the bucket (all in the same 60s window).
      t.push(base + 1, base + 20, base + 40, base + 59);
      ltp.push(lo, hi, lo, (hi + lo) / 2);
    });
    return { t, ltp };
  }

  it("finds the swing high + low the chart draws, on the bucketed candles", () => {
    // 5 candles: highs 10,20,12,8,14 — candle #2 (high 20) is a confirmed peak
    // (strength 1: higher than neighbours 10 and 12). Lows 5,9,7,3,6 — candle #4
    // (low 3) is a confirmed trough (lower than 7 and 6).
    const { t, ltp } = ticksFor([
      [10, 5],
      [20, 9],
      [12, 7],
      [8, 3],
      [14, 6],
    ]);
    const candles = bucketTicksToCandles(t, ltp, 60);
    expect(candles).toHaveLength(5);
    const sw = computeSwingLevels(
      candles.map((c) => ({ t: c.t, high: c.high, low: c.low })),
      1, // strength
      3, // count
    );
    expect(sw.highs.map((h) => h.price)).toContain(20);
    expect(sw.lows.map((l) => l.price)).toContain(3);
  });
});

describe("sma5SignalLine (min-periods=1)", () => {
  it("averages whatever is available up to `period`, from the first candle", () => {
    const sig = [10, 12, 14, 16, 18, 20].map((c, i) => K(i * 60, c));
    const line = sma5SignalLine(sig, 5, false);
    expect(line.map((b) => b.sma)).toEqual([
      10, // [10]
      11, // [10,12]
      12, // [10,12,14]
      13, // [10,12,14,16]
      14, // [10,12,14,16,18]  (full window)
      16, // [12,14,16,18,20]  (slides)
    ]);
    // close is the (raw here) candle close the colour compares against.
    expect(line.map((b) => b.close)).toEqual([10, 12, 14, 16, 18, 20]);
  });
});

describe("maRibbonSignal (slope trend)", () => {
  it("classifies a steadily RISING series as up-trend on the confirmed tail", () => {
    const sig = Array.from({ length: 12 }, (_, i) => K(i * 60, 100 + i));
    const r = maRibbonSignal(sig, { source: "ma" });
    expect(r.length).toBeGreaterThan(0);
    expect(r[r.length - 1].trend).toBe(1);
  });

  it("classifies a steadily FALLING series as down-trend on the confirmed tail", () => {
    const sig = Array.from({ length: 12 }, (_, i) => K(i * 60, 200 - i));
    const r = maRibbonSignal(sig, { source: "ma" });
    expect(r[r.length - 1].trend).toBe(-1);
  });

  it("returns [] for fewer than 2 candles", () => {
    expect(maRibbonSignal([K(0, 100)], { source: "ma" })).toEqual([]);
  });
});
