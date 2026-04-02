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

  // Enhanced news sentiment
  newsDetail?: NewsDetail | null;
  newsEventFlags?: string[];

  // Opening OI snapshot
  openingSnapshot?: {
    capturedAt: string;
    openingLtp: number;
  } | null;
  srIntradayLevels?: SRIntradayLevel[];

  // Enhanced fields from v2 AI engine
  srLevels?: SRLevel[];    // S/R Strength Line data (S5..ATM..R5)
  tradeDirection?: 'GO_CALL' | 'GO_PUT' | 'WAIT';
  atmStrike?: number;
  supportAnalysis?: WallAnalysis;
  resistanceAnalysis?: WallAnalysis;
  ivAssessment?: IVAssessment;
  thetaAssessment?: ThetaAssessment;
  tradeSetup?: TradeSetup | null;
  riskFlags?: RiskFlag[];
  scoringFactors?: Record<string, ScoringFactor>;

  // v2.4 Filter results
  filters?: TradeFilters;
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

/** S/R Level detail for the horizontal strength line visualization */
export interface SRLevel {
  strike: number;
  label: string;           // 'S5','S4','S3','S2','S1','ATM','R1','R2','R3','R4','R5'
  type: 'support' | 'atm' | 'resistance';
  oi: number;              // Current OI (put OI for support, call OI for resistance)
  openOI: number;          // OI at market open (9:15 AM snapshot)
  oiChangePct: number;     // Intraday % change since open
  oiChangeAbs: number;     // Absolute OI change since open
  strength: number;        // 0-100 wall strength
  activityLabel: string;   // Layman label: 'Buyers Entering', 'Sellers Exiting', etc.
  technicalLabel: string;  // Technical label: 'Long Buildup', 'Short Covering', etc.
  trend: 'strong_up' | 'up' | 'flat' | 'down' | 'strong_down';
  trendArrow: string;      // '▲▲' | '▲' | '─' | '▼' | '▼▼'
  prediction?: 'BOUNCE' | 'BREAKOUT' | 'BREAKDOWN' | 'UNCERTAIN';
  predictionProbability?: number; // 0-100
  barStatus: 'strengthening' | 'weakening' | 'stable' | 'atm';
}

/** Enhanced news sentiment detail */
export interface NewsArticle {
  title: string;
  source: string;
  score: number; // net sentiment score
}

export interface NewsDetail {
  sentiment: string;
  strength: string;
  confidence: number;
  total_articles: number;
  bull_score: number;
  bear_score: number;
  net_score: number;
  queries_used: number;
  event_flags: string[];
  top_articles: NewsArticle[];
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

/** Upcoming market event */
export interface MarketEvent {
  label: string;
  date: string;  // 'Today', 'Tomorrow', 'In 2 days', or ISO date
  category: string;
}

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

/** S/R Intraday Level from the opening OI snapshot analysis */
export interface SRIntradayLevel {
  strike: number;
  type: 'support' | 'atm' | 'resistance';
  call_oi: number;
  put_oi: number;
  opening_call_oi: number;
  opening_put_oi: number;
  call_oi_intraday_change: number;
  put_oi_intraday_change: number;
  call_change_pct: number;
  put_change_pct: number;
  call_activity: string;
  put_activity: string;
  relevant_oi: number;
  wall_strength: number;
  is_atm: boolean;
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

  // Opening OI snapshot data
  opening_snapshot?: {
    captured_at: string;
    opening_ltp: number;
  } | null;
  sr_intraday_levels?: SRIntradayLevel[];
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

/** Sideways market detection result */
export interface SidewaysDetection {
  is_sideways: boolean;
  signals_triggered: number;
  threshold: number;
  details: string[];
}

/** Trap market detection result */
export interface TrapDetection {
  is_trap: boolean;
  trap_types: string[];  // e.g. 'FALSE_BREAKOUT', 'OI_CONTRADICTION', 'SIGNAL_DIVERGENCE'
  details: string[];
}

/** Bounce/Breakdown classification result */
export interface BounceBreakdown {
  setup_type: 'BOUNCE_SUPPORT' | 'BOUNCE_RESISTANCE' | 'BREAKDOWN_SUPPORT' | 'BREAKOUT_RESISTANCE' | 'NEUTRAL';
  aligned: boolean;
  required_direction: 'GO_CALL' | 'GO_PUT' | null;
  detail: string;
}

/** Quality gate result */
export interface QualityGate {
  passed: boolean;
  blocked_by: string[];  // e.g. 'LOW_CONFIDENCE', 'SR_MISALIGNED', 'TRAP_DETECTED', 'LATE_SESSION', 'LOW_DTE'
  details: string[];
}

/** Combined filter results from AI Engine v2.4 */
export interface TradeFilters {
  original_direction: 'GO_CALL' | 'GO_PUT' | 'WAIT';
  filter_blocked: boolean;
  rejection_reasons: string[];
  sideways_detection: SidewaysDetection;
  trap_detection: TrapDetection;
  bounce_breakdown: BounceBreakdown;
  quality_gate: QualityGate;
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

  // Enhanced news sentiment
  news_detail?: NewsDetail;

  // Enhanced fields from v2 AI engine
  sr_levels?: SRLevel[];   // S/R Strength Line data (S5..ATM..R5)
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

  // v2.4 Filter results
  filters?: TradeFilters;
}

/** Payload shape for the data push API */
export interface TradingDataPayload {
  instrument: string;
  optionChain?: RawOptionChainData;
  analyzerOutput?: RawAnalyzerOutput;
  aiDecision?: RawAIDecision;
}
