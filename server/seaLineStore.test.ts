import { describe, it, expect, beforeEach } from "vitest";
import { insertSeaLine, getSeaLines, _resetSeaLineStore } from "./seaLineStore";

const S = (t: number, line: number, state: -1 | 0 | 1 = 1, close = line, deg = 0) => ({ t, line, state, close, deg });

describe("seaLineStore", () => {
  beforeEach(() => _resetSeaLineStore());

  it("returns [] for a series that was never posted", () => {
    expect(getSeaLines("banknifty", "2026-08-21", "111", "sma5")).toEqual([]);
  });

  it("appends closed-candle samples in time order", () => {
    insertSeaLine("banknifty", "2026-08-21", "111", "sma5", S(60, 100));
    insertSeaLine("banknifty", "2026-08-21", "111", "sma5", S(120, 101));
    expect(getSeaLines("banknifty", "2026-08-21", "111", "sma5").map((s) => s.t)).toEqual([60, 120]);
  });

  it("overwrites (not duplicates) when the same candle is re-closed", () => {
    insertSeaLine("banknifty", "2026-08-21", "111", "sma5", S(60, 100, 1));
    insertSeaLine("banknifty", "2026-08-21", "111", "sma5", S(60, 105, -1));
    const arr = getSeaLines("banknifty", "2026-08-21", "111", "sma5");
    expect(arr).toHaveLength(1);
    expect(arr[0]).toEqual({ t: 60, line: 105, state: -1, close: 105, deg: 0 });
  });

  it("keeps separate series per kind / securityId / date", () => {
    insertSeaLine("banknifty", "2026-08-21", "111", "sma5", S(60, 100));
    insertSeaLine("banknifty", "2026-08-21", "111", "ma", S(60, 200));
    insertSeaLine("banknifty", "2026-08-21", "222", "sma5", S(60, 300));
    insertSeaLine("banknifty", "2026-08-20", "111", "sma5", S(60, 400));
    expect(getSeaLines("banknifty", "2026-08-21", "111", "sma5")[0].line).toBe(100);
    expect(getSeaLines("banknifty", "2026-08-21", "111", "ma")[0].line).toBe(200);
    expect(getSeaLines("banknifty", "2026-08-21", "222", "sma5")[0].line).toBe(300);
    expect(getSeaLines("banknifty", "2026-08-20", "111", "sma5")[0].line).toBe(400);
  });

  it("normalizes the instrument key (NIFTY_50 == nifty50)", () => {
    insertSeaLine("NIFTY_50", "2026-08-21", "13", "sma5", S(60, 99));
    expect(getSeaLines("nifty50", "2026-08-21", "13", "sma5")[0].line).toBe(99);
  });

  it("caps the series length (drops the oldest)", () => {
    for (let i = 0; i < 650; i++) insertSeaLine("banknifty", "2026-08-21", "111", "sma5", S(i * 60, i));
    const arr = getSeaLines("banknifty", "2026-08-21", "111", "sma5");
    expect(arr.length).toBe(600);
    expect(arr[0].line).toBe(50); // first 50 dropped
    expect(arr[arr.length - 1].line).toBe(649);
  });
});
