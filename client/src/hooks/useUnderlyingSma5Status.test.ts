import { describe, it, expect } from "vitest";
import { computeSma5Status } from "./useUnderlyingSma5Status";
import type { Candle } from "@/lib/signalChart";

const C = (close: number, i: number): Candle =>
  ({ time: (i * 60) as any, open: close, high: close, low: close, close });
const candles = (...closes: number[]) => closes.map((c, i) => C(c, i));

describe("computeSma5Status", () => {
  const base = { useHa: false, period: 3, confirm: 1, buffer: 0 };

  it("warms up until there are enough candles", () => {
    const s = computeSma5Status(candles(10, 11), base)!;
    expect(s.tone).toBe("flat");
    expect(s.text).toMatch(/warming up/i);
  });

  it("steady rising = in the CALL", () => {
    const s = computeSma5Status(candles(10, 11, 12, 13, 14), base)!;
    expect(s.tone).toBe("up");
    expect(s.text).toMatch(/in the CALL/);
  });

  it("steady falling = in the PUT", () => {
    const s = computeSma5Status(candles(14, 13, 12, 11, 10), base)!;
    expect(s.tone).toBe("down");
    expect(s.text).toMatch(/in the PUT/);
  });

  it("confirm 2: a single candle below shows 'waiting to confirm (1 of 2)', not an exit", () => {
    const s = computeSma5Status(candles(10, 11, 12, 13, 14, 5), { ...base, confirm: 2 })!;
    expect(s.tone).toBe("pending");
    expect(s.text).toMatch(/waiting to confirm exit \(1 of 2\)/);
    expect(s.text).toMatch(/exits the CALL/);
  });

  it("confirm 1: the same candle below flips straight to the PUT", () => {
    const s = computeSma5Status(candles(10, 11, 12, 13, 14, 5), { ...base, confirm: 1 })!;
    expect(s.tone).toBe("down");
  });

  it("settings suffix shows confirm and (when set) buffer", () => {
    expect(computeSma5Status(candles(10, 11, 12, 13, 14), { ...base, confirm: 2, buffer: 0.1 })!.settings)
      .toBe("confirm 2 · buffer 0.1%");
    expect(computeSma5Status(candles(10, 11, 12, 13, 14), base)!.settings).toBe("confirm 1");
  });
});
