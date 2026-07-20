/**
 * Instrument-name normalisation in the trade resolvers.
 *
 * Callers spell the same instrument three ways: "NIFTY 50" (UI label),
 * "NIFTY50" (SEA signals) and "NIFTY_50" (the client feed key). The resolvers
 * stripped whitespace only, so the underscore form matched nothing and returned
 * null — which is NOT a loud failure: placeTrade falls back to `lotSize ?? 1`,
 * so the order reached the broker with qty in LOTS instead of units and was
 * rejected with "quantity 10 is not a whole multiple of the lot size 65".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getLotSizeMock = vi.fn();
const getExpiryListMock = vi.fn();

vi.mock("../broker/brokerService", () => ({
  getActiveBroker: () => ({ getLotSize: getLotSizeMock, getExpiryList: getExpiryListMock }),
}));
vi.mock("../broker/brokerConfig", () => ({
  getActiveBrokerConfig: async () => ({ isPaperBroker: true }),
}));
vi.mock("../broker/logger", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), important: vi.fn(), error: vi.fn() }),
}));

import { resolveLotSize, resolveUnderlyingForExpiry, resolveNearestExpiry } from "./tradeResolution";

beforeEach(() => {
  vi.clearAllMocks();
  getLotSizeMock.mockResolvedValue(65);
  getExpiryListMock.mockResolvedValue(["2026-07-24", "2026-07-31"]);
});

describe("instrument spelling is normalised across all three forms", () => {
  const forms = ["NIFTY_50", "NIFTY 50", "NIFTY50", "nifty50", "nifty_50"];

  it.each(forms)("resolveLotSize(%s) resolves to the NIFTY lot size", async (form) => {
    const ls = await resolveLotSize(form);
    expect(ls).toBe(65);
    expect(getLotSizeMock).toHaveBeenCalledWith("NIFTY");
  });

  it.each(forms)("resolveUnderlyingForExpiry(%s) maps to NIFTY", async (form) => {
    const r = await resolveUnderlyingForExpiry(form);
    expect(r).toEqual({ underlying: "NIFTY", exchangeSegment: "IDX_I" });
  });

  it.each(["BANKNIFTY", "BANK NIFTY", "BANK_NIFTY"])("handles %s", async (form) => {
    const r = await resolveUnderlyingForExpiry(form);
    expect(r?.underlying).toBe("BANKNIFTY");
  });

  it("resolveNearestExpiry picks the earliest expiry for the underscore form", async () => {
    await expect(resolveNearestExpiry("NIFTY_50")).resolves.toBe("2026-07-24");
  });

  it("still returns null for a genuinely unknown instrument", async () => {
    await expect(resolveUnderlyingForExpiry("RELIANCE")).resolves.toBeNull();
  });
});
