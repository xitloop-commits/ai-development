import { describe, it, expect } from "vitest";
import { manualRiskSlTp } from "./riskMode";

describe("manualRiskSlTp — configured SL/TP for AI trades in manual risk mode", () => {
  it("derives SL below and TP above entry from the configured %", () => {
    const { stopLoss, takeProfit } = manualRiskSlTp(1000, 2, 30);
    expect(stopLoss).toBe(980); // 2% below
    expect(takeProfit).toBe(1300); // 30% above
  });

  it("rounds to 2 decimals", () => {
    const { stopLoss, takeProfit } = manualRiskSlTp(103, 2, 30);
    expect(stopLoss).toBe(100.94); // 103 * 0.98
    expect(takeProfit).toBe(133.9); // 103 * 1.30
  });

  it("a tight SL% keeps the stop just under entry (no 5-19% blowups)", () => {
    const { stopLoss } = manualRiskSlTp(940.85, 2, 30);
    expect(stopLoss).toBeCloseTo(922.03, 2); // 2% stop, not the model's drift
  });
});