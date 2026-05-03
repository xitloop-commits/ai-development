/**
 * Discipline Agent — tRPC Router
 *
 * Endpoints:
 *   discipline.validate        — Pre-trade validation (runs full pipeline)
 *   discipline.getDashboard    — Dashboard data (state, score, streak, settings)
 *   discipline.getState        — Current intraday state
 *   discipline.getSettings     — Discipline settings
 *   discipline.updateSettings  — Update discipline settings
 *   discipline.acknowledgeLoss — Accept loss to start cooldown timer
 *   discipline.journalTrade    — Mark a trade as journaled
 *   discipline.completeReview  — Complete weekly review
 *   discipline.getViolations   — Today's violations
 *   discipline.getScoreHistory — Historical scores for charting
 *   discipline.getStreakStatus — Current streak info
 *   discipline.endOfDay        — Finalize daily score (admin/cron)
 *   discipline.onTradePlaced   — Post-trade: increment counters
 *   discipline.onTradeClosed   — Post-trade: update P&L, cooldowns, streaks
 *   discipline.resetDailyState — Reset state for testing
 */

import { z } from "zod";
import { router, publicProcedure, protectedProcedure } from "../_core/trpc";
import { disciplineAgent } from "./index";
import {
  getDisciplineSettings,
  updateDisciplineSettings,
  getDisciplineState,
  getScoreHistory,
  DisciplineStateModel,
} from "./disciplineModel";
import { getISTDateString, type Exchange } from "./types";
import { getTimelineSegments } from "./timeWindows";

const DEFAULT_USER_ID = "1";

// ─── Settings update schema ─────────────────────────────────────────
// Strict mirror of DisciplineAgentSettings (sans server-managed fields).
// Each module's sub-object is `.strict()` so unknown sub-keys also reject.
// Bounds reflect the spec — see DisciplineAgent_Spec_v1.4.

const emotionalStateEnum = z.enum(["calm", "anxious", "revenge", "fomo", "greedy", "neutral"]);
const timeHHmm = z.string().regex(/^[0-2]\d:[0-5]\d$/, "expected HH:mm");

export const disciplineSettingsUpdateSchema = z.object({
  // Module 1: Circuit Breaker
  dailyLossLimit: z.object({
    enabled: z.boolean(),
    thresholdPercent: z.number().min(0).max(100),
  }).strict().optional(),
  maxConsecutiveLosses: z.object({
    enabled: z.boolean(),
    maxLosses: z.number().int().min(1).max(20),
    cooldownMinutes: z.number().int().min(0).max(720),
  }).strict().optional(),

  // Module 2: Trade Limits
  maxTradesPerDay: z.object({
    enabled: z.boolean(),
    limit: z.number().int().min(1).max(100),
  }).strict().optional(),
  maxOpenPositions: z.object({
    enabled: z.boolean(),
    limit: z.number().int().min(1).max(50),
  }).strict().optional(),
  revengeCooldown: z.object({
    enabled: z.boolean(),
    durationMinutes: z.number().int().min(0).max(720),
    requireAcknowledgment: z.boolean(),
  }).strict().optional(),

  // Module 3: Time Windows
  noTradingAfterOpen: z.object({
    enabled: z.boolean(),
    nseMinutes: z.number().int().min(0).max(60),
    mcxMinutes: z.number().int().min(0).max(60),
  }).strict().optional(),
  noTradingBeforeClose: z.object({
    enabled: z.boolean(),
    nseMinutes: z.number().int().min(0).max(60),
    mcxMinutes: z.number().int().min(0).max(60),
  }).strict().optional(),
  lunchBreakPause: z.object({
    enabled: z.boolean(),
    startTime: timeHHmm,
    endTime: timeHHmm,
  }).strict().optional(),

  // Module 4: Pre-Trade Gate
  preTradeGate: z.object({
    enabled: z.boolean(),
    minRiskReward: z.object({
      enabled: z.boolean(),
      ratio: z.number().min(0).max(20),
    }).strict(),
    emotionalStateCheck: z.object({
      enabled: z.boolean(),
      blockStates: z.array(emotionalStateEnum),
    }).strict(),
  }).strict().optional(),

  // Module 5: Position Sizing
  maxPositionSize: z.object({
    enabled: z.boolean(),
    percentOfCapital: z.number().min(0).max(100),
  }).strict().optional(),
  maxTotalExposure: z.object({
    enabled: z.boolean(),
    percentOfCapital: z.number().min(0).max(100),
  }).strict().optional(),

  // Module 6: Journal
  journalEnforcement: z.object({
    enabled: z.boolean(),
    maxUnjournaled: z.number().int().min(0).max(100),
  }).strict().optional(),
  weeklyReview: z.object({
    enabled: z.boolean(),
    disciplineScoreWarning: z.number().int().min(0).max(100),
    redWeekReduction: z.number().int().min(1).max(52),
  }).strict().optional(),

  // Module 7: Streaks
  winningStreakReminder: z.object({
    enabled: z.boolean(),
    triggerAfterDays: z.number().int().min(1).max(365),
  }).strict().optional(),
  losingStreakAutoReduce: z.object({
    enabled: z.boolean(),
    triggerAfterDays: z.number().int().min(1).max(365),
    reduceByPercent: z.number().min(0).max(100),
  }).strict().optional(),

  // Module 8: Capital Protection & Session Management
  capitalProtection: z.object({
    profitCap: z.object({
      enabled: z.boolean(),
      percent: z.number().min(0).max(100),
    }).strict(),
    lossCap: z.object({
      enabled: z.boolean(),
      percent: z.number().min(0).max(100),
    }).strict(),
    gracePeriodSeconds: z.number().int().min(0).max(3600),
    carryForward: z.object({
      enabled: z.boolean(),
      nseEvalTime: timeHHmm,
      mcxEvalTime: timeHHmm,
      autoExit: z.boolean(),
      exitDelayMinutes: z.number().int().min(0).max(120),
      minProfitPercent: z.number().min(0).max(1000),
      minMomentumScore: z.number().min(0).max(100),
      minDte: z.number().int().min(0).max(365),
      ivCondition: z.enum(["fair", "cheap", "any"]),
    }).strict(),
    iv: z.object({
      historyWindow: z.number().int().min(20).max(5000),
      minSamples: z.number().int().min(5).max(2000),
      cheapPercentile: z.number().min(0).max(100),
      expensivePercentile: z.number().min(0).max(100),
    }).strict(),
  }).strict().optional(),
}).strict();

export const disciplineRouter = router({
  /**
   * Validate a trade against all discipline rules.
   */
  validate: protectedProcedure
    .input(
      z.object({
        instrument: z.string(),
        exchange: z.enum(["NSE", "MCX"]),
        transactionType: z.enum(["BUY", "SELL"]),
        optionType: z.enum(["CE", "PE"]),
        strike: z.number(),
        entryPrice: z.number(),
        quantity: z.number(),
        estimatedValue: z.number(),
        aiConfidence: z.number().optional(),
        aiRiskReward: z.number().optional(),
        emotionalState: z.enum(["calm", "anxious", "revenge", "fomo", "greedy", "neutral"]).optional(),
        planAligned: z.boolean().optional(),
        checklistDone: z.boolean().optional(),
        stopLoss: z.number().optional(),
        target: z.number().optional(),
        currentCapital: z.number(),
        currentExposure: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { currentCapital, currentExposure, ...request } = input;
      return disciplineAgent.validateTrade(
        DEFAULT_USER_ID,
        request,
        currentCapital,
        currentExposure
      );
    }),

  /**
   * Get the full discipline dashboard data.
   */
  getDashboard: publicProcedure.query(async () => {
    return disciplineAgent.getDashboard(DEFAULT_USER_ID);
  }),

  /**
   * Get current intraday discipline state.
   */
  getState: publicProcedure.query(async () => {
    return getDisciplineState(DEFAULT_USER_ID);
  }),

  /**
   * Get discipline settings.
   */
  getSettings: publicProcedure.query(async () => {
    return getDisciplineSettings(DEFAULT_USER_ID);
  }),

  /**
   * Update discipline settings. Accepts a partial of DisciplineAgentSettings
   * (server-managed `userId`/`updatedAt`/`history` are stripped). Strict mode:
   * unknown fields rejected with 400; per-field bounds enforced.
   */
  updateSettings: protectedProcedure
    .input(disciplineSettingsUpdateSchema)
    .mutation(async ({ input }) => {
      const updated = await updateDisciplineSettings(DEFAULT_USER_ID, input);
      // Refresh the IV classifier's runtime tunables so percentile bands
      // / history window match the new settings without a server restart.
      await disciplineAgent.pushIvTunables(DEFAULT_USER_ID);
      return updated;
    }),

  /**
   * Phase D2 — tRPC alias for the internal `disciplineAgent.recordTradeOutcome`
   * pipeline. Kept symmetric with the REST endpoint at
   * POST /api/discipline/recordTradeOutcome (Python callers) so both
   * surfaces share one handler internal.
   */
  recordTradeOutcome: protectedProcedure
    .input(
      z.object({
        channel: z.enum([
          "ai-live",
          "ai-paper",
          "my-live",
          "my-paper",
          "testing-live",
          "testing-sandbox",
        ]),
        tradeId: z.string().min(1),
        realizedPnl: z.number(),
        openingCapital: z.number().nonnegative(),
        // Canonical ExitReasonCode union — see shared/exitContracts.ts.
        exitReason: z
          .enum([
            "MOMENTUM_EXIT",
            "VOLATILITY_EXIT",
            "SL_HIT",
            "TP_HIT",
            "AGE_EXIT",
            "STALE_PRICE_EXIT",
            "DISCIPLINE_EXIT",
            "AI_EXIT",
            "MANUAL",
            "EOD",
            "EXPIRY",
          ])
          .optional(),
        exitTriggeredBy: z
          .enum(["RCA", "BROKER", "DISCIPLINE", "AI", "USER", "PA"])
          .optional(),
        signalSource: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await disciplineAgent.recordTradeOutcome(input);
      return { success: true };
    }),

  /**
   * Phase D2 — lightweight "is the operator allowed to trade now?"
   * snapshot. The REST endpoint at GET /api/discipline/status returns
   * the exact same shape; both delegate to disciplineAgent.getSessionStatus.
   */
  getSessionStatus: publicProcedure
    .input(z.object({ channel: z.string().min(1) }))
    .query(async ({ input }) => {
      return disciplineAgent.getSessionStatus(DEFAULT_USER_ID, input.channel);
    }),

  /**
   * Acknowledge a loss to start the cooldown timer.
   */
  acknowledgeLoss: protectedProcedure.mutation(async () => {
    return disciplineAgent.acknowledgeLoss(DEFAULT_USER_ID);
  }),

  /**
   * Mark a trade as journaled.
   */
  journalTrade: protectedProcedure
    .input(z.object({ tradeId: z.string() }))
    .mutation(async ({ input }) => {
      await disciplineAgent.journalTrade(DEFAULT_USER_ID, input.tradeId);
      return { success: true };
    }),

  /**
   * Complete the weekly review.
   */
  completeReview: protectedProcedure.mutation(async () => {
    await disciplineAgent.completeWeeklyReview(DEFAULT_USER_ID);
    return { success: true };
  }),

  /**
   * Get today's violations.
   */
  getViolations: publicProcedure.query(async () => {
    const state = await getDisciplineState(DEFAULT_USER_ID);
    return state.violations;
  }),

  /**
   * Get score history for charting.
   */
  getScoreHistory: publicProcedure
    .input(z.object({ days: z.number().min(1).max(365).default(30) }).optional())
    .query(async ({ input }) => {
      return getScoreHistory(DEFAULT_USER_ID, input?.days ?? 30);
    }),

  /**
   * Get current streak status.
   */
  getStreakStatus: publicProcedure.query(async () => {
    const { streak } = await disciplineAgent.getDashboard(DEFAULT_USER_ID);
    return streak;
  }),

  /**
   * Get time window timeline segments for visualization.
   */
  getTimeline: publicProcedure
    .input(z.object({ exchange: z.enum(["NSE", "MCX"]) }))
    .query(async ({ input }) => {
      const settings = await getDisciplineSettings(DEFAULT_USER_ID);
      return getTimelineSegments(input.exchange as Exchange, settings);
    }),

  /**
   * Finalize end-of-day score. Called by cron or admin.
   */
  endOfDay: protectedProcedure
    .input(z.object({ dailyPnl: z.number(), openCapital: z.number() }))
    .mutation(async ({ input }) => {
      await disciplineAgent.endOfDay(DEFAULT_USER_ID, input.dailyPnl, input.openCapital);
      return { success: true };
    }),

  /**
   * Notify that a trade was placed (increments counters).
   */
  onTradePlaced: protectedProcedure.mutation(async () => {
    await disciplineAgent.onTradePlaced(DEFAULT_USER_ID);
    return { success: true };
  }),

  /**
   * Notify that a trade was closed (updates P&L, cooldowns, streaks).
   */
  onTradeClosed: protectedProcedure
    .input(
      z.object({
        pnl: z.number(),
        openCapital: z.number(),
        tradeId: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const result = await disciplineAgent.onTradeClosed(
        DEFAULT_USER_ID,
        input.pnl,
        input.openCapital,
        input.tradeId
      );
      return { success: true, ...result };
    }),

  /**
   * Reset daily state (for testing).
   */
  resetDailyState: protectedProcedure.mutation(async () => {
    const date = getISTDateString();
    await DisciplineStateModel.deleteOne({ userId: DEFAULT_USER_ID, date });
    return { success: true, date };
  }),
});
