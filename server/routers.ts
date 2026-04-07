import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { z } from "zod";
import {
  getModuleStatuses,
  getInstrumentData,
  getSignals,
  getPositions,
  getTradingMode,
  setTradingMode,
  getActiveInstruments,
  setActiveInstruments,
  setConfiguredInstruments,
} from "./tradingStore";
import {
  getUpcomingHolidays,
  isTodayHoliday,
  getAllHolidays,
} from "./holidays";
import { getMongoHealth, pingMongo } from "./mongo";
import { brokerRouter } from "./broker/brokerRouter";
import { capitalRouter } from "./capital/capitalRouter";
import { disciplineRouter } from "./discipline/disciplineRouter";
import {
  createTrade,
  updateTrade,
  closeTrade,
  getUserTrades,
  getTradeStats,
} from "./db";
import { getUserSettings, updateUserSettings } from "./userSettings";
import {
  getAllInstruments,
  addInstrument,
  removeInstrument,
  type InstrumentConfig,
} from "./instruments";
import { searchByQuery } from "./broker/adapters/dhan/scripMaster";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // Trading data endpoints (read from in-memory store)
  trading: router({
    // Get all module statuses (heartbeats)
    moduleStatuses: publicProcedure.query(() => {
      return getModuleStatuses();
    }),

    // Get all instrument data (option chain + analyzer + AI decision combined)
    instruments: publicProcedure.query(() => {
      return getInstrumentData();
    }),

    // Get recent signals
    signals: publicProcedure
      .input(z.object({ limit: z.number().min(1).max(200).optional() }).optional())
      .query(({ input }) => {
        return getSignals(input?.limit ?? 50);
      }),

    // Get positions
    positions: publicProcedure.query(() => {
      return getPositions();
    }),

    // Get/set trading mode
    tradingMode: publicProcedure.query(() => {
      return { mode: getTradingMode() };
    }),

    setTradingMode: publicProcedure
      .input(z.object({ mode: z.enum(['LIVE', 'PAPER']) }))
      .mutation(({ input }) => {
        setTradingMode(input.mode);
        return { success: true, mode: input.mode };
      }),

    // Get active instruments list
    activeInstruments: publicProcedure.query(() => {
      return { instruments: getActiveInstruments() };
    }),

    // Set active instruments (syncs frontend filter to backend for Python modules)
    setActiveInstruments: publicProcedure
      .input(z.object({ instruments: z.array(z.string()) }))
      .mutation(({ input }) => {
        setActiveInstruments(input.instruments);
        return { success: true, instruments: getActiveInstruments() };
      }),
  }),

  // Instruments management (configure tradable instruments)
  instruments: router({
    // List all configured instruments
    list: publicProcedure.query(async () => {
      return await getAllInstruments();
    }),

    // Search scrip master for adding new instruments
    search: publicProcedure
      .input(
        z.object({
          query: z.string().min(1).max(100),
          exchange: z.enum(["NSE", "MCX", "BSE", "ALL"]).optional(),
        })
      )
      .query(({ input }) => {
        const exchange = input.exchange === "ALL" ? undefined : input.exchange;
        const results = searchByQuery(input.query, exchange, 20);
        // Transform to a simpler format for frontend
        return results.map(r => ({
          securityId: r.securityId,
          tradingSymbol: r.tradingSymbol,
          customSymbol: r.customSymbol,
          underlyingSymbol: r.underlyingSymbol,
          exchange: r.exchange,
          segment: r.segment,
          instrumentName: r.instrumentName,
          expiryDate: r.expiryDate,
          strikePrice: r.strikePrice,
          optionType: r.optionType,
          lotSize: r.lotSize,
        }));
      }),

    // Add a new instrument
    add: publicProcedure
      .input(
        z.object({
          key: z.string().regex(/^[A-Z0-9_]+$/),
          displayName: z.string().min(1).max(100),
          exchange: z.enum(["NSE", "MCX", "BSE"]),
          exchangeSegment: z.string().min(1).max(50),
          underlying: z.string().nullable(),
          autoResolve: z.boolean(),
          symbolName: z.string().nullable(),
        })
      )
      .mutation(async ({ input }) => {
        const config: Omit<InstrumentConfig, "isDefault" | "addedAt"> = {
          key: input.key,
          displayName: input.displayName,
          exchange: input.exchange,
          exchangeSegment: input.exchangeSegment,
          underlying: input.underlying,
          autoResolve: input.autoResolve,
          symbolName: input.symbolName,
        };
        const result = await addInstrument(config);
        // Update in-memory store
        const instruments = await getAllInstruments();
        setConfiguredInstruments(instruments);
        return result;
      }),

    // Remove a non-default instrument
    remove: publicProcedure
      .input(z.object({ key: z.string() }))
      .mutation(async ({ input }) => {
        await removeInstrument(input.key);
        // Update in-memory store
        const instruments = await getAllInstruments();
        setConfiguredInstruments(instruments);
        return { success: true };
      }),
  }),

  // Trade Journal endpoints (requires auth)
  journal: router({
    // Create a new trade entry
    create: publicProcedure
      .input(z.object({
        instrument: z.string(),
        tradeType: z.enum(['CALL_BUY', 'PUT_BUY', 'CALL_SELL', 'PUT_SELL']),
        strike: z.number(),
        entryPrice: z.number(),
        quantity: z.number().min(1).default(1),
        stopLoss: z.number().optional(),
        target: z.number().optional(),
        mode: z.enum(['LIVE', 'PAPER']).default('PAPER'),
        rationale: z.string().optional(),
        tags: z.string().optional(),
        aiDecision: z.string().optional(),
        aiConfidence: z.number().optional(),
        checklistScore: z.number().optional(),
        entryTime: z.number(), // UTC ms
      }))
      .mutation(async ({ ctx, input }) => {
        const id = await createTrade({
          userId: 1 /* single-user */,
          ...input,
          stopLoss: input.stopLoss ?? null,
          target: input.target ?? null,
          rationale: input.rationale ?? null,
          tags: input.tags ?? null,
          aiDecision: input.aiDecision ?? null,
          aiConfidence: input.aiConfidence ?? null,
          checklistScore: input.checklistScore ?? null,
        });
        return { success: true, id };
      }),

    // Close a trade
    close: publicProcedure
      .input(z.object({
        id: z.number(),
        exitPrice: z.number(),
        exitTime: z.number(),
        exitReason: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        await closeTrade(input.id, 1 /* single-user */, input.exitPrice, input.exitTime, input.exitReason);
        return { success: true };
      }),

    // Update a trade (rationale, tags, etc.)
    update: publicProcedure
      .input(z.object({
        id: z.number(),
        rationale: z.string().optional(),
        exitReason: z.string().optional(),
        tags: z.string().optional(),
        stopLoss: z.number().optional(),
        target: z.number().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { id, ...updates } = input;
        await updateTrade(id, 1 /* single-user */, updates);
        return { success: true };
      }),

    // List trades with filters
    list: publicProcedure
      .input(z.object({
        status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']).optional(),
        instrument: z.string().optional(),
        mode: z.enum(['LIVE', 'PAPER']).optional(),
        startTime: z.number().optional(),
        endTime: z.number().optional(),
        limit: z.number().min(1).max(500).optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        return getUserTrades(1 /* single-user */, input ?? undefined);
      }),

    // Get P&L stats
    stats: publicProcedure
      .input(z.object({
        startTime: z.number().optional(),
        endTime: z.number().optional(),
        mode: z.enum(['LIVE', 'PAPER']).optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        return getTradeStats(1 /* single-user */, input?.startTime, input?.endTime, input?.mode);
      }),

    // Compare LIVE vs PAPER performance side-by-side
    compare: publicProcedure
      .input(z.object({
        startTime: z.number().optional(),
        endTime: z.number().optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        const [liveStats, paperStats] = await Promise.all([
          getTradeStats(1 /* single-user */, input?.startTime, input?.endTime, 'LIVE'),
          getTradeStats(1 /* single-user */, input?.startTime, input?.endTime, 'PAPER'),
        ]);
        return { live: liveStats, paper: paperStats };
      }),
  }),

  // User Settings (MongoDB)
  settings: router({
    // Get user settings (all sections)
    get: publicProcedure.query(async ({ ctx }) => {
      return getUserSettings(1 /* single-user */);
    }),

    // @deprecated — Time Windows are now managed via trpc.discipline.getSettings/updateSettings.
    // Kept for backward compatibility; will be removed in a future version.
    updateTimeWindows: publicProcedure
      .input(z.object({
        nse: z.object({
          noTradeFirstMinutes: z.number().min(0).max(120).optional(),
          noTradeLastMinutes: z.number().min(0).max(120).optional(),
          lunchBreakPause: z.boolean().optional(),
          lunchBreakStart: z.string().optional(),
          lunchBreakEnd: z.string().optional(),
        }).optional(),
        mcx: z.object({
          noTradeFirstMinutes: z.number().min(0).max(120).optional(),
          noTradeLastMinutes: z.number().min(0).max(120).optional(),
        }).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const updated = await updateUserSettings(1 /* single-user */, { timeWindows: input as any });
        return { success: true, timeWindows: updated.timeWindows };
      }),

    // @deprecated — Discipline settings are now managed via trpc.discipline.getSettings/updateSettings.
    // Kept for backward compatibility; will be removed in a future version.
    updateDiscipline: publicProcedure
      .input(z.object({
        maxTradesPerDay: z.number().min(1).max(50).optional(),
        maxLossPerDay: z.number().min(0).optional(),
        maxLossPerDayPercent: z.number().min(0).max(100).optional(),
        maxConsecutiveLosses: z.number().min(1).max(20).optional(),
        cooldownAfterLoss: z.number().min(0).max(120).optional(),
        mandatoryChecklist: z.boolean().optional(),
        minChecklistScore: z.number().min(0).max(100).optional(),
        maxPositionSize: z.number().min(1).max(100).optional(),
        trailingStopEnabled: z.boolean().optional(),
        trailingStopPercent: z.number().min(0).max(50).optional(),
        noRevengeTrading: z.boolean().optional(),
        requireRationale: z.boolean().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const updated = await updateUserSettings(1 /* single-user */, { discipline: input as any });
        return { success: true, discipline: updated.discipline };
      }),

    // Update expiry control settings
    updateExpiryControls: publicProcedure
      .input(z.object({
        rules: z.array(z.object({
          instrument: z.string(),
          blockOnExpiryDay: z.boolean().optional(),
          blockDaysBefore: z.number().min(0).max(10).optional(),
          reducePositionSize: z.boolean().optional(),
          reduceSizePercent: z.number().min(10).max(100).optional(),
          warningBanner: z.boolean().optional(),
          autoExit: z.boolean().optional(),
          autoExitMinutes: z.number().min(5).max(120).optional(),
          noCarryToExpiry: z.boolean().optional(),
        })),
      }))
      .mutation(async ({ ctx, input }) => {
        const updated = await updateUserSettings(1 /* single-user */, { expiryControls: input as any });
        return { success: true, expiryControls: updated.expiryControls };
      }),

    // Update charge rates
    updateCharges: publicProcedure
      .input(z.object({
        rates: z.array(z.object({
          name: z.string(),
          rate: z.number().min(0),
          unit: z.string(),
          description: z.string().optional(),
          enabled: z.boolean().optional(),
        })),
      }))
      .mutation(async ({ ctx, input }) => {
        const updated = await updateUserSettings(1 /* single-user */, { charges: input as any });
        return { success: true, charges: updated.charges };
      }),
  }),

  // Broker Service (tRPC)
  broker: brokerRouter,

  // Capital Management & Trading Desk
  capital: capitalRouter,

  // Discipline Engine
  discipline: disciplineRouter,

  // MongoDB health check
  mongo: router({
    health: publicProcedure.query(async () => {
      const health = getMongoHealth();
      const latencyMs = await pingMongo();
      return { ...health, latencyMs };
    }),
  }),

  // Market holidays endpoints
  holidays: router({
    // Get upcoming holidays for a given exchange
    upcoming: publicProcedure
      .input(
        z.object({
          exchange: z.enum(['NSE', 'MCX', 'ALL']).optional(),
          daysAhead: z.number().min(1).max(365).optional(),
        }).optional()
      )
      .query(({ input }) => {
        return getUpcomingHolidays(
          input?.exchange ?? 'ALL',
          input?.daysAhead ?? 60
        );
      }),

    // Check if today is a holiday
    todayStatus: publicProcedure
      .input(
        z.object({
          exchange: z.enum(['NSE', 'MCX']),
        })
      )
      .query(({ input }) => {
        return isTodayHoliday(input.exchange);
      }),

    // Get all holidays for calendar view
    all: publicProcedure.query(() => {
      return getAllHolidays();
    }),
  }),
});

export type AppRouter = typeof appRouter;
