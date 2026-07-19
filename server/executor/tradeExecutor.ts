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
import {
  notifyTradeExit,
  notifyGateRejection,
} from "../_core/tradeEventNotifier";
import { withTrade } from "../_core/correlationContext";
import { teaSubmitTradeTotal, teaExitTotal } from "../_core/metrics";
import { getAdapter, getActiveBroker, isChannelKillSwitchActive } from "../broker/brokerService";
import { getActiveBrokerConfig } from "../broker/brokerConfig";
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
import { recoveryEngine } from "./recoveryEngine";
import { resolveLotSize } from "./tradeResolution";
import { getScripBySecurityId } from "../broker/adapters/dhan/scripMaster";
import { getExecutorSettings } from "./settings";
import { getExitConfig } from "../portfolio/aiModeConfig";
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

const PAPER_CHANNELS: Channel[] = ["paper"];
const LIVE_CHANNELS: Channel[] = ["my-live", "ai-live"];

function _isPaperChannel(channel: Channel): boolean {
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
  private unsubscribeBrokerTslArm: (() => void) | null = null;
  private unsubscribeBrokerTpRatchet: (() => void) | null = null;

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
    // LIVE Super Orders: arm the gated TSL / ratchet the trailing TP at the
    // broker when tickHandler signals (both route through TEA's single-writer
    // leg-modify methods).
    this.unsubscribeBrokerTslArm = portfolioAgent.onBrokerTslArm((event) => {
      this.armBrokerTsl(event.channel, event.tradeId).catch((err) =>
        log.error(`armBrokerTsl failed: ${err?.message ?? err}`),
      );
    });
    this.unsubscribeBrokerTpRatchet = portfolioAgent.onBrokerTpRatchet((event) => {
      this.ratchetBrokerTp(event.channel, event.tradeId, event.targetPrice).catch((err) =>
        log.error(`ratchetBrokerTp failed: ${err?.message ?? err}`),
      );
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
    // Re-subscribe live LTP for trades left OPEN by the previous process —
    // their in-memory feed subscriptions died on exit, so otherwise they
    // freeze at entry price (only near-the-money strikes ride the
    // option-chain feed). Fire-and-forget; per-trade failures are contained.
    void this.resubscribeOpenTradeLtps();
    log.important("Started — Trade Executor Agent v1.3 (SEA + recovery online)");
  }

  /**
   * Startup recovery for the frozen-LTP bug: trades left OPEN by a prior
   * process lost their live-LTP subscription when it exited. Loop every
   * channel's open positions and re-subscribe each contract so its live
   * price streams to the browser again. Async, fire-and-forget from
   * start(); a failure on one channel/trade never blocks the rest.
   */
  async resubscribeOpenTradeLtps(): Promise<void> {
    const ALL_CHANNELS: Channel[] = [
      "paper", "ai-live", "my-live",
    ];
    let count = 0;
    for (const channel of ALL_CHANNELS) {
      let positions: TradeRecord[];
      try {
        // day_records source (not position_state, which lags / is empty
        // during the dual-write migration window) so we never miss a
        // displayed open trade.
        positions = await portfolioAgent.listOpenTrades(channel);
      } catch (err: any) {
        log.warn(`resubscribeOpenTradeLtps: listOpenTrades(${channel}) failed: ${err?.message ?? err}`);
        continue;
      }
      if (positions.length === 0) continue;
      const feedAdapter = (() => {
        // T87 Phase 1: ALL channels read live ticks from the primary market
        // feed (market data is account-independent; orders still route per
        // channel via getAdapter). ai-live no longer pulls ticks from the
        // secondary — one shared tick feed on the primary.
        try {
          return getActiveBroker();
        } catch {
          return null;
        }
      })();
      if (!feedAdapter) continue;
      for (const t of positions) {
        if (t.status !== "OPEN" || !t.contractSecurityId) continue;
        _subscribeContractLtp(feedAdapter, t.instrument, t.contractSecurityId, `for open trade ${t.id}`);
        count++;
      }
    }
    if (count > 0) {
      log.important(`Re-subscribed ${count} open-trade contract(s) to live LTP on startup`);
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.unsubscribeAutoExit) {
      this.unsubscribeAutoExit();
      this.unsubscribeAutoExit = null;
    }
    if (this.unsubscribeBrokerTslArm) {
      this.unsubscribeBrokerTslArm();
      this.unsubscribeBrokerTslArm = null;
    }
    if (this.unsubscribeBrokerTpRatchet) {
      this.unsubscribeBrokerTpRatchet();
      this.unsubscribeBrokerTpRatchet = null;
    }
    orderSync.stop();
    recoveryEngine.stop();
    log.important("Stopped");
  }

  // ── §4.1 Submit a trade ─────────────────────────────────────

  async submitTrade(req: SubmitTradeRequest): Promise<SubmitTradeResponse> {
    // Wrap the entire submission flow in a correlation scope so every
    // log line emitted (across kill-switch, discipline, broker, and PA
    // state writes) carries the executionId as `tradeId` for grep-ability.
    const resp = await withTrade(req.executionId, () => this._submitTradeImpl(req));
    teaSubmitTradeTotal.labels({
      channel: req.channel,
      status: resp.success ? "success" : "rejected",
    }).inc();
    return resp;
  }

  private async _submitTradeImpl(req: SubmitTradeRequest): Promise<SubmitTradeResponse> {
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

      // Pre-flight: Discipline cap-check (PA Phase 3 §10.1). Blocks orders
      // when the circuit breaker / cooldown / trade-limit / position-size
      // rules would be violated. Skipped silently if Discipline state can't
      // be read so a transient discipline-engine failure doesn't halt
      // trading — Phase 4 will harden this to fail-closed.
      const blockReason = req.skipDisciplinePreCheck ? null : await this.disciplinePreCheck(req);
      if (blockReason) {
        const resp = rejection(req.executionId, `Discipline blocked: ${blockReason}`);
        idempotencyStore.fail(req.executionId, resp.error!);
        await portfolioAgent.recordTradeRejected({
          channel: req.channel,
          trade: { instrument: req.instrument },
          reason: resp.error!,
          timestamp: Date.now(),
        });
        // T52: Telegram push for gate rejections (fire-and-forget).
        notifyGateRejection({
          channel: req.channel,
          instrument: req.instrument,
          qty: req.quantity,
          reason: resp.error!,
        });
        return resp;
      }

      // Pre-flight: validate the option leg against the authoritative scrip
      // master — single universal gate for every channel/broker (AI, manual,
      // paper, live, sandbox). securityId, expiry and lot size must all come
      // from the scrip master with NO fallback: if anything can't be resolved
      // there, the trade is rejected (and an alert logged), never placed with a
      // guessed value. Non-option trades (FUT / equity) are unaffected.
      const optionReject = validateOptionAgainstScrip(req);
      if (optionReject) {
        log.warn(`submitTrade scrip-validation reject channel=${req.channel}: ${optionReject}`);
        const resp = rejection(req.executionId, optionReject);
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
      ensureOptionLtpSubscription(req);

      // Decide Super Order vs plain order. Live channels get a broker-enforced
      // Super Order (entry + SL + TP) when the setting is on, the adapter
      // supports it, and both SL & TP are resolved. Everything else (paper,
      // sandbox, missing SL/TP, setting off) uses the plain order path unchanged.
      const activeCfg = await getActiveBrokerConfig();
      const useSuperOrder =
        isLiveChannel(req.channel) &&
        (activeCfg?.settings?.useSuperOrderForLive ?? false) &&
        typeof adapter.placeSuperOrder === "function" &&
        !!(orderParams.stopLoss && orderParams.stopLoss > 0) &&
        !!(orderParams.target && orderParams.target > 0);

      // Place the order — this is the SINGLE point in the codebase that calls
      // broker.placeOrder / placeSuperOrder. Spec §3 rule 1 (Single Execution Point).
      let orderResult: OrderResult;
      let superOrderId: string | null = null;
      try {
        if (useSuperOrder) {
          const sr = await adapter.placeSuperOrder!(orderParams);
          superOrderId = sr.orderId; // entry/anchor id; also used as brokerOrderId
          orderResult = { orderId: sr.orderId, status: sr.status, message: sr.message, timestamp: sr.timestamp };
          log.info(`submitTrade placed SUPER order channel=${req.channel} order=${sr.orderId}`);
        } else {
          orderResult = await adapter.placeOrder(orderParams);
        }
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
        superOrderId,
      );

      await portfolioAgent.appendTrade(req.channel, trade);
      await portfolioAgent.recordTradePlaced({
        channel: req.channel,
        trade,
        timestamp: Date.now(),
      });

      // Race guard: a live order can fill within milliseconds of placement, so
      // its order_alert WS event may buffer either just BEFORE or just AFTER this
      // persist — the fill's cross-channel match is async and can start before the
      // trade exists yet finish after it's written. Replay immediately AND on a
      // short schedule so the buffered fill is applied whichever side of the
      // persist it lands on, promoting the trade PENDING → OPEN at the real fill
      // instead of being stranded. Idempotent: replayBufferedFills drains the
      // buffer first, so once the trade matches, later attempts are no-ops.
      const orderIdForReplay = orderResult.orderId;
      await portfolioAgent.replayBufferedFills(orderIdForReplay);
      for (const delayMs of [750, 2500]) {
        const t = setTimeout(() => {
          void portfolioAgent.replayBufferedFills(orderIdForReplay);
        }, delayMs);
        if (typeof t.unref === "function") t.unref();
      }

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
      // Fill notifications intentionally removed (operator wants only
      // profit/loss exit alerts + per-exchange close summary, no entry spam).
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
        // Prefer the human-readable reasons ("NSE market is closed") over the
        // bare rule keys ("timeWindow"); fall back to keys if absent.
        const reasons = result.blockReasons?.length ? result.blockReasons : result.blockedBy;
        return reasons.join("; ");
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

      // SL/TP arrive under two field-name spellings: the formal §4.2 API
      // uses stopLoss/takeProfit; the UI updateTrade adapter sends the
      // stopLossPrice/targetPrice aliases. Coalesce both up front so every
      // path below (broker leg + local record) reads the same value.
      // `!== undefined` (not `??`) preserves an explicit null = "clear it".
      const slMod =
        req.modifications.stopLossPrice !== undefined
          ? req.modifications.stopLossPrice
          : req.modifications.stopLoss;
      const tpMod =
        req.modifications.targetPrice !== undefined
          ? req.modifications.targetPrice
          : req.modifications.takeProfit;

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
            triggerPrice: slMod ?? undefined,
            price: tpMod ?? undefined,
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
              stopLossPrice: slMod ?? null,
              targetPrice: tpMod ?? null,
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
        stopLossPrice: slMod,
        targetPrice: tpMod,
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
      // B1 (correct-after-close): the reverse (exit) order id, captured so the
      // exit fill's avgTradedPrice can correct the realized price after we close
      // the position optimistically below.
      let exitBrokerOrderId: string | null = null;
      if (isLiveChannel(channel) && trade.brokerOrderId) {
        const adapter = getAdapter(channel);

        // Super Order: cancel the resting target/stop legs FIRST so neither can
        // fire while we flatten. Best-effort (non-fatal) — we still place the
        // reverse order below to guarantee the position is flat regardless of
        // Dhan's cancel-vs-squareoff semantics. NOTE: exact Dhan behavior on
        // cancelSuperOrder needs live verification (Super Orders are live-only).
        if (trade.superOrderId && typeof adapter.cancelSuperOrder === "function") {
          try {
            await adapter.cancelSuperOrder(trade.superOrderId);
            log.info(`exitTrade cancelled super-order legs channel=${channel} trade=${tradeId} super=${trade.superOrderId}`);
          } catch (e: any) {
            log.warn(`exitTrade cancelSuperOrder failed (continuing to flatten) trade=${tradeId}: ${e?.message ?? e}`);
          }
        }

        const exitOrderType = req.reason === "DISCIPLINE_EXIT" ? "MARKET" : req.exitType;
        const exitOptionType: OrderParams["optionType"] = trade.type.startsWith("CALL")
          ? "CE"
          : trade.type.startsWith("PUT")
          ? "PE"
          : "FUT";

        const exitParams: OrderParams = {
          // Exit by the trade's stored numeric contract securityId. Options can
          // ONLY be exited this way — the underlying name ("NIFTY 50") never
          // resolves. Futures resolve by symbol, so they fall back to the name.
          instrument: trade.contractSecurityId ?? trade.instrument,
          exchange: isEquityTradeRecord(trade) ? "NSE_EQ" : resolveExchange(trade.instrument),
          transactionType: trade.type.includes("BUY") ? "SELL" : "BUY",
          optionType: exitOptionType,
          strike: trade.strike ?? 0,
          expiry: trade.expiry ?? "",
          quantity: trade.qty,
          price: exitPrice,
          orderType: exitOrderType,
          // Square off on the same product the entry used (CNC delivery must sell
          // CNC). Options + legacy trades have no stored product → INTRADAY.
          productType: (trade.productType as "INTRADAY" | "CNC" | undefined) ?? "INTRADAY",
          tag: `EXIT-${trade.id}`,
        };
        try {
          // An option with no contractSecurityId cannot be exited — fail through
          // the same BROKER_DESYNC path so the position stays open locally and is
          // flagged for manual reconciliation rather than silently closed.
          if ((exitOptionType === "CE" || exitOptionType === "PE") && !trade.contractSecurityId) {
            throw new Error(
              `option ${trade.instrument} ${trade.strike ?? "?"} ${exitOptionType} has no contractSecurityId`,
            );
          }
          const result = await adapter.placeOrder(exitParams);
          exitBrokerOrderId = result.orderId ?? null;
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

      // Local close — single-writer entry point. Status is always
      // "CLOSED"; the reason flows through req.reason → exitReason on
      // the trade (also set by recordTradeClosed below).
      const { trade: closed, pnl, charges } = await portfolioAgent.closeTrade(
        channel,
        tradeId,
        exitPrice,
        req.reason,
        exitBrokerOrderId,
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

      // Release this trade's LTP subscription (refCount-aware in
      // SubscriptionManager — the WS unsubscribe only fires once the LAST
      // consumer of this contract drops it, so other open trades on the
      // same option keep streaming). Mirrors ensureOptionLtpSubscription's
      // routing: paper channels released via the primary live adapter,
      // live channels via the channel's own adapter.
      releaseOptionLtpSubscription(closed.contractSecurityId, closed.instrument, isEquityTradeRecord(closed));

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
      // T52: Telegram push for trade exits (fire-and-forget).
      notifyTradeExit({
        channel,
        instrument: closed.instrument,
        type: closed.type,
        strike: closed.strike ?? null,
        qty: closed.qty,
        entryPrice: closed.entryPrice,
        exitPrice,
        realizedPnl: pnl,
        realizedPnlPercent: grossEntryValue > 0 ? (pnl / grossEntryValue) * 100 : 0,
        reason: req.reason,
        triggeredBy: req.triggeredBy,
        durationSeconds: Math.round((closedAt - closed.openedAt) / 1000),
        cohort: closed.cohort ?? null,
        exitStrategy: closed.exitStrategy,
      });
      teaExitTotal.labels({ channel, trigger: req.reason }).inc();
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
      const { trade: closed, pnl } = await portfolioAgent.closeTrade(
        req.channel,
        req.tradeId,
        req.exitPrice,
        req.reason,
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
      // Release this contract's WS subscription (refCount-safe — see
      // exitTrade for the same call pattern).
      releaseOptionLtpSubscription(closed.contractSecurityId, closed.instrument, isEquityTradeRecord(closed));

      // TEMP DIAGNOSTIC ([XSYNC] exit-sync): the trade is now actually closed.
      log.important(
        `[XSYNC-SVR] CLOSED ${req.reason} channel=${req.channel} trade=${req.tradeId} exit=${req.exitPrice} pnl=${pnl}`,
      );
      // T52: Telegram push for PA-triggered auto-exits (TP/SL/DISCIPLINE_EXIT/EOD).
      notifyTradeExit({
        channel: req.channel,
        instrument: closed.instrument,
        type: closed.type,
        strike: closed.strike ?? null,
        qty: closed.qty,
        entryPrice: closed.entryPrice,
        exitPrice: req.exitPrice,
        realizedPnl: pnl,
        realizedPnlPercent: grossEntryValue > 0 ? (pnl / grossEntryValue) * 100 : 0,
        reason: req.reason,
        triggeredBy: "PA",
        durationSeconds: Math.round((closedAt - closed.openedAt) / 1000),
        cohort: closed.cohort ?? null,
        exitStrategy: closed.exitStrategy,
      });
      teaExitTotal.labels({ channel: req.channel, trigger: req.reason }).inc();
    } catch (err: any) {
      log.error(`recordAutoExit failed channel=${req.channel} trade=${req.tradeId}: ${err?.message ?? err}`);
    }
  }

  /**
   * LIVE Super Orders — arm the gated trailing stop at the broker (exactly once).
   * Triggered by tickHandler's gate/hold detection (brokerTslArm event). Moves
   * the STOP_LOSS_LEG to ~breakeven and sets a native trailingJump so Dhan then
   * trails the stop with zero further API calls. Single-writer: only TEA calls
   * the broker + persists. No-op for non-super / closed / already-armed trades.
   */
  async armBrokerTsl(channel: Channel, tradeId: string): Promise<void> {
    try {
      const day = await portfolioAgent.ensureCurrentDay(channel);
      const trade = day.trades.find((t) => t.id === tradeId);
      if (!trade || trade.status !== "OPEN" || !trade.superOrderId) return;
      if (trade.tslArmedOnBroker) return; // arm exactly once
      if ((trade.legModifyCount ?? 0) >= BROKER_MODIFY_CAP - BROKER_MODIFY_SAFETY_MARGIN) return;
      const adapter = getAdapter(channel);
      if (typeof adapter.modifySuperOrderLeg !== "function") return;

      const cfg = await getActiveBrokerConfig();
      const trailingStopPercent = cfg?.settings?.trailingStopPercent ?? 2.0;
      const breakeven = trade.breakevenPrice ?? trade.entryPrice;
      // Lock out the loss (stop ≈ breakeven) and let Dhan trail by a fixed rupee
      // jump (≈ trailingStopPercent% of entry) from here — no per-tick calls.
      const stopLossPrice = breakeven;
      const trailingJump = Math.max(0.05, (trailingStopPercent / 100) * trade.entryPrice);
      try {
        await adapter.modifySuperOrderLeg(trade.superOrderId, "STOP_LOSS_LEG", { stopLossPrice, trailingJump });
      } catch (err: any) {
        await portfolioAgent
          .markTradeDesync(channel, tradeId, {
            kind: "MODIFY",
            reason: `TSL arm failed: ${err?.message ?? err}`,
            timestamp: Date.now(),
            attempted: { stopLossPrice },
          })
          .catch(() => undefined);
        log.error(`armBrokerTsl modify failed channel=${channel} trade=${tradeId}: ${err?.message ?? err}`);
        return;
      }
      await portfolioAgent.recordBrokerLegModify(channel, tradeId, {
        tslArmedOnBroker: true,
        stopLossPrice,
        bumpModifyCount: true,
      });
      log.important(`[XSYNC-SVR] BROKER-TSL-ARMED ${channel} trade=${tradeId} stop=${stopLossPrice} jump=${trailingJump}`);
    } catch (err: any) {
      log.error(`armBrokerTsl failed channel=${channel} trade=${tradeId}: ${err?.message ?? err}`);
    }
  }

  /**
   * LIVE Super Orders — ratchet the trailing take-profit at the broker. Triggered
   * (throttled) by tickHandler's brokerTpRatchet event. Applies its own step
   * threshold + time throttle + the per-order modify-cap budget, then modifies
   * the TARGET_LEG. Single-writer + favorable-direction-only.
   */
  async ratchetBrokerTp(channel: Channel, tradeId: string, candidateTp: number): Promise<void> {
    try {
      const day = await portfolioAgent.ensureCurrentDay(channel);
      const trade = day.trades.find((t) => t.id === tradeId);
      if (!trade || trade.status !== "OPEN" || !trade.superOrderId || trade.targetPrice === null) return;
      if ((trade.legModifyCount ?? 0) >= BROKER_MODIFY_CAP - BROKER_MODIFY_SAFETY_MARGIN) return;

      const isBuy = trade.type.includes("BUY");
      const better = isBuy ? candidateTp > trade.targetPrice : candidateTp < trade.targetPrice;
      if (!better) return;
      // Step threshold — ignore tiny moves so we don't burn the modify budget.
      const ref = trade.lastBrokerTpPrice ?? trade.targetPrice;
      const step = (TP_BROKER_STEP_PERCENT / 100) * trade.entryPrice;
      if (Math.abs(candidateTp - ref) < step) return;
      // Time throttle.
      if (trade.lastBrokerTpModifyAt && Date.now() - trade.lastBrokerTpModifyAt < TP_BROKER_MIN_INTERVAL_MS) return;

      const adapter = getAdapter(channel);
      if (typeof adapter.modifySuperOrderLeg !== "function") return;
      try {
        await adapter.modifySuperOrderLeg(trade.superOrderId, "TARGET_LEG", { targetPrice: candidateTp });
      } catch (err: any) {
        await portfolioAgent
          .markTradeDesync(channel, tradeId, {
            kind: "MODIFY",
            reason: `TP ratchet failed: ${err?.message ?? err}`,
            timestamp: Date.now(),
            attempted: { targetPrice: candidateTp },
          })
          .catch(() => undefined);
        log.error(`ratchetBrokerTp modify failed channel=${channel} trade=${tradeId}: ${err?.message ?? err}`);
        return;
      }
      await portfolioAgent.recordBrokerLegModify(channel, tradeId, {
        targetPrice: candidateTp,
        lastBrokerTpPrice: candidateTp,
        lastBrokerTpModifyAt: Date.now(),
        bumpModifyCount: true,
      });
      log.info(`[XSYNC-SVR] BROKER-TP-RATCHET ${channel} trade=${tradeId} tp→${candidateTp}`);
    } catch (err: any) {
      log.error(`ratchetBrokerTp failed channel=${channel} trade=${tradeId}: ${err?.message ?? err}`);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────

// Dhan caps Super Order modifications at 25/order (DHAN_RATE_LIMITS.modifyPerOrder).
// Stop short of it, reserving margin so a long TP-ratchet trend can't starve the
// one-time TSL arm.
const BROKER_MODIFY_CAP = 25;
const BROKER_MODIFY_SAFETY_MARGIN = 3;
// TP-ratchet throttle: min favorable move (% of entry) + min time between modifies.
const TP_BROKER_STEP_PERCENT = 1.0;
const TP_BROKER_MIN_INTERVAL_MS = 30_000;

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

/**
 * A cash-equity (stock) trade record: a plain BUY/SELL with no option strike.
 * Options always carry a strike + CALL_/PUT_ type, so this never matches them.
 * Used to route the exit + LTP feed to NSE_EQ for stored trades (which have no
 * `assetClass` on the request shape).
 */
function isEquityTradeRecord(t: { strike?: number | null; type?: string }): boolean {
  return t.strike == null && (t.type === "BUY" || t.type === "SELL");
}

/** WS feed segment for a stored trade: NSE_EQ for stocks, else option routing. */
function feedSegmentForTrade(t: { instrument: string; strike?: number | null; type?: string }): ExchangeSegment {
  if (isEquityTradeRecord(t)) return "NSE_EQ";
  return resolveExchange(t.instrument) === "MCX_COMM" ? "MCX_COMM" : "NSE_FNO";
}

function resolveOptionType(req: SubmitTradeRequest): OptionType {
  if (req.optionType === "CE") return "CE";
  if (req.optionType === "PE") return "PE";
  return "FUT";
}

function resolveTransactionType(direction: "BUY" | "SELL"): TransactionType {
  return direction === "BUY" ? "BUY" : "SELL";
}

/**
 * Validate an option trade against the authoritative scrip master. Returns a
 * rejection reason string, or null if the option is valid (or the trade is not
 * an option). NO fallback: securityId, expiry and lot size must all resolve from
 * the scrip master, and the quantity must be a whole lot multiple — otherwise
 * the trade is blocked. Covers every channel via submitTrade.
 */
function validateOptionAgainstScrip(req: SubmitTradeRequest): string | null {
  if (req.optionType !== "CE" && req.optionType !== "PE") return null;
  const label = `${req.instrument} ${req.strike ?? "?"} ${req.optionType} ${req.expiry || "(no expiry)"}`;

  // MOCK toggle: the mock adapter mints synthetic "MOCK-…" securityIds and
  // resolves them against its OWN scrip list, not the real Dhan scrip master.
  // Validating those against the real master would always (wrongly) reject —
  // so exempt them. Real ids (paper-on-live-data and all live channels) still
  // pass through the gate below.
  if (req.contractSecurityId?.startsWith("MOCK-")) return null;

  if (!req.contractSecurityId) {
    return `Option ${label} has no resolved contract securityId — the option chain returned no match. Check the strike and expiry.`;
  }
  const rec = getScripBySecurityId(req.contractSecurityId);
  if (!rec) {
    return `Option ${label}: securityId ${req.contractSecurityId} is not in the scrip master (stale or not loaded). Refresh the scrip master.`;
  }
  if (rec.optionType && rec.optionType !== req.optionType) {
    return `Option ${label}: securityId ${req.contractSecurityId} is a ${rec.optionType} in the scrip master, not ${req.optionType}.`;
  }
  const reqExpiry = (req.expiry ?? "").split(" ")[0].split("T")[0];
  if (reqExpiry && rec.expiryDateOnly && reqExpiry !== rec.expiryDateOnly) {
    return `Option ${label}: expiry ${reqExpiry} does not match the scrip master (${rec.expiryDateOnly}) for securityId ${req.contractSecurityId}.`;
  }
  if (!rec.lotSize || rec.lotSize <= 0) {
    return `Option ${label}: scrip master has no lot size for securityId ${req.contractSecurityId}.`;
  }
  if (req.quantity <= 0 || req.quantity % rec.lotSize !== 0) {
    return `Option ${label}: quantity ${req.quantity} is not a whole multiple of the lot size ${rec.lotSize} (from scrip master).`;
  }
  return null;
}

function mapToOrderParams(req: SubmitTradeRequest): OrderParams {
  return {
    // Prefer the contract securityId resolved upstream (router resolveContract
    // for UI option trades, or the signal path). The broker needs a numeric
    // securityId; sending the underlying display name ("NIFTY 50") makes the
    // adapter's scrip-master lookup miss and the order get rejected. Fall back
    // to the name only when no contract id is present (e.g. futures-by-symbol
    // that the adapter itself resolves via scrip master).
    instrument: req.contractSecurityId ?? req.instrument,
    exchange: req.assetClass === "equity" ? "NSE_EQ" : resolveExchange(req.instrument),
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

/**
 * T84 — resolve the open-time exit-control flags for a new trade.
 *
 * On **AI paper** (the strategy race — the paper book, `source === "ai"`) the
 * pluggable exit STRATEGY owns the trade end-to-end: Sprint runs full auto
 * TP/SL/TSL with trailing ON (so both the TP and the stop trail the winner) and
 * STILL exits on the MA reversal EXIT (the aiSignal handler doesn't require
 * manualExitOnly). Runway/Anchor run on their own price engine — these flags
 * don't gate them. So no cohort special-casing on the race book.
 *
 * T85: the ATTACHED EXIT STRATEGY governs the trade end-to-end, on EVERY channel.
 * MA-Signal used to suppress SL/TP/age so it could "ride until its own reversal
 * EXIT" — that was the right default back when no strategy owned the exit. A
 * strategy always owns it now, so the suppression is gone: MA's reversal EXIT
 * still fires, it just isn't the ONLY exit any more.
 *
 * TSL mode is SEEDED from the shared Sprint config's trailing switch (the caller
 * passes it); the per-trade toggle rules after open. Pure + exported for testing.
 */
export function resolveOpenExitFlags(
  _channel: string,
  _cohort: string | null | undefined,
  trailingEnabled: boolean,
  _source?: "ai" | "my",
): {
  manualExitOnly: boolean;
  stopLossDisabled: boolean;
  targetDisabled: boolean;
  tslMode: "auto" | "manual";
} {
  return {
    manualExitOnly: false,
    stopLossDisabled: false,
    targetDisabled: false,
    tslMode: trailingEnabled ? "auto" : "manual",
  };
}

function buildTradeRecord(
  req: SubmitTradeRequest,
  tradeId: string,
  brokerOrderId: string,
  brokerId: string,
  status: TradeStatus,
  superOrderId?: string | null,
): TradeRecord {
  const tradeType: TradeRecord["type"] =
    req.optionType === "CE"
      ? req.direction === "BUY" ? "CALL_BUY" : "CALL_SELL"
      : req.optionType === "PE"
      ? req.direction === "BUY" ? "PUT_BUY" : "PUT_SELL"
      : req.direction === "BUY" ? "BUY" : "SELL";

  // AI-vs-My attribution (T87): derive from the placement origin, NOT the channel
  // — on the shared `paper` book the channel can't tell AI from manual.
  const source: "ai" | "my" = req.origin === "AI" ? "ai" : "my";

  // T85: the attached exit strategy drives every book; trailing seeds from the
  // shared Sprint config (the single source of trailing truth).
  const sprintCfg = getExitConfig().sprint;
  const exitFlags = resolveOpenExitFlags(
    req.channel,
    req.cohort,
    sprintCfg.trailingStopEnabled,
    source,
  );

  // T85: Sprint needs a concrete stop + target to work at all — its trailing is
  // skipped outright when stopLossPrice is null. Some cohorts (MA-Signal) emit a
  // signal with sl/tp = null because their native behaviour is "ride until the
  // reversal EXIT". When Sprint is the attached strategy and the signal supplied
  // neither, seed both from the shared Sprint config so the STRATEGY's rules
  // apply. Runway/Anchor derive their own stop from entry on the first tick, so
  // they're deliberately left alone.
  const strategy = req.exitStrategy ?? "sprint";
  const isLong = req.direction === "BUY";
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const seedFor = (pct: number, favourable: boolean): number | null =>
    strategy === "sprint" && req.entryPrice > 0
      ? round2(req.entryPrice * (1 + (isLong === favourable ? pct : -pct) / 100))
      : null;
  const stopLossPrice = req.stopLoss ?? seedFor(sprintCfg.defaultSL, false);
  const targetPrice = req.takeProfit ?? seedFor(sprintCfg.defaultTP, true);

  return {
    id: tradeId,
    instrument: req.instrument,
    type: tradeType,
    strike: req.strike ?? null,
    expiry: req.expiry ?? null,
    contractSecurityId: req.contractSecurityId ?? null,
    // Stocks persist their product type (MIS→INTRADAY | CNC) so the exit squares
    // off on the same product. Options leave it undefined (exit defaults INTRADAY).
    productType:
      req.assetClass === "equity" ? (req.productType === "CNC" ? "CNC" : "INTRADAY") : undefined,
    entryPrice: req.entryPrice,
    // Paper channels "fill" at the snapshot price we sent (mock has no real
    // fill), which can lag the live option price and open the trade in profit.
    // Mark the entry pending so tickHandler overwrites it with the first live
    // tick for the contract. Live trades get the true fill from the broker
    // event (applyBrokerOrderEvent), so they start non-pending.
    entryPending: req.channel.endsWith("-paper"),
    exitPrice: null,
    ltp: req.entryPrice,
    qty: req.quantity,
    capitalPercent: req.capitalPercent ?? 0,
    cohort: req.cohort ?? null,
    signalSeq: req.signalSeq ?? null,
    source,
    pnl: 0,
    unrealizedPnl: 0,
    charges: 0,
    chargesBreakdown: [],
    status,
    targetPrice,
    stopLossPrice,
    // Initial (model) SL distance in rupees — the fixed gap "signal"-mode
    // trailing keeps below the peak. Captured now; the first-tick-fill shift
    // moves entry + SL together so this distance stays valid.
    slDistance:
      stopLossPrice != null && req.entryPrice > 0
        ? Math.abs(req.entryPrice - stopLossPrice)
        : undefined,
    // Per-trade risk overrides start at their defaults (SL + TP active). TSL
    // mode is SEEDED from the broker-wide trailing switch — on → "auto" (trails),
    // off → "manual" (frozen) — after which the per-trade toggle rules regardless
    // of the global switch. originalStopLossPrice snapshots the stop at open so
    // the SL-disabled gate can tell whether the stop has since moved.
    manualExitOnly: exitFlags.manualExitOnly,
    // Pluggable exit strategy (T84). Defaults to "sprint" = today's behaviour;
    // the RCA twin fan-out overrides per-twin (sprint/runway/anchor).
    exitStrategy: req.exitStrategy ?? "sprint",
    stopLossDisabled: exitFlags.stopLossDisabled,
    targetDisabled: exitFlags.targetDisabled,
    tslMode: exitFlags.tslMode,
    originalStopLossPrice: stopLossPrice,
    // The SIGNAL's target (null when it sent none) — the stable input the staged
    // strategies read, so their own per-tick target output never feeds back in.
    originalTargetPrice: req.takeProfit ?? null,
    // Callers resolve the trailing-stop default before submitting (the UI
    // adapter folds in the broker-wide trailingStopEnabled setting). When a
    // formal caller omits it entirely, default to off.
    trailingStopEnabled: req.trailingStopLoss?.enabled ?? false,
    brokerOrderId,
    brokerId,
    superOrderId: superOrderId ?? null,
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
 * Ensure the option contract is on the live Dhan WS subscription so real
 * ticks flow into tickBus.
 *
 * - Live channels: subscribe on the channel's own adapter (dhanLive for
 *   my-live/testing-live, dhanAiData for ai-live).
 * - Paper channels (my-paper, ai-paper): subscribe via
 *   the primary Dhan adapter (dhanLive) so paper trades read the SAME
 *   live LTP the UI already sees. The channel's mock adapter otherwise
 *   emits synthetic ticks that never reach the browser bus.
 *
 * Failures are non-fatal — the trade still places, but LTP may not stream
 * until the user subscribes manually.
 *
 * TODO: matching unsubscribe on trade close is blocked on SubscriptionManager
 * gaining refcounting — today a bare unsubscribe would kill the feed for any
 * other open trade on the same contract.
 */
/**
 * Core LTP-subscribe shared by the place-trade path and the startup
 * re-subscribe. The caller passes the already-resolved feed adapter (live
 * channel → its own adapter; paper channel → the active live Dhan adapter
 * so paper reads real LTP). Failures are non-fatal.
 */
function _subscribeContractLtp(
  feedAdapter: BrokerAdapter | null | undefined,
  instrument: string,
  contractSecurityId: string,
  label: string,
  isEquity = false,
): void {
  if (!feedAdapter?.subscribeLTP) return;
  try {
    const wsExchange = isEquity
      ? "NSE_EQ"
      : resolveExchange(instrument) === "MCX_COMM" ? "MCX_COMM" : "NSE_FNO";
    feedAdapter.subscribeLTP(
      [{ exchange: wsExchange as any, securityId: contractSecurityId, mode: "full" }] as any,
      (tick) => tickBus.emitTick(tick),
    );
    log.debug(
      `Subscribed option LTP: ${wsExchange}:${contractSecurityId} ${label} via ${feedAdapter.brokerId}`,
    );
  } catch (err: any) {
    log.warn(`subscribeLTP failed for ${contractSecurityId}: ${err?.message ?? err}`);
  }
}

function ensureOptionLtpSubscription(
  req: SubmitTradeRequest,
): void {
  if (!req.contractSecurityId) return;
  // T87 Phase 1: ticks always come from the primary market feed
  // (getActiveBroker), live channels included. Orders still route via
  // getAdapter(req.channel) at the call site.
  const feedAdapter = getActiveBroker();
  _subscribeContractLtp(
    feedAdapter,
    req.instrument,
    req.contractSecurityId,
    `for trade ${req.executionId}`,
    req.assetClass === "equity",
  );
}

/**
 * Mirror of ensureOptionLtpSubscription for the trade-close path. The
 * SubscriptionManager's refCount ensures that other open trades / forms
 * still subscribed to the same contract keep their feed; the WS
 * unsubscribe only fires when the last consumer releases.
 *
 * Failures are non-fatal — the trade is already closed; a stale WS
 * subscription is at worst a minor inefficiency.
 */
function releaseOptionLtpSubscription(
  contractSecurityId: string | null | undefined,
  instrument: string,
  isEquity = false,
): void {
  if (!contractSecurityId) return;
  // T87 Phase 1: unsubscribe from the same primary market feed we subscribed on.
  const feedAdapter = (() => {
    try { return getActiveBroker(); } catch { return null; }
  })();
  if (!feedAdapter?.unsubscribeLTP) return;
  try {
    const wsExchange = isEquity
      ? "NSE_EQ"
      : resolveExchange(instrument) === "MCX_COMM" ? "MCX_COMM" : "NSE_FNO";
    feedAdapter.unsubscribeLTP(
      [{ exchange: wsExchange as any, securityId: contractSecurityId }] as any,
    );
    log.debug(
      `Released option LTP: ${wsExchange}:${contractSecurityId} via ${feedAdapter.brokerId}`,
    );
  } catch (err: any) {
    log.warn(`unsubscribeLTP failed for ${contractSecurityId}: ${err?.message ?? err}`);
  }
}

/**
 * TEA generates positionId as POS-{tradeId-with-leading-"T"-stripped}. Reverse it.
 *
 * The encode strips a leading "T" from app trade ids ("T1784…" → "1784…"), which
 * come back digit-first and need the "T" restored. Adopted ids ("EXT-322…") never
 * start with "T", so the encode strips nothing and the decode must NOT prepend one
 * — otherwise "POS-EXT-322…" wrongly becomes "TEXT-322…" and the exit fails to find
 * the trade (the bug that broke exiting externally-adopted positions).
 */
function tradeIdFromPositionId(positionId: string): string {
  if (!positionId.startsWith("POS-")) return positionId; // caller passed the tradeId directly
  const rest = positionId.slice(4);
  return /^\d/.test(rest) ? "T" + rest : rest;
}

export const tradeExecutor = new TradeExecutorAgent();
