import { describe, it, expect } from "vitest";
import { computeSwingLevels, nearestSupportBelow } from "./swingLevels";

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
