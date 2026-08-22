import { describe, it, expect } from "vitest";
import { computeSwingLevels, nearestSupportBelow, significantLevels } from "./swingLevels";

describe("computeSwingLevels (server, T171)", () => {
  const bars = [
    { t: 0, high: 10, low: 9 },
    { t: 1, high: 13, low: 12 }, // swing HIGH
    { t: 2, high: 11, low: 10 },
    { t: 3, high: 10, low: 6 }, // swing LOW
    { t: 4, high: 12, low: 7 }, // swing HIGH
    { t: 5, high: 11, low: 8 }, // last bar → never a pivot
  ];

  it("detects swing peaks and troughs (strength 1)", () => {
    const r = computeSwingLevels(bars, 1, 3);
    expect(r.highs.map((h) => h.price)).toEqual([13, 12]);
    expect(r.lows.map((l) => l.price)).toEqual([6]);
  });

  it("the most recent `strength` bars are never pivots (confirmation lag)", () => {
    const r = computeSwingLevels(bars, 1, 5);
    expect(r.highs.some((h) => h.t === 5)).toBe(false);
  });
});

describe("nearestSupportBelow (Rider support-start)", () => {
  // Two swing lows: 6 (t=3) and, with strength 1, add another below entry.
  const bars = [
    { t: 0, high: 20, low: 18 },
    { t: 1, high: 19, low: 14 }, // swing LOW 14
    { t: 2, high: 22, low: 20 },
    { t: 3, high: 21, low: 16 }, // swing LOW 16
    { t: 4, high: 23, low: 21 },
    { t: 5, high: 22, low: 19 },
  ];

  it("returns the nearest swing low below entry (highest low still under entry)", () => {
    // entry 17 → lows below are 14 and 16 → nearest = 16
    expect(nearestSupportBelow(bars, 17, 1)).toBe(16);
  });

  it("returns null when no swing low is below entry", () => {
    // entry 10 → both lows (14, 16) are ABOVE → no support below → null
    expect(nearestSupportBelow(bars, 10, 1)).toBeNull();
  });
});

describe("significantLevels (server, T172)", () => {
  // Two swing highs at ~100 (100.0 and 100.2 → within 0.3% → merge, touches 2),
  // one isolated high at 110, and a swing low at 90. Session hi/lo = 110.5 / 89.5.
  const bars = [
    { t: 0, high: 95, low: 94 },
    { t: 1, high: 100.0, low: 99 },  // swing HIGH (100.0)
    { t: 2, high: 98, low: 90 },     // swing LOW (90)
    { t: 3, high: 100.2, low: 99 },  // swing HIGH (100.2) → merges with 100.0
    { t: 4, high: 98, low: 95 },
    { t: 5, high: 110.0, low: 108 }, // swing HIGH (110)
    { t: 6, high: 105, low: 104 },
    { t: 7, high: 110.5, low: 89.5 },// extremes, but last bar → not a pivot
  ];

  it("merges nearby pivots into a retest-counted zone", () => {
    const r = significantLevels(bars, { strength: 1, mergePct: 0.3 });
    const merged = r.levels.find((l) => Math.abs(l.price - 100.1) < 0.2);
    expect(merged?.touches).toBe(2); // 100.0 + 100.2 folded together
  });

  it("keeps far-apart pivots as separate single-touch zones", () => {
    const r = significantLevels(bars, { strength: 1, mergePct: 0.3 });
    expect(r.levels.some((l) => Math.abs(l.price - 110) < 0.1 && l.touches === 1)).toBe(true);
    expect(r.levels.some((l) => Math.abs(l.price - 90) < 0.1 && l.touches === 1)).toBe(true);
  });

  it("returns the session high/low as majors", () => {
    const r = significantLevels(bars, { strength: 1, mergePct: 0.3 });
    expect(r.sessionHigh).toBe(110.5);
    expect(r.sessionLow).toBe(89.5);
  });
});
