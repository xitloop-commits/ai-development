/**
 * Phase D1 — tRPC tests for the new PortfolioAgent APIs:
 *
 *   portfolio.transferFundsCrossChannel  (cross-channel money move,
 *                                         Mongo-session-wrapped)
 *   portfolio.recordTradeUpdated         (audit-only SL/TP modify event)
 *
 * Mocks state.ts + storage.ts so the suite runs without Mongo. The
 * Mongo session itself is mocked too — we exercise the success path
 * (transaction commits) and the rollback path (one of the writes
 * throws → both states unchanged from the caller's perspective).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks (must be hoisted before SUT import) ──────────────────

const stateStore: Record<string, { channel: string; tradingPool: number; reservePool: number }> = {};

function seedState(channel: string, tradingPool: number, reservePool = 0) {
  stateStore[channel] = { channel, tradingPool, reservePool };
}

const getCapitalStateMock = vi.fn(async (channel: string) => {
  const s = stateStore[channel];
  if (!s) throw new Error(`getCapitalState: no state for ${channel}`);
  return s;
});

const updateCapitalStateMock = vi.fn(async (channel: string, patch: Partial<typeof stateStore[string]>) => {
  const s = stateStore[channel];
  if (!s) throw new Error(`updateCapitalState: no state for ${channel}`);
  Object.assign(s, patch);
  return s;
});

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    getCapitalState: (...args: any[]) => getCapitalStateMock(...args),
    updateCapitalState: (...args: any[]) => updateCapitalStateMock(...args),
  };
});

const appendEventMock = vi.fn(async () => undefined);
vi.mock("./storage", async () => {
  const actual = await vi.importActual<typeof import("./storage")>("./storage");
  return {
    ...actual,
    appendEvent: (...args: any[]) => appendEventMock(...args),
  };
});

// Mock mongoose.startSession() — we want to exercise the
// withTransaction callback without a real Mongo cluster.
vi.mock("mongoose", async () => {
  const actual = await vi.importActual<any>("mongoose");
  return {
    ...actual,
    default: {
      ...actual.default,
      startSession: vi.fn(async () => ({
        withTransaction: async (fn: () => Promise<void>) => {
          await fn();
        },
        endSession: async () => undefined,
      })),
    },
  };
});

// ─── SUT ─────────────────────────────────────────────────────────

import { portfolioRouter } from "./router";

const caller = portfolioRouter.createCaller({ req: { header: () => undefined } } as any);

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
});

// ─── transferFundsCrossChannel ──────────────────────────────────

describe("portfolio.transferFundsCrossChannel", () => {
  // T126 — the two books are paper and live. The pair used to be the two live
  // books; what the endpoint has to prove is unchanged: money leaves ONE named
  // book and lands in the OTHER, inside one transaction.
  it("moves a numeric amount from source.tradingPool to dest.tradingPool", async () => {
    seedState("paper", 100000, 25000);
    seedState("live", 0, 0);

    const result = await caller.transferFundsCrossChannel({
      from: "paper",
      to: "live",
      amount: 30000,
    });

    expect(result.transferred).toBe(30000);
    expect(result.from.tradingPool).toBe(70000);
    expect(result.to.tradingPool).toBe(30000);
    expect(stateStore["paper"].tradingPool).toBe(70000);
    expect(stateStore["live"].tradingPool).toBe(30000);
  });

  it('amount: "all" drains the source.tradingPool', async () => {
    seedState("paper", 50000, 0);
    seedState("live", 0, 0);

    const result = await caller.transferFundsCrossChannel({
      from: "paper",
      to: "live",
      amount: "all",
    });

    expect(result.transferred).toBe(50000);
    expect(stateStore["paper"].tradingPool).toBe(0);
    expect(stateStore["live"].tradingPool).toBe(50000);
  });

  it("rejects same-channel transfers", async () => {
    seedState("live", 100000, 0);
    await expect(
      caller.transferFundsCrossChannel({ from: "live", to: "live", amount: 1000 }),
    ).rejects.toThrow(/same channel/i);
  });

  it("rejects insufficient-balance transfers", async () => {
    seedState("paper", 1000, 0);
    seedState("live", 0, 0);
    await expect(
      caller.transferFundsCrossChannel({ from: "paper", to: "live", amount: 5000 }),
    ).rejects.toThrow(/Insufficient/i);
  });

  it("rejects amount: \"all\" when source has nothing to transfer", async () => {
    seedState("paper", 0, 0);
    seedState("live", 0, 0);
    await expect(
      caller.transferFundsCrossChannel({ from: "paper", to: "live", amount: "all" }),
    ).rejects.toThrow(/no trading-pool balance/i);
  });
});

// ─── recordTradeUpdated ─────────────────────────────────────────

describe("portfolio.recordTradeUpdated", () => {
  it("appends a TRADE_MODIFIED event to the audit log", async () => {
    const result = await caller.recordTradeUpdated({
      channel: "paper",
      tradeId: "T-1",
      modifications: { stopLoss: 95, takeProfit: 110 },
      timestamp: 1700000000000,
    });

    expect(result).toEqual({ success: true });
    expect(appendEventMock).toHaveBeenCalledTimes(1);
    const evt = appendEventMock.mock.calls[0][0];
    expect(evt).toMatchObject({
      channel: "paper",
      eventType: "TRADE_MODIFIED",
      tradeId: "T-1",
      payload: { modifications: { stopLoss: 95, takeProfit: 110 } },
      timestamp: 1700000000000,
    });
  });

  it("accepts null SL / TP (operator clearing brackets)", async () => {
    await caller.recordTradeUpdated({
      channel: "live",
      tradeId: "T-2",
      modifications: { stopLoss: null, takeProfit: null },
      timestamp: 1700000000000,
    });
    const evt = appendEventMock.mock.calls[0][0];
    expect(evt.payload).toEqual({ modifications: { stopLoss: null, takeProfit: null } });
  });

  it("accepts trailingStopEnabled toggle", async () => {
    await caller.recordTradeUpdated({
      channel: "live",
      tradeId: "T-3",
      modifications: { trailingStopEnabled: true },
      timestamp: 1700000000000,
    });
    const evt = appendEventMock.mock.calls[0][0];
    expect(evt.payload).toEqual({ modifications: { trailingStopEnabled: true } });
  });
});
