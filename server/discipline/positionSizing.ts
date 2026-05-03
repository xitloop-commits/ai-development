/**
 * Module 5: Position Size & Exposure
 *
 * - Max position size: rejects trades where value exceeds % of capital
 * - Max total exposure: blocks when sum of all open positions exceeds % of capital
 * - Streak-adjusted limits: auto-reduced when losing streak is active
 */

import type { DisciplineState, DisciplineAgentSettings, ModuleCheckResult } from "./types";

export interface PositionSizeResult extends ModuleCheckResult {
  positionPercent?: number;
  positionLimit?: number;
  exposurePercent?: number;
  exposureLimit?: number;
}

/**
 * Check if a single trade's value exceeds the max position size limit.
 */
export function checkPositionSize(
  estimatedValue: number,
  currentCapital: number,
  state: DisciplineState,
  settings: DisciplineAgentSettings
): PositionSizeResult {
  if (!settings.maxPositionSize.enabled || currentCapital <= 0) {
    return { passed: true };
  }

  let effectiveLimit = settings.maxPositionSize.percentOfCapital;

  // Apply streak adjustments
  const adjustment = state.activeAdjustments.find((a) => a.rule === "losing_streak_reduce_position");
  if (adjustment) {
    effectiveLimit = adjustment.adjustedValue;
  }

  const positionPercent = (estimatedValue / currentCapital) * 100;

  if (positionPercent > effectiveLimit) {
    return {
      passed: false,
      reason: `Position size ₹${estimatedValue.toLocaleString("en-IN")} = ${positionPercent.toFixed(1)}% of capital — EXCEEDS ${effectiveLimit}% LIMIT`,
      positionPercent,
      positionLimit: effectiveLimit,
    };
  }

  return {
    passed: true,
    positionPercent,
    positionLimit: effectiveLimit,
  };
}

/**
 * Check if total exposure (all open positions + new trade) exceeds the limit.
 */
export function checkExposure(
  estimatedValue: number,
  currentExposure: number,
  currentCapital: number,
  state: DisciplineState,
  settings: DisciplineAgentSettings
): PositionSizeResult {
  if (!settings.maxTotalExposure.enabled || currentCapital <= 0) {
    return { passed: true };
  }

  let effectiveLimit = settings.maxTotalExposure.percentOfCapital;

  // Apply streak adjustments
  const adjustment = state.activeAdjustments.find((a) => a.rule === "losing_streak_reduce_exposure");
  if (adjustment) {
    effectiveLimit = adjustment.adjustedValue;
  }

  const newTotalExposure = currentExposure + estimatedValue;
  const exposurePercent = (newTotalExposure / currentCapital) * 100;

  if (exposurePercent > effectiveLimit) {
    return {
      passed: false,
      reason: `Total exposure ₹${newTotalExposure.toLocaleString("en-IN")} = ${exposurePercent.toFixed(1)}% of capital — EXCEEDS ${effectiveLimit}% LIMIT`,
      exposurePercent,
      exposureLimit: effectiveLimit,
    };
  }

  return {
    passed: true,
    exposurePercent,
    exposureLimit: effectiveLimit,
  };
}
