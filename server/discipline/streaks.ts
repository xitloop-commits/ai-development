/**
 * Module 7: Streaks & Auto-Adjustments
 *
 * - Winning streak reminder: soft notification after N consecutive profitable days
 * - Losing streak auto-reduce: automatically reduces limits after N consecutive losing days
 *
 * Streaks are tracked per-day (not per-trade). A "winning day" is any day with positive
 * realized P&L. A "losing day" is any day with negative realized P&L.
 * Days with zero P&L (no trades) do not affect the streak.
 */

import type { DisciplineState, DisciplineEngineSettings, ActiveAdjustment, StreakState } from "./types";

export interface StreakInfo {
  active: boolean;
  type: "winning" | "losing" | "none";
  length: number;
  adjustments: string[];
  notifications: string[];
}

/**
 * Get the current streak status and any active adjustments or notifications.
 */
export function getStreakStatus(
  state: DisciplineState,
  settings: DisciplineEngineSettings
): StreakInfo {
  const streak = state.currentStreak;
  const adjustments: string[] = [];
  const notifications: string[] = [];

  if (streak.type === "none" || streak.length === 0) {
    return { active: false, type: "none", length: 0, adjustments: [], notifications: [] };
  }

  // Winning streak reminder
  if (
    streak.type === "winning" &&
    settings.winningStreakReminder.enabled &&
    streak.length >= settings.winningStreakReminder.triggerAfterDays
  ) {
    notifications.push(
      `${streak.length}-Day Winning Streak! But remember — overconfidence is the enemy. Don't increase position sizes. Stick to your plan.`
    );
  }

  // Losing streak auto-reduce
  if (
    streak.type === "losing" &&
    settings.losingStreakAutoReduce.enabled &&
    streak.length >= settings.losingStreakAutoReduce.triggerAfterDays
  ) {
    const reduceBy = settings.losingStreakAutoReduce.reduceByPercent;
    adjustments.push(`Position size reduced by ${reduceBy}% due to ${streak.length}-day losing streak`);
    adjustments.push(`Trade limit reduced due to ${streak.length}-day losing streak`);
    notifications.push(
      `${streak.length}-Day Losing Streak. The market isn't going anywhere. Protect your capital. Auto-reducing limits by ${reduceBy}% until streak breaks.`
    );
  }

  return {
    active: true,
    type: streak.type,
    length: streak.length,
    adjustments,
    notifications,
  };
}

/**
 * Calculate the auto-adjustments that should be applied based on the current streak.
 */
export function calculateStreakAdjustments(
  state: DisciplineState,
  settings: DisciplineEngineSettings
): ActiveAdjustment[] {
  const streak = state.currentStreak;
  const adjustments: ActiveAdjustment[] = [];

  if (
    streak.type !== "losing" ||
    !settings.losingStreakAutoReduce.enabled ||
    streak.length < settings.losingStreakAutoReduce.triggerAfterDays
  ) {
    return adjustments;
  }

  const reduceBy = settings.losingStreakAutoReduce.reduceByPercent;
  const factor = 1 - reduceBy / 100;
  const now = new Date();

  // Reduce max position size
  const originalPosition = settings.maxPositionSize.percentOfCapital;
  adjustments.push({
    rule: "losing_streak_reduce_position",
    description: `Position size reduced from ${originalPosition}% to ${(originalPosition * factor).toFixed(0)}% due to ${streak.length}-day losing streak`,
    originalValue: originalPosition,
    adjustedValue: Math.round(originalPosition * factor),
    appliedAt: now,
  });

  // Reduce max trades per day
  const originalTrades = settings.maxTradesPerDay.limit;
  adjustments.push({
    rule: "losing_streak_reduce_trades",
    description: `Max trades reduced from ${originalTrades} to ${Math.max(1, Math.round(originalTrades * factor))} due to ${streak.length}-day losing streak`,
    originalValue: originalTrades,
    adjustedValue: Math.max(1, Math.round(originalTrades * factor)),
    appliedAt: now,
  });

  // Reduce max exposure
  const originalExposure = settings.maxTotalExposure.percentOfCapital;
  adjustments.push({
    rule: "losing_streak_reduce_exposure",
    description: `Max exposure reduced from ${originalExposure}% to ${(originalExposure * factor).toFixed(0)}% due to ${streak.length}-day losing streak`,
    originalValue: originalExposure,
    adjustedValue: Math.round(originalExposure * factor),
    appliedAt: now,
  });

  return adjustments;
}

/**
 * Update the streak state based on today's P&L.
 * Called at end of day or when the day's trading is complete.
 */
export function updateStreak(
  currentStreak: StreakState,
  todayPnl: number,
  todayDate: string
): StreakState {
  // Zero P&L day doesn't affect streak
  if (todayPnl === 0) return currentStreak;

  const todayType: "winning" | "losing" = todayPnl > 0 ? "winning" : "losing";

  if (currentStreak.type === todayType) {
    // Continue the streak
    return {
      type: todayType,
      length: currentStreak.length + 1,
      startDate: currentStreak.startDate,
    };
  }

  // Streak broken — start a new one
  return {
    type: todayType,
    length: 1,
    startDate: todayDate,
  };
}
