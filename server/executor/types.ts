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
  /** Contract lot size. `quantity` is TOTAL UNITS (lots x lotSize); this records
   *  how many units make one lot so the desk can show "10 lots of 65" rather
   *  than guessing. Optional: buildTradeRecord falls back to the scrip master. */
  lotSize?: number;
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

  /** Asset class — "equity" routes the order to NSE_EQ cash (stocks); absent or
   *  "option" keeps the existing option/future routing. */
  assetClass?: "equity" | "option";

  /** Position size as % of available capital, when applicable. */
  capitalPercent?: number;

  /** Strategy cohort (scalp | trend | swing | multi_day_swing) for AI trades —
   *  stamped onto the TradeRecord so P&L can be grouped by strategy. */
  cohort?: string;

  /** Which pluggable exit strategy manages this trade (T84): sprint/runway/anchor.
   *  Set per-twin by the RCA fan-out; defaults to "sprint" in buildTradeRecord. */
  exitStrategy?: "sprint" | "runway" | "anchor" | "glide";

  /** T84 multi-strategy twin: skip TEA's per-submit discipline re-check. The
   *  signal already passed the DA gate once (discipline/routes.ts) before the
   *  fan-out, so the twins aren't re-gated per-twin (else the 2nd/3rd twin's
   *  accumulated exposure would reject it). Option A — twins exempt. */
  skipDisciplinePreCheck?: boolean;

  /** Global daily signal sequence (server-assigned) — shown on the trade row so
   *  it matches its originating tray signal card. */
  signalSeq?: number;

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

// C3: ExitTradeReason aliases shared.ExitReasonCode so DA→RCA→TEA pass
// the same value through the pipeline without per-hop re-typing. The
// literal-union members must stay in sync with shared/exitContracts.ts.
export type ExitTradeReason =
  | "MOMENTUM_EXIT"
  | "VOLATILITY_EXIT"
  | "SL_HIT"
  | "TSL_HIT"
  | "TP_HIT"
  | "AGE_EXIT"
  | "STALE_PRICE_EXIT"
  | "DISCIPLINE_EXIT"
  | "AI_EXIT"
  | "MANUAL"
  | "EOD"
  | "EOD_SQUAREOFF"
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
  reason: "TP_HIT" | "SL_HIT" | "TSL_HIT";
  exitPrice: number;
  /** Always "PA" for tickHandler-driven auto-exits. */
  triggeredBy: Extract<ExitTriggeredBy, "PA">;
  timestamp: number;
}

// ─── Re-exports for consumer convenience ───────────────────────

export type { ExitReason, ExitTriggeredBy };
