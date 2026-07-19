/**
 * G6 — portfolioAgent.refreshDrawdown peak tracking.
 *
 * The function is the live high-water-mark detector PA runs after every
 * trade close. It must:
 *
 *   1. Advance peakCapital + reset drawdown to 0 on a new high.
 *   2. Compute drawdownPercent from peak when currentCapital <  peak.
 *   3. Seed peak from initialFunding when peakCapital is missing — without
 *      this, the very first closeTrade reports a phantom 100% drawdown.
 *   4. No-op when currentCapital <= 0 (mid-boot transient).
 *
 * Other portfolioAgent surfaces (placeTrade / closeTrade / etc.) already
 * have coverage in `applyBrokerOrderEvent.test.ts`, `e2e.test.ts`, and
 * `sync.test.ts`. This file fills the refreshDrawdown gap specifically.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getCapitalStateMock = vi.fn();
const updateCapitalStateMock = vi.fn(async () => undefined);
const getDayRecordMock = vi.fn(async () => null as any);
const getOpenPositionsMock = vi.fn(async () => [] as any[]);

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    getCapitalState: (...args: any[]) => getCapitalStateMock(...args),
    updateCapitalState: (...args: any[]) => updateCapitalStateMock(...args),
    getDayRecord: (...args: any[]) => getDayRecordMock(...args),
  };
});

vi.mock("./storage", () => ({
  appendEvent: vi.fn(async () => undefined),
  upsertPosition: vi.fn(async () => undefined),
  getOpenPositions: (...args: any[]) => getOpenPositionsMock(...args),
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
  getUserSettings: vi.fn(async () => ({})),
}));

import { portfolioAgent } from "./portfolioAgent";

function callRefresh(channel: string): Promise<void> {
  return (portfolioAgent as any).refreshDrawdown(channel);
}

describe("portfolioAgent.refreshDrawdown — peak tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("advances peakCapital + zeros drawdown on a new high", async () => {
    getCapitalStateMock.mockResolvedValue({
      tradingPool: 110_000,
      reservePool: 0,
      initialFunding: 100_000,
      peakCapital: 100_000,
      drawdownPercent: 0,
    });

    await callRefresh("ai-paper");

    expect(updateCapitalStateMock).toHaveBeenCalledWith(
      "ai-paper",
      expect.objectContaining({
        peakCapital: 110_000,
        drawdownPercent: 0,
        peakUpdatedAt: expect.any(Number),
      }),
    );
  });

  it("computes drawdown from peak when currentCapital is below peak", async () => {
    getCapitalStateMock.mockResolvedValue({
      tradingPool: 90_000,
      reservePool: 0,
      initialFunding: 100_000,
      peakCapital: 110_000, // we were here once
      drawdownPercent: 0,
    });

    await callRefresh("ai-paper");

    expect(updateCapitalStateMock).toHaveBeenCalledWith(
      "ai-paper",
      expect.objectContaining({
        peakCapital: 110_000, // unchanged
        drawdownPercent: 18.18, // (110k - 90k) / 110k * 100, rounded 2dp
      }),
    );
    // peakUpdatedAt is NOT set on a non-new-high path.
    expect(updateCapitalStateMock.mock.calls[0][1]).not.toHaveProperty(
      "peakUpdatedAt",
    );
  });

  it("seeds peakCapital from initialFunding when peak is missing (first close)", async () => {
    getCapitalStateMock.mockResolvedValue({
      tradingPool: 95_000,
      reservePool: 0,
      initialFunding: 100_000,
      peakCapital: undefined,
    });

    await callRefresh("ai-paper");

    expect(updateCapitalStateMock).toHaveBeenCalledWith(
      "ai-paper",
      expect.objectContaining({
        peakCapital: 100_000, // seeded from initialFunding
        drawdownPercent: 5, // (100k - 95k) / 100k * 100
      }),
    );
  });

  it("no-ops when currentCapital is 0 (mid-boot transient)", async () => {
    getCapitalStateMock.mockResolvedValue({
      tradingPool: 0,
      reservePool: 0,
      initialFunding: 100_000,
      peakCapital: 100_000,
    });

    await callRefresh("ai-paper");

    expect(updateCapitalStateMock).not.toHaveBeenCalled();
  });

  it("treats trading + reserve pools as the combined high-water signal", async () => {
    // Reserve covers the gap that a low tradingPool alone would imply.
    getCapitalStateMock.mockResolvedValue({
      tradingPool: 50_000,
      reservePool: 80_000, // combined 130k, a new high
      initialFunding: 100_000,
      peakCapital: 110_000,
    });

    await callRefresh("ai-paper");

    expect(updateCapitalStateMock).toHaveBeenCalledWith(
      "ai-paper",
      expect.objectContaining({
        peakCapital: 130_000,
        drawdownPercent: 0,
      }),
    );
  });

  it("rounds drawdownPercent to 2 decimal places (no infinite-precision floats)", async () => {
    getCapitalStateMock.mockResolvedValue({
      tradingPool: 99_999, // tiny drawdown
      reservePool: 0,
      initialFunding: 100_000,
      peakCapital: 100_000,
    });

    await callRefresh("ai-paper");

    const call = updateCapitalStateMock.mock.calls[0][1];
    // 0.001% drawdown rounds to 0 at 2dp; precision matches the
    // function's `Math.round(... * 100) / 100` policy.
    expect(call.drawdownPercent).toBe(0);
  });

  it("hits the new-high branch exactly at peak === currentCapital", async () => {
    getCapitalStateMock.mockResolvedValue({
      tradingPool: 100_000,
      reservePool: 0,
      initialFunding: 100_000,
      peakCapital: 100_000,
    });

    await callRefresh("ai-paper");

    expect(updateCapitalStateMock).toHaveBeenCalledWith(
      "ai-paper",
      expect.objectContaining({
        peakCapital: 100_000,
        drawdownPercent: 0,
        peakUpdatedAt: expect.any(Number),
      }),
    );
  });
});

/**
 * T86 ③ — getPositions overlays live fields from day_records.
 *
 * position_state freezes ltp/unrealizedPnl at entry (only rewritten on
 * open/close). getPositions must overlay the live per-tick values from
 * day_records so RCA / carry-forward / the UI see the current price, not the
 * stale entry price. Also surfaces lastTickAt (the mirror mapper drops it).
 */
describe("portfolioAgent.getPositions — live-field overlay (T86 ③)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A frozen-at-entry position_state doc (ltp === entryPrice, unrealizedPnl 0).
  function stalePosition(over: any = {}) {
    return {
      positionId: "POS-1",
      tradeId: "T1",
      channel: "paper",
      dayIndex: 3,
      instrument: "BANKNIFTY",
      type: "CALL_BUY",
      entryPrice: 100,
      exitPrice: null,
      ltp: 100,            // frozen at entry
      qty: 15,
      status: "OPEN",
      unrealizedPnl: 0,    // frozen at entry
      lastTickAt: null,    // never mapped by positionDocToTradeRecord
      peakLtp: null,
      stopLossPrice: 95,
      targetPrice: 110,
      openedAt: 1_000,
      closedAt: null,
      ...over,
    };
  }

  it("replaces the frozen ltp/unrealizedPnl with the live day-record values", async () => {
    getOpenPositionsMock.mockResolvedValue([stalePosition()]);
    getDayRecordMock.mockResolvedValue({
      dayIndex: 3,
      trades: [
        // The live twin: price moved to 130, unrealizedPnl (130-100)*15 = 450.
        { id: "T1", ltp: 130, unrealizedPnl: 450, lastTickAt: 9_999, peakLtp: 132, stopLossPrice: 128, targetPrice: 140, status: "OPEN" },
      ],
    } as any);

    const [pos] = await portfolioAgent.getPositions("paper" as any);

    expect(pos.ltp).toBe(130);            // live, not the frozen 100
    expect(pos.unrealizedPnl).toBe(450);  // live, not the frozen 0
    expect(pos.lastTickAt).toBe(9_999);   // surfaced (mirror had dropped it)
    expect(pos.peakLtp).toBe(132);
    expect(pos.stopLossPrice).toBe(128);  // trailed
    expect(pos.targetPrice).toBe(140);    // ratcheted
    // day_records read exactly once for the single distinct dayIndex.
    expect(getDayRecordMock).toHaveBeenCalledTimes(1);
    expect(getDayRecordMock).toHaveBeenCalledWith("paper", 3);
  });

  it("keeps the mirror's own values when there is no day-record twin", async () => {
    getOpenPositionsMock.mockResolvedValue([stalePosition()]);
    getDayRecordMock.mockResolvedValue({ dayIndex: 3, trades: [] } as any); // twin missing

    const [pos] = await portfolioAgent.getPositions("paper" as any);

    expect(pos.ltp).toBe(100);           // untouched
    expect(pos.unrealizedPnl).toBe(0);   // untouched
  });

  it("does not read day_records when there are no open positions", async () => {
    getOpenPositionsMock.mockResolvedValue([]);

    const out = await portfolioAgent.getPositions("paper" as any);

    expect(out).toEqual([]);
    expect(getDayRecordMock).not.toHaveBeenCalled();
  });

  it("fetches each distinct day once for cross-day orphans", async () => {
    getOpenPositionsMock.mockResolvedValue([
      stalePosition({ positionId: "POS-1", tradeId: "T1", dayIndex: 3 }),
      stalePosition({ positionId: "POS-2", tradeId: "T2", dayIndex: 5 }),
    ]);
    getDayRecordMock.mockImplementation(async (_ch: string, di: number) => ({
      dayIndex: di,
      trades: [{ id: di === 3 ? "T1" : "T2", ltp: 200, unrealizedPnl: 1, status: "OPEN" }],
    }));

    const positions = await portfolioAgent.getPositions("paper" as any);

    expect(positions.map((p) => p.ltp)).toEqual([200, 200]);
    expect(getDayRecordMock).toHaveBeenCalledTimes(2); // one per distinct dayIndex
  });
});
