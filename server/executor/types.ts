/**
 * Trade Executor Agent — Public types.
 *
 * Mirrors TradeExecutorAgent_Spec_v1.3 §4 (Inputs) and §5 (Outputs).
 *
 * Channel-aware throughout: instead of the spec's `environment: "paper" | "live"`
 * field, every request carries the canonical `channel` (per BSA v1.9). TEA
 * derives paper-vs-live from the channel suffix.
 */

import type { Channel, ExitReason, ExitTriggeredBy } from "../portfolio/state";

// ─── §4.1 Trade Submission ──────────────────────────────────────

export type TradeOrigin = "RCA" | "AI" | "USER";

export interface TrailingStopLoss {
  enabled: boolean;
  distance: number;       // points (or percent — caller's contract)
  trigger: number;        // point at which TSL begins to trail
}

export interface SubmitTradeRequest {
  /** Idempotency key — TEA rejects duplicates. */
  executionId: string;
  /** Optional caller-supplied trade id; TEA generates one if absent. */
  tradeId?: string;
  channel: Channel;
  origin: TradeOrigin;

  instrument: string;
  direction: "BUY" | "SELL";
  quantity: number;
  entryPrice: number;

  stopLoss: number | null;
  takeProfit: number | null;
  trailingStopLoss?: TrailingStopLoss;

  orderType: "MARKET" | "LIMIT";
  productType: "INTRADAY" | "BO" | "MIS" | "CNC";

  // Option / future contract metadata (carried through to broker mapping).
  optionType?: "CE" | "PE" | "FUT";
  strike?: number;
  expiry?: string;
  contractSecurityId?: string;

  /** Position size as % of available capital, when applicable. */
  capitalPercent?: number;

  timestamp: number;
}

export type SubmitStatus = "PLACED" | "FILLED" | "PARTIAL" | "REJECTED";

export interface SubmitTradeResponse {
  success: boolean;
  executionId: string;
  tradeId: string;
  positionId: string;
  orderId: string | null;
  executedPrice: number | null;
  executedQuantity: number | null;
  status: SubmitStatus;
  error?: string;
  timestamp: number;
}

// ─── §4.2 Modify Order ──────────────────────────────────────────

export type ModificationReason =
  | "MOMENTUM_ADJUSTMENT"
  | "VOLATILITY_ADJUSTMENT"
  | "AI_SIGNAL"
  | "DISCIPLINE_REQUEST"
  | "USER";

export interface ModifyOrderRequest {
  executionId: string;
  positionId: string;
  /**
   * Channel that owns the position. Spec §4.2 doesn't include this field;
   * we add it because PA's day records are partitioned by channel and
   * resolving the channel from positionId alone would require a global
   * scan. RCA / AI know the channel of every position they hold.
   */
  channel: Channel;
  modifications: {
    stopLoss?: number | null;
    takeProfit?: number | null;
    /** Alias for backward compatibility with §4.2 wire shape. */
    stopLossPrice?: number | null;
    targetPrice?: number | null;
    trailingStopLoss?: TrailingStopLoss;
  };
  reason: ModificationReason;
  detail?: string;
  timestamp: number;
}

export interface ModifyOrderResponse {
  success: boolean;
  positionId: string;
  modificationId: string;
  oldSL: number | null;
  newSL: number | null;
  oldTP: number | null;
  newTP: number | null;
  appliedAt: number;
  error?: string;
}

// ─── §4.3 Exit Trade ────────────────────────────────────────────

export type ExitTradeReason =
  | "MOMENTUM_EXIT"
  | "SL_HIT"
  | "TP_HIT"
  | "AGE_EXIT"
  | "DISCIPLINE_EXIT"
  | "AI_EXIT"
  | "MANUAL"
  | "EOD"
  | "EXPIRY";

export interface ExitTradeRequest {
  executionId: string;
  positionId: string;
  channel: Channel;
  exitType: "MARKET" | "LIMIT";
  exitPrice?: number;
  reason: ExitTradeReason;
  triggeredBy: ExitTriggeredBy;
  detail?: string;
  currentPrice?: number;
  currentPnl?: number;
  /** When true, exit every open position on the channel (DISCIPLINE_EXIT use). */
  exitAll?: boolean;
  /** When true, only the listed positions exit (PARTIAL_EXIT use). */
  partialExit?: boolean;
  timestamp: number;
}

export interface ExitTradeResponse {
  success: boolean;
  positionId: string;
  exitId: string;
  exitPrice: number;
  executedQuantity: number;
  realizedPnl: number;
  realizedPnlPct: number;
  exitTime: number;
  error?: string;
}

// ─── PA → TEA internal callback (paper auto-exit on TP/SL) ─────

/**
 * tickHandler in PortfolioAgent watches paper-channel ticks and detects when
 * an open trade hits TP or SL. Instead of writing the close itself, it calls
 * TEA via this internal contract so the single-writer invariant holds.
 *
 * Not exposed via tRPC — server-internal API only.
 */
export interface RecordAutoExitRequest {
  channel: Channel;
  tradeId: string;
  reason: "TP" | "SL";
  exitPrice: number;
  /** Always "PA" for tickHandler-driven auto-exits. */
  triggeredBy: Extract<ExitTriggeredBy, "PA">;
  timestamp: number;
}

// ─── Re-exports for consumer convenience ───────────────────────

export type { ExitReason, ExitTriggeredBy };
