/**
 * Discipline Agent — REST endpoint (Phase C — SEA integration).
 *
 * One endpoint:
 *   POST /api/discipline/validateTrade
 *     Python SEA POSTs new-trade signals here. The handler chains
 *     DA.validateTrade → RCA.evaluate → TEA.submitTrade so the full
 *     gate sequence fires server-side from a single round-trip.
 *
 * The legacy seaBridge.ts log-tail bridge stays operational alongside
 * this endpoint during the migration soak — bridge uses idempotency
 * by executionId so duplicate submission is a no-op.
 *
 * Auth via B1 (X-Internal-Token); body validated via B8 (.strict()).
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { validateBody } from "../_core/zodMiddleware";
import { disciplineAgent } from "./index";
import { createLogger } from "../broker/logger";

const log = createLogger("DA", "REST");

// ─── Schema ────────────────────────────────────────────────────

const channelSchema = z.enum([
  "ai-live",
  "ai-paper",
  "my-live",
  "my-paper",
  "testing-live",
  "testing-sandbox",
]);

/**
 * Mirrors what tRPC `discipline.validate` accepts, plus the routing
 * fields RCA/TEA need (executionId, channel, origin). Request comes
 * from SEA as a complete trade intent; the handler performs the gate
 * chain end-to-end.
 */
const validateTradeSchema = z
  .object({
    // Routing / idempotency
    executionId: z.string().min(1),
    channel: channelSchema,
    origin: z.enum(["RCA", "AI", "USER"]),

    // Trade fields (TradeValidationRequest + RCA.evaluate inputs)
    instrument: z.string().min(1),
    exchange: z.enum(["NSE", "MCX"]),
    transactionType: z.enum(["BUY", "SELL"]),
    optionType: z.enum(["CE", "PE", "FUT"]),
    strike: z.number(),
    expiry: z.string().optional(),
    contractSecurityId: z.string().optional(),
    entryPrice: z.number().positive(),
    quantity: z.number().positive(),
    estimatedValue: z.number(),

    stopLoss: z.number().nullable(),
    takeProfit: z.number().nullable(),
    capitalPercent: z.number().min(0).max(100).optional(),

    // DA-side context
    aiConfidence: z.number().optional(),
    aiRiskReward: z.number().optional(),
    emotionalState: z.enum(["calm", "anxious", "revenge", "fomo", "greedy", "neutral"]).optional(),
    planAligned: z.boolean().optional(),
    checklistDone: z.boolean().optional(),
    currentCapital: z.number().nonnegative(),
    currentExposure: z.number().nonnegative(),
  })
  .strict();

const DEFAULT_USER_ID = "1";

// ─── Routes ────────────────────────────────────────────────────

export function registerDisciplineRoutes(app: Express): void {
  app.post(
    "/api/discipline/validateTrade",
    validateBody(validateTradeSchema),
    async (req: Request, res: Response) => {
      const body = req.body as z.infer<typeof validateTradeSchema>;
      const t0 = Date.now();
      try {
        // 1. DA pre-trade gate. Pass channel through so per-channel
        //    sessionHalts (Module 8) and per-channel counters resolve.
        const validation = await disciplineAgent.validateTrade(
          DEFAULT_USER_ID,
          {
            instrument: body.instrument,
            exchange: body.exchange,
            transactionType: body.transactionType,
            optionType: body.optionType === "FUT" ? "CE" : body.optionType,
            strike: body.strike,
            entryPrice: body.entryPrice,
            quantity: body.quantity,
            estimatedValue: body.estimatedValue,
            aiConfidence: body.aiConfidence,
            aiRiskReward: body.aiRiskReward,
            emotionalState: body.emotionalState,
            planAligned: body.planAligned,
            checklistDone: body.checklistDone,
            stopLoss: body.stopLoss ?? undefined,
            target: body.takeProfit ?? undefined,
          },
          body.currentCapital,
          body.currentExposure,
          body.channel,
        );
        if (!validation.allowed) {
          log.info(`DA reject channel=${body.channel} blockedBy=[${validation.blockedBy.join(",")}] dt=${Date.now() - t0}ms`);
          res.json({
            success: false,
            stage: "DA",
            decision: "REJECT",
            blockedBy: validation.blockedBy,
            warnings: validation.warnings,
          });
          return;
        }

        // 2. RCA evaluate → forwards to TEA.submitTrade on APPROVE.
        //    Imported lazily to break a server-startup module-load cycle
        //    (DA/RCA both lift wire imports through _core/index.ts).
        const { rcaMonitor } = await import("../risk-control");
        const evalResult = await rcaMonitor.evaluateTrade({
          executionId: body.executionId,
          channel: body.channel,
          instrument: body.instrument,
          direction: body.transactionType === "BUY" ? "BUY" : "SELL",
          quantity: body.quantity,
          entryPrice: body.entryPrice,
          stopLoss: body.stopLoss,
          takeProfit: body.takeProfit,
          optionType: body.optionType,
          strike: body.strike,
          expiry: body.expiry,
          contractSecurityId: body.contractSecurityId,
          capitalPercent: body.capitalPercent,
          origin: body.origin,
        });

        log.info(
          `chain channel=${body.channel} instrument=${body.instrument} ` +
            `decision=${evalResult.decision} dt=${Date.now() - t0}ms`,
        );
        res.json({
          success: evalResult.decision !== "REJECT",
          stage: "RCA",
          decision: evalResult.decision,
          reason: evalResult.reason,
          tradeId: evalResult.submitResult?.tradeId,
          orderId: evalResult.submitResult?.orderId,
          status: evalResult.submitResult?.status,
        });
      } catch (err: any) {
        log.error(`/validateTrade failed: ${err?.message ?? err}`);
        res.status(500).json({ success: false, stage: "ERROR", error: err?.message ?? String(err) });
      }
    },
  );

  log.important("REST routes registered under /api/discipline/*");
}
