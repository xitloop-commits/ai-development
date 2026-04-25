/**
 * Shared types and constants for the TradingDesk table and its row components.
 */

export type Workspace = 'live' | 'paper_manual' | 'paper';
export type DayStatus = 'ACTIVE' | 'COMPLETED' | 'GIFT' | 'FUTURE';
export type DayRating =
  | 'trophy'
  | 'double_trophy'
  | 'crown'
  | 'jackpot'
  | 'gift'
  | 'star'
  | 'future'
  | 'finish';

export interface TradeRecord {
  id: string;
  instrument: string;
  type: string;
  strike: number | null;
  expiry?: string | null;
  contractSecurityId?: string | null;
  entryPrice: number;
  exitPrice: number | null;
  ltp: number;
  qty: number;
  lotSize?: number;
  capitalPercent: number;
  pnl: number;
  unrealizedPnl: number;
  charges: number;
  chargesBreakdown: { name: string; amount: number }[];
  status: string;
  targetPrice: number | null;
  stopLossPrice: number | null;
  trailingStopEnabled?: boolean;
  openedAt: number;
  closedAt: number | null;
}

export interface DayRecord {
  dayIndex: number;
  date: string;
  tradeCapital: number;
  targetPercent: number;
  targetAmount: number;
  projCapital: number;
  originalProjCapital: number;
  actualCapital: number;
  deviation: number;
  trades: TradeRecord[];
  totalPnl: number;
  totalCharges: number;
  totalQty: number;
  instruments: string[];
  status: DayStatus;
  rating: DayRating;
  openedAt?: number;
}

export interface CapitalState {
  tradingPool: number;
  reservePool: number;
  currentDayIndex: number;
  targetPercent: number;
  availableCapital: number;
  netWorth: number;
  cumulativePnl: number;
  cumulativeCharges: number;
  todayPnl: number;
  todayTarget: number;
  quarterlyProjection: { quarterLabel: string; projectedCapital: number };
}

export const FALLBACK_CAPITAL: CapitalState = {
  tradingPool: 75000,
  reservePool: 25000,
  currentDayIndex: 1,
  targetPercent: 5,
  availableCapital: 75000,
  netWorth: 100000,
  cumulativePnl: 0,
  cumulativeCharges: 0,
  todayPnl: 0,
  todayTarget: 3750,
  quarterlyProjection: { quarterLabel: 'Q1', projectedCapital: 0 },
};

export const SESSION_INSTRUMENTS = ['NIFTY 50', 'BANK NIFTY', 'CRUDE OIL', 'NATURAL GAS'] as const;

export const UI_TO_RESOLVED: Record<string, string> = {
  'NIFTY 50': 'NIFTY_50',
  'BANK NIFTY': 'BANKNIFTY',
  'CRUDE OIL': 'CRUDEOIL',
  'NATURAL GAS': 'NATURALGAS',
};

export interface ResolvedInstrument {
  name: string;
  securityId: string;
  exchange: string;
  mode: string;
}
