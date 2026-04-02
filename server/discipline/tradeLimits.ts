/**
 * Module 2: Trade Limits
 *
 * - Max trades per day: hard limit on total trades placed (combined NSE + MCX)
 * - Max open positions: hard limit on simultaneously open positions
 *
 * Cancelled or rejected orders do not count toward the trade limit.
 */

import type { DisciplineState, DisciplineEngineSettings, ModuleCheckResult } from "./types";

export interface TradeLimitsResult extends ModuleCheckResult {
  tradesUsed?: number;
  tradesMax?: number;
  positionsOpen?: number;
  positionsMax?: number;
}

/**
 * Check if the max trades per day limit has been reached.
 */
export function checkMaxTrades(
  state: DisciplineState,
  settings: DisciplineEngineSettings
): TradeLimitsResult {
  if (!settings.maxTradesPerDay.enabled) {
    return { passed: true, tradesUsed: state.tradesToday };
  }

  const { limit } = settings.maxTradesPerDay;

  // Apply streak adjustments if any
  let effectiveLimit = limit;
  const adjustment = state.activeAdjustments.find((a) => a.rule === "losing_streak_reduce_trades");
  if (adjustment) {
    effectiveLimit = adjustment.adjustedValue;
  }

  if (state.tradesToday >= effectiveLimit) {
    return {
      passed: false,
      reason: `Trade limit reached: ${state.tradesToday}/${effectiveLimit} trades today`,
      tradesUsed: state.tradesToday,
      tradesMax: effectiveLimit,
    };
  }

  return {
    passed: true,
    tradesUsed: state.tradesToday,
    tradesMax: effectiveLimit,
  };
}

/**
 * Check if the max open positions limit has been reached.
 */
export function checkMaxPositions(
  state: DisciplineState,
  settings: DisciplineEngineSettings
): TradeLimitsResult {
  if (!settings.maxOpenPositions.enabled) {
    return { passed: true, positionsOpen: state.openPositions };
  }

  const { limit } = settings.maxOpenPositions;

  if (state.openPositions >= limit) {
    return {
      passed: false,
      reason: `Max open positions reached: ${state.openPositions}/${limit}. Close a position first.`,
      positionsOpen: state.openPositions,
      positionsMax: limit,
    };
  }

  return {
    passed: true,
    positionsOpen: state.openPositions,
    positionsMax: limit,
  };
}
