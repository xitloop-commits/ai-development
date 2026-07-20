/**
 * T92 — one-time Dhan seeding of live capital.
 *
 * Live books read their opening capital from their OWN Dhan account exactly
 * once (`getMargin().total` = sodLimit), then the engine owns the pool forever.
 * Nothing auto-funds to a default amount any more — the old behaviour created
 * every channel at ₹100,000, so ai-live traded against money nobody deposited.
 *
 * The failure path matters as much as the happy one: a failed seed must persist
 * NOTHING, so the next read retries instead of baking an unfunded book into the
 * database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mongo stand-in ──────────────────────────────────────────────
const docs: Record<string, any> = {};

const findOneMock = vi.fn((q: { channel: string }) => ({
  lean: async () => docs[q.channel] ?? null,
}));
const createMock = vi.fn(async (d: any) => {
  docs[d.channel] = { ...d };
  return docs[d.channel];
});

vi.mock("./storage", async () => {
  const actual = await vi.importActual<typeof import("./storage")>("./storage");
  return {
    ...actual,
    PortfolioStateModel: {
      findOne: (...a: any[]) => findOneMock(...(a as [any])),
      create: (...a: any[]) => createMock(...(a as [any])),
    },
    PositionStateModel: { findOne: () => ({ lean: async () => null }) },
  };
});

// ─── Broker stand-in ─────────────────────────────────────────────
const getMarginMock = vi.fn();
let registered: Record<string, unknown> = {};
/** Every brokerId the seeder asked for, in order. */
const requestedBrokerIds: string[] = [];

vi.mock("../broker/brokerService", () => ({
  _getAdapterByBrokerId: (brokerId: string) => {
    requestedBrokerIds.push(brokerId);
    return registered[brokerId] ? { getMargin: getMarginMock } : null;
  },
}));

vi.mock("../broker/tickBus", () => ({
  tickBus: { emitCapitalChanged: vi.fn(), emitPortfolio: vi.fn() },
}));

import { getCapitalState } from "./state";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(docs)) delete docs[k];
  registered = { "dhan-primary-ac": {}, "dhan-secondary-ac": {} };
  requestedBrokerIds.length = 0;
  getMarginMock.mockReset();
});

describe("T92 — live capital seeds once from Dhan", () => {
  it("seeds my-live from sodLimit (getMargin().total), not available balance", async () => {
    getMarginMock.mockResolvedValue({ available: 120_000, used: 80_000, total: 500_000 });

    const st = await getCapitalState("my-live");

    expect(st.tradingPool).toBe(500_000); // sodLimit — NOT available (120k)
    expect(st.initialFunding).toBe(500_000);
    expect(st.reservePool).toBe(0); // seed capital is 100% Trading
    expect(st.seededAt).toBeTypeOf("number");
    expect(createMock).toHaveBeenCalledOnce();
  });

  it("routes ai-live to the SPOUSE account and my-live to the PRIMARY", async () => {
    getMarginMock.mockResolvedValue({ available: 0, used: 0, total: 111 });

    await getCapitalState("ai-live");
    expect(requestedBrokerIds).toEqual(["dhan-secondary-ac"]);

    requestedBrokerIds.length = 0;
    await getCapitalState("my-live");
    expect(requestedBrokerIds).toEqual(["dhan-primary-ac"]);
  });

  it("does NOT fall back to the primary account when the spouse adapter is missing", async () => {
    // getAdapter("ai-live") would fall back to dhanLive here — seeding ai-live
    // from my-live's balance. The strict lookup must refuse instead.
    registered = { "dhan-primary-ac": {} };
    getMarginMock.mockResolvedValue({ available: 0, used: 0, total: 999_999 });

    const st = await getCapitalState("ai-live");

    expect(st.tradingPool).toBe(0);
    expect(st.seededAt).toBeNull();
    expect(getMarginMock).not.toHaveBeenCalled(); // never touched the primary
  });

  it("does NOT re-seed a book that already exists — Dhan is read once, ever", async () => {
    getMarginMock.mockResolvedValue({ available: 0, used: 0, total: 500_000 });
    await getCapitalState("my-live");
    getMarginMock.mockClear();

    // A later read — even after the pool has been drawn right down.
    docs["my-live"].tradingPool = 0;
    const again = await getCapitalState("my-live");

    expect(getMarginMock).not.toHaveBeenCalled();
    expect(again.tradingPool).toBe(0); // stays drained; NOT refilled from Dhan
  });

  it("persists NOTHING when the seed fails, so the next read retries", async () => {
    getMarginMock.mockRejectedValue(new Error("Token expired. Restart BSA to refresh."));

    const st = await getCapitalState("ai-live");

    expect(st.tradingPool).toBe(0);
    expect(st.seededAt).toBeNull(); // ← the "not tradeable" marker
    expect(createMock).not.toHaveBeenCalled();
    expect(docs["ai-live"]).toBeUndefined();

    // Token recovers → the retry succeeds and persists.
    getMarginMock.mockReset();
    getMarginMock.mockResolvedValue({ available: 0, used: 0, total: 300_000 });
    const retry = await getCapitalState("ai-live");
    expect(retry.tradingPool).toBe(300_000);
    expect(retry.seededAt).toBeTypeOf("number");
    expect(docs["ai-live"]).toBeDefined();
  });

  it("treats a missing adapter as a failed seed (no phantom balance)", async () => {
    registered = {}; // neither account configured yet

    const st = await getCapitalState("my-live");

    expect(st.tradingPool).toBe(0);
    expect(st.seededAt).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a nonsensical balance rather than seeding zero/negative", async () => {
    getMarginMock.mockResolvedValue({ available: 0, used: 0, total: 0 });

    const st = await getCapitalState("my-live");

    expect(st.seededAt).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("paper is created at zero and stamped seeded — it never calls Dhan", async () => {
    const st = await getCapitalState("paper");

    expect(st.tradingPool).toBe(0);
    expect(st.seededAt).toBeTypeOf("number"); // nothing to seed from; operator funds it
    expect(getMarginMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledOnce();
  });

  it("never auto-funds ₹100,000 — the old phantom-balance behaviour is gone", async () => {
    getMarginMock.mockRejectedValue(new Error("down"));

    for (const ch of ["paper", "ai-live", "my-live"] as const) {
      const st = await getCapitalState(ch);
      expect(st.tradingPool).not.toBe(100_000);
      expect(st.initialFunding).not.toBe(100_000);
    }
  });
});
