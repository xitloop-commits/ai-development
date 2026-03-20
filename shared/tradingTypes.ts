/**
 * Shared trading types used by both server and client.
 * These define the contract between the Python backend data and the React frontend.
 */

export interface ModuleStatus {
  name: string;
  shortName: string;
  status: 'active' | 'warning' | 'error' | 'idle';
  lastUpdate: string;
  message: string;
}

export interface SupportResistance {
  strike: number;
  callOI: number;
  putOI: number;
  type: 'support' | 'resistance';
}

export interface ActiveStrike {
  strike: number;
  type: 'call' | 'put';
  oi: number;
  oiChange: number;
  volume: number;
  signal: string;
}

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

export interface InstrumentData {
  name: string;
  displayName: string;
  exchange: string;
  expiry: string;
  lastPrice: number;
  marketBias: 'BULLISH' | 'BEARISH' | 'RANGE_BOUND' | 'NEUTRAL';
  aiDecision: 'GO' | 'NO_GO' | 'WAIT';
  aiConfidence: number;
  aiRationale: string;
  supportLevels: SupportResistance[];
  resistanceLevels: SupportResistance[];
  activeStrikes: ActiveStrike[];
  signals: Signal[];
  totalCallOI: number;
  totalPutOI: number;
  pcrRatio: number;
  strikesFound: number;
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

export type TradingMode = 'LIVE' | 'PAPER';

/** Shape of the raw option chain JSON from the Dhan API (fetcher output) */
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

/** Shape of the analyzer output JSON */
export interface RawAnalyzerOutput {
  instrument: string;
  timestamp: string;
  last_price: number;
  active_strikes: {
    call: number[];
    put: number[];
  };
  main_support: number;
  main_resistance: number;
  support_levels: number[];
  resistance_levels: number[];
  market_bias: string;
  oi_change_signals: string[];
  entry_signals: string[];
  real_time_signals: string[];
  exit_signals: string[];
  smart_money_signals: string[];
}

/** Shape of the AI decision output JSON */
export interface RawAIDecision {
  instrument: string;
  timestamp: string;
  decision: string;
  trade_type: string;
  confidence_score: number;
  rationale: string;
  market_bias_oc: string;
  market_bias_news: string;
  active_strikes: {
    call: number[];
    put: number[];
  };
  main_support: number;
  main_resistance: number;
  entry_signal_details: string | null;
  news_summary: string;
  target_strike: number | null;
  target_expiry_date: string | null;
}

/** Payload shape for the data push API */
export interface TradingDataPayload {
  instrument: string;
  optionChain?: RawOptionChainData;
  analyzerOutput?: RawAnalyzerOutput;
  aiDecision?: RawAIDecision;
}
