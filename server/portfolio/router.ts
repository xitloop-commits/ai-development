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
  deleteAllDayRecords,
  replaceCapitalState,
} from "./state";
import { deleteAllPositions } from "./storage";
import type { Channel, DayRecord } from "./state";
import {
  injectCapital,
  createDayRecord,
  calculateAvailableCapital,
  projectFutureDays,
  calculateQuarterlyProjection,
  calculateAllQuarterlyProjections,
  checkSessionReset,
  resetSession,
  recalculateDayAggregates,
  tradingSplit,
} from "./compounding";
import { getActiveBrokerConfig } from "../broker/brokerConfig";
import { portfolioAgent } from "./portfolioAgent";
import { tickHandler } from "./tickHandler";


// ─── Helpers ─────────────────────────────────────────────────────

const channelSchema = z.enum(["paper", "ai-live", "my-live"]);
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

      // T96 — the pools only move when a day COMPLETES, so `tradingPool +
      // reservePool` alone understates the true position for the whole of an
      // in-flight day (observed: 69,011 shown against a real 98,084).
      //
      // REALISED only — closed trades. `day.totalPnl` can't be used: it folds in
      // open trades' unrealised P&L (compounding.ts:578), which would make the
      // headline balance move on every tick and show money that isn't banked.
      // Unrealised is reported separately as `unrealisedPnl`.
      const realisedToday = Math.round(
        day.trades
          .filter((t) => t.status !== "OPEN")
          .reduce((sum, t) => sum + (t.pnl ?? 0), 0) * 100,
      ) / 100;
      const unrealisedToday = Math.round(
        day.trades
          .filter((t) => t.status === "OPEN")
          .reduce((sum, t) => sum + (t.unrealizedPnl ?? 0), 0) * 100,
      ) / 100;
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
        // True cash position: banked pools + what today has actually realised.
        // Once the day completes its profit folds into the pools and the new
        // day's realised resets to 0, so this never double-counts.
        netWorth: Math.round((state.tradingPool + state.reservePool + realisedToday) * 100) / 100,
        /** Pools only — what has been folded in by completed days. */
        bankedNetWorth: Math.round((state.tradingPool + state.reservePool) * 100) / 100,
        realisedToday,
        unrealisedPnl: unrealisedToday,
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

  /** Inject new capital into a channel's Trading Pool.
   *  NOT split: the whole amount goes to Trading. The reserve split applies to
   *  PROFIT only (see compounding.ts:injectCapital). */
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

        // T92: an UNSEEDED live book has no document — the Dhan seed failed and
        // deliberately persisted nothing. Injecting into it is the manual escape
        // hatch: it establishes the book at the injected amount and stamps it
        // seeded, so a broker that never comes back doesn't leave the operator
        // unable to fund their own account. `updateCapitalState` would throw
        // "Capital state not found" here.
        const updated = state.seededAt == null
          ? await replaceCapitalState(ws, {
              ...state,
              tradingPool,
              reservePool,
              initialFunding: input.amount,
              seededAt: Date.now(),
              updatedAt: Date.now(),
            })
          : await updateCapitalState(ws, {
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

      // T92: fund the channel the caller asked for. This used to be pinned to
      // 'my-live' regardless of input, so ai-live could never be funded at all.
      return syncWorkspace(input.channel);
    }),

  /** Transfer funds between Trading ↔ Reserve pools. */
  /**
   * Withdraw funds from a book — the inverse of inject.
   *
   * Funding follows the channel the operator is viewing (T101); the caller must
   * name it, and the client passes the viewed channel.
   *
   * `initialFunding` comes down by the same amount so growth % keeps measuring
   * against what is actually still invested. Without that, taking money out
   * would leave the denominator too high and permanently understate growth.
   * Floored at 0: withdrawing more than was ever injected (i.e. taking profits
   * out) must not drive it negative and invert the percentage.
   */
  withdraw: protectedProcedure
    .input(z.object({
      channel: channelSchema,
      amount: z.number().positive(),
      from: z.enum(['trading', 'reserve']),
    }))
    .mutation(async ({ input }) => {
      const targetPercent = await getDailyTargetPercent();
      const state = await getCapitalState(input.channel);

      // An unseeded live book has no document — there is nothing to take out.
      if (state.seededAt == null) {
        throw new Error(`${input.channel} is not funded yet — nothing to withdraw.`);
      }

      const pool = input.from === 'trading' ? state.tradingPool : state.reservePool;
      if (input.amount > pool) {
        throw new Error(
          `Cannot withdraw ₹${input.amount} from ${input.from} — it holds ₹${pool}.`,
        );
      }

      const r2 = (n: number) => Math.round(n * 100) / 100;
      const tradingPool = input.from === 'trading' ? r2(state.tradingPool - input.amount) : state.tradingPool;
      const reservePool = input.from === 'reserve' ? r2(state.reservePool - input.amount) : state.reservePool;

      const updated = await updateCapitalState(input.channel, {
        tradingPool,
        reservePool,
        initialFunding: Math.max(0, r2(state.initialFunding - input.amount)),
      });

      // Keep the day record in step, exactly as inject does — otherwise the
      // desk would show the day sized against capital that is no longer there.
      const day = await getDayRecord(input.channel, state.currentDayIndex);
      if (day) {
        day.tradeCapital = tradingPool;
        day.targetPercent = targetPercent;
        day.targetAmount = Math.round(tradingPool * targetPercent / 100 * 100) / 100;
        day.projCapital = Math.round((tradingPool + day.targetAmount) * 100) / 100;
        day.actualCapital = Math.round((tradingPool + day.totalPnl) * 100) / 100;
        day.deviation = Math.round((day.actualCapital - day.originalProjCapital) * 100) / 100;
        await upsertDayRecord(input.channel, day);
      }
      return updated;
    }),

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

      // T92: operate on the channel the caller asked for (was pinned to 'my-live').
      return syncWorkspace(input.channel);
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
        startCapital * tradingSplit(), // only trading pool share compounds
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

      // Project future days from REALIZED capital only. currentDay.actualCapital
      // includes open trades' unrealized P&L, which marks-to-market on every
      // tick — projecting from it shifts every future row on each price change.
      // Realized capital (start-of-day capital + closed-trade P&L) only moves
      // when a trade actually closes, which is when the projection should shift.
      const realizedDayPnl = currentDay.trades
        .filter((t) => t.status === "CLOSED")
        .reduce((sum, t) => sum + (t.pnl ?? 0), 0);
      const realizedCapital = currentDay.tradeCapital + realizedDayPnl;
      const startCapital = realizedCapital > 0 ? realizedCapital : state.tradingPool;
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
        // 1. Delete all day records + position_state (keep the two in sync so no
        //    OPEN position is orphaned for RCA to endlessly age-exit).
        const deleted = await deleteAllDayRecords(ws);
        await deleteAllPositions(ws);

        // 2. Replace capital state with fresh initialization
        const freshState = {
          tradingPool: Math.round(input.initialFunding * 100) / 100,
          reservePool: 0,
          initialFunding: input.initialFunding,
          currentDayIndex: 1,
          targetPercent,
          profitHistory: [] as any[],
          cumulativePnl: 0,
          cumulativeCharges: 0,
          sessionTradeCount: 0,
          sessionPnl: 0,
          sessionDate: today,
          // T96: a reset MUST clear the high-water mark. replaceCapitalState
          // uses $set, so any field omitted here SURVIVES — peakCapital was
          // found stale at 1,940,930 after a reset to 100,000, meaning every
          // drawdownPercent (and the capital-protection rules that read it) was
          // measured against a peak the account had never held.
          peakCapital: Math.round(input.initialFunding * 100) / 100,
          drawdownPercent: 0,
          peakUpdatedAt: now,
          createdAt: now,
          updatedAt: now,
        };

        const newState = await replaceCapitalState(ws, freshState);
        return { newState, deletedDayRecords: deleted };
      }

      // T92: reset the channel the caller asked for. This used to reset 'my-live'
      // unconditionally while the guard above checked `input.channel` — so
      // resetting 'paper' validated paper and then destroyed the LIVE book.
      const result = await resetWorkspace(input.channel);

      return {
        success: true,
        channel: input.channel,
        initialFunding: input.initialFunding,
        tradingPool: result.newState.tradingPool,
        reservePool: result.newState.reservePool,
        deletedDayRecords: result.deletedDayRecords,
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
      channel: z.enum(['paper']),
      initialFunding: z.number().positive().default(100000),
    }))
    .mutation(async ({ input }) => {
      const targetPercent = await getDailyTargetPercent();
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10);

      const deleted = await deleteAllDayRecords(input.channel);
      // Also wipe position_state — otherwise a still-OPEN position lingers here
      // (RCA reads it) and fires endless "Trade not found" age exits after clear.
      await deleteAllPositions(input.channel);

      const freshState = {
        tradingPool: Math.round(input.initialFunding * 100) / 100,
        reservePool: 0,
        initialFunding: input.initialFunding,
        currentDayIndex: 1,
        targetPercent,
        profitHistory: [] as any[],
        cumulativePnl: 0,
        cumulativeCharges: 0,
        sessionTradeCount: 0,
        sessionPnl: 0,
        sessionDate: today,
        // T96 — same as resetCapital: $set means an omitted field survives, so
        // the high-water mark has to be cleared explicitly.
        peakCapital: Math.round(input.initialFunding * 100) / 100,
        drawdownPercent: 0,
        peakUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      const newState = await replaceCapitalState(input.channel, freshState);

      // Invalidate the tick handler's in-memory day cache. Without this, a
      // tick arriving within the cache's 2s TTL re-reads the stale day (still
      // holding the just-deleted open trades) and re-persists it via
      // upsertDayRecord — resurrecting every trade the clear just removed.
      tickHandler.clearStateCache();

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
      channels: z.array(channelSchema).min(1).max(7),
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
      exitReason: z.enum(["SL_HIT", "TSL_HIT", "TP_HIT", "MOMENTUM_EXIT", "VOLATILITY_EXIT", "AGE_EXIT", "STALE_PRICE_EXIT", "DISCIPLINE_EXIT", "AI_EXIT", "MANUAL", "EOD", "EOD_SQUAREOFF", "EXPIRY"]),
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
