/**
 * Trade Executor Agent — tRPC router.
 *
 * Exposes spec §4 inputs as `executor.*` procedures. Every other agent /
 * UI consumer uses these to submit trade intent; nothing else should call
 * brokerService directly.
 *
 * Two flavours of write API:
 *   - Formal (spec §4): `submitTrade`, `modifyOrder`, `exitTrade` — used
 *     by RCA, AI, future SEA. Caller supplies fully-resolved fields.
 *   - UI-compat: `placeTrade`, `updateTrade` — used by the Trading Desk
 *     and signal trade buttons. Server resolves lot size, contract
 *     securityId, default SL/TP %, then delegates to the formal API.
 *     UI's `exitTrade` shape is small enough that the client translates
 *     it on the fly into the formal `exitTrade` request.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { tradeExecutor } from "./tradeExecutor";
import {
  getDailyTargetPercent,
  getTradeTargetPercent,
  resolveContract,
  resolveLotSize,
  resolveNearestExpiry,
} from "./tradeResolution";
import { getExecutorSettings, updateExecutorSettings } from "./settings";
import { getCapitalState, getDayRecord } from "../portfolio/state";
import { calculateAvailableCapital, calculatePositionSize } from "../portfolio/compounding";
import { getActiveBrokerConfig } from "../broker/brokerConfig";
import { portfolioAgent } from "../portfolio";

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
  ]),
  triggeredBy: z.enum(["RCA", "BROKER", "DISCIPLINE", "AI", "USER", "PA"]),
  detail: z.string().optional(),
  currentPrice: z.number().optional(),
  currentPnl: z.number().optional(),
  exitAll: z.boolean().optional(),
  partialExit: z.boolean().optional(),
  timestamp: z.number(),
});

// ─── UI-compat schemas (legacy NewTradeForm shape) ──────────────

const uiTradeTypeSchema = z.enum([
  "CALL_BUY",
  "CALL_SELL",
  "PUT_BUY",
  "PUT_SELL",
  "BUY",
  "SELL",
]);

const placeTradeUiSchema = z.object({
  channel: channelSchema,
  instrument: z.string(),
  type: uiTradeTypeSchema,
  strike: z.number().nullable().default(null),
  entryPrice: z.number().positive(),
  capitalPercent: z.number().min(5).max(100),
  expiry: z.string().optional().default(""),
  contractSecurityId: z.string().optional().nullable(),
  qty: z.number().int().positive().optional(),
  lotSize: z.number().int().positive().optional(),
  targetPercent: z.number().optional(),
  stopLossPercent: z.number().optional(),
  targetPrice: z.number().nullable().optional(),
  stopLossPrice: z.number().nullable().optional(),
  trailingStopEnabled: z.boolean().optional(),
});

const updateTradeUiSchema = z.object({
  channel: channelSchema,
  tradeId: z.string(),
  targetPrice: z.number().positive().optional(),
  stopLossPrice: z.number().positive().optional(),
  trailingStopEnabled: z.boolean().optional(),
});

// ─── B4: BROKER_DESYNC reconciliation ──────────────────────────
//
// After exitTrade or modifyOrder fails at the broker, the trade is
// flagged as desync'd. The operator goes to Dhan to determine TRUE
// state, then calls reconcileDesync with the appropriate action:
//
//   confirm-closed   → broker confirms position gone. Close locally at
//                      the operator-supplied exit price.
//   confirm-still-open → broker confirms position alive. Restore status
//                        and (optionally) overwrite local SL/TP to match
//                        what's currently at broker.
//   cancel-modify    → MODIFY-desync only. Keep local SL/TP unchanged;
//                      just clear the desync flag.
//
const reconcileDesyncSchema = z
  .object({
    channel: channelSchema,
    tradeId: z.string().min(1),
    action: z.enum(["confirm-closed", "confirm-still-open", "cancel-modify"]),
    /** Required when action="confirm-closed" — broker's reported exit price. */
    exitPrice: z.number().positive().optional(),
    /** Required when action="confirm-closed" — closure status to record. */
    closeStatus: z
      .enum([
        "CLOSED_TP",
        "CLOSED_SL",
        "CLOSED_MANUAL",
        "CLOSED_PARTIAL",
        "CLOSED_EOD",
      ])
      .optional(),
    /** Required when action="confirm-still-open" — broker's current SL. */
    stopLossPrice: z.number().nullable().optional(),
    /** Required when action="confirm-still-open" — broker's current TP. */
    targetPrice: z.number().nullable().optional(),
    /** Free-text operator note for the audit log. */
    note: z.string().optional(),
  })
  .strict();

export const executorRouter = router({
  // ── Formal API (RCA / AI / SEA) ─────────────────────────────

  /** Spec §4.1 — submit an approved trade for execution. */
  submitTrade: protectedProcedure
    .input(submitTradeSchema)
    .mutation(({ input }) => tradeExecutor.submitTrade(input)),

  /** Spec §4.2 — modify SL / TP / TSL on an open position (live only). */
  modifyOrder: protectedProcedure
    .input(modifyOrderSchema)
    .mutation(({ input }) => tradeExecutor.modifyOrder(input)),

  /** Spec §4.3 — exit a position (paper or live). */
  exitTrade: protectedProcedure
    .input(exitTradeSchema)
    .mutation(({ input }) => tradeExecutor.exitTrade(input)),

  // ── UI-compat (NewTradeForm + signal trade buttons) ─────────

  /**
   * UI-friendly placement: takes the legacy `portfolio.placeTrade` input
   * shape (type / qty / lotSize / capital%, with optional TP/SL %), runs
   * server-side resolution (lot size, option contract, defaults), then
   * delegates to tradeExecutor.submitTrade. Single writer is preserved —
   * this procedure is just an input adapter.
   */
  placeTrade: protectedProcedure
    .input(placeTradeUiSchema)
    .mutation(async ({ input }) => {
      // ── 1. Resolve nearest expiry for option trades when missing ──
      const isOption = /^(CALL|PUT)_/.test(input.type);
      let expiry = input.expiry;
      if (isOption && !expiry) {
        const resolved = await resolveNearestExpiry(input.instrument);
        if (resolved) expiry = resolved;
      }

      // ── 2. Resolve lot size when missing ────────────────────────
      let lotSize = input.lotSize;
      if (isOption && !lotSize) {
        const ls = await resolveLotSize(input.instrument);
        if (ls) lotSize = ls;
      }

      // ── 3. Resolve option contract + LTP delta-shift ────────────
      let contractSecurityId = input.contractSecurityId ?? undefined;
      let strike = input.strike;
      let entryPrice = input.entryPrice;
      let targetPriceOverride = input.targetPrice ?? null;
      let stopLossPriceOverride = input.stopLossPrice ?? null;
      if (isOption && !contractSecurityId && expiry && strike != null) {
        const isCall = input.type.startsWith("CALL");
        const resolved = await resolveContract(input.instrument, expiry, strike, isCall);
        if (resolved) {
          contractSecurityId = resolved.secId;
          strike = resolved.strike;
          const delta = resolved.ltp - entryPrice;
          entryPrice = resolved.ltp;
          if (targetPriceOverride != null) targetPriceOverride += delta;
          if (stopLossPriceOverride != null) stopLossPriceOverride += delta;
        }
      }

      // ── 4. Compute qty + margin ─────────────────────────────────
      const state = await getCapitalState(input.channel);
      const day = await portfolioAgent.ensureCurrentDay(input.channel);
      const openMargin = day.trades
        .filter((t) => t.status === "OPEN")
        .reduce((sum, t) => sum + t.entryPrice * t.qty, 0);
      const available = calculateAvailableCapital(state.tradingPool, openMargin);

      let qty: number;
      let margin: number;
      if (input.qty != null && input.qty > 0) {
        qty = input.qty * (lotSize ?? 1);
        margin = qty * entryPrice;
      } else {
        ({ qty, margin } = calculatePositionSize(
          available,
          input.capitalPercent,
          entryPrice,
          lotSize ?? 1,
        ));
      }
      if (margin > available) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Insufficient capital for this trade",
        });
      }

      // ── 5. Resolve TP / SL — absolute → %-from-entry → defaults ─
      const isBuy = input.type.includes("BUY");
      const tradeDefaults = await getTradeTargetPercent(input.type);

      let resolvedTakeProfit: number | null;
      if (input.targetPrice !== undefined) {
        resolvedTakeProfit = targetPriceOverride; // absolute override (delta-shifted)
      } else {
        const tpPercent = input.targetPercent ?? tradeDefaults.tpPercent;
        resolvedTakeProfit = isBuy
          ? Math.round(entryPrice * (1 + tpPercent / 100) * 100) / 100
          : Math.round(entryPrice * (1 - tpPercent / 100) * 100) / 100;
      }

      let resolvedStopLoss: number | null;
      if (input.stopLossPrice !== undefined) {
        resolvedStopLoss = stopLossPriceOverride;
      } else {
        const slPercent = input.stopLossPercent ?? tradeDefaults.slPercent;
        resolvedStopLoss = isBuy
          ? Math.round(entryPrice * (1 - slPercent / 100) * 100) / 100
          : Math.round(entryPrice * (1 + slPercent / 100) * 100) / 100;
      }

      // ── 6. Resolve order type / product type from broker config ─
      const config = await getActiveBrokerConfig();
      const orderType = (config?.settings?.orderType as "MARKET" | "LIMIT" | undefined) ?? "LIMIT";
      const productType = (config?.settings?.productType as "INTRADAY" | "CNC" | undefined) ?? "INTRADAY";

      // ── 7. Hand off to TEA's formal API ─────────────────────────
      const optionTypeForExec: "CE" | "PE" | "FUT" =
        input.type.startsWith("CALL") ? "CE" : input.type.startsWith("PUT") ? "PE" : "FUT";
      const direction: "BUY" | "SELL" = isBuy ? "BUY" : "SELL";

      const submitResp = await tradeExecutor.submitTrade({
        executionId: `UI-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channel: input.channel,
        origin: "USER",
        instrument: input.instrument,
        direction,
        quantity: qty,
        entryPrice,
        stopLoss: resolvedStopLoss,
        takeProfit: resolvedTakeProfit,
        orderType,
        productType,
        optionType: optionTypeForExec,
        strike: strike ?? undefined,
        expiry: expiry || undefined,
        contractSecurityId,
        capitalPercent: input.capitalPercent,
        timestamp: Date.now(),
      });
      if (!submitResp.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: submitResp.error ?? "Trade submission rejected",
        });
      }

      // Return the trade record + day (matches legacy `portfolio.placeTrade`
      // response shape for backward compat with existing UI code).
      const updatedDay = await getDayRecord(input.channel, state.currentDayIndex);
      const trade = updatedDay?.trades.find((t) => t.id === submitResp.tradeId);
      void margin;
      return { trade, day: updatedDay };
    }),

  // ── Settings (shared TEA / RCA / recovery tunables) ────────

  /** Read the executor settings doc. Defaults applied when Mongo empty. */
  getSettings: publicProcedure.query(() => getExecutorSettings()),

  /** Update one or more executor settings fields. Cache invalidated. */
  updateSettings: protectedProcedure
    .input(
      z.object({
        aiLiveLotCap: z.number().int().min(1).max(100).optional(),
        rcaMaxAgeMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
        rcaStaleTickMs: z.number().int().min(30_000).max(60 * 60 * 1000).optional(),
        rcaVolThreshold: z.number().min(0).max(2).optional(),
        recoveryStuckMs: z.number().int().min(10_000).max(10 * 60 * 1000).optional(),
        seaBridgeEnabled: z.boolean().optional(),
        seaBridgeChannel: channelSchema.optional(),
        seaBridgePollIntervalMs: z.number().int().min(1_000).max(5 * 60 * 1000).optional(),
        seaBridgeDirectionFilter: z.enum(["LONG_ONLY", "ALL"]).optional(),
        rcaChannels: z.array(channelSchema).min(0).max(6).optional(),
        recoveryChannels: z.array(channelSchema).min(0).max(6).optional(),
        // B4-followup — desync auto kill-switch
        desyncKillSwitchEnabled: z.boolean().optional(),
        desyncKillSwitchThreshold: z.number().int().min(1).max(50).optional(),
        desyncKillSwitchWindowSeconds: z.number().int().min(60).max(86_400).optional(),
      }),
    )
    .mutation(({ input }) => updateExecutorSettings(input)),

  /**
   * B4 — Reconcile a BROKER_DESYNC trade. Operator-driven; assumes the
   * operator has verified the trade's true state at the broker (Dhan UI)
   * before calling. This procedure mutates local state to match.
   */
  reconcileDesync: protectedProcedure
    .input(reconcileDesyncSchema)
    .mutation(async ({ input }) => {
      const day = await portfolioAgent.ensureCurrentDay(input.channel);
      const trade = day.trades.find((t) => t.id === input.tradeId);
      if (!trade) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Trade not found: ${input.tradeId}` });
      }
      if (!trade.desync) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Trade ${input.tradeId} is not in BROKER_DESYNC state`,
        });
      }

      switch (input.action) {
        case "confirm-closed": {
          if (input.exitPrice == null || !input.closeStatus) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "confirm-closed requires exitPrice + closeStatus",
            });
          }
          const result = await portfolioAgent.closeTrade(
            input.channel,
            input.tradeId,
            input.exitPrice,
            input.closeStatus,
          );
          // closeTrade already drops the desync marker on success.
          return {
            success: true as const,
            action: input.action,
            trade: result.trade,
            pnl: result.pnl,
          };
        }

        case "confirm-still-open": {
          // clearTradeDesync flips BROKER_DESYNC → OPEN and removes the
          // marker. After it runs the trade is in OPEN state, so PA's
          // updateTrade (which guards on OPEN) can apply SL/TP corrections
          // captured from the broker UI.
          await portfolioAgent.clearTradeDesync(input.channel, input.tradeId);
          if (input.stopLossPrice !== undefined || input.targetPrice !== undefined) {
            await portfolioAgent.updateTrade(input.channel, input.tradeId, {
              stopLossPrice: input.stopLossPrice ?? undefined,
              targetPrice: input.targetPrice ?? undefined,
            });
          }
          const refreshed = (await portfolioAgent.ensureCurrentDay(input.channel))
            .trades.find((t) => t.id === input.tradeId);
          return { success: true as const, action: input.action, trade: refreshed };
        }

        case "cancel-modify": {
          if (trade.desync.kind !== "MODIFY") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "cancel-modify only valid for MODIFY-kind desync",
            });
          }
          await portfolioAgent.clearTradeDesync(input.channel, input.tradeId);
          const refreshed = (await portfolioAgent.ensureCurrentDay(input.channel))
            .trades.find((t) => t.id === input.tradeId);
          return { success: true as const, action: input.action, trade: refreshed };
        }
      }
    }),

  /**
   * UI-friendly SL / TP / TSL update. Wraps tradeExecutor.modifyOrder with
   * the legacy `portfolio.updateTrade` input shape.
   */
  updateTrade: protectedProcedure
    .input(updateTradeUiSchema)
    .mutation(async ({ input }) => {
      const positionId = `POS-${input.tradeId.replace(/^T/, "")}`;
      const resp = await tradeExecutor.modifyOrder({
        executionId: `UI-MOD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        positionId,
        channel: input.channel,
        modifications: {
          stopLossPrice: input.stopLossPrice,
          targetPrice: input.targetPrice,
          trailingStopLoss: input.trailingStopEnabled !== undefined
            ? { enabled: input.trailingStopEnabled, distance: 0, trigger: 0 }
            : undefined,
        },
        reason: "USER",
        timestamp: Date.now(),
      });
      if (!resp.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: resp.error ?? "Modify rejected",
        });
      }
      const day = await portfolioAgent.ensureCurrentDay(input.channel);
      const trade = day.trades.find((t) => t.id === input.tradeId);
      return { trade };
    }),
});
