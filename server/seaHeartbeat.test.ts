import { describe, it, expect } from "vitest";
import { recordSeaHeartbeat, getSeaStatus } from "./seaHeartbeat";

describe("seaHeartbeat", () => {
  it("marks an instrument alive right after a heartbeat", () => {
    recordSeaHeartbeat("nifty50");
    const status = getSeaStatus();
    const nifty = status.instruments.find((i) => i.instrument === "nifty50");
    expect(nifty?.alive).toBe(true);
    expect(nifty?.ageSec).toBeLessThan(5);
    expect(status.anyAlive).toBe(true);
    expect(status.aliveCount).toBeGreaterThanOrEqual(1);
  });

  it("normalizes instrument names (case / punctuation insensitive)", () => {
    recordSeaHeartbeat("BANK-NIFTY");
    const status = getSeaStatus();
    expect(status.instruments.some((i) => i.instrument === "banknifty")).toBe(true);
  });

  it("ignores empty instrument", () => {
    const before = getSeaStatus().instruments.length;
    recordSeaHeartbeat("");
    expect(getSeaStatus().instruments.length).toBe(before);
  });
});
