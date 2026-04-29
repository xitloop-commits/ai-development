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
 * Phase 1 commit 4: submitTrade (paper + live), modifyOrder, exitTrade,
 * and recordAutoExit are all wired. The single-writer invariant is now
 * enforced for every state-mutating path including paper TP/SL hits —
 * tickHandler emits 'autoExitDetected' and TEA owns the close.
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
import { disciplineAgent } from "../discipline";
import type { Exchange } from "../discipline/types";
import { idempotencyStore } from "./idempotency";
import { orderSync } from "./orderSync";
import { rcaMonitor } from "../risk-control";
import { recoveryEngine } from "./recoveryEngine";
import { resolveLotSize } from "./tradeResolution";
import { getExecutorSettings } from "./settings";
import type {
  SubmitTradeRequest,
  SubmitTradeResponse,
  ModifyOrderRequest,
  ModifyOrderResponse,
  ExitTradeRequest,
  ExitTradeResponse,
  RecordAutoExitRequest,
} from "./types";

const log = createLogger("TEA", "Executor");

const PAPER_CHANNELS: Channel[] = ["my-paper", "ai-paper", "testing-sandbox"];
const LIVE_CHANNELS: Channel[] = ["my-live", "ai-live", "testing-live"];

// AI_LIVE_LOT_CAP is now sourced from executor_settings (default 1).
// TEA Settings page surfaces it; checkAiLiveLotCap reads through the
// 30 s-cached settings layer.

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
  private unsubscribeAutoExit: (() => void) | null = null;

  /** Lifecycle — invoked by server boot in _core/index.ts. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Hydrate the idempotency cache from MongoDB so executions that
    // landed before a restart still dedup. Fire-and-forget; if Mongo
    // is slow the in-memory store starts cold and warms as new
    // requests arrive.
    idempotencyStore.loadFromMongo().catch(() => undefined);
    // Subscribe to tickHandler's TP/SL detection events so paper auto-exits
    // route through TEA's single-writer flow.
    this.unsubscribeAutoExit = portfolioAgent.onAutoExit((event) => {
      this.recordAutoExit({
        channel: event.channel,
        tradeId: event.tradeId,
        reason: event.reason,
        exitPrice: event.exitPrice,
        triggeredBy: "PA",
        timestamp: event.timestamp,
      }).catch((err) => log.error(`recordAutoExit failed: ${err?.message ?? err}`));
    });
    // Order lifecycle sync (broker WS events → trade record reconciliation).
    // Lives under executor/ per spec §6.4. Paper channels never emit broker
    // order updates; this is effectively live-only.
    orderSync.start();
    // SEA → TEA path is now the DA→RCA→TEA REST chain (C8); the legacy
    // log-tail bridge was retired in C8-followup. SEA-Python POSTs to
    // /api/discipline/validateTrade.
    // RCA's lifecycle moved to _core/index.ts (C2) — RCA is a top-level
    // agent now, not a TEA child. TEA still calls into rcaMonitor at
    // runtime (signal-flip triggers, etc.) but doesn't own start/stop.
    // Recovery engine — polls live brokers for PENDING orders > 60s old
    // and emits synthetic OrderUpdate events to orderSync if the
    // underlying broker order has reached a terminal status. Backstop
    // for missed WS events. Live channels only.
    recoveryEngine.start();
    log.important("Started — Trade Executor Agent v1.3 (SEA + recovery online)");
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.unsubscribeAutoExit) {
      this.unsubscribeAutoExit();
      this.unsubscribeAutoExit = null;
    }
    orderSync.stop();
    recoveryEngine.stop();
    log.important("Stopped");
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

      // Pre-flight: AI Live 1-lot cap. The canary protocol launches at
      // 1 lot per trade; bigger orders on ai-live are rejected here even
      // if the caller (UI / future RCA / future SEA-live) tries to size
      // up. SEA's paper bridge already sends 1 lot, so this is a backstop
      // against accidental misconfiguration once ai-live is activated.
      if (req.channel === "ai-live") {
        const cap = await this.checkAiLiveLotCap(req);
        if (cap) {
          const resp = rejection(req.executionId, cap);
          idempotencyStore.fail(req.executionId, resp.error!);
          await portfolioAgent.recordTradeRejected({
            channel: req.channel,
            trade: { instrument: req.instrument },
            reason: resp.error!,
            timestamp: Date.now(),
          });
          return resp;
        }
      }

      // Pre-flight: Discipline cap-check (PA Phase 3 §10.1). Blocks orders
      // when the circuit breaker / cooldown / trade-limit / position-size
      // rules would be violated. Skipped silently if Discipline state can't
      // be read so a transient discipline-engine failure doesn't halt
      // trading — Phase 4 will harden this to fail-closed.
      const blockReason = await this.disciplinePreCheck(req);
      if (blockReason) {
        const resp = rejection(req.executionId, `Discipline blocked: ${blockReason}`);
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
      const trade = buildTradeRecord(
        req,
        tradeId,
        orderResult.orderId,
        adapter.brokerId,
        tradeStatus,
      );

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

  /**
   * AI Live 1-lot cap enforcement. Resolves the lot size for the
   * instrument and rejects if the request quantity translates to more
   * than `AI_LIVE_LOT_CAP` lots. Returns a human reason on violation,
   * null when the trade is within cap.
   *
   * Lot size resolution failures fall back to a strict 1-unit cap —
   * we'd rather reject a single ambiguous trade than let an
   * unbounded one through.
   */
  private async checkAiLiveLotCap(req: SubmitTradeRequest): Promise<string | null> {
    const settings = await getExecutorSettings();
    const cap = settings.aiLiveLotCap;
    const lotSize = (await resolveLotSize(req.instrument)) ?? 1;
    const lots = req.quantity / lotSize;
    if (lots > cap + 0.0001 /* float tolerance */) {
      return `AI Live lot cap violated: ${req.quantity} units / ${lotSize} lot-size = ${lots.toFixed(2)} lots > ${cap}`;
    }
    return null;
  }

  /**
   * Discipline cap-check: query disciplineAgent.validateTrade() with
   * the snapshot's currentCapital + openExposure. Returns a human
   * blockedBy string if the trade should be rejected, or null if
   * Discipline allows it.
   *
   * Phase 4 fail-closed: a thrown error from the discipline engine is
   * now treated as a BLOCK, not a pass-through. Rationale: the gate
   * exists to prevent capital loss during emotionally-charged or
   * cap-breaching states. If the gate is broken we don't know the
   * current state, and the safe default is "don't trade." Trade-offs:
   *
   *   - Cost of false reject: one missed signal entry, no capital impact.
   *   - Cost of false accept: a trade that should have been blocked
   *     gets placed (potential capital loss, especially on ai-live).
   *
   * Always prefer the false-reject failure mode.
   */
  private async disciplinePreCheck(req: SubmitTradeRequest): Promise<string | null> {
    try {
      const snap = await portfolioAgent.getState(req.channel);
      const exchange: Exchange =
        req.instrument.toUpperCase().includes("CRUDE") || req.instrument.toUpperCase().includes("NATURAL")
          ? "MCX"
          : "NSE";
      const result = await disciplineAgent.validateTrade(
        "1",
        {
          instrument: req.instrument,
          exchange,
          transactionType: req.direction,
          optionType: (req.optionType ?? "CE") === "FUT" ? "CE" : (req.optionType ?? "CE") as "CE" | "PE",
          strike: req.strike ?? 0,
          entryPrice: req.entryPrice,
          quantity: req.quantity,
          estimatedValue: req.entryPrice * req.quantity,
          stopLoss: req.stopLoss ?? undefined,
          target: req.takeProfit ?? undefined,
        },
        snap.currentCapital,
        snap.openExposure,
        req.channel,
      );
      if (!result.allowed && result.blockedBy.length > 0) {
        return result.blockedBy.join(", ");
      }
      return null;
    } catch (err: any) {
      log.error(`disciplinePreCheck FAILED — failing closed: ${err?.message ?? err}`);
      return `discipline engine error (fail-closed): ${err?.message ?? "unknown"}`;
    }
  }

  // ── §4.2 Modify an open order ──────────────────────────────

  async modifyOrder(req: ModifyOrderRequest): Promise<ModifyOrderResponse> {
    const cached = idempotencyStore.reserve<ModifyOrderResponse>(req.executionId);
    if (cached?.status === "completed" && cached.result) return cached.result;

    try {
      const channel = req.channel;
      const tradeId = tradeIdFromPositionId(req.positionId);

      // Live: send broker.modifyOrder to update the bracket leg's SL/TP. The
      // legacy router doesn't do this today (paper-only); TEA fixes it for
      // live channels. modifyOrder needs the broker order id to target — we
      // stored it on trade.brokerOrderId at submit time.
      //
      // B4: when the broker call fails on a LIVE channel we MUST NOT apply
      // the local SL/TP change — the broker still has the old bracket and
      // any local-only update would diverge silently. Instead, mark the
      // trade desync (status stays OPEN; position is alive at broker, only
      // the bracket differs) and fail the request so callers + UI know.
      if (isLiveChannel(channel)) {
        const adapter = getAdapter(channel);
        const day = await portfolioAgent.ensureCurrentDay(channel);
        const trade = day.trades.find((t) => t.id === tradeId);
        if (!trade) throw new Error(`Trade not found: ${tradeId}`);
        if (!trade.brokerOrderId) throw new Error(`Trade ${tradeId} has no brokerOrderId — cannot modify`);

        try {
          const result = await adapter.modifyOrder(trade.brokerOrderId, {
            triggerPrice: req.modifications.stopLossPrice ?? undefined,
            price: req.modifications.targetPrice ?? undefined,
          });
          log.info(
            `modifyOrder live broker ack channel=${channel} order=${trade.brokerOrderId} status=${result.status}`,
          );
        } catch (err: any) {
          const reason = err?.message ?? String(err);
          log.error(
            `modifyOrder BROKER_DESYNC channel=${channel} trade=${tradeId} order=${trade.brokerOrderId} reason=${reason}`,
          );
          await portfolioAgent.markTradeDesync(channel, tradeId, {
            kind: "MODIFY",
            reason,
            timestamp: Date.now(),
            attempted: {
              stopLossPrice: req.modifications.stopLossPrice ?? null,
              targetPrice: req.modifications.targetPrice ?? null,
            },
          });
          // B4-followup — notify RCA so its sliding-window counter can
          // trip the workspace kill switch on N consecutive desyncs.
          // Dynamic import breaks the TEA↔RCA cycle; fire-and-forget so
          // a slow notify doesn't delay the BROKER_DESYNC throw.
          void import("../risk-control").then(({ rcaMonitor }) =>
            rcaMonitor.notifyDesync(channel, tradeId, reason),
          ).catch((e) => log.warn(`RCA notifyDesync failed: ${e?.message ?? e}`));
          // Throw so the outer catch composes the failure response — local
          // SL/TP must NOT be updated when broker is out of sync.
          throw new Error(
            `BROKER_DESYNC: modifyOrder failed at broker (${reason}). Local SL/TP unchanged. Reconcile required.`,
          );
        }
      }

      // Local update — applies for paper and live alike (live arrives here
      // only when the broker call above succeeded; paper has no broker call).
      const { trade, oldSL, oldTP } = await portfolioAgent.updateTrade(channel, tradeId, {
        stopLossPrice: req.modifications.stopLoss ?? undefined,
        targetPrice: req.modifications.takeProfit ?? undefined,
        trailingStopEnabled: req.modifications.trailingStopLoss?.enabled,
      });

      const response: ModifyOrderResponse = {
        success: true,
        positionId: req.positionId,
        modificationId: `MOD-${req.executionId}`,
        oldSL,
        newSL: trade.stopLossPrice,
        oldTP,
        newTP: trade.targetPrice,
        appliedAt: Date.now(),
      };
      idempotencyStore.complete(req.executionId, response);
      log.info(
        `modifyOrder ok channel=${channel} trade=${tradeId} reason=${req.reason} ` +
          `SL ${oldSL}→${trade.stopLossPrice} TP ${oldTP}→${trade.targetPrice}`,
      );
      return response;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      log.error(`modifyOrder failed executionId=${req.executionId}: ${message}`);
      const response: ModifyOrderResponse = {
        success: false,
        positionId: req.positionId,
        modificationId: "",
        oldSL: null,
        newSL: null,
        oldTP: null,
        newTP: null,
        appliedAt: Date.now(),
        error: message,
      };
      idempotencyStore.fail(req.executionId, message);
      return response;
    }
  }

  // ── §4.3 Exit a trade ──────────────────────────────────────

  async exitTrade(req: ExitTradeRequest): Promise<ExitTradeResponse> {
    const cached = idempotencyStore.reserve<ExitTradeResponse>(req.executionId);
    if (cached?.status === "completed" && cached.result) return cached.result;

    try {
      const tradeId = tradeIdFromPositionId(req.positionId);
      const channel = req.channel;

      // Resolve current trade so we know exit price / instrument context.
      const day = await portfolioAgent.ensureCurrentDay(channel);
      const trade = day.trades.find((t) => t.id === tradeId);
      if (!trade) throw new Error(`Trade not found: ${tradeId}`);
      if (trade.status !== "OPEN" && trade.status !== "PENDING") {
        throw new Error(`Trade already closed: ${tradeId} (status=${trade.status})`);
      }

      // For LIMIT exits the caller supplies an exitPrice; for MARKET exits
      // we use the trade's current LTP (which tickHandler keeps fresh).
      const exitPrice = req.exitPrice ?? trade.ltp ?? trade.entryPrice;

      // Live channels: place a reverse broker order. DISCIPLINE_EXIT is
      // forced to MARKET per spec §4.3.
      //
      // B4: when the broker call fails on a LIVE channel we MUST NOT close
      // the trade locally. The broker may still have the position OPEN,
      // possibly drifting against us with no SL active. Mark the trade
      // BROKER_DESYNC, fail the request, and let the operator reconcile
      // (POST /api/executor/reconcile-desync) once they verify true state.
      if (isLiveChannel(channel) && trade.brokerOrderId) {
        const adapter = getAdapter(channel);
        const exitOrderType = req.reason === "DISCIPLINE_EXIT" ? "MARKET" : req.exitType;
        const exitParams: OrderParams = {
          instrument: trade.instrument,
          exchange: resolveExchange(trade.instrument),
          transactionType: trade.type.includes("BUY") ? "SELL" : "BUY",
          optionType: trade.type.startsWith("CALL")
            ? "CE"
            : trade.type.startsWith("PUT")
            ? "PE"
            : "FUT",
          strike: trade.strike ?? 0,
          expiry: trade.expiry ?? "",
          quantity: trade.qty,
          price: exitPrice,
          orderType: exitOrderType,
          productType: "INTRADAY",
          tag: `EXIT-${trade.id}`,
        };
        try {
          const result = await adapter.placeOrder(exitParams);
          log.info(
            `exitTrade live broker exit channel=${channel} trade=${tradeId} ` +
              `order=${result.orderId} status=${result.status}`,
          );
        } catch (err: any) {
          const reason = err?.message ?? String(err);
          log.error(
            `exitTrade BROKER_DESYNC channel=${channel} trade=${tradeId} reason=${reason}`,
          );
          await portfolioAgent.markTradeDesync(channel, tradeId, {
            kind: "EXIT",
            reason,
            timestamp: Date.now(),
          });
          // B4-followup — see modifyOrder hook above. Same pattern.
          void import("../risk-control").then(({ rcaMonitor }) =>
            rcaMonitor.notifyDesync(channel, tradeId, reason),
          ).catch((e) => log.warn(`RCA notifyDesync failed: ${e?.message ?? e}`));
          throw new Error(
            `BROKER_DESYNC: exit order failed at broker (${reason}). Position state unchanged locally. Reconcile required.`,
          );
        }
      }

      // Local close — single-writer entry point.
      const closeStatus = mapExitReasonToTradeStatus(req.reason);
      const { trade: closed, pnl, charges } = await portfolioAgent.closeTrade(
        channel,
        tradeId,
        exitPrice,
        closeStatus,
      );

      // Audit + Discipline push
      const closedAt = closed.closedAt ?? Date.now();
      const grossEntryValue = closed.entryPrice * closed.qty;
      await portfolioAgent.recordTradeClosed({
        channel,
        tradeId: closed.id,
        instrument: closed.instrument,
        side: closed.type.includes("BUY") ? "LONG" : "SHORT",
        entryPrice: closed.entryPrice,
        exitPrice,
        quantity: closed.qty,
        entryTime: closed.openedAt,
        exitTime: closedAt,
        realizedPnl: pnl,
        realizedPnlPercent: grossEntryValue > 0 ? (pnl / grossEntryValue) * 100 : 0,
        exitReason: req.reason,
        exitTriggeredBy: req.triggeredBy,
        duration: Math.round((closedAt - closed.openedAt) / 1000),
        pnlCategory: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
        signalSource: req.detail,
        timestamp: Date.now(),
      });

      void charges;
      const response: ExitTradeResponse = {
        success: true,
        positionId: req.positionId,
        exitId: `EXIT-${req.executionId}`,
        exitPrice,
        executedQuantity: closed.qty,
        realizedPnl: pnl,
        realizedPnlPct: grossEntryValue > 0 ? (pnl / grossEntryValue) * 100 : 0,
        exitTime: closedAt,
      };
      idempotencyStore.complete(req.executionId, response);
      log.info(
        `exitTrade ok channel=${channel} trade=${tradeId} reason=${req.reason} by=${req.triggeredBy} pnl=${pnl}`,
      );
      return response;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      log.error(`exitTrade failed executionId=${req.executionId}: ${message}`);
      const response: ExitTradeResponse = {
        success: false,
        positionId: req.positionId,
        exitId: "",
        exitPrice: 0,
        executedQuantity: 0,
        realizedPnl: 0,
        realizedPnlPct: 0,
        exitTime: Date.now(),
        error: message,
      };
      idempotencyStore.fail(req.executionId, message);
      return response;
    }
  }

  // ── PA-internal: tickHandler reports a paper TP/SL hit ─────

  /**
   * Server-internal call. tickHandler in PortfolioAgent emits
   * 'autoExitDetected' when a paper trade hits TP / SL on an incoming tick.
   * TEA.start subscribes and routes here; we run the canonical close
   * through portfolioAgent.closeTrade so the single-writer invariant holds.
   *
   * No broker call is needed — paper auto-exits never hit the broker.
   */
  async recordAutoExit(req: RecordAutoExitRequest): Promise<void> {
    try {
      const closeStatus: TradeStatus = req.reason === "TP_HIT" ? "CLOSED_TP" : "CLOSED_SL";
      const { trade: closed, pnl } = await portfolioAgent.closeTrade(
        req.channel,
        req.tradeId,
        req.exitPrice,
        closeStatus,
      );

      const closedAt = closed.closedAt ?? Date.now();
      const grossEntryValue = closed.entryPrice * closed.qty;
      await portfolioAgent.recordTradeClosed({
        channel: req.channel,
        tradeId: closed.id,
        instrument: closed.instrument,
        side: closed.type.includes("BUY") ? "LONG" : "SHORT",
        entryPrice: closed.entryPrice,
        exitPrice: req.exitPrice,
        quantity: closed.qty,
        entryTime: closed.openedAt,
        exitTime: closedAt,
        realizedPnl: pnl,
        realizedPnlPercent: grossEntryValue > 0 ? (pnl / grossEntryValue) * 100 : 0,
        exitReason: req.reason,
        exitTriggeredBy: "PA",
        duration: Math.round((closedAt - closed.openedAt) / 1000),
        pnlCategory: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
        timestamp: Date.now(),
      });
      log.info(
        `recordAutoExit ${req.reason} channel=${req.channel} trade=${req.tradeId} pnl=${pnl}`,
      );
    } catch (err: any) {
      log.error(`recordAutoExit failed channel=${req.channel} trade=${req.tradeId}: ${err?.message ?? err}`);
    }
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
  brokerId: string,
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
    brokerOrderId,
    brokerId,
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

/** TEA generates positionId as POS-{tradeId-without-T-prefix}. Reverse it. */
function tradeIdFromPositionId(positionId: string): string {
  if (positionId.startsWith("POS-")) return "T" + positionId.slice(4);
  return positionId; // caller passed the tradeId directly
}

/** Map TEA's exit-trade reason vocab to TradeRecord status values. */
function mapExitReasonToTradeStatus(reason: ExitTradeRequest["reason"]): TradeStatus {
  switch (reason) {
    case "TP_HIT":
      return "CLOSED_TP";
    case "SL_HIT":
      return "CLOSED_SL";
    case "EOD":
      return "CLOSED_EOD";
    default:
      return "CLOSED_MANUAL";
  }
}


export const tradeExecutor = new TradeExecutorAgent();
