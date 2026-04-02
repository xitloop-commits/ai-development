/**
 * Module 1: Circuit Breaker & Loss Limits
 *
 * - Daily loss limit: blocks all trading when cumulative realized loss exceeds threshold
 * - Consecutive losses: forces extended cooldown after N back-to-back losing trades
 *
 * The circuit breaker is LATCHED — once triggered, it cannot be unset until the next day.
 * Only realized P&L (closed trades) counts. Combined across NSE + MCX.
 */

import type { DisciplineState, DisciplineEngineSettings, ModuleCheckResult } from "./types";

export interface CircuitBreakerResult extends ModuleCheckResult {
  dailyLoss?: number;
  dailyLossPercent?: number;
}

/**
 * Check if the daily loss limit has been breached.
 * @param state Current intraday discipline state
 * @param settings Discipline settings
 * @param openCapital Current trading pool capital
 */
export function checkDailyLossLimit(
  state: DisciplineState,
  settings: DisciplineEngineSettings,
  openCapital: number
): CircuitBreakerResult {
  if (!settings.dailyLossLimit.enabled) {
    return { passed: true, dailyLoss: state.dailyRealizedPnl, dailyLossPercent: 0 };
  }

  // Already triggered — latched for the day
  if (state.circuitBreakerTriggered) {
    return {
      passed: false,
      reason: "DAILY LOSS LIMIT REACHED — Trading disabled for today",
      dailyLoss: state.dailyRealizedPnl,
      dailyLossPercent: state.dailyLossPercent,
    };
  }

  const threshold = settings.dailyLossLimit.thresholdPercent;
  const lossPercent = openCapital > 0 ? (Math.abs(Math.min(state.dailyRealizedPnl, 0)) / openCapital) * 100 : 0;

  if (lossPercent >= threshold) {
    return {
      passed: false,
      reason: `Daily loss ${lossPercent.toFixed(1)}% exceeds ${threshold}% limit`,
      dailyLoss: state.dailyRealizedPnl,
      dailyLossPercent: lossPercent,
    };
  }

  return {
    passed: true,
    dailyLoss: state.dailyRealizedPnl,
    dailyLossPercent: lossPercent,
  };
}

export interface ConsecutiveLossResult extends ModuleCheckResult {
  consecutiveLosses?: number;
  cooldownMinutes?: number;
}

/**
 * Check if the consecutive loss threshold has been hit.
 * This is separate from the revenge cooldown — it tracks cumulative losses.
 */
export function checkConsecutiveLosses(
  state: DisciplineState,
  settings: DisciplineEngineSettings
): ConsecutiveLossResult {
  if (!settings.maxConsecutiveLosses.enabled) {
    return { passed: true, consecutiveLosses: state.consecutiveLosses };
  }

  const { maxLosses, cooldownMinutes } = settings.maxConsecutiveLosses;

  if (state.consecutiveLosses >= maxLosses) {
    // Check if cooldown is active
    if (state.activeCooldown?.type === "consecutive_loss") {
      const now = new Date();
      if (now < state.activeCooldown.endsAt) {
        const remainingMs = state.activeCooldown.endsAt.getTime() - now.getTime();
        const remainingMin = Math.ceil(remainingMs / 60000);
        return {
          passed: false,
          reason: `${state.consecutiveLosses} consecutive losses — cooldown active (${remainingMin} min remaining)`,
          consecutiveLosses: state.consecutiveLosses,
          cooldownMinutes,
        };
      }
      // Cooldown expired — allow but don't reset counter (resets on a win)
      return { passed: true, consecutiveLosses: state.consecutiveLosses };
    }

    // Threshold hit but no cooldown started yet — block and signal to start cooldown
    return {
      passed: false,
      reason: `${state.consecutiveLosses} consecutive losses — extended cooldown required (${cooldownMinutes} min)`,
      consecutiveLosses: state.consecutiveLosses,
      cooldownMinutes,
    };
  }

  return { passed: true, consecutiveLosses: state.consecutiveLosses };
}
