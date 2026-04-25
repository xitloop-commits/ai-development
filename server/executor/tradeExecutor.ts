/**
 * Trade Executor Agent (TEA) — single execution gateway.
 *
 * Implements TradeExecutorAgent_Spec_v1.3.
 *
 * INVARIANT: TEA is the **only** module in the codebase allowed to call
 * `brokerService.placeOrder` / `modifyOrder` / `cancelOrder`. Every other
 * agent (RCA, SEA, AI Engine, UI) submits its intent via TEA's API and
 * lets TEA decide how to materialise it on the broker. Phase 1 commit 6
 * cuts the UI over; commit 7 adds the lint-style sweep that enforces this.
 *
 * INVARIANT: TEA is the **only** writer to the Portfolio Agent's trade
 * state. Reads can come from anywhere; writes (recordTradePlaced /
 * recordTradeClosed) flow through TEA exclusively.
 *
 * Phase 1 commit 1 (this file): class skeleton with stubbed methods so the
 * tRPC router compiles. Subsequent commits flesh out each method.
 */

import { createLogger } from "../broker/logger";
import { idempotencyStore } from "./idempotency";
import type {
  SubmitTradeRequest,
  SubmitTradeResponse,
  ModifyOrderRequest,
  ModifyOrderResponse,
  ExitTradeRequest,
  ExitTradeResponse,
  RecordAutoExitRequest,
} from "./types";

const log = createLogger("TradeExecutor");

class TradeExecutorAgent {
  private started = false;

  /** Lifecycle — invoked by server boot in _core/index.ts. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    log.info("Started — Trade Executor Agent v1.3 (Phase 1 commit 1: skeleton)");
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    log.info("Stopped");
  }

  // ── §4.1 Submit a trade ─────────────────────────────────────

  async submitTrade(req: SubmitTradeRequest): Promise<SubmitTradeResponse> {
    const cached = idempotencyStore.reserve<SubmitTradeResponse>(req.executionId);
    if (cached) {
      log.warn(`submitTrade duplicate executionId=${req.executionId} status=${cached.status}`);
      if (cached.status === "completed" && cached.result) return cached.result;
      return notImplemented<SubmitTradeResponse>(req.executionId, "submitTrade is not implemented yet (Phase 1 commit 2)");
    }

    // Phase 1 commit 1: skeleton — wiring lands in commits 2 (paper) + 3 (live).
    const response = notImplemented<SubmitTradeResponse>(
      req.executionId,
      "submitTrade is not implemented yet (Phase 1 commit 2)",
    );
    idempotencyStore.fail(req.executionId, response.error ?? "not implemented");
    return response;
  }

  // ── §4.2 Modify an open order ──────────────────────────────

  async modifyOrder(req: ModifyOrderRequest): Promise<ModifyOrderResponse> {
    const cached = idempotencyStore.reserve<ModifyOrderResponse>(req.executionId);
    if (cached?.status === "completed" && cached.result) return cached.result;

    const response: ModifyOrderResponse = {
      success: false,
      positionId: req.positionId,
      modificationId: "",
      oldSL: null,
      newSL: null,
      oldTP: null,
      newTP: null,
      appliedAt: Date.now(),
      error: "modifyOrder is not implemented yet (Phase 1 commit 4)",
    };
    idempotencyStore.fail(req.executionId, response.error!);
    return response;
  }

  // ── §4.3 Exit a trade ──────────────────────────────────────

  async exitTrade(req: ExitTradeRequest): Promise<ExitTradeResponse> {
    const cached = idempotencyStore.reserve<ExitTradeResponse>(req.executionId);
    if (cached?.status === "completed" && cached.result) return cached.result;

    const response: ExitTradeResponse = {
      success: false,
      positionId: req.positionId,
      exitId: "",
      exitPrice: 0,
      executedQuantity: 0,
      realizedPnl: 0,
      realizedPnlPct: 0,
      exitTime: Date.now(),
      error: "exitTrade is not implemented yet (Phase 1 commit 4)",
    };
    idempotencyStore.fail(req.executionId, response.error!);
    return response;
  }

  // ── PA-internal: tickHandler reports a paper TP/SL hit ─────

  /**
   * Server-internal call. Not exposed via tRPC. tickHandler in PortfolioAgent
   * detects paper-channel TP / SL hits and routes the close through TEA so
   * the single-writer invariant holds. Phase 1 commit 4 implements.
   */
  async recordAutoExit(_req: RecordAutoExitRequest): Promise<void> {
    log.debug("recordAutoExit: not implemented yet (Phase 1 commit 4)");
  }
}

function notImplemented<T extends { success: boolean; error?: string; timestamp?: number; executionId?: string; tradeId?: string; positionId?: string; orderId?: string | null; executedPrice?: number | null; executedQuantity?: number | null; status?: string }>(
  executionId: string,
  message: string,
): T {
  return {
    success: false,
    executionId,
    tradeId: "",
    positionId: "",
    orderId: null,
    executedPrice: null,
    executedQuantity: null,
    status: "REJECTED",
    error: message,
    timestamp: Date.now(),
  } as unknown as T;
}

export const tradeExecutor = new TradeExecutorAgent();
