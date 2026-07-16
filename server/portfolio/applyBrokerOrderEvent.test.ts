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
 * a trade on dhan-secondary-ac is not touched by an event from dhan-primary-ac
 * even if the orderIds happen to collide.
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
const updateCapitalStateMock = vi.fn(async () => undefined);

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    getCapitalState: (...args: any[]) => getCapitalStateMock(...args),
    getDayRecord: (...args: any[]) => getDayRecordMock(...args),
    upsertDayRecord: (...args: any[]) => upsertDayRecordMock(...args),
    updateCapitalState: (...args: any[]) => updateCapitalStateMock(...args),
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
import { tickHandler } from "./tickHandler";

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
    brokerId: "dhan-primary-ac",
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
  brokerId: "dhan-primary-ac",
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

  it("Super Order SL leg fill (legNo 2) → closes parent via autoExitDetected SL_HIT", async () => {
    getDayRecordMock.mockImplementation(async (channel: any) =>
      channel === "my-live"
        ? makeDay([makeTrade({ superOrderId: "SUP-1", stopLossPrice: 98 })])
        : null,
    );
    const emitSpy = vi.spyOn(tickHandler, "emit");
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ orderId: "LEG-SL", legNo: 2, entryOrderId: "SUP-1", averagePrice: 98 }),
    );
    expect(result.matched).toBe(true);
    expect(result.tradeId).toBe("T-1");
    expect(emitSpy).toHaveBeenCalledWith(
      "autoExitDetected",
      expect.objectContaining({ channel: "my-live", tradeId: "T-1", reason: "SL_HIT", exitPrice: 98 }),
    );
    emitSpy.mockRestore();
  });

  it("Super Order TP leg fill (legNo 3) → closes parent via autoExitDetected TP_HIT", async () => {
    getDayRecordMock.mockImplementation(async (channel: any) =>
      channel === "my-live"
        ? makeDay([makeTrade({ superOrderId: "SUP-1", targetPrice: 105 })])
        : null,
    );
    const emitSpy = vi.spyOn(tickHandler, "emit");
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ orderId: "LEG-TP", legNo: 3, entryOrderId: "SUP-1", averagePrice: 105 }),
    );
    expect(result.matched).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith(
      "autoExitDetected",
      expect.objectContaining({ reason: "TP_HIT", exitPrice: 105 }),
    );
    emitSpy.mockRestore();
  });

  it("Super Order leg fill with no matching superOrderId → no match, no emit", async () => {
    const emitSpy = vi.spyOn(tickHandler, "emit");
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ orderId: "LEG-X", legNo: 2, entryOrderId: "SUP-UNKNOWN", averagePrice: 98 }),
    );
    expect(result.matched).toBe(false);
    expect(emitSpy).not.toHaveBeenCalledWith("autoExitDetected", expect.anything());
    emitSpy.mockRestore();
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

  it("EXPIRED (nothing filled) — same CANCELLED handling as CANCELLED", async () => {
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ status: "EXPIRED", filledQuantity: 0 }),
    );
    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe("CANCELLED");
  });

  it("REJECTED — marks REJECTED (distinct from CANCELLED) + captures reason", async () => {
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ status: "REJECTED", reason: "Invalid IP" }),
    );
    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe("REJECTED");

    const written = upsertDayRecordMock.mock.calls[0][1] as DayRecord;
    const t = written.trades[0];
    expect(t.status).toBe("REJECTED");
    expect(t.rejectReason).toBe("Invalid IP");
    expect(t.pnl).toBe(0);
    expect(t.closedAt).toBeGreaterThan(0);
  });

  it("intermediate status PENDING is a no-op", async () => {
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ status: "PENDING" }),
    );
    expect(result.matched).toBe(false);
    expect(upsertDayRecordMock).not.toHaveBeenCalled();
  });

  it("PARTIALLY_FILLED — promotes PENDING → OPEN, sets filled qty + avg price", async () => {
    getDayRecordMock.mockImplementation(async (c: any) =>
      c === "my-live" ? makeDay([makeTrade({ status: "PENDING", qty: 75 })]) : null,
    );
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ status: "PARTIALLY_FILLED", filledQuantity: 50, averagePrice: 101 }),
    );
    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe("OPEN");

    const t = (upsertDayRecordMock.mock.calls[0][1] as DayRecord).trades[0];
    expect(t.status).toBe("OPEN");
    expect(t.qty).toBe(50); // only the filled portion so far
    expect(t.entryPrice).toBe(101); // running avg
  });

  it("CANCELLED after a partial fill — keeps the filled position open, not cancelled", async () => {
    getDayRecordMock.mockImplementation(async (c: any) =>
      c === "my-live" ? makeDay([makeTrade({ status: "OPEN", qty: 75, entryPrice: 101 })]) : null,
    );
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ status: "CANCELLED", filledQuantity: 50, averagePrice: 101 }),
    );
    expect(result.matched).toBe(true);

    const t = (upsertDayRecordMock.mock.calls[0][1] as DayRecord).trades[0];
    expect(t.status).toBe("OPEN"); // NOT cancelled — the filled 50 is a real position
    expect(t.qty).toBe(50); // only the filled remainder
    expect(t.closedAt).toBeNull();
  });

  it("exit-fill correction (B1) — restates a CLOSED trade's exit price + P&L via exitBrokerOrderId", async () => {
    getDayRecordMock.mockImplementation(async (c: any) =>
      c === "my-live"
        ? makeDay([
            makeTrade({
              status: "CLOSED",
              entryPrice: 100,
              qty: 75,
              exitPrice: 105, // optimistic close
              pnl: 375, // (105-100)*75, no charges (empty option rates)
              charges: 0,
              brokerOrderId: "ENTRY-9",
              exitBrokerOrderId: "EXIT-9",
              closedAt: 1700000000000,
            }),
          ])
        : null,
    );
    // The reverse (exit) order's fill — different orderId, real avg 104.
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ orderId: "EXIT-9", status: "FILLED", averagePrice: 104, filledQuantity: 75 }),
    );
    expect(result.matched).toBe(true);

    const t = (upsertDayRecordMock.mock.calls.at(-1)![1] as DayRecord).trades[0];
    expect(t.exitPrice).toBe(104); // corrected to the real fill
    expect(t.pnl).toBe(300); // (104-100)*75, recomputed
    // Capital was adjusted by the delta only (375 → 300 = -75).
    expect(updateCapitalStateMock).toHaveBeenCalledWith(
      "my-live",
      expect.objectContaining({ sessionPnl: expect.any(Number) }),
    );
  });

  it("no-match — orderId not in any open trade returns matched=false", async () => {
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ orderId: "UNKNOWN-ORD" }),
    );
    expect(result.matched).toBe(false);
    expect(upsertDayRecordMock).not.toHaveBeenCalled();
  });

  it("brokerId disambiguation — event from a different broker is ignored even on orderId collision", async () => {
    // Trade was placed on "dhan-primary-ac"; event arrives from "dhan-secondary-ac" with
    // the same orderId. Pair-match must reject this.
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ brokerId: "dhan-secondary-ac", orderId: "BORD-1" }),
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
      if (channel === "ai-live") return makeDay([makeTrade({ id: "T-AI", brokerId: "dhan-secondary-ac" })]);
      return null;
    });
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ brokerId: "dhan-secondary-ac" }),
    );
    expect(result.matched).toBe(true);
    expect(result.channel).toBe("ai-live");
    expect(result.tradeId).toBe("T-AI");
  });
});
