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
import { TRPCError } from "@trpc/server";
import { getISTNow } from "../discipline/types";
import { listReplayDates, getReplayStatus, startReplay, stopReplay } from "./tickReplay";

/** True while either exchange's market is open (weekday, within hours). Replay is
 *  blocked then so recorded ticks can't collide with a live feed. NSE 09:15–15:30,
 *  MCX 09:00–23:30 IST, Mon–Fri (holidays not checked — hours already exclude
 *  most of the risk window and this is a deliberately conservative gate). */
function isMarketHoursNow(): boolean {
  const ist = getISTNow();
  const dow = ist.getUTCDay(); // getISTNow() carries IST in its UTC fields
  if (dow === 0 || dow === 6) return false; // weekend
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const nse = mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
  const mcx = mins >= 9 * 60 && mins <= 23 * 60 + 30;
  return nse || mcx;
}

export const replayRouter = router({
  dates: publicProcedure.query(() => listReplayDates()),

  status: publicProcedure.query(() => getReplayStatus()),

  start: protectedProcedure
    .input(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
        speed: z.number().positive().max(120).default(1),
      }),
    )
    .mutation(async ({ input }) => {
      if (isMarketHoursNow()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Replay is only available outside live market hours (it would collide with the real feed).",
        });
      }
      try {
        await startReplay(input.date, input.speed);
      } catch (e: unknown) {
        throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error)?.message ?? "Replay failed to start" });
      }
      return getReplayStatus();
    }),

  stop: protectedProcedure.mutation(() => {
    stopReplay();
    return getReplayStatus();
  }),
});
