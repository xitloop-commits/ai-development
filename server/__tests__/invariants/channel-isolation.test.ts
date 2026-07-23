/**
 * Invariant: BSA's channel→adapter dispatch routes each call to exactly
 * one adapter. The paper book (`paper`) routes to the single shared mock
 * adapter; a paper order MUST NOT reach a live (Dhan) adapter, and vice-versa.
 *
 * Live channels intentionally share an adapter when they share an account;
 * the test asserts the documented mapping rather than universal isolation.
 *
 * ai-live's account is CONFIGURABLE (T118, `AI_LIVE_BROKER_ID`). These tests
 * pin BOTH settings explicitly instead of inheriting whatever `.env` happens to
 * say — the ambient value is a deployment choice, and a suite that reads it
 * turns a config edit into a red test with no code change behind it.
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

  const ORIGINAL_AI_BROKER = process.env.AI_LIVE_BROKER_ID;

  beforeEach(() => {
    // Default deployment: two accounts. Set, never inherited — .env on this
    // machine currently points ai-live at the PRIMARY account.
    delete process.env.AI_LIVE_BROKER_ID;
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
    if (ORIGINAL_AI_BROKER === undefined) delete process.env.AI_LIVE_BROKER_ID;
    else process.env.AI_LIVE_BROKER_ID = ORIGINAL_AI_BROKER;
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

  // ── AI_LIVE_BROKER_ID: ai-live moved onto the primary account (T118) ──

  it("routes ai-live to the PRIMARY account when AI_LIVE_BROKER_ID says so", () => {
    // One whitelisted IP means only one Dhan account can place orders.
    process.env.AI_LIVE_BROKER_ID = "dhan-primary-ac";
    expect(getAdapter("ai-live")).toBe(dhanLive);
    expect(getAdapter("my-live")).toBe(dhanLive);
  });

  it("keeps PAPER isolated even when both live books share one account", async () => {
    // The thing that must never break, whatever the live wiring is.
    process.env.AI_LIVE_BROKER_ID = "dhan-primary-ac";
    await getAdapter("paper").placeOrder(sampleOrder);
    expect(spies.mockPaper).toHaveBeenCalledTimes(1);
    expect(spies.dhanLive).not.toHaveBeenCalled();
    expect(spies.dhanAiData).not.toHaveBeenCalled();
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
