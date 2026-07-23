/**
 * Lubas-managed live exits (AI-menu "Lubas exit" toggle).
 *
 * Default ON: the tick engine runs its own exit detection for LIVE trades and
 * fires `autoExitDetected` (→ recordAutoExit → a real market exit at Dhan). This
 * is the only way Runway / Anchor / Glide / tick-driven trailing work on live,
 * since Dhan Super Order legs can hold only a fixed SL + fixed TP.
 *
 * OFF: Dhan holds the SL/TP legs; the tick engine skips its own detection.
 *
 * These pin the gate at the point that matters — a live SL breach either fires
 * a Lubas exit or it does not, depending solely on the flag.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getCapitalStateMock = vi.fn();
const getDayRecordMock = vi.fn();
const upsertDayRecordMock = vi.fn();
const getActiveBrokerConfigMock = vi.fn();

const aiSprint: Record<string, any> = {
  defaultSL: 2, defaultTP: 5, dailyTargetPercent: 5,
  trailingStopEnabled: false, trailingStopPercent: 2,
  trailingDistanceSource: "config", trailingActivationGatePercent: 2,
  trailingActivationHoldSeconds: 0, tpTrailPercent: 1.5,
};
// The flag under test. Mutable so a single test can flip it; the getExitConfig
// mock reads it live.
let lubasManagedExit = true;

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

vi.mock("../portfolio/aiModeConfig", () => ({
  bookForChannel: (ch: string) => (ch === "paper" ? "paper" : "live"),
  originKind: () => "ai",
  getExitConfig: () => ({
    sprint: aiSprint,
    runway: { coolingSec: 300, defaultSlPct: 25, cooledSlPct: 12.5, breakevenAtFrac: 0.5, nearTargetFrac: 0.9, trailPct: 15, defaultTargetPct: 2.3 },
    anchor: { coolingSec: 300, defaultSlPct: 25, cooledSlPct: 12.5, breakevenAtFrac: 0.5, nearTargetFrac: 0.9, trailPct: 15, defaultTargetPct: 2.3 },
    glide: { disasterSlPct: 50 },
  }),
  // T129 — lubasManagedExit moved to the common block.
  getCommonConfig: () => ({ lubasManagedExit }),
  getAiConfig: () => ({ strategies: {}, sizing: { perInstrument: {} } }),
}));

vi.mock("../broker/tickBus", () => ({
  tickBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock("../broker/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), important: vi.fn() }),
}));
vi.mock("./compounding", () => ({ recalculateDayAggregates: (day: any) => day }));

import { tickHandler } from "./tickHandler";
import type { TickData } from "../broker/types";

// securityId matches the trade's contractSecurityId — an option trade with a
// contract id is matched ONLY by that id (tickMatchesTrade), never the underlying.
const tick = (ltp: number): TickData =>
  ({ exchange: "NSE", securityId: "111", ltp, timestamp: Date.now() }) as TickData;

/** A live BUY on live, with a Sprint stop just below entry. */
const liveTrade = (overrides: Partial<any> = {}): any => ({
  id: "T-LIVE", instrument: "NIFTY_50", type: "BUY", strike: null, expiry: null,
  contractSecurityId: "111", entryPrice: 100, exitPrice: null, ltp: 100, qty: 65,
  status: "OPEN", targetPrice: 120, stopLossPrice: 95, breakevenPrice: 100,
  exitStrategy: "sprint", superOrderId: null, lastTickAt: null, unrealizedPnl: 0,
  ...overrides,
});

/** Drive one tick with the trade sitting on `live` (other channels empty). */
async function processLive(trade: any, ltp: number): Promise<void> {
  getDayRecordMock.mockImplementation((channel: string) =>
    Promise.resolve(
      channel === "live"
        ? { dayIndex: 1, date: "2024-11-14", trades: [trade], totalPnl: 0 }
        : { dayIndex: 1, date: "2024-11-14", trades: [], totalPnl: 0 },
    ),
  );
  tickHandler.clearStateCache();
  const h = tickHandler as any;
  h.pendingUpdates.set(`NSE:111`, tick(ltp));
  await h.processPendingUpdates();
}

describe("Lubas-managed live exits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tickHandler.clearStateCache();
    (tickHandler as any).peakPrices.clear();
    (tickHandler as any).exitingTrades.clear();
    lubasManagedExit = true;
    getCapitalStateMock.mockResolvedValue({
      channel: "live", tradingPool: 100_000, reservePool: 0, initialFunding: 100_000,
      currentDayIndex: 1, targetPercent: 1, profitHistory: [], cumulativePnl: 0,
      cumulativeCharges: 0, sessionTradeCount: 0,
    });
    getActiveBrokerConfigMock.mockResolvedValue({ brokerId: "test", settings: {} });
  });

  it("fires a Lubas exit on a live SL breach when the toggle is ON", async () => {
    lubasManagedExit = true;
    let exitEvent: any = null;
    tickHandler.once("autoExitDetected", (e) => { exitEvent = e; });
    // Price falls below the 95 stop.
    await processLive(liveTrade(), 94);
    expect(exitEvent).not.toBeNull();
    expect(exitEvent.channel).toBe("live");
    expect(exitEvent.reason).toBe("SL_HIT");
  });

  it("does NOT fire a Lubas exit when the toggle is OFF (Dhan owns the legs)", async () => {
    lubasManagedExit = false;
    let exitEvent: any = null;
    tickHandler.once("autoExitDetected", (e) => { exitEvent = e; });
    // Same breach — but with Dhan-managed exits, the tick engine must not act.
    await processLive(liveTrade(), 94);
    expect(exitEvent).toBeNull();
  });

  it("runs Glide's disaster stop on live only when ON", async () => {
    // A live Glide trade (no SL/TP) must still get its 50% disaster backstop
    // when Lubas owns the exit — and must NOT when Dhan does (it never reaches
    // detection). entryPending false so the first tick doesn't reprice the entry.
    const glide = () => liveTrade({ id: "T-GLIDE", exitStrategy: "glide", stopLossPrice: null, targetPrice: null });

    lubasManagedExit = true;
    let onEvent: any = null;
    tickHandler.once("autoExitDetected", (e) => { onEvent = e; });
    await processLive(glide(), 40); // past a 50% disaster stop from entry 100
    expect(onEvent?.reason).toBe("SL_HIT");

    (tickHandler as any).exitingTrades.clear();
    lubasManagedExit = false;
    let offEvent: any = null;
    tickHandler.once("autoExitDetected", (e) => { offEvent = e; });
    await processLive(glide(), 40);
    expect(offEvent).toBeNull();
  });
});
