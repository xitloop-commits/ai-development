/**
 * TSL trail-from-start + ratchet + auto-exit tests for tickHandler.
 *
 * Trailing now trails from the FIRST tick — no activation gate, no hold, no
 * breakeven floor. The stop sits a fixed gap below the running peak from the
 * start; the gap comes from the setting:
 *   - "config" → trailingStopPercent % of the peak
 *   - "signal" → the trade's own initial SL distance (trade.slDistance, rupees)
 * It only ratchets in the favourable direction — never crawls back.
 *
 * Covered:
 *   1. BUY: trails UP from the first favourable tick
 *   2. BUY: SL never moves down (no widening)
 *   3. SELL: trails DOWN from the first favourable tick
 *   4. SL_HIT fires at the ratcheted SL level
 *   5. per-trade auto TSL trails even when the global switch is off (independence)
 *   6. trails even on a small move (no gate to clear)
 *   7. signal mode: trails at the trade's slDistance, not the config gap
 *   8. no breakeven floor: the stop can trail below breakeven
 *   9. peak tracking (peakLtp) is restart-safe
 *  10. peakLtp updates on a new high
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getCapitalStateMock = vi.fn();
const getDayRecordMock = vi.fn();
const upsertDayRecordMock = vi.fn();
const getActiveBrokerConfigMock = vi.fn();
const aiSprint: Record<string, any> = {}; // Sprint trailing config — tests set this (read via the getAiConfig mock)

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
// Trailing comes from the SHARED Sprint exit config (AI menu), so these tests
// drive it through `aiSprint` below rather than broker settings.
vi.mock("../portfolio/aiModeConfig", () => ({
  aiModeForChannel: () => null,
  modeForChannel: (ch: string) => (ch === "paper" ? "paper" : "live"),
  // Sprint / Runway / Anchor are SHARED now — the engine reads getExitConfig().
  getExitConfig: () => ({
    sprint: aiSprint,
    runway: { coolingSec: 300, defaultSlPct: 25, cooledSlPct: 12.5, breakevenAtFrac: 0.5, nearTargetFrac: 0.9, trailPct: 15, defaultTargetPct: 2.3 },
    anchor: { coolingSec: 300, defaultSlPct: 25, cooledSlPct: 12.5, breakevenAtFrac: 0.5, nearTargetFrac: 0.9, trailPct: 15, defaultTargetPct: 2.3 },
  }),
  getAiConfig: () => ({ strategies: {}, sizing: { perInstrument: {}, aiLiveLotCap: 1 } }),
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
  // Only paper holds the trade; the other paper channels return an empty day
  // so the same trade isn't processed multiple times per tick.
  getDayRecordMock.mockImplementation((channel: string) =>
    Promise.resolve(
      channel === "paper"
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

describe("tickHandler TSL — trail from start, ratchet, no gate/floor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tickHandler.clearStateCache();
    (tickHandler as any).peakPrices.clear();
    (tickHandler as any).tslArmedAt.clear();
    (tickHandler as any).tslActivated.clear();
    (tickHandler as any).exitingTrades.clear();

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
    // TSL on, config source, 1.5% gap. Trailing config comes from the AI menu.
    getActiveBrokerConfigMock.mockResolvedValue({ brokerId: "test", settings: {} });
    for (const k of Object.keys(aiSprint)) delete aiSprint[k];
    Object.assign(aiSprint, {
      trailingStopEnabled: true,
      trailingStopPercent: 1.5,
      trailingDistanceSource: "config",
      trailingActivationGatePercent: 2,
      trailingActivationHoldSeconds: 0,
    });
  });

  it("BUY: trails UP from the first favourable tick (no gate)", async () => {
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });
    // One tick: peak 110 → 110 × 0.985 = 108.35, immediately.
    await processWith(trade, makeTick({ ltp: 110 }));
    expect(trade.stopLossPrice).toBeCloseTo(108.35, 2);
  });

  it("BUY: SL does NOT move DOWN if price retraces (no widening)", async () => {
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });
    await processWith(trade, makeTick({ ltp: 110 })); // → 108.35
    const ratchedSL = trade.stopLossPrice;
    await processWith(trade, makeTick({ ltp: 105 })); // retrace
    expect(trade.stopLossPrice).toBe(ratchedSL); // unchanged
  });

  it("SELL: trails DOWN from the first favourable tick", async () => {
    const trade = makeSellTrade({ entryPrice: 100, stopLossPrice: 105 });
    await processWith(trade, makeTick({ ltp: 90 })); // peak(min)=90 → 90 × 1.015 = 91.35
    expect(trade.stopLossPrice).toBeCloseTo(91.35, 2);
  });

  it("BUY: SL_HIT fires at the ratcheted SL level", async () => {
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });
    let exitEvent: any = null;
    tickHandler.once("autoExitDetected", (e) => { exitEvent = e; });

    await processWith(trade, makeTick({ ltp: 110 })); // SL trails to 108.35
    expect(trade.stopLossPrice).toBeCloseTo(108.35, 2);

    await processWith(trade, makeTick({ ltp: 108 })); // breaches 108.35
    expect(exitEvent).not.toBeNull();
    expect(exitEvent.reason).toBe("SL_HIT");
    expect(exitEvent.tradeId).toBe(trade.id);
    // Fills at the stop LEVEL, not the breaching tick.
    expect(exitEvent.exitPrice).toBeCloseTo(108.35, 2);
  });

  it("T86 β — a guarded SL_HIT re-fires only after the retry window while still OPEN", async () => {
    vi.useFakeTimers();
    let exitCount = 0;
    const onExit = () => { exitCount++; };
    tickHandler.on("autoExitDetected", onExit);
    try {
      const t0 = new Date("2026-07-19T04:00:00Z").getTime();
      vi.setSystemTime(t0);
      const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });

      await processWith(trade, makeTick({ ltp: 110 })); // SL trails to 108.35
      await processWith(trade, makeTick({ ltp: 108 })); // breach → emit #1 + guard
      expect(exitCount).toBe(1);

      // Same breach within the 30s window → guarded, no duplicate emit while TEA
      // is (expected to be) closing it.
      vi.setSystemTime(t0 + 15_000);
      await processWith(trade, makeTick({ ltp: 108 }));
      expect(exitCount).toBe(1);

      // The close never landed (TEA absent here) and the trade is STILL OPEN
      // past EXIT_RETRY_MS → the stale guard lets the exit be re-detected instead
      // of leaving the trade frozen forever.
      vi.setSystemTime(t0 + 31_000);
      await processWith(trade, makeTick({ ltp: 108 }));
      expect(exitCount).toBe(2);
    } finally {
      tickHandler.off("autoExitDetected", onExit);
      vi.useRealTimers();
    }
  });

  it("global trailing OFF no longer blocks a per-trade auto TSL (independence)", async () => {
    // Decision A: the broker-wide switch only SEEDS a trade's mode at open; the
    // tickHandler then trails on the trade's own tslMode. A trade left on "auto"
    // trails even when the global trailingStopEnabled is off.
    Object.assign(aiSprint, { trailingStopEnabled: false });
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95, tslMode: "auto" });
    await processWith(trade, makeTick({ ltp: 110 })); // peak 110 → 110 × 0.985 = 108.35
    expect(trade.stopLossPrice).toBeCloseTo(108.35, 2); // trails despite global off
  });

  it("trails on a small favourable move (no gate to clear)", async () => {
    // A 101 tick — barely in profit, well under the old 102 gate — still trails.
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95 });
    await processWith(trade, makeTick({ ltp: 101 })); // peak 101 → 101 × 0.985 = 99.485
    expect(trade.stopLossPrice).toBeCloseTo(99.49, 2);
  });

  it("signal mode: trails at the trade's slDistance, not the config gap", async () => {
    Object.assign(aiSprint, { trailingDistanceSource: "signal" }); // % ignored in signal mode
    // slDistance 5 (rupees). peak 110 → 110 − 5 = 105 (config gap would be 108.35).
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95, slDistance: 5 });
    await processWith(trade, makeTick({ ltp: 110 }));
    expect(trade.stopLossPrice).toBeCloseTo(105, 2);
  });

  it("no breakeven floor: the stop can trail below breakeven", async () => {
    // Wide 5% gap: peak 102 → 102 × 0.95 = 96.9, which is below breakeven 100.
    // With the floor removed, the stop trails there (96.9), not clamped to 100.
    Object.assign(aiSprint, { trailingStopPercent: 5, trailingActivationGatePercent: 1 });
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95, breakevenPrice: 100 });
    await processWith(trade, makeTick({ ltp: 102 }));
    expect(trade.stopLossPrice).toBeCloseTo(96.9, 2);
  });

  it("peak tracking is restart-safe (persisted peakLtp survives a Map clear)", async () => {
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 108.35, peakLtp: 110 });
    (tickHandler as any).peakPrices.clear(); // simulate restart

    await processWith(trade, makeTick({ ltp: 105 })); // below peak
    expect(trade.peakLtp).toBe(110);
    expect(trade.stopLossPrice).toBeCloseTo(108.35, 2); // no new high → unchanged
  });

  it("peakLtp updates on a new high", async () => {
    const trade = makeBuyTrade({ entryPrice: 100, stopLossPrice: 95, peakLtp: 105 });
    await processWith(trade, makeTick({ ltp: 112 }));
    expect(trade.peakLtp).toBe(112);
  });

  // ── Per-trade risk overrides: SL-disabled + TSL auto/manual ──────────────
  it("per-trade tslMode=manual freezes auto-trailing (stop stays put)", async () => {
    const trade = makeBuyTrade({ tslMode: "manual", stopLossPrice: 95, originalStopLossPrice: 95, slDistance: 5 });
    await processTicks(trade, [110]); // auto (config 1.5%) would trail to 108.35
    expect(trade.stopLossPrice).toBe(95); // manual → frozen
  });

  it("stopLossDisabled suppresses the hard-floor SL exit while the stop is unmoved", async () => {
    Object.assign(aiSprint, { trailingStopEnabled: false });
    // tslMode=manual so auto-trailing doesn't move the stop off its hard floor —
    // that's the scenario the SL-disabled gate protects.
    const trade = makeBuyTrade({ stopLossDisabled: true, tslMode: "manual", stopLossPrice: 95, originalStopLossPrice: 95 });
    let exitEvent: any = null;
    tickHandler.once("autoExitDetected", (e) => { exitEvent = e; });
    await processTicks(trade, [94]); // ltp 94 <= stop 95 → would be SL_HIT
    expect(exitEvent).toBeNull(); // suppressed
    expect(trade.status).toBe("OPEN");
  });

  it("targetDisabled suppresses the take-profit auto-exit (rides on SL/TSL only)", async () => {
    const trade = makeBuyTrade({ targetDisabled: true, tslMode: "manual", targetPrice: 105, stopLossPrice: 95, originalStopLossPrice: 95 });
    let exitEvent: any = null;
    tickHandler.once("autoExitDetected", (e) => { exitEvent = e; });
    await processTicks(trade, [106]); // ltp 106 >= target 105 → would be TP_HIT
    expect(exitEvent).toBeNull(); // suppressed
    expect(trade.status).toBe("OPEN");
  });

  it("stopLossDisabled STILL exits once the stop has trailed up (TSL live)", async () => {
    Object.assign(aiSprint, { trailingStopEnabled: true, trailingDistanceSource: "signal" });
    const trade = makeBuyTrade({ stopLossDisabled: true, stopLossPrice: 95, originalStopLossPrice: 95, slDistance: 5 });
    let exitEvent: any = null;
    tickHandler.once("autoExitDetected", (e) => { exitEvent = e; });
    await processTicks(trade, [110]); // peak 110 → stop trails to 105 (moved from 95)
    expect(trade.stopLossPrice).toBeCloseTo(105, 2);
    await processWith(trade, makeTick({ ltp: 104 })); // hits the trailed stop
    expect(exitEvent).not.toBeNull();
    expect(exitEvent.reason).toBe("SL_HIT");
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
