/**
 * Discipline Engine — Orchestrator
 *
 * Singleton that coordinates all discipline modules into a single validation pipeline.
 * Called before every trade placement to check all rules.
 * Also provides methods for post-trade updates (P&L tracking, cooldowns, journal).
 */

import type {
  TradeValidationRequest,
  TradeValidationResult,
  DisciplineState,
  DisciplineEngineSettings,
  Exchange,
} from "./types";
import { getISTDateString } from "./types";
import {
  getDisciplineSettings,
  getDisciplineState,
  updateDisciplineState,
  addViolation,
  saveDailyScore,
} from "./disciplineModel";
import { checkDailyLossLimit, checkConsecutiveLosses } from "./circuitBreaker";
import { checkMaxTrades, checkMaxPositions } from "./tradeLimits";
import { checkCooldown, createRevengeCooldown, createConsecutiveLossCooldown, acknowledgeLoss, resolveOverlappingCooldowns } from "./cooldowns";
import { checkTimeWindow } from "./timeWindows";
import { checkPositionSize, checkExposure } from "./positionSizing";
import { evaluatePreTradeGate } from "./preTrade";
import { checkJournalCompliance, checkWeeklyReview } from "./journalCheck";
import { getStreakStatus, calculateStreakAdjustments, updateStreak } from "./streaks";
import { calculateScore } from "./score";

// ─── Discipline Engine Class ───────────────────────────────────

class DisciplineEngine {
  private static instance: DisciplineEngine;

  private constructor() {}

  static getInstance(): DisciplineEngine {
    if (!DisciplineEngine.instance) {
      DisciplineEngine.instance = new DisciplineEngine();
    }
    return DisciplineEngine.instance;
  }

  // ─── Pre-Trade Validation Pipeline ─────────────────────────

  /**
   * Run all discipline checks before a trade is placed.
   * Returns a comprehensive result with pass/fail for each module.
   */
  async validateTrade(
    userId: string,
    request: TradeValidationRequest,
    currentCapital: number,
    currentExposure: number
  ): Promise<TradeValidationResult> {
    const date = getISTDateString();
    const settings = await getDisciplineSettings(userId);
    const state = await getDisciplineState(userId, date);

    // Apply streak adjustments before validation
    const streakAdjustments = calculateStreakAdjustments(state, settings);
    if (streakAdjustments.length > 0) {
      state.activeAdjustments = streakAdjustments;
      await updateDisciplineState(userId, date, { activeAdjustments: streakAdjustments });
    }

    const blockedBy: string[] = [];
    const warnings: string[] = [];
    const adjustments: string[] = [];

    // 1. Circuit Breaker
    const cbResult = checkDailyLossLimit(state, settings, currentCapital);
    if (!cbResult.passed) blockedBy.push("circuitBreaker");

    // 2. Consecutive Losses
    const clResult = checkConsecutiveLosses(state, settings);
    if (!clResult.passed) blockedBy.push("consecutiveLosses");

    // 3. Trade Limits
    const tlResult = checkMaxTrades(state, settings);
    if (!tlResult.passed) blockedBy.push("tradeLimits");

    // 4. Max Positions
    const mpResult = checkMaxPositions(state, settings);
    if (!mpResult.passed) blockedBy.push("maxPositions");

    // 5. Cooldown
    const cdResult = checkCooldown(state, settings);
    if (!cdResult.passed) blockedBy.push("cooldown");

    // 6. Time Window
    const twResult = checkTimeWindow(request.exchange, settings);
    if (!twResult.passed) blockedBy.push("timeWindow");

    // 7. Position Size
    const psResult = checkPositionSize(request.estimatedValue, currentCapital, state, settings);
    if (!psResult.passed) blockedBy.push("positionSize");

    // 8. Exposure
    const exResult = checkExposure(request.estimatedValue, currentExposure, currentCapital, state, settings);
    if (!exResult.passed) blockedBy.push("exposure");

    // 9. Journal
    const jResult = checkJournalCompliance(state, settings);
    if (!jResult.passed) blockedBy.push("journal");

    // 10. Weekly Review
    const wrResult = checkWeeklyReview(state, settings);
    if (!wrResult.passed) blockedBy.push("weeklyReview");

    // 11. Pre-Trade Gate
    const ptResult = evaluatePreTradeGate(request, settings);
    if (!ptResult.passed) blockedBy.push("preTrade");
    if (ptResult.softWarnings) warnings.push(...ptResult.softWarnings);

    // 12. Streak notifications
    const streakInfo = getStreakStatus(state, settings);
    if (streakInfo.notifications.length > 0) warnings.push(...streakInfo.notifications);
    if (streakInfo.adjustments.length > 0) adjustments.push(...streakInfo.adjustments);

    // Record violations for any blocks
    if (blockedBy.length > 0) {
      for (const rule of blockedBy) {
        await addViolation(userId, date, {
          ruleId: rule,
          ruleName: rule,
          severity: "hard",
          description: this.getBlockReason(rule, { cbResult, clResult, tlResult, mpResult, cdResult, twResult, psResult, exResult, jResult, ptResult }),
          timestamp: new Date(),
          overridden: false,
        });
      }
    }

    return {
      allowed: blockedBy.length === 0,
      blockedBy,
      warnings,
      adjustments,
      details: {
        circuitBreaker: { ...cbResult },
        tradeLimits: { ...tlResult, positionsOpen: mpResult.positionsOpen },
        cooldown: { ...cdResult },
        timeWindow: { ...twResult },
        positionSize: { ...psResult, exposurePercent: exResult.exposurePercent },
        journal: { ...jResult },
        preTrade: { ...ptResult },
        streaks: {
          active: streakInfo.active,
          type: streakInfo.type === "none" ? undefined : streakInfo.type,
          length: streakInfo.length,
          adjustments: streakInfo.adjustments,
        },
      },
    };
  }

  // ─── Post-Trade Updates ────────────────────────────────────

  /**
   * Called when a new trade is placed (after validation passes).
   * Increments counters.
   */
  async onTradePlaced(userId: string): Promise<void> {
    const date = getISTDateString();
    const state = await getDisciplineState(userId, date);
    await updateDisciplineState(userId, date, {
      tradesToday: state.tradesToday + 1,
      openPositions: state.openPositions + 1,
      unjournaledTrades: [...state.unjournaledTrades, `trade_${Date.now()}`],
    });
  }

  /**
   * Called when a trade is closed. Updates P&L, cooldowns, streaks.
   */
  async onTradeClosed(
    userId: string,
    pnl: number,
    openCapital: number,
    tradeId?: string
  ): Promise<{ cooldownStarted: boolean; circuitBreakerTriggered: boolean }> {
    const date = getISTDateString();
    const settings = await getDisciplineSettings(userId);
    const state = await getDisciplineState(userId, date);

    const newPnl = state.dailyRealizedPnl + pnl;
    const newLossPercent = openCapital > 0 ? (Math.abs(Math.min(newPnl, 0)) / openCapital) * 100 : 0;

    const updates: Partial<DisciplineState> = {
      dailyRealizedPnl: newPnl,
      dailyLossPercent: newLossPercent,
      openPositions: Math.max(0, state.openPositions - 1),
    };

    let cooldownStarted = false;
    let circuitBreakerTriggered = false;

    if (pnl < 0) {
      // Loss — update consecutive losses and check for cooldowns
      updates.consecutiveLosses = state.consecutiveLosses + 1;

      // Revenge cooldown
      const revengeCooldown = createRevengeCooldown(settings, tradeId);
      if (revengeCooldown) {
        updates.activeCooldown = resolveOverlappingCooldowns(state.activeCooldown, revengeCooldown);
        cooldownStarted = true;
      }

      // Consecutive loss cooldown
      if (
        settings.maxConsecutiveLosses.enabled &&
        (updates.consecutiveLosses ?? 0) >= settings.maxConsecutiveLosses.maxLosses
      ) {
        const clCooldown = createConsecutiveLossCooldown(settings);
        if (clCooldown) {
          updates.activeCooldown = resolveOverlappingCooldowns(updates.activeCooldown, clCooldown);
          cooldownStarted = true;
        }
      }

      // Circuit breaker check
      if (
        settings.dailyLossLimit.enabled &&
        newLossPercent >= settings.dailyLossLimit.thresholdPercent
      ) {
        updates.circuitBreakerTriggered = true;
        updates.circuitBreakerTriggeredAt = new Date();
        circuitBreakerTriggered = true;
      }
    } else if (pnl > 0) {
      // Win — reset consecutive losses
      updates.consecutiveLosses = 0;
    }

    await updateDisciplineState(userId, date, updates);

    return { cooldownStarted, circuitBreakerTriggered };
  }

  /**
   * Called when the user acknowledges a loss (clicks "I accept the loss").
   * Starts the actual cooldown timer.
   */
  async acknowledgeLoss(userId: string): Promise<{ cooldownEndsAt: Date | null }> {
    const date = getISTDateString();
    const settings = await getDisciplineSettings(userId);
    const state = await getDisciplineState(userId, date);

    if (!state.activeCooldown || state.activeCooldown.acknowledged) {
      return { cooldownEndsAt: null };
    }

    const updated = acknowledgeLoss(state.activeCooldown, settings);
    await updateDisciplineState(userId, date, { activeCooldown: updated });

    return { cooldownEndsAt: updated.endsAt };
  }

  /**
   * Mark a trade as journaled — removes from unjournaled list.
   */
  async journalTrade(userId: string, tradeId: string): Promise<void> {
    const date = getISTDateString();
    const state = await getDisciplineState(userId, date);
    const filtered = state.unjournaledTrades.filter((id) => id !== tradeId);
    await updateDisciplineState(userId, date, { unjournaledTrades: filtered });
  }

  /**
   * Complete the weekly review.
   */
  async completeWeeklyReview(userId: string): Promise<void> {
    const date = getISTDateString();
    await updateDisciplineState(userId, date, { weeklyReviewCompleted: true });
  }

  // ─── End-of-Day Processing ─────────────────────────────────

  /**
   * Called at end of day to finalize score and update streaks.
   */
  async endOfDay(userId: string, dailyPnl: number, openCapital: number): Promise<void> {
    const date = getISTDateString();
    const settings = await getDisciplineSettings(userId);
    const state = await getDisciplineState(userId, date);

    // Calculate final score
    const { score, breakdown } = calculateScore(state, settings);

    // Update streak
    const newStreak = updateStreak(state.currentStreak, dailyPnl, date);
    await updateDisciplineState(userId, date, { currentStreak: newStreak });

    // Save daily score
    await saveDailyScore({
      userId,
      date,
      score,
      breakdown,
      violationCount: state.violations.length,
      tradesToday: state.tradesToday,
      dailyPnl,
      dailyPnlPercent: openCapital > 0 ? (dailyPnl / openCapital) * 100 : 0,
      streakType: newStreak.type,
      streakLength: newStreak.length,
    });
  }

  // ─── Query Methods ─────────────────────────────────────────

  /**
   * Get the current discipline dashboard data.
   */
  async getDashboard(userId: string): Promise<{
    state: DisciplineState;
    settings: DisciplineEngineSettings;
    score: { score: number; breakdown: import("./types").ScoreBreakdown };
    streak: ReturnType<typeof getStreakStatus>;
  }> {
    const date = getISTDateString();
    const settings = await getDisciplineSettings(userId);
    const state = await getDisciplineState(userId, date);
    const { score, breakdown } = calculateScore(state, settings);
    const streak = getStreakStatus(state, settings);

    return { state, settings, score: { score, breakdown }, streak };
  }

  // ─── Private Helpers ───────────────────────────────────────

  private getBlockReason(
    rule: string,
    results: Record<string, { reason?: string }>
  ): string {
    const map: Record<string, string> = {
      circuitBreaker: results.cbResult?.reason ?? "Circuit breaker triggered",
      consecutiveLosses: results.clResult?.reason ?? "Consecutive losses limit",
      tradeLimits: results.tlResult?.reason ?? "Trade limit reached",
      maxPositions: results.mpResult?.reason ?? "Max positions reached",
      cooldown: results.cdResult?.reason ?? "Cooldown active",
      timeWindow: results.twResult?.reason ?? "Time window blocked",
      positionSize: results.psResult?.reason ?? "Position size exceeded",
      exposure: results.exResult?.reason ?? "Exposure limit exceeded",
      journal: results.jResult?.reason ?? "Journal entries required",
      weeklyReview: "Weekly review required",
      preTrade: results.ptResult?.reason ?? "Pre-trade gate failed",
    };
    return map[rule] ?? rule;
  }
}

export const disciplineEngine = DisciplineEngine.getInstance();
export { DisciplineEngine };
