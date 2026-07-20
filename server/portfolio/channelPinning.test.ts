/**
 * T92 regression — capital ops must act on the channel they're given.
 *
 * `inject`, `transferFunds` and `resetCapital` all accepted a `channel` input
 * and then wrote to `'my-live'` regardless. The worst case was `resetCapital`:
 * it validated the REQUESTED channel and then destroyed my-live, so resetting
 * paper wiped the live book's day records, positions and pools.
 *
 * These tests seed several channels and assert the non-target channels are
 * untouched. They fail against the old pinned implementation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface St { channel: string; tradingPool: number; reservePool: number; initialFunding: number; currentDayIndex: number }

const stateStore: Record<string, St> = {};

function seed(channel: string, tradingPool: number, reservePool = 0) {
  stateStore[channel] = { channel, tradingPool, reservePool, initialFunding: tradingPool, currentDayIndex: 1 };
}

const deletedDaysFor: string[] = [];
const deletedPositionsFor: string[] = [];

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    getCapitalState: vi.fn(async (channel: string) => {
      if (!stateStore[channel]) seed(channel, 0);
      return stateStore[channel];
    }),
    updateCapitalState: vi.fn(async (channel: string, patch: Partial<St>) => {
      Object.assign(stateStore[channel], patch);
      return stateStore[channel];
    }),
    replaceCapitalState: vi.fn(async (channel: string, fresh: St) => {
      stateStore[channel] = { ...fresh, channel };
      return stateStore[channel];
    }),
    // No day record → the day-sync branch is skipped; pools are what we assert on.
    getDayRecord: vi.fn(async () => null),
    upsertDayRecord: vi.fn(async (_c: string, d: unknown) => d),
    deleteAllDayRecords: vi.fn(async (channel: string) => { deletedDaysFor.push(channel); return 3; }),
  };
});

vi.mock("./storage", async () => {
  const actual = await vi.importActual<typeof import("./storage")>("./storage");
  return {
    ...actual,
    deleteAllPositions: vi.fn(async (channel: string) => { deletedPositionsFor.push(channel); return 0; }),
  };
});

vi.mock("../broker/brokerConfig", async () => {
  const actual = await vi.importActual<typeof import("../broker/brokerConfig")>("../broker/brokerConfig");
  return { ...actual, getActiveBrokerConfig: vi.fn(async () => ({ settings: { dailyTargetPercent: 5 } })) };
});

import { portfolioRouter } from "./router";

const caller = portfolioRouter.createCaller({ req: { header: () => undefined } } as any);

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
  deletedDaysFor.length = 0;
  deletedPositionsFor.length = 0;
});

describe("T92 — capital ops honour the requested channel", () => {
  it("inject funds the requested channel, not my-live", async () => {
    seed("my-live", 500_000);
    seed("ai-live", 200_000);

    await caller.inject({ channel: "ai-live", amount: 50_000 });

    expect(stateStore["ai-live"].tradingPool).toBe(250_000);
    expect(stateStore["my-live"].tradingPool).toBe(500_000); // untouched
  });

  it("inject adds to Trading only — the reserve split applies to profit, not capital", async () => {
    seed("ai-live", 100_000, 10_000);

    await caller.inject({ channel: "ai-live", amount: 40_000 });

    expect(stateStore["ai-live"].tradingPool).toBe(140_000);
    expect(stateStore["ai-live"].reservePool).toBe(10_000); // NOT given a 25% cut
  });

  it("transferFunds moves pools on the requested channel, not my-live", async () => {
    seed("my-live", 500_000, 100_000);
    seed("ai-live", 200_000, 50_000);

    await caller.transferFunds({ channel: "ai-live", from: "trading", to: "reserve", amount: 20_000 });

    expect(stateStore["ai-live"].tradingPool).toBe(180_000);
    expect(stateStore["ai-live"].reservePool).toBe(70_000);
    expect(stateStore["my-live"].tradingPool).toBe(500_000); // untouched
    expect(stateStore["my-live"].reservePool).toBe(100_000);
  });

  it("resetCapital wipes ONLY the requested channel — resetting paper must not destroy the live book", async () => {
    seed("my-live", 500_000, 100_000);
    seed("paper", 100_000);

    await caller.resetCapital({ channel: "paper", initialFunding: 100_000, force: true });

    // Live book completely untouched — pools, day records and positions.
    expect(stateStore["my-live"].tradingPool).toBe(500_000);
    expect(stateStore["my-live"].reservePool).toBe(100_000);
    expect(deletedDaysFor).toEqual(["paper"]);
    expect(deletedPositionsFor).toEqual(["paper"]);
  });

  it("resetCapital reports the channel it acted on", async () => {
    seed("ai-live", 200_000);
    const res = await caller.resetCapital({ channel: "ai-live", initialFunding: 250_000, force: true });

    expect(res.channel).toBe("ai-live");
    expect(res.tradingPool).toBe(250_000);
    expect(res.reservePool).toBe(0); // seed capital is 100% Trading
  });
});

/**
 * T96 — a reset must clear the high-water mark.
 *
 * replaceCapitalState uses $set, so any field the reset omits SURVIVES.
 * peakCapital wasn't in the field list, so it persisted across resets: found at
 * 1,940,930 on the paper book after a reset to 100,000, which had
 * drawdownPercent reading 96.44% and the capital-protection rules acting on it.
 */
describe("T96 — resetCapital clears the high-water mark", () => {
  it("sets peakCapital to the new funding, not the old peak", async () => {
    seed("paper", 100_000);
    (stateStore["paper"] as any).peakCapital = 1_940_930.29;
    (stateStore["paper"] as any).drawdownPercent = 96.44;

    await caller.resetCapital({ channel: "paper", initialFunding: 200_000, force: true });

    expect((stateStore["paper"] as any).peakCapital).toBe(200_000);
    expect((stateStore["paper"] as any).drawdownPercent).toBe(0);
  });

  it("clearWorkspace clears it too", async () => {
    seed("paper", 100_000);
    (stateStore["paper"] as any).peakCapital = 1_940_930.29;

    await caller.clearWorkspace({ channel: "paper", initialFunding: 200_000 });

    expect((stateStore["paper"] as any).peakCapital).toBe(200_000);
  });
});
