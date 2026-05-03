/**
 * Canonical TradeClosedEvent — single source of truth for "a trade
 * just closed" across the agent boundary.
 *
 * Per IMPLEMENTATION_PLAN_v2.md §6 D3 (SPEC-58 + SPEC-65):
 *   - PortfolioAgent EMITS this on every closeTrade success
 *     (`portfolioAgent.recordTradeClosed` accepts the same shape)
 *   - DisciplineAgent CONSUMES this via `recordTradeOutcome`
 *     (was previously expecting a subset, dropping fields)
 *   - RiskControlAgent emits the same shape when its exit dispatcher
 *     fires
 *
 * This file lives in `shared/` (not `server/`) so it has zero
 * server-only imports — Python helper code, React UI, and any future
 * cross-language tooling can consume it.
 *
 * The legacy `server/portfolio/types.ts TradeClosedRequest` is now an
 * alias for this type; the field names + types are identical.
 *
 * Field-level invariants:
 *   - `realizedPnlPercent` is a percentage (0..100, can be negative);
 *     not a fraction (0..1).
 *   - `entryTime` / `exitTime` / `timestamp` are epoch milliseconds, UTC.
 *   - `duration` is seconds (`exitTime - entryTime` / 1000, rounded).
 *   - `pnlCategory` is `breakeven` for `realizedPnl === 0`.
 *   - `signalSource` is set by AI / RCA-driven exits (e.g. SEA signal id);
 *     undefined for SL/TP/MANUAL/EOD/EXPIRY/DISCIPLINE-driven exits.
 *   - `exitReason` matches `ExitReasonCode` from
 *     `shared/exitContracts.ts` (the same union DA / RCA / SEA emit).
 */

import type { ChannelCode, ExitReasonCode, ExitTriggeredBy } from "./exitContracts";

export interface TradeClosedEvent {
  channel: ChannelCode;
  tradeId: string;
  instrument: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryTime: number;          // epoch ms (UTC)
  exitTime: number;           // epoch ms (UTC)
  realizedPnl: number;        // absolute, after charges
  realizedPnlPercent: number; // percent of entry capital for this trade
  exitReason: ExitReasonCode;
  exitTriggeredBy: ExitTriggeredBy;
  duration: number;           // seconds
  pnlCategory: "win" | "loss" | "breakeven";
  signalSource?: string;      // SEA signal id / RCA exit kind / etc.
  timestamp: number;          // epoch ms (UTC) — when the event fired
}
