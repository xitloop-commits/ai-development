/**
 * TSL activation + ratchet + auto-exit tests for tickHandler.
 *
 * Trailing is now GATED: the stop does not trail immediately. Price must clear
 * breakeven by the activation-gate %, held for the hold time, before the stop
 * arms. Once armed, the stop trails the peak by the gap % and is floored at
 * breakeven so a pullback can never give back charges. Gate/hold/gap come from
 * broker settings (the same source the UI TradeBar reads).
 *
 * Covered:
 *   1. BUY: trails UP only AFTER activation (gate cleared + hold elapsed)
 *   2. BUY: SL never moves down (no widening)
 *   3. SELL: trails DOWN after activation
 *   4. SL_HIT fires at the ratched SL level
 *   5. trailingStopEnabled=false → never trails
 *   6. price below the gate → never arms → never trails
 *   7. hold timer: gate must hold N seconds before activation
 *   8. breakeven floor: trailed stop never drops below breakeven
 *   9. peak tracking (peakLtp) is independent of activation + restart-safe
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    breakevenPrice: 100, // no charges in tests → breakeven = entry
    trailingStopEnabled: undefined,
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
    breakevenPrice: 100,
    trailingStopEnabled: undefined,
    lastTickAt: null,
    unrealizedPnl: 0,
    ...overrides,
  };
}

async function processWith(trade: any, tick: TickData): Promise<void> {
  // Only my-paper holds the trade; the other paper channels return an empty day
  // so the same trade isn't processed multiple times per tick (which would let
  // the per-trade activation state collide across channels in the test).
  getDayRecordMock.mockImplementation((channel: string) =>
    Promise.resolve(
      channel === "my-paper"
        ? { dayIndex: 1, date: "2024-11-14", trades: [trade], totalPnl: 0 }
        : { dayIndex: 1, date: "2024-11-14", trades: [], totalPnl: 0 },
    ),
  );
  tickHandler.clearStateCache(); // re-read fresh each tick (matches production)
  const handler = tickHandler as any;
  handler.pendingUpdates.set(`${tick.exchange}:${tick.securityId}`, tick);
  await handler.processPendingUpdates();
}

async function processTicks(trade: any, ltps: number[]): Promise<void> {
  for (const ltp of ltps) await processWith(trade, makeTick({ ltp }));
}

describe("tickHandler TSL — activation gate, ratchet, breakeven floor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tickHandler.clearStateCache();
    (tickHandler as any).peakPrices.clear();
    (tickHandler as any).tslArmedAt.clear();
    (tickHandler as any).tslActivated.clear();
    (tickHandler as any).exitingTrades.clear();

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
    // TSL on, 1.5% gap, 2% gate, 0s hold (so 2 ticks activate without real time).
    getActiveBrokerConfigMock.mockResolvedValue({
      brokerId: "test",
      settings: {
        trailingStopEnabled: true,
        trailingStopPercent: 1.5,
        trailingActivationGatePercent: 2,
        trailingActivationHoldSeconds: 0,
      },
    });
  });

  it("BUY: trails UP only after activation (arm tick, then activate tick)", async () => {
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });
    // First tick clears the gate (>102) → arms but does NOT trail yet.
    await processWith(trade, makeTick({ ltp: 103 }));
    expect(trade.stopLossPrice).toBe(95);
    // Second tick (hold=0) activates → trails: peak 110 → 110 × 0.985 = 108.35.
    await processWith(trade, makeTick({ ltp: 110 }));
    expect(trade.stopLossPrice).toBeCloseTo(108.35, 2);
  });

  it("BUY: SL does NOT move DOWN if price retraces (no widening)", async () => {
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });
    await processTicks(trade, [103, 110]); // arm + activate → 108.35
    const ratchedSL = trade.stopLossPrice;
    await processWith(trade, makeTick({ ltp: 105 })); // retrace
    expect(trade.stopLossPrice).toBe(ratchedSL); // unchanged
  });

  it("SELL: trails DOWN after activation", async () => {
    const trade = makeSellTrade({ entryPrice: 100, stopLossPrice: 105 });
    // Gate for SELL = breakeven × (1 − 2%) = 98. Arm at 97, activate at 90.
    await processTicks(trade, [97, 90]); // peak(min)=90 → 90 × 1.015 = 91.35
    expect(trade.stopLossPrice).toBeCloseTo(91.35, 2);
  });

  it("BUY: SL_HIT fires at the ratched SL level", async () => {
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });
    let exitEvent: any = null;
    tickHandler.once("autoExitDetected", (e) => { exitEvent = e; });

    await processTicks(trade, [103, 110]); // SL trails to 108.35
    expect(trade.stopLossPrice).toBeCloseTo(108.35, 2);

    await processWith(trade, makeTick({ ltp: 108 })); // breaches 108.35
    expect(exitEvent).not.toBeNull();
    expect(exitEvent.reason).toBe("SL_HIT");
    expect(exitEvent.tradeId).toBe(trade.id);
    // Fills at the stop LEVEL, not the breaching tick.
    expect(exitEvent.exitPrice).toBeCloseTo(108.35, 2);
  });

  it("trailingStopEnabled=false → SL never moves", async () => {
    getActiveBrokerConfigMock.mockResolvedValue({
      brokerId: "test",
      settings: {
        trailingStopEnabled: false,
        trailingStopPercent: 1.5,
        trailingActivationGatePercent: 2,
        trailingActivationHoldSeconds: 0,
      },
    });
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });
    await processTicks(trade, [103, 110]);
    expect(trade.stopLossPrice).toBe(95); // unchanged
  });

  it("price never clears the gate → never arms → SL stays put", async () => {
    // Gate = 102. A 101 tick is in profit but below the gate.
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });
    await processTicks(trade, [101, 101.5]);
    expect(trade.stopLossPrice).toBe(95);
    expect((tickHandler as any).tslActivated.has("T-BUY")).toBe(false);
  });

  it("hold timer: gate must hold the full hold-time before activation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    getActiveBrokerConfigMock.mockResolvedValue({
      brokerId: "test",
      settings: {
        trailingStopEnabled: true,
        trailingStopPercent: 1.5,
        trailingActivationGatePercent: 2,
        trailingActivationHoldSeconds: 10, // 10s hold
      },
    });
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });

    await processWith(trade, makeTick({ ltp: 110 })); // arm at t=0
    expect(trade.stopLossPrice).toBe(95);

    vi.setSystemTime(5000); // 5s — not enough
    await processWith(trade, makeTick({ ltp: 110 }));
    expect(trade.stopLossPrice).toBe(95);

    vi.setSystemTime(11000); // 11s — hold elapsed → activate + trail
    await processWith(trade, makeTick({ ltp: 110 }));
    expect(trade.stopLossPrice).toBeCloseTo(108.35, 2);
  });

  it("breakeven floor: trailed stop never drops below breakeven (recover charges)", async () => {
    // Wide gap (5%) vs small gate (1%): the raw trailed stop would be below
    // breakeven, so the floor must clamp it to breakeven.
    getActiveBrokerConfigMock.mockResolvedValue({
      brokerId: "test",
      settings: {
        trailingStopEnabled: true,
        trailingStopPercent: 5,
        trailingActivationGatePercent: 1,
        trailingActivationHoldSeconds: 0,
      },
    });
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95, breakevenPrice: 100 });
    // Gate = 101. Arm at 101.5, activate at 102. peak 102 → 102 × 0.95 = 96.9,
    // which is below breakeven 100 → floored to 100.
    await processTicks(trade, [101.5, 102]);
    expect(trade.stopLossPrice).toBeCloseTo(100, 2);
  });

  it("peak tracking is independent of activation + restart-safe", async () => {
    // Persisted peak survives an in-memory Map clear (restart); a lower tick
    // does not lower the peak, and without re-activation the SL is untouched.
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 108.35, peakLtp: 110 });
    (tickHandler as any).peakPrices.clear(); // simulate restart

    await processWith(trade, makeTick({ ltp: 105 })); // below peak
    expect(trade.peakLtp).toBe(110);
    expect(trade.stopLossPrice).toBeCloseTo(108.35, 2);
  });

  it("peakLtp updates on a new high regardless of activation", async () => {
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95, peakLtp: 105 });
    await processWith(trade, makeTick({ ltp: 112 }));
    expect(trade.peakLtp).toBe(112); // peak tracked even on the arming tick
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
