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
 * Map UI instrument name → { underlying, exchangeSegment } for expiry-list lookup.
 * Live broker needs numeric securityId; paper broker accepts symbolic underlying.
 */
async function resolveUnderlyingForExpiry(
  instrument: string
): Promise<{ underlying: string; exchangeSegment: string } | null> {
  const norm = instrument.toUpperCase().replace(/\s+/g, "");
  const config = await getActiveBrokerConfig();
  const isPaper = config?.isPaperBroker ?? true;

  if (isPaper) {
    const map: Record<string, { underlying: string; segment: string }> = {
      "NIFTY50": { underlying: "NIFTY", segment: "IDX_I" },
      "NIFTY": { underlying: "NIFTY", segment: "IDX_I" },
      "BANKNIFTY": { underlying: "BANKNIFTY", segment: "IDX_I" },
      "CRUDEOIL": { underlying: "CRUDEOIL", segment: "MCX_COMM" },
      "CRUDE": { underlying: "CRUDEOIL", segment: "MCX_COMM" },
      "NATURALGAS": { underlying: "NATURALGAS", segment: "MCX_COMM" },
    };
    const m = map[norm];
    return m ? { underlying: m.underlying, exchangeSegment: m.segment } : null;
  }

  const idxMap: Record<string, { securityId: string; segment: string }> = {
    "NIFTY50": { securityId: "13", segment: "IDX_I" },
    "NIFTY": { securityId: "13", segment: "IDX_I" },
    "BANKNIFTY": { securityId: "25", segment: "IDX_I" },
  };
  if (idxMap[norm]) {
    return { underlying: idxMap[norm].securityId, exchangeSegment: idxMap[norm].segment };
  }

  const broker = getActiveBroker();
  if ((norm === "CRUDEOIL" || norm === "CRUDE" || norm === "NATURALGAS") && broker?.resolveMCXFutcom) {
    const mcxSym = norm === "CRUDE" ? "CRUDEOIL" : norm;
    const result = await broker.resolveMCXFutcom(mcxSym);
    if (result) {
      return { underlying: String(result.securityId), exchangeSegment: "MCX_COMM" };
    }
  }
  return null;
}

/**
 * Resolve the nearest (earliest) expiry for a given instrument.
 * Returns null if broker unavailable or no expiries found.
 */
async function resolveNearestExpiry(instrument: string): Promise<string | null> {
  const broker = getActiveBroker();
  if (!broker) return null;
  const resolved = await resolveUnderlyingForExpiry(instrument);
  if (!resolved) return null;
  try {
    const list = await broker.getExpiryList(resolved.underlying, resolved.exchangeSegment);
    if (!list || list.length === 0) return null;
    const sorted = [...list].sort(
      (a, b) => new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime()
    );
    return sorted[0];
  } catch {
    return null;
  }
}

/**
 * Resolve the option contract securityId AND current LTP for
 * (instrument, expiry, strike, isCall). Returns null if unavailable.
 * Needed so trade LTP polling subscribes to the option leg (not spot), and
 * so signal-initiated trades can refresh entry price against the live chain
 * rather than the stale value carried on the SEA signal.
 */
async function resolveContract(
  instrument: string,
  expiry: string,
  strike: number,
  isCall: boolean
): Promise<{ secId: string; ltp: number; strike: number } | null> {
  const broker = getActiveBroker();
  if (!broker) {
    console.warn(`[resolveContract] No active broker for ${instrument}`);
    return null;
  }
  const resolved = await resolveUnderlyingForExpiry(instrument);
  if (!resolved) {
    console.warn(`[resolveContract] Could not resolve underlying for ${instrument}`);
    return null;
  }
  try {
    const chain = await broker.getOptionChain(
      resolved.underlying,
      expiry,
      resolved.exchangeSegment
    );
    const rows = chain.rows ?? [];
    if (rows.length === 0) {
      console.warn(`[resolveContract] Empty option chain for ${instrument} ${expiry}`);
      return null;
    }
    // Find nearest strike — signal's ATM strike may not exactly match chain steps
    let row = rows.find((r: any) => r.strike === strike);
    if (!row) {
      row = rows.reduce((best: any, r: any) =>
        Math.abs(r.strike - strike) < Math.abs(best.strike - strike) ? r : best
      );
      console.warn(
        `[resolveContract] Strike ${strike} not in chain for ${instrument}; using nearest ${row.strike}`
      );
    }
    const secId = isCall ? row.callSecurityId : row.putSecurityId;
    const ltp = isCall ? row.callLTP : row.putLTP;
    if (!secId || !ltp || ltp <= 0) {
      console.warn(
        `[resolveContract] Missing secId/ltp for ${instrument} ${row.strike} ${isCall ? 'CE' : 'PE'}: secId=${secId}, ltp=${ltp}`
      );
      return null;
    }
    return { secId, ltp, strike: row.strike };
  } catch (err: any) {
    console.warn(`[resolveContract] getOptionChain failed for ${instrument} ${expiry}: ${err?.message}`);
    return null;
  }
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

  // ─── Trade Mutations ───────────────────────────────────────────

  /** Place a new trade. */
  placeTrade: publicProcedure
    .input(z.object({
      channel: channelSchema,
      instrument: z.string(),
      type: z.enum(["CALL_BUY", "CALL_SELL", "PUT_BUY", "PUT_SELL", "BUY", "SELL"]),
      strike: z.number().nullable().default(null),
      entryPrice: z.number().positive(),
      capitalPercent: z.number().min(5).max(100),
      expiry: z.string().optional().default(""),  // expiry date (YYYY-MM-DD), empty = nearest
      contractSecurityId: z.string().optional().nullable(),
      qty: z.number().int().positive().optional(),      // explicit lot count from UI
      lotSize: z.number().int().positive().optional(),  // lot size from scrip master
      targetPercent: z.number().optional(),   // TP % from entry (legacy)
      stopLossPercent: z.number().optional(),  // SL % from entry (legacy)
      targetPrice: z.number().nullable().optional(),   // TP absolute price (new)
      stopLossPrice: z.number().nullable().optional(),  // SL absolute price (new)
      trailingStopEnabled: z.boolean().optional(),  // Enable trailing stop for this trade
    }))
    .mutation(async ({ input }) => {
      const state = await getCapitalState(input.channel);
      const day = await ensureCurrentDay(input.channel);

      // Resolve nearest expiry for option trades when client didn't supply one
      // (e.g. TRADE button on SignalsFeed sends empty expiry)
      const isOptionTrade = /^(CALL|PUT)_/.test(input.type);
      if (isOptionTrade && !input.expiry) {
        const resolvedExpiry = await resolveNearestExpiry(input.instrument);
        if (resolvedExpiry) {
          input.expiry = resolvedExpiry;
        }
      }

      // Resolve lot size server-side when not supplied. Without this the TRADE
      // button from SignalsFeed (which only sends qty=1, no lotSize) would open
      // a 1-unit trade instead of 1 lot — charges then exceed the points and
      // make winning trades show negative P&L.
      if (isOptionTrade && !input.lotSize) {
        const broker = getActiveBroker();
        if (broker?.getLotSize) {
          const norm = input.instrument.toUpperCase().replace(/\s+/g, "");
          const lotSymbol =
            norm === "NIFTY50" || norm === "NIFTY" ? "NIFTY"
            : norm === "BANKNIFTY" ? "BANKNIFTY"
            : norm === "CRUDEOIL" || norm === "CRUDE" ? "CRUDEOIL"
            : norm === "NATURALGAS" ? "NATURALGAS"
            : input.instrument;
          try {
            const ls = await broker.getLotSize(lotSymbol);
            if (ls && ls > 0) input.lotSize = ls;
          } catch {
            /* leave undefined; placeTrade falls back to 1 */
          }
        }
      }

      // Resolve option contract securityId + fresh LTP server-side when the
      // client didn't supply a contractSecurityId (signal-initiated TRADE).
      // This also refreshes entry against the live option chain and shifts
      // TP/SL by the same delta so the SEA-computed risk/reward is preserved
      // against current prices (SEA signals can be minutes stale).
      if (isOptionTrade && !input.contractSecurityId && input.expiry && input.strike != null) {
        const isCall = input.type.startsWith("CALL");
        const resolved = await resolveContract(
          input.instrument,
          input.expiry,
          input.strike,
          isCall
        );
        if (resolved) {
          input.contractSecurityId = resolved.secId;
          input.strike = resolved.strike;
          const staleEntry = input.entryPrice;
          const delta = resolved.ltp - staleEntry;
          input.entryPrice = resolved.ltp;
          if (input.targetPrice != null) input.targetPrice += delta;
          if (input.stopLossPrice != null) input.stopLossPrice += delta;
        } else {
          console.warn(
            `[placeTrade] Could not resolve option contract for ${input.instrument} ` +
            `${input.expiry} ${input.strike} — LTP will fall back to underlying feed.`
          );
        }
      }

      // Ensure the option leg is subscribed on the live WS feed so ticks flow
      if (isOptionTrade && input.contractSecurityId) {
        const broker = getActiveBroker();
        if (broker?.subscribeLTP) {
          const isMcx = input.instrument.toUpperCase().includes("CRUDE")
            || input.instrument.toUpperCase().includes("NATURAL");
          const exchange = isMcx ? "MCX_COMM" : "NSE_FNO";
          try {
            broker.subscribeLTP(
              [{
                exchange,
                securityId: input.contractSecurityId,
                mode: "full",
              }] as any,
              (tick) => tickBus.emitTick(tick)
            );
            console.log(
              `[placeTrade] Subscribed option leg: ${exchange}:${input.contractSecurityId}`
            );
          } catch (err: any) {
            console.warn(`[placeTrade] subscribeLTP failed: ${err?.message}`);
          }
        } else {
          console.warn(`[placeTrade] No broker.subscribeLTP available — LTP will not stream`);
        }
      }

      // Calculate open margin
      const openMargin = day.trades
        .filter((t) => t.status === "OPEN")
        .reduce((sum, t) => sum + t.entryPrice * t.qty, 0);

      const available = calculateAvailableCapital(state.tradingPool, openMargin);
      // If the UI provided an explicit lot count, use it directly; otherwise derive from capitalPercent
      let qty: number;
      let margin: number;
      if (input.qty != null && input.qty > 0) {
        qty = input.qty * (input.lotSize ?? 1);
        margin = qty * input.entryPrice;
      } else {
        ({ qty, margin } = calculatePositionSize(
          available,
          input.capitalPercent,
          input.entryPrice,
          input.lotSize ?? 1
        ));
      }

      if (qty <= 0) {
        throw new Error("Insufficient capital for this trade");
      }

      // Calculate bracket order levels — TP/SL can be provided as absolute prices or percentages
      const isBuy = input.type.includes("BUY");
      const tradeDefaults = await getTradeTargetPercent(input.type);
      
      // Use absolute prices if provided, otherwise calculate from percentages, otherwise use defaults
      let targetPrice: number | null;
      let stopLossPrice: number | null;
      
      // Target Price: user-provided absolute price → user-provided percentage → broker defaults
      if (input.targetPrice !== undefined) {
        // User provided absolute price via new SL/TP editor (can be null to disable)
        targetPrice = input.targetPrice;
      } else if (input.targetPercent !== undefined) {
        // Legacy percentage input
        const tpPercent = input.targetPercent;
        targetPrice = isBuy
          ? Math.round(input.entryPrice * (1 + tpPercent / 100) * 100) / 100
          : Math.round(input.entryPrice * (1 - tpPercent / 100) * 100) / 100;
      } else {
        // Use broker defaults
        const tpPercent = tradeDefaults.tpPercent;
        targetPrice = isBuy
          ? Math.round(input.entryPrice * (1 + tpPercent / 100) * 100) / 100
          : Math.round(input.entryPrice * (1 - tpPercent / 100) * 100) / 100;
      }
      
      // Stop Loss Price: user-provided absolute price → user-provided percentage → broker defaults
      if (input.stopLossPrice !== undefined) {
        // User provided absolute price via new SL/TP editor (can be null to disable)
        stopLossPrice = input.stopLossPrice;
      } else if (input.stopLossPercent !== undefined) {
        // Legacy percentage input
        const slPercent = input.stopLossPercent;
        stopLossPrice = isBuy
          ? Math.round(input.entryPrice * (1 - slPercent / 100) * 100) / 100
          : Math.round(input.entryPrice * (1 + slPercent / 100) * 100) / 100;
      } else {
        // Use broker defaults
        const slPercent = tradeDefaults.slPercent;
        stopLossPrice = isBuy
          ? Math.round(input.entryPrice * (1 - slPercent / 100) * 100) / 100
          : Math.round(input.entryPrice * (1 + slPercent / 100) * 100) / 100;
      }

      const trade: TradeRecord = {
        id: generateTradeId(),
        instrument: input.instrument,
        type: input.type,
        strike: input.strike,
        expiry: input.expiry || null,
        contractSecurityId: input.contractSecurityId ?? null,
        entryPrice: input.entryPrice,
        exitPrice: null,
        ltp: input.entryPrice,
        qty,
        lotSize: input.lotSize,
        capitalPercent: input.capitalPercent,
        pnl: 0,
        unrealizedPnl: 0,
        charges: 0,
        chargesBreakdown: [],
        status: "OPEN",
        targetPrice,
        stopLossPrice,
        trailingStopEnabled: input.trailingStopEnabled,
        brokerId: null,
        openedAt: Date.now(),
        closedAt: null,
      };

      console.log(
        `[placeTrade] ${input.channel} ${input.instrument} ${input.type} ` +
        `strike=${input.strike} expiry=${input.expiry} ` +
        `contractSecurityId=${trade.contractSecurityId} ` +
        `lotSize=${trade.lotSize} qty=${trade.qty} entry=${trade.entryPrice}`
      );

      // ── Broker order placement (live channels only) ──────────
      let brokerOrderId: string | null = null;
      if (input.channel === "my-live" || input.channel === "ai-live" || input.channel === "testing-live") {
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
              stopLoss: stopLossPrice ?? undefined,
              target: targetPrice ?? undefined,
              tag: trade.id,
            };

            console.log(`[Capital] Placing broker order:`, JSON.stringify({
              instrument: orderParams.instrument,
              exchange: orderParams.exchange,
              transactionType: orderParams.transactionType,
              optionType: orderParams.optionType,
              strike: orderParams.strike,
              expiry: orderParams.expiry,
              quantity: orderParams.quantity,
              price: orderParams.price,
              orderType: orderParams.orderType,
              productType: orderParams.productType,
              stopLoss: orderParams.stopLoss,
              target: orderParams.target,
              tag: orderParams.tag,
            }));
            const result = await broker.placeOrder(orderParams);
            brokerOrderId = result.orderId;
            console.log(`[Capital] Broker order placed: orderId=${result.orderId} status=${result.status} raw=`, JSON.stringify(result));
          } catch (err: any) {
            console.error("[Capital] Broker order failed:", err?.message ?? err, err?.response?.data ?? '');
            // Trade is still recorded in capital engine even if broker fails
          }
        }
      }

      trade.brokerId = brokerOrderId;
      day.trades.push(trade);
      const updated = recalculateDayAggregates(day);

      // Update session counter
      await updateCapitalState(input.channel, {
        sessionTradeCount: state.sessionTradeCount + 1,
      });

      await upsertDayRecord(input.channel, updated);

      return { trade, day: updated };
    }),

  /** Update TP/SL on an open trade. */
  updateTrade: publicProcedure
    .input(z.object({
      channel: channelSchema,
      tradeId: z.string(),
      targetPrice: z.number().positive().optional(),
      stopLossPrice: z.number().positive().optional(),
      trailingStopEnabled: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const day = await ensureCurrentDay(input.channel);
      const trade = day.trades.find((t) => t.id === input.tradeId);
      if (!trade) throw new Error(`Trade not found: ${input.tradeId}`);
      if (trade.status !== "OPEN") throw new Error(`Trade already closed: ${input.tradeId}`);

      if (input.targetPrice !== undefined) trade.targetPrice = input.targetPrice;
      if (input.stopLossPrice !== undefined) trade.stopLossPrice = input.stopLossPrice;
      if (input.trailingStopEnabled !== undefined) trade.trailingStopEnabled = input.trailingStopEnabled;

      await upsertDayRecord(input.channel, day);
      return { trade };
    }),

  /** Exit a single trade. */
  exitTrade: publicProcedure
    .input(z.object({
      channel: channelSchema,
      tradeId: z.string(),
      exitPrice: z.number().positive(),
      reason: z.enum(["MANUAL", "TP", "SL", "PARTIAL", "EOD"]).default("MANUAL"),
    }))
    .mutation(async ({ input }) => {
      const state = await getCapitalState(input.channel);
      const day = await ensureCurrentDay(input.channel);

      const trade = day.trades.find((t) => t.id === input.tradeId);
      if (!trade) throw new Error(`Trade not found: ${input.tradeId}`);
      if (trade.status !== "OPEN") throw new Error(`Trade already closed: ${input.tradeId}`);

      // ── Close broker position (live channels only) ──────────
      if ((input.channel === "my-live" || input.channel === "ai-live" || input.channel === "testing-live") && trade.brokerId) {
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

      // Recalculate day aggregates
      const updated = recalculateDayAggregates(day);
      await upsertDayRecord(input.channel, updated);

      // Update session P&L
      await updateCapitalState(input.channel, {
        sessionPnl: state.sessionPnl + trade.pnl,
        cumulativePnl: state.cumulativePnl + trade.pnl,
        cumulativeCharges: state.cumulativeCharges + charges.total,
      });

      // Check day completion
      const completion = checkDayCompletion(updated);
      if (completion.complete) {
        const result = completeDayIndex(state, updated);

        // Update capital state
        const newState = await updateCapitalState(input.channel, {
          tradingPool: result.tradingPool,
          reservePool: result.reservePool,
          currentDayIndex: state.currentDayIndex + 1,
          profitHistory: [...state.profitHistory, result.profitEntry],
        });

        // Mark day as completed
        updated.status = "COMPLETED";
        updated.rating = result.rating;
        await upsertDayRecord(input.channel, updated);

        // Handle gift days if excess profit
        if (completion.excessProfit > 0) {
          const gifts = calculateGiftDays(
            completion.excessProfit,
            state.currentDayIndex + 1,
            result.tradingPool,
            state.targetPercent,
            (idx) => result.tradingPool * Math.pow(1 + state.targetPercent / 100, idx - state.currentDayIndex),
            input.channel
          );

          for (const giftDay of gifts.giftDays) {
            await upsertDayRecord(input.channel, giftDay);
          }

          if (gifts.giftDays.length > 0) {
            await updateCapitalState(input.channel, {
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

        await updateCapitalState(input.channel, {
          tradingPool: clawback.newTradingPool,
          currentDayIndex: clawback.newDayIndex,
          profitHistory: clawback.updatedHistory,
        });

        // Delete consumed day records
        if (clawback.consumedDayIndices.length > 0) {
          for (const idx of clawback.consumedDayIndices) {
            await deleteDayRecordsFrom(input.channel, idx);
          }
        }

        return { trade, day: updated, dayCompleted: false, clawback: true };
      }

      return { trade, day: updated, dayCompleted: false };
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
