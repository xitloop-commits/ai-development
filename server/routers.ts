import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createLogger } from "./broker/logger";

const searchLog = createLogger("BSA", "InstrumentsSearch");
import {
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
import { querySeaSignals, getSeaSignalsForChartFromStore } from "./seaSignalStore";
import { getSEASignalsForChart, logFolderFor } from "./seaSignals";
import { getCohortState, setCohort } from "./seaControl";
import { getTradesForDate } from "./portfolio/state";
import { getInstrumentLiveState } from "./instrumentLiveState";
import { readUnderlyingTicks, listRecordedDates, readOptionContractTicks } from "./chartData";
import { analyzeInstrument } from "./signal-advisor";
import { brokerRouter } from "./broker/brokerRouter";
import { portfolioRouter } from "./portfolio/router";
import { executorRouter } from "./executor";
import { disciplineRouter } from "./discipline/disciplineRouter";
import { alertsRouter } from "./alerts/alertRouter";
import { searchStocks, addStock, listStocks, removeStock } from "./stockMaster";
import { getActiveBroker } from "./broker/brokerService";
import { getUserSettings, updateUserSettings } from "./userSettings";
import {
  getAllInstruments,
  addInstrument,
  removeInstrument,
  assignHotkey,
  setInstrumentColor,
  type InstrumentConfig,
} from "./instruments";
import { searchByQuery, downloadScripMaster, needsRefresh } from "./broker/adapters/dhan/scripMaster";
import { setReserveSplitPercent } from "./portfolio/compounding";

export const appRouter = router({
  // Trading data endpoints (read from in-memory store)
  trading: router({
    // Get live state for one instrument (InstrumentCard v2)
    instrumentLiveState: publicProcedure
      .input(z.object({ instrument: z.string() }))
      .query(({ input }) => {
        return getInstrumentLiveState(input.instrument);
      }),

    // Get SEA signals from Mongo (sea_signals), recent-first. Used for the
    // signal tray's initial paint and lazy-load: pass `before` (the oldest
    // `ts` already loaded) to page older. Live updates arrive over /ws/ticks.
    signals: publicProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(200).optional(),
            before: z.number().optional(),
            allDays: z.boolean().optional(),
          })
          .optional(),
      )
      .query(({ input }) => {
        return querySeaSignals({
          limit: input?.limit ?? 50,
          before: input?.before,
          allDays: input?.allDays,
        });
      }),

    // All SEA signals for one instrument on one date (YYYY-MM-DD IST), for the
    // chart overlay. Prefers the durable store so each marker's id === the tray
    // card's signalSeq; falls back to the raw log file for older dates that
    // predate the store (those carry a synthetic sequence id). Works without
    // the live feed either way.
    signalsForChart: publicProcedure
      .input(
        z.object({
          instrument: z.string(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      )
      .query(async ({ input }) => {
        const fromStore = await getSeaSignalsForChartFromStore(
          input.instrument,
          input.date,
        );
        if (fromStore.length > 0) return fromStore;
        return getSEASignalsForChart(input.instrument, input.date);
      }),

    // SEA cohort control — global on/off for the toggleable signal cohorts
    // (scalp / trend / ma). Read the current state; flip a cohort (persists to
    // config + pushes live to SEA over /ws/sea-control).
    seaCohortState: publicProcedure.query(() => getCohortState()),
    setSeaCohort: publicProcedure
      .input(
        z.object({
          cohort: z.enum(["scalp", "trend", "ma"]),
          enabled: z.boolean(),
        }),
      )
      .mutation(({ input }) => setCohort(input.cohort, input.enabled)),

    // All trades on one option strike (instrument + strike + CE/PE) for one
    // channel + date, shaped for the option-strike chart overlay (entry/exit
    // markers labelled with signalSeq). Reads the channel's day record.
    optionTradesForChart: publicProcedure
      .input(
        z.object({
          channel: z.enum(["ai-live", "ai-paper", "my-live", "my-paper", "testing-live", "stocks-live", "stocks-paper"]),
          instrument: z.string(),
          strike: z.number(),
          side: z.enum(["CE", "PE"]),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      )
      .query(async ({ input }) => {
        const wantFolder = logFolderFor(input.instrument);
        const trades = await getTradesForDate(input.channel as any, input.date);
        return trades
          .filter((t) => {
            if (logFolderFor(t.instrument) !== wantFolder) return false;
            if (t.strike !== input.strike) return false;
            const side = t.type.startsWith("CALL_") ? "CE" : t.type.startsWith("PUT_") ? "PE" : null;
            return side === input.side;
          })
          .map((t) => ({
            signalSeq: t.signalSeq ?? null,
            side: input.side,
            entryTime: Math.round(t.openedAt / 1000), // ms → epoch seconds
            entryPrice: t.entryPrice,
            exitTime: t.closedAt != null ? Math.round(t.closedAt / 1000) : null,
            exitPrice: t.exitPrice,
            status: t.status,
            exitReason: t.exitReason,
            pnl: t.pnl,
            // Current SL/TP (they trail) — drawn as price lines on the chart.
            stopLossPrice: t.stopLossPrice ?? null,
            targetPrice: t.targetPrice ?? null,
          }))
          .sort((a, b) => a.entryTime - b.entryTime);
      }),

    // Recorded underlying ticks for one instrument + date, from our own disk
    // recording (data/raw/<date>/<inst>_underlying_ticks.ndjson.gz). Parallel
    // {t, ltp} arrays in epoch SECONDS (UTC); the client buckets them into
    // candles at any interval. Pure disk read — no Dhan, no live feed. For
    // "today" the client re-polls to pick up freshly-flushed ticks (near-live).
    underlyingTicks: publicProcedure
      .input(
        z.object({
          instrument: z.string(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      )
      .query(({ input }) => readUnderlyingTicks(input.instrument, input.date)),

    // One option contract's recorded ticks for a date (filtered from the big
    // all-strikes option file). SLOW (~15–30s on a 0.2–1 GB gz) — used ONCE to
    // back-fill the live CE/PE panels on chart open, never polled.
    optionTicksForContract: publicProcedure
      .input(
        z.object({
          instrument: z.string(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          securityId: z.string().min(1),
        }),
      )
      .query(({ input }) => readOptionContractTicks(input.instrument, input.date, input.securityId)),

    // Dates (YYYY-MM-DD, ascending) this instrument has a recorded underlying
    // tick file for — drives the chart window's date picker.
    recordedChartDates: publicProcedure
      .input(z.object({ instrument: z.string() }))
      .query(({ input }) => listRecordedDates(input.instrument)),

    // All trades for one instrument on one channel + date (ANY strike/side),
    // shaped for the underlying-chart overlay (entry/exit markers labelled with
    // signalSeq). Like optionTradesForChart but not strike-scoped.
    tradesForChart: publicProcedure
      .input(
        z.object({
          channel: z.enum(["ai-live", "ai-paper", "my-live", "my-paper", "testing-live", "stocks-live", "stocks-paper"]),
          instrument: z.string(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      )
      .query(async ({ input }) => {
        const wantFolder = logFolderFor(input.instrument);
        const trades = await getTradesForDate(input.channel as any, input.date);
        return trades
          .filter((t) => logFolderFor(t.instrument) === wantFolder)
          .map((t) => ({
            signalSeq: t.signalSeq ?? null,
            side: (t.type.startsWith("CALL_") ? "CE" : t.type.startsWith("PUT_") ? "PE" : "CE") as "CE" | "PE",
            strike: t.strike ?? null,
            entryTime: Math.round(t.openedAt / 1000), // ms → epoch seconds
            entryPrice: t.entryPrice,
            exitTime: t.closedAt != null ? Math.round(t.closedAt / 1000) : null,
            exitPrice: t.exitPrice,
            status: t.status,
            exitReason: t.exitReason,
            pnl: t.pnl,
          }))
          .sort((a, b) => a.entryTime - b.entryTime);
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
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex colour like #3B82F6").optional(),
        })
      )
      .mutation(async ({ input }) => {
        const config: Omit<InstrumentConfig, "isDefault" | "addedAt" | "color"> & { color?: string } = {
          key: input.key,
          displayName: input.displayName,
          exchange: input.exchange,
          exchangeSegment: input.exchangeSegment,
          underlying: input.underlying,
          autoResolve: input.autoResolve,
          symbolName: input.symbolName,
          hotkey: null,
          color: input.color,
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

    // Assign / clear an instrument's hotkey. Single character (digit
    // 1-9 or letter), or null to remove. Server-side `assignHotkey`
    // handles the swap-with-existing-instrument case if the same key
    // is already bound.
    setHotkey: protectedProcedure
      .input(
        z.object({
          key: z.string().min(1),
          hotkey: z.string().regex(/^[a-z0-9]$/i, "single alphanumeric character").nullable(),
        })
      )
      .mutation(async ({ input }) => {
        await assignHotkey(input.key, input.hotkey);
        // Update in-memory store so the live hotkey map sees the change.
        const instruments = await getAllInstruments();
        setConfiguredInstruments(instruments);
        return { success: true };
      }),

    // Set an instrument's base colour (hex). Drives every instrument-specific
    // UI shade (pill, cards, signals) via the shared client colour helper.
    setColor: protectedProcedure
      .input(
        z.object({
          key: z.string().min(1),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex colour like #3B82F6"),
        })
      )
      .mutation(async ({ input }) => {
        await setInstrumentColor(input.key, input.color);
        const instruments = await getAllInstruments();
        setConfiguredInstruments(instruments);
        return { success: true };
      }),
  }),

  // Stock master — NSE cash equities for the Stocks workspace watchlist.
  stocks: router({
    // The watchlist: all added stocks, oldest first.
    list: publicProcedure.query(() => listStocks()),

    // Live quotes for every watchlist stock: LTP + today's change, from one
    // batched Dhan OHLC call (ohlc.close is the previous-day close). Keyed by
    // securityId. Poll this from the UI. Missing/failed ids are simply absent.
    quotes: publicProcedure.query(async () => {
      const out: Record<
        string,
        { ltp: number; prevClose: number; change: number; changePct: number }
      > = {};
      const stocks = await listStocks();
      if (stocks.length === 0) return out;

      const broker = getActiveBroker();
      if (!broker?.getOhlcQuote) return out; // no live broker → empty (UI shows —)

      const ids = stocks
        .map((s) => Number(s.securityId))
        .filter((n) => Number.isFinite(n));
      if (ids.length === 0) return out;

      let raw: Awaited<ReturnType<NonNullable<typeof broker.getOhlcQuote>>> = {};
      try {
        raw = await broker.getOhlcQuote({ NSE_EQ: ids });
      } catch {
        return out; // transient broker/network error → empty this poll
      }

      const bySeg = raw.NSE_EQ ?? {};
      for (const s of stocks) {
        const q = bySeg[s.securityId];
        if (!q) continue;
        const ltp = q.lastPrice ?? 0;
        const prevClose = q.close ?? 0;
        const live = ltp > 0 && prevClose > 0;
        out[s.securityId] = {
          ltp,
          prevClose,
          change: live ? ltp - prevClose : 0,
          changePct: live ? ((ltp - prevClose) / prevClose) * 100 : 0,
        };
      }
      return out;
    }),

    // Search the Dhan scrip master for NSE cash equities by name/symbol.
    search: publicProcedure
      .input(z.object({ query: z.string().min(1).max(100) }))
      .query(async ({ input }) => {
        // Make sure the scrip master is loaded (first run / >24h stale).
        if (needsRefresh(24)) {
          try {
            await downloadScripMaster();
          } catch {
            /* fall back to whatever's cached (may be empty on first run) */
          }
        }
        return searchStocks(input.query, 25);
      }),

    // Add a searched stock to the watchlist/master (idempotent by securityId).
    add: protectedProcedure
      .input(
        z.object({
          securityId: z.string().min(1),
          symbol: z.string().min(1),
          name: z.string().default(""),
          exchange: z.string().default("NSE"),
          segment: z.string().default("E"),
          series: z.string().default("EQ"),
          lotSize: z.number().default(1),
          tickSize: z.number().default(0.05),
        }),
      )
      .mutation(({ input }) => addStock(input)),

    // Remove a stock from the watchlist/master.
    remove: protectedProcedure
      .input(z.object({ securityId: z.string().min(1) }))
      .mutation(async ({ input }) => {
        await removeStock(input.securityId);
        return { success: true };
      }),
  }),

  // User Settings (MongoDB)
  settings: router({
    // Get user settings (all sections)
    get: publicProcedure.query(async () => {
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
      .mutation(async ({ input }) => {
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
      .mutation(async ({ input }) => {
        const updated = await updateUserSettings(1 /* single-user */, { charges: input as any });
        return { success: true, charges: updated.charges };
      }),

    // Update trading mode — workspace modes and kill switch states
    updateTradingMode: protectedProcedure
      .input(z.object({
        aiTradesMode: z.enum(["live", "paper"]).optional(),
        myTradesMode: z.enum(["live", "paper"]).optional(),
        testingMode: z.enum(["live"]).optional(),
        aiKillSwitch: z.boolean().optional(),
        myKillSwitch: z.boolean().optional(),
        testingKillSwitch: z.boolean().optional(),
        stocksKillSwitch: z.boolean().optional(),
        defaultWorkspace: z.enum(["ai", "my", "testing", "stocks"]).optional(),
      }))
      .mutation(async ({ input }) => {
        const updated = await updateUserSettings(1 /* single-user */, { tradingMode: input as any });
        return { success: true, tradingMode: updated.tradingMode };
      }),

    // Update the global reserve-split % (profit routed to the Reserve Pool).
    // Persists + applies the value to the live compounding engine immediately.
    updateReserveSplit: protectedProcedure
      .input(z.object({ reserveSplitPercent: z.number().min(0).max(90) }))
      .mutation(async ({ input }) => {
        const updated = await updateUserSettings(1 /* single-user */, {
          reserveSplitPercent: input.reserveSplitPercent,
        });
        setReserveSplitPercent(updated.reserveSplitPercent);
        return { success: true, reserveSplitPercent: updated.reserveSplitPercent };
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

  // Alerts (T52 — server-side AlertHistory persistence; client wiring pending)
  alerts: alertsRouter,

  // "CLAUD SAYS" — per-instrument option-chain verdict via Claude. The server
  // owns the rollover notebook (history); the client only names the instrument.
  signalAdvisor: router({
    analyze: publicProcedure
      .input(z.object({ instrument: z.string() }))
      .mutation(async ({ input }) => {
        try {
          return await analyzeInstrument(input.instrument);
        } catch (err: any) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: err?.message ?? "Signal advisor failed.",
          });
        }
      }),
  }),

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
