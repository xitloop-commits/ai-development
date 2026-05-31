import { describe, expect, it } from "vitest";
import { resolveDhanOrderPrice } from "./index";

/**
 * Dhan rejects a MARKET-type order carrying a non-zero price (DH-905:
 * "Missing required fields, bad values for parameters"). resolveDhanOrderPrice
 * forces price=0 for MARKET / SL-M while leaving LIMIT / SL untouched.
 */
describe("resolveDhanOrderPrice", () => {
  it("zeroes the price for a MARKET order", () => {
    expect(resolveDhanOrderPrice("MARKET", 123.45)).toBe(0);
  });

  it("zeroes the price for a STOP_LOSS_MARKET (SL-M) order", () => {
    expect(resolveDhanOrderPrice("SL-M", 200)).toBe(0);
  });

  it("keeps the caller's price for a LIMIT order", () => {
    expect(resolveDhanOrderPrice("LIMIT", 123.45)).toBe(123.45);
  });

  it("keeps the caller's price for an SL (stop-loss-limit) order", () => {
    expect(resolveDhanOrderPrice("SL", 99.5)).toBe(99.5);
  });

  it("leaves a MARKET order with price 0 at 0", () => {
    expect(resolveDhanOrderPrice("MARKET", 0)).toBe(0);
  });
});
