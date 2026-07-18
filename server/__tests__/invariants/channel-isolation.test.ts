/**
 * Invariant: BSA's channel→adapter dispatch routes each call to exactly
 * one adapter. The paper book (`paper`) routes to the single shared mock
 * adapter; a paper order MUST NOT reach a live (Dhan) adapter, and vice-versa.
 *
 * Live channels intentionally share an adapter when they share an account;
 * the test asserts the documented mapping rather than universal isolation.
 *
 * Reference: T87 two-book model (paper | ai-live | my-live).
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

  it("ai-live routes to dhan-secondary-ac (spouse account)", () => {
    expect(getAdapter("ai-live")).toBe(dhanAiData);
  });

  it("my-live routes to dhan-primary-ac", () => {
    expect(getAdapter("my-live")).toBe(dhanLive);
  });

  it("paper routes to the shared mock-paper adapter", () => {
    expect(getAdapter("paper")).toBe(mockPaper);
  });

  // ── placeOrder isolation: paper vs live ───────────────────────

  it("a paper placeOrder touches mock-paper only — no live adapter is touched", async () => {
    await getAdapter("paper").placeOrder(sampleOrder);

    expect(spies.mockPaper).toHaveBeenCalledTimes(1);
    expect(spies.dhanLive).not.toHaveBeenCalled();
    expect(spies.dhanAiData).not.toHaveBeenCalled();
  });

  // ── placeOrder isolation: live channels ───────────────────────

  it("an ai-live placeOrder touches dhan-secondary-ac only — primary dhan-primary-ac stays untouched", async () => {
    await getAdapter("ai-live").placeOrder(sampleOrder);

    expect(spies.dhanAiData).toHaveBeenCalledTimes(1);
    expect(spies.dhanLive).not.toHaveBeenCalled();
    expect(spies.mockPaper).not.toHaveBeenCalled();
  });

  it("a my-live placeOrder touches dhan-primary-ac only — the AI-data account stays untouched", async () => {
    await getAdapter("my-live").placeOrder(sampleOrder);

    expect(spies.dhanLive).toHaveBeenCalledTimes(1);
    expect(spies.dhanAiData).not.toHaveBeenCalled();
    expect(spies.mockPaper).not.toHaveBeenCalled();
  });

  // ── ai-live fallback when dhan-secondary-ac is missing ─────────────

  it("ai-live falls back to dhan-primary-ac when dhan-secondary-ac is not configured", () => {
    _resetForTesting();
    _setAdaptersForTesting({
      dhanLive, mockPaper,
      // dhanAiData intentionally omitted
    });
    expect(getAdapter("ai-live")).toBe(dhanLive);
  });
});
