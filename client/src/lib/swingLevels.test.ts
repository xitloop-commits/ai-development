import { describe, it, expect } from "vitest";
import { computeSwingLevels } from "./swingLevels";

describe("computeSwingLevels (T168 swing S/R)", () => {
  const bars = [
    { time: 0, high: 10, low: 9 },
    { time: 1, high: 13, low: 12 }, // swing HIGH (13 > 10 and 11)
    { time: 2, high: 11, low: 10 },
    { time: 3, high: 10, low: 6 }, // swing LOW  (6 < 10 and 7)
    { time: 4, high: 12, low: 7 }, // swing HIGH (12 > 10 and 11)
    { time: 5, high: 11, low: 8 }, // last bar → never a pivot (needs strength after)
  ];

  it("detects swing peaks and troughs (strength 1)", () => {
    const r = computeSwingLevels(bars, 1, 3);
    expect(r.highs.map((h) => h.price)).toEqual([13, 12]);
    expect(r.lows.map((l) => l.price)).toEqual([6]);
  });

  it("keeps only the last `count` of each (most recent)", () => {
    const r = computeSwingLevels(bars, 1, 1);
    expect(r.highs.map((h) => h.price)).toEqual([12]); // newest peak only
    expect(r.lows.map((l) => l.price)).toEqual([6]);
  });

  it("the most recent `strength` candles are never pivots (confirmation lag)", () => {
    // bar 5 (high 11) would be a peak vs bar 4, but has no bar after it → excluded.
    const r = computeSwingLevels(bars, 1, 5);
    expect(r.highs.some((h) => h.time === 5)).toBe(false);
  });

  it("carries the pivot time through for the chart", () => {
    const r = computeSwingLevels(bars, 1, 3);
    expect(r.highs[0]).toEqual({ price: 13, time: 1 });
    expect(r.lows[0]).toEqual({ price: 6, time: 3 });
  });
});
