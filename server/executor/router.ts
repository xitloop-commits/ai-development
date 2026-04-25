/**
 * Trade Executor Agent — tRPC router.
 *
 * Exposes spec §4 inputs as `executor.*` procedures. Every other agent /
 * UI consumer uses these to submit trade intent; nothing else should call
 * brokerService directly.
 */

import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { tradeExecutor } from "./tradeExecutor";

const channelSchema = z.enum([
  "ai-live",
  "ai-paper",
  "my-live",
  "my-paper",
  "testing-live",
  "testing-sandbox",
]);

const trailingStopSchema = z.object({
  enabled: z.boolean(),
  distance: z.number().nonnegative(),
  trigger: z.number().nonnegative(),
});

const submitTradeSchema = z.object({
  executionId: z.string().min(1),
  tradeId: z.string().optional(),
  channel: channelSchema,
  origin: z.enum(["RCA", "AI", "USER"]),

  instrument: z.string().min(1),
  direction: z.enum(["BUY", "SELL"]),
  quantity: z.number().positive(),
  entryPrice: z.number().positive(),

  stopLoss: z.number().nullable(),
  takeProfit: z.number().nullable(),
  trailingStopLoss: trailingStopSchema.optional(),

  orderType: z.enum(["MARKET", "LIMIT"]),
  productType: z.enum(["INTRADAY", "BO", "MIS", "CNC"]),

  optionType: z.enum(["CE", "PE", "FUT"]).optional(),
  strike: z.number().optional(),
  expiry: z.string().optional(),
  contractSecurityId: z.string().optional(),

  capitalPercent: z.number().min(0).max(100).optional(),
  timestamp: z.number(),
});

const modifyOrderSchema = z.object({
  executionId: z.string().min(1),
  positionId: z.string().min(1),
  channel: channelSchema,
  modifications: z.object({
    stopLoss: z.number().nullable().optional(),
    takeProfit: z.number().nullable().optional(),
    stopLossPrice: z.number().nullable().optional(),
    targetPrice: z.number().nullable().optional(),
    trailingStopLoss: trailingStopSchema.optional(),
  }),
  reason: z.enum([
    "MOMENTUM_ADJUSTMENT",
    "VOLATILITY_ADJUSTMENT",
    "AI_SIGNAL",
    "DISCIPLINE_REQUEST",
    "USER",
  ]),
  detail: z.string().optional(),
  timestamp: z.number(),
});

const exitTradeSchema = z.object({
  executionId: z.string().min(1),
  positionId: z.string().min(1),
  channel: channelSchema,
  exitType: z.enum(["MARKET", "LIMIT"]),
  exitPrice: z.number().positive().optional(),
  reason: z.enum([
    "MOMENTUM_EXIT",
    "SL_HIT",
    "TP_HIT",
    "AGE_EXIT",
    "DISCIPLINE_EXIT",
    "AI_EXIT",
    "MANUAL",
    "EOD",
    "EXPIRY",
  ]),
  triggeredBy: z.enum(["RCA", "BROKER", "DISCIPLINE", "AI", "USER", "PA"]),
  detail: z.string().optional(),
  currentPrice: z.number().optional(),
  currentPnl: z.number().optional(),
  exitAll: z.boolean().optional(),
  partialExit: z.boolean().optional(),
  timestamp: z.number(),
});

export const executorRouter = router({
  /** Spec §4.1 — submit an approved trade for execution. */
  submitTrade: publicProcedure
    .input(submitTradeSchema)
    .mutation(({ input }) => tradeExecutor.submitTrade(input)),

  /** Spec §4.2 — modify SL / TP / TSL on an open position (live only). */
  modifyOrder: publicProcedure
    .input(modifyOrderSchema)
    .mutation(({ input }) => tradeExecutor.modifyOrder(input)),

  /** Spec §4.3 — exit a position (paper or live). */
  exitTrade: publicProcedure
    .input(exitTradeSchema)
    .mutation(({ input }) => tradeExecutor.exitTrade(input)),
});
