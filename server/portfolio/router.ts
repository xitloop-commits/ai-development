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
  deleteAllDayRecords,
  replaceCapitalState,
} from "./state";
import type { Channel, DayRecord, TradeRecord } from "./state";
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
} from "./compounding";
import { calculateTradeCharges } from "./charges";
import type { ChargeRate } from "./charges";
import { getUserSettings } from "../userSettings";
import { getActiveBroker } from "../broker/brokerService";
import { getActiveBrokerConfig } from "../broker/brokerConfig";
import { tickBus } from "../broker/tickBus";
import type { BrokerSettings, OrderParams } from "../broker/types";
import { portfolioAgent } from "./portfolioAgent";
// ─── Helpers ─────────────────────────────────────────────────────

const channelSchema = z.enum(["ai-live", "ai-paper", "my-live", "my-paper", "testing-live", "testing-sandbox"]);
/** Channels that mirror My Trades LIVE capital ops for shadow tracking. */
const mirroredChannels: Channel[] = ["my-paper", "ai-paper", "testing-sandbox"];

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
 * Ensure the current day record exists. Creates Day 1 if needed.
 * Reads dailyTargetPercent from broker config settings (centralized).
 */
async function ensureCurrentDay(channel: Channel): Promise<DayRecord> {
  const state = await getCapitalState(channel);

  // Check session reset
  if (checkSessionReset(state)) {
    await updateCapitalState(channel, resetSession(state));
  }

  let day = await getDayRecord(channel, state.currentDayIndex);
  if (!day) {
    // Read target % from centralized settings
    const targetPercent = await getDailyTargetPercent();
    const origProj = state.tradingPool * (1 + targetPercent / 100);
    day = createDayRecord(
      state.currentDayIndex,
      state.tradingPool,
      targetPercent,
      origProj,
      channel,
      "ACTIVE"
    );
    day = await upsertDayRecord(channel, day);

    // Sync targetPercent to capital state if it differs
    if (state.targetPercent !== targetPercent) {
      await updateCapitalState(channel, { targetPercent });
    }
  }
  return day;
}

// ─── Router ──────────────────────────────────────────────────────

export const portfolioRouter = router({
  // ─── State Queries ─────────────────────────────────────────────

  /** Get current capital state for a workspace. */
  state: publicProcedure
    .input(z.object({ channel: channelSchema }))
    .query(async ({ input }) => {
      const state = await getCapitalState(input.channel);
      const day = await ensureCurrentDay(input.channel);

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
        state.initialFunding,
        state.targetPercent
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
          state.initialFunding,
          state.targetPercent
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
    .input(z.object({ channel: channelSchema }))
    .mutation(async ({ input }) => {
      const targetPercent = await getDailyTargetPercent();
      const state = await getCapitalState(input.channel);

      // 1. Update capital state
      if (state.targetPercent !== targetPercent) {
        await updateCapitalState(input.channel, { targetPercent });
      }

      // 2. Update current day record
      const day = await getDayRecord(input.channel, state.currentDayIndex);
      if (day && day.targetPercent !== targetPercent) {
        day.targetPercent = targetPercent;
        day.targetAmount = Math.round(day.tradeCapital * targetPercent / 100 * 100) / 100;
        day.projCapital = Math.round((day.tradeCapital + day.targetAmount) * 100) / 100;
        // originalProjCapital is NOT changed — it preserves the ideal compounding path
        day.deviation = Math.round((day.actualCapital - day.originalProjCapital) * 100) / 100;
        await upsertDayRecord(input.channel, day);
      }

      return { success: true, targetPercent };
    }),

  /** Inject new capital (75/25 split). */
  inject: publicProcedure
    .input(z.object({
      channel: channelSchema,
      amount: z.number().positive(),
    }))
    .mutation(async ({ input }) => {
      const targetPercent = await getDailyTargetPercent();

      // Helper to sync a workspace's capital state and day record
      async function syncWorkspace(ws: typeof input.channel) {
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

      // Sync live workspace (primary — must succeed)
      const liveResult = await syncWorkspace('my-live');

      // Sync mirror channels (best-effort — don't let them break the inject)
      for (const channel of mirroredChannels) {
        try {
          await syncWorkspace(channel);
        } catch (err) {
          console.warn(`[portfolio.inject] ${channel} channel sync failed (non-fatal):`, err);
        }
      }

      return liveResult;
    }),

  /** Transfer funds between Trading ↔ Reserve pools. */
  transferFunds: publicProcedure
    .input(z.object({
      channel: channelSchema,
      from: z.enum(['trading', 'reserve']),
      to: z.enum(['trading', 'reserve']),
      amount: z.number().positive(),
    }))
    .mutation(async ({ input }) => {
      if (input.from === input.to) throw new Error('Cannot transfer to same pool');

      const targetPercent = await getDailyTargetPercent();

      async function syncWorkspace(ws: typeof input.channel) {
        const state = await getCapitalState(ws);

        // Validate sufficient balance
        const sourceBalance = input.from === 'trading' ? state.tradingPool : state.reservePool;
        if (input.amount > sourceBalance) {
          throw new Error(`Insufficient ${input.from} pool balance: ${sourceBalance}`);
        }

        const tradingDelta = input.from === 'trading' ? -input.amount : input.amount;
        const newTrading = Math.round((state.tradingPool + tradingDelta) * 100) / 100;
        const newReserve = Math.round((state.reservePool - tradingDelta) * 100) / 100;

        const updated = await updateCapitalState(ws, {
          tradingPool: newTrading,
          reservePool: newReserve,
        });

        // Sync current day record with new trading capital
        const day = await getDayRecord(ws, state.currentDayIndex);
        if (day) {
          day.tradeCapital = newTrading;
          day.targetPercent = targetPercent;
          day.targetAmount = Math.round(newTrading * targetPercent / 100 * 100) / 100;
          day.projCapital = Math.round((newTrading + day.targetAmount) * 100) / 100;
          day.actualCapital = Math.round((newTrading + day.totalPnl) * 100) / 100;
          day.deviation = Math.round((day.actualCapital - day.originalProjCapital) * 100) / 100;
          await upsertDayRecord(ws, day);
        }
        return updated;
      }

      const liveResult = await syncWorkspace('my-live');
      for (const channel of mirroredChannels) {
        try { await syncWorkspace(channel); } catch {}
      }
      return liveResult;
    }),

  // ─── Day Record Queries ────────────────────────────────────────

  /** Get completed (past) day records. */
  pastDays: publicProcedure
    .input(z.object({
      channel: channelSchema,
      limit: z.number().min(1).max(250).default(50),
    }))
    .query(async ({ input }) => {
      const state = await getCapitalState(input.channel);
      return getDayRecords(input.channel, {
        from: 1,
        to: state.currentDayIndex - 1,
        limit: input.limit,
      });
    }),

  /** Get the current active day with all trades. */
  currentDay: publicProcedure
    .input(z.object({ channel: channelSchema }))
    .query(async ({ input }) => {
      return ensureCurrentDay(input.channel);
    }),

  /** Get projected future days (computed on-the-fly, not stored). */
  futureDays: publicProcedure
    .input(z.object({
      channel: channelSchema,
      count: z.number().min(1).max(50).default(20),
    }))
    .query(async ({ input }) => {
      const state = await getCapitalState(input.channel);
      const day = await ensureCurrentDay(input.channel);
      const startCapital = day.actualCapital > 0 ? day.actualCapital : state.tradingPool;
      const startDay = state.currentDayIndex + 1;
      const targetPercent = await getDailyTargetPercent();

      return projectFutureDays(
        startDay,
        startCapital * TRADING_SPLIT, // only trading pool share compounds
        targetPercent,
        input.count,
        input.channel
      );
    }),

  /** Get all days for the table view (past + current + future). */
  allDays: publicProcedure
    .input(z.object({
      channel: channelSchema,
      futureCount: z.number().min(0).max(250).default(250),
    }))
    .query(async ({ input }) => {
      const state = await getCapitalState(input.channel);
      const pastDays = await getDayRecords(input.channel, {
        from: 1,
        to: state.currentDayIndex - 1,
      });
      const currentDay = await ensureCurrentDay(input.channel);

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
            input.channel
          )
        : [];

      return {
        pastDays,
        currentDay,
        futureDays,
        currentDayIndex: state.currentDayIndex,
      };
    }),

  /** Exit all open trades. */
  exitAll: publicProcedure
    .input(z.object({
      channel: channelSchema,
      exitPrices: z.record(z.string(), z.number()), // tradeId → exitPrice
    }))
    .mutation(async ({ input }) => {
      const day = await ensureCurrentDay(input.channel);
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
      await upsertDayRecord(input.channel, updated);

      // Update cumulative state
      const state = await getCapitalState(input.channel);
      const totalPnl = results.reduce((sum, r) => sum + r.pnl, 0);
      const totalCharges = results.reduce((sum, r) => sum + r.charges, 0);
      await updateCapitalState(input.channel, {
        sessionPnl: state.sessionPnl + totalPnl,
        cumulativePnl: state.cumulativePnl + totalPnl,
        cumulativeCharges: state.cumulativeCharges + totalCharges,
      });

      // Check day completion (target hit → generate gift days if excess)
      const completion = checkDayCompletion(updated);
      if (completion.complete) {
        const freshState = await getCapitalState(input.channel);
        const result = completeDayIndex(freshState, updated);

        await updateCapitalState(input.channel, {
          tradingPool: result.tradingPool,
          reservePool: result.reservePool,
          currentDayIndex: freshState.currentDayIndex + 1,
          profitHistory: [...freshState.profitHistory, result.profitEntry],
        });

        updated.status = "COMPLETED";
        updated.rating = result.rating;
        await upsertDayRecord(input.channel, updated);

        if (completion.excessProfit > 0) {
          const gifts = calculateGiftDays(
            completion.excessProfit,
            freshState.currentDayIndex + 1,
            result.tradingPool,
            freshState.targetPercent,
            (idx) => result.tradingPool * Math.pow(1 + freshState.targetPercent / 100, idx - freshState.currentDayIndex),
            input.channel
          );

          for (const giftDay of gifts.giftDays) {
            await upsertDayRecord(input.channel, giftDay);
          }

          if (gifts.giftDays.length > 0) {
            await updateCapitalState(input.channel, {
              currentDayIndex: freshState.currentDayIndex + 1 + gifts.giftDays.length,
              tradingPool: gifts.finalTradingPool,
            });
          }
        }
      }

      return { results, day: updated };
    }),

  /** Reset capital to initial state. Destructive: clears all day records and resets pools. */
  resetCapital: publicProcedure
    .input(z.object({
      channel: channelSchema,
      initialFunding: z.number().positive().default(100000),
      force: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      // Guard: warn if day cycles have started — require force=true to proceed
      if (!input.force) {
        const state = await getCapitalState(input.channel);
        const day = await getDayRecord(input.channel, state.currentDayIndex);
        const hasCompletedTrades = day?.trades?.some(
          (t) => t.status !== 'OPEN' && t.status !== 'PENDING' && t.status !== 'CANCELLED'
        ) ?? false;
        const hasPastDays = state.currentDayIndex > 1;

        if (hasPastDays || hasCompletedTrades) {
          throw new Error(
            'Capital reset requires confirmation. ' +
            'Current state: Day ' + state.currentDayIndex +
            (hasCompletedTrades ? ' with completed trades.' : '.') +
            ' Pass force=true to confirm reset.'
          );
        }
      }

      const targetPercent = await getDailyTargetPercent();
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10);

      // Helper to reset a single workspace
      async function resetWorkspace(ws: typeof input.channel) {
        // 1. Delete all day records
        const deleted = await deleteAllDayRecords(ws);

        // 2. Replace capital state with fresh initialization
        const freshState = {
          tradingPool: Math.round(input.initialFunding * TRADING_SPLIT * 100) / 100,
          reservePool: Math.round(input.initialFunding * (1 - TRADING_SPLIT) * 100) / 100,
          initialFunding: input.initialFunding,
          currentDayIndex: 1,
          targetPercent,
          profitHistory: [] as any[],
          cumulativePnl: 0,
          cumulativeCharges: 0,
          sessionTradeCount: 0,
          sessionPnl: 0,
          sessionDate: today,
          createdAt: now,
          updatedAt: now,
        };

        const newState = await replaceCapitalState(ws, freshState);
        return { newState, deletedDayRecords: deleted };
      }

      // Reset live workspace (primary)
      const liveResult = await resetWorkspace('my-live');

      // Reset paper workspaces (best-effort)
      for (const channel of mirroredChannels) {
        try {
          await resetWorkspace(channel);
        } catch (err) {
          console.warn(`[portfolio.resetCapital] ${channel} channel reset failed (non-fatal):`, err);
        }
      }

      return {
        success: true,
        initialFunding: input.initialFunding,
        tradingPool: liveResult.newState.tradingPool,
        reservePool: liveResult.newState.reservePool,
        deletedDayRecords: liveResult.deletedDayRecords,
      };
    }),

  /** Update LTP for open trades (called by polling). */
  updateLtp: publicProcedure
    .input(z.object({
      channel: channelSchema,
      prices: z.record(z.string(), z.number()), // tradeId → ltp
    }))
    .mutation(async ({ input }) => {
      const day = await ensureCurrentDay(input.channel);
      let changed = false;

      for (const trade of day.trades) {
        if (trade.status === "OPEN" && input.prices[trade.id] !== undefined) {
          trade.ltp = input.prices[trade.id];
          changed = true;
        }
      }

      if (changed) {
        const updated = recalculateDayAggregates(day);
        await upsertDayRecord(input.channel, updated);
        return updated;
      }

      return day;
    }),

  /** Clear all trades and reset a paper channel to zero. Only allowed for paper channels. */
  clearWorkspace: publicProcedure
    .input(z.object({
      channel: z.enum(['my-paper', 'ai-paper', 'testing-sandbox']),
      initialFunding: z.number().positive().default(100000),
    }))
    .mutation(async ({ input }) => {
      const targetPercent = await getDailyTargetPercent();
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10);

      const deleted = await deleteAllDayRecords(input.channel);

      const freshState = {
        tradingPool: Math.round(input.initialFunding * TRADING_SPLIT * 100) / 100,
        reservePool: Math.round(input.initialFunding * (1 - TRADING_SPLIT) * 100) / 100,
        initialFunding: input.initialFunding,
        currentDayIndex: 1,
        targetPercent,
        profitHistory: [] as any[],
        cumulativePnl: 0,
        cumulativeCharges: 0,
        sessionTradeCount: 0,
        sessionPnl: 0,
        sessionDate: today,
        createdAt: now,
        updatedAt: now,
      };

      const newState = await replaceCapitalState(input.channel, freshState);
      return { success: true, deletedDayRecords: deleted, newState };
    }),

  // ─── Portfolio Agent Spec §7.1 — Query APIs ────────────────────

  /** Spec §7.1 — full portfolio snapshot (capital + exposure + risk). */
  snapshot: publicProcedure
    .input(z.object({ channel: channelSchema }))
    .query(({ input }) => portfolioAgent.getState(input.channel)),

  /** Spec §7.1 — open positions for a channel. */
  positions: publicProcedure
    .input(z.object({ channel: channelSchema }))
    .query(({ input }) => portfolioAgent.getPositions(input.channel)),

  /** Spec §7.1 — aggregate performance metrics. */
  metrics: publicProcedure
    .input(z.object({ channel: channelSchema }))
    .query(({ input }) => portfolioAgent.getMetrics(input.channel)),

  /** Spec §7.1 — historical day records. */
  history: publicProcedure
    .input(z.object({
      channel: channelSchema,
      from: z.number().int().min(1).optional(),
      to: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }))
    .query(({ input }) => {
      const { channel, ...range } = input;
      return portfolioAgent.getHistory(channel, range);
    }),

  /** Spec §10.1 — on-demand daily P&L pull. */
  dailyPnl: publicProcedure
    .input(z.object({ channel: channelSchema }))
    .query(({ input }) => portfolioAgent.getDailyPnl(input.channel)),

  /** Spec §5.3 — current risk signals. */
  exposure: publicProcedure
    .input(z.object({ channel: channelSchema }))
    .query(({ input }) => portfolioAgent.evaluateExposure(input.channel)),

  /** Spec §5.3 — drawdown indicator. */
  drawdown: publicProcedure
    .input(z.object({ channel: channelSchema }))
    .query(({ input }) => portfolioAgent.evaluateDrawdown(input.channel)),

  /** Spec §5.3 — portfolio health score. */
  health: publicProcedure
    .input(z.object({ channel: channelSchema }))
    .query(({ input }) => portfolioAgent.evaluateHealth(input.channel)),

  // ─── Portfolio Agent Spec §7.1 — Mutation APIs ─────────────────

  /** Spec §5.2 — record trade close with full outcome metadata. */
  recordTradeClosed: publicProcedure
    .input(z.object({
      channel: channelSchema,
      tradeId: z.string(),
      instrument: z.string(),
      side: z.enum(["LONG", "SHORT"]),
      entryPrice: z.number(),
      exitPrice: z.number(),
      quantity: z.number(),
      entryTime: z.number(),
      exitTime: z.number(),
      realizedPnl: z.number(),
      realizedPnlPercent: z.number(),
      exitReason: z.enum(["SL", "TP", "RCA_EXIT", "DISCIPLINE_EXIT", "AI_EXIT", "MANUAL", "EOD", "EXPIRY"]),
      exitTriggeredBy: z.enum(["RCA", "BROKER", "DISCIPLINE", "AI", "USER", "PA"]),
      duration: z.number(),
      pnlCategory: z.enum(["win", "loss", "breakeven"]),
      signalSource: z.string().optional(),
      timestamp: z.number(),
    }))
    .mutation(({ input }) => portfolioAgent.recordTradeClosed(input)),

  /** Spec §7.1 — audit trail for rejected trades. */
  recordTradeRejected: publicProcedure
    .input(z.object({
      channel: channelSchema,
      reason: z.string(),
      instrument: z.string().optional(),
      timestamp: z.number(),
    }))
    .mutation(({ input }) => {
      const { channel, reason, instrument, timestamp } = input;
      return portfolioAgent.recordTradeRejected({
        channel,
        trade: instrument ? { instrument } : {},
        reason,
        timestamp,
      });
    }),
});
