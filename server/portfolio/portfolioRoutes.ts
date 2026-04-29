/**
 * Portfolio Agent REST routes (PA spec §10.1).
 *
 * Plain Express routes for read-side consumers (Python modules, monitoring
 * dashboards, the Discipline pull-fallback) that don't speak tRPC. The
 * canonical writer + read API is the tRPC `portfolio.*` namespace; this
 * file is a thin REST projection of a few PA queries.
 *
 * All endpoints are under /api/portfolio/*
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { validateQuery } from "../_core/zodMiddleware";
import { portfolioAgent } from "./portfolioAgent";
import type { Channel } from "./state";

const channelSchema = z.enum([
  "ai-live",
  "ai-paper",
  "my-live",
  "my-paper",
  "testing-live",
  "testing-sandbox",
]);

const dailyPnlQuerySchema = z
  .object({
    channel: channelSchema,
  })
  .strict();

export function registerPortfolioRoutes(app: Express): void {
  /**
   * GET /api/portfolio/daily-pnl?channel=<Channel>
   *
   * Spec §10.1 — daily P&L pull endpoint. Returns the same payload as the
   * tRPC `portfolio.dailyPnl` query for callers that prefer REST.
   */
  app.get(
    "/api/portfolio/daily-pnl",
    validateQuery(dailyPnlQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { channel } = req.query as unknown as z.infer<typeof dailyPnlQuerySchema>;
        const report = await portfolioAgent.getDailyPnl(channel as Channel);
        res.json(report);
      } catch (err: any) {
        console.error("[portfolio REST] daily-pnl failed:", err);
        res.status(500).json({ error: err.message });
      }
    },
  );
}
