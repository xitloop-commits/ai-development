/**
 * Shared trading types used by both server and client.
 *
 * (The large analyzer/option-chain UI type set — InstrumentData, ModuleStatus,
 * SupportResistance, ActiveStrike, SRLevel, SRIntradayLevel, News*, RawAnalyzer-
 * Output, TradingDataPayload, TradingMode, MarketEvent — was removed with the
 * legacy FETCHER/ANALYZER pipeline.)
 */

export type SignalType =
  | 'long_buildup'
  | 'short_buildup'
  | 'short_covering'
  | 'long_unwinding'
  | 'call_writing'
  | 'put_writing'
  | 'trap_up'
  | 'trap_down'
  | 'scalp_buy'
  | 'scalp_sell';

export interface Signal {
  id: string;
  timestamp: string;
  instrument: string;
  type: SignalType;
  strike: number;
  description: string;
  severity: 'high' | 'medium' | 'low';
}

export interface Position {
  id: string;
  instrument: string;
  type: 'CALL_BUY' | 'PUT_BUY' | 'CALL_SELL' | 'PUT_SELL';
  strike: number;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  pnl: number;
  pnlPercent: number;
  slPrice: number;
  tpPrice: number;
  status: 'OPEN' | 'CLOSED';
  entryTime: string;
}

/** Market holiday for NSE or MCX */
export interface MarketHoliday {
  date: string;          // ISO date string YYYY-MM-DD
  day: string;           // e.g. 'Monday'
  description: string;   // e.g. 'Republic Day'
  exchange: 'NSE' | 'MCX' | 'BOTH';
  type: 'trading' | 'settlement' | 'both';
  morningSession?: 'open' | 'closed';  // MCX only
  eveningSession?: 'open' | 'closed';  // MCX only
  special?: string;      // e.g. 'Muhurat Trading'
}

/** Shape of the raw option chain JSON from the Dhan API. Consumed by the IV
 *  classifier (carry-forward) — kept though the fetcher that pushed it is gone. */
export interface RawOptionChainData {
  last_price: number;
  oc: Record<string, {
    ce?: {
      oi: number;
      volume: number;
      last_price: number;
      implied_volatility: number;
      previous_oi: number;
      previous_volume: number;
      greeks: { delta: number; theta: number; gamma: number; vega: number };
      security_id: number;
      average_price: number;
      previous_close_price: number;
      top_ask_price: number;
      top_ask_quantity: number;
      top_bid_price: number;
      top_bid_quantity: number;
    };
    pe?: {
      oi: number;
      volume: number;
      last_price: number;
      implied_volatility: number;
      previous_oi: number;
      previous_volume: number;
      greeks: { delta: number; theta: number; gamma: number; vega: number };
      security_id: number;
      average_price: number;
      previous_close_price: number;
      top_ask_price: number;
      top_ask_quantity: number;
      top_bid_price: number;
      top_bid_quantity: number;
    };
  }>;
}
