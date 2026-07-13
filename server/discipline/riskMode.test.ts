import { describe, it, expect } from "vitest";
import { manualRiskSlTp, riskSlTp, netProfitTargetPrice, type RiskSettingsLite } from "./riskMode";

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

describe("riskSlTp — percent | fixed risk resolution", () => {
  const PCT: RiskSettingsLite = { slMode: "percent", targetMode: "percent", defaultSL: 2, tradeTargetOptions: 30, tradeTargetOther: 2 };
  const FIXED: RiskSettingsLite = { slMode: "fixed", targetMode: "fixed", slFixedOptions: 10, slFixedOther: 5, tradeTargetOptionsFixed: 40, tradeTargetOtherFixed: 5 };

  it("percent mode, long option: % of entry around entry", () => {
    expect(riskSlTp(100, { isOption: true, isLong: true, settings: PCT })).toEqual({ stopLoss: 98, takeProfit: 130 });
  });

  it("fixed mode, long option: absolute ₹ distances", () => {
    expect(riskSlTp(100, { isOption: true, isLong: true, settings: FIXED })).toEqual({ stopLoss: 90, takeProfit: 140 });
  });

  it("fixed mode, others: uses the others (points) distances", () => {
    expect(riskSlTp(100, { isOption: false, isLong: true, settings: FIXED })).toEqual({ stopLoss: 95, takeProfit: 105 });
  });

  it("short position reverses stop/target", () => {
    expect(riskSlTp(100, { isOption: true, isLong: false, settings: PCT })).toEqual({ stopLoss: 102, takeProfit: 70 });
  });

  it("mixed: fixed SL + percent target", () => {
    const mixed: RiskSettingsLite = { ...FIXED, targetMode: "percent", tradeTargetOptions: 30 };
    expect(riskSlTp(100, { isOption: true, isLong: true, settings: mixed })).toEqual({ stopLoss: 90, takeProfit: 130 });
  });

  it("falls back to sane defaults when settings are empty", () => {
    const r = riskSlTp(100, { isOption: true, isLong: true, settings: {} });
    expect(r).toEqual({ stopLoss: 98, takeProfit: 130 });
  });
});

describe("netProfitTargetPrice — target price that nets a ₹ profit after charges", () => {
  it("long: exit set so gross − charges ≈ netTarget", () => {
    const tp = netProfitTargetPrice(100, true, 30, 500, () => 45);
    expect(tp).toBe(118.17); // (500 + 45) / 30 above entry
    const net = (tp - 100) * 30 - 45;
    expect(net).toBeCloseTo(500, 0); // nets the target
  });

  it("short: exit below entry, still nets the target", () => {
    const tp = netProfitTargetPrice(100, false, 30, 300, () => 30);
    expect(tp).toBe(89); // (300 + 30) / 30 below entry
    const net = (100 - tp) * 30 - 30;
    expect(net).toBeCloseTo(300, 0);
  });

  it("degrades to entry ± netTarget when qty is unknown", () => {
    expect(netProfitTargetPrice(100, true, 0, 500, () => 45)).toBe(600);
  });
});