/**
 * Tests for RCA's three inbound APIs (C2):
 *   evaluateTrade / disciplineRequest / aiSignal.
 *
 * Mocks tradeExecutor + portfolioAgent so the suite runs without Mongo
 * or live broker. The REST routes are thin adapters; once these methods
 * are tested + zod schemas validated, the Express layer is covered.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Mocks (must be hoisted before SUT import) ──────────────────

vi.mock("../executor/tradeExecutor", () => ({
  tradeExecutor: {
    submitTrade: vi.fn(async () => ({
      success: true,
      tradeId: "T-1",
      positionId: "POS-1",
      orderId: "ORD-1",
      status: "FILLED",
    })),
    exitTrade: vi.fn(async () => ({
      success: true,
      positionId: "POS-1",
      exitId: "EXIT-1",
      exitPrice: 102,
      executedQuantity: 75,
      realizedPnl: 150,
      realizedPnlPct: 2,
      exitTime: 1700000000000,
    })),
    modifyOrder: vi.fn(async () => ({
      success: true,
      positionId: "POS-1",
      modificationId: "MOD-1",
      oldSL: 90,
      newSL: 95,
      oldTP: 120,
      newTP: 120,
      appliedAt: 1700000000000,
    })),
  },
}));

vi.mock("../portfolio", () => ({
  portfolioAgent: {
    getPositions: vi.fn(async () => []),
  },
}));

vi.mock("../broker/tickBus", () => ({
  tickBus: { emitTick: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock("../seaSignals", () => ({
  getSEASignals: vi.fn(() => []),
}));

vi.mock("../executor/settings", () => ({
  getExecutorSettings: vi.fn(async () => ({
    rcaMaxAgeMs: 30 * 60_000,
    rcaStaleTickMs: 5 * 60_000,
    rcaVolThreshold: 0.7,
    rcaChannels: [],
  })),
}));

// ─── SUT ─────────────────────────────────────────────────────────

import { rcaMonitor } from "./index";
import { tradeExecutor } from "../executor/tradeExecutor";
import { portfolioAgent } from "../portfolio";
import { getSEASignals } from "../seaSignals";

const sampleEvalReq = {
  executionId: "test-1",
  channel: "ai-paper" as const,
  instrument: "NIFTY_50",
  direction: "BUY" as const,
  quantity: 75,
  entryPrice: 100,
  stopLoss: 90,
  takeProfit: 120,
  origin: "AI" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  (portfolioAgent.getPositions as any).mockResolvedValue([]);
  (tradeExecutor.submitTrade as any).mockResolvedValue({
    success: true,
    tradeId: "T-1",
    positionId: "POS-1",
    orderId: "ORD-1",
    status: "FILLED",
  });
  (tradeExecutor.exitTrade as any).mockResolvedValue({
    success: true,
    positionId: "POS-1",
    exitId: "EXIT-1",
    exitPrice: 102,
    executedQuantity: 75,
    realizedPnl: 150,
    realizedPnlPct: 2,
    exitTime: 1700000000000,
  });
});

// ─── evaluateTrade ───────────────────────────────────────────────

describe("rcaMonitor.evaluateTrade", () => {
  it("APPROVE on TEA success — forwards to submitTrade", async () => {
    const result = await rcaMonitor.evaluateTrade(sampleEvalReq);
    expect(result.decision).toBe("APPROVE");
    expect(tradeExecutor.submitTrade).toHaveBeenCalledTimes(1);
    expect((tradeExecutor.submitTrade as any).mock.calls[0][0]).toMatchObject({
      executionId: "test-1",
      instrument: "NIFTY_50",
      origin: "AI",
    });
  });

  it("REJECT when TEA returns success=false", async () => {
    (tradeExecutor.submitTrade as any).mockResolvedValueOnce({
      success: false,
      tradeId: "",
      positionId: "",
      orderId: "",
      status: "REJECTED",
      error: "Kill switch active",
    });
    const result = await rcaMonitor.evaluateTrade(sampleEvalReq);
    expect(result.decision).toBe("REJECT");
    expect(result.reason).toContain("Kill switch");
  });
});

// ─── disciplineRequest ───────────────────────────────────────────

describe("rcaMonitor.disciplineRequest", () => {
  const openTrade = (id: string, channel: string, instrument: string) => ({
    id,
    instrument,
    type: "CALL_BUY" as const,
    strike: 23300,
    entryPrice: 100,
    exitPrice: null,
    ltp: 102,
    qty: 75,
    capitalPercent: 10,
    pnl: 0,
    unrealizedPnl: 150,
    charges: 0,
    chargesBreakdown: [],
    status: "OPEN" as const,
    targetPrice: 120,
    stopLossPrice: 90,
    brokerId: null,
    openedAt: 1700000000000,
    closedAt: null,
  });

  it("scope=ALL exits every open position on the requested channels", async () => {
    (portfolioAgent.getPositions as any).mockImplementation(async (channel: string) => {
      if (channel === "ai-paper") return [openTrade("T1", channel, "NIFTY_50")];
      if (channel === "my-live") return [openTrade("T2", channel, "BANKNIFTY")];
      return [];
    });

    const result = await rcaMonitor.disciplineRequest({
      reason: "DISCIPLINE_EXIT",
      channels: ["ai-paper", "my-live"],
      scope: { kind: "ALL" },
    });

    expect(result.exited).toBe(2);
    expect(result.failed).toBe(0);
    expect(tradeExecutor.exitTrade).toHaveBeenCalledTimes(2);
    expect(result.details.map((d) => d.tradeId).sort()).toEqual(["T1", "T2"]);
  });

  it("scope=INSTRUMENT exits only matching trades", async () => {
    (portfolioAgent.getPositions as any).mockImplementation(async (channel: string) => {
      if (channel === "ai-paper") {
        return [openTrade("T1", channel, "NIFTY_50"), openTrade("T2", channel, "BANKNIFTY")];
      }
      return [];
    });

    const result = await rcaMonitor.disciplineRequest({
      reason: "DISCIPLINE_EXIT",
      channels: ["ai-paper"],
      scope: { kind: "INSTRUMENT", instrument: "NIFTY_50" },
    });

    expect(result.exited).toBe(1);
    expect(result.details[0].tradeId).toBe("T1");
  });

  it("scope=TRADE_IDS exits only listed ids", async () => {
    (portfolioAgent.getPositions as any).mockImplementation(async () => [
      openTrade("T1", "ai-paper", "NIFTY_50"),
      openTrade("T2", "ai-paper", "NIFTY_50"),
      openTrade("T3", "ai-paper", "NIFTY_50"),
    ]);
    const result = await rcaMonitor.disciplineRequest({
      reason: "DISCIPLINE_EXIT",
      channels: ["ai-paper"],
      scope: { kind: "TRADE_IDS", tradeIds: ["T1", "T3"] },
    });
    expect(result.exited).toBe(2);
    expect(result.details.map((d) => d.tradeId).sort()).toEqual(["T1", "T3"]);
  });

  it("counts failed exits correctly", async () => {
    (portfolioAgent.getPositions as any).mockResolvedValueOnce([openTrade("T1", "ai-paper", "NIFTY_50")]);
    (tradeExecutor.exitTrade as any).mockResolvedValueOnce({
      success: false,
      positionId: "POS-1",
      exitId: "",
      exitPrice: 0,
      executedQuantity: 0,
      realizedPnl: 0,
      realizedPnlPct: 0,
      exitTime: 0,
      error: "BROKER_DESYNC",
    });
    const result = await rcaMonitor.disciplineRequest({
      reason: "DISCIPLINE_EXIT",
      channels: ["ai-paper"],
      scope: { kind: "ALL" },
    });
    expect(result.exited).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.details[0].error).toContain("BROKER_DESYNC");
  });
});

// ─── aiSignal ────────────────────────────────────────────────────

describe("rcaMonitor.aiSignal", () => {
  const openTrade = (id: string, instrument: string) => ({
    id,
    instrument,
    type: "CALL_BUY" as const,
    strike: 23300,
    entryPrice: 100,
    exitPrice: null,
    ltp: 95,
    qty: 75,
    capitalPercent: 10,
    pnl: 0,
    unrealizedPnl: -50,
    charges: 0,
    chargesBreakdown: [],
    status: "OPEN" as const,
    targetPrice: 120,
    stopLossPrice: 90,
    brokerId: null,
    openedAt: 1700000000000,
    closedAt: null,
  });

  it("EXIT signal exits matching open positions", async () => {
    (portfolioAgent.getPositions as any).mockResolvedValue([openTrade("T1", "NIFTY_50")]);
    const result = await rcaMonitor.aiSignal({
      instrument: "NIFTY_50",
      signal: "EXIT",
      confidence: 0.85,
    });
    expect(result.acted).toBe(1);
    expect(tradeExecutor.exitTrade).toHaveBeenCalledTimes(1);
  });

  it("MODIFY_SL with newPrice — calls tradeExecutor.modifyOrder per matching position", async () => {
    (portfolioAgent.getPositions as any).mockResolvedValue([openTrade("T1", "NIFTY_50")]);
    const result = await rcaMonitor.aiSignal({
      instrument: "NIFTY_50",
      signal: "MODIFY_SL",
      newPrice: 95,
    });
    expect(result.acted).toBe(1);
    expect((tradeExecutor as any).modifyOrder).toHaveBeenCalledTimes(1);
    const call = ((tradeExecutor as any).modifyOrder as any).mock.calls[0][0];
    expect(call.modifications.stopLossPrice).toBe(95);
    expect(call.reason).toBe("AI_SIGNAL");
    expect(tradeExecutor.exitTrade).not.toHaveBeenCalled();
  });

  it("MODIFY_TP with newPrice — calls modifyOrder with target leg", async () => {
    (portfolioAgent.getPositions as any).mockResolvedValue([openTrade("T1", "NIFTY_50")]);
    const result = await rcaMonitor.aiSignal({
      instrument: "NIFTY_50",
      signal: "MODIFY_TP",
      newPrice: 130,
    });
    expect(result.acted).toBe(1);
    const call = ((tradeExecutor as any).modifyOrder as any).mock.calls[0][0];
    expect(call.modifications.targetPrice).toBe(130);
  });

  it("MODIFY_SL without newPrice — skipped at the entry guard", async () => {
    (portfolioAgent.getPositions as any).mockResolvedValue([openTrade("T1", "NIFTY_50")]);
    const result = await rcaMonitor.aiSignal({
      instrument: "NIFTY_50",
      signal: "MODIFY_SL",
    });
    expect(result.acted).toBe(0);
    expect(result.skipped).toBe(1);
    expect((tradeExecutor as any).modifyOrder).not.toHaveBeenCalled();
    expect(tradeExecutor.exitTrade).not.toHaveBeenCalled();
  });

  it("instrument mismatch — no action", async () => {
    (portfolioAgent.getPositions as any).mockResolvedValue([openTrade("T1", "NIFTY_50")]);
    const result = await rcaMonitor.aiSignal({
      instrument: "BANKNIFTY",
      signal: "EXIT",
    });
    expect(result.acted).toBe(0);
    expect(tradeExecutor.exitTrade).not.toHaveBeenCalled();
  });
});

// ─── getLatestMomentumScore (C3 enrichment) ──────────────────────

describe("rcaMonitor.getLatestMomentumScore", () => {
  it("returns SEASignal.momentum when present", () => {
    (getSEASignals as any).mockReturnValueOnce([
      {
        id: "s1", timestamp: 0, timestamp_ist: "", instrument: "NIFTY",
        direction: "GO_CALL", direction_prob_30s: 0.7,
        max_upside_pred_30s: 0, max_drawdown_pred_30s: 0,
        atm_strike: 23000, atm_ce_ltp: null, atm_pe_ltp: null,
        spot_price: null, momentum: 78, breakout: null, model_version: "v1",
      },
    ]);
    expect(rcaMonitor.getLatestMomentumScore("NIFTY_50")).toBe(78);
  });

  it("falls back to direction_prob_30s × 100 when momentum is null", () => {
    (getSEASignals as any).mockReturnValueOnce([
      {
        id: "s1", timestamp: 0, timestamp_ist: "", instrument: "BANKNIFTY",
        direction: "GO_PUT", direction_prob_30s: 0.62,
        max_upside_pred_30s: 0, max_drawdown_pred_30s: 0,
        atm_strike: 0, atm_ce_ltp: null, atm_pe_ltp: null,
        spot_price: null, momentum: null, breakout: null, model_version: "v1",
      },
    ]);
    expect(rcaMonitor.getLatestMomentumScore("BANKNIFTY")).toBeCloseTo(62);
  });

  it("returns null when no signal exists for the instrument", () => {
    (getSEASignals as any).mockReturnValueOnce([]);
    expect(rcaMonitor.getLatestMomentumScore("CRUDEOIL")).toBeNull();
  });

  it("matches NIFTY_50 → NIFTY (instrument-key normalisation)", () => {
    (getSEASignals as any).mockReturnValueOnce([
      {
        id: "s1", timestamp: 0, timestamp_ist: "", instrument: "NIFTY",
        direction: "GO_CALL", direction_prob_30s: 0.5,
        max_upside_pred_30s: 0, max_drawdown_pred_30s: 0,
        atm_strike: 0, atm_ce_ltp: null, atm_pe_ltp: null,
        spot_price: null, momentum: 55, breakout: null, model_version: "v1",
      },
    ]);
    expect(rcaMonitor.getLatestMomentumScore("NIFTY 50")).toBe(55);
  });
});
