/**
 * Net-₹ exits — SL/TP as a net rupee P&L (after charges) instead of a premium %.
 *
 * fs is mocked so updateExitConfig can't touch the real trading config (a test
 * mutating the live config has broken this project before — see
 * resolveExitStrategy.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { initAiConfig, updateExitConfig, sprintOpeningLevels } from "./aiModeConfig";
import { resolveNetRsExit, netPnlAtPrice } from "./netRsExit";
import type { TradeRecord } from "./state";
import type { ChargeRate } from "./charges";

beforeEach(() => initAiConfig());

describe("resolveNetRsExit — reads the ₹-mode config per strategy", () => {
  it("returns null when both sides are percent (the default)", () => {
    expect(resolveNetRsExit("sprint", "live")).toBeNull();
    expect(resolveNetRsExit("runway", "live")).toBeNull();
    expect(resolveNetRsExit("anchor", "live")).toBeNull();
  });

  it("returns null for glide and unknown strategies (they have no SL/TP)", () => {
    expect(resolveNetRsExit("glide", "live")).toBeNull();
    expect(resolveNetRsExit(null, "live")).toBeNull();
    expect(resolveNetRsExit(undefined, "live")).toBeNull();
  });

  it("surfaces Sprint's ₹ figures when a side is flipped to rupees", () => {
    updateExitConfig("live", { sprint: { slMode: "rupees", defaultSL: 2000, tpMode: "rupees", defaultTP: 3000 } });
    expect(resolveNetRsExit("sprint", "live")).toEqual({
      slMode: "rupees", tpMode: "rupees", slRs: 2000, tpRs: 3000,
    });
  });

  it("supports a MIXED trade — ₹ stop, % target", () => {
    updateExitConfig("live", { sprint: { slMode: "rupees", defaultSL: 1500, tpMode: "percent" } });
    const r = resolveNetRsExit("sprint", "live");
    expect(r?.slMode).toBe("rupees");
    expect(r?.tpMode).toBe("percent");
    expect(r?.slRs).toBe(1500);
  });

  it("reads Runway/Anchor ₹ figures from defaultSlPct / defaultTargetPct", () => {
    updateExitConfig("live", { runway: { slMode: "rupees", defaultSlPct: 2500, tpMode: "rupees", defaultTargetPct: 4000 } });
    expect(resolveNetRsExit("runway", "live")).toEqual({
      slMode: "rupees", tpMode: "rupees", slRs: 2500, tpRs: 4000,
    });
  });
});

describe("netPnlAtPrice — gross move minus round-trip charges", () => {
  const trade = (over: Partial<TradeRecord> = {}): TradeRecord =>
    ({ type: "CALL_BUY", entryPrice: 100, qty: 100, ...over } as TradeRecord);

  it("with no charge rates returns pure gross P&L", () => {
    // long, premium 100 → 130, 100 qty → +₹3,000 gross, no charges.
    expect(netPnlAtPrice(trade(), 130, [])).toBe(3000);
  });

  it("mirrors direction for a short (profit when premium falls)", () => {
    expect(netPnlAtPrice(trade({ type: "PUT_SELL" }), 80, [])).toBe(2000); // sold 100, now 80
    expect(netPnlAtPrice(trade({ type: "PUT_SELL" }), 120, [])).toBe(-2000);
  });

  it("subtracts charges so the net is below the gross", () => {
    // 1% flat percent charge on each leg's turnover.
    const rates: ChargeRate[] = [{ name: "brokerage", unit: "percent", rate: 1, enabled: true } as ChargeRate];
    // gross = (130-100)*100 = 3000; entry leg = 1% of 100*100 = 100; exit leg = 1% of 130*100 = 130.
    // net = 3000 - 100 - 130 = 2770.
    expect(netPnlAtPrice(trade(), 130, rates)).toBe(2770);
  });
});

describe("sprintOpeningLevels — mode-aware opening price for gate + TradeBar", () => {
  it("percent mode is unchanged — % of the premium", () => {
    updateExitConfig("live", { sprint: { slMode: "percent", defaultSL: 10, tpMode: "percent", defaultTP: 5 } });
    expect(sprintOpeningLevels("live", 100, true, 100)).toEqual({ stopLoss: 90, takeProfit: 105 });
  });

  it("rupees mode spreads the ₹ over the position (₹ / qty) around entry", () => {
    // ₹2,000 stop over 100 qty = ₹20/unit → stop 80; ₹3,000 tp = ₹30/unit → target 130.
    updateExitConfig("live", { sprint: { slMode: "rupees", defaultSL: 2000, tpMode: "rupees", defaultTP: 3000 } });
    expect(sprintOpeningLevels("live", 100, true, 100)).toEqual({ stopLoss: 80, takeProfit: 130 });
  });

  it("mirrors ₹ levels for a short", () => {
    updateExitConfig("live", { sprint: { slMode: "rupees", defaultSL: 2000, tpMode: "rupees", defaultTP: 3000 } });
    expect(sprintOpeningLevels("live", 100, false, 100)).toEqual({ stopLoss: 120, takeProfit: 70 });
  });

  it("falls back to a WIDE placeholder in ₹ mode when qty is unknown (never front-runs the net check)", () => {
    updateExitConfig("live", { sprint: { slMode: "rupees", defaultSL: 2000, tpMode: "rupees", defaultTP: 3000 } });
    // qty omitted → 50% of entry each side, so the price stop can't fire before
    // the per-tick net check does.
    expect(sprintOpeningLevels("live", 100, true)).toEqual({ stopLoss: 50, takeProfit: 150 });
  });
});
