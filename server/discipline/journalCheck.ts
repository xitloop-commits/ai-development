/**
 * Module 6: Journal & Weekly Review
 *
 * - Unjournaled trade enforcement: blocks new trades when too many unjournaled
 * - Weekly review gate: blocks trading on Monday until review is completed
 */

import type { DisciplineState, DisciplineEngineSettings, ModuleCheckResult } from "./types";

export interface JournalCheckResult extends ModuleCheckResult {
  unjournaledCount?: number;
  maxUnjournaled?: number;
}

/**
 * Check if the user has too many unjournaled trades.
 */
export function checkJournalCompliance(
  state: DisciplineState,
  settings: DisciplineEngineSettings
): JournalCheckResult {
  if (!settings.journalEnforcement.enabled) {
    return { passed: true, unjournaledCount: state.unjournaledTrades.length };
  }

  const { maxUnjournaled } = settings.journalEnforcement;
  const count = state.unjournaledTrades.length;

  if (count >= maxUnjournaled) {
    return {
      passed: false,
      reason: `Complete ${count} journal entries first — max ${maxUnjournaled} unjournaled trades allowed`,
      unjournaledCount: count,
      maxUnjournaled,
    };
  }

  return {
    passed: true,
    unjournaledCount: count,
    maxUnjournaled,
  };
}

export interface WeeklyReviewResult extends ModuleCheckResult {
  reviewRequired?: boolean;
}

/**
 * Check if the weekly review has been completed (Monday gate).
 */
export function checkWeeklyReview(
  state: DisciplineState,
  settings: DisciplineEngineSettings
): WeeklyReviewResult {
  if (!settings.weeklyReview.enabled) {
    return { passed: true };
  }

  // Check if today is Monday (IST)
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const dayOfWeek = ist.getUTCDay(); // 0 = Sunday, 1 = Monday

  if (dayOfWeek === 1 && !state.weeklyReviewCompleted) {
    return {
      passed: false,
      reason: "Complete your weekly performance review before trading",
      reviewRequired: true,
    };
  }

  return { passed: true };
}
