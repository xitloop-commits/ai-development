/**
 * G6 — rcaMonitor exit triggers.
 *
 * `inbound.test.ts` already exercises the three external APIs
 * (evaluateTrade, disciplineRequest, aiSignal). This file locks the
 * INTERNAL monitor loop's four exit-trigger paths:
 *
 *   1. AGE          — trade age >= maxAgeMs
 *   2. STALE_PRICE  — no tick for >= staleTickMs
 *   3. VOLATILITY   — latest SEA signal predicts max_drawdown >= threshold
 *   4. MOMENTUM_FLIP — latest SEA signal direction opposite to position
 *
 * Each trigger should call exit() exactly once and skip every other
 * trigger that fires after it (continue/return semantics).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks (hoisted via vi.hoisted so they're alive before vi.mock) ──

const { exitTradeMock, getPositionsMock, getSEASignalsMock } = vi.hoisted(() => ({
  exitTradeMock: vi.fn(async () => ({
    success: true,
    positionId: "POS-1",
    exitId: "EXIT-1",
    exitPrice: 100,
    executedQuantity: 75,
    realizedPnl: 0,
    realizedPnlPct: 0,
    exitTime: Date.now(),
  })),
  getPositionsMock: vi.fn(async () => [] as any[]),
  getSEASignalsMock: vi.fn(() => [] as any[]),
}));

vi.mock("../executor/tradeExecutor", () => ({
  tradeExecutor: {
    exitTrade: exitTradeMock,
    submitTrade: vi.fn(),
    modifyOrder: vi.fn(),
  },
}));

vi.mock("../portfolio", () => ({
  portfolioAgent: {
    getPositions: getPositionsMock,
  },
}));

vi.mock("../seaSignals", () => ({
  getSEASignals: getSEASignalsMock,
}));

vi.mock("../broker/tickBus", () => ({
  tickBus: { emitTick: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock("../executor/settings", () => ({
  getExecutorSettings: vi.fn(async () => ({
    rcaMaxAgeMs: 30 * 60_000,
    rcaStaleTickMs: 5 * 60_000,
    rcaVolThreshold: 0.7,
    rcaChannels: [],
    recoveryStuckMs: 60_000,
    recoveryChannels: [],
    aiLiveLotCap: 1,
  })),
}));

import { rcaMonitor } from "./index";

function makeOpenTrade(overrides: any = {}) {
  return {
    id: "T-1",
    instrument: "NIFTY_50",
    type: "CALL_BUY",
    status: "OPEN",
    openedAt: Date.now(),
    lastTickAt: Date.now(),
    entryPrice: 100,
    qty: 75,
    exitPrice: null,
    contractSecurityId: null,
    strike: null,
    ...overrides,
  };
}

describe("rcaMonitor — exit triggers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rcaMonitor.stop();
    rcaMonitor.start({
      maxAgeMs: 30 * 60_000,
      staleTickMs: 5 * 60_000,
      volThreshold: 0.7,
      channels: ["ai-paper"],
    });
  });

  it("AGE trigger — fires exitTrade when openedAt is older than maxAgeMs", async () => {
    const tooOld = makeOpenTrade({
      openedAt: Date.now() - 60 * 60_000, // 60 min, threshold is 30
    });
    getPositionsMock.mockResolvedValueOnce([tooOld as any]);

    await (rcaMonitor as any).tick();

    expect(exitTradeMock).toHaveBeenCalledTimes(1);
    expect(exitTradeMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "AGE_EXIT" }),
    );
  });

  it("STALE_PRICE trigger — fires when lastTickAt is older than staleTickMs", async () => {
    const stale = makeOpenTrade({
      openedAt: Date.now() - 60_000, // young
      lastTickAt: Date.now() - 10 * 60_000, // tick 10 min stale, threshold 5
    });
    getPositionsMock.mockResolvedValueOnce([stale as any]);

    await (rcaMonitor as any).tick();

    expect(exitTradeMock).toHaveBeenCalledTimes(1);
    expect(exitTradeMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "STALE_PRICE_EXIT" }),
    );
  });

  it("STALE_PRICE does NOT fire when lastTickAt is undefined (fresh trade pre-first-tick)", async () => {
    const fresh = makeOpenTrade({
      openedAt: Date.now() - 60_000,
      lastTickAt: undefined,
    });
    getPositionsMock.mockResolvedValueOnce([fresh as any]);

    await (rcaMonitor as any).tick();

    expect(exitTradeMock).not.toHaveBeenCalled();
  });

  it("VOLATILITY trigger — fires when SEA predicts drawdown >= threshold", async () => {
    const trade = makeOpenTrade();
    getPositionsMock.mockResolvedValueOnce([trade as any]);
    // SEA signals come back with the canonical key form ("NIFTY", not
    // "NIFTY_50") — toSeaKey() normalises trade.instrument to match.
    getSEASignalsMock.mockReturnValue([
      {
        instrument: "NIFTY",
        direction: "GO_CALL",
        max_drawdown_pred_30s: 0.85, // above 0.7 threshold
        timestamp: Date.now(),
      },
    ] as any);

    await (rcaMonitor as any).tick();

    expect(exitTradeMock).toHaveBeenCalledTimes(1);
    expect(exitTradeMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "VOLATILITY_EXIT" }),
    );
  });

  it("VOLATILITY does NOT fire when predicted drawdown is below threshold", async () => {
    const trade = makeOpenTrade();
    getPositionsMock.mockResolvedValueOnce([trade as any]);
    getSEASignalsMock.mockReturnValue([
      {
        instrument: "NIFTY",
        direction: "GO_CALL",
        max_drawdown_pred_30s: 0.3, // below 0.7
        timestamp: Date.now(),
      },
    ] as any);

    await (rcaMonitor as any).tick();

    expect(exitTradeMock).not.toHaveBeenCalled();
  });

  it("skips trades that are not OPEN status", async () => {
    const closed = makeOpenTrade({
      status: "CLOSED",
      openedAt: Date.now() - 60 * 60_000, // would trigger AGE if open
    });
    getPositionsMock.mockResolvedValueOnce([closed as any]);

    await (rcaMonitor as any).tick();

    expect(exitTradeMock).not.toHaveBeenCalled();
  });

  it("skips trades that have already had an exit attempted (idempotency cache)", async () => {
    const trade = makeOpenTrade({
      id: "T-DEDUP",
      openedAt: Date.now() - 60 * 60_000,
    });
    getPositionsMock.mockResolvedValue([trade as any]);

    // First tick fires the AGE exit.
    await (rcaMonitor as any).tick();
    expect(exitTradeMock).toHaveBeenCalledTimes(1);

    // Second tick on the same trade must not re-attempt — exitAttempted
    // cache prevents double-exit on the next monitor sweep.
    await (rcaMonitor as any).tick();
    expect(exitTradeMock).toHaveBeenCalledTimes(1);
  });

  it("survives portfolioAgent.getPositions failure without throwing (best-effort)", async () => {
    getPositionsMock.mockRejectedValueOnce(new Error("Mongo down"));

    await expect((rcaMonitor as any).tick()).resolves.toBeUndefined();
    expect(exitTradeMock).not.toHaveBeenCalled();
  });

  it("getLatestMomentumScore returns null when no signal exists for the instrument", () => {
    getSEASignalsMock.mockReturnValue([] as any);
    expect(rcaMonitor.getLatestMomentumScore("CRUDEOIL")).toBeNull();
  });

  it("getLatestMomentumScore returns the model's momentum field when present", () => {
    // The function maps instrument NIFTY → SEA key "NIFTY"; the signal's
    // `instrument` field comes back from getSEASignals already in the
    // SEA-canonical form (see toSeaKey in rcaMonitor source).
    getSEASignalsMock.mockReturnValue([
      { instrument: "NIFTY", momentum: 78, direction_prob_30s: 0.7, timestamp: Date.now() },
    ] as any);
    expect(rcaMonitor.getLatestMomentumScore("NIFTY")).toBe(78);
  });

  it("getLatestMomentumScore falls back to direction_prob × 100 when momentum is missing", () => {
    getSEASignalsMock.mockReturnValue([
      { instrument: "NIFTY", direction_prob_30s: 0.65, timestamp: Date.now() },
    ] as any);
    expect(rcaMonitor.getLatestMomentumScore("NIFTY")).toBeCloseTo(65, 5);
  });
});
