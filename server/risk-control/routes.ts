/**
 * Risk Control Agent — REST endpoints (C2).
 *
 * Three inbound APIs that other agents use to drive RCA:
 *
 *   POST /api/risk-control/evaluate          ← Discipline gate-passed trade
 *   POST /api/risk-control/discipline-request ← Discipline MUST_EXIT / PARTIAL_EXIT
 *   POST /api/risk-control/ai-signal         ← SEA continuous signal
 *
 * All three are protected by the B1 auth middleware (mounted on /api).
 * Bodies validated by zod via the B8 helpers; strict mode on every
 * envelope. Method bodies live on rcaMonitor (./index.ts) — these
 * routes are pure adapters.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { validateBody } from "../_core/zodMiddleware";
import { rcaMonitor } from "./index";
import { createLogger } from "../broker/logger";

const log = createLogger("RCA", "REST");

// ─── Schemas (strict) ───────────────────────────────────────────

const channelSchema = z.enum([
  "ai-live",
  "ai-paper",
  "my-live",
  "my-paper",
  "testing-live",
  "testing-sandbox",
]);

const evaluateSchema = z
  .object({
    executionId: z.string().min(1),
    channel: channelSchema,
    instrument: z.string().min(1),
    direction: z.enum(["BUY", "SELL"]),
    quantity: z.number().positive(),
    entryPrice: z.number().positive(),
    stopLoss: z.number().nullable(),
    takeProfit: z.number().nullable(),
    optionType: z.enum(["CE", "PE", "FUT"]).optional(),
    strike: z.number().optional(),
    expiry: z.string().optional(),
    contractSecurityId: z.string().optional(),
    capitalPercent: z.number().min(0).max(100).optional(),
    origin: z.enum(["RCA", "AI", "USER"]),
  })
  .strict();

const exitReasonEnum = z.enum([
  "MOMENTUM_EXIT",
  "VOLATILITY_EXIT",
  "SL_HIT",
  "TP_HIT",
  "AGE_EXIT",
  "STALE_PRICE_EXIT",
  "DISCIPLINE_EXIT",
  "AI_EXIT",
  "MANUAL",
  "EOD",
  "EXPIRY",
]);

const disciplineRequestSchema = z
  .object({
    reason: exitReasonEnum,
    detail: z.string().optional(),
    channels: z.array(channelSchema).optional(),
    scope: z
      .union([
        z.object({ kind: z.literal("ALL") }).strict(),
        z.object({ kind: z.literal("INSTRUMENT"), instrument: z.string().min(1) }).strict(),
        z.object({ kind: z.literal("TRADE_IDS"), tradeIds: z.array(z.string().min(1)).min(1) }).strict(),
      ]),
  })
  .strict();

const aiSignalSchema = z
  .object({
    instrument: z.string().min(1),
    signal: z.enum(["EXIT", "MODIFY_SL", "MODIFY_TP"]),
    confidence: z.number().min(0).max(1).optional(),
    /** Required when signal is MODIFY_SL or MODIFY_TP. */
    newPrice: z.number().positive().optional(),
    detail: z.string().optional(),
  })
  .strict()
  .refine(
    (v) => v.signal === "EXIT" || v.newPrice != null,
    { message: "newPrice required for MODIFY_SL / MODIFY_TP", path: ["newPrice"] },
  );

// ─── Routes ────────────────────────────────────────────────────

export function registerRiskControlRoutes(app: Express): void {
  app.post(
    "/api/risk-control/evaluate",
    validateBody(evaluateSchema),
    async (req: Request, res: Response) => {
      try {
        const result = await rcaMonitor.evaluateTrade(req.body as z.infer<typeof evaluateSchema>);
        res.json({ success: true, data: result });
      } catch (err: any) {
        log.error(`/evaluate failed: ${err?.message ?? err}`);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  app.post(
    "/api/risk-control/discipline-request",
    validateBody(disciplineRequestSchema),
    async (req: Request, res: Response) => {
      try {
        const result = await rcaMonitor.disciplineRequest(req.body as z.infer<typeof disciplineRequestSchema>);
        res.json({ success: true, data: result });
      } catch (err: any) {
        log.error(`/discipline-request failed: ${err?.message ?? err}`);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  app.post(
    "/api/risk-control/ai-signal",
    validateBody(aiSignalSchema),
    async (req: Request, res: Response) => {
      try {
        const result = await rcaMonitor.aiSignal(req.body as z.infer<typeof aiSignalSchema>);
        res.json({ success: true, data: result });
      } catch (err: any) {
        log.error(`/ai-signal failed: ${err?.message ?? err}`);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  log.important("REST routes registered under /api/risk-control/*");
}
