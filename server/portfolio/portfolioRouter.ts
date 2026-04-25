/**
 * portfolioRouter — tRPC `portfolio.*` namespace.
 *
 * Implements the API surface from PortfolioAgent_Spec_v1.1 §7.1.
 * Delegates to the portfolioAgent singleton.
 *
 * Phase 1 design note: this router is added alongside the existing legacy
 * `capital.*` router so both work during migration. Commit 4 of this PR
 * does the client-side cutover (capital.* → portfolio.*) and removes
 * capital.* from the appRouter.
 */

import { z } from "zod";
import { router, publicProcedure } from "../_core/trpc";
import { portfolioAgent } from "./portfolioAgent";

const channelSchema = z.enum([
  "ai-live",
  "ai-paper",
  "my-live",
  "my-paper",
  "testing-live",
  "testing-sandbox",
]);

const channelInput = z.object({ channel: channelSchema });

export const portfolioRouter = router({
  /** §5.1 — current portfolio snapshot for a channel. */
  getState: publicProcedure
    .input(channelInput)
    .query(({ input }) => portfolioAgent.getState(input.channel)),

  /** §7.1 — open positions on this channel. */
  getPositions: publicProcedure
    .input(channelInput)
    .query(({ input }) => portfolioAgent.getPositions(input.channel)),

  /** §5.4 — aggregate performance metrics (win rate, avg R, etc.). */
  getMetrics: publicProcedure
    .input(channelInput)
    .query(({ input }) => portfolioAgent.getMetrics(input.channel)),

  /** §7.1 — historical day records over a range. */
  getHistory: publicProcedure
    .input(
      z.object({
        channel: channelSchema,
        from: z.number().min(1).optional(),
        to: z.number().min(1).optional(),
        limit: z.number().min(1).max(500).optional(),
      }),
    )
    .query(({ input }) =>
      portfolioAgent.getHistory(input.channel, {
        from: input.from,
        to: input.to,
        limit: input.limit,
      }),
    ),

  /**
   * §10.1 — daily P&L pull endpoint shape. Available for on-demand reads
   * (e.g. carry-forward evaluation at 15:15 IST). The push counterpart
   * runs into Discipline on every trade close.
   */
  getDailyPnl: publicProcedure
    .input(channelInput)
    .query(({ input }) => portfolioAgent.getDailyPnl(input.channel)),

  /** §5.3 — current risk signals. Phase 3 (Discipline cap-check) populates fully. */
  evaluateExposure: publicProcedure
    .input(channelInput)
    .query(({ input }) => portfolioAgent.evaluateExposure(input.channel)),

  evaluateDrawdown: publicProcedure
    .input(channelInput)
    .query(({ input }) => portfolioAgent.evaluateDrawdown(input.channel)),

  evaluateHealth: publicProcedure
    .input(channelInput)
    .query(({ input }) => portfolioAgent.evaluateHealth(input.channel)),
});
