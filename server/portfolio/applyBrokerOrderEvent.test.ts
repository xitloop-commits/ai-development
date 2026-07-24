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
    channel: "live",
  };
}

function makeState(): CapitalState {
  return {
    channel: "live",
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
  // Default: live has the trade; live and testing-live are empty.
  getCapitalStateMock.mockImplementation(async (channel: any) =>
    channel === "live" ? makeState() : null,
  );
  getDayRecordMock.mockImplementation(async (channel: any) =>
    channel === "live" ? makeDay([makeTrade()]) : null,
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
    expect(result.channel).toBe("live");
    expect(result.newStatus).toBe("OPEN");

    const written = upsertDayRecordMock.mock.calls[0][1] as DayRecord;
    expect(written.trades[0].entryPrice).toBe(100.5);
    expect(written.trades[0].qty).toBe(75);
  });

  it("Super Order SL leg fill (legNo 2) → closes parent via autoExitDetected SL_HIT", async () => {
    getDayRecordMock.mockImplementation(async (channel: any) =>
      channel === "live"
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
      expect.objectContaining({ channel: "live", tradeId: "T-1", reason: "SL_HIT", exitPrice: 98 }),
    );
    emitSpy.mockRestore();
  });

  it("Super Order TP leg fill (legNo 3) → closes parent via autoExitDetected TP_HIT", async () => {
    getDayRecordMock.mockImplementation(async (channel: any) =>
      channel === "live"
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
      channel === "live"
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
      c === "live" ? makeDay([makeTrade({ status: "PENDING", qty: 75 })]) : null,
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
      c === "live" ? makeDay([makeTrade({ status: "OPEN", qty: 75, entryPrice: 101 })]) : null,
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
      c === "live"
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
      "live",
      expect.objectContaining({ sessionPnl: expect.any(Number) }),
    );
  });

  it("external-order adoption — an unmatched primary-account fill opens a position in live", async () => {
    // No local trade anywhere; live is empty. An external BUY on the
    // primary account should be mirrored as a new OPEN long in live.
    getCapitalStateMock.mockImplementation(async (c: any) =>
      c === "live" ? { ...makeState(), channel: "live" } : null,
    );
    getDayRecordMock.mockImplementation(async (c: any) =>
      c === "live" ? { ...makeDay([]), channel: "live" } : null,
    );
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({
        orderId: "OBUY1",
        status: "FILLED",
        filledQuantity: 1,
        averagePrice: 353,
        brokerId: "dhan-primary-ac",
        securityId: "15355",
        symbol: "RECLTD",
        transactionType: "BUY",
        assetKind: "equity",
        productType: "INTRADAY",
      }),
    );
    expect(result.matched).toBe(true);
    expect(result.channel).toBe("live");

    const written = upsertDayRecordMock.mock.calls.at(-1)![1] as DayRecord;
    const t = written.trades.find((x) => x.id === "EXT-OBUY1");
    expect(t).toBeDefined();
    expect(t!.type).toBe("BUY"); // long
    expect(t!.status).toBe("OPEN");
    expect(t!.entryPrice).toBe(353);
    expect(t!.contractSecurityId).toBe("15355");
  });

  it("race guard — an app fill (TEA- tag) that beats its trade's persist is BUFFERED, then replayed to OPEN", async () => {
    // 1) The order fills within ms of placement — its order_alert arrives before
    //    submitTrade has written the trade. Nothing matches. It must be buffered,
    //    NOT adopted as an external EXT- position (the bug that stranded the real
    //    trade as PENDING + created a bogus duplicate).
    getCapitalStateMock.mockResolvedValue(null);
    getDayRecordMock.mockResolvedValue(null);
    const early = baseEvent({
      orderId: "APP-ORD-RACE",
      status: "FILLED",
      averagePrice: 120.7,
      filledQuantity: 65,
      brokerId: "dhan-primary-ac",
      securityId: "57344",
      symbol: "NIFTY-Jul2026-2",
      transactionType: "BUY",
      assetKind: "option",
      correlationId: "TEA-UI-race",
    });
    const buffered = await portfolioAgent.applyBrokerOrderEvent(early);
    expect(buffered.matched).toBe(false);
    expect(upsertDayRecordMock).not.toHaveBeenCalled(); // buffered, not adopted

    // 2) submitTrade persists the PENDING trade, then replays the buffered fill.
    const pending = makeTrade({
      id: "T-RACE",
      brokerOrderId: "APP-ORD-RACE",
      status: "PENDING",
      entryPrice: 122,
      qty: 65,
    });
    getCapitalStateMock.mockImplementation(async (c: any) => (c === "live" ? makeState() : null));
    getDayRecordMock.mockImplementation(async (c: any) => (c === "live" ? makeDay([pending]) : null));

    await portfolioAgent.replayBufferedFills("APP-ORD-RACE");

    const written = upsertDayRecordMock.mock.calls.at(-1)![1] as DayRecord;
    const t = written.trades.find((x) => x.id === "T-RACE")!;
    expect(t.status).toBe("OPEN"); // promoted PENDING → OPEN
    expect(t.entryPrice).toBe(120.7); // corrected to the real fill
    expect(written.trades.find((x) => x.id.startsWith("EXT-"))).toBeUndefined(); // no bogus duplicate
  });

  it("race guard (REJECTED) — a broker reject that beats persist is BUFFERED, then flips PENDING → REJECTED with reason", async () => {
    // The real miss: a margin/RMS reject returns within ms of placement — same
    // window as a fast fill — so it can beat the PENDING persist. Before this was
    // buffered the terminal event fell through and was DROPPED, stranding the
    // trade on PENDING forever with no reason tooltip.
    getCapitalStateMock.mockResolvedValue(null);
    getDayRecordMock.mockResolvedValue(null);
    const early = baseEvent({
      orderId: "APP-ORD-REJ",
      status: "REJECTED",
      reason: "RMS: Insufficient margin",
      brokerId: "dhan-primary-ac",
      correlationId: "TEA-UI-rej",
    });
    const buffered = await portfolioAgent.applyBrokerOrderEvent(early);
    expect(buffered.matched).toBe(false); // buffered, not dropped
    expect(upsertDayRecordMock).not.toHaveBeenCalled();

    // submitTrade persists the PENDING trade, then drains the buffer.
    const pending = makeTrade({
      id: "T-REJ",
      brokerOrderId: "APP-ORD-REJ",
      status: "PENDING",
    });
    getCapitalStateMock.mockImplementation(async (c: any) => (c === "live" ? makeState() : null));
    getDayRecordMock.mockImplementation(async (c: any) => (c === "live" ? makeDay([pending]) : null));

    await portfolioAgent.replayBufferedFills("APP-ORD-REJ");

    const written = upsertDayRecordMock.mock.calls.at(-1)![1] as DayRecord;
    const t = written.trades.find((x) => x.id === "T-REJ")!;
    expect(t.status).toBe("REJECTED"); // flipped off PENDING
    expect(t.rejectReason).toBe("RMS: Insufficient margin"); // reason for the tooltip
  });

  it("race guard (EXIT- tag) — an exit fill that beats the close is BUFFERED, then re-books the real price", async () => {
    // Reproduces the live miss on 2026-07-23. Dhan reported the exit FILLED at
    // 145.95 six milliseconds BEFORE exitTrade persisted the close, so no CLOSED
    // trade carried that exitBrokerOrderId yet and the event was dropped — the
    // trade kept 146.45, the LTP the close had assumed, overstating P&L by
    // Rs 32.50. The buffer only accepted "TEA-" (entries); exits fell through.
    getCapitalStateMock.mockResolvedValue(null);
    getDayRecordMock.mockResolvedValue(null);
    const earlyExit = baseEvent({
      orderId: "34226072318830",
      status: "FILLED",
      averagePrice: 145.95,
      filledQuantity: 65,
      brokerId: "dhan-primary-ac",
      securityId: "63937",
      transactionType: "SELL",
      assetKind: "option",
      correlationId: "EXIT-T-LIVE",
    });
    const buffered = await portfolioAgent.applyBrokerOrderEvent(earlyExit);
    expect(buffered.matched).toBe(false);
    expect(upsertDayRecordMock).not.toHaveBeenCalled(); // buffered, never adopted

    // The close lands a moment later, stamping exitBrokerOrderId, and exitTrade
    // drains the buffer.
    const closedTrade = makeTrade({
      id: "T-LIVE",
      status: "CLOSED",
      type: "CALL_BUY",
      entryPrice: 142.4,
      qty: 65,
      exitPrice: 146.45,     // what the app assumed (its own LTP)
      exitBrokerOrderId: "34226072318830",
      pnl: 194.16,
      charges: 69.09,
    });
    getCapitalStateMock.mockImplementation(async (c: any) => (c === "live" ? makeState() : null));
    getDayRecordMock.mockImplementation(async (c: any) => (c === "live" ? makeDay([closedTrade]) : null));

    await portfolioAgent.replayBufferedFills("34226072318830");

    // Re-booked at the broker's REAL fill, not the LTP.
    expect(closedTrade.exitPrice).toBe(145.95);
    // P&L was RECOMPUTED from the corrected price — not left at the stale value.
    // Asserted against the trade's own charges rather than a hardcoded rupee
    // figure, since charge rates are mocked here (live, this is 194.16 → 161.66,
    // the Rs 32.50 the book was overstating).
    expect(closedTrade.pnl).not.toBe(194.16);
    const expectedGross = (145.95 - 142.4) * 65;
    expect(closedTrade.pnl).toBeCloseTo(expectedGross - (closedTrade.charges ?? 0), 2);
  });

  it("external OPTION fill (no app tag) is NOT adopted — options need contract resolution (deferred to ③)", async () => {
    getCapitalStateMock.mockResolvedValue(null);
    getDayRecordMock.mockResolvedValue(null);
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({
        orderId: "EXT-OPT-1",
        status: "FILLED",
        averagePrice: 117.3,
        filledQuantity: 65,
        brokerId: "dhan-primary-ac",
        securityId: "57344",
        symbol: "NIFTY-Jul2026-2",
        transactionType: "SELL",
        assetKind: "option",
        correlationId: "NA",
      }),
    );
    expect(result.matched).toBe(false);
    expect(upsertDayRecordMock).not.toHaveBeenCalled(); // equity-only gate holds
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
      channel === "live"
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
      channel === "live"
        ? makeDay([makeTrade({ status: "CLOSED", brokerOrderId: "BORD-1" })])
        : null,
    );
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ status: "FILLED" }),
    );
    expect(result.matched).toBe(false);
    expect(upsertDayRecordMock).not.toHaveBeenCalled();
  });

  it("finds the trade on the live book, skipping paper", async () => {
    // T126 — this used to prove the scan reached the SECOND live book. With one
    // live book what still matters is that a broker event never matches a paper
    // trade: paper fills are simulated and have no broker order behind them.
    getCapitalStateMock.mockImplementation(async (channel: any) =>
      channel === "live" || channel === "paper" ? makeState() : null,
    );
    getDayRecordMock.mockImplementation(async (channel: any) => {
      if (channel === "paper") return makeDay([makeTrade({ id: "T-PAPER" })]);
      if (channel === "live") return makeDay([makeTrade({ id: "T-AI", brokerId: "dhan-primary-ac" })]);
      return null;
    });
    const result = await portfolioAgent.applyBrokerOrderEvent(
      baseEvent({ brokerId: "dhan-primary-ac" }),
    );
    expect(result.matched).toBe(true);
    expect(result.channel).toBe("live");
    expect(result.tradeId).toBe("T-AI");
  });
});

/**
 * Rolling the exit strategy on an OPEN trade — the desk's strategy pill.
 *
 * Exercises the REAL portfolioAgent.updateTrade (not a mirrored copy), because
 * the two interactions here decide whether a live position stays managed at all.
 */
describe("portfolioAgent.updateTrade — strategy roll", () => {
  beforeEach(() => {
    getCapitalStateMock.mockImplementation(async (c: any) => (c === "live" ? makeState() : null));
  });

  it("switching TO glide sets manualExitOnly, so the tick engine stops auto-exiting", async () => {
    const t = makeTrade({ id: "T-ROLL", status: "OPEN", exitStrategy: "sprint", manualExitOnly: false, cohort: "ma_signal" });
    getDayRecordMock.mockImplementation(async (c: any) => (c === "live" ? makeDay([t]) : null));

    const { trade } = await portfolioAgent.updateTrade("live", "T-ROLL", { exitStrategy: "glide" });
    expect(trade.exitStrategy).toBe("glide");
    expect(trade.manualExitOnly).toBe(true);
  });

  it("switching AWAY from glide clears manualExitOnly AND backfills the null levels", async () => {
    // A glide trade has no SL/TP. Handed to Sprint without levels, nothing would
    // ever close it — the failure this backfill exists to prevent.
    const t = makeTrade({
      id: "T-ROLL2", status: "OPEN", exitStrategy: "glide", manualExitOnly: true,
      entryPrice: 100, stopLossPrice: null, targetPrice: null, cohort: "ma_signal",
    });
    getDayRecordMock.mockImplementation(async (c: any) => (c === "live" ? makeDay([t]) : null));

    const { trade } = await portfolioAgent.updateTrade("live", "T-ROLL2", { exitStrategy: "sprint" });
    expect(trade.exitStrategy).toBe("sprint");
    expect(trade.manualExitOnly).toBe(false);
    expect(trade.stopLossPrice).not.toBeNull();
    expect(trade.targetPrice).not.toBeNull();
    // A BUY's stop sits BELOW entry and its target ABOVE.
    expect(trade.stopLossPrice!).toBeLessThan(100);
    expect(trade.targetPrice!).toBeGreaterThan(100);
  });

  it("does not overwrite levels that already exist", async () => {
    // Clobbering here would undo a deliberate manual widening.
    const t = makeTrade({
      id: "T-ROLL3", status: "OPEN", exitStrategy: "sprint",
      entryPrice: 100, stopLossPrice: 88, targetPrice: 130,
    });
    getDayRecordMock.mockImplementation(async (c: any) => (c === "live" ? makeDay([t]) : null));

    const { trade } = await portfolioAgent.updateTrade("live", "T-ROLL3", { exitStrategy: "runway" });
    expect(trade.stopLossPrice).toBe(88);
    expect(trade.targetPrice).toBe(130);
  });

  it("refuses to modify a CLOSED trade", async () => {
    const t = makeTrade({ id: "T-CLOSED", status: "CLOSED", exitStrategy: "sprint" });
    getDayRecordMock.mockImplementation(async (c: any) => (c === "live" ? makeDay([t]) : null));
    await expect(
      portfolioAgent.updateTrade("live", "T-CLOSED", { exitStrategy: "glide" }),
    ).rejects.toThrow(/closed/i);
  });
});
