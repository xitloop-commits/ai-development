/**
 * Trade Executor Agent — public exports.
 *
 * The `tradeExecutor` singleton is the single entry point for all trade
 * intent in the system. Every other module (UI, RCA, SEA, AI Engine)
 * submits trades via tRPC `executor.*` or directly via this singleton's
 * methods. No other module is permitted to call brokerService.placeOrder /
 * modifyOrder / cancelOrder.
 */

export { tradeExecutor } from "./tradeExecutor";
export { executorRouter } from "./router";

export type {
  SubmitTradeRequest,
  SubmitTradeResponse,
  ModifyOrderRequest,
  ModifyOrderResponse,
  ExitTradeRequest,
  ExitTradeResponse,
  RecordAutoExitRequest,
  TradeOrigin,
  ExitTradeReason,
  ModificationReason,
  TrailingStopLoss,
  SubmitStatus,
} from "./types";
