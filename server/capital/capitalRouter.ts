/**
 * Capital Router — tRPC endpoints for the Trading Desk and Capital Management.
 *
 * Provides:
 *   - Capital state queries (pools, day index, session)
 *   - Day record queries (past, current, future projections)
 *   - Trade placement and exit mutations
 *   - Capital injection mutation
 */
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import {
  getCapitalState,
  updateCapitalState,
  getDayRecords,
  getDayRecord,
  upsertDayRecord,
  deleteDayRecordsFrom,
} from "./capitalModel";
import type { Workspace, DayRecord, TradeRecord } from "./capitalModel";
import {
  initializeCapital,
  injectCapital,
  createDayRecord,
  checkDayCompletion,
  completeDayIndex,
  calculateGiftDays,
  processClawback,
  calculateAvailableCapital,
  calculatePositionSize,
  projectFutureDays,
  calculateQuarterlyProjection,
  calculateAllQuarterlyProjections,
  checkSessionReset,
  resetSession,
  recalculateDayAggregates,
  TRADING_SPLIT,
  MAX_DAY_INDEX,
} from "./capitalEngine";
import { calculateTradeCharges } from "./chargesEngine";
import type { ChargeRate } from "./chargesEngine";
import { getUserSettings } from "../userSettings";
import { getActiveBroker } from "../broker/brokerService";
import { getActiveBrokerConfig } from "../broker/brokerConfig";
import type { BrokerSettings, OrderParams } from "../broker/types";
import { createTrade as createJournalEntry, closeTrade as closeJournalEntry } from "../db";

/** System user ID for auto-journaled trades (no auth context in capital flow). */
const SYSTEM_USER_ID = 1;

// ─── Helpers ─────────────────────────────────────────────────────

const workspaceSchema = z.enum(["live", "paper"]);

function generateTradeId(): string {
  return `T${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function getChargeRates(userId: number = 1): Promise<ChargeRate[]> {
  const settings = await getUserSettings(userId);
  return settings.charges.rates as ChargeRate[];
}

/**
 * Read the daily target % from broker config settings.
 * Falls back to the engine constant (5) if no broker config exists.
 */
async function getDailyTargetPercent(): Promise<number> {
  const config = await getActiveBrokerConfig();
  return config?.settings?.dailyTargetPercent ?? 5;
}

/**
 * Read per-instrument trade target % from broker config settings.
 * Options default to 30%, other instruments to 2%.
 */
async function getTradeTargetPercent(instrument: string): Promise<{ tpPercent: number; slPercent: number }> {
  const config = await getActiveBrokerConfig();
  const isOption = /CALL|PUT|CE|PE/i.test(instrument);
  const tpPercent = isOption
    ? (config?.settings?.tradeTargetOptions ?? 30)
    : (config?.settings?.tradeTargetOther ?? 2);
  const slPercent = config?.settings?.defaultSL ?? 10;
  return { tpPercent, slPercent };
}

/**
 * Ensure the current day record exists. Creates Day 1 if needed.
 * Reads dailyTargetPercent from broker config settings (centralized).
 */
async function ensureCurrentDay(workspace: Workspace): Promise<DayRecord> {
  const state = await getCapitalState(workspace);

  // Check session reset
  if (checkSessionReset(state)) {
    await updateCapitalState(workspace, resetSession(state));
  }

  let day = await getDayRecord(workspace, state.currentDayIndex);
  if (!day) {
    // Read target % from centralized settings
    const targetPercent = await getDailyTargetPercent();
    const origProj = state.tradingPool * (1 + targetPercent / 100);
    day = createDayRecord(
      state.currentDayIndex,
      state.tradingPool,
      targetPercent,
      origProj,
      workspace,
      "ACTIVE"
    );
    day = await upsertDayRecord(workspace, day);

    // Sync targetPercent to capital state if it differs
    if (state.targetPercent !== targetPercent) {
      await updateCapitalState(workspace, { targetPercent });
    }
  }
  return day;
}

// ─── Router ──────────────────────────────────────────────────────

export const capitalRouter = router({
  // ─── State Queries ─────────────────────────────────────────────

  /** Get current capital state for a workspace. */
  state: publicProcedure
    .input(z.object({ workspace: workspaceSchema }))
    .query(async ({ input }) => {
      const state = await getCapitalState(input.workspace);
      const day = await ensureCurrentDay(input.workspace);

      // Calculate open position margin
      const openMargin = day.trades
        .filter((t) => t.status === "OPEN")
        .reduce((sum, t) => sum + t.entryPrice * t.qty, 0);

      const available = calculateAvailableCapital(state.tradingPool, openMargin);
      const daysElapsed = Math.floor((Date.now() - state.createdAt) / 86400000);
      const quarterly = calculateQuarterlyProjection(
        state.tradingPool,
        state.reservePool,
        state.currentDayIndex,
        daysElapsed,
        state.initialFunding
      );

      return {
        ...state,
        availableCapital: available,
        openPositionMargin: openMargin,
        netWorth: Math.round((state.tradingPool + state.reservePool) * 100) / 100,
        quarterlyProjection: quarterly,
        allQuarterlyProjections: calculateAllQuarterlyProjections(
          state.tradingPool,
          state.reservePool,
          state.currentDayIndex,
          daysElapsed,
          state.initialFunding
        ),
        todayPnl: day.totalPnl,
        todayTarget: day.targetAmount,
      };
    }),

  /**
   * Sync daily target % from settings to capital state and current day record.
   * Called by the frontend after saving dailyTargetPercent in broker config settings.
   * Updates the current day's targetPercent, targetAmount, and projCapital immediately
   * (but NOT originalProjCapital — that preserves the ideal compounding path).
   */
  syncDailyTarget: publicProcedure
    .input(z.object({ workspace: workspaceSchema }))
    .mutation(async ({ input }) => {
      const targetPercent = await getDailyTargetPercent();
      const state = await getCapitalState(input.workspace);

      // 1. Update capital state
      if (state.targetPercent !== targetPercent) {
        await updateCapitalState(input.workspace, { targetPercent });
      }

      // 2. Update current day record
      const day = await getDayRecord(input.workspace, state.currentDayIndex);
      if (day && day.targetPercent !== targetPercent) {
        day.targetPercent = targetPercent;
        day.targetAmount = Math.round(day.tradeCapital * targetPercent / 100 * 100) / 100;
        day.projCapital = Math.round((day.tradeCapital + day.targetAmount) * 100) / 100;
        // originalProjCapital is NOT changed — it preserves the ideal compounding path
        day.deviation = Math.round((day.actualCapital - day.originalProjCapital) * 100) / 100;
        await upsertDayRecord(input.workspace, day);
      }

      return { success: true, targetPercent };
    }),

  /** Inject new capital (75/25 split). */
  inject: publicProcedure
    .input(z.object({
      workspace: workspaceSchema,
      amount: z.number().positive(),
    }))
    .mutation(async ({ input }) => {
      const targetPercent = await getDailyTargetPercent();

      // Helper to sync a workspace's capital state and day record
      async function syncWorkspace(ws: typeof input.workspace) {
        const state = await getCapitalState(ws);
        const { tradingPool, reservePool } = injectCapital(state, input.amount);
        const updated = await updateCapitalState(ws, {
          tradingPool,
          reservePool,
          initialFunding: state.initialFunding + input.amount,
        });

        // Sync current day record
        const day = await getDayRecord(ws, state.currentDayIndex);
        if (day) {
          day.tradeCapital = tradingPool;
          day.targetPercent = targetPercent;
          day.targetAmount = Math.round(tradingPool * targetPercent / 100 * 100) / 100;
          day.projCapital = Math.round((tradingPool + day.targetAmount) * 100) / 100;
          day.actualCapital = Math.round((tradingPool + day.totalPnl) * 100) / 100;
          day.deviation = Math.round((day.actualCapital - day.originalProjCapital) * 100) / 100;
          await upsertDayRecord(ws, day);
        }
        return updated;
      }

      // Sync both workspaces
      const [liveResult] = await Promise.all([
        syncWorkspace('live'),
        syncWorkspace('paper'),
      ]);

      return liveResult;
    }),

  // ─── Day Record Queries ────────────────────────────────────────

  /** Get completed (past) day records. */
  pastDays: publicProcedure
    .input(z.object({
      workspace: workspaceSchema,
      limit: z.number().min(1).max(250).default(50),
    }))
    .query(async ({ input }) => {
      const state = await getCapitalState(input.workspace);
      return getDayRecords(input.workspace, {
        from: 1,
        to: state.currentDayIndex - 1,
        limit: input.limit,
      });
    }),

  /** Get the current active day with all trades. */
  currentDay: publicProcedure
    .input(z.object({ workspace: workspaceSchema }))
    .query(async ({ input }) => {
      return ensureCurrentDay(input.workspace);
    }),

  /** Get projected future days (computed on-the-fly, not stored). */
  futureDays: publicProcedure
    .input(z.object({
      workspace: workspaceSchema,
      count: z.number().min(1).max(50).default(20),
    }))
    .query(async ({ input }) => {
      const state = await getCapitalState(input.workspace);
      const day = await ensureCurrentDay(input.workspace);
      const startCapital = day.actualCapital > 0 ? day.actualCapital : state.tradingPool;
      const startDay = state.currentDayIndex + 1;
      const targetPercent = await getDailyTargetPercent();

      return projectFutureDays(
        startDay,
        startCapital * TRADING_SPLIT, // only trading pool share compounds
        targetPercent,
        input.count,
        input.workspace
      );
    }),

  /** Get all days for the table view (past + current + future). */
  allDays: publicProcedure
    .input(z.object({
      workspace: workspaceSchema,
      futureCount: z.number().min(0).max(250).default(250),
    }))
    .query(async ({ input }) => {
      const state = await getCapitalState(input.workspace);
      const pastDays = await getDayRecords(input.workspace, {
        from: 1,
        to: state.currentDayIndex - 1,
      });
      const currentDay = await ensureCurrentDay(input.workspace);

      // Project future days from current actual capital
      const startCapital = currentDay.actualCapital > 0
        ? currentDay.actualCapital
        : state.tradingPool;
      const targetPercent = await getDailyTargetPercent();
      const futureDays = input.futureCount > 0
        ? projectFutureDays(
            state.currentDayIndex + 1,
            startCapital,
            targetPercent,
            input.futureCount,
            input.workspace
          )
        : [];

      return {
        pastDays,
        currentDay,
        futureDays,
        currentDayIndex: state.currentDayIndex,
      };
    }),

  // ─── Trade Mutations ───────────────────────────────────────────

  /** Place a new trade. */
  placeTrade: publicProcedure
    .input(z.object({
      workspace: workspaceSchema,
      instrument: z.string(),
      type: z.enum(["CALL_BUY", "CALL_SELL", "PUT_BUY", "PUT_SELL", "BUY", "SELL"]),
      strike: z.number().nullable().default(null),
      entryPrice: z.number().positive(),
      capitalPercent: z.number().min(5).max(25),
      expiry: z.string().optional().default(""),  // expiry date (YYYY-MM-DD), empty = nearest
      targetPercent: z.number().optional(),   // TP % from entry
      stopLossPercent: z.number().optional(),  // SL % from entry
    }))
    .mutation(async ({ input }) => {
      const state = await getCapitalState(input.workspace);
      const day = await ensureCurrentDay(input.workspace);

      // Calculate open margin
      const openMargin = day.trades
        .filter((t) => t.status === "OPEN")
        .reduce((sum, t) => sum + t.entryPrice * t.qty, 0);

      const available = calculateAvailableCapital(state.tradingPool, openMargin);
      const { qty, margin } = calculatePositionSize(
        available,
        input.capitalPercent,
        input.entryPrice
      );

      if (qty <= 0) {
        throw new Error("Insufficient capital for this trade");
      }

      // Calculate bracket order levels — TP/SL defaults from broker config settings
      const isBuy = input.type.includes("BUY");
      const tradeDefaults = await getTradeTargetPercent(input.type);
      const tpPercent = input.targetPercent ?? tradeDefaults.tpPercent;
      const slPercent = input.stopLossPercent ?? tradeDefaults.slPercent;
      const targetPrice = isBuy
        ? Math.round(input.entryPrice * (1 + tpPercent / 100) * 100) / 100
        : Math.round(input.entryPrice * (1 - tpPercent / 100) * 100) / 100;
      const stopLossPrice = isBuy
        ? Math.round(input.entryPrice * (1 - slPercent / 100) * 100) / 100
        : Math.round(input.entryPrice * (1 + slPercent / 100) * 100) / 100;

      const trade: TradeRecord = {
        id: generateTradeId(),
        instrument: input.instrument,
        type: input.type,
        strike: input.strike,
        entryPrice: input.entryPrice,
        exitPrice: null,
        ltp: input.entryPrice,
        qty,
        capitalPercent: input.capitalPercent,
        pnl: 0,
        unrealizedPnl: 0,
        charges: 0,
        chargesBreakdown: [],
        status: "OPEN",
        targetPrice,
        stopLossPrice,
        brokerId: null,
        openedAt: Date.now(),
        closedAt: null,
      };

      // ── Broker order placement (live workspace only) ──────────
      let brokerOrderId: string | null = null;
      if (input.workspace === "live") {
        const broker = getActiveBroker();
        const config = await getActiveBrokerConfig();
        if (broker && config && !config.isPaperBroker) {
          try {
            const isBuyTxn = input.type.includes("BUY");
            const optType = input.type.startsWith("CALL")
              ? "CE" as const
              : input.type.startsWith("PUT")
              ? "PE" as const
              : "FUT" as const;
            const exchange = (input.instrument.includes("CRUDE") || input.instrument.includes("NATURAL"))
              ? "MCX_COMM" as const
              : "NSE_FNO" as const;

            const orderParams: OrderParams = {
              instrument: input.instrument,
              exchange,
              transactionType: isBuyTxn ? "BUY" : "SELL",
              optionType: optType,
              strike: input.strike ?? 0,
              expiry: input.expiry || "",  // empty = resolved by adapter via scrip master
              quantity: qty,
              price: input.entryPrice,
              orderType: config.settings.orderType ?? "LIMIT",
              productType: config.settings.productType ?? "INTRADAY",
              stopLoss: stopLossPrice,
              target: targetPrice,
              tag: trade.id,
            };

            const result = await broker.placeOrder(orderParams);
            brokerOrderId = result.orderId;
            console.log(`[Capital] Broker order placed: ${result.orderId} (${result.status})`);
          } catch (err) {
            console.error("[Capital] Broker order failed:", err);
            // Trade is still recorded in capital engine even if broker fails
          }
        }
      }

      trade.brokerId = brokerOrderId;
      day.trades.push(trade);
      const updated = recalculateDayAggregates(day);

      // Update session counter
      await updateCapitalState(input.workspace, {
        sessionTradeCount: state.sessionTradeCount + 1,
      });

      await upsertDayRecord(input.workspace, updated);

      // ── Auto-journal: fire-and-forget ──────────────────────
      try {
        const journalMode = input.workspace === "live" ? "LIVE" as const : "PAPER" as const;
        const journalType = ["CALL_BUY", "PUT_BUY", "CALL_SELL", "PUT_SELL"].includes(input.type)
          ? input.type as "CALL_BUY" | "PUT_BUY" | "CALL_SELL" | "PUT_SELL"
          : input.type === "BUY" ? "CALL_BUY" as const : "PUT_SELL" as const;
        const journalId = await createJournalEntry({
          userId: SYSTEM_USER_ID,
          instrument: input.instrument,
          tradeType: journalType,
          strike: input.strike ?? 0,
          entryPrice: input.entryPrice,
          quantity: qty,
          stopLoss: stopLossPrice,
          target: targetPrice,
          mode: journalMode,
          entryTime: trade.openedAt,
          tags: `capital:${trade.id}`,
        });
        // Store journal ID on trade for exit sync
        (trade as any).journalId = journalId;
      } catch (err) {
        console.warn("[Capital] Auto-journal entry failed:", err);
      }

      return { trade, day: updated };
    }),

  /** Exit a single trade. */
  exitTrade: publicProcedure
    .input(z.object({
      workspace: workspaceSchema,
      tradeId: z.string(),
      exitPrice: z.number().positive(),
      reason: z.enum(["MANUAL", "TP", "SL", "PARTIAL", "EOD"]).default("MANUAL"),
    }))
    .mutation(async ({ input }) => {
      const state = await getCapitalState(input.workspace);
      const day = await ensureCurrentDay(input.workspace);

      const trade = day.trades.find((t) => t.id === input.tradeId);
      if (!trade) throw new Error(`Trade not found: ${input.tradeId}`);
      if (trade.status !== "OPEN") throw new Error(`Trade already closed: ${input.tradeId}`);

      // ── Close broker position (live workspace only) ──────────
      if (input.workspace === "live" && trade.brokerId) {
        const broker = getActiveBroker();
        const config = await getActiveBrokerConfig();
        if (broker && config && !config.isPaperBroker) {
          try {
            const isBuyTxn = trade.type.includes("BUY");
            const optType = trade.type.startsWith("CALL")
              ? "CE" as const
              : trade.type.startsWith("PUT")
              ? "PE" as const
              : "FUT" as const;
            const exchange = (trade.instrument.includes("CRUDE") || trade.instrument.includes("NATURAL"))
              ? "MCX_COMM" as const
              : "NSE_FNO" as const;

            // Exit = opposite transaction
            const exitOrder: OrderParams = {
              instrument: trade.instrument,
              exchange,
              transactionType: isBuyTxn ? "SELL" : "BUY",
              optionType: optType,
              strike: trade.strike ?? 0,
              expiry: "",
              quantity: trade.qty,
              price: input.exitPrice,
              orderType: config.settings.orderType ?? "LIMIT",
              productType: config.settings.productType ?? "INTRADAY",
              tag: `EXIT-${trade.id}`,
            };

            const result = await broker.placeOrder(exitOrder);
            console.log(`[Capital] Broker exit order placed: ${result.orderId} (${result.status})`);
          } catch (err) {
            console.error("[Capital] Broker exit order failed:", err);
          }
        }
      }

      // Calculate P&L
      const isBuy = trade.type.includes("BUY");
      const direction = isBuy ? 1 : -1;
      const grossPnl = (input.exitPrice - trade.entryPrice) * trade.qty * direction;

      // Calculate charges
      const chargeRates = await getChargeRates();
      const charges = calculateTradeCharges(
        {
          entryPrice: trade.entryPrice,
          exitPrice: input.exitPrice,
          qty: trade.qty,
          isBuy,
          exchange: trade.instrument.includes("CRUDE") || trade.instrument.includes("NATURAL") ? "MCX" : "NSE",
        },
        chargeRates
      );

      // Update trade
      trade.exitPrice = input.exitPrice;
      trade.pnl = Math.round((grossPnl - charges.total) * 100) / 100;
      trade.charges = charges.total;
      trade.chargesBreakdown = charges.breakdown;
      trade.unrealizedPnl = 0;
      trade.closedAt = Date.now();

      const statusMap: Record<string, TradeRecord["status"]> = {
        MANUAL: "CLOSED_MANUAL",
        TP: "CLOSED_TP",
        SL: "CLOSED_SL",
        PARTIAL: "CLOSED_PARTIAL",
        EOD: "CLOSED_EOD",
      };
      trade.status = statusMap[input.reason] ?? "CLOSED_MANUAL";

      // ── Auto-journal close: fire-and-forget ──────────────────
      try {
        const { getUserTrades } = await import("../db");
        const journalTrades = await getUserTrades(SYSTEM_USER_ID, {
          status: "OPEN",
          instrument: trade.instrument,
          limit: 50,
        });
        const match = journalTrades.find((j) => j.tags === `capital:${trade.id}`);
        if (match) {
          await closeJournalEntry(
            match.id,
            SYSTEM_USER_ID,
            input.exitPrice,
            trade.closedAt!,
            input.reason
          );
        }
      } catch (err) {
        console.warn("[Capital] Auto-journal close failed:", err);
      }

      // Recalculate day aggregates
      const updated = recalculateDayAggregates(day);
      await upsertDayRecord(input.workspace, updated);

      // Update session P&L
      await updateCapitalState(input.workspace, {
        sessionPnl: state.sessionPnl + trade.pnl,
        cumulativePnl: state.cumulativePnl + trade.pnl,
        cumulativeCharges: state.cumulativeCharges + charges.total,
      });

      // Check day completion
      const completion = checkDayCompletion(updated);
      if (completion.complete) {
        const result = completeDayIndex(state, updated);

        // Update capital state
        const newState = await updateCapitalState(input.workspace, {
          tradingPool: result.tradingPool,
          reservePool: result.reservePool,
          currentDayIndex: state.currentDayIndex + 1,
          profitHistory: [...state.profitHistory, result.profitEntry],
        });

        // Mark day as completed
        updated.status = "COMPLETED";
        updated.rating = result.rating;
        await upsertDayRecord(input.workspace, updated);

        // Handle gift days if excess profit
        if (completion.excessProfit > 0) {
          const gifts = calculateGiftDays(
            completion.excessProfit,
            state.currentDayIndex + 1,
            result.tradingPool,
            state.targetPercent,
            (idx) => result.tradingPool * Math.pow(1 + state.targetPercent / 100, idx - state.currentDayIndex),
            input.workspace
          );

          for (const giftDay of gifts.giftDays) {
            await upsertDayRecord(input.workspace, giftDay);
          }

          if (gifts.giftDays.length > 0) {
            await updateCapitalState(input.workspace, {
              currentDayIndex: state.currentDayIndex + 1 + gifts.giftDays.length,
              tradingPool: gifts.finalTradingPool,
            });
          }
        }

        return { trade, day: updated, dayCompleted: true, giftDays: completion.excessProfit > 0 };
      }

      // Check for clawback (significant loss)
      if (updated.totalPnl < 0 && Math.abs(updated.totalPnl) >= updated.targetAmount) {
        const clawback = processClawback(updated.totalPnl, state);

        await updateCapitalState(input.workspace, {
          tradingPool: clawback.newTradingPool,
          currentDayIndex: clawback.newDayIndex,
          profitHistory: clawback.updatedHistory,
        });

        // Delete consumed day records
        if (clawback.consumedDayIndices.length > 0) {
          for (const idx of clawback.consumedDayIndices) {
            await deleteDayRecordsFrom(input.workspace, idx);
          }
        }

        return { trade, day: updated, dayCompleted: false, clawback: true };
      }

      return { trade, day: updated, dayCompleted: false };
    }),

  /** Exit all open trades. */
  exitAll: publicProcedure
    .input(z.object({
      workspace: workspaceSchema,
      exitPrices: z.record(z.string(), z.number()), // tradeId → exitPrice
    }))
    .mutation(async ({ input }) => {
      const day = await ensureCurrentDay(input.workspace);
      const openTrades = day.trades.filter((t) => t.status === "OPEN");
      const results = [];

      for (const trade of openTrades) {
        const exitPrice = input.exitPrices[trade.id] ?? trade.ltp;
        // Delegate to exitTrade logic inline
        const isBuy = trade.type.includes("BUY");
        const direction = isBuy ? 1 : -1;
        const grossPnl = (exitPrice - trade.entryPrice) * trade.qty * direction;

        const chargeRates = await getChargeRates();
        const charges = calculateTradeCharges(
          {
            entryPrice: trade.entryPrice,
            exitPrice,
            qty: trade.qty,
            isBuy,
            exchange: trade.instrument.includes("CRUDE") || trade.instrument.includes("NATURAL") ? "MCX" : "NSE",
          },
          chargeRates
        );

        trade.exitPrice = exitPrice;
        trade.pnl = Math.round((grossPnl - charges.total) * 100) / 100;
        trade.charges = charges.total;
        trade.chargesBreakdown = charges.breakdown;
        trade.unrealizedPnl = 0;
        trade.status = "CLOSED_MANUAL";
        trade.closedAt = Date.now();

        results.push({ tradeId: trade.id, pnl: trade.pnl, charges: charges.total });
      }

      const updated = recalculateDayAggregates(day);
      await upsertDayRecord(input.workspace, updated);

      // Update cumulative state
      const state = await getCapitalState(input.workspace);
      const totalPnl = results.reduce((sum, r) => sum + r.pnl, 0);
      const totalCharges = results.reduce((sum, r) => sum + r.charges, 0);
      await updateCapitalState(input.workspace, {
        sessionPnl: state.sessionPnl + totalPnl,
        cumulativePnl: state.cumulativePnl + totalPnl,
        cumulativeCharges: state.cumulativeCharges + totalCharges,
      });

      return { results, day: updated };
    }),

  /** Update LTP for open trades (called by polling). */
  updateLtp: publicProcedure
    .input(z.object({
      workspace: workspaceSchema,
      prices: z.record(z.string(), z.number()), // tradeId → ltp
    }))
    .mutation(async ({ input }) => {
      const day = await ensureCurrentDay(input.workspace);
      let changed = false;

      for (const trade of day.trades) {
        if (trade.status === "OPEN" && input.prices[trade.id] !== undefined) {
          trade.ltp = input.prices[trade.id];
          changed = true;
        }
      }

      if (changed) {
        const updated = recalculateDayAggregates(day);
        await upsertDayRecord(input.workspace, updated);
        return updated;
      }

      return day;
    }),
});
