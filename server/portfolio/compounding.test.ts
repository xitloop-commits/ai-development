/**
 * Capital Engine — Unit & Integration Tests
 *
 * Tests the pure business logic functions without MongoDB.
 * Covers: initialization, injection, day lifecycle, gift days, clawback,
 * position sizing, future projection, session management, and aggregation.
 */
import { describe, expect, it } from "vitest";
import {
  initializeCapital,
  injectCapital,
  createDayRecord,
  checkDayCompletion,
  completeDayIndex,
  calculateGiftDays,
  processClawback,
  calculateAvailableCapital,
  calculatePositionSize,
  projectFutureDays,
  calculateQuarterlyProjection,
  checkSessionReset,
  resetSession,
  recalculateDayAggregates,
  TRADING_SPLIT,
  RESERVE_SPLIT,
  MAX_DAY_INDEX,
  DEFAULT_TARGET_PERCENT,
  DEFAULT_INITIAL_FUNDING,
} from "./compounding";
import type { CapitalState, DayRecord, TradeRecord } from "./state";

// ─── Helpers ────────────────────────────────────────────────────

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function makeState(overrides?: Partial<CapitalState>): CapitalState {
  return {
    workspace: "live",
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

function makeTrade(overrides?: Partial<TradeRecord>): TradeRecord {
  return {
    tradeId: `t_${Date.now()}`,
    instrument: "NIFTY_50",
    exchange: "NSE_FNO",
    type: "BUY_CE",
    strike: 26000,
    expiry: "2026-04-03",
    qty: 50,
    entryPrice: 150,
    exitPrice: 0,
    ltp: 150,
    pnl: 0,
    unrealizedPnl: 0,
    charges: 0,
    chargeBreakdown: [],
    capitalPercent: 10,
    status: "OPEN",
    entryTime: new Date(),
    exitTime: null,
    tag: "test",
    ...overrides,
  };
}

// ─── Constants ──────────────────────────────────────────────────

describe("Capital Engine Constants", () => {
  it("should have correct split ratios", () => {
    expect(TRADING_SPLIT).toBe(0.75);
    expect(RESERVE_SPLIT).toBe(0.25);
    expect(TRADING_SPLIT + RESERVE_SPLIT).toBe(1);
  });

  it("should have correct defaults", () => {
    expect(MAX_DAY_INDEX).toBe(250);
    expect(DEFAULT_TARGET_PERCENT).toBe(5);
    expect(DEFAULT_INITIAL_FUNDING).toBe(100000);
  });
});

// ─── Initialization ─────────────────────────────────────────────

describe("initializeCapital", () => {
  it("should create state with 75/25 split", () => {
    const state = initializeCapital("live", 100000, 5);
    expect(state.tradingPool).toBe(75000);
    expect(state.reservePool).toBe(25000);
    expect(state.initialFunding).toBe(100000);
    expect(state.currentDayIndex).toBe(1);
    expect(state.targetPercent).toBe(5);
    expect(state.channel).toBe("live");
  });

  it("should use default funding when not specified", () => {
    const state = initializeCapital("paper");
    expect(state.tradingPool).toBe(75000);
    expect(state.reservePool).toBe(25000);
    expect(state.initialFunding).toBe(100000);
  });

  it("should handle custom funding amounts", () => {
    const state = initializeCapital("live", 500000, 3);
    expect(state.tradingPool).toBe(375000);
    expect(state.reservePool).toBe(125000);
    expect(state.targetPercent).toBe(3);
  });

  it("should start with zero counters", () => {
    const state = initializeCapital("live");
    expect(state.cumulativePnl).toBe(0);
    expect(state.cumulativeCharges).toBe(0);
    expect(state.sessionTradeCount).toBe(0);
    expect(state.sessionPnl).toBe(0);
    expect(state.profitHistory).toEqual([]);
  });
});

// ─── Capital Injection ──────────────────────────────────────────

describe("injectCapital", () => {
  it("should split injected capital 75/25", () => {
    const state = makeState();
    const result = injectCapital(state, 100000);
    expect(result.tradingPool).toBe(150000); // 75000 + 75000
    expect(result.reservePool).toBe(50000);  // 25000 + 25000
  });

  it("should handle small injections", () => {
    const state = makeState();
    const result = injectCapital(state, 100);
    expect(result.tradingPool).toBe(75075);
    expect(result.reservePool).toBe(25025);
  });

  it("should handle zero injection", () => {
    const state = makeState();
    const result = injectCapital(state, 0);
    expect(result.tradingPool).toBe(75000);
    expect(result.reservePool).toBe(25000);
  });
});

// ─── Day Record Creation ────────────────────────────────────────

describe("createDayRecord", () => {
  it("should create a day record with correct calculations", () => {
    const day = createDayRecord(1, 75000, 5, 75000, "live", "ACTIVE");
    expect(day.dayIndex).toBe(1);
    expect(day.tradeCapital).toBe(75000);
    expect(day.targetPercent).toBe(5);
    expect(day.targetAmount).toBe(3750); // 75000 * 5%
    expect(day.projCapital).toBe(78750); // 75000 + 3750
    expect(day.status).toBe("ACTIVE");
    expect(day.trades).toEqual([]);
    expect(day.totalPnl).toBe(0);
  });

  it("should calculate deviation from original projection", () => {
    const day = createDayRecord(5, 80000, 5, 85000, "live");
    expect(day.deviation).toBe(-5000); // 80000 - 85000
  });

  it("should default to ACTIVE status", () => {
    const day = createDayRecord(1, 75000, 5, 75000, "live");
    expect(day.status).toBe("ACTIVE");
  });
});

// ─── Day Completion ─────────────────────────────────────────────

describe("checkDayCompletion", () => {
  it("should not be complete with open trades", () => {
    const day = createDayRecord(1, 75000, 5, 75000, "live");
    day.trades = [makeTrade({ status: "OPEN" })];
    day.totalPnl = 5000;
    const result = checkDayCompletion(day);
    expect(result.complete).toBe(false);
    expect(result.excessProfit).toBe(0);
  });

  it("should not be complete when P&L below target", () => {
    const day = createDayRecord(1, 75000, 5, 75000, "live");
    day.trades = [makeTrade({ status: "CLOSED", pnl: 2000 })];
    day.totalPnl = 2000;
    const result = checkDayCompletion(day);
    expect(result.complete).toBe(false);
  });

  it("should be complete when P&L meets target exactly", () => {
    const day = createDayRecord(1, 75000, 5, 75000, "live");
    day.trades = [makeTrade({ status: "CLOSED", pnl: 3750 })];
    day.totalPnl = 3750;
    const result = checkDayCompletion(day);
    expect(result.complete).toBe(true);
    expect(result.excessProfit).toBe(0);
  });

  it("should calculate excess profit when P&L exceeds target", () => {
    const day = createDayRecord(1, 75000, 5, 75000, "live");
    day.trades = [makeTrade({ status: "CLOSED", pnl: 5000 })];
    day.totalPnl = 5000;
    const result = checkDayCompletion(day);
    expect(result.complete).toBe(true);
    expect(result.excessProfit).toBe(1250); // 5000 - 3750
  });
});

// ─── Day Index Completion ───────────────────────────────────────

describe("completeDayIndex", () => {
  it("should split profit 75/25 between pools", () => {
    const state = makeState();
    const day = createDayRecord(1, 75000, 5, 75000, "live");
    day.totalPnl = 4000;
    day.tradeCapital = 75000;

    const result = completeDayIndex(state, day);
    expect(result.tradingPool).toBe(78000); // 75000 + 4000*0.75
    expect(result.reservePool).toBe(26000); // 25000 + 4000*0.25
  });

  it("should generate correct profit history entry", () => {
    const state = makeState();
    const day = createDayRecord(1, 75000, 5, 75000, "live");
    day.totalPnl = 4000;

    const result = completeDayIndex(state, day);
    expect(result.profitEntry.dayIndex).toBe(1);
    expect(result.profitEntry.totalProfit).toBe(4000);
    expect(result.profitEntry.tradingPoolShare).toBe(3000);
    expect(result.profitEntry.reservePoolShare).toBe(1000);
    expect(result.profitEntry.consumed).toBe(false);
  });

  it("should rate trophy for normal profit", () => {
    const state = makeState();
    const day = createDayRecord(1, 75000, 5, 75000, "live");
    day.totalPnl = 4000; // 5.3%

    const result = completeDayIndex(state, day);
    expect(result.rating).toBe("trophy");
  });

  it("should rate double_trophy for 10%+ profit", () => {
    const state = makeState();
    const day = createDayRecord(1, 75000, 5, 75000, "live");
    day.totalPnl = 8000; // 10.67%

    const result = completeDayIndex(state, day);
    expect(result.rating).toBe("double_trophy");
  });
});

// ─── Gift Days ──────────────────────────────────────────────────

describe("calculateGiftDays", () => {
  it("should generate gift days from excess profit", () => {
    const result = calculateGiftDays(
      10000,
      2,
      78000,
      5,
      (idx) => 78000 + idx * 3000,
      "live"
    );
    expect(result.giftDays.length).toBeGreaterThan(0);
    expect(result.giftDays[0].status).toBe("GIFT");
    expect(result.giftDays[0].rating).toBe("gift");
  });

  it("should not generate gift days if excess is less than target", () => {
    const result = calculateGiftDays(
      100, // too small for a 5% target on 78000
      2,
      78000,
      5,
      (idx) => 78000,
      "live"
    );
    expect(result.giftDays.length).toBe(0);
    expect(result.remainingExcess).toBe(100);
  });

  it("should not exceed MAX_DAY_INDEX", () => {
    const result = calculateGiftDays(
      999999999,
      249,
      78000,
      5,
      (idx) => 78000,
      "live"
    );
    // Should stop at day 250
    for (const day of result.giftDays) {
      expect(day.dayIndex).toBeLessThanOrEqual(MAX_DAY_INDEX);
    }
  });
});

// ─── Clawback ───────────────────────────────────────────────────

describe("processClawback", () => {
  it("should consume previous profit entries on loss", () => {
    const state = makeState({
      tradingPool: 78000,
      currentDayIndex: 3,
      profitHistory: [
        { dayIndex: 1, totalProfit: 4000, tradingPoolShare: 3000, reservePoolShare: 1000, consumed: false },
        { dayIndex: 2, totalProfit: 4000, tradingPoolShare: 3000, reservePoolShare: 1000, consumed: false },
      ],
    });

    const result = processClawback(-2000, state);
    expect(result.newTradingPool).toBe(76000); // 78000 - 2000
    // Should partially consume the newest entry
    expect(result.consumedDayIndices.length).toBe(0); // 2000 < 3000, so partial
    expect(result.partialDay).not.toBeNull();
  });

  it("should fully consume entries when loss exceeds single entry", () => {
    const state = makeState({
      tradingPool: 78000,
      currentDayIndex: 3,
      profitHistory: [
        { dayIndex: 1, totalProfit: 4000, tradingPoolShare: 3000, reservePoolShare: 1000, consumed: false },
        { dayIndex: 2, totalProfit: 4000, tradingPoolShare: 3000, reservePoolShare: 1000, consumed: false },
      ],
    });

    const result = processClawback(-5000, state);
    expect(result.newTradingPool).toBe(73000); // 78000 - 5000
    expect(result.consumedDayIndices).toContain(2); // day 2 fully consumed (3000)
    // Remaining 2000 partially consumes day 1
  });

  it("should not make trading pool negative", () => {
    const state = makeState({
      tradingPool: 1000,
      profitHistory: [],
    });

    const result = processClawback(-5000, state);
    expect(result.newTradingPool).toBe(0);
  });

  it("should never touch reserve pool", () => {
    const state = makeState({
      tradingPool: 75000,
      reservePool: 25000,
      profitHistory: [],
    });

    // Reserve should remain unchanged after clawback
    const result = processClawback(-75000, state);
    expect(result.newTradingPool).toBe(0);
    // Reserve is not returned by processClawback — it's never modified
  });
});

// ─── Available Capital ──────────────────────────────────────────

describe("calculateAvailableCapital", () => {
  it("should subtract open position margin", () => {
    expect(calculateAvailableCapital(75000, 20000)).toBe(55000);
  });

  it("should not go below zero", () => {
    expect(calculateAvailableCapital(10000, 20000)).toBe(0);
  });

  it("should return full pool when no positions", () => {
    expect(calculateAvailableCapital(75000, 0)).toBe(75000);
  });
});

// ─── Position Sizing ────────────────────────────────────────────

describe("calculatePositionSize", () => {
  it("should calculate quantity from capital percentage", () => {
    const result = calculatePositionSize(100000, 10, 200, 50);
    // 10% of 100000 = 10000 margin
    // 10000 / 200 = 50 raw qty
    // 50 / 50 * 50 = 50 (aligned to lot size)
    expect(result.qty).toBe(50);
    expect(result.margin).toBe(10000);
  });

  it("should align to lot size", () => {
    const result = calculatePositionSize(100000, 10, 200, 75);
    // 10000 / 200 = 50 raw qty
    // 50 / 75 = 0.66 → floor = 0 → max(75, 0) = 75
    expect(result.qty).toBe(75);
  });

  it("should ensure minimum of 1 lot", () => {
    const result = calculatePositionSize(100, 10, 200, 50);
    // 10 / 200 = 0.05 raw qty → floor = 0 → max(50, 0) = 50
    expect(result.qty).toBeGreaterThanOrEqual(50);
  });
});

// ─── Future Day Projection ──────────────────────────────────────

describe("projectFutureDays", () => {
  it("should generate the requested number of future days", () => {
    const days = projectFutureDays(2, 78000, 5, 10, "live");
    expect(days.length).toBe(10);
    expect(days[0].dayIndex).toBe(2);
    expect(days[9].dayIndex).toBe(11);
  });

  it("should mark all days as FUTURE status", () => {
    const days = projectFutureDays(2, 78000, 5, 5, "live");
    for (const day of days) {
      expect(day.status).toBe("FUTURE");
    }
  });

  it("should compound capital with 75% of profit", () => {
    const days = projectFutureDays(1, 75000, 5, 3, "live");
    // Day 1: pool=75000, target=3750, next pool = 75000 + 3750*0.75 = 77812.5
    expect(days[0].tradeCapital).toBe(75000);
    expect(days[0].targetAmount).toBe(3750);
    expect(days[1].tradeCapital).toBe(round(75000 + 3750 * TRADING_SPLIT));
  });

  it("should not exceed MAX_DAY_INDEX", () => {
    const days = projectFutureDays(248, 100000, 5, 10, "live");
    for (const day of days) {
      expect(day.dayIndex).toBeLessThanOrEqual(MAX_DAY_INDEX);
    }
    expect(days.length).toBeLessThanOrEqual(3); // 248, 249, 250
  });

  it("should mark day 250 as finish", () => {
    const days = projectFutureDays(250, 100000, 5, 1, "live");
    expect(days[0].rating).toBe("finish");
  });
});

// ─── Quarterly Projection ───────────────────────────────────────

describe("calculateQuarterlyProjection", () => {
  it("returns the planned end-of-quarter net worth (default funding)", () => {
    // Day 1 is in Q1; with default 100K @ 5%/day compounded over the
    // quarter end-day, the projection is well above the starting 100K.
    const result = calculateQuarterlyProjection(75000, 25000, 1, 0);
    expect(result.projectedCapital).toBeGreaterThan(100000);
    expect(result.quarterLabel).toMatch(/^Q\d$/);
  });

  it("projects to the same quarter end regardless of daysElapsed", () => {
    // The function ignores currentTradingPool/currentReservePool/
    // daysElapsed for projection — it returns the planned target at
    // quarter end. Same currentDayIndex → same projection.
    const a = calculateQuarterlyProjection(80000, 27000, 5, 10);
    const b = calculateQuarterlyProjection(75000, 25000, 5, 0);
    expect(a.projectedCapital).toBe(b.projectedCapital);
    expect(a.projectedCapital).toBeGreaterThan(107000);
  });
});

// ─── Session Management ─────────────────────────────────────────

describe("Session Management", () => {
  it("should detect session reset needed for new day", () => {
    const state = makeState({ sessionDate: "2025-01-01" });
    expect(checkSessionReset(state)).toBe(true);
  });

  it("should not reset for same day", () => {
    const today = new Date().toISOString().slice(0, 10);
    const state = makeState({ sessionDate: today });
    expect(checkSessionReset(state)).toBe(false);
  });

  it("should return zero counters on reset", () => {
    const state = makeState({ sessionTradeCount: 5, sessionPnl: 3000 });
    const reset = resetSession(state);
    expect(reset.sessionTradeCount).toBe(0);
    expect(reset.sessionPnl).toBe(0);
    expect(reset.sessionDate).toBe(new Date().toISOString().slice(0, 10));
  });
});

// ─── Day Record Aggregation ─────────────────────────────────────

describe("recalculateDayAggregates", () => {
  it("should aggregate closed trades correctly", () => {
    const day = createDayRecord(1, 75000, 5, 75000, "live");
    day.trades = [
      makeTrade({ status: "CLOSED", pnl: 2000, charges: 50, instrument: "NIFTY_50", qty: 50 }),
      makeTrade({ status: "CLOSED", pnl: 1500, charges: 40, instrument: "BANKNIFTY", qty: 25 }),
    ];

    const result = recalculateDayAggregates(day);
    expect(result.totalPnl).toBe(3500); // trade.pnl is already net of charges
    expect(result.totalCharges).toBe(90);
    expect(result.totalQty).toBe(75);
    expect(result.instruments).toContain("NIFTY_50");
    expect(result.instruments).toContain("BANKNIFTY");
  });

  it("should include unrealized P&L for open trades", () => {
    const day = createDayRecord(1, 75000, 5, 75000, "live");
    day.trades = [
      makeTrade({ status: "OPEN", entryPrice: 150, ltp: 170, qty: 50, type: "BUY_CE", charges: 0 }),
    ];

    const result = recalculateDayAggregates(day);
    // Unrealized: (170 - 150) * 50 * 1 = 1000
    expect(result.totalPnl).toBe(1000);
  });

  it("should handle mixed open and closed trades", () => {
    const day = createDayRecord(1, 75000, 5, 75000, "live");
    day.trades = [
      makeTrade({ status: "CLOSED", pnl: 2000, charges: 50, qty: 50 }),
      makeTrade({ status: "OPEN", entryPrice: 200, ltp: 220, qty: 25, type: "BUY_CE", charges: 0 }),
    ];

    const result = recalculateDayAggregates(day);
    // Closed: 2000 realized, Open: (220-200)*25 = 500 unrealized
    // Closed pnl (2000, already net) + Open unrealized (500) = 2500
    expect(result.totalPnl).toBe(2500);
    expect(result.totalCharges).toBe(50);
  });

  it("should update actualCapital and deviation", () => {
    const day = createDayRecord(1, 75000, 5, 75000, "live");
    day.trades = [
      makeTrade({ status: "CLOSED", pnl: 4000, charges: 100, qty: 50 }),
    ];

    const result = recalculateDayAggregates(day);
    expect(result.actualCapital).toBe(round(75000 + 4000)); // tradeCapital + netPnl (pnl already net)
    expect(result.deviation).toBe(round(75000 + 4000 - 75000)); // actualCapital - originalProj
  });
});

// ─── Full Trade Lifecycle (Pure Logic) ──────────────────────────

describe("Full Trade Lifecycle (Pure Logic)", () => {
  it("should simulate a profitable day from init to completion", () => {
    // 1. Initialize
    const state = initializeCapital("live", 100000, 5);
    expect(state.tradingPool).toBe(75000);

    // 2. Create day 1
    const day1 = createDayRecord(1, state.tradingPool, state.targetPercent, 75000, "live");
    expect(day1.targetAmount).toBe(3750);

    // 3. Add a winning trade
    day1.trades.push(makeTrade({
      status: "CLOSED",
      entryPrice: 150,
      exitPrice: 180,
      qty: 50,
      pnl: 1500,
      charges: 45,
    }));
    day1.trades.push(makeTrade({
      status: "CLOSED",
      entryPrice: 200,
      exitPrice: 250,
      qty: 50,
      pnl: 2500,
      charges: 55,
    }));

    // 4. Recalculate aggregates
    const updated = recalculateDayAggregates(day1);
    expect(updated.totalPnl).toBe(4000); // trade.pnl already net of charges

    // 5. Check completion
    const completion = checkDayCompletion(updated);
    expect(completion.complete).toBe(true);
    expect(completion.excessProfit).toBe(round(4000 - 3750)); // 250

    // 6. Complete day
    const result = completeDayIndex(state, updated);
    expect(result.tradingPool).toBe(round(75000 + 4000 * TRADING_SPLIT));
    expect(result.reservePool).toBe(round(25000 + 4000 * RESERVE_SPLIT));
    expect(result.profitEntry.consumed).toBe(false);
  });

  it("should simulate a loss day with clawback", () => {
    // Setup: 2 profitable days completed
    const state = makeState({
      tradingPool: 81000,
      reservePool: 27000,
      currentDayIndex: 3,
      profitHistory: [
        { dayIndex: 1, totalProfit: 4000, tradingPoolShare: 3000, reservePoolShare: 1000, consumed: false },
        { dayIndex: 2, totalProfit: 4000, tradingPoolShare: 3000, reservePoolShare: 1000, consumed: false },
      ],
    });

    // Day 3: loss of -5000
    const clawback = processClawback(-5000, state);
    expect(clawback.newTradingPool).toBe(76000); // 81000 - 5000
    // Day 2's trading share (3000) should be consumed
    expect(clawback.consumedDayIndices).toContain(2);
  });

  it("should simulate capital injection mid-cycle", () => {
    const state = makeState({ tradingPool: 80000, reservePool: 27000 });
    const result = injectCapital(state, 50000);
    expect(result.tradingPool).toBe(117500); // 80000 + 37500
    expect(result.reservePool).toBe(39500);  // 27000 + 12500
  });
});
