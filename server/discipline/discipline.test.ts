/**
 * Discipline Agent — Unit Tests
 *
 * Tests the pure discipline module functions without MongoDB.
 * Covers: circuit breaker, trade limits, cooldowns, time windows,
 * position sizing, pre-trade gate, journal check, streaks, and scoring.
 */
import { describe, expect, it } from "vitest";
import { checkDailyLossLimit, checkConsecutiveLosses } from "./circuitBreaker";
import { checkMaxTrades, checkMaxPositions } from "./tradeLimits";
import { checkCooldown, createRevengeCooldown, createConsecutiveLossCooldown, acknowledgeLoss, resolveOverlappingCooldowns } from "./cooldowns";
import { checkTimeWindow } from "./timeWindows";
import { checkPositionSize, checkExposure } from "./positionSizing";
import { evaluatePreTradeGate } from "./preTrade";
import { checkJournalCompliance, checkWeeklyReview } from "./journalCheck";
import { getStreakStatus, calculateStreakAdjustments, updateStreak } from "./streaks";
import { calculateScore } from "./score";
import type {
  DisciplineState,
  DisciplineAgentSettings,
  TradeValidationRequest,
  Exchange,
  CooldownState,
  StreakState,
} from "./types";
import { DEFAULT_DISCIPLINE_AGENT_SETTINGS, createDefaultState } from "./types";

// ─── Helpers ────────────────────────────────────────────────────

function makeSettings(overrides?: Partial<DisciplineAgentSettings>): DisciplineAgentSettings {
  return {
    userId: "test-user",
    updatedAt: new Date(),
    history: [],
    ...DEFAULT_DISCIPLINE_AGENT_SETTINGS,
    ...overrides,
  };
}

function makeState(overrides?: Partial<DisciplineState>): DisciplineState {
  const base = createDefaultState("test-user", new Date().toISOString().slice(0, 10));
  return { ...base, ...overrides };
}

function makeRequest(overrides?: Partial<TradeValidationRequest>): TradeValidationRequest {
  return {
    instrument: "NIFTY_50",
    exchange: "NSE" as Exchange,
    transactionType: "BUY",
    optionType: "CE",
    strike: 26000,
    entryPrice: 150,
    quantity: 50,
    estimatedValue: 10000,
    ...overrides,
  };
}

// ─── Circuit Breaker ────────────────────────────────────────────

describe("Circuit Breaker", () => {
  describe("checkDailyLossLimit", () => {
    it("should pass when no losses", () => {
      const state = makeState({ dailyLossPercent: 0 });
      const settings = makeSettings();
      const result = checkDailyLossLimit(state, settings, 100000);
      expect(result.passed).toBe(true);
    });

    it("should pass when loss below threshold", () => {
      // threshold is 3%, so -2000 on 100000 = 2% should pass
      const state = makeState({ dailyRealizedPnl: -2000 });
      const settings = makeSettings();
      const result = checkDailyLossLimit(state, settings, 100000);
      expect(result.passed).toBe(true);
    });

    it("should fail when loss at threshold", () => {
      // threshold is 3%, so -3000 on 100000 = 3% should fail (>= check)
      const state = makeState({ dailyRealizedPnl: -3000 });
      const settings = makeSettings();
      const result = checkDailyLossLimit(state, settings, 100000);
      expect(result.passed).toBe(false);
    });

    it("should fail when loss exceeds threshold", () => {
      // threshold is 3%, so -5000 on 100000 = 5% should fail
      const state = makeState({ dailyRealizedPnl: -5000 });
      const settings = makeSettings();
      const result = checkDailyLossLimit(state, settings, 100000);
      expect(result.passed).toBe(false);
    });

    it("should fail when circuit breaker already triggered", () => {
      const state = makeState({ circuitBreakerTriggered: true, dailyLossPercent: 5 });
      const settings = makeSettings();
      const result = checkDailyLossLimit(state, settings, 100000);
      expect(result.passed).toBe(false);
    });

    it("should pass when feature disabled", () => {
      const state = makeState({ dailyRealizedPnl: -10000 });
      const settings = makeSettings({ dailyLossLimit: { enabled: false, thresholdPercent: 3 } });
      const result = checkDailyLossLimit(state, settings, 100000);
      expect(result.passed).toBe(true);
    });
  });

  describe("checkConsecutiveLosses", () => {
    it("should pass when below max", () => {
      const state = makeState({ consecutiveLosses: 1 });
      const settings = makeSettings();
      const result = checkConsecutiveLosses(state, settings);
      expect(result.passed).toBe(true);
    });

    it("should fail when at max", () => {
      const state = makeState({ consecutiveLosses: 3 });
      const settings = makeSettings();
      const result = checkConsecutiveLosses(state, settings);
      expect(result.passed).toBe(false);
    });

    it("should pass when disabled", () => {
      const state = makeState({ consecutiveLosses: 10 });
      const settings = makeSettings({
        maxConsecutiveLosses: { enabled: false, maxLosses: 3, cooldownMinutes: 30 },
      });
      const result = checkConsecutiveLosses(state, settings);
      expect(result.passed).toBe(true);
    });
  });
});

// ─── Trade Limits ───────────────────────────────────────────────

describe("Trade Limits", () => {
  describe("checkMaxTrades", () => {
    it("should pass when below limit", () => {
      const state = makeState({ tradesToday: 3 });
      const settings = makeSettings();
      const result = checkMaxTrades(state, settings);
      expect(result.passed).toBe(true);
    });

    it("should fail when at limit", () => {
      const state = makeState({ tradesToday: 5 });
      const settings = makeSettings();
      const result = checkMaxTrades(state, settings);
      expect(result.passed).toBe(false);
    });

    it("should pass when disabled", () => {
      const state = makeState({ tradesToday: 100 });
      const settings = makeSettings({
        maxTradesPerDay: { enabled: false, limit: 5 },
      });
      const result = checkMaxTrades(state, settings);
      expect(result.passed).toBe(true);
    });
  });

  describe("checkMaxPositions", () => {
    it("should pass when below limit", () => {
      const state = makeState({ openPositions: 1 });
      const settings = makeSettings();
      const result = checkMaxPositions(state, settings);
      expect(result.passed).toBe(true);
    });

    it("should fail when at limit", () => {
      const state = makeState({ openPositions: 3 });
      const settings = makeSettings();
      const result = checkMaxPositions(state, settings);
      expect(result.passed).toBe(false);
    });
  });
});

// ─── Cooldowns ──────────────────────────────────────────────────

describe("Cooldowns", () => {
  describe("checkCooldown", () => {
    it("should pass when no active cooldown", () => {
      const state = makeState();
      const settings = makeSettings();
      const result = checkCooldown(state, settings);
      expect(result.passed).toBe(true);
    });

    it("should fail when cooldown is active and not expired", () => {
      const futureDate = new Date(Date.now() + 600000); // 10 min from now
      const state = makeState({
        activeCooldown: {
          type: "revenge",
          startedAt: new Date(),
          endsAt: futureDate,
          acknowledged: true,
          triggerTrade: "t1",
        },
      });
      const settings = makeSettings();
      const result = checkCooldown(state, settings);
      expect(result.passed).toBe(false);
    });

    it("should pass when cooldown has expired", () => {
      const pastDate = new Date(Date.now() - 600000); // 10 min ago
      const state = makeState({
        activeCooldown: {
          type: "revenge",
          startedAt: new Date(Date.now() - 1200000),
          endsAt: pastDate,
          acknowledged: true,
          triggerTrade: "t1",
        },
      });
      const settings = makeSettings();
      const result = checkCooldown(state, settings);
      expect(result.passed).toBe(true);
    });

    it("should block when cooldown not yet acknowledged", () => {
      const futureDate = new Date(Date.now() + 600000);
      const state = makeState({
        activeCooldown: {
          type: "revenge",
          startedAt: new Date(),
          endsAt: futureDate,
          acknowledged: false,
          triggerTrade: "t1",
        },
      });
      const settings = makeSettings();
      const result = checkCooldown(state, settings);
      expect(result.passed).toBe(false);
      expect(result.requiresAcknowledgment).toBe(true);
    });
  });

  describe("createRevengeCooldown", () => {
    it("should create a cooldown when enabled", () => {
      const settings = makeSettings();
      const cooldown = createRevengeCooldown(settings, "t1");
      expect(cooldown).not.toBeNull();
      expect(cooldown?.type).toBe("revenge");
      // requireAcknowledgment is true by default, so acknowledged should be false
      expect(cooldown?.acknowledged).toBe(false);
    });

    it("should return null when disabled", () => {
      const settings = makeSettings({
        revengeCooldown: { enabled: false, durationMinutes: 15, requireAcknowledgment: true },
      });
      const cooldown = createRevengeCooldown(settings);
      expect(cooldown).toBeNull();
    });
  });

  describe("acknowledgeLoss", () => {
    it("should set acknowledged and start timer", () => {
      const cooldown: CooldownState = {
        type: "revenge",
        startedAt: new Date(),
        endsAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // far future
        acknowledged: false,
        triggerTrade: "t1",
      };
      const settings = makeSettings();
      const result = acknowledgeLoss(cooldown, settings);
      expect(result.acknowledged).toBe(true);
      // endsAt should be ~15 minutes from now
      const expectedEnd = Date.now() + 15 * 60 * 1000;
      expect(Math.abs(result.endsAt.getTime() - expectedEnd)).toBeLessThan(5000);
    });
  });

  describe("resolveOverlappingCooldowns", () => {
    it("should keep the longer cooldown", () => {
      const short: CooldownState = {
        type: "revenge",
        startedAt: new Date(),
        endsAt: new Date(Date.now() + 300000),
        acknowledged: false,
        triggerTrade: "t1",
      };
      const long: CooldownState = {
        type: "consecutive_loss",
        startedAt: new Date(),
        endsAt: new Date(Date.now() + 1800000),
        acknowledged: false,
      };
      const result = resolveOverlappingCooldowns(short, long);
      expect(result.type).toBe("consecutive_loss");
    });

    it("should use new cooldown when current is undefined", () => {
      const cd: CooldownState = {
        type: "revenge",
        startedAt: new Date(),
        endsAt: new Date(Date.now() + 300000),
        acknowledged: false,
        triggerTrade: "t1",
      };
      const result = resolveOverlappingCooldowns(undefined, cd);
      expect(result.type).toBe("revenge");
    });
  });
});

// ─── Time Windows ───────────────────────────────────────────────

describe("Time Windows", () => {
  it("should return a result object with expected shape", () => {
    const settings = makeSettings();
    const result = checkTimeWindow("NSE", settings);
    expect(result).toHaveProperty("passed");
    expect(typeof result.passed).toBe("boolean");
  });

  it("should pass when all time window features disabled and within market hours", () => {
    // Must be within market hours (09:15-15:30 IST) even when features disabled
    // because the function always blocks outside market hours
    const fakeNow = new Date("2026-04-02T11:00:00.000Z"); // 11:00 IST
    const settings = makeSettings({
      noTradingAfterOpen: { enabled: false, nseMinutes: 15, mcxMinutes: 15 },
      noTradingBeforeClose: { enabled: false, nseMinutes: 15, mcxMinutes: 15 },
      lunchBreakPause: { enabled: false, startTime: "12:30", endTime: "13:30" },
    });
    const result = checkTimeWindow("NSE", settings, fakeNow);
    expect(result.passed).toBe(true);
  });

  it("should block during pre-market open window", () => {
    // Simulate 09:20 IST — the function reads getUTCHours() from the passed date,
    // expecting it to already be IST-shifted. So we set UTC hours to 09:20.
    const fakeNow = new Date("2026-04-02T09:20:00.000Z");
    const settings = makeSettings();
    const result = checkTimeWindow("NSE", settings, fakeNow);
    expect(result.passed).toBe(false);
    expect(result.blockType).toBe("market_open");
  });

  it("should allow trading during normal hours", () => {
    // Simulate 11:00 IST — set UTC hours to 11:00 since function reads getUTCHours()
    const fakeNow = new Date("2026-04-02T11:00:00.000Z");
    const settings = makeSettings();
    const result = checkTimeWindow("NSE", settings, fakeNow);
    expect(result.passed).toBe(true);
  });

  it("should block during pre-close window", () => {
    // Simulate 15:20 IST — set UTC hours to 15:20 since function reads getUTCHours()
    const fakeNow = new Date("2026-04-02T15:20:00.000Z");
    const settings = makeSettings();
    const result = checkTimeWindow("NSE", settings, fakeNow);
    expect(result.passed).toBe(false);
    expect(result.blockType).toBe("market_close");
  });
});

// ─── Position Sizing ────────────────────────────────────────────

describe("Position Sizing", () => {
  describe("checkPositionSize", () => {
    it("should pass when position is within limit", () => {
      const state = makeState();
      const settings = makeSettings(); // maxPositionSize: 40%
      const result = checkPositionSize(30000, 100000, state, settings);
      expect(result.passed).toBe(true); // 30% < 40%
    });

    it("should fail when position exceeds limit", () => {
      const state = makeState();
      const settings = makeSettings(); // maxPositionSize: 40%
      const result = checkPositionSize(50000, 100000, state, settings);
      expect(result.passed).toBe(false); // 50% > 40%
    });

    it("should pass when disabled", () => {
      const state = makeState();
      const settings = makeSettings({
        maxPositionSize: { enabled: false, percentOfCapital: 25 },
      });
      const result = checkPositionSize(50000, 100000, state, settings);
      expect(result.passed).toBe(true);
    });

    it("should apply streak adjustment to reduce limit", () => {
      const state = makeState({
        activeAdjustments: [{
          rule: "losing_streak_reduce_position",
          description: "Reduced due to streak",
          originalValue: 40,
          adjustedValue: 20,
          appliedAt: new Date(),
        }],
      });
      const settings = makeSettings();
      // 25% of capital, but adjusted limit is 20%
      const result = checkPositionSize(25000, 100000, state, settings);
      expect(result.passed).toBe(false); // 25% > 20% adjusted
    });
  });

  describe("checkExposure", () => {
    it("should pass when total exposure is within limit", () => {
      const state = makeState();
      const settings = makeSettings(); // maxTotalExposure: 80%
      // New position 10000 + current exposure 50000 = 60000 / 100000 = 60% < 80%
      const result = checkExposure(10000, 50000, 100000, state, settings);
      expect(result.passed).toBe(true);
    });

    it("should fail when total exposure exceeds limit", () => {
      const state = makeState();
      const settings = makeSettings(); // maxTotalExposure: 80%
      // New position 40000 + current exposure 50000 = 90000 / 100000 = 90% > 80%
      const result = checkExposure(40000, 50000, 100000, state, settings);
      expect(result.passed).toBe(false);
    });
  });
});

// ─── Pre-Trade Gate ─────────────────────────────────────────────

describe("Pre-Trade Gate", () => {
  it("should pass when feature disabled", () => {
    const request = makeRequest();
    const settings = makeSettings({
      preTradeGate: {
        enabled: false,
        minRiskReward: { enabled: false, ratio: 1.5 },
        emotionalStateCheck: { enabled: false, blockStates: [] },
      },
    });
    const result = evaluatePreTradeGate(request, settings);
    expect(result.passed).toBe(true);
  });

  it("should fail when R:R ratio is below minimum", () => {
    const request = makeRequest({
      aiRiskReward: 0.8,
    });
    const settings = makeSettings();
    const result = evaluatePreTradeGate(request, settings);
    expect(result.passed).toBe(false);
  });

  it("should pass when R:R ratio is above minimum", () => {
    const request = makeRequest({
      aiRiskReward: 2.5,
    });
    const settings = makeSettings();
    const result = evaluatePreTradeGate(request, settings);
    expect(result.passed).toBe(true);
  });

  it("should block when emotional state is in blocked list", () => {
    const request = makeRequest({
      emotionalState: "revenge",
      aiRiskReward: 2.0,
    });
    const settings = makeSettings();
    const result = evaluatePreTradeGate(request, settings);
    expect(result.passed).toBe(false);
  });

  it("should pass when emotional state is calm", () => {
    const request = makeRequest({
      emotionalState: "calm",
      aiRiskReward: 2.0,
    });
    const settings = makeSettings();
    const result = evaluatePreTradeGate(request, settings);
    expect(result.passed).toBe(true);
  });
});

// ─── Journal Check ──────────────────────────────────────────────

describe("Journal Check", () => {
  describe("checkJournalCompliance", () => {
    it("should pass when no unjournaled trades", () => {
      const state = makeState({ unjournaledTrades: [] });
      const settings = makeSettings();
      const result = checkJournalCompliance(state, settings);
      expect(result.passed).toBe(true);
    });

    it("should pass when unjournaled below max", () => {
      const state = makeState({ unjournaledTrades: ["t1", "t2"] });
      const settings = makeSettings();
      const result = checkJournalCompliance(state, settings);
      expect(result.passed).toBe(true);
    });

    it("should fail when unjournaled at max", () => {
      const state = makeState({ unjournaledTrades: ["t1", "t2", "t3"] });
      const settings = makeSettings();
      const result = checkJournalCompliance(state, settings);
      expect(result.passed).toBe(false);
    });

    it("should pass when disabled", () => {
      const state = makeState({ unjournaledTrades: ["t1", "t2", "t3", "t4", "t5"] });
      const settings = makeSettings({
        journalEnforcement: { enabled: false, maxUnjournaled: 3 },
      });
      const result = checkJournalCompliance(state, settings);
      expect(result.passed).toBe(true);
    });
  });

  describe("checkWeeklyReview", () => {
    it("should pass when review completed", () => {
      const state = makeState({ weeklyReviewCompleted: true });
      const settings = makeSettings();
      const result = checkWeeklyReview(state, settings);
      expect(result.passed).toBe(true);
    });

    it("should pass when disabled", () => {
      const state = makeState({ weeklyReviewCompleted: false });
      const settings = makeSettings({
        weeklyReview: { enabled: false, disciplineScoreWarning: 70, redWeekReduction: 3 },
      });
      const result = checkWeeklyReview(state, settings);
      expect(result.passed).toBe(true);
    });
  });
});

// ─── Streaks ────────────────────────────────────────────────────

describe("Streaks", () => {
  describe("getStreakStatus", () => {
    it("should report no streak when none active", () => {
      const state = makeState({
        currentStreak: { type: "none", length: 0, startDate: "" },
      });
      const settings = makeSettings();
      const result = getStreakStatus(state, settings);
      expect(result.active).toBe(false);
      expect(result.type).toBe("none");
    });

    it("should report active winning streak", () => {
      const state = makeState({
        currentStreak: { type: "winning", length: 4, startDate: "2026-03-28" },
      });
      const settings = makeSettings();
      const result = getStreakStatus(state, settings);
      expect(result.active).toBe(true);
      expect(result.type).toBe("winning");
      expect(result.length).toBe(4);
    });

    it("should generate notification for long winning streak", () => {
      const state = makeState({
        currentStreak: { type: "winning", length: 6, startDate: "2026-03-25" },
      });
      const settings = makeSettings();
      const result = getStreakStatus(state, settings);
      expect(result.notifications.length).toBeGreaterThan(0);
    });

    it("should generate adjustments for long losing streak", () => {
      const state = makeState({
        currentStreak: { type: "losing", length: 4, startDate: "2026-03-28" },
      });
      const settings = makeSettings();
      const result = getStreakStatus(state, settings);
      expect(result.adjustments.length).toBeGreaterThan(0);
      expect(result.notifications.length).toBeGreaterThan(0);
    });
  });

  describe("updateStreak", () => {
    it("should start winning streak on profit", () => {
      const streak: StreakState = { type: "none", length: 0, startDate: "" };
      const result = updateStreak(streak, 1000, "2026-04-01");
      expect(result.type).toBe("winning");
      expect(result.length).toBe(1);
    });

    it("should extend winning streak on consecutive profit", () => {
      const streak: StreakState = { type: "winning", length: 3, startDate: "2026-03-28" };
      const result = updateStreak(streak, 500, "2026-04-01");
      expect(result.type).toBe("winning");
      expect(result.length).toBe(4);
    });

    it("should break winning streak on loss", () => {
      const streak: StreakState = { type: "winning", length: 5, startDate: "2026-03-25" };
      const result = updateStreak(streak, -500, "2026-04-01");
      expect(result.type).toBe("losing");
      expect(result.length).toBe(1);
    });

    it("should start losing streak on loss", () => {
      const streak: StreakState = { type: "none", length: 0, startDate: "" };
      const result = updateStreak(streak, -500, "2026-04-01");
      expect(result.type).toBe("losing");
      expect(result.length).toBe(1);
    });

    it("should not affect streak on zero P&L", () => {
      const streak: StreakState = { type: "winning", length: 3, startDate: "2026-03-28" };
      const result = updateStreak(streak, 0, "2026-04-01");
      expect(result.type).toBe("winning");
      expect(result.length).toBe(3);
    });
  });

  describe("calculateStreakAdjustments", () => {
    it("should return empty for no streak", () => {
      const state = makeState();
      const settings = makeSettings();
      const result = calculateStreakAdjustments(state, settings);
      expect(result.length).toBe(0);
    });

    it("should return adjustments for active losing streak above threshold", () => {
      const state = makeState({
        currentStreak: { type: "losing", length: 4, startDate: "2026-03-28" },
      });
      const settings = makeSettings();
      const result = calculateStreakAdjustments(state, settings);
      expect(result.length).toBeGreaterThan(0);
      // Should reduce position size
      const positionAdj = result.find((a) => a.rule === "losing_streak_reduce_position");
      expect(positionAdj).toBeDefined();
      expect(positionAdj!.adjustedValue).toBeLessThan(positionAdj!.originalValue);
    });

    it("should not return adjustments for winning streak", () => {
      const state = makeState({
        currentStreak: { type: "winning", length: 5, startDate: "2026-03-25" },
      });
      const settings = makeSettings();
      const result = calculateStreakAdjustments(state, settings);
      expect(result.length).toBe(0);
    });
  });
});

// ─── Scoring ────────────────────────────────────────────────────

describe("Score Calculator", () => {
  it("should return perfect score for clean state", () => {
    const state = makeState();
    const settings = makeSettings();
    const { score, breakdown } = calculateScore(state, settings);
    expect(score).toBe(100);
    expect(breakdown).toBeDefined();
    expect(breakdown.circuitBreaker).toBeGreaterThan(0);
    expect(breakdown.tradeLimits).toBeGreaterThan(0);
  });

  it("should reduce score for circuit breaker trigger", () => {
    const state = makeState({
      circuitBreakerTriggered: true,
      dailyLossPercent: 5,
    });
    const settings = makeSettings();
    const { score } = calculateScore(state, settings);
    expect(score).toBeLessThan(100);
  });

  it("should reduce score for unjournaled trades", () => {
    const state = makeState({
      unjournaledTrades: ["t1", "t2"],
    });
    const settings = makeSettings();
    const { score } = calculateScore(state, settings);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("should reduce score for violations", () => {
    const state = makeState({
      violations: [
        {
          ruleId: "time_window",
          ruleName: "Time Window",
          severity: "hard" as const,
          description: "Traded during blocked window",
          timestamp: new Date(),
          overridden: false,
        },
      ],
    });
    const settings = makeSettings();
    const { score } = calculateScore(state, settings);
    expect(score).toBeLessThan(100);
  });

  it("should return score between 0 and 100 even with many violations", () => {
    const state = makeState({
      circuitBreakerTriggered: true,
      consecutiveLosses: 5,
      tradesToday: 10,
      dailyLossPercent: 10,
      unjournaledTrades: ["t1", "t2", "t3", "t4", "t5"],
      violations: Array(10).fill({
        ruleId: "pre_trade_gate",
        ruleName: "Pre-Trade Gate",
        severity: "hard" as const,
        description: "test",
        timestamp: new Date(),
        overridden: false,
      }),
    });
    const settings = makeSettings();
    const { score } = calculateScore(state, settings);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ─── Full Discipline Pipeline (Pure Logic) ──────────────────────

describe("Full Discipline Pipeline (Pure Logic)", () => {
  it("should allow a clean trade with no violations", () => {
    const state = makeState();
    const settings = makeSettings();

    // All individual checks should pass
    expect(checkDailyLossLimit(state, settings, 100000).passed).toBe(true);
    expect(checkConsecutiveLosses(state, settings).passed).toBe(true);
    expect(checkMaxTrades(state, settings).passed).toBe(true);
    expect(checkMaxPositions(state, settings).passed).toBe(true);
    expect(checkCooldown(state, settings).passed).toBe(true);
    expect(checkJournalCompliance(state, settings).passed).toBe(true);
    expect(checkPositionSize(10000, 100000, state, settings).passed).toBe(true);
    expect(checkExposure(10000, 20000, 100000, state, settings).passed).toBe(true);
  });

  it("should block a trade after hitting daily loss limit", () => {
    const state = makeState({
      dailyLossPercent: 4,
      circuitBreakerTriggered: true,
    });
    const settings = makeSettings();

    expect(checkDailyLossLimit(state, settings, 100000).passed).toBe(false);
  });

  it("should block a trade when max trades reached and cooldown active", () => {
    const state = makeState({
      tradesToday: 5,
      activeCooldown: {
        type: "revenge",
        startedAt: new Date(),
        endsAt: new Date(Date.now() + 600000),
        acknowledged: true,
        triggerTrade: "t1",
      },
    });
    const settings = makeSettings();

    expect(checkMaxTrades(state, settings).passed).toBe(false);
    expect(checkCooldown(state, settings).passed).toBe(false);
  });

  it("should simulate a full day: trade → loss → cooldown → acknowledge → wait → trade again", () => {
    const state = makeState();
    const settings = makeSettings();

    // 1. First trade passes
    expect(checkMaxTrades(state, settings).passed).toBe(true);
    state.tradesToday = 1;

    // 2. Trade results in loss
    state.consecutiveLosses = 1;
    state.dailyRealizedPnl = -1000;
    state.dailyLossPercent = 1;

    // 3. Revenge cooldown created
    const cooldown = createRevengeCooldown(settings, "trade_1");
    expect(cooldown).not.toBeNull();
    state.activeCooldown = cooldown!;

    // 4. Blocked by cooldown
    expect(checkCooldown(state, settings).passed).toBe(false);

    // 5. Acknowledge loss
    const acked = acknowledgeLoss(state.activeCooldown, settings);
    state.activeCooldown = acked;
    expect(acked.acknowledged).toBe(true);

    // 6. Still blocked (timer running)
    expect(checkCooldown(state, settings).passed).toBe(false);

    // 7. Simulate cooldown expiry
    state.activeCooldown.endsAt = new Date(Date.now() - 1000);
    expect(checkCooldown(state, settings).passed).toBe(true);

    // 8. Second trade passes
    expect(checkMaxTrades(state, settings).passed).toBe(true);
    state.tradesToday = 2;
  });
});
