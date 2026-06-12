/**
 * F1 — `tickHandler` per-channel state cache.
 *
 * Without the cache, every 500ms-batched call to `processPendingUpdates`
 * fires `getCapitalState` + `getDayRecord` + `getActiveBrokerConfig` on
 * each of 6 channels — even when no incoming tick matches an open trade.
 * With the cache, a quiet channel (no match in this batch) makes 0 Mongo
 * calls until either the TTL expires or a tick actually matches.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getCapitalStateMock = vi.fn();
const getDayRecordMock = vi.fn();
const upsertDayRecordMock = vi.fn();
const getActiveBrokerConfigMock = vi.fn();

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    getCapitalState: (...args: any[]) => getCapitalStateMock(...args),
    getDayRecord: (...args: any[]) => getDayRecordMock(...args),
    upsertDayRecord: (...args: any[]) => upsertDayRecordMock(...args),
  };
});

vi.mock("../broker/brokerConfig", () => ({
  getActiveBrokerConfig: () => getActiveBrokerConfigMock(),
}));

vi.mock("../broker/tickBus", () => ({
  tickBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock("../broker/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    important: vi.fn(),
  }),
}));

vi.mock("./compounding", () => ({
  recalculateDayAggregates: (day: any) => day,
}));

import { tickHandler } from "./tickHandler";
import type { TickData } from "../broker/types";

function makeTick(overrides: Partial<TickData> = {}): TickData {
  return {
    exchange: "NSE",
    securityId: "FAKE_ID",
    ltp: 100,
    timestamp: Date.now(),
    ...overrides,
  } as TickData;
}

describe("tickHandler — F1 per-channel state cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tickHandler.clearStateCache();

    getCapitalStateMock.mockResolvedValue({
      channel: "my-paper",
      tradingPool: 100_000,
      reservePool: 0,
      initialFunding: 100_000,
      currentDayIndex: 1,
      targetPercent: 1,
      profitHistory: [],
      cumulativePnl: 0,
      cumulativeCharges: 0,
      sessionTradeCount: 0,
    });
    // Day record with NO open trades — ensures no tick→trade match.
    getDayRecordMock.mockResolvedValue({
      dayIndex: 1,
      date: "2024-11-14",
      trades: [],
      totalPnl: 0,
    });
    getActiveBrokerConfigMock.mockResolvedValue(null);
  });

  it("100 ticks with no trade match → 0 Mongo calls after cache is warm", async () => {
    const handler = tickHandler as any;

    // Batch 1 — warms the cache for all 6 TICK_CHANNELS.
    handler.pendingUpdates.set("NSE:WARM", makeTick({ securityId: "WARM" }));
    await handler.processPendingUpdates();

    const callsAfterWarm =
      getCapitalStateMock.mock.calls.length +
      getDayRecordMock.mock.calls.length +
      getActiveBrokerConfigMock.mock.calls.length;
    expect(callsAfterWarm).toBeGreaterThan(0);

    // Reset all counters — cache is now warm for every channel.
    vi.clearAllMocks();

    // Batch 2 — 100 ticks, none of which match any open trade (there are
    // no open trades). The cache must absorb all 6 channels' reads.
    for (let i = 0; i < 100; i++) {
      handler.pendingUpdates.set(`NSE:UNMATCHED_${i}`, makeTick({ securityId: `UNMATCHED_${i}` }));
    }
    await handler.processPendingUpdates();

    expect(getCapitalStateMock).not.toHaveBeenCalled();
    expect(getDayRecordMock).not.toHaveBeenCalled();
    expect(getActiveBrokerConfigMock).not.toHaveBeenCalled();
    expect(upsertDayRecordMock).not.toHaveBeenCalled();
  });

  it("clearStateCache forces the next batch to re-read", async () => {
    const handler = tickHandler as any;

    // Warm
    handler.pendingUpdates.set("NSE:WARM", makeTick({ securityId: "WARM" }));
    await handler.processPendingUpdates();

    vi.clearAllMocks();
    tickHandler.clearStateCache();

    handler.pendingUpdates.set("NSE:WARM", makeTick({ securityId: "WARM" }));
    await handler.processPendingUpdates();

    // Cache cleared → first batch hits Mongo again. We expect at least
    // one read per channel (6 channels × { state, day, brokerConfig }).
    expect(getCapitalStateMock.mock.calls.length).toBeGreaterThan(0);
    expect(getDayRecordMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("invalidates the cache after a tick matches an open trade", async () => {
    const handler = tickHandler as any;

    const openTrade = {
      id: "T1",
      instrument: "NIFTY_50",
      type: "BUY",
      strike: null,
      expiry: null,
      contractSecurityId: null,
      entryPrice: 100,
      exitPrice: null,
      ltp: 100,
      qty: 1,
      status: "OPEN",
      targetPrice: null,
      stopLossPrice: null,
      trailingStopEnabled: false,
      lastTickAt: null,
      unrealizedPnl: 0,
    };

    // Switch to a day record that DOES have an open trade matching our tick.
    getDayRecordMock.mockResolvedValue({
      dayIndex: 1,
      date: "2024-11-14",
      trades: [openTrade],
      totalPnl: 0,
    });

    // Warm cache.
    handler.pendingUpdates.set("NSE:NIFTY_50", makeTick({ securityId: "NIFTY_50" }));
    await handler.processPendingUpdates();

    // upsertDayRecord must have been called for at least one channel
    // (the match channels, e.g. my-paper) — proving anyUpdated path ran.
    expect(upsertDayRecordMock).toHaveBeenCalled();

    vi.clearAllMocks();

    // Next batch: cache for matched channels was invalidated, so those
    // channels re-read from Mongo. That is the desired behaviour — fresh
    // state after a tick→trade match.
    handler.pendingUpdates.set("NSE:NIFTY_50", makeTick({ securityId: "NIFTY_50" }));
    await handler.processPendingUpdates();

    expect(getCapitalStateMock.mock.calls.length).toBeGreaterThan(0);
  });
});

/**
 * Regression — clearing a workspace must not let a stale cached day
 * resurrect the just-deleted trades.
 *
 * Bug: CLEAR deletes the day record in Mongo, but the tick handler still
 * holds the old day (with its open trades) in `stateCache`. The next
 * matching tick reads that stale day and re-persists it via
 * upsertDayRecord — bringing every cleared trade back. The fix is for the
 * clear path to call `tickHandler.clearStateCache()` after the delete.
 */
describe("tickHandler — clear-workspace cache invalidation", () => {
  const openTrade = {
    id: "T1",
    instrument: "NIFTY_50",
    type: "BUY",
    strike: null,
    expiry: null,
    contractSecurityId: null,
    entryPrice: 100,
    exitPrice: null,
    ltp: 100,
    qty: 1,
    status: "OPEN",
    targetPrice: null,
    stopLossPrice: null,
    trailingStopEnabled: false,
    lastTickAt: null,
    unrealizedPnl: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tickHandler.clearStateCache();
    // The persist throttle + peak/exit tracking live in private maps that
    // are NOT cleared by clearStateCache and leak across tests. Reset them
    // so the throttle never suppresses a write mid-test (otherwise these
    // tests are timing-dependent on prior tests' lastPersistAt stamps).
    const h = tickHandler as any;
    h.lastPersistAt.clear();
    h.peakPrices.clear();
    h.exitingTrades.clear();
    getCapitalStateMock.mockResolvedValue({
      channel: "my-paper",
      tradingPool: 100_000,
      reservePool: 0,
      initialFunding: 100_000,
      currentDayIndex: 1,
      targetPercent: 1,
      profitHistory: [],
      cumulativePnl: 0,
      cumulativeCharges: 0,
      sessionTradeCount: 0,
    });
    getActiveBrokerConfigMock.mockResolvedValue(null);
  });

  it("WITHOUT clearStateCache: a stale cached day re-persists the cleared trade (the bug)", async () => {
    const handler = tickHandler as any;

    // Warm the cache while the day still holds an open trade. Use a
    // non-matching tick so no persist/invalidation happens during warm —
    // the cache is left holding the open-trade day.
    getDayRecordMock.mockResolvedValue({ dayIndex: 1, date: "2024-11-14", trades: [openTrade], totalPnl: 0 });
    handler.pendingUpdates.set("NSE:WARM", makeTick({ securityId: "WARM" }));
    await handler.processPendingUpdates();
    expect(upsertDayRecordMock).not.toHaveBeenCalled();

    // Simulate the clear: Mongo now returns an empty day, but the cache is
    // NOT invalidated. A matching tick arrives.
    getDayRecordMock.mockResolvedValue({ dayIndex: 1, date: "2024-11-14", trades: [], totalPnl: 0 });
    vi.clearAllMocks();
    handler.pendingUpdates.set("NSE:NIFTY_50", makeTick({ securityId: "NIFTY_50" }));
    await handler.processPendingUpdates();

    // Stale cache wins → the open-trade day is written back to Mongo.
    expect(upsertDayRecordMock).toHaveBeenCalled();
  });

  it("WITH clearStateCache: the cleared trade stays gone (the fix)", async () => {
    const handler = tickHandler as any;

    // Warm the cache with the open-trade day (same as above).
    getDayRecordMock.mockResolvedValue({ dayIndex: 1, date: "2024-11-14", trades: [openTrade], totalPnl: 0 });
    handler.pendingUpdates.set("NSE:WARM", makeTick({ securityId: "WARM" }));
    await handler.processPendingUpdates();

    // Simulate clearWorkspace: delete the day, THEN invalidate the cache.
    getDayRecordMock.mockResolvedValue({ dayIndex: 1, date: "2024-11-14", trades: [], totalPnl: 0 });
    tickHandler.clearStateCache();
    vi.clearAllMocks();

    // Matching tick arrives — the handler must re-read the fresh empty day
    // and write nothing back.
    handler.pendingUpdates.set("NSE:NIFTY_50", makeTick({ securityId: "NIFTY_50" }));
    await handler.processPendingUpdates();

    expect(upsertDayRecordMock).not.toHaveBeenCalled();
  });
});

/**
 * Regression — a live trade's tick persist must NOT clobber a trade that was
 * placed (appended) AFTER the tick handler cached the day.
 *
 * Bug: the handler held a cached day snapshot (e.g. [BANK NIFTY]) and wrote the
 * whole thing back on its ~0.5s persist. A NIFTY 50 trade placed while BANK
 * NIFTY was live got erased by that stale write. The fix re-reads the day fresh
 * at persist time and merges only the live fields, preserving new trades.
 */
describe("tickHandler — persist must not clobber concurrently-placed trades", () => {
  function makeOpen(id: string, instrument: string) {
    return {
      id, instrument, type: "CALL_BUY", strike: null, expiry: null,
      contractSecurityId: null, entryPrice: 100, exitPrice: null, ltp: 100, qty: 1,
      status: "OPEN", targetPrice: null, stopLossPrice: null, trailingStopEnabled: false,
      lastTickAt: null, unrealizedPnl: 0,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tickHandler.clearStateCache();
    const h = tickHandler as any;
    h.lastPersistAt.clear();
    h.peakPrices.clear();
    h.exitingTrades.clear();
    getCapitalStateMock.mockResolvedValue({
      channel: "my-paper", tradingPool: 100_000, reservePool: 0, initialFunding: 100_000,
      currentDayIndex: 1, targetPercent: 1, profitHistory: [], cumulativePnl: 0,
      cumulativeCharges: 0, sessionTradeCount: 0,
    });
    getActiveBrokerConfigMock.mockResolvedValue(null);
  });

  it("a tick for trade A persists a day that still contains the just-placed trade B", async () => {
    const handler = tickHandler as any;
    const tradeA = makeOpen("TA", "NIFTY_50");
    const tradeB = makeOpen("TB", "BANK NIFTY");

    // `dayTrades` is the DB-backed list. Warm the cache while it holds only A.
    let dayTrades: any[] = [tradeA];
    getDayRecordMock.mockImplementation((ch: string) =>
      Promise.resolve(
        ch === "my-paper"
          ? { dayIndex: 1, date: "2024-11-14", trades: dayTrades, totalPnl: 0 }
          : { dayIndex: 1, date: "2024-11-14", trades: [], totalPnl: 0 },
      ),
    );

    // Non-matching tick warms the cache (snapshot = [A]) without persisting.
    handler.pendingUpdates.set("NSE:WARM", makeTick({ securityId: "WARM" }));
    await handler.processPendingUpdates();
    expect(upsertDayRecordMock).not.toHaveBeenCalled();

    // Trade B is placed → appended to the DB list as a NEW array, so the cached
    // snapshot still references the old [A].
    dayTrades = [tradeA, tradeB];
    upsertDayRecordMock.mockClear();

    // A matching tick for A triggers a persist. The fix re-reads fresh [A, B].
    handler.pendingUpdates.set("NSE:NIFTY_50", makeTick({ securityId: "NIFTY_50", ltp: 101 }));
    await handler.processPendingUpdates();

    expect(upsertDayRecordMock).toHaveBeenCalled();
    const persisted = upsertDayRecordMock.mock.calls.find((c) => c[0] === "my-paper")?.[1];
    const ids = (persisted?.trades ?? []).map((t: any) => t.id);
    expect(ids).toContain("TA"); // the live trade
    expect(ids).toContain("TB"); // the just-placed trade — NOT clobbered
  });
});
