/**
 * capitalLedger — reconciliation between the book and the broker.
 *
 * Model B, chosen deliberately: the app keeps its OWN ledger and CHECKS it
 * against the broker. It never mirrors. Mirroring would have silently
 * overwritten the ₹9,00,000 that landed on the wrong book on 2026-07-21 and
 * hidden the bug that put it there.
 *
 * The property that matters most is the negative one: a broker read that FAILS
 * must never read as "matched". A false green here is worse than no check at
 * all, because it converts an unknown into a reassurance.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getMargin = vi.fn();
/** T118 — which account backs ai-live; flipped per-test. */
let aiLiveBrokerId = "dhan-secondary-ac";
vi.mock("../broker/brokerService", () => ({
  _getAdapterByBrokerId: vi.fn((id: string) =>
    id === "dhan-primary-ac" || id === "dhan-secondary-ac" ? { getMargin } : null,
  ),
  brokerIdForChannel: (channel: string) =>
    channel === "my-live" ? "dhan-primary-ac"
    : channel === "ai-live" ? aiLiveBrokerId
    : null,
  liveBooksShareAccount: () => aiLiveBrokerId === "dhan-primary-ac",
}));
vi.mock("./storage", () => ({ appendEvent: vi.fn(), getEvents: vi.fn(async () => []) }));

/** The OTHER book's pools, read by reconcile only when the account is shared. */
const otherBook = { tradingPool: 0, reservePool: 0 };
vi.mock("./state", () => ({ getCapitalState: vi.fn(async () => ({ ...otherBook })) }));

import { reconcile } from "./capitalLedger";

beforeEach(() => {
  vi.clearAllMocks();
  aiLiveBrokerId = "dhan-secondary-ac";
  otherBook.tradingPool = 0;
  otherBook.reservePool = 0;
});

describe("paper", () => {
  it("is not reconciled — there is no broker behind it", async () => {
    const r = await reconcile("paper", 1_000_000, 0);
    expect(r.status).toBe("NOT_APPLICABLE");
    expect(r.brokerBalance).toBeNull();
    expect(r.bookBalance).toBe(1_000_000);
  });
});

describe("live books", () => {
  it("MATCHES when the book equals the broker", async () => {
    getMargin.mockResolvedValue({ available: 100_000.32, used: 0, total: 100_000.32 });
    const r = await reconcile("my-live", 100_000.32, 0);
    expect(r.status).toBe("MATCHED");
    expect(r.difference).toBe(0);
  });

  it("counts BOTH pools as the book balance", async () => {
    // Reserve is still the operator's money; excluding it would report drift
    // every time a completed day moved profit across.
    getMargin.mockResolvedValue({ available: 100_000, used: 0, total: 100_000 });
    const r = await reconcile("my-live", 75_000, 25_000);
    expect(r.bookBalance).toBe(100_000);
    expect(r.status).toBe("MATCHED");
  });

  it("reports DRIFT and its size — the 2026-07-21 case", async () => {
    // Book held the seed plus a misdirected 9L; Dhan held only the seed.
    getMargin.mockResolvedValue({ available: 100_000.32, used: 0, total: 100_000.32 });
    const r = await reconcile("my-live", 1_000_000.32, 0);
    expect(r.status).toBe("DRIFT");
    expect(r.difference).toBe(900_000);
    expect(r.message).toMatch(/AHEAD OF/);
  });

  it("reports drift the other way too", async () => {
    getMargin.mockResolvedValue({ available: 100_000, used: 0, total: 100_000 });
    const r = await reconcile("my-live", 40_000, 0);
    expect(r.status).toBe("DRIFT");
    expect(r.difference).toBe(-60_000);
    expect(r.message).toMatch(/BEHIND/);
  });

  it("tolerates paise, not rupees", async () => {
    getMargin.mockResolvedValue({ available: 100_000, used: 0, total: 100_000 });
    expect((await reconcile("my-live", 100_000.75, 0)).status).toBe("MATCHED");
    expect((await reconcile("my-live", 100_002, 0)).status).toBe("DRIFT");
  });

  it("reads CASH, not the start-of-day limit", async () => {
    // sodLimit can include collateral and broker margin — money you do not own.
    // Reconciling against it would call a real shortfall a match.
    getMargin.mockResolvedValue({ available: 100_000, used: 0, total: 1_000_000 });
    const r = await reconcile("my-live", 100_000, 0);
    expect(r.brokerBalance).toBe(100_000);
    expect(r.status).toBe("MATCHED");
  });
});

describe("a failed broker read is never a match", () => {
  it("is UNAVAILABLE when getMargin throws", async () => {
    getMargin.mockRejectedValue(new Error("Token expired"));
    const r = await reconcile("my-live", 100_000, 0);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.brokerBalance).toBeNull();
    expect(r.message).toMatch(/NOT a match/);
  });

  it("is UNAVAILABLE when the balance is not a number", async () => {
    getMargin.mockResolvedValue({ available: undefined, used: 0, total: 0 });
    expect((await reconcile("my-live", 100_000, 0)).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when the balance is NaN", async () => {
    getMargin.mockResolvedValue({ available: NaN, used: 0, total: 0 });
    expect((await reconcile("my-live", 100_000, 0)).status).toBe("UNAVAILABLE");
  });
});

describe("T118 — both live books funded by ONE Dhan account", () => {
  it("compares the SUM of both books against the single account", async () => {
    // One account holds the money for both books, so neither book alone can
    // ever equal its balance. Comparing them separately would report permanent
    // drift and train the operator to ignore the check.
    aiLiveBrokerId = "dhan-primary-ac";
    otherBook.tradingPool = 40_000; // ai-live
    getMargin.mockResolvedValue({ available: 100_000, used: 0, total: 100_000 });

    const r = await reconcile("my-live", 60_000, 0);

    expect(r.status).toBe("MATCHED");
    expect(r.difference).toBe(0);
    expect(r.bookBalance).toBe(60_000); // this book's own figure is still reported
    expect(r.message).toContain("Both live books together");
    expect(r.message).toContain("share dhan-primary-ac");
  });

  it("reports DRIFT on the sum, not on one book's shortfall", async () => {
    aiLiveBrokerId = "dhan-primary-ac";
    otherBook.tradingPool = 40_000;
    getMargin.mockResolvedValue({ available: 130_000, used: 0, total: 130_000 });

    const r = await reconcile("my-live", 60_000, 0);

    expect(r.status).toBe("DRIFT");
    expect(r.difference).toBe(-30_000); // 100k of book vs 130k at the broker
    expect(r.message).toContain("BEHIND");
  });

  it("reconciles ai-live against the same shared account", async () => {
    aiLiveBrokerId = "dhan-primary-ac";
    otherBook.tradingPool = 60_000; // my-live
    getMargin.mockResolvedValue({ available: 100_000, used: 0, total: 100_000 });

    const r = await reconcile("ai-live", 40_000, 0);

    expect(r.status).toBe("MATCHED");
    expect(r.brokerBalance).toBe(100_000);
  });

  it("compares each book on its OWN when the accounts are separate", async () => {
    // Default setup must be untouched: two accounts, two independent checks.
    otherBook.tradingPool = 999_999; // must be ignored entirely
    getMargin.mockResolvedValue({ available: 60_000, used: 0, total: 60_000 });

    const r = await reconcile("my-live", 60_000, 0);

    expect(r.status).toBe("MATCHED");
    expect(r.message).toContain("This book");
    expect(r.message).not.toContain("together");
  });
});
