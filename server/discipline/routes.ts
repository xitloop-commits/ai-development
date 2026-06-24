/**
 * Discipline Agent — REST endpoints.
 *
 * Three endpoints:
 *   POST /api/discipline/validateTrade
 *     Python SEA POSTs new-trade signals here. The handler chains
 *     DA.validateTrade → RCA.evaluate → TEA.submitTrade so the full
 *     gate sequence fires server-side from a single round-trip.
 *
 *   POST /api/discipline/recordTradeOutcome   (Phase D2)
 *     Symmetric REST surface for the existing tRPC mutation. Python
 *     callers POST trade-close events here so DA can update its
 *     emotional-state counters / cooldowns / streaks.
 *
 *   GET  /api/discipline/status?channel=...   (Phase D2)
 *     Lightweight "am I allowed to trade?" snapshot. Same shape as
 *     tRPC `discipline.getSessionStatus`; both delegate to
 *     `disciplineAgent.getSessionStatus` so UI and Python see one
 *     source of truth.
 *
 * The legacy log-tail bridge (seaBridge.ts) was retired in C8-followup
 * once the soak confirmed SEA-Python was POSTing in production.
 *
 * Auth via B1 (X-Internal-Token); bodies / queries validated via B8
 * (.strict()).
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { validateBody, validateQuery } from "../_core/zodMiddleware";
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
    // quantity / estimatedValue are optional for the thin AI path: when omitted
    // the server sizes the trade itself (lots × scrip-master lot size) and
    // computes estimatedValue. UI/full callers still pass them through unchanged.
    quantity: z.number().positive().optional(),
    estimatedValue: z.number().optional(),
    /** Lots to trade when the server sizes (AI path). Defaults to 1. */
    lots: z.number().positive().optional(),
    /** Strategy cohort (scalp | trend | swing | multi_day_swing) — stamped onto
     *  the trade for P&L grouping. */
    cohort: z.string().optional(),

    stopLoss: z.number().nullable(),
    takeProfit: z.number().nullable(),
    capitalPercent: z.number().min(0).max(100).optional(),

    // DA-side context
    aiConfidence: z.number().optional(),
    aiRiskReward: z.number().optional(),
    emotionalState: z.enum(["calm", "anxious", "revenge", "fomo", "greedy", "neutral"]).optional(),
    planAligned: z.boolean().optional(),
    checklistDone: z.boolean().optional(),
    currentCapital: z.number().nonnegative().optional(),
    currentExposure: z.number().nonnegative().optional(),
  })
  .strict();

const recordTradeOutcomeSchema = z
  .object({
    channel: channelSchema,
    tradeId: z.string().min(1),
    realizedPnl: z.number(),
    openingCapital: z.number().nonnegative(),
    // Canonical ExitReasonCode union — see shared/exitContracts.ts.
    exitReason: z
      .enum([
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
      ])
      .optional(),
    exitTriggeredBy: z
      .enum(["RCA", "BROKER", "DISCIPLINE", "AI", "USER", "PA"])
      .optional(),
    signalSource: z.string().optional(),
  })
  .strict();

const sessionStatusQuerySchema = z
  .object({
    channel: z.string().min(1),
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
        // 0. Thin AI path — when the caller omits quantity, the server sizes the
        //    trade and sources capital/exposure itself (single source of truth),
        //    and enforces one open position per instrument so the SEA's 30s
        //    signal re-emits don't stack duplicate entries.
        let quantity = body.quantity;
        let estimatedValue = body.estimatedValue;
        let currentCapital = body.currentCapital;
        let currentExposure = body.currentExposure;
        let entryPrice = body.entryPrice;
        let stopLoss = body.stopLoss;
        let takeProfit = body.takeProfit;
        if (quantity == null) {
          const { resolveLotSize } = await import("../executor/tradeResolution");
          const { getCapitalState } = await import("../portfolio/state");
          const { portfolioAgent } = await import("../portfolio");
          const { tickBus } = await import("../broker/tickBus");

          const openTrades = await portfolioAgent.listOpenTrades(body.channel);
          if (openTrades.some((t) => t.instrument === body.instrument)) {
            log.info(`AI trade skipped — position already open channel=${body.channel} instrument=${body.instrument}`);
            res.json({
              success: false,
              stage: "GUARD",
              decision: "REJECT",
              reason: `position already open for ${body.instrument}`,
            });
            return;
          }

          // Re-price the entry to the LIVE tick the trade will actually track
          // (the same WS feed trade.ltp uses). The SEA's `entry` is a TFA
          // feature-file snapshot that lags on momentum signals, so without this
          // every fill opened instantly green. Delta-shift SL/TP to keep their
          // rupee distances. Falls back to the signal entry if no tick is cached.
          if (body.contractSecurityId) {
            const seg = body.exchange === "MCX" ? "MCX_COMM" : "NSE_FNO";
            const liveLtp = tickBus.getLatestTick(seg, body.contractSecurityId)?.ltp;
            if (liveLtp && liveLtp > 0 && entryPrice > 0) {
              const delta = liveLtp - entryPrice;
              if (stopLoss != null) stopLoss += delta;
              if (takeProfit != null) takeProfit += delta;
              log.info(`AI entry repriced ${body.instrument} ${entryPrice} → ${liveLtp} (live tick)`);
              entryPrice = liveLtp;
            }
          }

          const lots = body.lots ?? 1;
          const lotSize = (await resolveLotSize(body.instrument)) ?? 1;
          quantity = Math.max(1, Math.round(lots * lotSize));
          estimatedValue = quantity * entryPrice;
          const cap = await getCapitalState(body.channel);
          currentCapital = cap.tradingPool;
          currentExposure = openTrades.reduce((s, t) => s + t.entryPrice * t.qty, 0);
        }

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
            entryPrice,
            quantity: quantity ?? 0,
            estimatedValue: estimatedValue ?? 0,
            aiConfidence: body.aiConfidence,
            aiRiskReward: body.aiRiskReward,
            emotionalState: body.emotionalState,
            planAligned: body.planAligned,
            checklistDone: body.checklistDone,
            stopLoss: stopLoss ?? undefined,
            target: takeProfit ?? undefined,
          },
          currentCapital ?? 0,
          currentExposure ?? 0,
          body.channel,
        );
        if (!validation.allowed) {
          const reasonText = validation.blockReasons?.length
            ? validation.blockReasons.join("; ")
            : validation.blockedBy.join(", ");
          log.info(`DA reject channel=${body.channel} reason="${reasonText}" dt=${Date.now() - t0}ms`);
          res.json({
            success: false,
            stage: "DA",
            decision: "REJECT",
            blockedBy: validation.blockedBy,
            blockReasons: validation.blockReasons,
            reason: reasonText,
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
          quantity: quantity ?? 0,
          entryPrice,
          stopLoss,
          takeProfit,
          optionType: body.optionType,
          strike: body.strike,
          expiry: body.expiry,
          contractSecurityId: body.contractSecurityId,
          capitalPercent: body.capitalPercent,
          cohort: body.cohort,
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

  // Phase D2 — POST /api/discipline/recordTradeOutcome
  app.post(
    "/api/discipline/recordTradeOutcome",
    validateBody(recordTradeOutcomeSchema),
    async (req: Request, res: Response) => {
      const body = req.body as z.infer<typeof recordTradeOutcomeSchema>;
      try {
        await disciplineAgent.recordTradeOutcome(body);
        res.json({ success: true });
      } catch (err: any) {
        log.error(`/recordTradeOutcome failed: ${err?.message ?? err}`);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  // Phase D2 — GET /api/discipline/status?channel=ai-paper
  app.get(
    "/api/discipline/status",
    validateQuery(sessionStatusQuerySchema),
    async (req: Request, res: Response) => {
      const { channel } = req.query as unknown as z.infer<typeof sessionStatusQuerySchema>;
      try {
        const status = await disciplineAgent.getSessionStatus(DEFAULT_USER_ID, channel);
        res.json(status);
      } catch (err: any) {
        log.error(`/status failed: ${err?.message ?? err}`);
        res.status(500).json({ error: err?.message ?? String(err) });
      }
    },
  );

  log.important("REST routes registered under /api/discipline/*");
}
