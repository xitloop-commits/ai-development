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
