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

import { initAiConfig, updateExitConfig, sprintOpeningLevels, getExitConfig, getCommonConfig, updateCommonConfig } from "./aiModeConfig";
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

  it("never handles glide — its optional TP is owned by the glide branch, not resolveNetRsExit", () => {
    updateExitConfig("live", { glide: { tpEnabled: true, tpMode: "rupees", tp: 5000 } });
    expect(resolveNetRsExit("glide", "live")).toBeNull();
  });
});

describe("glide optional TP config (default off)", () => {
  it("defaults to off, percent, and survives an old config", () => {
    initAiConfig();
    const g = getExitConfig("live").glide;
    expect(g.tpEnabled).toBe(false);
    expect(g.tpMode).toBe("percent");
    expect(typeof g.tp).toBe("number");
  });

  it("stores an enabled ₹ TP and clamps it into the net-₹ band", () => {
    updateExitConfig("live", { glide: { tpEnabled: true, tpMode: "rupees", tp: 5000 } });
    const g = getExitConfig("live").glide;
    expect(g.tpEnabled).toBe(true);
    expect(g.tpMode).toBe("rupees");
    expect(g.tp).toBe(5000);
  });
});

describe("master exits (common block, T141)", () => {
  it("default: all three off, percent, back-filled on an old config", () => {
    initAiConfig();
    const m = getCommonConfig().masterExits;
    expect(m.tp.enabled).toBe(false);
    expect(m.sl.enabled).toBe(false);
    expect(m.tsl.enabled).toBe(false);
    expect(m.tp.mode).toBe("percent");
  });

  it("stores enabled ₹ master levels and clamps into the net-₹ band", () => {
    updateCommonConfig({ masterExits: {
      tp: { enabled: true, mode: "rupees", value: 3000 },
      sl: { enabled: true, mode: "rupees", value: 2000 },
      tsl: { enabled: true, mode: "rupees", value: 1000 },
    } });
    const m = getCommonConfig().masterExits;
    expect(m.tp).toEqual({ enabled: true, mode: "rupees", value: 3000 });
    expect(m.sl.value).toBe(2000);
    expect(m.tsl.value).toBe(1000);
  });

  it("a partial patch leaves the other master levels intact", () => {
    updateCommonConfig({ masterExits: { sl: { enabled: true, mode: "percent", value: 8 } } as any });
    const m = getCommonConfig().masterExits;
    expect(m.sl.enabled).toBe(true);
    expect(m.tp).toBeDefined(); // not wiped by the partial patch
    expect(m.tsl).toBeDefined();
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
