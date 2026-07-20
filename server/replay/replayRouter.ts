/**
 * Replay router — drives the tick-replay live-simulation from the UI.
 *
 * dates  → which recorded days can be replayed
 * status → is a replay running (+ date/speed/tick count)
 * start  → begin replaying a date at `speed` (blocked during live market hours,
 *          since replay ticks would collide with the real feed)
 * stop   → abort an in-flight replay
 */
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { listRuns, getRun, deleteRun, summariseRun } from "./replayRuns";
import { getUserSettings } from "../userSettings";
import { TRPCError } from "@trpc/server";
import { getISTNow } from "../discipline/types";
import { listReplayDates, getReplayStatus, startReplay, stopReplay } from "./tickReplay";

/**
 * True while the exchange we REPLAY is open (weekday, within hours).
 *
 * NSE only, 09:15–15:30 IST. Replay streams nifty50 + banknifty and nothing
 * else, so MCX hours are irrelevant — and because MCX runs to 23:30, including
 * it blocked replay for almost the entire evening, which is exactly when you
 * want to run one.
 *
 * Holidays aren't checked; the hours already exclude most of the risk window.
 */
function isMarketHoursNow(): boolean {
  const ist = getISTNow();
  const dow = ist.getUTCDay(); // getISTNow() carries IST in its UTC fields
  if (dow === 0 || dow === 6) return false; // weekend
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

export const replayRouter = router({
  dates: publicProcedure.query(() => listReplayDates()),

  status: publicProcedure.query(() => getReplayStatus()),

  start: protectedProcedure
    .input(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
        speed: z.number().positive().max(120).default(1),
        /** Model version per instrument to run the experiment against, e.g.
         *  `{ nifty50: "20260718_161937" }`. Omitted instruments keep whatever
         *  SEA is already on. */
        models: z.record(z.string(), z.string()).optional(),
        /** Notional capital the run sizes against — never a real pool. */
        openingCapital: z.number().positive().optional(),
        note: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (isMarketHoursNow()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Replay is only available outside live market hours (it would collide with the real feed).",
        });
      }
      // A replay must never place REAL orders. AI signals route by aiTradesMode
      // (discipline/routes.ts), so with the AI menu on LIVE a replayed signal
      // would hit the live account. Trades are redirected to the run before
      // that point, but refusing outright is the honest guard: it also stops a
      // run being recorded while the operator believes they are live-trading.
      const aiMode = (await getUserSettings(1)).tradingMode?.aiTradesMode ?? "paper";
      if (aiMode === "live") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Switch AI trades to PAPER before replaying — replay must not run against the live account.",
        });
      }
      try {
        const { runId } = await startReplay(input.date, input.speed, {
          models: input.models,
          openingCapital: input.openingCapital,
          note: input.note ?? null,
        });
        return { ...getReplayStatus(), runId };
      } catch (e: unknown) {
        throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error)?.message ?? "Replay failed to start" });
      }
    }),

  // ── Runs (T97) ────────────────────────────────────────────────────
  /** Run list for the Replay tab — no trade arrays, so it stays light. */
  runs: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(200).default(50) }).optional())
    .query(({ input }) => listRuns(input?.limit ?? 50)),

  /** One run WITH its trades — the desk renders these. */
  run: publicProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(({ input }) => getRun(input.runId)),

  deleteRun: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await deleteRun(input.runId);
      return { success: true };
    }),

  /**
   * Compare two runs. Returns each run's headline numbers plus per-cohort and
   * per-strategy splits, so "which model did better" can be answered on more
   * than a single P&L figure — a model can win on net while losing on hit rate,
   * and that matters when the sample is one day.
   */
  compare: publicProcedure
    .input(z.object({ runA: z.string().min(1), runB: z.string().min(1) }))
    .query(async ({ input }) => {
      const [a, b] = await Promise.all([getRun(input.runA), getRun(input.runB)]);
      if (!a || !b) throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      return { a: summariseRun(a), b: summariseRun(b), sameDate: a.date === b.date };
    }),

  stop: protectedProcedure.mutation(() => {
    stopReplay();
    return getReplayStatus();
  }),
});
