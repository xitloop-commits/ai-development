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
} from "./tradingStore";

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
});

export type AppRouter = typeof appRouter;
