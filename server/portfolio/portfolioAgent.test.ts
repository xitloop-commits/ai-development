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

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    getCapitalState: (...args: any[]) => getCapitalStateMock(...args),
    updateCapitalState: (...args: any[]) => updateCapitalStateMock(...args),
  };
});

vi.mock("./storage", () => ({
  appendEvent: vi.fn(async () => undefined),
  upsertPosition: vi.fn(async () => undefined),
  getOpenPositions: vi.fn(async () => []),
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
