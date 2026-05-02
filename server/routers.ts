import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createLogger } from "./broker/logger";

const searchLog = createLogger("BSA", "InstrumentsSearch");
import {
  getModuleStatuses,
  getInstrumentData,
  getSignals,
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
import { getSEASignals } from "./seaSignals";
import { getInstrumentLiveState } from "./instrumentLiveState";
import { brokerRouter } from "./broker/brokerRouter";
import { portfolioRouter } from "./portfolio/router";
import { executorRouter } from "./executor";
import { disciplineRouter } from "./discipline/disciplineRouter";
import { getUserSettings, updateUserSettings } from "./userSettings";
import {
  getAllInstruments,
  addInstrument,
  removeInstrument,
  type InstrumentConfig,
} from "./instruments";
import { searchByQuery, downloadScripMaster, needsRefresh } from "./broker/adapters/dhan/scripMaster";

export const appRouter = router({
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

    // Get live state for one instrument (InstrumentCard v2)
    instrumentLiveState: publicProcedure
      .input(z.object({ instrument: z.string() }))
      .query(({ input }) => {
        return getInstrumentLiveState(input.instrument);
      }),

    // Get recent SEA signals (reads from logs/signals/<inst>/<date>_signals.log)
    signals: publicProcedure
      .input(z.object({ limit: z.number().min(1).max(200).optional() }).optional())
      .query(({ input }) => {
        return getSEASignals(input?.limit ?? 50);
      }),

    // Get active instruments list
    activeInstruments: publicProcedure.query(() => {
      return { instruments: getActiveInstruments() };
    }),

    // Set active instruments (syncs frontend filter to backend for Python modules)
    setActiveInstruments: protectedProcedure
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
        }).optional()
      )
      .query(async ({ input }) => {
        try {
          searchLog.debug(`Search called: ${JSON.stringify(input ?? {})}`);

          // Return empty results if no input
          if (!input?.query) {
            searchLog.debug("No query provided");
            return [];
          }

          // Ensure scrip master is loaded (download if stale or empty)
          searchLog.debug("Checking if scrip master needs refresh...");
          if (needsRefresh(24)) {
            try {
              searchLog.info("Downloading scrip master...");
              const count = await downloadScripMaster();
              searchLog.info(`Scrip master loaded successfully with ${count} records`);
            } catch (downloadErr: any) {
              searchLog.error(`Scrip master download failed: ${downloadErr?.message ?? downloadErr}`);
              // Continue with whatever data we have (may be empty on first run)
            }
          } else {
            searchLog.debug("Scrip master is fresh, not downloading");
          }

          const exchange = input.exchange === "ALL" ? undefined : input.exchange;
          const results = searchByQuery(input.query, exchange, 20);
          searchLog.debug(`Query '${input.query}' returned ${results.length} results`);

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
        } catch (err: any) {
          searchLog.error("Unexpected error", err);
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Search failed: ${err.message}`,
          });
        }
      }),

    // Add a new instrument
    add: protectedProcedure
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
          hotkey: null,
        };
        const result = await addInstrument(config);
        // Update in-memory store
        const instruments = await getAllInstruments();
        setConfiguredInstruments(instruments);
        return result;
      }),

    // Remove a non-default instrument
    remove: protectedProcedure
      .input(z.object({ key: z.string() }))
      .mutation(async ({ input }) => {
        await removeInstrument(input.key);
        // Update in-memory store
        const instruments = await getAllInstruments();
        setConfiguredInstruments(instruments);
        return { success: true };
      }),
  }),

  // User Settings (MongoDB)
  settings: router({
    // Get user settings (all sections)
    get: publicProcedure.query(async ({ ctx }) => {
      return getUserSettings(1 /* single-user */);
    }),

    // Update expiry control settings
    updateExpiryControls: protectedProcedure
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
    updateCharges: protectedProcedure
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

    // Update trading mode — workspace modes and kill switch states
    updateTradingMode: protectedProcedure
      .input(z.object({
        aiTradesMode: z.enum(["live", "paper"]).optional(),
        myTradesMode: z.enum(["live", "paper"]).optional(),
        testingMode: z.enum(["live", "sandbox"]).optional(),
        aiKillSwitch: z.boolean().optional(),
        myKillSwitch: z.boolean().optional(),
        testingKillSwitch: z.boolean().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const updated = await updateUserSettings(1 /* single-user */, { tradingMode: input as any });
        return { success: true, tradingMode: updated.tradingMode };
      }),
  }),

  // Broker Service (tRPC)
  broker: brokerRouter,

  // Portfolio Agent (PortfolioAgent_Spec_v1.3) — canonical portfolio API.
  // Absorbed legacy `capital.*` namespace in PA Phase 1 commit 4.
  portfolio: portfolioRouter,

  // Trade Executor Agent (TradeExecutorAgent_Spec_v1.3) — single execution
  // gateway. Phase 1 commit 1: skeleton; methods wired in subsequent commits.
  executor: executorRouter,

  // Discipline Agent
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
