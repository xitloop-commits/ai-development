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
  })),
}));

// The monitor tests exercise the executor-settings safety-exit path, so route
// every channel through the fallback (aiModeForChannel → null). The other
// exports are only used by the placement path (not under test here).
vi.mock("../portfolio/aiModeConfig", () => ({
  aiModeForChannel: () => null,
  modeForChannel: (ch: string) => (ch === "paper" ? "paper" : "live"),
  getActiveStrategies: () => ["sprint"],
  getAiConfig: () => ({
    order: { orderType: "MARKET", productType: "INTRADAY" },
    globalExits: { rcaMaxAgeMs: 30 * 60_000, rcaStaleTickMs: 5 * 60_000, rcaVolThreshold: 0.7 },
  }),
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
      channels: ["paper"],
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

  it("MOMENTUM_FLIP is disabled globally — no exit even on a confident opposite signal", async () => {
    const trade = makeOpenTrade({ cohort: "trend" }); // CALL_BUY = bullish
    getPositionsMock.mockResolvedValueOnce([trade as any]);
    getSEASignalsMock.mockReturnValue([
      // GO_PUT opposite a long call, 0.7 → conf 70 ≥ 60 — WOULD have fired the
      // momentum-flip, but MOMENTUM_EXIT_ENABLED=false turns it off.
      { instrument: "NIFTY", direction: "GO_PUT", direction_prob_30s: 0.7, timestamp: Date.now() },
    ] as any);

    await (rcaMonitor as any).tick();

    expect(exitTradeMock).not.toHaveBeenCalled();
  });

  it("MOMENTUM_FLIP is skipped for scalps even on a confident opposite signal", async () => {
    const trade = makeOpenTrade({ cohort: "scalp" });
    getPositionsMock.mockResolvedValueOnce([trade as any]);
    getSEASignalsMock.mockReturnValue([
      { instrument: "NIFTY", direction: "GO_PUT", direction_prob_30s: 0.7, timestamp: Date.now() },
    ] as any);

    await (rcaMonitor as any).tick();

    expect(exitTradeMock).not.toHaveBeenCalled();
  });

  it("MOMENTUM_FLIP is skipped when the opposite signal is not confident enough", async () => {
    const trade = makeOpenTrade({ cohort: "trend" });
    getPositionsMock.mockResolvedValueOnce([trade as any]);
    getSEASignalsMock.mockReturnValue([
      // 0.5 → confidence 50 < 60 → no flip even though direction is opposite.
      { instrument: "NIFTY", direction: "GO_PUT", direction_prob_30s: 0.5, timestamp: Date.now() },
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

  it("T86 β — re-attempts a still-open guarded trade after the retry window", async () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-07-19T04:00:00Z").getTime();
      vi.setSystemTime(t0);
      const trade = makeOpenTrade({
        id: "T-REOPEN",
        openedAt: t0 - 60 * 60_000, // AGE-eligible every sweep
      });
      getPositionsMock.mockResolvedValue([trade as any]);

      // First sweep fires the AGE exit and guards the trade.
      await (rcaMonitor as any).tick();
      expect(exitTradeMock).toHaveBeenCalledTimes(1);

      // Still inside the 60s retry window → guarded, no re-attempt (even though
      // the executor "succeeded" but the trade is somehow still OPEN).
      vi.setSystemTime(t0 + 30_000);
      await (rcaMonitor as any).tick();
      expect(exitTradeMock).toHaveBeenCalledTimes(1);

      // Past EXIT_RETRY_MS and STILL open → the guard is stale, so RCA re-fires
      // the exit instead of leaving it stuck forever.
      vi.setSystemTime(t0 + 61_000);
      await (rcaMonitor as any).tick();
      expect(exitTradeMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("T86 β — a permanent 'already closed' failure is never re-attempted", async () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-07-19T04:00:00Z").getTime();
      vi.setSystemTime(t0);
      const trade = makeOpenTrade({
        id: "T-PERM",
        openedAt: t0 - 60 * 60_000,
      });
      getPositionsMock.mockResolvedValue([trade as any]);
      // The first (and only) attempt fails permanently — the trade is gone.
      exitTradeMock.mockResolvedValueOnce({
        success: false,
        error: "Trade already closed",
      } as any);

      await (rcaMonitor as any).tick();
      expect(exitTradeMock).toHaveBeenCalledTimes(1);

      // Even long past the retry window, a permanent failure stays guarded
      // (stamped far in the future) so RCA never spams a dead trade.
      vi.setSystemTime(t0 + 10 * 60_000);
      await (rcaMonitor as any).tick();
      expect(exitTradeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
