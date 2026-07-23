/**
 * The live-option confirm guard. This is what stands between a click and a real
 * order, and it is now shared by the desk and the watchlist index rows — so a
 * regression here silently un-guards every entry point at once.
 */
import { describe, it, expect } from "vitest";
import { liveOptionConfirm, liveStockConfirm, isOptionTrade } from "./optionOrderConfirm";

const buy = { instrument: "NIFTY_50", type: "CALL_BUY", strike: 24_500, entryPrice: 120.5, qty: 75 };

describe("isOptionTrade", () => {
  it("recognises option types", () => {
    for (const t of ["CALL_BUY", "PUT_BUY", "CALL_SELL", "PUT_SELL"]) {
      expect(isOptionTrade(t)).toBe(true);
    }
  });
  it("does not treat equity orders as options", () => {
    expect(isOptionTrade("BUY")).toBe(false);
    expect(isOptionTrade("SELL")).toBe(false);
  });
});

describe("liveOptionConfirm", () => {
  it("confirms an option order on a LIVE channel", () => {
    const c = liveOptionConfirm("live", buy);
    expect(c).not.toBeNull();
    expect(c!.title).toMatch(/LIVE/);
    expect(c!.message).toContain("BUY");
    expect(c!.message).toContain("NIFTY_50");
    expect(c!.message).toContain("24500");
    expect(c!.message).toContain("CE");
    expect(c!.message).toContain("REAL order");
  });

  it("confirms on live too, not just live", () => {
    expect(liveOptionConfirm("live", buy)).not.toBeNull();
  });

  it("does NOT confirm on paper — simulated money places immediately", () => {
    expect(liveOptionConfirm("paper", buy)).toBeNull();
  });

  it("does NOT confirm equity orders (they have their own staged-buy dialog)", () => {
    expect(liveOptionConfirm("live", { ...buy, type: "BUY" })).toBeNull();
  });

  it("labels a PUT as PE and a sell as SELL", () => {
    const c = liveOptionConfirm("live", { ...buy, type: "PUT_SELL" });
    expect(c!.message).toContain("PE");
    expect(c!.message).toContain("SELL");
  });

  it("quotes the total premium at risk, not the per-unit price", () => {
    // 120.5 × 75 = 9037.5 → 9038
    const c = liveOptionConfirm("live", buy);
    expect(c!.message).toContain("9,038");
  });
});

describe("liveStockConfirm", () => {
  const order = { symbol: "ICICIBANK", qty: 50, productType: "INTRADAY" as const };

  it("confirms a LIVE stock order with share count and total value", () => {
    const c = liveStockConfirm("live", order, 1234.5);
    expect(c).not.toBeNull();
    expect(c!.message).toContain("BUY 50 ICICIBANK");
    expect(c!.message).toContain("Intraday / MIS");
    expect(c!.message).toContain("61,725"); // 1234.5 × 50
    expect(c!.message).toContain("REAL order");
  });

  it("names CNC as Delivery", () => {
    const c = liveStockConfirm("live", { ...order, productType: "CNC" }, 100);
    expect(c!.message).toContain("Delivery / CNC");
  });

  it("does NOT confirm on paper", () => {
    expect(liveStockConfirm("paper", order, 100)).toBeNull();
  });
});
