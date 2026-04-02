/**
 * Discipline Engine — tRPC Router
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
import { router, publicProcedure } from "../_core/trpc";
import { disciplineEngine } from "./index";
import {
  getDisciplineSettings,
  updateDisciplineSettings,
  getDisciplineState,
  getScoreHistory,
  DisciplineStateModel,
} from "./disciplineModel";
import { getISTDateString, type Exchange, type EmotionalState } from "./types";
import { getTimelineSegments } from "./timeWindows";

const DEFAULT_USER_ID = "1";

export const disciplineRouter = router({
  /**
   * Validate a trade against all discipline rules.
   */
  validate: publicProcedure
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
      return disciplineEngine.validateTrade(
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
    return disciplineEngine.getDashboard(DEFAULT_USER_ID);
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
   * Update discipline settings.
   */
  updateSettings: publicProcedure
    .input(z.record(z.string(), z.unknown()))
    .mutation(async ({ input }) => {
      return updateDisciplineSettings(DEFAULT_USER_ID, input);
    }),

  /**
   * Acknowledge a loss to start the cooldown timer.
   */
  acknowledgeLoss: publicProcedure.mutation(async () => {
    return disciplineEngine.acknowledgeLoss(DEFAULT_USER_ID);
  }),

  /**
   * Mark a trade as journaled.
   */
  journalTrade: publicProcedure
    .input(z.object({ tradeId: z.string() }))
    .mutation(async ({ input }) => {
      await disciplineEngine.journalTrade(DEFAULT_USER_ID, input.tradeId);
      return { success: true };
    }),

  /**
   * Complete the weekly review.
   */
  completeReview: publicProcedure.mutation(async () => {
    await disciplineEngine.completeWeeklyReview(DEFAULT_USER_ID);
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
    const { streak } = await disciplineEngine.getDashboard(DEFAULT_USER_ID);
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
  endOfDay: publicProcedure
    .input(z.object({ dailyPnl: z.number(), openCapital: z.number() }))
    .mutation(async ({ input }) => {
      await disciplineEngine.endOfDay(DEFAULT_USER_ID, input.dailyPnl, input.openCapital);
      return { success: true };
    }),

  /**
   * Notify that a trade was placed (increments counters).
   */
  onTradePlaced: publicProcedure.mutation(async () => {
    await disciplineEngine.onTradePlaced(DEFAULT_USER_ID);
    return { success: true };
  }),

  /**
   * Notify that a trade was closed (updates P&L, cooldowns, streaks).
   */
  onTradeClosed: publicProcedure
    .input(
      z.object({
        pnl: z.number(),
        openCapital: z.number(),
        tradeId: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const result = await disciplineEngine.onTradeClosed(
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
  resetDailyState: publicProcedure.mutation(async () => {
    const date = getISTDateString();
    await DisciplineStateModel.deleteOne({ userId: DEFAULT_USER_ID, date });
    return { success: true, date };
  }),
});
