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
