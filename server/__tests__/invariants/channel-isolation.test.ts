/**
 * Invariant: BSA's channel→adapter dispatch routes each call to exactly
 * one adapter, and paper channels are fully isolated (a my-paper trade
 * MUST NOT reach the ai-paper adapter, and vice-versa).
 *
 * Live channels intentionally share an adapter when they share an account
 * (my-live and testing-live both use `dhan`); the test asserts the
 * documented mapping rather than universal isolation.
 *
 * Reference: BrokerServiceAgent_Spec_v1.9 §1.2 (channel→brokerId table).
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
  let dhanSandbox: MockAdapter;
  let mockAi: MockAdapter;
  let mockMy: MockAdapter;
  let spies: Record<string, ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    _resetForTesting();
    // Five real adapter instances — one per BSA broker slot. Real
    // MockAdapter behaviour, but each instance is independent.
    dhanLive   = new MockAdapter("dhan", "Dhan (live)");
    dhanAiData = new MockAdapter("dhan-ai-data", "Dhan (AI Data)");
    dhanSandbox = new MockAdapter("dhan-sandbox", "Dhan (sandbox)");
    mockAi     = new MockAdapter("mock-ai", "Paper (AI Trades)");
    mockMy     = new MockAdapter("mock-my", "Paper (My Trades)");

    _setAdaptersForTesting({
      dhanLive, dhanAiData, dhanSandbox, mockAi, mockMy,
    });

    spies = {
      dhanLive:   vi.spyOn(dhanLive, "placeOrder"),
      dhanAiData: vi.spyOn(dhanAiData, "placeOrder"),
      dhanSandbox: vi.spyOn(dhanSandbox, "placeOrder"),
      mockAi:     vi.spyOn(mockAi, "placeOrder"),
      mockMy:     vi.spyOn(mockMy, "placeOrder"),
    };
  });

  afterEach(() => {
    Object.values(spies).forEach((s) => s.mockRestore());
    _resetForTesting();
  });

  // ── Channel → adapter mapping ─────────────────────────────────

  it("ai-live routes to dhan-ai-data (spouse account)", () => {
    expect(getAdapter("ai-live")).toBe(dhanAiData);
  });

  it("my-live routes to dhan (primary account)", () => {
    expect(getAdapter("my-live")).toBe(dhanLive);
  });

  it("testing-live routes to dhan and shares the adapter with my-live (by design)", () => {
    expect(getAdapter("testing-live")).toBe(dhanLive);
    expect(getAdapter("testing-live")).toBe(getAdapter("my-live"));
  });

  it("testing-sandbox routes to dhan-sandbox", () => {
    expect(getAdapter("testing-sandbox")).toBe(dhanSandbox);
  });

  it("ai-paper routes to mock-ai", () => {
    expect(getAdapter("ai-paper")).toBe(mockAi);
  });

  it("my-paper routes to mock-my", () => {
    expect(getAdapter("my-paper")).toBe(mockMy);
  });

  // ── placeOrder isolation: paper channels ──────────────────────

  it("a my-paper placeOrder touches mock-my only — every other adapter stays untouched", async () => {
    await getAdapter("my-paper").placeOrder(sampleOrder);

    expect(spies.mockMy).toHaveBeenCalledTimes(1);
    expect(spies.mockAi).not.toHaveBeenCalled();
    expect(spies.dhanLive).not.toHaveBeenCalled();
    expect(spies.dhanAiData).not.toHaveBeenCalled();
    expect(spies.dhanSandbox).not.toHaveBeenCalled();
  });

  it("an ai-paper placeOrder touches mock-ai only — every other adapter stays untouched", async () => {
    await getAdapter("ai-paper").placeOrder(sampleOrder);

    expect(spies.mockAi).toHaveBeenCalledTimes(1);
    expect(spies.mockMy).not.toHaveBeenCalled();
    expect(spies.dhanLive).not.toHaveBeenCalled();
    expect(spies.dhanAiData).not.toHaveBeenCalled();
    expect(spies.dhanSandbox).not.toHaveBeenCalled();
  });

  // ── placeOrder isolation: live channels ───────────────────────

  it("an ai-live placeOrder touches dhan-ai-data only — primary dhan stays untouched", async () => {
    await getAdapter("ai-live").placeOrder(sampleOrder);

    expect(spies.dhanAiData).toHaveBeenCalledTimes(1);
    expect(spies.dhanLive).not.toHaveBeenCalled();
    expect(spies.mockAi).not.toHaveBeenCalled();
    expect(spies.mockMy).not.toHaveBeenCalled();
    expect(spies.dhanSandbox).not.toHaveBeenCalled();
  });

  it("an testing-sandbox placeOrder touches dhan-sandbox only", async () => {
    await getAdapter("testing-sandbox").placeOrder(sampleOrder);

    expect(spies.dhanSandbox).toHaveBeenCalledTimes(1);
    expect(spies.dhanLive).not.toHaveBeenCalled();
    expect(spies.dhanAiData).not.toHaveBeenCalled();
    expect(spies.mockAi).not.toHaveBeenCalled();
    expect(spies.mockMy).not.toHaveBeenCalled();
  });

  // ── ai-live fallback when dhan-ai-data is missing ─────────────

  it("ai-live falls back to dhan when dhan-ai-data is not configured", () => {
    _resetForTesting();
    _setAdaptersForTesting({
      dhanLive, mockAi, mockMy,
      // dhanAiData intentionally omitted
    });
    expect(getAdapter("ai-live")).toBe(dhanLive);
  });
});
