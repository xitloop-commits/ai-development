import { describe, expect, it } from "vitest";
import { DhanAdapter } from "./index";
import type { OrderParams } from "../../types";

/**
 * Unit tests for DhanAdapter._resolveSecurityId (private — accessed via cast).
 *
 * Regression guard for the 2026-05-31 sandbox bug: an order for the index spot
 * "NIFTY 50" fell through the scrip-master lookup and the raw text was passed to
 * Dhan as the securityId, producing a vague "Missing required fields" rejection.
 * The resolver must now FAIL FAST with a clear message instead of forwarding junk.
 *
 * These cases don't load the scrip master, so every name lookup misses — which is
 * exactly the unresolved-instrument path under test.
 */
function makeParams(overrides: Partial<OrderParams>): OrderParams {
  return {
    instrument: "NIFTY 50",
    exchange: "NSE_FNO" as OrderParams["exchange"],
    transactionType: "BUY" as OrderParams["transactionType"],
    optionType: "" as OrderParams["optionType"],
    strike: 0,
    expiry: "",
    quantity: 50,
    price: 0,
    orderType: "MARKET" as OrderParams["orderType"],
    productType: "INTRADAY" as OrderParams["productType"],
    ...overrides,
  };
}

describe("DhanAdapter._resolveSecurityId", () => {
  const adapter = new DhanAdapter("dhan-sandbox", true);
  const resolve = (p: OrderParams) => (adapter as any)._resolveSecurityId(p);

  it("passes through a numeric securityId untouched", () => {
    expect(resolve(makeParams({ instrument: "13" }))).toBe("13");
  });

  it("throws a clear error for an unresolvable index spot name", () => {
    expect(() => resolve(makeParams({ instrument: "NIFTY 50" }))).toThrowError(
      /Cannot resolve securityId for "NIFTY 50"/
    );
  });

  it("does NOT forward the raw instrument text to the broker", () => {
    // Before the fix this returned "NIFTY 50"; now it must throw instead.
    expect(() => resolve(makeParams({ instrument: "NIFTY 50" }))).toThrow();
  });

  it("includes available context (expiry/strike/optionType) in the error", () => {
    expect(() =>
      resolve(
        makeParams({
          instrument: "BANKNIFTY",
          expiry: "2026-06-25",
          strike: 50000,
          optionType: "CE" as OrderParams["optionType"],
        })
      )
    ).toThrowError(/expiry=2026-06-25 strike=50000 optionType=CE/);
  });
});