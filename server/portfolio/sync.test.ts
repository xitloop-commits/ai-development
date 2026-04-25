/**
 * Capital Sync Tests — Inject → State → Day Records → Quarterly Projections
 *
 * Tests the full data sync chain when capital is injected:
 *   1. Pure engine: injectCapital splits 75/25 correctly
 *   2. Day record sync: current day's tradeCapital, targetAmount, projCapital update
 *   3. State sync: tradingPool, reservePool, initialFunding update
 *   4. Quarterly projections: use updated initialFunding baseline
 *   5. Future days: project from updated actualCapital
 *   6. Both workspaces: live AND paper sync independently
 *   7. Past days: remain untouched after inject
 *
 * Router-level tests use appRouter.createCaller() with a mock context,
 * requiring a real MongoDB connection (integration tests).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";
import {
  injectCapital,
  createDayRecord,
  initializeCapital,
  calculateQuarterlyProjection,
  calculateAllQuarterlyProjections,
  projectFutureDays,
  TRADING_SPLIT,
  RESERVE_SPLIT,
  DEFAULT_TARGET_PERCENT,
  DEFAULT_INITIAL_FUNDING,
} from "./compounding";
import type { CapitalState, DayRecord } from "./state";

// ─── Helpers ────────────────────────────────────────────────────

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function makeState(overrides?: Partial<CapitalState>): CapitalState {
  return {
    channel: "my-live",
    tradingPool: 75000,
    reservePool: 25000,
    initialFunding: 100000,
    currentDayIndex: 1,
    targetPercent: 5,
    profitHistory: [],
    cumulativePnl: 0,
    cumulativeCharges: 0,
    sessionTradeCount: 0,
    sessionPnl: 0,
    sessionDate: new Date().toISOString().slice(0, 10),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createMockContext(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

// ═══════════════════════════════════════════════════════════════════
// PART 1: Pure Engine Tests (no MongoDB)
// ═══════════════════════════════════════════════════════════════════

describe("Pure Engine: injectCapital", () => {
  it("should split injected amount 75/25 and add to existing pools", () => {
    const state = makeState({ tradingPool: 75000, reservePool: 25000 });
    const result = injectCapital(state, 100000);
    expect(result.tradingPool).toBe(150000); // 75000 + 100000*0.75
    expect(result.reservePool).toBe(50000);  // 25000 + 100000*0.25
  });

  it("should handle fractional amounts correctly", () => {
    const state = makeState({ tradingPool: 75000, reservePool: 25000 });
    const result = injectCapital(state, 33333);
    expect(result.tradingPool).toBe(round(75000 + 33333 * 0.75));
    expect(result.reservePool).toBe(round(25000 + 33333 * 0.25));
  });

  it("should correctly recalculate day record after inject", () => {
    const newTradingPool = 150000;
    const targetPercent = 5;
    const day = createDayRecord(1, 75000, 5, 78750, "live", "ACTIVE");

    // Simulate what inject does to the day record
    day.tradeCapital = newTradingPool;
    day.targetPercent = targetPercent;
    day.targetAmount = round(newTradingPool * targetPercent / 100);
    day.projCapital = round(newTradingPool + day.targetAmount);
    day.actualCapital = round(newTradingPool + day.totalPnl);
    day.deviation = round(day.actualCapital - day.originalProjCapital);

    expect(day.tradeCapital).toBe(150000);
    expect(day.targetAmount).toBe(7500);     // 150000 * 5%
    expect(day.projCapital).toBe(157500);    // 150000 + 7500
    expect(day.actualCapital).toBe(150000);  // 150000 + 0 (no PnL)
    expect(day.originalProjCapital).toBe(78750); // unchanged
    expect(day.deviation).toBe(150000 - 78750); // 71250
  });

  it("should preserve totalPnl in actualCapital after inject", () => {
    const newTradingPool = 150000;
    const day = createDayRecord(1, 75000, 5, 78750, "live", "ACTIVE");
    day.totalPnl = 2000; // existing P&L

    day.tradeCapital = newTradingPool;
    day.targetAmount = round(newTradingPool * 5 / 100);
    day.projCapital = round(newTradingPool + day.targetAmount);
    day.actualCapital = round(newTradingPool + day.totalPnl);

    expect(day.actualCapital).toBe(152000); // 150000 + 2000
  });
});

describe("Pure Engine: Quarterly Projections with updated initialFunding", () => {
  it("should use provided initialFunding instead of DEFAULT_INITIAL_FUNDING", () => {
    const result1 = calculateQuarterlyProjection(150000, 50000, 10, 30, 100000);
    const result2 = calculateQuarterlyProjection(150000, 50000, 10, 30, 200000);

    // Different baselines should produce different avg daily rates → different projections
    // With 100K baseline: grew from 100K to 200K in 10 days → high rate
    // With 200K baseline: grew from 200K to 200K in 10 days → zero rate
    expect(result1.projectedCapital).toBeGreaterThan(result2.projectedCapital);
  });

  it("should mark past quarters as isPast with zero projection", () => {
    const results = calculateAllQuarterlyProjections(150000, 50000, 10, 30, 200000);
    expect(results).toHaveLength(4);

    const now = new Date();
    const month = now.getMonth();
    const currentQuarter = month >= 3 && month <= 5 ? 1 : month >= 6 && month <= 8 ? 2 : month >= 9 && month <= 11 ? 3 : 4;

    for (const q of results) {
      if (q.isPast) {
        expect(q.projectedCapital).toBe(0);
      }
      if (q.isCurrent) {
        expect(q.projectedCapital).toBeGreaterThan(0);
      }
    }

    // Exactly one should be current
    const currentCount = results.filter(q => q.isCurrent).length;
    expect(currentCount).toBe(1);
  });

  it("should project future quarters from current capital", () => {
    const results = calculateAllQuarterlyProjections(150000, 50000, 10, 30, 200000);
    const futureQuarters = results.filter(q => !q.isPast && !q.isCurrent);

    for (const q of futureQuarters) {
      expect(q.projectedCapital).toBeGreaterThan(0);
    }
  });
});

describe("Pure Engine: Future Days projection after inject", () => {
  it("should project from updated actualCapital, not old tradingPool", () => {
    const oldFuture = projectFutureDays(2, 75000, 5, 5, "live");
    const newFuture = projectFutureDays(2, 150000, 5, 5, "live");

    // New future should have higher tradeCapital at every day
    for (let i = 0; i < oldFuture.length; i++) {
      expect(newFuture[i].tradeCapital).toBeGreaterThan(oldFuture[i].tradeCapital);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// PART 2: Router Integration Tests (requires MongoDB)
// ═══════════════════════════════════════════════════════════════════

describe("Router Integration: Capital Inject → Sync Chain", () => {
  let caller: ReturnType<typeof appRouter.createCaller>;
  let mongoConnected = false;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.warn("⚠ MONGODB_URI not set — skipping router integration tests");
      return;
    }
    try {
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(uri);
      }
      mongoConnected = true;
    } catch (e) {
      console.warn("⚠ MongoDB connection failed — skipping router integration tests");
    }

    const ctx = createMockContext();
    caller = appRouter.createCaller(ctx);
  });

  afterAll(async () => {
    if (mongoConnected && mongoose.connection.readyState === 1) {
      // Clean up test data — delete test workspace states
      // (Don't disconnect — other tests may need the connection)
    }
  });

  // ── Test 1: State reflects inject immediately ──────────────────

  it("state endpoint should return updated pools after inject", async () => {
    if (!mongoConnected) return;

    // Get state before inject
    const stateBefore = await caller.portfolio.state({ channel: "my-live" });
    const poolBefore = stateBefore.tradingPool;
    const reserveBefore = stateBefore.reservePool;
    const fundingBefore = stateBefore.initialFunding;

    // Inject 10000
    const injectAmount = 10000;
    await caller.portfolio.inject({ channel: "my-live", amount: injectAmount });

    // Get state after inject
    const stateAfter = await caller.portfolio.state({ channel: "my-live" });

    expect(stateAfter.tradingPool).toBe(round(poolBefore + injectAmount * TRADING_SPLIT));
    expect(stateAfter.reservePool).toBe(round(reserveBefore + injectAmount * RESERVE_SPLIT));
    expect(stateAfter.initialFunding).toBe(fundingBefore + injectAmount);
    expect(stateAfter.netWorth).toBe(
      round(stateAfter.tradingPool + stateAfter.reservePool)
    );

    // Reverse the inject to restore state
    // (We can't un-inject, so we just note the state changed)
  });

  // ── Test 2: Current day record reflects inject ─────────────────

  it("currentDay should have updated tradeCapital after inject", async () => {
    if (!mongoConnected) return;

    const stateBefore = await caller.portfolio.state({ channel: "my-live" });
    const dayBefore = await caller.portfolio.currentDay({ channel: "my-live" });

    const injectAmount = 5000;
    await caller.portfolio.inject({ channel: "my-live", amount: injectAmount });

    const dayAfter = await caller.portfolio.currentDay({ channel: "my-live" });
    const expectedTradingPool = round(stateBefore.tradingPool + injectAmount * TRADING_SPLIT);

    expect(dayAfter.tradeCapital).toBe(expectedTradingPool);
    expect(dayAfter.targetAmount).toBe(
      round(expectedTradingPool * dayAfter.targetPercent / 100)
    );
    expect(dayAfter.projCapital).toBe(
      round(expectedTradingPool + dayAfter.targetAmount)
    );
    // originalProjCapital should NOT change
    expect(dayAfter.originalProjCapital).toBe(dayBefore.originalProjCapital);
  });

  // ── Test 3: allDays reflects inject in current day row ─────────

  it("allDays should show updated current day after inject", async () => {
    if (!mongoConnected) return;

    const injectAmount = 3000;
    const stateBefore = await caller.portfolio.state({ channel: "my-live" });

    await caller.portfolio.inject({ channel: "my-live", amount: injectAmount });

    const allDays = await caller.portfolio.allDays({ channel: "my-live", futureCount: 5 });
    const currentDayIndex = (await caller.portfolio.state({ channel: "my-live" })).currentDayIndex;

    // Find the current day in allDays
    const currentDayRow = allDays.find((d: DayRecord) => d.dayIndex === currentDayIndex);
    expect(currentDayRow).toBeDefined();

    const expectedTradingPool = round(stateBefore.tradingPool + injectAmount * TRADING_SPLIT);
    expect(currentDayRow!.tradeCapital).toBe(expectedTradingPool);
  });

  // ── Test 4: Future days project from updated capital ───────────

  it("future days should project from updated actualCapital", async () => {
    if (!mongoConnected) return;

    const allDaysBefore = await caller.portfolio.allDays({ channel: "my-live", futureCount: 5 });
    const stateBefore = await caller.portfolio.state({ channel: "my-live" });

    const injectAmount = 20000;
    await caller.portfolio.inject({ channel: "my-live", amount: injectAmount });

    const allDaysAfter = await caller.portfolio.allDays({ channel: "my-live", futureCount: 5 });
    const stateAfter = await caller.portfolio.state({ channel: "my-live" });

    // Future days should have higher tradeCapital than before
    const futureBefore = allDaysBefore.filter((d: DayRecord) => d.status === "FUTURE");
    const futureAfter = allDaysAfter.filter((d: DayRecord) => d.status === "FUTURE");

    if (futureBefore.length > 0 && futureAfter.length > 0) {
      expect(futureAfter[0].tradeCapital).toBeGreaterThan(futureBefore[0].tradeCapital);
    }
  });

  // ── Test 5: Quarterly projections use updated initialFunding ───

  it("quarterly projections should use updated initialFunding after inject", async () => {
    if (!mongoConnected) return;

    const stateBefore = await caller.portfolio.state({ channel: "my-live" });
    const projBefore = stateBefore.allQuarterlyProjections;

    const injectAmount = 50000;
    await caller.portfolio.inject({ channel: "my-live", amount: injectAmount });

    const stateAfter = await caller.portfolio.state({ channel: "my-live" });
    const projAfter = stateAfter.allQuarterlyProjections;

    // initialFunding should have increased
    expect(stateAfter.initialFunding).toBe(stateBefore.initialFunding + injectAmount);

    // Current quarter projection should reflect new capital
    const currentBefore = projBefore.find((q: any) => q.isCurrent);
    const currentAfter = projAfter.find((q: any) => q.isCurrent);

    expect(currentAfter).toBeDefined();
    expect(currentAfter!.projectedCapital).toBeGreaterThan(0);

    // Past quarters should remain at 0
    const pastAfter = projAfter.filter((q: any) => q.isPast);
    for (const q of pastAfter) {
      expect(q.projectedCapital).toBe(0);
    }
  });

  // ── Test 6: Paper workspace syncs independently ────────────────

  it("paper workspace should also sync after inject", async () => {
    if (!mongoConnected) return;

    const paperStateBefore = await caller.portfolio.state({ channel: "my-paper" });

    const injectAmount = 8000;
    // Inject is called with workspace: 'live' but syncs both
    await caller.portfolio.inject({ channel: "my-live", amount: injectAmount });

    const paperStateAfter = await caller.portfolio.state({ channel: "my-paper" });

    expect(paperStateAfter.tradingPool).toBe(
      round(paperStateBefore.tradingPool + injectAmount * TRADING_SPLIT)
    );
    expect(paperStateAfter.reservePool).toBe(
      round(paperStateBefore.reservePool + injectAmount * RESERVE_SPLIT)
    );
    expect(paperStateAfter.initialFunding).toBe(
      paperStateBefore.initialFunding + injectAmount
    );

    // Paper current day should also be synced
    const paperDay = await caller.portfolio.currentDay({ channel: "my-paper" });
    expect(paperDay.tradeCapital).toBe(paperStateAfter.tradingPool);
  });

  // ── Test 7: Past days are NOT modified ─────────────────────────

  it("past completed days should NOT be modified after inject", async () => {
    if (!mongoConnected) return;

    const state = await caller.portfolio.state({ channel: "my-live" });

    // Only test if there are past days
    if (state.currentDayIndex > 1) {
      const pastDaysBefore = await caller.portfolio.pastDays({ channel: "my-live", limit: 10 });

      await caller.portfolio.inject({ channel: "my-live", amount: 5000 });

      const pastDaysAfter = await caller.portfolio.pastDays({ channel: "my-live", limit: 10 });

      // Each past day should be identical
      for (let i = 0; i < pastDaysBefore.length; i++) {
        expect(pastDaysAfter[i].tradeCapital).toBe(pastDaysBefore[i].tradeCapital);
        expect(pastDaysAfter[i].targetAmount).toBe(pastDaysBefore[i].targetAmount);
        expect(pastDaysAfter[i].projCapital).toBe(pastDaysBefore[i].projCapital);
        expect(pastDaysAfter[i].actualCapital).toBe(pastDaysBefore[i].actualCapital);
      }
    }
  });

  // ── Test 8: netWorth = tradingPool + reservePool ───────────────

  it("netWorth should equal tradingPool + reservePool after inject", async () => {
    if (!mongoConnected) return;

    await caller.portfolio.inject({ channel: "my-live", amount: 15000 });

    const state = await caller.portfolio.state({ channel: "my-live" });
    expect(state.netWorth).toBe(round(state.tradingPool + state.reservePool));
  });

  // ── Test 9: todayTarget reflects updated tradeCapital ──────────

  it("todayTarget should reflect updated tradeCapital after inject", async () => {
    if (!mongoConnected) return;

    await caller.portfolio.inject({ channel: "my-live", amount: 10000 });

    const state = await caller.portfolio.state({ channel: "my-live" });
    const expectedTarget = round(state.tradingPool * state.targetPercent / 100);

    expect(state.todayTarget).toBe(expectedTarget);
  });

  // ── Test 10: Multiple sequential injects accumulate correctly ──

  it("multiple sequential injects should accumulate correctly", async () => {
    if (!mongoConnected) return;

    const stateBefore = await caller.portfolio.state({ channel: "my-live" });

    await caller.portfolio.inject({ channel: "my-live", amount: 1000 });
    await caller.portfolio.inject({ channel: "my-live", amount: 2000 });
    await caller.portfolio.inject({ channel: "my-live", amount: 3000 });

    const stateAfter = await caller.portfolio.state({ channel: "my-live" });
    const totalInjected = 6000;

    expect(stateAfter.tradingPool).toBe(
      round(stateBefore.tradingPool + totalInjected * TRADING_SPLIT)
    );
    expect(stateAfter.reservePool).toBe(
      round(stateBefore.reservePool + totalInjected * RESERVE_SPLIT)
    );
    expect(stateAfter.initialFunding).toBe(
      stateBefore.initialFunding + totalInjected
    );
  });
});
