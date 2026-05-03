/**
 * Tests for portfolioAgent.applyBrokerOrderEvent (B11-followup 3/3).
 *
 * The four broker outcomes orderSync used to handle directly:
 *   - FILLED with slippage (entry price adjustment)
 *   - FILLED with partial qty (qty adjustment + PENDING → OPEN)
 *   - CANCELLED / REJECTED / EXPIRED (mark CANCELLED)
 *   - No-match (TP/SL leg event, ignored)
 *
 * Plus the brokerId pair-match disambiguation added in commit 2/3:
 * a trade on dhan-ai-data is not touched by an event from dhan even
 * if the orderIds happen to collide.
 *
 * State + storage are mocked so the suite runs without Mongo.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TradeRecord, DayRecord, CapitalState } from "./state";
import type { BrokerOrderEvent } from "./types";

// ─── Mocks (hoisted) ────────────────────────────────────────────

const upsertDayRecordMock = vi.fn(async (_channel: any, day: DayRecord) => day);
const getCapitalStateMock = vi.fn();
const getDayRecordMock = vi.fn();
const recalculateMock = vi.fn((day: DayRecord) => day);

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    getCapitalState: (...args: any[]) => getCapitalStateMock(...args),
    getDayRecord: (...args: any[]) => getDayRecordMock(...args),
    upsertDayRecord: (...args: any[]) => upsertDayRecordMock(...args),
  };
});

vi.mock("./compounding", async () => {
  const actual = await vi.importActual<typeof import("./compounding")>("./compounding");
  return {
    ...actual,
    recalculateDayAggregates: (day: DayRecord) => recalculateMock(day),
  };
});

vi.mock("./storage", () => ({
  appendEvent: vi.fn(async () => undefined),
  upsertPosition: vi.fn(async () => undefined),
  PositionStateModel: { collection: { updateMany: vi.fn() } },
  PortfolioStateModel: { collection: { updateMany: vi.fn() } },
}));

vi.mock("../broker/brokerConfig", () => ({
  getActiveBrokerConfig: vi.fn(async () => null),
}));

vi.mock("../discipline", () => ({
  disciplineAgent: { onTradeClosed: vi.fn(async () => ({})) },
}));

vi.mock("../userSettings", () => ({
  getUserSettings: vi.fn(async () => ({ charges: { rates: [] } })),
}));

// ─── SUT ─────────────────────────────────────────────────────────

import { portfolioAgent } from "./portfolioAgent";

// ─── Fixtures ────────────────────────────────────────────────────

function makeTrade(overrides?: Partial<TradeRecord>): TradeRecord {
  return {
    id: "T-1",
    instrument: "NIFTY_50",
    type: "CALL_BUY",
    strike: 26000,
    entryPrice: 100,
    exitPrice: null,
    ltp: 100,
    qty: 75,
    capitalPercent: 10,
    pnl: 0,
    unrealizedPnl: 0,
    charges: 0,
    chargesBreakdown: [],
    status: "OPEN",
    targetPrice: 105,
    stopLossPrice: 98,
    brokerOrderId: "BORD-1",
    brokerId: "dhan",
    openedAt: 1700000000000,
    closedAt: null,
    ...overrides,
  };
}

function makeDay(trades: TradeRecord[]): DayRecord {
  return {
    dayIndex: 1,
    date: "2026-04-29",
    tradeCapital: 100000,
    targetPercent: 5,
    targetAmount: 5000,
    projCapital: 105000,
    originalProjCapital: 105000,
    actualCapital: 100000,
    deviation: 0,
    trades,
    totalPnl: 0,
    totalCharges: 0,
    totalQty: 0,
    instruments: [],
    status: "ACTIVE",
    rating: "future",
    channel: "my-live",
  };
}

function makeState(): CapitalState {
  return {
    channel: "my-live",
    initialFunding: 100000,
    tradingPool: 75000,
    reservePool: 25000,
    targetPercent: 5,
    currentDayIndex: 1,
    cumulativePnl: 0,
    cumulativeCharges: 0,
    sessionTradeCount: 0,
    sessionPnl: 0,
    sessionDate: "2026-04-29",
    profitHistory: [],
    peakCapital: 100000,
    drawdownPercent: 0,
    peakUpdatedAt: 1700000000000,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

const baseEvent = (overrides?: Partial<BrokerOrderEvent>): BrokerOrderEvent => ({
  brokerId: "dhan",
  orderId: "BORD-1",
  status: "FILLED",
  filledQuantity: 75,
  averagePrice: 100,
  timestamp: 1700000000000,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: my-live has the trade; ai-live and testing-live are empty.
  getCapitalStateMock.mockImplementation(async (channel: any) =>
    channel === "my-live" ? makeState() : null,
  );
  getDayRecordMock.mockImplementation(async (channel: any) =>
    channel === "my-live" ? makeDay([makeTrade()]) : null,
  );
});

// ─── Cases ───────────────────────────────────────────────────────

describe("portfolioAgent.applyBrokerOrderEvent", () => {
  it("FILLED with slippage — adjusts entryPrice, leaves qty alone", async () => {
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ averagePrice: 100.5, filledQuantity: 75 }),
    );
    expect(result.matched).toBe(true);
    expect(result.tradeId).toBe("T-1");
    expect(result.channel).toBe("my-live");
    expect(result.newStatus).toBe("OPEN");

    const written = upsertDayRecordMock.mock.calls[0][1] as DayRecord;
    expect(written.trades[0].entryPrice).toBe(100.5);
    expect(written.trades[0].qty).toBe(75);
  });

  it("FILLED with partial qty — adjusts qty + promotes PENDING → OPEN", async () => {
    getDayRecordMock.mockImplementationOnce(async (channel: any) =>
      channel === "my-live"
        ? makeDay([makeTrade({ status: "PENDING", qty: 75 })])
        : null,
    );
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ filledQuantity: 50, averagePrice: 100 }),
    );
    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe("OPEN");

    const written = upsertDayRecordMock.mock.calls[0][1] as DayRecord;
    expect(written.trades[0].qty).toBe(50);
    expect(written.trades[0].status).toBe("OPEN");
  });

  it("CANCELLED — marks CANCELLED + zeros pnl + stamps closedAt", async () => {
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ status: "CANCELLED", filledQuantity: 0, averagePrice: 0 }),
    );
    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe("CANCELLED");

    const written = upsertDayRecordMock.mock.calls[0][1] as DayRecord;
    const t = written.trades[0];
    expect(t.status).toBe("CANCELLED");
    expect(t.exitPrice).toBe(t.entryPrice);
    expect(t.pnl).toBe(0);
    expect(t.unrealizedPnl).toBe(0);
    expect(t.closedAt).toBeGreaterThan(0);
  });

  it("REJECTED + EXPIRED — same CANCELLED handling as CANCELLED", async () => {
    for (const status of ["REJECTED", "EXPIRED"] as const) {
      vi.clearAllMocks();
      getCapitalStateMock.mockImplementation(async (c: any) =>
        c === "my-live" ? makeState() : null,
      );
      getDayRecordMock.mockImplementation(async (c: any) =>
        c === "my-live" ? makeDay([makeTrade()]) : null,
      );
      const result = await portfolioAgent.applyBrokerOrderEvent(
        baseEvent({ status }),
      );
      expect(result.matched).toBe(true);
      expect(result.newStatus).toBe("CANCELLED");
    }
  });

  it("intermediate statuses (PENDING, PARTIALLY_FILLED) are no-ops", async () => {
    for (const status of ["PENDING", "PARTIALLY_FILLED"] as const) {
      vi.clearAllMocks();
      getCapitalStateMock.mockImplementation(async (c: any) =>
        c === "my-live" ? makeState() : null,
      );
      getDayRecordMock.mockImplementation(async (c: any) =>
        c === "my-live" ? makeDay([makeTrade()]) : null,
      );
      const result = await portfolioAgent.applyBrokerOrderEvent(
        baseEvent({ status }),
      );
      expect(result.matched).toBe(false);
      expect(upsertDayRecordMock).not.toHaveBeenCalled();
    }
  });

  it("no-match — orderId not in any open trade returns matched=false", async () => {
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ orderId: "UNKNOWN-ORD" }),
    );
    expect(result.matched).toBe(false);
    expect(upsertDayRecordMock).not.toHaveBeenCalled();
  });

  it("brokerId disambiguation — event from a different broker is ignored even on orderId collision", async () => {
    // Trade was placed on "dhan"; event arrives from "dhan-ai-data" with
    // the same orderId. Pair-match must reject this.
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ brokerId: "dhan-ai-data", orderId: "BORD-1" }),
    );
    expect(result.matched).toBe(false);
    expect(upsertDayRecordMock).not.toHaveBeenCalled();
  });

  it("legacy trades with brokerId=null fall back to orderId-only match", async () => {
    getDayRecordMock.mockImplementationOnce(async (channel: any) =>
      channel === "my-live"
        ? makeDay([makeTrade({ brokerId: null })])
        : null,
    );
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ brokerId: "any-broker", orderId: "BORD-1" }),
    );
    expect(result.matched).toBe(true);
    expect(result.tradeId).toBe("T-1");
  });

  it("CLOSED / CANCELLED trades on the day are not re-touched", async () => {
    getDayRecordMock.mockImplementationOnce(async (channel: any) =>
      channel === "my-live"
        ? makeDay([makeTrade({ status: "CLOSED", brokerOrderId: "BORD-1" })])
        : null,
    );
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ status: "FILLED" }),
    );
    expect(result.matched).toBe(false);
    expect(upsertDayRecordMock).not.toHaveBeenCalled();
  });

  it("scans live channels — finds match on ai-live when my-live has no trade", async () => {
    getCapitalStateMock.mockImplementation(async (channel: any) =>
      channel === "my-live" || channel === "ai-live" ? makeState() : null,
    );
    getDayRecordMock.mockImplementation(async (channel: any) => {
      if (channel === "my-live") return makeDay([]);
      if (channel === "ai-live") return makeDay([makeTrade({ id: "T-AI", brokerId: "dhan-ai-data" })]);
      return null;
    });
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ brokerId: "dhan-ai-data" }),
    );
    expect(result.matched).toBe(true);
    expect(result.channel).toBe("ai-live");
    expect(result.tradeId).toBe("T-AI");
  });
});
