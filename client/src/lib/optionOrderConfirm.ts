/**
 * Shared live-option order confirmation.
 *
 * A LIVE option order fires real money, so it is confirmed before placing.
 * Extracted from useTradingDeskHandlers so every entry point — the desk, the
 * watchlist index rows, anything added later — asks the same question in the
 * same words. Duplicating the wording per call site is how one of them
 * eventually forgets to guard.
 *
 * Paper orders place immediately; stock orders confirm in their own staged-buy
 * flow (TodaySection), so only option trades are guarded here.
 */
import { isLiveChannel, type Channel } from "./tradeTypes";

export interface OptionOrderLike {
  instrument: string;
  /** CALL_BUY / PUT_BUY / CALL_SELL / PUT_SELL / BUY / SELL */
  type: string;
  strike?: number | null;
  entryPrice: number;
  qty: number;
}

/**
 * Confirmation for a LIVE stock (equity) order, or null on paper.
 *
 * Kept beside the option version so both money-facing confirmations live in one
 * place and can be tested. Equity is a separate flow — it carries a share count
 * and MIS/CNC rather than a strike and CE/PE — hence a separate function rather
 * than one over-general helper.
 */
export function liveStockConfirm(
  channel: Channel,
  order: { symbol: string; qty: number; productType: "INTRADAY" | "CNC" },
  entryPrice: number,
): { title: string; message: string } | null {
  if (!isLiveChannel(channel)) return null;
  const value = Math.round(entryPrice * order.qty);
  return {
    title: "Place LIVE stock order?",
    message:
      `BUY ${order.qty} ${order.symbol} ` +
      `(${order.productType === "CNC" ? "Delivery / CNC" : "Intraday / MIS"}) ` +
      `at market ≈ ₹${value.toLocaleString("en-IN")}. ` +
      `This is a REAL order on your live Dhan account.`,
  };
}

/** True when `type` is an option trade (as opposed to an equity BUY/SELL). */
export function isOptionTrade(type: string): boolean {
  return /^(CALL|PUT)_/.test(type);
}

/**
 * The confirmation to show before placing, or null when none is needed
 * (paper channel, or a non-option order).
 */
export function liveOptionConfirm(
  channel: Channel,
  trade: OptionOrderLike,
): { title: string; message: string } | null {
  if (!isLiveChannel(channel) || !isOptionTrade(trade.type)) return null;

  const ceOrPe = trade.type.startsWith("CALL") ? "CE" : "PE";
  const side = trade.type.includes("BUY") ? "BUY" : "SELL";
  const value = Math.round(trade.entryPrice * trade.qty);

  return {
    title: "Place LIVE option order?",
    message:
      `${side} ${trade.instrument} ${trade.strike ?? ""} ${ceOrPe} × ${trade.qty} ` +
      `@ ~₹${value.toLocaleString("en-IN")} premium. This is a REAL order on your live account.`,
  };
}
