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
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
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
  syncDailyTarget: protectedProcedure
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
  inject: protectedProcedure
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
  transferFunds: protectedProcedure
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

  /**
   * Phase D1 — cross-channel fund transfer (spec §7.1, AILiveCanary §4
   * step 1 + §8 step 3).
   *
   * Moves money from one channel's trading pool to another channel's
   * trading pool. The two writes (debit source, credit dest) are wrapped
   * in a Mongo session + transaction so a mid-flight failure can never
   * leave the pools diverged. Closes SRV-41.
   *
   * `amount: "all"` drains the source's full tradingPool. Numeric amount
   * must be ≤ source balance.
   *
   * Distinct from `transferFunds` (above) — that one moves between the
   * trading/reserve POOLS within a single channel; this one moves
   * between two CHANNELS' trading pools. Different verb in the user's
   * head, different signature.
   */
  transferFundsCrossChannel: protectedProcedure
    .input(z.object({
      from: channelSchema,
      to: channelSchema,
      amount: z.union([z.number().positive(), z.literal("all")]),
    }))
    .mutation(async ({ input }) => {
      if (input.from === input.to) {
        throw new Error("Cannot transfer to the same channel");
      }
      const mongoose = (await import("mongoose")).default;
      const session = await mongoose.startSession();
      try {
        let result: { from: { tradingPool: number }; to: { tradingPool: number }; transferred: number } | null = null;
        await session.withTransaction(async () => {
          const fromState = await getCapitalState(input.from);
          const toState = await getCapitalState(input.to);
          const transfer =
            input.amount === "all" ? fromState.tradingPool : input.amount;
          if (transfer <= 0) {
            throw new Error(`Source channel ${input.from} has no trading-pool balance to transfer`);
          }
          if (transfer > fromState.tradingPool) {
            throw new Error(
              `Insufficient balance on ${input.from}: have ${fromState.tradingPool}, asked for ${transfer}`,
            );
          }
          const newFromTrading = Math.round((fromState.tradingPool - transfer) * 100) / 100;
          const newToTrading = Math.round((toState.tradingPool + transfer) * 100) / 100;
          const updFrom = await updateCapitalState(input.from, { tradingPool: newFromTrading });
          const updTo = await updateCapitalState(input.to, { tradingPool: newToTrading });
          result = {
            from: { tradingPool: updFrom.tradingPool },
            to: { tradingPool: updTo.tradingPool },
            transferred: transfer,
          };
        });
        if (!result) throw new Error("transferFundsCrossChannel: transaction returned no result");
        return result;
      } finally {
        await session.endSession();
      }
    }),

  /**
   * Phase D1 — audit-only event for SL/TP modify post-fill (spec §7.1).
   * TEA fires this after a successful broker modify; PA appends to the
   * event log so dashboards can see the trail. Does NOT mutate the
   * trade record — the actual fields are already updated by the
   * upstream tradeExecutor.modifyOrder path.
   */
  recordTradeUpdated: protectedProcedure
    .input(z.object({
      channel: channelSchema,
      tradeId: z.string().min(1),
      modifications: z.object({
        stopLoss: z.number().nullable().optional(),
        takeProfit: z.number().nullable().optional(),
        trailingStopEnabled: z.boolean().optional(),
      }).strict(),
      timestamp: z.number().int().nonnegative().default(() => Date.now()),
    }))
    .mutation(async ({ input }) => {
      const { appendEvent } = await import("./storage");
      await appendEvent({
        channel: input.channel,
        eventType: "TRADE_MODIFIED",
        tradeId: input.tradeId,
        payload: {
          modifications: input.modifications,
        },
        timestamp: input.timestamp,
      });
      return { success: true };
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


  /** Reset capital to initial state. Destructive: clears all day records and resets pools. */
  resetCapital: protectedProcedure
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
  updateLtp: protectedProcedure
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
  clearWorkspace: protectedProcedure
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

  /**
   * Head-to-Head comparison data — snapshot + metrics + portfolio_metrics
   * rollup (with pnlByTriggeredBy / countByTriggeredBy breakdowns) for
   * each requested channel. Drives the AI vs My / paper vs live view
   * needed for the AI Live canary 30-day comparison.
   */
  headToHead: publicProcedure
    .input(z.object({
      channels: z.array(channelSchema).min(1).max(6),
    }))
    .query(async ({ input }) => {
      const { getMetrics: getMetricsFromStorage } = await import("./storage");
      const rows = await Promise.all(
        input.channels.map(async (channel) => {
          const [snapshot, classicMetrics, rollup] = await Promise.all([
            portfolioAgent.getState(channel),
            portfolioAgent.getMetrics(channel),
            getMetricsFromStorage(channel),
          ]);
          return { channel, snapshot, metrics: classicMetrics, rollup };
        }),
      );
      return rows;
    }),

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
  recordTradeClosed: protectedProcedure
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
      exitReason: z.enum(["SL_HIT", "TP_HIT", "MOMENTUM_EXIT", "VOLATILITY_EXIT", "AGE_EXIT", "STALE_PRICE_EXIT", "DISCIPLINE_EXIT", "AI_EXIT", "MANUAL", "EOD", "EXPIRY"]),
      exitTriggeredBy: z.enum(["RCA", "BROKER", "DISCIPLINE", "AI", "USER", "PA"]),
      duration: z.number(),
      pnlCategory: z.enum(["win", "loss", "breakeven"]),
      signalSource: z.string().optional(),
      timestamp: z.number(),
    }))
    .mutation(({ input }) => portfolioAgent.recordTradeClosed(input)),

  /** Spec §7.1 — audit trail for rejected trades. */
  recordTradeRejected: protectedProcedure
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
