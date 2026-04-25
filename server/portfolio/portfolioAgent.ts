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
 * In Phase 1 the underlying storage (capital_state, day_records collections)
 * is reused via state.ts CRUD helpers — PA is the API/behaviour boundary,
 * storage is implementation detail. Phase 2 (separate PR) will introduce
 * PA-owned schemas (portfolio_state, position_state, etc.) per spec §6.3.
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
import {
  TRADING_SPLIT,
  calculateAvailableCapital,
  calculateQuarterlyProjection,
} from "./compounding";
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

  /** Lifecycle hook — called from server startup. tickHandler integration
   *  arrives in commit 3; for now this is a no-op marker. */
  start(): void {
    if (this.started) return;
    this.started = true;
    log.info("Started — Portfolio Agent v1.2 (Phase 1)");
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    log.info("Stopped");
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
   * trade is already written to DayRecord.trades by the legacy capitalRouter
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
   *     capitalRouter.exitTrade; this is a converged code path).
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
      (trade as any).exitReason = req.exitReason;
      (trade as any).exitTriggeredBy = req.exitTriggeredBy;
      (trade as any).signalSource = req.signalSource;
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

    // TODO commit 5: push to /api/discipline/recordTradeOutcome
    // TODO Phase 3: discipline cap-check activation

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
