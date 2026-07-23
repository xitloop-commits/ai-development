/**
 * Invariant: BSA's channel→adapter dispatch routes each call to exactly
 * one adapter. The paper book (`paper`) routes to the single shared mock
 * adapter; a paper order MUST NOT reach a live (Dhan) adapter, and vice-versa.
 *
 * Live channels intentionally share an adapter when they share an account;
 * the test asserts the documented mapping rather than universal isolation.
 *
 * T126 — two books. `paper` must never reach a Dhan adapter; `live` always
 * reaches the primary account. The secondary adapter stays registered for the
 * TFA data feed and must never execute an order.
 *
 * Reference: T87 two-book model (paper | live | live).
 *
 * Strategy: real MockAdapter instances injected via _setAdaptersForTesting
 * (avoids Mongo-coupled initBrokerService). Spies on each adapter's
 * placeOrder via vi.spyOn — zero drift from the BrokerAdapter interface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getAdapter,
  _resetForTesting,
  _setAdaptersForTesting,
} from "../../broker/brokerService";
import { MockAdapter } from "../../broker/adapters/mock";
import type { OrderParams } from "../../broker/types";

const sampleOrder: OrderParams = {
  instrument: "NIFTY_50",
  exchange: "NSE_FNO",
  transactionType: "BUY",
  optionType: "CE",
  strike: 23000,
  expiry: "2026-05-29",
  quantity: 50,
  price: 100,
  orderType: "LIMIT",
  productType: "INTRADAY",
};

describe("invariant: channel isolation", () => {
  let dhanLive: MockAdapter;
  let dhanAiData: MockAdapter;
  let mockPaper: MockAdapter;
  let spies: Record<string, ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    _resetForTesting();
    // Three real adapter instances — one per BSA broker slot. Real
    // MockAdapter behaviour, but each instance is independent.
    dhanLive   = new MockAdapter("dhan-primary-ac", "Dhan (live)");
    dhanAiData = new MockAdapter("dhan-secondary-ac", "Dhan (AI Data)");
    mockPaper  = new MockAdapter("mock-paper", "Paper");

    _setAdaptersForTesting({
      dhanLive, dhanAiData, mockPaper,
    });

    spies = {
      dhanLive:   vi.spyOn(dhanLive, "placeOrder"),
      dhanAiData: vi.spyOn(dhanAiData, "placeOrder"),
      mockPaper:  vi.spyOn(mockPaper, "placeOrder"),
    };
  });

  afterEach(() => {
    Object.values(spies).forEach((s) => s.mockRestore());
    _resetForTesting();
  });

  // ── Channel → adapter mapping ─────────────────────────────────

  it("live routes to the primary Dhan account", () => {
    expect(getAdapter("live")).toBe(dhanLive);
  });

  // ── T126: one live book ───────────────────────────────────────

  it("keeps PAPER isolated from every Dhan adapter", () => {
    // The invariant that must hold no matter how the live side is wired: a paper
    // order must never reach a real broker.
    expect(getAdapter("paper")).toBe(mockPaper);
  });

  it("a paper placeOrder touches ONLY the mock adapter", async () => {
    await getAdapter("paper").placeOrder(sampleOrder);
    expect(spies.mockPaper).toHaveBeenCalledTimes(1);
    expect(spies.dhanLive).not.toHaveBeenCalled();
    expect(spies.dhanAiData).not.toHaveBeenCalled();
  });

  it("a live placeOrder touches ONLY the primary account", async () => {
    // dhanAiData stays connected for the TFA data feed and must never execute.
    await getAdapter("live").placeOrder(sampleOrder);
    expect(spies.dhanLive).toHaveBeenCalledTimes(1);
    expect(spies.dhanAiData).not.toHaveBeenCalled();
    expect(spies.mockPaper).not.toHaveBeenCalled();
  });
});
