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
import { getCohortState, setCohort, setRevPct, syncCohortsFromAiConfig, setModelVersion, getSma5LineConfig } from "./seaControl";
import { listModelVersions } from "./modelVersions";
import { getExitCfg, setCoolingSec } from "./portfolio/exitConfig";
import { getAllAiConfig, updateAiConfig, updateExitConfig, updateCommonConfig } from "./portfolio/aiModeConfig";
import { tickBus } from "./broker/tickBus";
import { getTradesForDateWithCycleNo } from "./portfolio/state";
import { portfolioAgent } from "./portfolio";
import { getInstrumentLiveState } from "./instrumentLiveState";
import { readUnderlyingTicks, listRecordedDates, readOptionContractTicks } from "./chartData";
import { analyzeInstrument } from "./signal-advisor";
import { brokerRouter } from "./broker/brokerRouter";
import { portfolioRouter } from "./portfolio/router";
import { executorRouter } from "./executor";
import { disciplineRouter } from "./discipline/disciplineRouter";
import { alertsRouter } from "./alerts/alertRouter";
import { replayRouter } from "./replay/replayRouter";
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

    // T161 — session strike lock: today's locks + config + instrument switches.
    // T165 — while a live-simulation replays, the REPLAYED day's locks (from
    // the recorded chain at open) replace the live ones for the instruments
    // being simulated, so chart panes follow the sim's contracts.
    strikeLockState: publicProcedure.query(async () => {
      const { lockSnapshot } = await import("./portfolio/strikeLock");
      const { getCommonConfig } = await import("./portfolio/aiModeConfig");
      const { getReplayStatus } = await import("./replay/tickReplay");
      const { getReplayLock } = await import("./replay/replayLock");
      const common = getCommonConfig();
      const locks = lockSnapshot();
      const rp = getReplayStatus();
      if (rp.running && rp.date) {
        for (const inst of rp.instruments) {
          const rl = await getReplayLock(inst, rp.date);
          if (rl) locks[inst] = rl;
        }
      }
      return {
        locks,
        config: common.strikeLock,
        instrumentEnabled: common.instrumentEnabled,
        replay: rp.running ? { date: rp.date, instruments: rp.instruments } : null,
      };
    }),

    // T161 — ensure today's lock exists for an instrument (computes on first
    // call), or force a fresh one from the CURRENT ATM (`force` = drift OK /
    // watchlist re-lock).
    strikeRelock: publicProcedure
      .input(z.object({ instrument: z.string(), force: z.boolean().optional() }))
      .mutation(async ({ input }) => {
        const { getLock, relock } = await import("./portfolio/strikeLock");
        const lock = input.force ? await relock(input.instrument) : await getLock(input.instrument);
        return { lock };
      }),

    // T162 test chart — strike ladder for an instrument's nearest expiry.
    chainStrikes: publicProcedure
      .input(z.object({ instrument: z.string() }))
      .query(async ({ input }) => {
        const { resolveNearestExpiry, resolveUnderlyingForExpiry } = await import("./executor/tradeResolution");
        const { getActiveBroker } = await import("./broker/brokerService");
        const broker = getActiveBroker();
        const inst = logFolderFor(input.instrument);
        const resolved = broker ? await resolveUnderlyingForExpiry(inst) : null;
        const expiry = resolved ? await resolveNearestExpiry(inst) : null;
        if (!broker || !resolved || !expiry) return { expiry: null, strikes: [] as number[] };
        try {
          const chain = await broker.getOptionChain(resolved.underlying, expiry, resolved.exchangeSegment);
          const strikes = ((chain?.rows ?? []) as { strike?: number }[])
            .map((r) => r.strike)
            .filter((s): s is number => s != null)
            .sort((a, b) => a - b);
          return { expiry, strikes };
        } catch {
          return { expiry, strikes: [] as number[] };
        }
      }),

    // T162 test chart — resolve one strike+side to its contract id.
    optionContractId: publicProcedure
      .input(z.object({ instrument: z.string(), strike: z.number(), isCall: z.boolean() }))
      .query(async ({ input }) => {
        const { resolveNearestExpiry, resolveContract } = await import("./executor/tradeResolution");
        const inst = logFolderFor(input.instrument);
        const expiry = await resolveNearestExpiry(inst);
        if (!expiry) return { securityId: null, expiry: null, strike: input.strike };
        const r = await resolveContract(inst, expiry, input.strike, input.isCall);
        return { securityId: r?.secId ?? null, expiry, strike: r?.strike ?? input.strike };
      }),

    // T161 — watchlist tick icon: per-instrument signals/trades master switch.
    setInstrumentEnabled: publicProcedure
      .input(z.object({ instrument: z.string(), enabled: z.boolean() }))
      .mutation(async ({ input }) => {
        const { updateCommonConfig, getCommonConfig } = await import("./portfolio/aiModeConfig");
        const { logFolderFor } = await import("./seaSignals");
        const key = logFolderFor(input.instrument);
        updateCommonConfig({
          instrumentEnabled: { ...getCommonConfig().instrumentEnabled, [key]: input.enabled },
        });
        return { instrumentEnabled: getCommonConfig().instrumentEnabled };
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
    // The SMA5 detector's candle mode (HA vs raw) + period, so the chart draws
    // its SMA5 line to match the signals that actually fire.
    sma5LineConfig: publicProcedure
      .input(z.object({ instrument: z.string() }))
      .query(({ input }) => getSma5LineConfig(input.instrument)),
    setSeaCohort: publicProcedure
      .input(
        z.object({
          cohort: z.enum(["scalp", "trend", "ma"]),
          enabled: z.boolean(),
        }),
      )
      .mutation(({ input }) => setCohort(input.cohort, input.enabled)),
    // MA-Signal reversal size (%). Live-tunable slider in the SEA panel.
    setSeaRevPct: publicProcedure
      .input(z.object({ value: z.number() }))
      .mutation(({ input }) => setRevPct(input.value)),

    // T94 — model switch. `modelVersions` lists what's trained on disk for each
    // instrument (newest first) with its headline metrics, so the pick is made
    // on evidence rather than a timestamp. `setModel` points the RUNNING SEA at
    // one: it pushes over /ws/sea-control (hot-swap, no restart) and writes
    // models/<inst>/LATEST so a restart comes up on the same version.
    modelVersions: publicProcedure.query(() => listModelVersions()),
    setModel: publicProcedure
      .input(z.object({ instrument: z.string().min(1), version: z.string().min(1) }))
      .mutation(({ input }) => setModelVersion(input.instrument, input.version)),

    /**
     * "Go Live" — mirror an OPEN paper trade onto the LIVE book as a REAL order,
     * sized and managed by the LIVE config (not the paper trade's). Routed through
     * the full discipline chain (DA → RCA → TEA) so the live kill-switch, session
     * halts and sizing all apply. origin=RCA forces it onto `live` (no AI-switch /
     * cohort gating) and uses the live·ai config; a STABLE executionId makes a
     * repeat click idempotent so it can't place a second order.
     */
    goLive: protectedProcedure
      .input(z.object({ tradeId: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const open = await portfolioAgent.listOpenTrades("paper").catch(() => []);
        const t = open.find((x) => x.id === input.tradeId);
        if (!t) throw new TRPCError({ code: "BAD_REQUEST", message: "Paper trade not found or already closed" });
        if (t.strike == null || !t.contractSecurityId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Trade has no option contract to place live" });
        }
        const inst = t.instrument.toLowerCase();
        const payload = {
          executionId: `GOLIVE-${t.id}`, // stable → idempotent (no double order)
          channel: "live",
          origin: "RCA", // forces onto live + live·ai config; no AI-switch/cohort gate
          instrument: t.instrument,
          exchange: inst.includes("crude") || inst.includes("natural") || inst.includes("gas") ? "MCX" : "NSE",
          transactionType: t.type.includes("BUY") ? "BUY" : "SELL",
          optionType: t.type.includes("CALL") ? "CE" : t.type.includes("PUT") ? "PE" : "FUT",
          strike: t.strike,
          expiry: t.expiry ?? undefined,
          contractSecurityId: t.contractSecurityId,
          entryPrice: t.ltp && t.ltp > 0 ? t.ltp : t.entryPrice, // seed; repriced live
          cohort: t.cohort ?? undefined,
          stopLoss: null,
          takeProfit: null,
        };
        const port = Number(process.env.PORT) || 3000;
        const secret = process.env.INTERNAL_API_SECRET ?? "";
        let body: any = {};
        try {
          const resp = await fetch(`http://localhost:${port}/api/discipline/validateTrade`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(secret ? { "X-Internal-Token": secret } : {}) },
            body: JSON.stringify(payload),
          });
          body = await resp.json().catch(() => ({}));
          const ok = resp.ok && (body?.success || body?.tradeId || (Array.isArray(body?.results) && body.results.some((r: any) => r.success)));
          if (!ok) throw new TRPCError({ code: "BAD_REQUEST", message: body?.reason ?? body?.blockReasons?.join?.("; ") ?? `Live placement failed (HTTP ${resp.status})` });
        } catch (e: any) {
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e?.message ?? "Live placement failed" });
        }
        return { success: true, tradeId: body?.tradeId ?? null };
      }),

    // T84 exit-strategy race config (Runway/Anchor). Read the effective config;
    // set the cooling window live from the SEA panel (applied on the next tick).
    exitStrategyConfig: publicProcedure.query(() => getExitCfg()),
    setExitCooling: publicProcedure
      .input(z.object({ coolingSec: z.number() }))
      .mutation(({ input }) => setCoolingSec(input.coolingSec)),

    // Per-mode AI config (paper / live independent) — the AI menu's single store.
    // `aiConfig` returns both modes; `updateAiConfig` deep-merges a patch into one
    // mode, clamps + persists, and broadcasts the new config to every open panel
    // (Apply → instant backend + frontend sync). Exit knobs apply in-process on
    // the next tick; strategy / sizing / order apply at the next entry.
    aiConfig: publicProcedure.query(() => getAllAiConfig()),
    updateAiConfig: publicProcedure
      .input(z.object({
        book: z.enum(["paper", "live", "replay"]),
        kind: z.enum(["ai", "manual"]),
        patch: z.any(),
      }))
      .mutation(async ({ input }) => {
        updateAiConfig(input.book, input.kind, input.patch);
        // Cohorts drive the RUNNING SEA: push them over /ws/sea-control (which
        // also persists to config/sea_thresholds/*.json) so the engine applies
        // them in <100 ms. Only the AI stream feeds SEA (manual trades aren't
        // SEA-generated), and only the ACTIVE book pushes — editing the book
        // you're NOT trading must not change what fires. (Step 3 replaces this
        // with a union push so both books' cohorts are always live.)
        // T128 — SEA takes the UNION of both enabled books' AI cohorts, so any
        // cohort edit on the AI stream re-syncs regardless of which book it was.
        if (input.kind === "ai" && (input.patch as { cohorts?: unknown })?.cohorts) {
          await syncCohortsFromAiConfig();
        }
        const all = getAllAiConfig();
        tickBus.emitAiConfig(all);
        return all;
      }),

    // SHARED Sprint / Runway / Anchor exit config — common to every mode.
    updateExitConfig: publicProcedure
      .input(z.object({ book: z.enum(["paper", "live", "replay"]), patch: z.any() }))
      .mutation(({ input }) => {
        updateExitConfig(input.book, input.patch);
        const all = getAllAiConfig();
        tickBus.emitAiConfig(all);
        return all;
      }),

    // T129 — system-wide common block (detector revPct, RCA global exits, EOD
    // square-off, Lubas-exit owner). A cohort-detector change (revPct) must
    // re-sync SEA; the others are read on demand by their consumers.
    updateCommonConfig: publicProcedure
      .input(z.object({ patch: z.any() }))
      .mutation(async ({ input }) => {
        updateCommonConfig(input.patch);
        const p = input.patch as { revPct?: unknown; sma5ExitConfirm?: unknown; sma5Buffer?: unknown; sma5EntryWatch?: unknown; sma5EntryGate?: unknown; sma5CandleSec?: unknown; maCandleSec?: unknown };
        if (p?.revPct !== undefined || p?.sma5ExitConfirm !== undefined || p?.sma5Buffer !== undefined || p?.sma5EntryWatch !== undefined || p?.sma5EntryGate !== undefined || p?.sma5CandleSec !== undefined || p?.maCandleSec !== undefined) {
          await syncCohortsFromAiConfig();
        }
        const all = getAllAiConfig();
        tickBus.emitAiConfig(all);
        return all;
      }),

    // All trades on one option strike (instrument + strike + CE/PE) for one
    // channel + date, shaped for the option-strike chart overlay (entry/exit
    // markers labelled with signalSeq). Reads the channel's day record.
    optionTradesForChart: publicProcedure
      .input(
        z.object({
          channel: z.enum(["paper", "live"]),
          instrument: z.string(),
          strike: z.number(),
          side: z.enum(["CE", "PE"]),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          // Include the instrument's OTHER-contract trades too (other strike / side),
          // tagged onContract:false. The chart marks them by time but skips their
          // SL/TP price lines (their premium is on a different scale).
          allStrikes: z.boolean().optional(),
        }),
      )
      .query(async ({ input }) => {
        const wantFolder = logFolderFor(input.instrument);
        // "#N" = the trade's position within its day CYCLE (matches the desk row +
        // main chart); calendar-date numbering drifted when a cycle spans days.
        const rows = await getTradesForDateWithCycleNo(input.channel as any, input.date);
        return rows
          .filter(({ trade: t }) => {
            if (logFolderFor(t.instrument) !== wantFolder) return false;
            if (input.allStrikes) return true; // every trade on this instrument
            if (t.strike !== input.strike) return false;
            const side = t.type.startsWith("CALL_") ? "CE" : t.type.startsWith("PUT_") ? "PE" : null;
            return side === input.side;
          })
          .map(({ trade: t, cycleNo }) => {
            const side = t.type.startsWith("CALL_") ? "CE" : "PE";
            return {
              id: t.id ?? null,
              signalSeq: t.signalSeq ?? null,
              tradeNo: cycleNo,
              side,
              strike: t.strike ?? null,
              // This chart's own contract → drawn on-price (SL/TP lines); others are
              // time markers only.
              onContract: t.strike === input.strike && side === input.side,
              entryTime: Math.round(t.openedAt / 1000), // ms → epoch seconds
              entryPrice: t.entryPrice,
              exitTime: t.closedAt != null ? Math.round(t.closedAt / 1000) : null,
              exitPrice: t.exitPrice,
              status: t.status,
              exitReason: t.exitReason,
              pnl: t.pnl,
              cohort: t.cohort ?? null,
              exitStrategy: t.exitStrategy ?? null,
              // Current SL/TP (they trail) — drawn as price lines on the chart.
              stopLossPrice: t.stopLossPrice ?? null,
              targetPrice: t.targetPrice ?? null,
            };
          })
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
          channel: z.enum(["paper", "live"]),
          instrument: z.string(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      )
      .query(async ({ input }) => {
        const wantFolder = logFolderFor(input.instrument);
        // "#N" = the trade's position within its day CYCLE (matches the desk row);
        // numbering by calendar date drifted when a cycle spans multiple days.
        const rows = await getTradesForDateWithCycleNo(input.channel as any, input.date);
        return rows
          .filter(({ trade: t }) => logFolderFor(t.instrument) === wantFolder)
          .map(({ trade: t, cycleNo }) => ({
            id: t.id, // trade id — lets the chart move this trade's Target line
            signalSeq: t.signalSeq ?? null,
            tradeNo: cycleNo,
            side: (t.type.startsWith("CALL_") ? "CE" : t.type.startsWith("PUT_") ? "PE" : "CE") as "CE" | "PE",
            strike: t.strike ?? null,
            entryTime: Math.round(t.openedAt / 1000), // ms → epoch seconds
            entryPrice: t.entryPrice,
            // Stop / target — drawn as reference lines on the contract chart. The
            // stop is a TRAILING stop, so this is its LAST (frozen-at-close) level,
            // not a static line for the whole trade.
            stopLossPrice: t.stopLossPrice ?? null,
            targetPrice: t.targetPrice ?? null,
            exitTime: t.closedAt != null ? Math.round(t.closedAt / 1000) : null,
            exitPrice: t.exitPrice,
            status: t.status,
            exitReason: t.exitReason,
            pnl: t.pnl,
            cohort: t.cohort ?? null,
            contractSecurityId: t.contractSecurityId ?? null,
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

    // Batched OHLC quote (LTP + prev-day close) for every watchlist stock, keyed
    // by securityId. Seeds/falls back the watchlist rows so EVERY stock shows a
    // price immediately — the live WS tick only fires once a stock trades, so
    // illiquid names (or ones whose initial packet was missed) would otherwise
    // stay blank. Missing/failed ids are simply absent.
    quotes: publicProcedure.query(async () => {
      const out: Record<string, { ltp: number; prevClose: number }> = {};
      const stocks = await listStocks();
      if (stocks.length === 0) return out;
      const broker = getActiveBroker();
      if (!broker?.getOhlcQuote) return out; // no live broker → empty (rows show —)
      const ids = stocks.map((s) => Number(s.securityId)).filter((n) => Number.isFinite(n));
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
        out[s.securityId] = { ltp: q.lastPrice ?? 0, prevClose: q.close ?? 0 };
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
        // Independent per-book AI routing. Both true = one signal lands on both.
        aiPaperEnabled: z.boolean().optional(),
        aiLiveEnabled: z.boolean().optional(),
        aiTradesEnabled: z.boolean().optional(),
        myTradesMode: z.enum(["live", "paper"]).optional(),
        testingMode: z.enum(["live"]).optional(),
        aiKillSwitch: z.boolean().optional(),
        myKillSwitch: z.boolean().optional(),
        testingKillSwitch: z.boolean().optional(),
        stocksKillSwitch: z.boolean().optional(),
        defaultWorkspace: z.enum(["ai", "my"]).optional(),
      }))
      .mutation(async ({ input }) => {
        const updated = await updateUserSettings(1 /* single-user */, { tradingMode: input as any });
        // T128 — an AI-trades switch (paper/live on/off) changes the union of
        // cohorts SEA should detect, so re-sync whenever routing changes.
        if (input.aiTradesMode !== undefined || input.aiPaperEnabled !== undefined
            || input.aiLiveEnabled !== undefined || input.aiTradesEnabled !== undefined) {
          await syncCohortsFromAiConfig();
        }
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

  // Tick replay — recorded-tick live-simulation (drives the exit engine now;
  // SEA-firing Python driver + UI land in later milestones).
  replay: replayRouter,

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
