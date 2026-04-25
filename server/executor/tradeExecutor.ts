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
 * recordTradeClosed / appendTrade) flow through TEA exclusively.
 *
 * Phase 1 commit 2: paper-channel submitTrade is wired end-to-end via
 * MockAdapter + portfolioAgent.appendTrade. Live channels and the
 * modify/exit/auto-exit methods follow in commits 3–4.
 */

import { createLogger } from "../broker/logger";
import { getAdapter, isChannelKillSwitchActive } from "../broker/brokerService";
import { tickBus } from "../broker/tickBus";
import type {
  BrokerAdapter,
  ExchangeSegment,
  OptionType,
  OrderParams,
  OrderResult,
  OrderStatus,
  TransactionType,
} from "../broker/types";
import { portfolioAgent } from "../portfolio";
import type { Channel, TradeRecord, TradeStatus } from "../portfolio/state";
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

const PAPER_CHANNELS: Channel[] = ["my-paper", "ai-paper", "testing-sandbox"];
const LIVE_CHANNELS: Channel[] = ["my-live", "ai-live", "testing-live"];

function isPaperChannel(channel: Channel): boolean {
  return PAPER_CHANNELS.includes(channel);
}

function isLiveChannel(channel: Channel): boolean {
  return LIVE_CHANNELS.includes(channel);
}

/**
 * Channels with the broker kill switch armed cannot place new trades.
 * Returns true if the channel is currently locked.
 */
function isKillSwitchOn(channel: Channel): boolean {
  try {
    return isChannelKillSwitchActive(channel);
  } catch {
    return false;
  }
}

class TradeExecutorAgent {
  private started = false;

  /** Lifecycle — invoked by server boot in _core/index.ts. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    log.info("Started — Trade Executor Agent v1.3 (Phase 1 commit 2: paper submit wired)");
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    log.info("Stopped");
  }

  // ── §4.1 Submit a trade ─────────────────────────────────────

  async submitTrade(req: SubmitTradeRequest): Promise<SubmitTradeResponse> {
    // Idempotency — duplicate executionIds replay the cached response.
    const cached = idempotencyStore.reserve<SubmitTradeResponse>(req.executionId);
    if (cached) {
      if (cached.status === "completed" && cached.result) {
        log.warn(`submitTrade duplicate executionId=${req.executionId} — replaying cached result`);
        return cached.result;
      }
      // in_progress or failed — return a synthetic rejection so the caller
      // doesn't retry blindly.
      return rejection(req.executionId, "Duplicate executionId in flight or already failed");
    }

    try {
      // Pre-flight: kill switch arms reject orders before they hit the broker.
      if (isKillSwitchOn(req.channel)) {
        const resp = rejection(req.executionId, `Kill switch active for channel ${req.channel}`);
        idempotencyStore.fail(req.executionId, resp.error!);
        await portfolioAgent.recordTradeRejected({
          channel: req.channel,
          trade: { instrument: req.instrument },
          reason: resp.error!,
          timestamp: Date.now(),
        });
        return resp;
      }

      const adapter: BrokerAdapter = getAdapter(req.channel);
      const orderParams = mapToOrderParams(req);

      // Subscribe to the option-leg LTP feed before placing so ticks start
      // flowing immediately. No-op for futures / non-option trades.
      ensureOptionLtpSubscription(adapter, req);

      // Place the order — this is the SINGLE point in the codebase that
      // calls broker.placeOrder. Spec §3 rule 1 (Single Execution Point).
      let orderResult: OrderResult;
      try {
        orderResult = await adapter.placeOrder(orderParams);
      } catch (placeErr: any) {
        const msg = placeErr?.message ?? String(placeErr);
        log.error(`submitTrade broker.placeOrder threw channel=${req.channel}: ${msg}`);
        const resp = rejection(req.executionId, `Broker error: ${msg}`);
        idempotencyStore.fail(req.executionId, resp.error!);
        await portfolioAgent.recordTradeRejected({
          channel: req.channel,
          trade: { instrument: req.instrument },
          reason: resp.error!,
          timestamp: Date.now(),
        });
        return resp;
      }

      // Terminal failure on the broker side — do NOT create a local trade.
      if (
        orderResult.status === "REJECTED" ||
        orderResult.status === "CANCELLED" ||
        orderResult.status === "EXPIRED"
      ) {
        const resp = rejection(
          req.executionId,
          orderResult.message ?? `Broker returned ${orderResult.status}`,
        );
        idempotencyStore.fail(req.executionId, resp.error!);
        await portfolioAgent.recordTradeRejected({
          channel: req.channel,
          trade: { instrument: req.instrument },
          reason: resp.error!,
          timestamp: Date.now(),
        });
        return resp;
      }

      // Build + persist the trade. Status depends on whether the broker
      // filled immediately (paper / market) or queued (live limit / partial).
      const tradeId = req.tradeId ?? generateTradeId();
      const positionId = `POS-${tradeId.replace(/^T/, "")}`;
      const tradeStatus = mapBrokerStatusToTradeStatus(orderResult.status);
      const submitStatus = mapBrokerStatusToSubmitStatus(orderResult.status);
      const trade = buildTradeRecord(req, tradeId, orderResult.orderId, tradeStatus);

      await portfolioAgent.appendTrade(req.channel, trade);
      await portfolioAgent.recordTradePlaced({
        channel: req.channel,
        trade,
        timestamp: Date.now(),
      });

      const response: SubmitTradeResponse = {
        success: true,
        executionId: req.executionId,
        tradeId,
        positionId,
        orderId: orderResult.orderId,
        // For paper / market fills the entryPrice IS the fill price; for live
        // limit / partial fills, the broker's order book will report the
        // actual averagePrice via WS events (orderSync handles in commit 5).
        executedPrice: req.entryPrice,
        executedQuantity: tradeStatus === "OPEN" ? req.quantity : 0,
        status: submitStatus,
        timestamp: Date.now(),
      };
      idempotencyStore.complete(req.executionId, response);
      log.info(
        `submitTrade ok channel=${req.channel} trade=${tradeId} order=${orderResult.orderId} ` +
          `brokerStatus=${orderResult.status} tradeStatus=${tradeStatus}`,
      );
      return response;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      log.error(`submitTrade failed executionId=${req.executionId}: ${message}`);
      const resp = rejection(req.executionId, message);
      idempotencyStore.fail(req.executionId, message);
      return resp;
    }
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

// ─── Helpers ────────────────────────────────────────────────────

function generateTradeId(): string {
  return `T${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function rejection(executionId: string, error: string): SubmitTradeResponse {
  return {
    success: false,
    executionId,
    tradeId: "",
    positionId: "",
    orderId: null,
    executedPrice: null,
    executedQuantity: null,
    status: "REJECTED",
    error,
    timestamp: Date.now(),
  };
}

function resolveExchange(instrument: string): ExchangeSegment {
  const upper = instrument.toUpperCase();
  if (upper.includes("CRUDE") || upper.includes("NATURAL")) return "MCX_COMM";
  return "NSE_FNO";
}

function resolveOptionType(req: SubmitTradeRequest): OptionType {
  if (req.optionType === "CE") return "CE";
  if (req.optionType === "PE") return "PE";
  return "FUT";
}

function resolveTransactionType(direction: "BUY" | "SELL"): TransactionType {
  return direction === "BUY" ? "BUY" : "SELL";
}

function mapToOrderParams(req: SubmitTradeRequest): OrderParams {
  return {
    instrument: req.instrument,
    exchange: resolveExchange(req.instrument),
    transactionType: resolveTransactionType(req.direction),
    optionType: resolveOptionType(req),
    strike: req.strike ?? 0,
    expiry: req.expiry ?? "",
    quantity: req.quantity,
    price: req.entryPrice,
    orderType: req.orderType,
    // Broker's ProductType is INTRADAY | CNC | MARGIN. TEA's BO and MIS both
    // map to INTRADAY; bracket-order semantics come from stopLoss + target.
    productType: req.productType === "CNC" ? "CNC" : "INTRADAY",
    stopLoss: req.stopLoss ?? undefined,
    target: req.takeProfit ?? undefined,
    tag: `TEA-${req.executionId}`,
  };
}

function buildTradeRecord(
  req: SubmitTradeRequest,
  tradeId: string,
  brokerOrderId: string,
  status: TradeStatus,
): TradeRecord {
  const tradeType: TradeRecord["type"] =
    req.optionType === "CE"
      ? req.direction === "BUY" ? "CALL_BUY" : "CALL_SELL"
      : req.optionType === "PE"
      ? req.direction === "BUY" ? "PUT_BUY" : "PUT_SELL"
      : req.direction === "BUY" ? "BUY" : "SELL";

  return {
    id: tradeId,
    instrument: req.instrument,
    type: tradeType,
    strike: req.strike ?? null,
    expiry: req.expiry ?? null,
    contractSecurityId: req.contractSecurityId ?? null,
    entryPrice: req.entryPrice,
    exitPrice: null,
    ltp: req.entryPrice,
    qty: req.quantity,
    capitalPercent: req.capitalPercent ?? 0,
    pnl: 0,
    unrealizedPnl: 0,
    charges: 0,
    chargesBreakdown: [],
    status,
    targetPrice: req.takeProfit ?? null,
    stopLossPrice: req.stopLoss ?? null,
    trailingStopEnabled: req.trailingStopLoss?.enabled ?? false,
    brokerId: brokerOrderId,
    openedAt: Date.now(),
    closedAt: null,
  };
}

/**
 * Map the broker's OrderStatus to our TradeRecord.status. FILLED / OPEN
 * (broker's "live in market") map to OPEN; PENDING / PARTIALLY_FILLED stay
 * PENDING until orderSync (commit 5) confirms the fill.
 */
function mapBrokerStatusToTradeStatus(status: OrderStatus): TradeStatus {
  switch (status) {
    case "FILLED":
    case "OPEN":
      return "OPEN";
    case "PENDING":
    case "PARTIALLY_FILLED":
      return "PENDING";
    default:
      return "PENDING";
  }
}

/** Map broker status to the SubmitTrade response `status` field. */
function mapBrokerStatusToSubmitStatus(
  status: OrderStatus,
): "PLACED" | "FILLED" | "PARTIAL" | "REJECTED" {
  switch (status) {
    case "FILLED":
      return "FILLED";
    case "PARTIALLY_FILLED":
      return "PARTIAL";
    case "PENDING":
    case "OPEN":
      return "PLACED";
    default:
      return "REJECTED";
  }
}

/**
 * For option trades on live channels, ensure the contract is on the broker's
 * WS subscription so ticks flow into tickBus. Mock adapters treat this as a
 * no-op. Failures are non-fatal — the trade still places, but LTP may not
 * stream until the user subscribes manually.
 */
function ensureOptionLtpSubscription(
  adapter: BrokerAdapter,
  req: SubmitTradeRequest,
): void {
  if (!req.contractSecurityId) return;
  if (!adapter.subscribeLTP) return;
  try {
    const exchange = resolveExchange(req.instrument);
    const wsExchange = exchange === "MCX_COMM" ? "MCX_COMM" : "NSE_FNO";
    adapter.subscribeLTP(
      [{ exchange: wsExchange as any, securityId: req.contractSecurityId, mode: "full" }] as any,
      (tick) => tickBus.emitTick(tick),
    );
    log.debug(
      `Subscribed option LTP: ${wsExchange}:${req.contractSecurityId} for trade ${req.executionId}`,
    );
  } catch (err: any) {
    log.warn(`subscribeLTP failed for ${req.contractSecurityId}: ${err?.message ?? err}`);
  }
}

export const tradeExecutor = new TradeExecutorAgent();
