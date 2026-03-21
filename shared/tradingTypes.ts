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

  // Enhanced fields from v2 AI engine
  tradeDirection?: 'GO_CALL' | 'GO_PUT' | 'WAIT';
  atmStrike?: number;
  supportAnalysis?: WallAnalysis;
  resistanceAnalysis?: WallAnalysis;
  ivAssessment?: IVAssessment;
  thetaAssessment?: ThetaAssessment;
  tradeSetup?: TradeSetup | null;
  riskFlags?: RiskFlag[];
  scoringFactors?: Record<string, ScoringFactor>;
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

/** Wall strength analysis for a support or resistance level */
export interface WallAnalysis {
  level: number;
  strength: number; // 0-100
  oi: number;
  oi_change: number;
  oi_change_pct: number;
  volume: number;
  iv: number;
  prediction: 'BREAKOUT' | 'BREAKDOWN' | 'BOUNCE' | 'UNCERTAIN';
  probability: number; // 0-100
  evidence: string[];
}

/** IV assessment */
export interface IVAssessment {
  atm_iv: number;
  assessment: 'CHEAP' | 'FAIR' | 'EXPENSIVE' | 'UNKNOWN';
  detail: string;
}

/** Theta assessment */
export interface ThetaAssessment {
  theta_per_day: number;
  days_to_expiry: number | null;
  warning: string | null;
}

/** Trade setup with entry, target, SL */
export interface TradeSetup {
  direction: 'GO_CALL' | 'GO_PUT';
  strike: number;
  option_type: 'CE' | 'PE';
  entry_price: number;
  target_price: number;
  target_pct: number;
  stop_loss: number;
  sl_pct: number;
  risk_reward: number;
  target_label: string;
  delta: number;
  resistance_level: number;
  support_level: number;
}

/** Risk flag */
export interface RiskFlag {
  type: 'warning' | 'danger';
  text: string;
}

/** Scoring factor detail */
export interface ScoringFactor {
  score: number; // -1 to +1
  weight: number; // 0 to 1
  detail: string;
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

  // Enhanced fields from v2 AI engine
  trade_direction?: 'GO_CALL' | 'GO_PUT' | 'WAIT';
  atm_strike?: number;
  ltp?: number;
  support_analysis?: WallAnalysis;
  resistance_analysis?: WallAnalysis;
  iv_assessment?: IVAssessment;
  theta_assessment?: ThetaAssessment;
  pcr_ratio?: number;
  trade_setup?: TradeSetup | null;
  risk_flags?: RiskFlag[];
  scoring_factors?: Record<string, ScoringFactor>;
}

/** Payload shape for the data push API */
export interface TradingDataPayload {
  instrument: string;
  optionChain?: RawOptionChainData;
  analyzerOutput?: RawAnalyzerOutput;
  aiDecision?: RawAIDecision;
}
