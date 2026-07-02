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
  // Used by ensureOptionLtpSubscription for paper channels. Returning undefined
  // makes the LTP subscription a safe no-op in unit tests (no live WS feed).
  getActiveBroker: vi.fn(() => undefined),
}));

vi.mock("./tradeResolution", () => ({
  resolveLotSize: vi.fn(async () => 75), // NIFTY default
}));

// Scrip master is not loaded in unit tests — mock the authoritative record
// lookup. "55123" is a valid NIFTY CE (lot 75); any other id is unknown.
vi.mock("../broker/adapters/dhan/scripMaster", () => ({
  getScripBySecurityId: vi.fn((id: string) =>
    id === "55123"
      ? { securityId: "55123", optionType: "CE", expiryDateOnly: "2026-06-25", lotSize: 75 }
      : undefined,
  ),
}));

vi.mock("./settings", () => ({
  getExecutorSettings: vi.fn(async () => ({
    userId: "1",
    aiLiveLotCap: 1,
    rcaMaxAgeMs: 30 * 60 * 1000,
    rcaStaleTickMs: 5 * 60 * 1000,
    rcaVolThreshold: 0.7,
    updatedAt: 0,
  })),
  updateExecutorSettings: vi.fn(),
}));

vi.mock("../broker/tickBus", () => ({
  tickBus: { emitTick: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock("../discipline", () => ({
  disciplineAgent: {
    validateTrade: vi.fn(async () => ({
      allowed: true,
      blockedBy: [],
      blockReasons: [],
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
    // Used by resubscribeOpenTradeLtps — default empty; tests override.
    listOpenTrades: vi.fn(async () => [] as any[]),
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
    markTradeDesync: vi.fn(async () => ({ trade: {} as any, day: {} as any })),
    clearTradeDesync: vi.fn(async () => ({ trade: {} as any, day: {} as any })),
    hasUnresolvedDesync: vi.fn(async () => false),
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

  it("persists trailingStopEnabled from the request's trailingStopLoss.enabled", async () => {
    // Regression: the new-trade form's TSL toggle reaches submitTrade as
    // trailingStopLoss.enabled and must land on the trade record. Previously
    // the placeTrade adapter dropped it, so trailing-stop was always off.
    const req = paperRequest({ trailingStopLoss: { enabled: true, distance: 0, trigger: 0 } });
    await tradeExecutor.submitTrade(req);

    expect(portfolioAgent.appendTrade).toHaveBeenCalledWith(
      "my-paper",
      expect.objectContaining({ trailingStopEnabled: true }),
    );
  });

  it("defaults trailingStopEnabled to false when no TSL is supplied", async () => {
    await tradeExecutor.submitTrade(paperRequest());
    expect(portfolioAgent.appendTrade).toHaveBeenCalledWith(
      "my-paper",
      expect.objectContaining({ trailingStopEnabled: false }),
    );
  });

  it("sends the resolved contractSecurityId to the broker, not the underlying name", async () => {
    // Regression: an option order resolves a numeric contract securityId upstream
    // (router resolveContract). mapToOrderParams must forward THAT id to the
    // broker — sending the display name "NIFTY 50" makes the adapter's scrip
    // lookup miss and the order get rejected.
    const req = paperRequest({
      instrument: "NIFTY 50",
      optionType: "CE",
      strike: 23550,
      expiry: "2026-06-25",
      contractSecurityId: "55123",
    });
    await tradeExecutor.submitTrade(req);

    expect(fillingAdapter.placeOrder).toHaveBeenCalledTimes(1);
    const orderParams = (fillingAdapter.placeOrder as any).mock.calls[0][0];
    expect(orderParams.instrument).toBe("55123");
  });

  it("rejects an option whose securityId is not in the scrip master (no fallback)", async () => {
    const req = paperRequest({
      instrument: "NIFTY 50",
      optionType: "CE",
      strike: 23550,
      expiry: "2026-06-25",
      contractSecurityId: "99999", // unknown to the scrip master mock
    });
    const resp = await tradeExecutor.submitTrade(req);

    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/not in the scrip master/i);
    expect(fillingAdapter.placeOrder).not.toHaveBeenCalled();
  });

  it("rejects an option whose quantity is not a whole lot multiple", async () => {
    const req = paperRequest({
      instrument: "NIFTY 50",
      optionType: "CE",
      strike: 23550,
      expiry: "2026-06-25",
      contractSecurityId: "55123",
      quantity: 65, // 65 is not a multiple of the scrip-master lot size 75
    });
    const resp = await tradeExecutor.submitTrade(req);

    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/not a whole multiple of the lot size 75/i);
    expect(fillingAdapter.placeOrder).not.toHaveBeenCalled();
  });

  it("falls back to the instrument name when no contractSecurityId is present", async () => {
    const req = paperRequest({ instrument: "NIFTY_50" }); // no contractSecurityId
    await tradeExecutor.submitTrade(req);

    const orderParams = (fillingAdapter.placeOrder as any).mock.calls[0][0];
    expect(orderParams.instrument).toBe("NIFTY_50");
  });

  it("rejects an option with no contractSecurityId before hitting the broker (universal guard)", async () => {
    // Applies to every channel/broker — an option leg without a resolved
    // contract must never reach placeOrder (paper would fake-fill junk; live
    // would reject vaguely; P&L tracking would break).
    const req = paperRequest({
      instrument: "NIFTY 50",
      optionType: "CE",
      strike: 23550,
      expiry: "2026-06-25",
      // contractSecurityId intentionally omitted
    });
    const resp = await tradeExecutor.submitTrade(req);

    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/no resolved contract securityId/i);
    expect(fillingAdapter.placeOrder).not.toHaveBeenCalled();
    expect(portfolioAgent.appendTrade).not.toHaveBeenCalled();
    expect(portfolioAgent.recordTradeRejected).toHaveBeenCalledTimes(1);
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

  it("accepts a 1-lot order on ai-paper", async () => {
    const resp = await tradeExecutor.submitTrade(
      paperRequest({ channel: "ai-paper", origin: "AI", quantity: 75 }),
    );
    if (!resp.success) {
      expect(resp.error).not.toMatch(/lot cap/i);
    }
  });

  it("does NOT cap ai-paper — it honours the configured instrumentSizing (paper validation, no real money)", async () => {
    // 150 / 75 = 2 lots. On ai-paper the AI lot cap is intentionally NOT enforced
    // so trades size per the configured instrumentSizing; the 1-lot canary cap is
    // real-money protection for ai-live only.
    const resp = await tradeExecutor.submitTrade(
      paperRequest({ channel: "ai-paper", origin: "AI", quantity: 150 }),
    );
    if (!resp.success) {
      expect(resp.error).not.toMatch(/lot cap/i);
    }
  });

  it("does NOT apply the cap to my-paper / my-live (manual orders are operator-supervised)", async () => {
    const resp = await tradeExecutor.submitTrade(
      paperRequest({ channel: "my-paper", origin: "USER", quantity: 1500 }),
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

  it("accepts the UI alias field names (stopLossPrice/targetPrice) and applies them", async () => {
    // Regression: the UI updateTrade adapter sends stopLossPrice/targetPrice,
    // but the local-update path used to read only stopLoss/takeProfit — so
    // editing SL/TP on an open trade silently did nothing. modifyOrder must
    // coalesce both spellings before calling PA.updateTrade.
    const resp = await tradeExecutor.modifyOrder({
      executionId: "mod-alias-1",
      positionId: "POS-1234",
      channel: "my-paper",
      modifications: { stopLossPrice: 88, targetPrice: 125, trailingStopLoss: { enabled: true, distance: 0, trigger: 0 } },
      reason: "USER",
      timestamp: Date.now(),
    });

    expect(resp.success).toBe(true);
    expect(portfolioAgent.updateTrade).toHaveBeenCalledWith(
      "my-paper",
      "T1234",
      expect.objectContaining({ stopLossPrice: 88, targetPrice: 125, trailingStopEnabled: true }),
    );
  });
});

// ─── B4: BROKER_DESYNC behaviour ────────────────────────────────

describe("B4 — BROKER_DESYNC handling", () => {
  // Live-channel paths require the trade to have a brokerOrderId.
  // Override ensureCurrentDay to return that shape just for these tests.
  beforeEach(() => {
    (portfolioAgent.ensureCurrentDay as any).mockResolvedValue({
      trades: [
        {
          id: "T1234",
          instrument: "NIFTY_50",
          type: "CALL_BUY",
          entryPrice: 100,
          qty: 75,
          status: "OPEN",
          ltp: 105,
          brokerOrderId: "BROKER-ORD-1",
          brokerId: "dhan-primary-ac",
          // A live option position carries its resolved contract id; the exit
          // reverses on this securityId, not the underlying name.
          contractSecurityId: "55123",
          openedAt: 1700000000000,
        },
      ],
    });
  });

  it("exitTrade — broker placeOrder failure marks BROKER_DESYNC and does NOT close locally", async () => {
    const failingAdapter = {
      ...fillingAdapter,
      placeOrder: vi.fn(async () => {
        throw new Error("Dhan timeout");
      }),
    };
    (getAdapter as any).mockReturnValue(failingAdapter);

    const resp = await tradeExecutor.exitTrade({
      executionId: "exit-fail-1",
      positionId: "POS-1234",
      channel: "my-live",
      exitType: "MARKET",
      reason: "MANUAL",
      triggeredBy: "USER",
      timestamp: Date.now(),
    });

    // Outer catch composes the failure response.
    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/BROKER_DESYNC/);

    // Trade is flagged desync with kind=EXIT.
    expect(portfolioAgent.markTradeDesync).toHaveBeenCalledTimes(1);
    expect((portfolioAgent.markTradeDesync as any).mock.calls[0][2]).toMatchObject({
      kind: "EXIT",
      reason: "Dhan timeout",
    });

    // The position is NOT closed locally — closeTrade must not have been called.
    expect(portfolioAgent.closeTrade).not.toHaveBeenCalled();
  });

  it("exitTrade — live option with no contractSecurityId fails to DESYNC, never hits the broker", async () => {
    // A live option leg can only be exited by its numeric contract id. If it's
    // missing we must NOT place a reverse order with the underlying name (it
    // never resolves) and must NOT close locally — flag for reconciliation.
    (portfolioAgent.ensureCurrentDay as any).mockResolvedValue({
      trades: [
        {
          id: "T1234",
          instrument: "NIFTY 50",
          type: "CALL_BUY",
          entryPrice: 100,
          qty: 75,
          status: "OPEN",
          ltp: 105,
          brokerOrderId: "BROKER-ORD-1",
          brokerId: "dhan-primary-ac",
          // contractSecurityId intentionally absent
          openedAt: 1700000000000,
        },
      ],
    });
    (getAdapter as any).mockReturnValue(fillingAdapter);

    const resp = await tradeExecutor.exitTrade({
      executionId: "exit-nocsid-1",
      positionId: "POS-1234",
      channel: "my-live",
      exitType: "MARKET",
      reason: "MANUAL",
      triggeredBy: "USER",
      timestamp: Date.now(),
    });

    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/BROKER_DESYNC/);
    expect(portfolioAgent.markTradeDesync).toHaveBeenCalledTimes(1);
    expect((portfolioAgent.markTradeDesync as any).mock.calls[0][2]).toMatchObject({
      kind: "EXIT",
    });
    expect((portfolioAgent.markTradeDesync as any).mock.calls[0][2].reason).toMatch(
      /no contractSecurityId/i,
    );
    // Never reached the broker; never closed locally.
    expect(fillingAdapter.placeOrder).not.toHaveBeenCalled();
    expect(portfolioAgent.closeTrade).not.toHaveBeenCalled();
  });

  it("modifyOrder — broker modifyOrder failure marks BROKER_DESYNC and does NOT update local SL/TP", async () => {
    const failingAdapter = {
      ...fillingAdapter,
      modifyOrder: vi.fn(async () => {
        throw new Error("Dhan rejected SL price");
      }),
    };
    (getAdapter as any).mockReturnValue(failingAdapter);

    const resp = await tradeExecutor.modifyOrder({
      executionId: "mod-fail-1",
      positionId: "POS-1234",
      channel: "my-live",
      modifications: { stopLossPrice: 92, targetPrice: 130 },
      reason: "USER",
      timestamp: Date.now(),
    });

    // Outer catch composes the failure response.
    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/BROKER_DESYNC/);

    // Trade is flagged desync with kind=MODIFY + the attempted SL/TP recorded.
    expect(portfolioAgent.markTradeDesync).toHaveBeenCalledTimes(1);
    const desyncCall = (portfolioAgent.markTradeDesync as any).mock.calls[0][2];
    expect(desyncCall.kind).toBe("MODIFY");
    expect(desyncCall.attempted).toEqual({ stopLossPrice: 92, targetPrice: 130 });

    // Local SL/TP MUST NOT be updated when broker is out of sync.
    expect(portfolioAgent.updateTrade).not.toHaveBeenCalled();
  });

  it("modifyOrder — paper-channel broker error does NOT desync (no broker call to fail)", async () => {
    // Paper channels don't call broker.modifyOrder. Confirm the desync
    // branch is gated by isLiveChannel.
    const resp = await tradeExecutor.modifyOrder({
      executionId: "mod-paper-1",
      positionId: "POS-1234",
      channel: "my-paper",
      modifications: { stopLoss: 88, takeProfit: 125 },
      reason: "USER",
      timestamp: Date.now(),
    });

    expect(resp.success).toBe(true);
    expect(portfolioAgent.markTradeDesync).not.toHaveBeenCalled();
    expect(portfolioAgent.updateTrade).toHaveBeenCalledTimes(1);
  });
});

describe("resubscribeOpenTradeLtps (startup frozen-LTP fix)", () => {
  it("re-subscribes each open trade's contract, skipping those without contractSecurityId", async () => {
    const subscribeLTP = vi.fn();
    vi.mocked(getAdapter).mockReturnValue({ brokerId: "dhan-primary-ac", subscribeLTP } as any);
    vi.mocked(portfolioAgent.listOpenTrades).mockImplementation(async (ch: any) =>
      ch === "my-live"
        ? ([
            { id: "T1", instrument: "NIFTY 50", status: "OPEN", contractSecurityId: "55123" },
            { id: "T2", instrument: "NATURAL GAS", status: "OPEN", contractSecurityId: "99001" },
            { id: "T3", instrument: "NIFTY 50", status: "OPEN", contractSecurityId: null },
          ] as any[])
        : ([] as any[]),
    );

    await tradeExecutor.resubscribeOpenTradeLtps();

    // T1 (NSE) + T2 (MCX) subscribed; T3 skipped for missing contractSecurityId.
    expect(subscribeLTP).toHaveBeenCalledTimes(2);
    expect(subscribeLTP.mock.calls[0][0][0]).toMatchObject({ exchange: "NSE_FNO", securityId: "55123" });
    expect(subscribeLTP.mock.calls[1][0][0]).toMatchObject({ exchange: "MCX_COMM", securityId: "99001" });
  });

  it("no-op when no channel has open trades", async () => {
    const subscribeLTP = vi.fn();
    vi.mocked(getAdapter).mockReturnValue({ brokerId: "dhan-primary-ac", subscribeLTP } as any);
    vi.mocked(portfolioAgent.listOpenTrades).mockResolvedValue([] as any[]);

    await tradeExecutor.resubscribeOpenTradeLtps();

    expect(subscribeLTP).not.toHaveBeenCalled();
  });
});
