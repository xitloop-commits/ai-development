/**
 * Discipline Score Calculator
 *
 * Weighted average of adherence to all enabled rules. Score ranges from 0 to 100.
 * Disabled rules have their weight redistributed proportionally.
 *
 * Weight Distribution:
 *   Circuit Breaker:  20%  (max 20 pts)
 *   Trade Limits:     15%  (max 15 pts)
 *   Cooldowns:        15%  (max 15 pts)
 *   Time Windows:     10%  (max 10 pts)
 *   Position Sizing:  15%  (max 15 pts)
 *   Journal:          10%  (max 10 pts)
 *   Pre-Trade Gate:   15%  (max 15 pts)
 */

import type { DisciplineState, DisciplineEngineSettings, ScoreBreakdown } from "./types";

interface CategoryWeight {
  key: keyof ScoreBreakdown;
  baseWeight: number;
  isEnabled: (s: DisciplineEngineSettings) => boolean;
  calculate: (state: DisciplineState, settings: DisciplineEngineSettings) => number;
}

const CATEGORIES: CategoryWeight[] = [
  {
    key: "circuitBreaker",
    baseWeight: 20,
    isEnabled: (s) => s.dailyLossLimit.enabled || s.maxConsecutiveLosses.enabled,
    calculate: (state, settings) => {
      if (!settings.dailyLossLimit.enabled) return 20;

      // Full points if daily loss < 50% of limit
      const threshold = settings.dailyLossLimit.thresholdPercent;
      const lossPercent = Math.abs(Math.min(state.dailyLossPercent, 0));

      if (state.circuitBreakerTriggered) return 0;
      if (lossPercent === 0) return 20;
      if (lossPercent < threshold * 0.5) return 20;

      // Linear reduction from 50% to 100% of limit
      const ratio = (lossPercent - threshold * 0.5) / (threshold * 0.5);
      return Math.max(0, Math.round(20 * (1 - ratio)));
    },
  },
  {
    key: "tradeLimits",
    baseWeight: 15,
    isEnabled: (s) => s.maxTradesPerDay.enabled || s.maxOpenPositions.enabled,
    calculate: (state, settings) => {
      if (!settings.maxTradesPerDay.enabled) return 15;

      const limit = settings.maxTradesPerDay.limit;
      const used = state.tradesToday;

      if (used >= limit) return 0;
      if (used < limit * 0.6) return 15;

      // Linear reduction from 60% to 100%
      const ratio = (used - limit * 0.6) / (limit * 0.4);
      return Math.max(0, Math.round(15 * (1 - ratio)));
    },
  },
  {
    key: "cooldowns",
    baseWeight: 15,
    isEnabled: (s) => s.revengeCooldown.enabled || s.maxConsecutiveLosses.enabled,
    calculate: (state) => {
      // Full points if no cooldowns triggered today
      const cooldownViolations = state.violations.filter(
        (v) => v.ruleId === "revenge_cooldown" || v.ruleId === "consecutive_loss_cooldown"
      );
      return Math.max(0, 15 - cooldownViolations.length * 5);
    },
  },
  {
    key: "timeWindows",
    baseWeight: 10,
    isEnabled: (s) => s.noTradingAfterOpen.enabled || s.noTradingBeforeClose.enabled || s.lunchBreakPause.enabled,
    calculate: (state) => {
      // Full points if no time window violations
      const twViolations = state.violations.filter((v) => v.ruleId === "time_window");
      return twViolations.length === 0 ? 10 : 0;
    },
  },
  {
    key: "positionSizing",
    baseWeight: 15,
    isEnabled: (s) => s.maxPositionSize.enabled || s.maxTotalExposure.enabled,
    calculate: (state) => {
      // Full points if no position sizing violations
      const psViolations = state.violations.filter(
        (v) => v.ruleId === "position_size" || v.ruleId === "total_exposure"
      );
      if (psViolations.length > 0) return 0;

      // Check if all trades were under 80% of max
      const nearLimitViolations = state.violations.filter((v) => v.ruleId === "position_near_limit");
      return Math.max(0, 15 - nearLimitViolations.length * 3);
    },
  },
  {
    key: "journal",
    baseWeight: 10,
    isEnabled: (s) => s.journalEnforcement.enabled,
    calculate: (state) => {
      // Full points if all trades journaled same day
      const unjournaled = state.unjournaledTrades.length;
      return Math.max(0, 10 - unjournaled * 3);
    },
  },
  {
    key: "preTradeGate",
    baseWeight: 15,
    isEnabled: (s) => s.preTradeGate.enabled,
    calculate: (state) => {
      // Full points if all gate checks passed
      const softOverrides = state.violations.filter(
        (v) => v.ruleId === "pre_trade_gate" && v.severity === "soft" && v.overridden
      );
      const hardBlocks = state.violations.filter(
        (v) => v.ruleId === "pre_trade_gate" && v.severity === "hard"
      );
      return Math.max(0, 15 - softOverrides.length * 3 - hardBlocks.length * 5);
    },
  },
];

/**
 * Calculate the discipline score and breakdown.
 */
export function calculateScore(
  state: DisciplineState,
  settings: DisciplineEngineSettings
): { score: number; breakdown: ScoreBreakdown } {
  // Determine which categories are enabled
  const enabledCategories = CATEGORIES.filter((c) => c.isEnabled(settings));
  const disabledCategories = CATEGORIES.filter((c) => !c.isEnabled(settings));

  // Redistribute disabled weights proportionally
  const totalEnabledWeight = enabledCategories.reduce((sum, c) => sum + c.baseWeight, 0);
  const totalDisabledWeight = disabledCategories.reduce((sum, c) => sum + c.baseWeight, 0);

  const breakdown: ScoreBreakdown = {
    circuitBreaker: 0,
    tradeLimits: 0,
    cooldowns: 0,
    timeWindows: 0,
    positionSizing: 0,
    journal: 0,
    preTradeGate: 0,
  };

  let totalScore = 0;

  for (const category of enabledCategories) {
    // Scale the weight to account for disabled categories
    const scaleFactor = totalEnabledWeight > 0 ? (category.baseWeight + (totalDisabledWeight * category.baseWeight) / totalEnabledWeight) / category.baseWeight : 1;
    const rawScore = category.calculate(state, settings);
    const scaledScore = rawScore * scaleFactor;

    breakdown[category.key] = Math.round(scaledScore * 10) / 10;
    totalScore += scaledScore;
  }

  // For disabled categories, give full marks (they don't penalize)
  for (const category of disabledCategories) {
    breakdown[category.key] = category.baseWeight;
  }

  return {
    score: Math.round(Math.min(100, Math.max(0, totalScore))),
    breakdown,
  };
}
