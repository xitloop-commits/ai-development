/**
 * Module 4: Pre-Trade Gate
 *
 * Server-side evaluation of the pre-trade checklist.
 * The frontend shows a 7-check UI; this module validates the hard checks server-side.
 *
 * Hard checks (blocking):
 *   3. R:R ratio acceptable
 *   4. Position size within limits (handled by positionSizing module)
 *   5. Total exposure within limits (handled by positionSizing module)
 *   6. Emotional state not in blocked list
 *
 * Soft checks (warning only):
 *   1. Trade aligned with plan
 *   2. Pre-entry checklist completed
 *   7. Checklist done
 */

import type { DisciplineEngineSettings, ModuleCheckResult, TradeValidationRequest } from "./types";

export interface PreTradeResult extends ModuleCheckResult {
  failedChecks?: string[];
  softWarnings?: string[];
}

/**
 * Evaluate the pre-trade gate checks.
 * Position size and exposure are handled by the positionSizing module separately.
 */
export function evaluatePreTradeGate(
  request: TradeValidationRequest,
  settings: DisciplineEngineSettings
): PreTradeResult {
  if (!settings.preTradeGate.enabled) {
    return { passed: true };
  }

  const failedChecks: string[] = [];
  const softWarnings: string[] = [];

  // ─── Hard Check: R:R Ratio ─────────────────────────────────
  if (settings.preTradeGate.minRiskReward.enabled) {
    const minRR = settings.preTradeGate.minRiskReward.ratio;

    if (request.aiRiskReward !== undefined && request.aiRiskReward > 0) {
      if (request.aiRiskReward < minRR) {
        failedChecks.push(`R:R ratio ${request.aiRiskReward.toFixed(1)} — BELOW MINIMUM ${minRR}`);
      }
    } else if (request.stopLoss !== undefined && request.target !== undefined && request.stopLoss > 0) {
      // Calculate R:R from stop loss and target
      const risk = Math.abs(request.entryPrice - request.stopLoss);
      const reward = Math.abs(request.target - request.entryPrice);
      const rr = risk > 0 ? reward / risk : 0;

      if (rr < minRR) {
        failedChecks.push(`R:R ratio 1:${rr.toFixed(1)} — BELOW MINIMUM 1:${minRR}`);
      }
    }
    // If neither aiRiskReward nor SL/target provided, skip R:R check
  }

  // ─── Hard Check: Emotional State ───────────────────────────
  if (settings.preTradeGate.emotionalStateCheck.enabled && request.emotionalState) {
    const blockedStates = settings.preTradeGate.emotionalStateCheck.blockStates;
    if (blockedStates.includes(request.emotionalState)) {
      failedChecks.push(`Emotional state "${request.emotionalState}" is blocked — step away and calm down`);
    }
  }

  // ─── Soft Check: Plan Alignment ────────────────────────────
  if (request.planAligned === false) {
    softWarnings.push("Trade not aligned with plan");
  }

  // ─── Soft Check: Checklist ─────────────────────────────────
  if (request.checklistDone === false) {
    softWarnings.push("Pre-entry checklist not completed");
  }

  const passed = failedChecks.length === 0;

  return {
    passed,
    reason: passed
      ? undefined
      : `Pre-trade gate blocked: ${failedChecks.join("; ")}`,
    failedChecks: failedChecks.length > 0 ? failedChecks : undefined,
    softWarnings: softWarnings.length > 0 ? softWarnings : undefined,
  };
}
