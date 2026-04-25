/**
 * Trade Executor Agent — unit tests.
 *
 * Targets the stable primitives in tradeExecutor.ts:
 *   - Idempotency: duplicate executionId replays cached response
 *   - submitTrade paper path: maps + persists + records
 *   - submitTrade rejection: broker REJECTED → no local trade + audit
 *   - exitTrade paper path: closes + audits + Discipline push
 *   - modifyOrder paper path: updates SL/TP via PA.updateTrade
 *   - Kill switch pre-flight: rejects without touching the broker
 *
 * Broker / PortfolioAgent dependencies are mocked so the suite runs
 * without MongoDB or live broker. Live-channel paths aren't exercised
 * here because the orderSync state machine isn't fully exercisable
 * without a real WS event source — that's deferred to integration tests
 * in Phase 2.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Mocks (must be declared before importing the SUT) ──────────

vi.mock("../broker/brokerService", () => ({
  getAdapter: vi.fn(),
  isChannelKillSwitchActive: vi.fn(() => false),
}));

vi.mock("./tradeResolution", () => ({
  resolveLotSize: vi.fn(async () => 75), // NIFTY default
}));

vi.mock("./settings", () => ({
  getExecutorSettings: vi.fn(async () => ({
    userId: "1",
    aiLiveLotCap: 1,
    rcaMaxAgeMs: 30 * 60 * 1000,
    rcaStaleTickMs: 5 * 60 * 1000,
    rcaVolThreshold: 0.7,
    recoveryStuckMs: 60_000,
    updatedAt: 0,
  })),
  updateExecutorSettings: vi.fn(),
}));

vi.mock("../broker/tickBus", () => ({
  tickBus: { emitTick: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock("../discipline", () => ({
  disciplineEngine: {
    validateTrade: vi.fn(async () => ({
      allowed: true,
      blockedBy: [],
      warnings: [],
      adjustments: [],
      details: {},
    })),
  },
}));

vi.mock("../portfolio", () => ({
  portfolioAgent: {
    getState: vi.fn(async () => ({
      currentCapital: 100000,
      openExposure: 0,
      tradingPool: 75000,
      reservePool: 25000,
    })),
    appendTrade: vi.fn(async (_channel: any, trade: any) => trade),
    closeTrade: vi.fn(async (_channel: any, _tradeId: any, exitPrice: number) => ({
      trade: {
        id: "T-CLOSED",
        instrument: "NIFTY_50",
        type: "CALL_BUY",
        entryPrice: 100,
        qty: 75,
        exitPrice,
        openedAt: 1700000000000,
        closedAt: 1700000060000,
      },
      day: {} as any,
      pnl: (exitPrice - 100) * 75,
      charges: 0,
    })),
    updateTrade: vi.fn(async (_channel: any, _tradeId: any, modifications: any) => ({
      trade: {
        id: "T-MOD",
        stopLossPrice: modifications.stopLossPrice ?? 90,
        targetPrice: modifications.targetPrice ?? 120,
      },
      day: {} as any,
      oldSL: 90,
      oldTP: 120,
    })),
    ensureCurrentDay: vi.fn(async () => ({
      // tradeIdFromPositionId("POS-1234") → "T1234". Mock trades match
      // that round-trip so positionId resolution finds them.
      trades: [
        {
          id: "T1234",
          instrument: "NIFTY_50",
          type: "CALL_BUY",
          entryPrice: 100,
          qty: 75,
          status: "OPEN",
          ltp: 105,
          brokerId: null,
          openedAt: 1700000000000,
        },
      ],
    })),
    recordTradePlaced: vi.fn(async () => undefined),
    recordTradeRejected: vi.fn(async () => undefined),
    recordTradeClosed: vi.fn(async () => undefined),
    onAutoExit: vi.fn(() => () => undefined),
  },
}));

// ─── SUT + helpers ──────────────────────────────────────────────

import { tradeExecutor } from "./tradeExecutor";
import { idempotencyStore } from "./idempotency";
import { getAdapter, isChannelKillSwitchActive } from "../broker/brokerService";
import { portfolioAgent } from "../portfolio";

function paperRequest(overrides: Partial<Parameters<typeof tradeExecutor.submitTrade>[0]> = {}) {
  return {
    executionId: `test-${Math.random().toString(36).slice(2)}`,
    channel: "my-paper" as const,
    origin: "USER" as const,
    instrument: "NIFTY_50",
    direction: "BUY" as const,
    quantity: 75,
    entryPrice: 100,
    stopLoss: 90,
    takeProfit: 120,
    orderType: "MARKET" as const,
    productType: "INTRADAY" as const,
    timestamp: Date.now(),
    ...overrides,
  };
}

const fillingAdapter = {
  brokerId: "mock-my",
  displayName: "Paper",
  placeOrder: vi.fn(async () => ({
    orderId: "ORD-MOCK-1",
    status: "FILLED" as const,
    timestamp: Date.now(),
  })),
  modifyOrder: vi.fn(async () => ({
    orderId: "ORD-MOCK-1",
    status: "FILLED" as const,
    timestamp: Date.now(),
  })),
};

const rejectingAdapter = {
  ...fillingAdapter,
  placeOrder: vi.fn(async () => ({
    orderId: "",
    status: "REJECTED" as const,
    message: "Insufficient margin",
    timestamp: Date.now(),
  })),
};

beforeEach(() => {
  idempotencyStore.reset();
  vi.clearAllMocks();
  (isChannelKillSwitchActive as any).mockReturnValue(false);
  (getAdapter as any).mockReturnValue(fillingAdapter);
});

// ─── Tests ──────────────────────────────────────────────────────

describe("submitTrade — paper path", () => {
  it("places the order, appends the trade, and records it as placed", async () => {
    const req = paperRequest();
    const resp = await tradeExecutor.submitTrade(req);

    expect(resp.success).toBe(true);
    expect(resp.status).toBe("FILLED");
    expect(resp.tradeId).toMatch(/^T\d/);
    expect(resp.positionId).toMatch(/^POS-/);
    expect(resp.orderId).toBe("ORD-MOCK-1");

    expect(fillingAdapter.placeOrder).toHaveBeenCalledTimes(1);
    expect(portfolioAgent.appendTrade).toHaveBeenCalledTimes(1);
    expect(portfolioAgent.recordTradePlaced).toHaveBeenCalledTimes(1);
  });

  it("replays the cached response on duplicate executionId (idempotency)", async () => {
    const req = paperRequest({ executionId: "dup-1" });
    const first = await tradeExecutor.submitTrade(req);
    const second = await tradeExecutor.submitTrade(req);

    expect(second.success).toBe(true);
    expect(second.tradeId).toBe(first.tradeId);
    expect(second.orderId).toBe(first.orderId);
    // Broker should NOT have been called twice.
    expect(fillingAdapter.placeOrder).toHaveBeenCalledTimes(1);
    expect(portfolioAgent.appendTrade).toHaveBeenCalledTimes(1);
  });

  it("rejects when broker returns REJECTED, with no local trade created", async () => {
    (getAdapter as any).mockReturnValue(rejectingAdapter);

    const resp = await tradeExecutor.submitTrade(paperRequest());

    expect(resp.success).toBe(false);
    expect(resp.status).toBe("REJECTED");
    expect(resp.error).toContain("Insufficient margin");

    expect(portfolioAgent.appendTrade).not.toHaveBeenCalled();
    expect(portfolioAgent.recordTradeRejected).toHaveBeenCalledTimes(1);
  });

  it("rejects pre-broker when the kill switch is armed", async () => {
    (isChannelKillSwitchActive as any).mockReturnValue(true);

    const resp = await tradeExecutor.submitTrade(paperRequest());

    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/kill switch/i);
    // Broker must not have been called at all.
    expect(fillingAdapter.placeOrder).not.toHaveBeenCalled();
    expect(portfolioAgent.recordTradeRejected).toHaveBeenCalledTimes(1);
  });
});

describe("ai-live 1-lot cap", () => {
  it("accepts a 1-lot order on ai-live", async () => {
    // 75 / 75 = 1 lot. Within cap.
    const resp = await tradeExecutor.submitTrade(
      paperRequest({ channel: "ai-live", origin: "AI", quantity: 75 }),
    );
    // Will fail later (live path requires real adapter mock), but should
    // pass the lot-cap check — error must NOT mention lot cap.
    if (!resp.success) {
      expect(resp.error).not.toMatch(/lot cap/i);
    }
  });

  it("rejects a 2-lot order on ai-live with a clear error", async () => {
    // 150 / 75 = 2 lots. Exceeds cap of 1.
    const resp = await tradeExecutor.submitTrade(
      paperRequest({ channel: "ai-live", origin: "AI", quantity: 150 }),
    );
    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/AI Live lot cap violated/);
    expect(fillingAdapter.placeOrder).not.toHaveBeenCalled();
    expect(portfolioAgent.recordTradeRejected).toHaveBeenCalledTimes(1);
  });

  it("does NOT apply the cap to ai-paper (paper has no lot cap)", async () => {
    const resp = await tradeExecutor.submitTrade(
      paperRequest({ channel: "ai-paper", origin: "AI", quantity: 1500 }),
    );
    // Goes through to broker (mock fills it).
    expect(resp.success).toBe(true);
  });
});

describe("exitTrade", () => {
  it("closes the trade via PA.closeTrade and records the outcome", async () => {
    const resp = await tradeExecutor.exitTrade({
      executionId: "exit-1",
      positionId: "POS-1234",
      channel: "my-paper",
      exitType: "MARKET",
      exitPrice: 110,
      reason: "MANUAL",
      triggeredBy: "USER",
      timestamp: Date.now(),
    });

    expect(resp.success).toBe(true);
    expect(resp.exitPrice).toBe(110);
    expect(resp.realizedPnl).toBe((110 - 100) * 75);

    expect(portfolioAgent.closeTrade).toHaveBeenCalledTimes(1);
    expect(portfolioAgent.recordTradeClosed).toHaveBeenCalledTimes(1);
  });

  it("falls back to trade.ltp when no exitPrice is provided", async () => {
    const resp = await tradeExecutor.exitTrade({
      executionId: "exit-2",
      positionId: "POS-1234",
      channel: "my-paper",
      exitType: "MARKET",
      reason: "MANUAL",
      triggeredBy: "USER",
      timestamp: Date.now(),
    });

    expect(resp.success).toBe(true);
    // Mocked open trade had ltp=105
    expect(resp.exitPrice).toBe(105);
  });
});

describe("modifyOrder", () => {
  it("paper channel — updates SL/TP via PA.updateTrade with no broker call", async () => {
    const resp = await tradeExecutor.modifyOrder({
      executionId: "mod-1",
      positionId: "POS-1234",
      channel: "my-paper",
      modifications: { stopLoss: 88, takeProfit: 125 },
      reason: "USER",
      timestamp: Date.now(),
    });

    expect(resp.success).toBe(true);
    expect(portfolioAgent.updateTrade).toHaveBeenCalledTimes(1);
    expect(fillingAdapter.modifyOrder).not.toHaveBeenCalled();
  });
});
