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
  getCapitalState,
  getDayRecord,
  getDayRecords,
  upsertDayRecord,
  updateCapitalState,
} from "./state";
import { tickHandler } from "./tickHandler";
import type { AutoExitEvent } from "./tickHandler";
import {
  upsertPosition,
  type PositionStateDoc,
} from "./storage";
import {
  TRADING_SPLIT,
  calculateAvailableCapital,
  calculateQuarterlyProjection,
  createDayRecord,
  recalculateDayAggregates,
  checkSessionReset,
  resetSession,
  checkDayCompletion,
  completeDayIndex,
  calculateGiftDays,
  processClawback,
} from "./compounding";
import { calculateTradeCharges } from "./charges";
import type { ChargeRate } from "./charges";
import { getUserSettings } from "../userSettings";
import { getActiveBrokerConfig } from "../broker/brokerConfig";
import { disciplineEngine } from "../discipline";
import type {
  PortfolioSnapshot,
  TradeClosedRequest,
  TradeClosedResponse,
  TradePlacedEvent,
  TradeRejectedEvent,
  RiskSignals,
  PortfolioMetrics,
  DailyPnlReport,
} from "./types";

const log = createLogger("PortfolioAgent");

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
    drawdownPercent: 0, // TODO — Phase 2 will track peak capital + compute drawdown
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
   * Lifecycle — called from server startup. Boots the internal tickHandler
   * (MTM + auto-exit on TP/SL) under PA's ownership. Idempotent.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    tickHandler.start();
    log.info("Started — Portfolio Agent v1.2 (Phase 1)");
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    tickHandler.stop();
    log.info("Stopped");
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
    const day = await this.ensureCurrentDay(channel);
    day.trades.push(trade);
    const updated = recalculateDayAggregates(day);
    await upsertDayRecord(channel, updated);
    await this.mirrorPosition(channel, updated.dayIndex, trade).catch((err) =>
      log.warn(`mirrorPosition (append) failed for ${trade.id}: ${(err as Error).message}`),
    );
    return updated;
  }

  /**
   * Phase 2 dual-write helper: project a TradeRecord into the
   * position_state collection. Idempotent (upsert keyed on positionId).
   */
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
      trailingStopEnabled: trade.trailingStopEnabled,
      brokerId: trade.brokerId,
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
  async closeTrade(
    channel: Channel,
    tradeId: string,
    exitPrice: number,
    closeStatus: TradeRecord["status"],
  ): Promise<{ trade: TradeRecord; day: DayRecord; pnl: number; charges: number }> {
    const state = await getCapitalState(channel);
    const day = await this.ensureCurrentDay(channel);

    const trade = day.trades.find((t) => t.id === tradeId);
    if (!trade) throw new Error(`Trade not found: ${tradeId}`);
    if (trade.status !== "OPEN" && trade.status !== "PENDING") {
      throw new Error(`Trade already closed: ${tradeId} (status=${trade.status})`);
    }

    // P&L
    const isBuy = trade.type.includes("BUY");
    const direction = isBuy ? 1 : -1;
    const grossPnl = (exitPrice - trade.entryPrice) * trade.qty * direction;

    // Charges
    const settings = await getUserSettings(1);
    const chargeRates = settings.charges.rates as ChargeRate[];
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
    trade.status = closeStatus;

    // Persist day record (with recalculated aggregates)
    const updated = recalculateDayAggregates(day);
    await upsertDayRecord(channel, updated);

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

    return { trade, day: updated, pnl: trade.pnl, charges: charges.total };
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

    if (modifications.stopLossPrice !== undefined) trade.stopLossPrice = modifications.stopLossPrice;
    if (modifications.targetPrice !== undefined) trade.targetPrice = modifications.targetPrice;
    if (modifications.trailingStopEnabled !== undefined) trade.trailingStopEnabled = modifications.trailingStopEnabled;

    await upsertDayRecord(channel, day);
    await this.mirrorPosition(channel, day.dayIndex, trade).catch((err) =>
      log.warn(`mirrorPosition (update) failed for ${trade.id}: ${(err as Error).message}`),
    );
    return { trade, day, oldSL, oldTP };
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
  private async maybeCompleteOrClawback(
    channel: Channel,
    stateBeforeClose: CapitalState,
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
        }
      }
      void newState;
      return;
    }

    // Clawback path — significant loss eats previous days' profits.
    if (day.totalPnl < 0 && Math.abs(day.totalPnl) >= day.targetAmount) {
      const clawback = processClawback(day.totalPnl, state);
      await updateCapitalState(channel, {
        tradingPool: clawback.newTradingPool,
        currentDayIndex: clawback.newDayIndex,
        profitHistory: clawback.updatedHistory,
      });
      // Note: caller (router or TEA) handles deleting consumed day records;
      // PA only updates the in-memory view here.
    }
  }

  // ── §7.1 Query APIs ──────────────────────────────────────────

  /** Per spec §7.1 — current portfolio snapshot for a channel. */
  async getState(channel: Channel): Promise<PortfolioSnapshot> {
    const state = await getCapitalState(channel);
    const currentDay = await getDayRecord(channel, state.currentDayIndex);
    return snapshotFromState(channel, state, currentDay);
  }

  /** Per spec §7.1 — open positions for a channel. */
  async getPositions(channel: Channel): Promise<TradeRecord[]> {
    const state = await getCapitalState(channel);
    const day = await getDayRecord(channel, state.currentDayIndex);
    return (day?.trades ?? []).filter((t) => t.status === "OPEN");
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
    const day = await getDayRecord(req.channel, state.currentDayIndex);
    if (!day) {
      throw new Error(`No active day for channel ${req.channel}`);
    }

    // Locate the trade in today's record + stamp exit metadata
    const trade = day.trades.find((t) => t.id === req.tradeId);
    if (trade) {
      trade.exitReason = req.exitReason;
      trade.exitTriggeredBy = req.exitTriggeredBy;
      trade.signalSource = req.signalSource;
    }
    await upsertDayRecord(req.channel, day);

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
    try {
      await disciplineEngine.recordTradeOutcome({
        channel: req.channel,
        tradeId: req.tradeId,
        realizedPnl: req.realizedPnl,
        openingCapital,
        exitReason: req.exitReason,
        exitTriggeredBy: req.exitTriggeredBy,
        signalSource: req.signalSource,
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

  /** Per spec §7.1 — record a rejected trade for audit. Phase 2 will
   *  persist these; Phase 1 just logs. */
  async recordTradeRejected(event: TradeRejectedEvent): Promise<void> {
    log.warn(
      `recordTradeRejected ${event.channel} ${event.trade.instrument ?? "?"} reason="${event.reason}"`,
    );
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

// ─── Singleton ──────────────────────────────────────────────────

export const portfolioAgent = new PortfolioAgentImpl();
