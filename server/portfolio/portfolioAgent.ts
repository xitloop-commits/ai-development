/**
 * Portfolio Agent — single source of truth for portfolio state.
 *
 * Implements PortfolioAgent_Spec_v1.1 §6 + §7. Owns:
 *   - Open + closed position lifecycle
 *   - Capital pool balances (Trading + Reserve, 75/25 split)
 *   - Mark-to-market valuation (delegated to tickHandler)
 *   - Realized + unrealized P&L tracking
 *   - 250-day compounding (delegated to compounding.ts)
 *   - Trade outcome recording with `exitTriggeredBy` audit trail
 *
 * In Phase 1 the underlying storage (legacy `capital_state` and `day_records`
 * collections) is reused via state.ts CRUD helpers — PA is the API/behaviour
 * boundary, storage is implementation detail. Phase 2 (separate PR) will
 * introduce PA-owned schemas (portfolio_state, position_state, etc.) per
 * spec §6.3 and migrate the underlying collection names accordingly.
 */

import { createLogger } from "../broker/logger";
import {
  type Channel,
  type CapitalState,
  type DayRecord,
  type TradeRecord,
  channelToSource,
  getCapitalState,
  getDayRecord,
  getDayRecords,
  upsertDayRecord,
  patchTradeInDay,
  dayAggregateFields,
  updateCapitalState,
} from "./state";
import { tickHandler } from "./tickHandler";
import type { AutoExitEvent, BrokerTslArmEvent, BrokerTpRatchetEvent } from "./tickHandler";
import {
  upsertPosition,
  getOpenPositions,
  appendEvent,
  upsertMetrics,
  getMetrics,
  type PositionStateDoc,
  type PortfolioMetricsDoc,
  type PortfolioEventType,
} from "./storage";
import {
  calculateAvailableCapital,
  calculateQuarterlyProjection,
  createDayRecord,
  recalculateDayAggregates,
  checkSessionReset,
  resetSession,
  checkDayCompletion,
  checkCombinedDayCompletion,
  completeDayIndex,
  calculateGiftDays,
  processClawback,
} from "./compounding";
import { recordCapitalEvent } from "./capitalLedger";
import { sprintOpeningLevels } from "./aiModeConfig";
import { calculateTradeCharges, estimateSingleLegCharges } from "./charges";
import type { ChargeRate } from "./charges";
import { chargeRatesForTrade } from "../../shared/chargesEngine";
import { getUserSettings } from "../userSettings";
import { getActiveBrokerConfig } from "../broker/brokerConfig";
import { getActiveRunId, appendTrade as appendTradeToRun, getRun, updateRunTrades } from "../replay/replayRuns";
import { disciplineAgent } from "../discipline";
import { notifyOrderRejected } from "../_core/tradeEventNotifier";
import { getScripBySecurityId } from "../broker/adapters/dhan/scripMaster";
import type {
  PortfolioSnapshot,
  TradeClosedRequest,
  TradeClosedResponse,
  TradePlacedEvent,
  TradeRejectedEvent,
  RiskSignals,
  PortfolioMetrics,
  DailyPnlReport,
  BrokerOrderEvent,
  BrokerOrderEventResult,
} from "./types";

const log = createLogger("PA", "Agent");

// ─── Helpers ────────────────────────────────────────────────────

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function snapshotFromState(
  channel: Channel,
  state: CapitalState,
  currentDay: DayRecord | null
): PortfolioSnapshot {
  const trades = currentDay?.trades ?? [];
  const openTrades = trades.filter((t) => t.status === "OPEN");

  const openExposure = openTrades.reduce((sum, t) => sum + t.entryPrice * t.qty, 0);
  const openMargin = openExposure;
  const unrealizedPnl = openTrades.reduce((sum, t) => sum + (t.unrealizedPnl ?? 0), 0);
  const availableCapital = calculateAvailableCapital(state.tradingPool, openMargin);

  const largest = openTrades.reduce(
    (max, t) => Math.max(max, t.entryPrice * t.qty),
    0,
  );
  const positionConcentration = openExposure > 0 ? largest / openExposure : 0;

  const todayPnl = currentDay?.totalPnl ?? 0;
  const todayTarget = currentDay?.targetAmount ?? 0;
  const openingCapital = state.tradingPool + state.reservePool - todayPnl;
  const dailyRealizedPnl = todayPnl;
  const dailyRealizedPnlPercent =
    openingCapital > 0 ? (dailyRealizedPnl / openingCapital) * 100 : 0;

  const daysElapsed = Math.max(0, Math.floor((Date.now() - state.createdAt) / 86400000));
  const quarterly = calculateQuarterlyProjection(
    state.tradingPool,
    state.reservePool,
    state.currentDayIndex,
    daysElapsed,
    state.initialFunding,
    state.targetPercent,
  );

  return {
    channel,
    currentCapital: state.tradingPool + state.reservePool,
    availableCapital,
    tradingPool: state.tradingPool,
    reservePool: state.reservePool,
    initialFunding: state.initialFunding,
    openExposure,
    openMargin,
    openPositionCount: openTrades.length,
    positionConcentration,
    unrealizedPnl,
    realizedPnl: state.cumulativePnl,
    dailyRealizedPnl,
    dailyRealizedPnlPercent,
    drawdownPercent: state.drawdownPercent ?? 0,
    winLossStreak: 0,   // TODO — Phase 3 sources this from Discipline streak counters
    currentDayIndex: state.currentDayIndex,
    targetPercent: state.targetPercent,
    todayTarget,
    todayPnl,
    netWorth: Math.round((state.tradingPool + state.reservePool) * 100) / 100,
    quarterlyProjection: quarterly,
    lastUpdated: state.updatedAt,
  };
}

// ─── PortfolioAgent class ───────────────────────────────────────

class PortfolioAgentImpl {
  private started = false;

  /**
   * Early app-fill buffer (race guard). An app-placed order can fill so fast
   * that its order_alert WS event beats the submitTrade DB persist — the trade
   * isn't in any day record yet, so no reconciler branch matches it. Rather than
   * adopt it (which would create a bogus EXT- duplicate + strand the real trade
   * as PENDING), buffer the event here keyed by broker orderId; submitTrade calls
   * `replayBufferedFills(orderId)` the moment its trade is persisted. Keyed by
   * orderId, timestamped so an orphan (submitTrade threw after placeOrder) is
   * purged after a grace window instead of leaking. */
  private earlyFills = new Map<string, { event: BrokerOrderEvent; at: number }[]>();
  private static readonly EARLY_FILL_TTL_MS = 60_000;

  /**
   * Lifecycle — called from server startup. Boots the internal tickHandler
   * (MTM + auto-exit on TP/SL) under PA's ownership. Idempotent.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    tickHandler.start();
    log.important("Started — Portfolio Agent v1.2 (Phase 1)");
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    tickHandler.stop();
    log.important("Stopped");
  }

  /**
   * Subscribe to PnL snapshots emitted by the tick handler. Useful for
   * SSE / WebSocket bridges that push live P&L updates to the UI.
   */
  onPnlUpdate(handler: (snapshot: import("./tickHandler").PnlSnapshot) => void): () => void {
    tickHandler.on("pnlUpdate", handler);
    return () => tickHandler.off("pnlUpdate", handler);
  }

  /**
   * Subscribe to paper-channel auto-exit detections from the tick handler.
   * tickHandler emits when a paper trade hits TP or SL on incoming ticks;
   * TEA listens here so the close + audit + Discipline push all flow through
   * the single-writer entry point. Returns an unsubscribe function.
   */
  onAutoExit(handler: (event: AutoExitEvent) => void): () => void {
    tickHandler.on("autoExitDetected", handler);
    return () => tickHandler.off("autoExitDetected", handler);
  }

  /** LIVE Super Orders: gated TSL should arm at the broker (TEA modifies the
   *  STOP_LOSS_LEG). Returns an unsubscribe function. */
  onBrokerTslArm(handler: (event: BrokerTslArmEvent) => void): () => void {
    tickHandler.on("brokerTslArm", handler);
    return () => tickHandler.off("brokerTslArm", handler);
  }

  /** LIVE Super Orders: trailing take-profit should ratchet at the broker (TEA
   *  modifies the TARGET_LEG, applying its throttle + modify-cap budget). */
  onBrokerTpRatchet(handler: (event: BrokerTpRatchetEvent) => void): () => void {
    tickHandler.on("brokerTpRatchet", handler);
    return () => tickHandler.off("brokerTpRatchet", handler);
  }

  /** Persist the local flags after a broker Super Order leg modify (single
   *  writer). Mutates only the leg-modify bookkeeping fields + optionally the
   *  new SL/TP the broker now holds. */
  async recordBrokerLegModify(
    channel: Channel,
    tradeId: string,
    patch: {
      tslArmedOnBroker?: boolean;
      stopLossPrice?: number;
      targetPrice?: number;
      lastBrokerTpPrice?: number;
      lastBrokerTpModifyAt?: number;
      bumpModifyCount?: boolean;
    },
  ): Promise<void> {
    const day = await this.ensureCurrentDay(channel);
    const trade = day.trades.find((t) => t.id === tradeId);
    if (!trade) return;
    if (patch.tslArmedOnBroker !== undefined) trade.tslArmedOnBroker = patch.tslArmedOnBroker;
    if (patch.stopLossPrice !== undefined) trade.stopLossPrice = patch.stopLossPrice;
    if (patch.targetPrice !== undefined) trade.targetPrice = patch.targetPrice;
    if (patch.lastBrokerTpPrice !== undefined) trade.lastBrokerTpPrice = patch.lastBrokerTpPrice;
    if (patch.lastBrokerTpModifyAt !== undefined) trade.lastBrokerTpModifyAt = patch.lastBrokerTpModifyAt;
    if (patch.bumpModifyCount) trade.legModifyCount = (trade.legModifyCount ?? 0) + 1;
    await upsertDayRecord(channel, day);
  }

  // ── Internal helpers (used by TEA + portfolioRouter) ─────────

  /**
   * Ensure the current Day Index has a DayRecord. Creates one with the
   * current Trading Pool snapshot if missing, applies a session reset if
   * the calendar day has rolled, and returns the up-to-date record.
   *
   * Used by TEA when it needs to append a newly-placed trade. Phase 2 will
   * make this the single entry point for all trade writes.
   */
  async ensureCurrentDay(channel: Channel): Promise<DayRecord> {
    const state = await getCapitalState(channel);
    if (checkSessionReset(state)) {
      await updateCapitalState(channel, resetSession(state));
    }
    let day = await getDayRecord(channel, state.currentDayIndex);
    if (!day) {
      const config = await getActiveBrokerConfig();
      const targetPercent = config?.settings?.dailyTargetPercent ?? state.targetPercent ?? 5;
      const origProj = state.tradingPool * (1 + targetPercent / 100);
      day = createDayRecord(
        state.currentDayIndex,
        state.tradingPool,
        targetPercent,
        origProj,
        channel,
        "ACTIVE",
      );
      day = await upsertDayRecord(channel, day);
      if (state.targetPercent !== targetPercent) {
        await updateCapitalState(channel, { targetPercent });
      }
    }
    return day;
  }

  /**
   * Append a TradeRecord to the current day, recalculate aggregates, and
   * persist. Returns the updated DayRecord. Single-writer entry point used
   * by TEA's submitTrade flow.
   *
   * Phase 2: also dual-writes the trade to the position_state collection
   * so queries like getOpenPositions can resolve without scanning the
   * day record's nested array. Failures on the dual-write are logged
   * and swallowed — the day_records write is the source of truth during
   * the migration window.
   */
  async appendTrade(channel: Channel, trade: TradeRecord): Promise<DayRecord> {
    // T97 — while a replay run is open, EVERY new trade belongs to that run and
    // must not touch a real book. Redirecting here rather than at the router
    // keeps one choke point: the executor, sizing and risk chain run unchanged,
    // only the destination differs. A replay cannot move paper's capital or P&L
    // because its trades never enter paper's document.
    const runId = getActiveRunId();
    if (runId) {
      if (trade.source == null) trade.source = "ai";
      if (trade.breakevenPrice == null && trade.entryPrice > 0 && trade.qty > 0) {
        trade.breakevenPrice = await this.computeBreakevenPrice(trade);
      }
      await appendTradeToRun(runId, trade);
      // Return a throwaway day so callers that read the result don't crash.
      // Nothing downstream persists it.
      return createDayRecord(0, 0, 0, 0, channel, "ACTIVE");
    }

    const day = await this.ensureCurrentDay(channel);
    // Stamp AI-vs-My attribution from the channel prefix (T87) — persisted so it
    // survives the paper-channel merge; explicit callers may pre-set it.
    if (trade.source == null) trade.source = channelToSource(channel);
    // Freeze the breakeven price once at placement — the trailing stop is
    // floored here, and the UI reads the same value, so they can't drift.
    if (trade.breakevenPrice == null && trade.entryPrice > 0 && trade.qty > 0) {
      trade.breakevenPrice = await this.computeBreakevenPrice(trade);
    }
    day.trades.push(trade);
    const updated = recalculateDayAggregates(day);
    await upsertDayRecord(channel, updated);
    await this.mirrorPosition(channel, updated.dayIndex, trade).catch((err) =>
      log.warn(`mirrorPosition (append) failed for ${trade.id}: ${(err as Error).message}`),
    );
    await this.audit("TRADE_PLACED", channel, trade.id, {
      instrument: trade.instrument,
      type: trade.type,
      qty: trade.qty,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLossPrice,
      target: trade.targetPrice,
      brokerOrderId: trade.brokerOrderId,
      brokerId: trade.brokerId,
    });
    return updated;
  }

  /**
   * Breakeven price = entry ± round-trip charges per unit. Uses the same charges
   * engine + user rates as the close path so the figure matches what's realized;
   * the exit leg is estimated at the entry price. Falls back to entryPrice if
   * settings/charges can't be read.
   */
  private async computeBreakevenPrice(trade: TradeRecord): Promise<number> {
    try {
      const settings = await getUserSettings(1);
      // Stocks use their equity (intraday/delivery) profile; options use settings.
      const rates = chargeRatesForTrade(trade, settings.charges.rates as ChargeRate[]) as ChargeRate[];
      const isBuy = trade.type.includes("BUY");
      const entryLeg = estimateSingleLegCharges(trade.entryPrice, trade.qty, isBuy, rates).total;
      const exitLeg = estimateSingleLegCharges(trade.entryPrice, trade.qty, !isBuy, rates).total;
      const perUnit = (entryLeg + exitLeg) / trade.qty;
      const be = isBuy ? trade.entryPrice + perUnit : trade.entryPrice - perUnit;
      return Math.round(be * 100) / 100;
    } catch {
      return trade.entryPrice;
    }
  }

  /**
   * Phase 2 dual-write helper: project a TradeRecord into the
   * position_state collection. Idempotent (upsert keyed on positionId).
   */
  /**
   * Phase 2 audit helper: append an event to portfolio_events. Failures
   * are swallowed (audit log is best-effort; the primary write already
   * succeeded by the time we get here).
   */
  private async audit(
    eventType: PortfolioEventType,
    channel: Channel,
    tradeId: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const positionId = tradeId ? `POS-${tradeId.replace(/^T/, "")}` : undefined;
      await appendEvent({
        channel,
        eventType,
        tradeId,
        positionId,
        payload,
        timestamp: Date.now(),
      });
    } catch (err) {
      log.warn(`audit ${eventType} ${channel} ${tradeId ?? "-"}: ${(err as Error).message}`);
    }
  }

  /**
   * Phase 2 metrics rollup: scan all closed positions on the channel
   * (via position_state) and compute aggregate stats with breakdowns
   * by exitTriggeredBy. Designed for the Head-to-Head reporting view.
   * Single channel scan per close — bounded cost; still cheap at the
   * scale where AI is producing < 100 trades/day.
   */
  private async refreshMetrics(channel: Channel): Promise<void> {
    const { PositionStateModel } = await import("./storage");
    const closed = await PositionStateModel.find({
      channel,
      status: { $nin: ["OPEN", "PENDING", "CANCELLED"] },
    }).lean();

    const init = (): PortfolioMetricsDoc["pnlByTriggeredBy"] => ({
      USER: 0, AI: 0, RCA: 0, DISCIPLINE: 0, BROKER: 0, PA: 0,
    });
    const pnlByTriggeredBy = init();
    const countByTriggeredBy = init();

    let cumulativePnl = 0;
    let cumulativeCharges = 0;
    let winCount = 0;
    let lossCount = 0;
    let breakevenCount = 0;
    let totalRr = 0;
    let rrSamples = 0;

    for (const p of closed) {
      cumulativePnl += p.pnl ?? 0;
      cumulativeCharges += p.charges ?? 0;
      if ((p.pnl ?? 0) > 0) winCount += 1;
      else if ((p.pnl ?? 0) < 0) lossCount += 1;
      else breakevenCount += 1;
      if (p.targetPrice && p.stopLossPrice && p.entryPrice) {
        const reward = Math.abs(p.targetPrice - p.entryPrice);
        const risk = Math.abs(p.entryPrice - p.stopLossPrice);
        if (risk > 0) { totalRr += reward / risk; rrSamples += 1; }
      }
      const triggered = (p.exitTriggeredBy as keyof typeof pnlByTriggeredBy | undefined);
      if (triggered && triggered in pnlByTriggeredBy) {
        pnlByTriggeredBy[triggered] += p.pnl ?? 0;
        countByTriggeredBy[triggered] += 1;
      }
    }
    const tradeCount = winCount + lossCount + breakevenCount;
    const winRate = tradeCount > 0 ? winCount / tradeCount : 0;

    // maxDrawdown from portfolio_state.peakCapital (set up in commit 1
    // schema; still defaulted to 0 on older docs — Phase 4 will track
    // peak/drawdown live).
    const existing = await getMetrics(channel);

    await upsertMetrics({
      channel,
      cumulativePnl,
      cumulativeCharges,
      maxDrawdown: existing?.maxDrawdown ?? 0,
      winRate,
      averageRr: rrSamples > 0 ? totalRr / rrSamples : 0,
      tradeCount,
      winCount,
      lossCount,
      breakevenCount,
      pnlByTriggeredBy,
      countByTriggeredBy,
      updatedAt: Date.now(),
    });
  }

  /**
   * PA Phase 4: peak / drawdown live tracking. Reads the current state,
   * advances peakCapital if currentCapital exceeds it (drawdown resets
   * to 0), otherwise computes drawdownPercent from the peak. Persists
   * via updateCapitalState so the next snapshot reads fresh values.
   *
   * Called from closeTrade. Could also be called on capital injection
   * — reserved for follow-up.
   */
  private async refreshDrawdown(channel: Channel): Promise<void> {
    const state = await getCapitalState(channel);
    const currentCapital = (state.tradingPool ?? 0) + (state.reservePool ?? 0);
    if (currentCapital <= 0) return;

    // Seed peak from initial funding if missing — prevents the first
    // closeTrade from reporting an artificial 100% drawdown.
    const seedPeak = state.peakCapital ?? state.initialFunding ?? currentCapital;

    if (currentCapital >= seedPeak) {
      // New high-water mark; reset drawdown.
      await updateCapitalState(channel, {
        peakCapital: currentCapital,
        drawdownPercent: 0,
        peakUpdatedAt: Date.now(),
      });
      return;
    }
    // Below peak — compute drawdown.
    const drawdownPercent = ((seedPeak - currentCapital) / seedPeak) * 100;
    await updateCapitalState(channel, {
      peakCapital: seedPeak,
      drawdownPercent: Math.round(drawdownPercent * 100) / 100,
    });
  }

  private async mirrorPosition(channel: Channel, dayIndex: number, trade: TradeRecord): Promise<void> {
    const positionId = `POS-${trade.id.replace(/^T/, "")}`;
    const now = Date.now();
    const doc: PositionStateDoc = {
      positionId,
      tradeId: trade.id,
      channel,
      dayIndex,
      instrument: trade.instrument,
      type: trade.type,
      strike: trade.strike,
      expiry: trade.expiry ?? null,
      contractSecurityId: trade.contractSecurityId ?? null,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      ltp: trade.ltp,
      qty: trade.qty,
      lotSize: trade.lotSize,
      capitalPercent: trade.capitalPercent,
      pnl: trade.pnl,
      unrealizedPnl: trade.unrealizedPnl,
      charges: trade.charges,
      chargesBreakdown: trade.chargesBreakdown,
      status: trade.status,
      targetPrice: trade.targetPrice,
      stopLossPrice: trade.stopLossPrice,
      peakLtp: trade.peakLtp,
      trailingStopEnabled: trade.trailingStopEnabled,
      manualExitOnly: trade.manualExitOnly ?? false,
      exitStrategy: trade.exitStrategy ?? "sprint",
      brokerOrderId: trade.brokerOrderId,
      brokerId: trade.brokerId,
      cohort: trade.cohort ?? null,
      source: trade.source ?? channelToSource(channel),
      openedAt: trade.openedAt,
      closedAt: trade.closedAt,
      exitReason: trade.exitReason,
      exitTriggeredBy: trade.exitTriggeredBy,
      signalSource: trade.signalSource,
      createdAt: now,
      updatedAt: now,
    };
    await upsertPosition(doc);
  }

  /**
   * Close an open trade. Single-writer storage primitive — does the full
   * close: P&L calculation, charges, capital state update, day completion
   * check, gift-day cascade, clawback rewind. Called by TEA.exitTrade
   * (manual exits) and TEA.recordAutoExit (paper TP/SL detected by
   * tickHandler).
   *
   * Throws if the trade is not found, already closed, or the channel has no
   * active day.
   */
  /**
   * Settle a replay-run trade. Mirrors the book path's P&L and charge maths
   * exactly — a run is only worth comparing if its numbers are computed the same
   * way as a real book's — but persists to the run document and touches no
   * capital.
   *
   * Returns null when the trade isn't in this run, so the caller can fall
   * through to the normal path.
   */
  private async closeTradeInRun(
    runId: string,
    tradeId: string,
    exitPrice: number,
    exitReason?: import("./state").ExitReason,
  ): Promise<{ trade: TradeRecord; day: DayRecord; pnl: number; charges: number } | null> {
    const run = await getRun(runId);
    if (!run) return null;
    const trades = run.trades ?? [];
    const trade = trades.find((t) => t.id === tradeId);
    if (!trade) return null;
    if (trade.status !== "OPEN" && trade.status !== "PENDING") return null;

    const isBuy = trade.type.includes("BUY");
    const grossPnl = (exitPrice - trade.entryPrice) * trade.qty * (isBuy ? 1 : -1);

    const settings = await getUserSettings(1);
    const chargeRates = chargeRatesForTrade(trade, settings.charges.rates as ChargeRate[]) as ChargeRate[];
    const charges = calculateTradeCharges(
      {
        entryPrice: trade.entryPrice,
        exitPrice,
        qty: trade.qty,
        isBuy,
        exchange:
          trade.instrument.includes("CRUDE") || trade.instrument.includes("NATURAL") ? "MCX" : "NSE",
      },
      chargeRates,
    );

    trade.exitPrice = exitPrice;
    trade.pnl = Math.round((grossPnl - charges.total) * 100) / 100;
    trade.charges = charges.total;
    trade.chargesBreakdown = charges.breakdown;
    trade.unrealizedPnl = 0;
    trade.ltp = exitPrice;
    trade.closedAt = Date.now();
    if (trade.openedAt) trade.durationMs = trade.closedAt - trade.openedAt;
    trade.status = "CLOSED";
    if (exitReason) trade.exitReason = exitReason;

    await updateRunTrades(runId, trades);
    log.info(`[replay] closed ${tradeId} @ ${exitPrice} (${exitReason ?? "?"}) pnl=${trade.pnl}`);

    // A run has no day record; hand back a throwaway so the signature holds.
    return {
      trade,
      day: createDayRecord(1, run.openingCapital, 0, run.openingCapital, "paper", "ACTIVE"),
      pnl: trade.pnl,
      charges: charges.total,
    };
  }

  async closeTrade(
    channel: Channel,
    tradeId: string,
    exitPrice: number,
    /** Optional — stamp the operator-known exit reason on the trade
     *  alongside the close. The follow-up recordTradeClosed event also
     *  sets exitReason; this parameter exists for callers (e.g.
     *  reconcileDesync) that close out without going through that path. */
    exitReason?: import("./state").ExitReason,
    /** Broker order id of the reverse (exit) order — stamped so the exit fill
     *  can later correct the realized price (B1: correct-after-close). */
    exitBrokerOrderId?: string | null,
  ): Promise<{ trade: TradeRecord; day: DayRecord; pnl: number; charges: number }> {
    // T97 — a replay trade lives in the RUN, not the day record. Without this
    // the lookup below throws "Trade not found", the exit never completes, and
    // the trade stays OPEN forever: SL / TSL / TP appear not to work at all,
    // even though the tick engine detected the hit correctly. appendTrade and
    // the tick engine were redirected to the run; this path was missed.
    const runId = getActiveRunId();
    if (runId) {
      const closedInRun = await this.closeTradeInRun(runId, tradeId, exitPrice, exitReason);
      if (closedInRun) return closedInRun;
      // Not in the run → fall through: it's a genuine book trade (e.g. one that
      // was already open before the replay started).
    }

    const state = await getCapitalState(channel);
    const day = await this.ensureCurrentDay(channel);

    const trade = day.trades.find((t) => t.id === tradeId);
    if (!trade) throw new Error(`Trade not found: ${tradeId}`);
    // BROKER_DESYNC is a permitted entry state for closeTrade — the
    // reconcile flow uses this to flip a desync'd trade to a real close
    // once the broker confirms the position is gone.
    if (
      trade.status !== "OPEN" &&
      trade.status !== "PENDING" &&
      trade.status !== "BROKER_DESYNC"
    ) {
      throw new Error(`Trade already closed: ${tradeId} (status=${trade.status})`);
    }

    // P&L
    const isBuy = trade.type.includes("BUY");
    const direction = isBuy ? 1 : -1;
    const grossPnl = (exitPrice - trade.entryPrice) * trade.qty * direction;

    // Charges
    const settings = await getUserSettings(1);
    // Stocks use their equity (intraday/delivery) profile; options use settings.
    const chargeRates = chargeRatesForTrade(trade, settings.charges.rates as ChargeRate[]) as ChargeRate[];
    const charges = calculateTradeCharges(
      {
        entryPrice: trade.entryPrice,
        exitPrice,
        qty: trade.qty,
        isBuy,
        exchange:
          trade.instrument.includes("CRUDE") || trade.instrument.includes("NATURAL")
            ? "MCX"
            : "NSE",
      },
      chargeRates,
    );

    // Stamp the close on the trade
    trade.exitPrice = exitPrice;
    trade.pnl = Math.round((grossPnl - charges.total) * 100) / 100;
    trade.charges = charges.total;
    trade.chargesBreakdown = charges.breakdown;
    trade.unrealizedPnl = 0;
    trade.ltp = exitPrice;
    trade.closedAt = Date.now();
    // Hold duration (ms) — persisted so reports read it without recomputing.
    if (trade.openedAt) trade.durationMs = trade.closedAt - trade.openedAt;
    trade.status = "CLOSED";
    if (exitReason) trade.exitReason = exitReason;
    if (exitBrokerOrderId) trade.exitBrokerOrderId = exitBrokerOrderId;
    // Reconciliation may close a previously-desync'd trade — drop the marker.
    if (trade.desync) delete trade.desync;

    // Persist the close ATOMICALLY (T86 β): a positional per-trade write for the
    // close fields + the recomputed day aggregates, NOT a whole-day overwrite —
    // so a concurrent per-tick persist can't revert this trade back to OPEN.
    const updated = recalculateDayAggregates(day);
    await patchTradeInDay(
      channel,
      updated.dayIndex,
      trade.id,
      {
        status: "CLOSED",
        exitPrice: trade.exitPrice,
        pnl: trade.pnl,
        charges: trade.charges,
        chargesBreakdown: trade.chargesBreakdown,
        unrealizedPnl: 0,
        ltp: trade.ltp,
        closedAt: trade.closedAt,
        durationMs: trade.durationMs,
        exitReason: trade.exitReason,
        exitBrokerOrderId: trade.exitBrokerOrderId,
      },
      dayAggregateFields(updated),
    );

    // Phase 2 dual-write: project the closed trade into position_state.
    await this.mirrorPosition(channel, updated.dayIndex, trade).catch((err) =>
      log.warn(`mirrorPosition (close) failed for ${trade.id}: ${(err as Error).message}`),
    );

    // Update capital state — session + cumulative P&L counters.
    await updateCapitalState(channel, {
      sessionPnl: state.sessionPnl + trade.pnl,
      cumulativePnl: state.cumulativePnl + trade.pnl,
      cumulativeCharges: state.cumulativeCharges + charges.total,
    });

    // Day completion / gift days / clawback. These are best-effort —
    // failures are logged but the close itself stands.
    try {
      await this.maybeCompleteOrClawback(channel, state, updated);
    } catch (err) {
      log.warn(`Day completion / clawback check failed for ${channel}: ${(err as Error).message}`);
    }

    // Phase 2: append audit event + refresh metrics rollup.
    await this.audit("TRADE_CLOSED", channel, trade.id, {
      exitPrice,
      pnl: trade.pnl,
      charges: charges.total,
      status: trade.status,
      exitReason: trade.exitReason,
      exitTriggeredBy: trade.exitTriggeredBy,
    });
    await this.refreshMetrics(channel).catch((err) =>
      log.warn(`refreshMetrics failed for ${channel}: ${(err as Error).message}`),
    );
    // Phase 4: advance peak / recompute drawdown after every close.
    await this.refreshDrawdown(channel).catch((err) =>
      log.warn(`refreshDrawdown failed for ${channel}: ${(err as Error).message}`),
    );

    return { trade, day: updated, pnl: trade.pnl, charges: charges.total };
  }

  /**
   * B1 (correct-after-close): the reverse (exit) order filled at `realExitPrice`
   * AFTER we optimistically closed the trade at the requested/LTP price. Restate
   * the realized exit price, recompute net P&L + charges, and adjust the capital
   * counters by the delta. No-op if the price already matches or the trade isn't
   * a matching closed trade.
   */
  async correctExitFill(
    channel: Channel,
    tradeId: string,
    realExitPrice: number,
  ): Promise<{ corrected: boolean }> {
    if (!(realExitPrice > 0)) return { corrected: false };
    const state = await getCapitalState(channel).catch(() => null);
    if (!state) return { corrected: false };
    const day = await getDayRecord(channel, state.currentDayIndex).catch(() => null);
    if (!day) return { corrected: false };
    const trade = day.trades.find((t) => t.id === tradeId);
    if (!trade || trade.status !== "CLOSED") {
      return { corrected: false };
    }
    if (trade.exitPrice === realExitPrice) return { corrected: false };

    const oldPnl = trade.pnl;
    const oldCharges = trade.charges;

    const isBuy = trade.type.includes("BUY");
    const direction = isBuy ? 1 : -1;
    const grossPnl = (realExitPrice - trade.entryPrice) * trade.qty * direction;
    const settings = await getUserSettings(1);
    const chargeRates = chargeRatesForTrade(trade, settings.charges.rates as ChargeRate[]) as ChargeRate[];
    const charges = calculateTradeCharges(
      {
        entryPrice: trade.entryPrice,
        exitPrice: realExitPrice,
        qty: trade.qty,
        isBuy,
        exchange:
          trade.instrument.includes("CRUDE") || trade.instrument.includes("NATURAL") ? "MCX" : "NSE",
      },
      chargeRates,
    );

    trade.exitPrice = realExitPrice;
    trade.ltp = realExitPrice;
    trade.pnl = Math.round((grossPnl - charges.total) * 100) / 100;
    trade.charges = charges.total;
    trade.chargesBreakdown = charges.breakdown;

    const pnlDelta = Math.round((trade.pnl - oldPnl) * 100) / 100;
    const chargeDelta = Math.round((charges.total - oldCharges) * 100) / 100;

    const updated = recalculateDayAggregates(day);
    await upsertDayRecord(channel, updated);
    await this.mirrorPosition(channel, updated.dayIndex, trade).catch((err) =>
      log.warn(`mirrorPosition (exit-correct) failed for ${trade.id}: ${(err as Error).message}`),
    );

    // Apply only the DELTA — closeTrade already booked the optimistic P&L.
    await updateCapitalState(channel, {
      sessionPnl: state.sessionPnl + pnlDelta,
      cumulativePnl: state.cumulativePnl + pnlDelta,
      cumulativeCharges: state.cumulativeCharges + chargeDelta,
    });

    await this.audit("BROKER_ORDER_EVENT", channel, trade.id, {
      note: "exit-fill price correction",
      newExitPrice: realExitPrice,
      oldPnl,
      newPnl: trade.pnl,
      pnlDelta,
    });
    await this.refreshMetrics(channel).catch(() => {});
    await this.refreshDrawdown(channel).catch(() => {});

    return { corrected: true };
  }

  /** Build a TradeRecord mirroring an externally-placed fill (id prefix EXT-). */
  private buildExternalTrade(
    update: BrokerOrderEvent,
    symbol: string,
    direction: "BUY" | "SELL",
    qty: number,
    price: number,
  ): TradeRecord {
    // T123 — an order placed OUTSIDE Lubas (adopted from the broker's order
    // stream) arrives with a securityId and nothing else. Strike and expiry were
    // both hardcoded null, so an adopted option landed on the desk unidentified.
    // The scrip master knows both from that one id; resolve rather than guess.
    const scrip = update.securityId ? getScripBySecurityId(String(update.securityId)) : undefined;
    return {
      id: `EXT-${update.orderId}`,
      instrument: symbol,
      type: direction, // BUY = long, SELL = short
      strike: scrip?.strikePrice && scrip.strikePrice > 0 ? scrip.strikePrice : null,
      expiry: scrip?.expiryDateOnly || null,
      contractSecurityId: update.securityId ?? null,
      productType: update.productType === "CNC" ? "CNC" : "INTRADAY",
      entryPrice: price,
      entryPending: false,
      exitPrice: null,
      ltp: price,
      qty,
      lotSize: 1,
      capitalPercent: 0,
      pnl: 0,
      unrealizedPnl: 0,
      charges: 0,
      chargesBreakdown: [],
      status: "OPEN",
      targetPrice: null,
      stopLossPrice: null,
      brokerOrderId: update.orderId,
      brokerId: update.brokerId,
      openedAt: Date.now(),
      closedAt: null,
    } as TradeRecord;
  }

  /**
   * Adopt an externally-placed order (not placed through the app) by mirroring
   * it into the app via position netting. Called when a FILLED event from the
   * PRIMARY account matched no local trade. Attribution: equity → stocks-live,
   * else live. A fill either opens a position in its own direction or
   * closes/reduces an existing opposite one (handles sell-first-then-cover).
   */
  private async adoptExternalFill(update: BrokerOrderEvent): Promise<BrokerOrderEventResult> {
    const securityId = update.securityId;
    const direction = update.transactionType;
    const qty = update.filledQuantity;
    const price = update.averagePrice;
    if (!securityId || !direction || !(qty > 0) || !(price > 0)) return { matched: false };

    // Only EQUITY (stocks) is adopted for now. Options/commodities need a
    // securityId → strike/expiry contract resolution before they can be mirrored
    // correctly (buildExternalTrade would otherwise create an equity-shaped
    // trade for a CE/PE) — deferred to step ③.
    if (update.assetKind !== "equity") return { matched: false };
    // Stocks fold into the My book (T87): equity fills are adopted into live.
    const channel: Channel = "live";
    const symbol = update.symbol ?? securityId;

    const state = await getCapitalState(channel).catch(() => null);
    if (!state) return { matched: false };
    const day = await getDayRecord(channel, state.currentDayIndex).catch(() => null);
    if (!day) return { matched: false };

    // Net against an OPEN opposite-side position for this security.
    const oppSide = direction === "BUY" ? "SELL" : "BUY";
    const open = day.trades.find(
      (t) => t.status === "OPEN" && t.contractSecurityId === securityId && t.type === oppSide,
    );

    if (open) {
      if (qty >= open.qty) {
        // Full close (cover) — realize P&L at the fill price; any excess opens a
        // fresh position in this fill's direction.
        await this.closeTrade(channel, open.id, price, "MANUAL", update.orderId);
        const excess = qty - open.qty;
        if (excess > 0) {
          await this.appendTrade(channel, this.buildExternalTrade(update, symbol, direction, excess, price));
        }
        return { matched: true, channel, tradeId: open.id, newStatus: "CLOSED" };
      }
      // Partial close — shrink the open position; book the realized P&L on the
      // closed portion into the capital counters.
      const dir = open.type.includes("BUY") ? 1 : -1;
      const grossPnl = (price - open.entryPrice) * qty * dir;
      open.qty -= qty;
      const updated = recalculateDayAggregates(day);
      await upsertDayRecord(channel, updated);
      await updateCapitalState(channel, {
        sessionPnl: state.sessionPnl + Math.round(grossPnl * 100) / 100,
        cumulativePnl: state.cumulativePnl + Math.round(grossPnl * 100) / 100,
      });
      await this.audit("BROKER_ORDER_EVENT", channel, open.id, {
        note: "external partial close (netting)",
        closedQty: qty,
        price,
        realizedPnl: Math.round(grossPnl * 100) / 100,
      });
      return { matched: true, channel, tradeId: open.id, newStatus: "OPEN" };
    }

    // No opposite position — open a new one in this fill's direction.
    const trade = this.buildExternalTrade(update, symbol, direction, qty, price);
    await this.appendTrade(channel, trade);
    return { matched: true, channel, tradeId: trade.id, newStatus: "OPEN" };
  }

  /**
   * Update SL / TP / trailing-stop on an open trade. Used by TEA.modifyOrder.
   * Pure local state mutation — TEA handles any broker-side modify call.
   */
  async updateTrade(
    channel: Channel,
    tradeId: string,
    modifications: {
      stopLossPrice?: number | null;
      targetPrice?: number | null;
      trailingStopEnabled?: boolean;
      stopLossDisabled?: boolean;
      targetDisabled?: boolean;
      tslMode?: "auto" | "manual";
      manualExitOnly?: boolean;
      /** Roll the exit strategy on an OPEN trade (the desk's strategy pill). */
      exitStrategy?: "sprint" | "runway" | "anchor" | "glide";
    },
  ): Promise<{ trade: TradeRecord; day: DayRecord; oldSL: number | null; oldTP: number | null }> {
    const day = await this.ensureCurrentDay(channel);
    const trade = day.trades.find((t) => t.id === tradeId);
    if (!trade) throw new Error(`Trade not found: ${tradeId}`);
    if (trade.status !== "OPEN") {
      throw new Error(`Cannot modify closed trade: ${tradeId} (status=${trade.status})`);
    }
    const oldSL = trade.stopLossPrice;
    const oldTP = trade.targetPrice;

    // Stamp the manual-override flags alongside the level. Every caller of this
    // method is operator intent (the UI's SL/TP edit, and the desync reconcile
    // where the operator types in the broker's true levels) — the tick engine
    // mutates trades directly and never comes through here, so this can't be
    // tripped by the strategy's own trailing.
    //
    // Without these the attached strategy overwrites a manual edit on the very
    // next tick: Runway/Anchor recompute both levels from config unconditionally.
    if (modifications.stopLossPrice !== undefined) {
      trade.stopLossPrice = modifications.stopLossPrice;
      trade.slOverridden = true;
    }
    if (modifications.targetPrice !== undefined) {
      trade.targetPrice = modifications.targetPrice;
      trade.tpOverridden = true;
    }
    if (modifications.trailingStopEnabled !== undefined) trade.trailingStopEnabled = modifications.trailingStopEnabled;
    if (modifications.stopLossDisabled !== undefined) trade.stopLossDisabled = modifications.stopLossDisabled;
    if (modifications.targetDisabled !== undefined) trade.targetDisabled = modifications.targetDisabled;
    if (modifications.tslMode !== undefined) trade.tslMode = modifications.tslMode;
    if (modifications.manualExitOnly !== undefined) trade.manualExitOnly = modifications.manualExitOnly;

    // ── Rolling the exit strategy on a LIVE position ────────────────────────
    //
    // Two things have to move with it, or the trade ends up in a state no engine
    // manages:
    //
    //  → GLIDE has no SL/TP/trailing; it rides until MA-Signal's EXIT. That is
    //    expressed by `manualExitOnly`, which the tick engine reads to skip
    //    every auto-exit. Setting the strategy without it leaves Sprint's stops
    //    still firing on a trade meant to ride.
    //
    //  ← LEAVING glide, the trade has NULL levels (Glide never set any). Handing
    //    it to Sprint as-is gives a position with no stop and no target — the
    //    engine would simply never exit it. So backfill from the AI menu's
    //    Sprint config, mirroring how a fresh Sprint trade opens.
    //    Runway/Anchor recompute both from entry on their first tick, so they
    //    need no backfill — but a level is still set so the row never shows a
    //    blank stop on a live position.
    if (modifications.exitStrategy !== undefined) {
      const next = modifications.exitStrategy;
      trade.exitStrategy = next;
      trade.manualExitOnly = next === "glide";
      if (next !== "glide" && trade.entryPrice > 0 &&
          (trade.stopLossPrice == null || trade.targetPrice == null)) {
        const lv = sprintOpeningLevels(trade.entryPrice, trade.type.includes("BUY"));
        if (trade.stopLossPrice == null) trade.stopLossPrice = lv.stopLoss;
        if (trade.targetPrice == null) trade.targetPrice = lv.takeProfit;
      }
      log.important(
        `strategy rolled ${channel} trade=${tradeId} → ${next} ` +
          `(manualExitOnly=${trade.manualExitOnly} SL=${trade.stopLossPrice} TP=${trade.targetPrice})`,
      );
    }

    await upsertDayRecord(channel, day);
    // Push EVERY edit into the tickHandler's live cache — its per-tick persist
    // writes the cached trade, so any field not mirrored here is clobbered back
    // on the next tick ("moves then resets"). Covers prices AND the risk-flag
    // toggles (SL/TP-disable, TSL mode, manual-exit-only).
    tickHandler.applyTradeEdit(channel, tradeId, {
      exitStrategy: modifications.exitStrategy,
      // On a strategy roll, push the RESOLVED values (manualExitOnly and any
      // backfilled levels the roll just set) — not the caller's, which carried
      // none of them. Otherwise the next tick persist reverts the roll.
      stopLossPrice: modifications.stopLossPrice ?? (modifications.exitStrategy ? trade.stopLossPrice : undefined),
      targetPrice: modifications.targetPrice ?? (modifications.exitStrategy ? trade.targetPrice : undefined),
      manualExitOnly: modifications.exitStrategy ? trade.manualExitOnly : modifications.manualExitOnly,
      stopLossDisabled: modifications.stopLossDisabled,
      targetDisabled: modifications.targetDisabled,
      tslMode: modifications.tslMode,
    });
    await this.mirrorPosition(channel, day.dayIndex, trade).catch((err) =>
      log.warn(`mirrorPosition (update) failed for ${trade.id}: ${(err as Error).message}`),
    );
    await this.audit("TRADE_MODIFIED", channel, trade.id, {
      oldSL,
      newSL: trade.stopLossPrice,
      oldTP,
      newTP: trade.targetPrice,
      trailingStopEnabled: trade.trailingStopEnabled,
    });
    return { trade, day, oldSL, oldTP };
  }

  /**
   * B4: flag a trade as desync'd from broker after a failed broker mutation.
   *
   * - kind="EXIT" → also flips status to BROKER_DESYNC (limbo: position
   *   may be open OR closed at broker; reconcile must check). Discipline
   *   blocks new entries.
   * - kind="MODIFY" → keeps status=OPEN, only annotates the desync. The
   *   position is alive at the broker; only the bracket SL/TP differ.
   *   Discipline still blocks (operator must reconcile before adding).
   */
  async markTradeDesync(
    channel: Channel,
    tradeId: string,
    info: import("./state").DesyncInfo,
  ): Promise<{ trade: TradeRecord; day: DayRecord }> {
    const day = await this.ensureCurrentDay(channel);
    const trade = day.trades.find((t) => t.id === tradeId);
    if (!trade) throw new Error(`Trade not found: ${tradeId}`);

    trade.desync = info;
    if (info.kind === "EXIT") {
      trade.status = "BROKER_DESYNC";
    }
    await upsertDayRecord(channel, day);
    await this.audit("TRADE_DESYNC", channel, trade.id, {
      kind: info.kind,
      reason: info.reason,
      timestamp: info.timestamp,
      attempted: info.attempted,
    });
    return { trade, day };
  }

  /**
   * B4: clear a trade's desync flag after operator-initiated reconciliation
   * confirmed the position is still alive at the broker.
   *
   * If status was BROKER_DESYNC (an EXIT-desync that the operator now
   * confirms is still open), it's flipped back to OPEN — the position
   * is alive at broker, so the local state should reflect that. Caller
   * is responsible for any SL/TP correction (use updateTrade afterwards).
   *
   * For positions whose status is already OPEN (a MODIFY-desync), the
   * status is left alone — only the desync marker is removed.
   */
  async clearTradeDesync(
    channel: Channel,
    tradeId: string,
  ): Promise<{ trade: TradeRecord; day: DayRecord }> {
    const day = await this.ensureCurrentDay(channel);
    const trade = day.trades.find((t) => t.id === tradeId);
    if (!trade) throw new Error(`Trade not found: ${tradeId}`);
    if (!trade.desync) return { trade, day };

    const cleared = trade.desync;
    const previousStatus = trade.status;
    if (trade.status === "BROKER_DESYNC") {
      trade.status = "OPEN";
    }
    delete trade.desync;
    await upsertDayRecord(channel, day);
    await this.audit("TRADE_DESYNC_CLEARED", channel, trade.id, {
      kind: cleared.kind,
      previousStatus,
      restoredStatus: trade.status,
      reconciledAt: Date.now(),
    });
    return { trade, day };
  }

  /**
   * B4: any open trade currently flagged as desync'd? Discipline uses this
   * to block new entries until the operator reconciles.
   */
  async hasUnresolvedDesync(channel: Channel): Promise<boolean> {
    const day = await this.ensureCurrentDay(channel);
    return day.trades.some((t) => t.desync !== undefined);
  }

  /**
   * B11-followup 3/3 — apply a broker-emitted OrderUpdate to the local
   * trade state. This is the single-writer entry point for broker
   * lifecycle reconciliation; orderSync used to write directly via
   * upsertDayRecord (PA single-writer-invariant violation), now it just
   * forwards events here.
   *
   * Lookup: trades are identified by (brokerOrderId, brokerId). The
   * brokerId pair-match disambiguates orderId collisions across adapters
   * (commit 2/3 stamped brokerId on every event). Legacy trades that
   * pre-date the brokerId field have brokerId=null and fall back to
   * orderId-only matching.
   *
   * Only terminal-ish statuses mutate state (FILLED, CANCELLED, REJECTED,
   * EXPIRED). Intermediate PENDING/OPEN events are no-ops — the trade is
   * already in the matching state locally.
   *
   * Returns `{ matched, channel, tradeId }` for the caller (orderSync's
   * "sync" emit + tests).
   */
  async applyBrokerOrderEvent(
    update: BrokerOrderEvent,
  ): Promise<BrokerOrderEventResult> {
    if (
      update.status !== "FILLED" &&
      update.status !== "PARTIALLY_FILLED" &&
      update.status !== "CANCELLED" &&
      update.status !== "REJECTED" &&
      update.status !== "EXPIRED"
    ) {
      return { matched: false };
    }

    // ── Super Order leg fill (LegNo 2 = Stop-Loss, 3 = Target) ───────────
    // A broker-side SL/TP exit. Match the parent trade by superOrderId (== the
    // leg's entryOrderId / AlgoOrdNo, always present on a leg event) or by a
    // previously-learned leg id, then close via the SAME auto-exit path paper
    // uses: emit autoExitDetected → TEA.recordAutoExit owns close + analytics +
    // notify (single-writer invariant preserved).
    if (update.status === "FILLED" && (update.legNo === 2 || update.legNo === 3)) {
      const reason: AutoExitEvent["reason"] = update.legNo === 2 ? "SL_HIT" : "TP_HIT";
      const legChannels: Channel[] = ["live"];
      for (const channel of legChannels) {
        const state = await getCapitalState(channel).catch(() => null);
        if (!state) continue;
        const day = await getDayRecord(channel, state.currentDayIndex).catch(() => null);
        if (!day) continue;
        const trade = day.trades.find(
          (t) =>
            (t.status === "OPEN" || t.status === "PENDING") &&
            ((!!update.entryOrderId && t.superOrderId === update.entryOrderId) ||
              t.slLegOrderId === update.orderId ||
              t.tpLegOrderId === update.orderId),
        );
        if (!trade) continue;
        const legPrice = update.legNo === 2 ? trade.stopLossPrice : trade.targetPrice;
        const exitPrice = update.averagePrice > 0 ? update.averagePrice : legPrice ?? trade.ltp;
        await this.audit("BROKER_ORDER_EVENT", channel, trade.id, {
          brokerId: update.brokerId,
          legNo: update.legNo,
          legOrderId: update.orderId,
          superOrderId: trade.superOrderId,
          reason,
          exitPrice,
          note: "super-order leg fill",
        });
        tickHandler.emit("autoExitDetected", {
          channel,
          tradeId: trade.id,
          reason,
          exitPrice,
          timestamp: Date.now(),
        } satisfies AutoExitEvent);
        return { matched: true, channel, tradeId: trade.id };
      }
      return { matched: false };
    }

    // Brokers don't tell us which channel the order belongs to. Each live
    // channel could have placed it — scan and stop at the first match.
    const liveChannels: Channel[] = ["live"];
    for (const channel of liveChannels) {
      const state = await getCapitalState(channel).catch(() => null);
      if (!state) continue;
      const day = await getDayRecord(channel, state.currentDayIndex).catch(() => null);
      if (!day) continue;

      const trade = day.trades.find(
        (t) =>
          t.brokerOrderId === update.orderId &&
          // Legacy trades (pre-2026-05) have brokerId=null on the trade
          // record; for those we fall back to orderId-only matching.
          (t.brokerId === null || t.brokerId === update.brokerId) &&
          (t.status === "OPEN" || t.status === "PENDING"),
      );
      if (!trade) continue;

      const previousStatus = trade.status;
      let entryAdjusted = false;
      let qtyAdjusted = false;

      // A fill event (full or partial), OR a cancel/expire that leaves a filled
      // portion behind (remainder killed after a partial) — all mean the trade
      // holds a real position. `filledQuantity` is cumulative; `averagePrice` is
      // the running weighted average across fills.
      const isFill = update.status === "FILLED" || update.status === "PARTIALLY_FILLED";
      // A cancel/expire that reports a filled qty is only the UNFILLED remainder
      // dying after a partial fill — the filled portion is a real position, so
      // keep it open. A cancel/expire with nothing filled falls through to close.
      const remainderKill =
        (update.status === "CANCELLED" || update.status === "EXPIRED") &&
        update.filledQuantity > 0;

      if (isFill || remainderKill) {
        // Correct entry price + qty to the broker's actual fill. `filledQuantity`
        // is cumulative; `averagePrice` is the running weighted average.
        if (update.averagePrice > 0 && update.averagePrice !== trade.entryPrice) {
          trade.entryPrice = update.averagePrice;
          entryAdjusted = true;
        }
        // On a real fill event, re-arm entryPending when no avg price came (so
        // tickHandler fills from the first live tick). A remainder-kill carries
        // no new fill price — keep the price already set by the earlier fill.
        if (isFill) trade.entryPending = !(update.averagePrice > 0);
        if (update.filledQuantity > 0 && update.filledQuantity !== trade.qty) {
          trade.qty = update.filledQuantity;
          qtyAdjusted = true;
        }
        // Promote PENDING → OPEN once the broker confirms any fill. A later
        // PARTIALLY_FILLED/FILLED just grows the filled qty; a remainder-kill
        // leaves the (partial) position open.
        if (trade.status === "PENDING") trade.status = "OPEN";
      } else {
        // CANCELLED / REJECTED / EXPIRED with nothing filled — order never made
        // it to market. REJECTED is kept distinct (broker refused it) and carries
        // the broker's reason text; CANCELLED/EXPIRED collapse to CANCELLED.
        trade.status = update.status === "REJECTED" ? "REJECTED" : "CANCELLED";
        if (update.status === "REJECTED" && update.reason) {
          trade.rejectReason = update.reason;
        }
        trade.exitPrice = trade.entryPrice;
        trade.pnl = 0;
        trade.unrealizedPnl = 0;
        trade.closedAt = Date.now();
        // 2026-07-01: Telegram push for broker-side kills (REJECTED /
        // CANCELLED / EXPIRED). Previously silent — the operator had no
        // signal that the AI had tried to enter but was blocked at the
        // broker. Fire-and-forget; the notifier gates on live +
        // ai-paper so manual and testing trades stay silent.
        try {
          notifyOrderRejected({
            channel,
            instrument: trade.instrument,
            qty: trade.qty,
            status: trade.status === "REJECTED" ? "REJECTED" : "CANCELLED",
            reason: trade.rejectReason ?? null,
            triggeredBy: "BROKER",
          });
        } catch (err) {
          log.warn(
            `notifyOrderRejected failed for ${trade.id}: ${(err as Error).message}`,
          );
        }
      }

      const updated = recalculateDayAggregates(day);
      await upsertDayRecord(channel, updated);

      await this.audit("BROKER_ORDER_EVENT", channel, trade.id, {
        brokerId: update.brokerId,
        brokerOrderId: update.orderId,
        brokerStatus: update.status,
        previousStatus,
        newStatus: trade.status,
        entryAdjusted,
        qtyAdjusted,
        averagePrice: update.averagePrice,
        filledQuantity: update.filledQuantity,
      });

      return { matched: true, channel, tradeId: trade.id, newStatus: trade.status };
    }

    // ── Exit-fill correction (B1) ────────────────────────────────────────
    // No OPEN/PENDING trade matched this fill by its ENTRY order id — so it may
    // be the fill of a REVERSE (exit) order. Match a recently-CLOSED trade by its
    // exitBrokerOrderId and restate the realized exit price to the real fill.
    if (update.status === "FILLED" && update.averagePrice > 0) {
      for (const channel of liveChannels) {
        const state = await getCapitalState(channel).catch(() => null);
        if (!state) continue;
        const day = await getDayRecord(channel, state.currentDayIndex).catch(() => null);
        if (!day) continue;
        const trade = day.trades.find(
          (t) =>
            t.exitBrokerOrderId === update.orderId &&
            (t.brokerId === null || t.brokerId === update.brokerId) &&
            t.status === "CLOSED",
        );
        if (!trade) continue;
        await this.correctExitFill(channel, trade.id, update.averagePrice);
        return { matched: true, channel, tradeId: trade.id, newStatus: trade.status };
      }
    }

    // ── Early app-fill buffer (race guard) ────────────────────────────────
    // Nothing above matched. If this is an APP order, its trade record simply
    // hasn't persisted yet — the order filled within milliseconds of being
    // placed, beating the DB write. Buffer it; the placing side replays it via
    // replayBufferedFills() once the record exists.
    // NEVER adopt an app order (that stole this trade's fill in the pre-fix bug).
    //
    // BOTH tags qualify:
    //   "TEA-…"  entry orders  → replayed by submitTrade
    //   "EXIT-…" exit orders   → replayed by exitTrade
    // Exits were missing here, so a fast exit fill was dropped and the trade
    // kept the price the app had assumed (its own LTP) instead of the broker's.
    // Observed 2026-07-23: Dhan filled at 145.95, app recorded 146.45 — the fill
    // event landed 6ms BEFORE the close persisted, so correctExitFill (which
    // already existed and works) never found the trade to correct.
    if (
      (update.status === "FILLED" || update.status === "PARTIALLY_FILLED") &&
      (update.correlationId?.startsWith("TEA-") || update.correlationId?.startsWith("EXIT-"))
    ) {
      const now = Date.now();
      // Purge orphaned buffers (submitTrade threw after placeOrder → never drained).
      for (const [oid, evs] of Array.from(this.earlyFills.entries())) {
        const fresh = evs.filter(
          (e: { event: BrokerOrderEvent; at: number }) =>
            now - e.at < PortfolioAgentImpl.EARLY_FILL_TTL_MS,
        );
        if (fresh.length === 0) this.earlyFills.delete(oid);
        else if (fresh.length !== evs.length) this.earlyFills.set(oid, fresh);
      }
      const buf = this.earlyFills.get(update.orderId) ?? [];
      buf.push({ event: update, at: now });
      this.earlyFills.set(update.orderId, buf);
      log.important(
        `early app-fill buffered order=${update.orderId} corr=${update.correlationId} ` +
          `— awaiting trade persist (${buf.length} queued)`,
      );
      return { matched: false };
    }

    // ── External-order adoption ───────────────────────────────────────────
    // A fill from the PRIMARY account that matched no local trade (entry or
    // exit) was placed outside the app — mirror it via position netting. Primary
    // account only; the secondary/live (spouse/TFA) account stays off-limits.
    if (
      update.status === "FILLED" &&
      update.brokerId === "dhan-primary-ac" &&
      !!update.securityId &&
      !!update.transactionType &&
      update.averagePrice > 0
    ) {
      return await this.adoptExternalFill(update);
    }

    return { matched: false };
  }

  /**
   * Replay any early app-fills buffered for this broker order id. Called by
   * submitTrade the instant its trade record is persisted, closing the
   * fill-beats-persist race: the buffered fill now finds its trade via the
   * normal entry-match path (promote PENDING → OPEN, correct entry price/qty).
   * No-op when nothing was buffered (the common, non-racing case).
   */
  async replayBufferedFills(orderId: string): Promise<void> {
    const buf = this.earlyFills.get(orderId);
    if (!buf || buf.length === 0) return;
    this.earlyFills.delete(orderId);
    log.important(`replaying ${buf.length} buffered fill(s) for order=${orderId}`);
    for (const { event } of buf) {
      try {
        await this.applyBrokerOrderEvent(event);
      } catch (err) {
        log.warn(`replay of buffered fill order=${orderId} failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Internal: after every close, evaluate whether the day's combined P&L
   * crosses the target threshold (advance + gift-day cascade) or the
   * clawback threshold (rewind day index, consume previous profits).
   *
   * Mirrors the logic that lives inline in portfolioRouter.exitTrade today.
   * Phase 2 will have this be the only home; the legacy router is removed
   * in TEA Phase 1 commit 6.
   */
  /** The two live books share ONE 250-day staircase (T87). Kept in lockstep. */
  private static readonly LIVE_JOURNEY_CHANNELS: Channel[] = ["live"];

  private async maybeCompleteOrClawback(
    channel: Channel,
    stateBeforeClose: CapitalState,
    day: DayRecord,
  ): Promise<void> {
    // T126 — one live book now, so the "shared staircase, separate wallets" rule
    // that combined two live books into one journey has nothing left to combine.
    // completeOrClawbackLive is kept as the live path (it owns the broker-aware
    // day close); it simply has a single book to work on.
    if (channel === "live") {
      return this.completeOrClawbackLive();
    }
    return this.completeOrClawbackSingle(channel, day);
  }

  /** Single-book day completion / clawback (paper). Advances that book's own
   *  counter when its own P&L clears its own target. */
  private async completeOrClawbackSingle(
    channel: Channel,
    day: DayRecord,
  ): Promise<void> {
    // Re-read state since closeTrade just updated session/cumulative P&L.
    const state = await getCapitalState(channel);

    const completion = checkDayCompletion(day);
    if (completion.complete) {
      const result = completeDayIndex(state, day);
      const newState = await updateCapitalState(channel, {
        tradingPool: result.tradingPool,
        reservePool: result.reservePool,
        currentDayIndex: state.currentDayIndex + 1,
        profitHistory: [...state.profitHistory, result.profitEntry],
      });

      day.status = "COMPLETED";
      day.rating = result.rating;
      await upsertDayRecord(channel, day);

      // The reserve pool's own record: this is the ONLY thing that moves money
      // into Reserve, which is why every book sits at reserve 0 until a day
      // actually completes.
      await recordCapitalEvent({
        channel,
        type: "DAY_COMPLETED",
        amount: day.totalPnl,
        tradingPoolAfter: result.tradingPool,
        reservePoolAfter: result.reservePool,
        tradingDelta: result.profitEntry.tradingPoolShare,
        reserveDelta: result.profitEntry.reservePoolShare,
        note:
          `Day ${day.dayIndex} closed ${day.totalPnl >= 0 ? "+" : ""}` +
          `₹${day.totalPnl.toLocaleString("en-IN")} · ` +
          `₹${result.profitEntry.tradingPoolShare.toLocaleString("en-IN")} to Trading, ` +
          `₹${result.profitEntry.reservePoolShare.toLocaleString("en-IN")} to Reserve`,
        detail: {
          dayIndex: day.dayIndex,
          tradingPoolShare: result.profitEntry.tradingPoolShare,
          reservePoolShare: result.profitEntry.reservePoolShare,
          rating: result.rating,
        },
      });

      if (completion.excessProfit > 0) {
        const gifts = calculateGiftDays(
          completion.excessProfit,
          state.currentDayIndex + 1,
          result.tradingPool,
          state.targetPercent,
          (idx) => result.tradingPool * Math.pow(1 + state.targetPercent / 100, idx - state.currentDayIndex),
          channel,
        );
        for (const giftDay of gifts.giftDays) {
          await upsertDayRecord(channel, giftDay);
        }
        if (gifts.giftDays.length > 0) {
          await updateCapitalState(channel, {
            currentDayIndex: state.currentDayIndex + 1 + gifts.giftDays.length,
            tradingPool: gifts.finalTradingPool,
          });
          // Book row for the pool move the gift cascade just made — without it
          // the passbook would show a balance jump with no line explaining it.
          const giftDelta = Math.round((gifts.finalTradingPool - result.tradingPool) * 100) / 100;
          await recordCapitalEvent({
            channel,
            type: "CAPITAL_ADJUSTED",
            amount: giftDelta,
            tradingPoolAfter: gifts.finalTradingPool,
            reservePoolAfter: result.reservePool,
            tradingDelta: giftDelta,
            reserveDelta: 0,
            note:
              `${gifts.giftDays.length} gift day(s) auto-completed from excess profit — ` +
              `staircase jumps to day ${state.currentDayIndex + 1 + gifts.giftDays.length}`,
            detail: { giftDays: gifts.giftDays.map((g) => g.dayIndex) },
          });
        }
      }
      void newState;
      return;
    }

    // Clawback path — a significant loss eats previous days' banked profits.
    //
    // T96: gated on NO OPEN TRADES, mirroring checkDayCompletion. `day.totalPnl`
    // includes open trades' unrealised P&L (compounding.ts:578), so without this
    // a position temporarily under water triggers a clawback that a recovery
    // never undoes. A day is only judged once everything in it is settled.
    const hasOpen = day.trades.some((t) => t.status === "OPEN");
    if (!hasOpen && day.totalPnl < 0 && Math.abs(day.totalPnl) >= day.targetAmount) {
      const clawback = processClawback(day.totalPnl, state);
      await updateCapitalState(channel, {
        tradingPool: clawback.newTradingPool,
        currentDayIndex: clawback.newDayIndex,
        profitHistory: clawback.updatedHistory,
      });
      // Note: caller (router or TEA) handles deleting consumed day records;
      // PA only updates the in-memory view here.
      const clawDelta = Math.round((clawback.newTradingPool - state.tradingPool) * 100) / 100;
      await recordCapitalEvent({
        channel,
        type: "CLAWBACK",
        amount: clawDelta,
        tradingPoolAfter: clawback.newTradingPool,
        reservePoolAfter: state.reservePool,
        tradingDelta: clawDelta,
        reserveDelta: 0,
        note:
          `Day ${day.dayIndex} loss ₹${Math.abs(day.totalPnl).toLocaleString("en-IN")} ` +
          `clawed back — staircase rewinds to day ${clawback.newDayIndex}`,
        detail: { dayIndex: day.dayIndex, newDayIndex: clawback.newDayIndex },
      });
    }
  }

  /**
   * Shared LIVE journey (T87): live + live climb ONE staircase together but
   * keep SEPARATE capital ("shared staircase, separate wallets"). A live day
   * completes when the COMBINED (live + live) P&L clears the COMBINED target
   * and neither book has an open trade; on completion each account compounds its
   * OWN day profit (75/25) and both counters advance together. A combined loss ≥
   * the combined target claws each account back by its OWN loss and rewinds both
   * counters to the furthest-back point (keeping lockstep).
   *
   * Deferred (follow-up): gift-day SKIPPING on the shared staircase. For now a
   * combined overshoot just advances the staircase one day — the excess still
   * accrues to each pool (each already compounded its own day profit), so no money
   * is lost; the staircase simply climbs one step at a time. Single-book gift-day
   * skipping is unchanged for paper.
   */
  private async completeOrClawbackLive(): Promise<void> {
    const chans = PortfolioAgentImpl.LIVE_JOURNEY_CHANNELS;
    const states = await Promise.all(chans.map((c) => getCapitalState(c)));
    // The two books advance in lockstep, so their indices should match; if they
    // ever drift, use the higher index as the shared day.
    const sharedIdx = Math.max(...states.map((s) => s.currentDayIndex));
    const days = await Promise.all(
      chans.map((c) => getDayRecord(c, sharedIdx).catch(() => null)),
    );

    const decision = checkCombinedDayCompletion(
      days.map((d) => ({
        totalPnl: d?.totalPnl ?? 0,
        targetAmount: d?.targetAmount ?? 0,
        hasOpen: (d?.trades ?? []).some((t) => t.status === "OPEN"),
      })),
    );
    if (decision.status === "none") return;

    // ── Combined completion: each account compounds its OWN profit; counter +1 ──
    if (decision.status === "complete") {
      for (let i = 0; i < chans.length; i++) {
        const c = chans[i];
        const st = states[i];
        const d = days[i];
        if (!d) {
          // Book has no record at the shared day — just keep it in lockstep.
          await updateCapitalState(c, { currentDayIndex: sharedIdx + 1 });
          continue;
        }
        const result = completeDayIndex(st, d);
        d.status = "COMPLETED";
        d.rating = result.rating;
        await upsertDayRecord(c, d);
        await updateCapitalState(c, {
          tradingPool: result.tradingPool,
          reservePool: result.reservePool,
          currentDayIndex: sharedIdx + 1,
          profitHistory: [...st.profitHistory, result.profitEntry],
        });
        // Book row — the live path never wrote one (T104), so live day closes
        // were invisible in the book while paper's showed up.
        await recordCapitalEvent({
          channel: c,
          type: "DAY_COMPLETED",
          amount: d.totalPnl,
          tradingPoolAfter: result.tradingPool,
          reservePoolAfter: result.reservePool,
          tradingDelta: result.profitEntry.tradingPoolShare,
          reserveDelta: result.profitEntry.reservePoolShare,
          note:
            `Day ${d.dayIndex} closed ${d.totalPnl >= 0 ? "+" : ""}` +
            `₹${d.totalPnl.toLocaleString("en-IN")} (shared staircase) · ` +
            `₹${result.profitEntry.tradingPoolShare.toLocaleString("en-IN")} to Trading, ` +
            `₹${result.profitEntry.reservePoolShare.toLocaleString("en-IN")} to Reserve`,
          detail: {
            dayIndex: d.dayIndex,
            tradingPoolShare: result.profitEntry.tradingPoolShare,
            reservePoolShare: result.profitEntry.reservePoolShare,
            rating: result.rating,
          },
        });
      }
      return;
    }

    // ── Combined clawback: each account claws its OWN loss; counters rewind ──
    if (decision.status === "clawback") {
      const clawbacks = chans.map((_c, i) => {
        const dayPnl = days[i]?.totalPnl ?? 0;
        // A book that was profitable this day keeps its money; pass 0 loss.
        return processClawback(dayPnl < 0 ? dayPnl : 0, states[i]);
      });
      // Rewind the shared staircase to the furthest-back point either book reached.
      const sharedNewIdx = Math.min(...clawbacks.map((cb) => cb.newDayIndex));
      for (let i = 0; i < chans.length; i++) {
        await updateCapitalState(chans[i], {
          tradingPool: clawbacks[i].newTradingPool,
          currentDayIndex: sharedNewIdx,
          profitHistory: clawbacks[i].updatedHistory,
        });
        // Book row per account, but only where money actually moved — a book
        // that was profitable this day passed 0 loss and keeps its balance.
        const delta = Math.round((clawbacks[i].newTradingPool - states[i].tradingPool) * 100) / 100;
        if (delta !== 0) {
          await recordCapitalEvent({
            channel: chans[i],
            type: "CLAWBACK",
            amount: delta,
            tradingPoolAfter: clawbacks[i].newTradingPool,
            reservePoolAfter: states[i].reservePool,
            tradingDelta: delta,
            reserveDelta: 0,
            note:
              `Combined loss day — ₹${Math.abs(delta).toLocaleString("en-IN")} clawed back, ` +
              `shared staircase rewinds to day ${sharedNewIdx}`,
            detail: { sharedDayIndex: sharedIdx, newDayIndex: sharedNewIdx },
          });
        }
      }
    }
  }

  // ── §7.1 Query APIs ──────────────────────────────────────────

  /** Per spec §7.1 — current portfolio snapshot for a channel. */
  async getState(channel: Channel): Promise<PortfolioSnapshot> {
    const state = await getCapitalState(channel);
    const currentDay = await getDayRecord(channel, state.currentDayIndex);
    return snapshotFromState(channel, state, currentDay);
  }

  /**
   * Per spec §7.1 — open positions for a channel. Phase 2: reads from
   * the position_state collection (not day_records.trades) so a single
   * indexed query returns all open positions across day indices, not
   * just the current day. Returns the data projected back into the
   * legacy TradeRecord shape so callers don't need to migrate.
   */
  async getPositions(channel: Channel): Promise<TradeRecord[]> {
    const positions = await getOpenPositions(channel);
    const records = positions.map(positionDocToTradeRecord);
    if (records.length > 0) {
      await this.overlayLiveFields(channel, positions, records);
    }
    return records;
  }

  /**
   * T86 ③ — the position_state mirror freezes ltp / unrealizedPnl at entry (it's
   * only rewritten on open / close, never per tick). day_records carries the
   * live per-tick values, so overlay them here — every getPositions consumer
   * (RCA, discipline carry-forward, the UI positions endpoint) then sees the
   * CURRENT price, not the frozen entry price that made earlier analysis blind.
   * Also surfaces `lastTickAt`, which positionDocToTradeRecord drops (so RCA's
   * stale-price exit can finally see a real tick timestamp from this path).
   */
  private async overlayLiveFields(
    channel: Channel,
    positions: PositionStateDoc[],
    records: TradeRecord[],
  ): Promise<void> {
    // Open positions are almost always in the current day, but a cross-day
    // orphan can exist — fetch each distinct day once, then index by tradeId.
    const dayIndexes = Array.from(new Set(positions.map((p) => p.dayIndex)));
    const liveById = new Map<string, TradeRecord>();
    for (const dayIndex of dayIndexes) {
      let day: DayRecord | null = null;
      try {
        day = await getDayRecord(channel, dayIndex);
      } catch {
        day = null;
      }
      if (!day) continue;
      for (const t of day.trades) liveById.set(t.id, t);
    }
    for (let i = 0; i < records.length; i++) {
      const live = liveById.get(positions[i].tradeId);
      if (!live) continue; // no day-record twin — keep the mirror's values
      const r = records[i];
      r.ltp = live.ltp;
      r.unrealizedPnl = live.unrealizedPnl;
      r.lastTickAt = live.lastTickAt;
      if (live.peakLtp != null) r.peakLtp = live.peakLtp;
      if (live.stopLossPrice != null) r.stopLossPrice = live.stopLossPrice;
      if (live.targetPrice != null) r.targetPrice = live.targetPrice;
    }
  }

  /**
   * All still-OPEN trades for a channel, read from day_records — the same
   * authoritative source the trading desk renders. Unlike getPositions()
   * (which reads position_state, a collection that lags during the dual-write
   * migration window and can be empty), this never misses a displayed open
   * trade. Used by the startup live-LTP re-subscribe so every open row gets
   * its feed back after a restart.
   */
  async listOpenTrades(channel: Channel): Promise<TradeRecord[]> {
    const state = await getCapitalState(channel);
    const days = await getDayRecords(channel, { from: 1, to: state.currentDayIndex });
    const open: TradeRecord[] = [];
    for (const d of days) {
      for (const t of d.trades) {
        if (t.status === "OPEN") open.push(t);
      }
    }
    return open;
  }

  /**
   * Per spec §7.1 — aggregate performance metrics for a channel.
   * Phase 1: sourced from existing day records. Phase 2 will use
   * portfolio_metrics collection.
   */
  async getMetrics(channel: Channel): Promise<PortfolioMetrics> {
    const state = await getCapitalState(channel);
    const days = await getDayRecords(channel, { from: 1, to: state.currentDayIndex });

    let winCount = 0;
    let lossCount = 0;
    let breakevenCount = 0;
    let cumulativePnl = 0;
    let totalRr = 0;
    let rrSamples = 0;

    for (const d of days) {
      cumulativePnl += d.totalPnl;
      for (const t of d.trades) {
        if (t.status === "OPEN" || t.status === "PENDING" || t.status === "CANCELLED") continue;
        if (t.pnl > 0) winCount += 1;
        else if (t.pnl < 0) lossCount += 1;
        else breakevenCount += 1;
        if (t.targetPrice && t.stopLossPrice && t.entryPrice) {
          const reward = Math.abs(t.targetPrice - t.entryPrice);
          const risk = Math.abs(t.entryPrice - t.stopLossPrice);
          if (risk > 0) {
            totalRr += reward / risk;
            rrSamples += 1;
          }
        }
      }
    }
    const tradeCount = winCount + lossCount + breakevenCount;
    const winRate = tradeCount > 0 ? winCount / tradeCount : 0;

    return {
      channel,
      cumulativePnl,
      maxDrawdown: 0, // TODO Phase 2: track peak + max-drawdown over time
      winRate,
      averageRr: rrSamples > 0 ? totalRr / rrSamples : 0,
      tradeCount,
      winCount,
      lossCount,
      breakevenCount,
    };
  }

  /** Per spec §7.1 — historical day records over a range. */
  async getHistory(
    channel: Channel,
    range?: { from?: number; to?: number; limit?: number },
  ): Promise<DayRecord[]> {
    return getDayRecords(channel, range);
  }

  /**
   * Per spec §10.1 / §5.1 (extended) — daily P&L pull endpoint shape.
   * This is the on-demand read counterpart to the push that PA does into
   * Discipline on every trade close (commit 5 wires the push).
   */
  async getDailyPnl(channel: Channel): Promise<DailyPnlReport> {
    const state = await getCapitalState(channel);
    const day = await getDayRecord(channel, state.currentDayIndex);
    const todayPnl = day?.totalPnl ?? 0;
    const openTrades = (day?.trades ?? []).filter((t) => t.status === "OPEN");
    const dailyUnrealizedPnl = openTrades.reduce((sum, t) => sum + (t.unrealizedPnl ?? 0), 0);
    const openingCapital = state.tradingPool + state.reservePool - todayPnl;
    const dailyRealizedPnlPercent =
      openingCapital > 0 ? (todayPnl / openingCapital) * 100 : 0;

    return {
      channel,
      date: todayIST(),
      openingCapital,
      dailyRealizedPnl: todayPnl,
      dailyRealizedPnlPercent,
      dailyUnrealizedPnl,
      openPositionCount: openTrades.length,
      lastUpdatedAt: day && day.trades.length > 0
        ? Math.max(...day.trades.map((t) => t.closedAt ?? t.openedAt))
        : state.updatedAt,
    };
  }

  // ── §7.1 Mutation APIs ──────────────────────────────────────

  /**
   * Per spec §7.1 / §10.5 — record a newly-placed trade. In Phase 1 the
   * trade is already written to DayRecord.trades by the portfolioRouter
   * placeTrade flow; this method exists as the PA-canonical entry point so
   * future writers (TEA) call PA directly.
   */
  async recordTradePlaced(event: TradePlacedEvent): Promise<void> {
    const { channel, trade } = event;
    log.debug(`recordTradePlaced ${channel} ${trade.id} ${trade.instrument} ${trade.type}`);
    // Phase 1 is informational — capital router has already written the
    // trade. Phase 2 will move ownership of the write here.
  }

  /**
   * Per spec §5.2 — record a trade close with full outcome metadata.
   * Used by the legacy capital exit flow (commit 5 wires it), TEA (future),
   * and the tickHandler's auto-exit on TP/SL (commit 3).
   *
   * Phase 1 implementation:
   *   - Updates the trade record's exitReason / exitTriggeredBy fields.
   *   - Recomputes day aggregates + cumulative P&L (already happens in
   *     portfolioRouter.exitTrade; this is a converged code path).
   *   - Pushes outcome to Discipline (stub in commit 5; activation Phase 3).
   */
  async recordTradeClosed(req: TradeClosedRequest): Promise<TradeClosedResponse> {
    const state = await getCapitalState(req.channel);
    // Normally the trade lives in the current day. But if THIS close completed
    // the day, closeTrade already advanced currentDayIndex (and the new day may
    // not exist yet), so the current index points past the trade's day. Find
    // the day that actually contains the trade, scanning back from the current
    // index; only then fall back to ensuring a current day exists.
    let day = await getDayRecord(req.channel, state.currentDayIndex);
    if (!day || !day.trades.some((t) => t.id === req.tradeId)) {
      const floor = Math.max(0, state.currentDayIndex - 30);
      for (let idx = state.currentDayIndex - 1; idx >= floor; idx--) {
        const candidate = await getDayRecord(req.channel, idx);
        if (candidate?.trades.some((t) => t.id === req.tradeId)) {
          day = candidate;
          break;
        }
      }
    }
    if (!day) {
      // No day record at all (e.g. fresh channel) — ensure one so downstream
      // metrics / discipline don't crash; the metadata stamp below is a no-op.
      day = await this.ensureCurrentDay(req.channel);
    }

    // Locate the trade in its day record + stamp exit metadata ATOMICALLY
    // (T86 β): a positional per-trade write of ONLY the exit-audit fields — never
    // a whole-day overwrite, and it never touches `status`, so it can't revert a
    // completed close back to OPEN (the old exitReason-stamped-but-still-OPEN bug).
    const trade = day.trades.find((t) => t.id === req.tradeId);
    if (trade) {
      trade.exitReason = req.exitReason;
      trade.exitTriggeredBy = req.exitTriggeredBy;
      trade.signalSource = req.signalSource;
      await patchTradeInDay(req.channel, day.dayIndex, req.tradeId, {
        exitReason: req.exitReason,
        exitTriggeredBy: req.exitTriggeredBy,
        signalSource: req.signalSource,
      });
    }

    const positionsRemaining = day.trades.filter((t) => t.status === "OPEN").length;
    const openingCapital = state.tradingPool + state.reservePool - day.totalPnl;
    const dailyPnlPercentUpdated =
      openingCapital > 0 ? (day.totalPnl / openingCapital) * 100 : 0;

    log.info(
      `recordTradeClosed ${req.channel} ${req.tradeId} ${req.exitReason} ` +
      `by ${req.exitTriggeredBy} pnl=${req.realizedPnl} positions_remaining=${positionsRemaining}`,
    );

    // Push outcome into Discipline so its streak / cooldown / circuit-breaker
    // counters track this close. Phase 3 will activate full cap-check feedback.
    // Pass the full canonical TradeClosedEvent (Phase D3) — DA accepts
    // wider shape than it strictly uses, so adding fields here is safe
    // and prevents the historical "subset drop" bug.
    try {
      await disciplineAgent.recordTradeOutcome({
        ...req,
        openingCapital,
      });
    } catch (err) {
      log.warn(`recordTradeOutcome push to Discipline failed (non-fatal): ${(err as Error).message}`);
    }

    return {
      success: true,
      tradeId: req.tradeId,
      dailyPnlUpdated: day.totalPnl,
      dailyPnlPercentUpdated,
      positionsRemaining,
      timestamp: Date.now(),
    };
  }

  /**
   * Per spec §7.1 — record a rejected trade for audit. Phase 2: writes
   * a TRADE_REJECTED event to portfolio_events so the rejection is
   * recoverable from the audit log (forensics + Head-to-Head reporting).
   */
  async recordTradeRejected(event: TradeRejectedEvent): Promise<void> {
    log.warn(
      `recordTradeRejected ${event.channel} ${event.trade.instrument ?? "?"} reason="${event.reason}"`,
    );
    await this.audit("TRADE_REJECTED", event.channel, undefined, {
      instrument: event.trade.instrument,
      reason: event.reason,
    });
  }

  // ── §7.1 Signal APIs ────────────────────────────────────────

  /** Per spec §5.3 — current risk signals. Phase 1 returns stub values;
   *  Phase 3 (Discipline cap-check) will populate. */
  async evaluateExposure(channel: Channel): Promise<RiskSignals> {
    const snap = await this.getState(channel);
    const exposureRatio = snap.currentCapital > 0
      ? snap.openMargin / snap.currentCapital
      : 0;
    return {
      maxExposureBreached: exposureRatio > 0.4, // default 40% from Settings
      drawdownThresholdHit: snap.drawdownPercent > 5, // default 5% (placeholder)
      tradingCapacityLow: snap.availableCapital < snap.currentCapital * 0.1,
      positionConcentrationAlert: snap.positionConcentration > 0.5,
      portfolioHealthScore: 100, // Phase 3 computes
    };
  }

  async evaluateDrawdown(channel: Channel): Promise<{ percent: number; isBreached: boolean }> {
    const snap = await this.getState(channel);
    return { percent: snap.drawdownPercent, isBreached: snap.drawdownPercent > 5 };
  }

  async evaluateHealth(channel: Channel): Promise<{ score: number }> {
    const signals = await this.evaluateExposure(channel);
    return { score: signals.portfolioHealthScore };
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Project a position_state doc back into the legacy TradeRecord shape so
 * existing PA consumers (TEA, RCA, UI) don't need to migrate. Phase 4
 * will retire the TradeRecord type in favour of PositionStateDoc.
 */
function positionDocToTradeRecord(p: PositionStateDoc): TradeRecord {
  return {
    id: p.tradeId,
    instrument: p.instrument,
    type: p.type,
    strike: p.strike,
    expiry: p.expiry,
    contractSecurityId: p.contractSecurityId,
    entryPrice: p.entryPrice,
    exitPrice: p.exitPrice,
    ltp: p.ltp,
    qty: p.qty,
    lotSize: p.lotSize,
    capitalPercent: p.capitalPercent,
    pnl: p.pnl,
    unrealizedPnl: p.unrealizedPnl,
    charges: p.charges,
    chargesBreakdown: p.chargesBreakdown,
    status: p.status,
    targetPrice: p.targetPrice,
    stopLossPrice: p.stopLossPrice,
    trailingStopEnabled: p.trailingStopEnabled,
    peakLtp: p.peakLtp,
    brokerOrderId: p.brokerOrderId,
    brokerId: p.brokerId,
    cohort: p.cohort ?? null,
    manualExitOnly: p.manualExitOnly ?? false,
    exitStrategy: p.exitStrategy ?? "sprint",
    openedAt: p.openedAt,
    closedAt: p.closedAt,
    exitReason: p.exitReason,
    exitTriggeredBy: p.exitTriggeredBy,
    signalSource: p.signalSource,
  };
}

// ─── Singleton ──────────────────────────────────────────────────

export const portfolioAgent = new PortfolioAgentImpl();
