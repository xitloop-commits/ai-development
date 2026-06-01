/**
 * Wave 1 — TSL ratchet + auto-exit tests for tickHandler.
 *
 * Locks the existing trailing-stop behavior in tickHandler.ts (was untested).
 * The ratchet logic was implemented but had no regression tests; without
 * these the next refactor could silently break it.
 *
 * Covered:
 *   1. TSL ratchets UP for BUY when price makes a new high
 *   2. TSL does NOT move down (never widens the stop)
 *   3. TSL ratchets DOWN for SELL when price makes a new low
 *   4. SL_HIT fires when ltp breaches the ratched SL
 *   5. broker trailingStopEnabled=false → SL stays static
 *   6. broker setting governs every open trade (the per-trade flag is ignored)
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
    securityId: "NIFTY_50",
    ltp: 100,
    timestamp: Date.now(),
    ...overrides,
  } as TickData;
}

function makeBuyTrade(overrides: Partial<any> = {}): any {
  return {
    id: "T-BUY",
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
    stopLossPrice: 95,
    trailingStopEnabled: undefined,  // fall back to broker setting
    lastTickAt: null,
    unrealizedPnl: 0,
    ...overrides,
  };
}

function makeSellTrade(overrides: Partial<any> = {}): any {
  return {
    id: "T-SELL",
    instrument: "NIFTY_50",
    type: "SELL",
    strike: null,
    expiry: null,
    contractSecurityId: null,
    entryPrice: 100,
    exitPrice: null,
    ltp: 100,
    qty: 1,
    status: "OPEN",
    targetPrice: null,
    stopLossPrice: 105,
    trailingStopEnabled: undefined,
    lastTickAt: null,
    unrealizedPnl: 0,
    ...overrides,
  };
}

async function processWith(trade: any, tick: TickData): Promise<void> {
  getDayRecordMock.mockResolvedValue({
    dayIndex: 1,
    date: "2024-11-14",
    trades: [trade],
    totalPnl: 0,
  });
  const handler = tickHandler as any;
  handler.pendingUpdates.set(`${tick.exchange}:${tick.securityId}`, tick);
  await handler.processPendingUpdates();
}

describe("tickHandler TSL ratchet — Wave 1", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tickHandler.clearStateCache();
    (tickHandler as any).peakPrices.clear();

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
    // TSL on, 1.5% trail
    getActiveBrokerConfigMock.mockResolvedValue({
      brokerId: "test",
      settings: { trailingStopEnabled: true, trailingStopPercent: 1.5 },
    });
  });

  it("BUY: ratchets SL UP when price makes a new high", async () => {
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });
    // tick to 110 → newPeak=110 → trailedSL = 110 × (1 - 0.015) = 108.35
    await processWith(trade, makeTick({ ltp: 110 }));
    expect(trade.stopLossPrice).toBeCloseTo(108.35, 2);
  });

  it("BUY: SL does NOT move DOWN if price retraces (no widening)", async () => {
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });
    await processWith(trade, makeTick({ ltp: 110 }));  // ratchets to 108.35
    const ratchedSL = trade.stopLossPrice;
    await processWith(trade, makeTick({ ltp: 105 }));  // retracement
    expect(trade.stopLossPrice).toBe(ratchedSL);  // unchanged
  });

  it("SELL: ratchets SL DOWN when price makes a new low", async () => {
    const trade = makeSellTrade({ entryPrice: 100, stopLossPrice: 105 });
    // tick to 90 → newPeak=90 (min) → trailedSL = 90 × (1 + 0.015) = 91.35
    await processWith(trade, makeTick({ ltp: 90 }));
    expect(trade.stopLossPrice).toBeCloseTo(91.35, 2);
  });

  it("BUY: SL_HIT fires when ltp breaches the ratched SL", async () => {
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });
    let exitEvent: any = null;
    tickHandler.once("autoExitDetected", (e) => { exitEvent = e; });

    // Step 1: ratchet up — peak 110, trailedSL = 108.35
    await processWith(trade, makeTick({ ltp: 110 }));
    expect(trade.stopLossPrice).toBeCloseTo(108.35, 2);

    // Step 2: price drops to 108 (below trailed SL of 108.35) — fire exit
    await processWith(trade, makeTick({ ltp: 108 }));

    expect(exitEvent).not.toBeNull();
    expect(exitEvent.reason).toBe("SL_HIT");
    expect(exitEvent.tradeId).toBe(trade.id);
    expect(exitEvent.exitPrice).toBe(108);
  });

  it("trailingStopEnabled=false in broker → SL does NOT move", async () => {
    getActiveBrokerConfigMock.mockResolvedValue({
      brokerId: "test",
      settings: { trailingStopEnabled: false, trailingStopPercent: 1.5 },
    });
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });
    await processWith(trade, makeTick({ ltp: 110 }));
    expect(trade.stopLossPrice).toBe(95);  // unchanged
  });

  it("broker setting governs — trailing OFF globally never trails, even if the trade's frozen flag is on", async () => {
    getActiveBrokerConfigMock.mockResolvedValue({
      brokerId: "test",
      settings: { trailingStopEnabled: false, trailingStopPercent: 1.5 },
    });
    const trade = makeBuyTrade({
      entryPrice: 100, stopLossPrice: 95,
      trailingStopEnabled: true,  // stale per-trade ON is ignored now
    });
    await processWith(trade, makeTick({ ltp: 110 }));
    expect(trade.stopLossPrice).toBe(95);  // global OFF → unchanged
  });

  it("broker setting governs — trailing ON globally trails every open trade, even one whose frozen flag is off", async () => {
    // Broker config defaults to trailingStopEnabled:true in beforeEach.
    const trade = makeBuyTrade({
      entryPrice: 100, stopLossPrice: 95,
      trailingStopEnabled: false,  // stale per-trade OFF is ignored now
    });
    await processWith(trade, makeTick({ ltp: 110 }));
    expect(trade.stopLossPrice).toBeCloseTo(108.35, 2);  // global ON → trails
  });

  it("restart safety: persisted trade.peakLtp survives in-memory Map clear", async () => {
    /**
     * Simulates server restart: clear the in-memory peakPrices Map. The
     * persisted `trade.peakLtp` should be the source of truth so the next
     * tick doesn't lower the peak back to entryPrice.
     */
    const trade = makeBuyTrade({
      entryPrice: 100,
      stopLossPrice: 108.35,  // already trailed from a prior session
      peakLtp: 110,            // persisted peak
    });
    (tickHandler as any).peakPrices.clear();  // simulate restart

    // Next tick at 105 — below peak. Should NOT lower SL.
    await processWith(trade, makeTick({ ltp: 105 }));
    expect(trade.stopLossPrice).toBeCloseTo(108.35, 2);
    // peakLtp also unchanged (105 < 110)
    expect(trade.peakLtp).toBe(110);
  });

  it("trade.peakLtp gets updated on a new high (persistence write-through)", async () => {
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95, peakLtp: 105 });
    await processWith(trade, makeTick({ ltp: 112 }));
    expect(trade.peakLtp).toBe(112);  // ratched up
    // SL also moved: 112 × 0.985 = 110.32
    expect(trade.stopLossPrice).toBeCloseTo(110.32, 2);
  });

  it("ratchet does NOT fire when price is below entry on first tick (no new peak)", async () => {
    /**
     * BUY trade entered at 100, SL at 90. First tick comes at 95 (below
     * entry). peakPrices defaults to entryPrice (100), and Math.max(100,95)
     * = 100 = currentPeak → no new peak → no ratchet. SL stays at 90.
     * Locks in current behavior: trail only fires when price actually makes
     * a new high beyond entry.
     */
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 90 });
    await processWith(trade, makeTick({ ltp: 95 }));
    expect(trade.stopLossPrice).toBe(90);  // unchanged
  });
});
