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
const patchTradeInDayMock = vi.fn();
const patchDayAggregatesMock = vi.fn();
const getActiveBrokerConfigMock = vi.fn();

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    getCapitalState: (...args: any[]) => getCapitalStateMock(...args),
    getDayRecord: (...args: any[]) => getDayRecordMock(...args),
    upsertDayRecord: (...args: any[]) => upsertDayRecordMock(...args),
    // T86 β — persist now writes each open trade atomically (positional $set)
    // + one aggregate write, instead of a whole-day upsert. Both return a
    // truthy DayRecord so the handler's `anyPatched` path runs.
    patchTradeInDay: (...args: any[]) => patchTradeInDayMock(...args),
    patchDayAggregates: (...args: any[]) => patchDayAggregatesMock(...args),
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
      channel: "paper",
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
    patchTradeInDayMock.mockResolvedValue({ dayIndex: 1, trades: [] });
    patchDayAggregatesMock.mockResolvedValue({ dayIndex: 1, trades: [] });
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

    // The matched OPEN trade must have been persisted via the atomic per-trade
    // write (T86 β) for at least one channel — proving the anyPatched path ran.
    expect(patchTradeInDayMock).toHaveBeenCalled();

    vi.clearAllMocks();

    // Next batch: cache for matched channels was invalidated, so those
    // channels re-read from Mongo. That is the desired behaviour — fresh
    // state after a tick→trade match.
    handler.pendingUpdates.set("NSE:NIFTY_50", makeTick({ securityId: "NIFTY_50" }));
    await handler.processPendingUpdates();

    expect(getCapitalStateMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("carries the recomputed unrealizedPnl in the per-trade patch (T86 ③)", async () => {
    const handler = tickHandler as any;
    // F1's beforeEach doesn't reset the persist throttle / guards; a prior test
    // in this block leaves lastPersistAt set, which would throttle our persist.
    handler.lastPersistAt.clear();
    handler.peakPrices.clear();
    handler.exitingTrades.clear();
    // Open trade with a non-zero unrealizedPnl on the fresh day record; the
    // per-tick persist must include it (β dropped it, ③ restores it) so
    // day_records stays the single fresh source of truth for the mirror.
    getDayRecordMock.mockResolvedValue({
      dayIndex: 1,
      date: "2024-11-14",
      trades: [{
        id: "T1", instrument: "NIFTY_50", type: "BUY", strike: null, expiry: null,
        contractSecurityId: null, entryPrice: 100, exitPrice: null, ltp: 100, qty: 1,
        status: "OPEN", targetPrice: null, stopLossPrice: null, trailingStopEnabled: false,
        lastTickAt: null, unrealizedPnl: 42,
      }],
      totalPnl: 0,
    });

    handler.pendingUpdates.set("NSE:NIFTY_50", makeTick({ securityId: "NIFTY_50" }));
    await handler.processPendingUpdates();

    expect(patchTradeInDayMock).toHaveBeenCalledWith(
      expect.anything(),
      1,
      "T1",
      expect.objectContaining({ unrealizedPnl: 42 }),
      undefined,
      expect.objectContaining({ requireOpen: true, silent: true }),
    );
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
      channel: "paper",
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
    patchTradeInDayMock.mockResolvedValue({ dayIndex: 1, trades: [] });
    patchDayAggregatesMock.mockResolvedValue({ dayIndex: 1, trades: [] });
  });

  it("even WITHOUT clearStateCache the cleared trade is never re-persisted (β atomic persist)", async () => {
    const handler = tickHandler as any;

    // Warm the cache while the day still holds an open trade. Use a
    // non-matching tick so no persist/invalidation happens during warm —
    // the cache is left holding the open-trade day.
    getDayRecordMock.mockResolvedValue({ dayIndex: 1, date: "2024-11-14", trades: [openTrade], totalPnl: 0 });
    handler.pendingUpdates.set("NSE:WARM", makeTick({ securityId: "WARM" }));
    await handler.processPendingUpdates();
    expect(patchTradeInDayMock).not.toHaveBeenCalled();

    // Simulate the clear: Mongo now returns an empty day, but the cache is
    // NOT invalidated. A matching tick arrives — the stale snapshot still
    // holds the open trade, so a persist IS attempted.
    getDayRecordMock.mockResolvedValue({ dayIndex: 1, date: "2024-11-14", trades: [], totalPnl: 0 });
    vi.clearAllMocks();
    handler.pendingUpdates.set("NSE:NIFTY_50", makeTick({ securityId: "NIFTY_50" }));
    await handler.processPendingUpdates();

    // But the atomic persist iterates the FRESH (now empty) day record, not the
    // stale snapshot — so no trade is ever written back. The old whole-day
    // upsert would have resurrected the cleared trade; the β persist cannot.
    expect(patchTradeInDayMock).not.toHaveBeenCalled();
    expect(patchDayAggregatesMock).not.toHaveBeenCalled();
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

    expect(patchTradeInDayMock).not.toHaveBeenCalled();
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
      channel: "paper", tradingPool: 100_000, reservePool: 0, initialFunding: 100_000,
      currentDayIndex: 1, targetPercent: 1, profitHistory: [], cumulativePnl: 0,
      cumulativeCharges: 0, sessionTradeCount: 0,
    });
    getActiveBrokerConfigMock.mockResolvedValue(null);
    patchTradeInDayMock.mockResolvedValue({ dayIndex: 1, trades: [] });
    patchDayAggregatesMock.mockResolvedValue({ dayIndex: 1, trades: [] });
  });

  it("a tick for trade A patches only A, never touching the just-placed trade B", async () => {
    const handler = tickHandler as any;
    const tradeA = makeOpen("TA", "NIFTY_50");
    const tradeB = makeOpen("TB", "BANK NIFTY");

    // `dayTrades` is the DB-backed list. Warm the cache while it holds only A.
    let dayTrades: any[] = [tradeA];
    getDayRecordMock.mockImplementation((ch: string) =>
      Promise.resolve(
        ch === "paper"
          ? { dayIndex: 1, date: "2024-11-14", trades: dayTrades, totalPnl: 0 }
          : { dayIndex: 1, date: "2024-11-14", trades: [], totalPnl: 0 },
      ),
    );

    // Non-matching tick warms the cache (snapshot = [A]) without persisting.
    handler.pendingUpdates.set("NSE:WARM", makeTick({ securityId: "WARM" }));
    await handler.processPendingUpdates();
    expect(patchTradeInDayMock).not.toHaveBeenCalled();

    // Trade B is placed → appended to the DB list as a NEW array, so the cached
    // snapshot still references the old [A].
    dayTrades = [tradeA, tradeB];
    patchTradeInDayMock.mockClear();

    // A matching tick for A triggers a persist. The atomic β persist re-reads
    // fresh [A, B] and writes ONLY the live trade A (positional $set) — B is
    // never in the write path, so it cannot be clobbered.
    handler.pendingUpdates.set("NSE:NIFTY_50", makeTick({ securityId: "NIFTY_50", ltp: 101 }));
    await handler.processPendingUpdates();

    expect(patchTradeInDayMock).toHaveBeenCalled();
    // patchTradeInDay(channel, dayIndex, tradeId, patch, ...) — 3rd arg is the id.
    const paperPatchIds = patchTradeInDayMock.mock.calls
      .filter((c) => c[0] === "paper")
      .map((c) => c[2]);
    expect(paperPatchIds).toContain("TA");    // the live trade was patched
    expect(paperPatchIds).not.toContain("TB"); // the just-placed trade — untouched
  });
});

/**
 * Entry-pending fill — the paper-trade stale-entry fix.
 *
 * Paper trades open with a placeholder entry (mock "fills" at the snapshot we
 * sent, which lags the live option price → artificial instant profit). The
 * first live tick for the contract must overwrite entryPrice and shift
 * SL/TP/breakeven by the same delta, then clear the pending flag. If no tick
 * arrives within the grace window, the placeholder is kept.
 */
describe("tickHandler — entry-pending first-tick fill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tickHandler.clearStateCache();
    getCapitalStateMock.mockResolvedValue({
      channel: "paper", tradingPool: 100_000, reservePool: 0,
      initialFunding: 100_000, currentDayIndex: 1, targetPercent: 1,
      profitHistory: [], cumulativePnl: 0, cumulativeCharges: 0, sessionTradeCount: 0,
    });
    getActiveBrokerConfigMock.mockResolvedValue(null);
    patchTradeInDayMock.mockResolvedValue({ dayIndex: 1, trades: [] });
    patchDayAggregatesMock.mockResolvedValue({ dayIndex: 1, trades: [] });
  });

  it("first matching tick overwrites the placeholder entry and shifts SL/TP", async () => {
    const handler = tickHandler as any;
    const trade: any = {
      id: "P1", instrument: "BANKNIFTY", type: "CALL_BUY", strike: 58200,
      expiry: null, contractSecurityId: "OPT1",
      entryPrice: 100, entryPending: true, exitPrice: null, ltp: 100, qty: 15,
      status: "OPEN", targetPrice: 110, stopLossPrice: 95, breakevenPrice: 101,
      tslMode: "manual", trailingStopEnabled: false, lastTickAt: null, unrealizedPnl: 0,
      openedAt: Date.now(),
    };
    getDayRecordMock.mockResolvedValue({ dayIndex: 1, date: "2026-07-01", trades: [trade], totalPnl: 0 });

    // First live tick for the contract at 130 (option moved before our fill).
    handler.pendingUpdates.set("NSE:OPT1", makeTick({ securityId: "OPT1", ltp: 130 }));
    await handler.processPendingUpdates();

    expect(trade.entryPending).toBe(false);
    expect(trade.entryPrice).toBe(130);      // filled at the live tick, not 100
    expect(trade.targetPrice).toBe(140);     // 110 + 30 delta
    expect(trade.stopLossPrice).toBe(125);   // 95 + 30 delta
    expect(trade.breakevenPrice).toBe(131);  // 101 + 30 delta
    expect(trade.ltp).toBe(130);
  });

  it("does NOT re-fill a trade whose entry is already confirmed (entryPending false)", async () => {
    const handler = tickHandler as any;
    const trade: any = {
      id: "P2", instrument: "BANKNIFTY", type: "CALL_BUY", strike: 58200,
      expiry: null, contractSecurityId: "OPT2",
      entryPrice: 100, entryPending: false, exitPrice: null, ltp: 100, qty: 15,
      status: "OPEN", targetPrice: 110, stopLossPrice: 95,
      tslMode: "manual", trailingStopEnabled: false, lastTickAt: null, unrealizedPnl: 0, openedAt: Date.now(),
    };
    getDayRecordMock.mockResolvedValue({ dayIndex: 1, date: "2026-07-01", trades: [trade], totalPnl: 0 });

    handler.pendingUpdates.set("NSE:OPT2", makeTick({ securityId: "OPT2", ltp: 130 }));
    await handler.processPendingUpdates();

    expect(trade.entryPrice).toBe(100);      // untouched
    expect(trade.targetPrice).toBe(110);     // untouched
    expect(trade.ltp).toBe(130);             // ltp still marks normally
  });

  it("clears entryPending after the grace window when no tick arrives (keeps placeholder)", async () => {
    const handler = tickHandler as any;
    const trade: any = {
      id: "P3", instrument: "BANKNIFTY", type: "CALL_BUY", strike: 58200,
      expiry: null, contractSecurityId: "OPT3",
      entryPrice: 100, entryPending: true, exitPrice: null, ltp: 100, qty: 15,
      status: "OPEN", targetPrice: 110, stopLossPrice: 95,
      trailingStopEnabled: false, lastTickAt: null, unrealizedPnl: 0,
      openedAt: Date.now() - 20_000, // older than the 15s grace window
    };
    getDayRecordMock.mockResolvedValue({ dayIndex: 1, date: "2026-07-01", trades: [trade], totalPnl: 0 });

    // A tick for a DIFFERENT contract — never matches OPT3.
    handler.pendingUpdates.set("NSE:OTHER", makeTick({ securityId: "OTHER", ltp: 130 }));
    await handler.processPendingUpdates();

    expect(trade.entryPending).toBe(false);  // gave up waiting
    expect(trade.entryPrice).toBe(100);      // kept the placeholder
    expect(trade.targetPrice).toBe(110);     // unchanged
  });
});
