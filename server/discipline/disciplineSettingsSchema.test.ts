/**
 * Tests for the strict zod schema on discipline.updateSettings (B9).
 */
import { describe, it, expect } from "vitest";
import { disciplineSettingsUpdateSchema } from "./disciplineRouter";

describe("disciplineSettingsUpdateSchema (B9)", () => {
  it("accepts a valid partial update", () => {
    const result = disciplineSettingsUpdateSchema.safeParse({
      dailyLossLimit: { enabled: true, thresholdPercent: 3 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full valid payload", () => {
    const full = {
      dailyLossLimit: { enabled: true, thresholdPercent: 3 },
      maxConsecutiveLosses: { enabled: true, maxLosses: 3, cooldownMinutes: 30 },
      maxTradesPerDay: { enabled: true, limit: 5 },
      maxOpenPositions: { enabled: true, limit: 3 },
      revengeCooldown: { enabled: true, durationMinutes: 15, requireAcknowledgment: true },
      noTradingAfterOpen: { enabled: true, nseMinutes: 15, mcxMinutes: 15 },
      noTradingBeforeClose: { enabled: true, nseMinutes: 15, mcxMinutes: 15 },
      lunchBreakPause: { enabled: false, startTime: "12:30", endTime: "13:30" },
      preTradeGate: {
        enabled: true,
        minRiskReward: { enabled: true, ratio: 1.5 },
        emotionalStateCheck: { enabled: true, blockStates: ["revenge", "fomo"] as const },
      },
      maxPositionSize: { enabled: true, percentOfCapital: 40 },
      maxTotalExposure: { enabled: true, percentOfCapital: 80 },
      journalEnforcement: { enabled: true, maxUnjournaled: 3 },
      weeklyReview: { enabled: true, disciplineScoreWarning: 70, redWeekReduction: 3 },
      winningStreakReminder: { enabled: true, triggerAfterDays: 5 },
      losingStreakAutoReduce: { enabled: true, triggerAfterDays: 3, reduceByPercent: 50 },
    };
    const result = disciplineSettingsUpdateSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  it("rejects unknown top-level fields", () => {
    const result = disciplineSettingsUpdateSchema.safeParse({
      dailyLossLimit: { enabled: true, thresholdPercent: 3 },
      randomField: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown sub-object fields", () => {
    const result = disciplineSettingsUpdateSchema.safeParse({
      dailyLossLimit: { enabled: true, thresholdPercent: 3, sneaky: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative thresholdPercent", () => {
    const result = disciplineSettingsUpdateSchema.safeParse({
      dailyLossLimit: { enabled: true, thresholdPercent: -50 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects thresholdPercent above 100", () => {
    const result = disciplineSettingsUpdateSchema.safeParse({
      dailyLossLimit: { enabled: true, thresholdPercent: 150 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric cooldownMinutes", () => {
    const result = disciplineSettingsUpdateSchema.safeParse({
      maxConsecutiveLosses: { enabled: true, maxLosses: 3, cooldownMinutes: "yes" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed lunch-break time", () => {
    const result = disciplineSettingsUpdateSchema.safeParse({
      lunchBreakPause: { enabled: true, startTime: "12:30 pm", endTime: "13:30" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown emotional state in blockStates", () => {
    const result = disciplineSettingsUpdateSchema.safeParse({
      preTradeGate: {
        enabled: true,
        minRiskReward: { enabled: true, ratio: 1.5 },
        emotionalStateCheck: { enabled: true, blockStates: ["furious"] },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty payload as missing-rejection? No — empty partial is valid", () => {
    // Edge case: empty object is a no-op update; allowed since every field is optional.
    const result = disciplineSettingsUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
