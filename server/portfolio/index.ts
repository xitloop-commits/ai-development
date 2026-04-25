/**
 * Portfolio module — public exports.
 *
 * The PortfolioAgent (`portfolioAgent`) is the single source of truth
 * for portfolio state per PortfolioAgent_Spec_v1.1. New consumers should
 * use it; legacy state.ts CRUD helpers remain available during the Phase 1
 * migration window.
 */

export { portfolioAgent } from "./portfolioAgent";

export type {
  PortfolioSnapshot,
  TradeClosedRequest,
  TradeClosedResponse,
  TradePlacedEvent,
  TradeRejectedEvent,
  RiskSignals,
  PortfolioMetrics,
  DailyPnlReport,
  ExitReason,
  ExitTriggeredBy,
} from "./types";

// Storage helpers — kept exported for the migration window. In commit 4
// callers move to portfolioAgent methods; the helpers stay for internal
// use only.
export {
  getCapitalState,
  getDayRecord,
  getDayRecords,
  updateCapitalState,
  upsertDayRecord,
  type Channel,
  type CapitalState,
  type DayRecord,
  type TradeRecord,
} from "./state";
