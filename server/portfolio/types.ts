/**
 * PortfolioAgent types — implements PortfolioAgent_Spec_v1.1 §5 + §9
 *
 * The Portfolio Agent is the single source of truth for portfolio state.
 * These types describe its public API and internal state model.
 */

import type { Channel, TradeRecord, TradeStatus, ExitReason, ExitTriggeredBy } from "./state";

export type { ExitReason, ExitTriggeredBy };

// ─── §5.1 Portfolio Snapshot ────────────────────────────────────

/**
 * Portfolio snapshot per spec §5.1 — the read model returned by
 * portfolio.getState(channel). Computed (not stored) from CapitalState
 * + open positions in the current DayRecord.
 */
export interface PortfolioSnapshot {
  channel: Channel;

  // Capital
  currentCapital: number;       // tradingPool + reservePool
  availableCapital: number;     // tradingPool − openMargin
  tradingPool: number;
  reservePool: number;
  initialFunding: number;

  // Exposure
  openExposure: number;         // sum of open trade entryPrice × qty
  openMargin: number;           // same as openExposure for option premium
  openPositionCount: number;
  positionConcentration: number; // largest position / openExposure (0..1)

  // P&L
  unrealizedPnl: number;        // MTM of currently open positions
  realizedPnl: number;          // cumulative since day 1
  dailyRealizedPnl: number;     // today's realized P&L (sum of today's closed trades)
  dailyRealizedPnlPercent: number; // dailyRealizedPnl / openingCapital × 100

  // Risk metrics
  drawdownPercent: number;      // current drawdown from peak capital
  winLossStreak: number;        // positive = win streak; negative = loss streak

  // Day index (250-day journey)
  currentDayIndex: number;
  targetPercent: number;
  todayTarget: number;          // tradeCapital × targetPercent / 100
  todayPnl: number;             // current day's totalPnl from DayRecord

  // Forward projection
  netWorth: number;             // tradingPool + reservePool
  quarterlyProjection: { quarterLabel: string; projectedCapital: number } | null;

  lastUpdated: number;
}

// ─── §5.2 Trade Outcome Recording ───────────────────────────────

/**
 * Request payload for portfolio.recordTradeClosed (spec §5.2). Captures
 * who triggered the exit and why — drives Discipline cap-checks +
 * 30-day head-to-head reporting.
 *
 * Canonical shape lives in `shared/tradeClosedEvent.ts` (Phase D3).
 * This alias keeps existing imports working without a rename sweep
 * across the codebase. Same fields, same types — `Channel` is
 * structurally identical to `ChannelCode` (both are the same string
 * union, declared twice for the server-only / shared-by-all split).
 */
export type TradeClosedRequest = import("../../shared/tradeClosedEvent").TradeClosedEvent;

export interface TradeClosedResponse {
  success: boolean;
  tradeId: string;
  dailyPnlUpdated: number;
  dailyPnlPercentUpdated: number;
  positionsRemaining: number;
  timestamp: number;
}

// ─── §5.3 Risk Signals ──────────────────────────────────────────

export interface RiskSignals {
  maxExposureBreached: boolean;
  drawdownThresholdHit: boolean;
  tradingCapacityLow: boolean;       // available capital < threshold
  positionConcentrationAlert: boolean;
  portfolioHealthScore: number;      // 0..100
}

// ─── §5.4 Historical Metrics ────────────────────────────────────

export interface PortfolioMetrics {
  channel: Channel;
  cumulativePnl: number;
  maxDrawdown: number;
  winRate: number;                   // 0..1
  averageRr: number;                 // average reward:risk ratio
  tradeCount: number;
  winCount: number;
  lossCount: number;
  breakevenCount: number;
}

export interface DailyPnlReport {
  channel: Channel;
  date: string;                      // YYYY-MM-DD IST
  openingCapital: number;
  dailyRealizedPnl: number;
  dailyRealizedPnlPercent: number;
  dailyUnrealizedPnl: number;
  openPositionCount: number;
  lastUpdatedAt: number;
}

// ─── Trade lifecycle inputs ─────────────────────────────────────

export interface TradePlacedEvent {
  channel: Channel;
  trade: TradeRecord;
  timestamp: number;
}

export interface TradeRejectedEvent {
  channel: Channel;
  trade: Partial<TradeRecord>;
  reason: string;
  timestamp: number;
}

/**
 * B11-followup 3/3 — broker-emitted lifecycle event applied to local
 * trade state via portfolioAgent.applyBrokerOrderEvent. Same shape as
 * the broker's OrderUpdate; declared here to avoid PA depending on
 * `broker/types`.
 */
export interface BrokerOrderEvent {
  brokerId: string;
  orderId: string;
  /** Mirrors broker/types.OrderStatus. Declared inline to keep PA from
   *  depending on the broker package. Only terminal-ish statuses
   *  (FILLED, CANCELLED, REJECTED, EXPIRED) drive state mutation;
   *  intermediate ones (PENDING, OPEN, PARTIALLY_FILLED) are no-ops. */
  status:
    | "PENDING"
    | "OPEN"
    | "FILLED"
    | "PARTIALLY_FILLED"
    | "CANCELLED"
    | "REJECTED"
    | "EXPIRED";
  filledQuantity: number;
  averagePrice: number;
  timestamp: number;
}

export interface BrokerOrderEventResult {
  matched: boolean;
  channel?: Channel;
  tradeId?: string;
  newStatus?: TradeStatus;
}
