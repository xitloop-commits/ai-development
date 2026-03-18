// Terminal Noir Trading Dashboard — Type Definitions

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

export interface Signal {
  id: string;
  timestamp: string;
  instrument: string;
  type: 'long_buildup' | 'short_buildup' | 'short_covering' | 'long_unwinding' | 'call_writing' | 'put_writing' | 'trap_up' | 'trap_down' | 'scalp_buy' | 'scalp_sell';
  strike: number;
  description: string;
  severity: 'high' | 'medium' | 'low';
}

export interface InstrumentData {
  name: string;
  displayName: string;
  exchange: string;
  expiry: string;
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
