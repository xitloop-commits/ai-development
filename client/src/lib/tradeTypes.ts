/**
 * Shared types and constants for the TradingDesk table and its row components.
 *
 * Canonical state vocabulary (BSA v1.8):
 *   workspace ∈ { ai, my, testing }
 *   mode      ∈ { live, paper, sandbox }   (sandbox only on testing)
 *   channel   = `${workspace}-${mode}`     // 6 valid combinations
 *
 * `channel` is the single source of truth on the wire and in storage.
 */

export type Workspace = 'ai' | 'my' | 'testing';
export type Mode = 'live' | 'paper' | 'sandbox';

export type Channel =
  | 'ai-live'
  | 'ai-paper'
  | 'my-live'
  | 'my-paper'
  | 'testing-live'
  | 'testing-sandbox';

export const ALL_CHANNELS: readonly Channel[] = [
  'ai-live',
  'ai-paper',
  'my-live',
  'my-paper',
  'testing-live',
  'testing-sandbox',
] as const;

/** Default mode for each workspace tab on first launch (paper/sandbox = safer side). */
export const DEFAULT_CHANNEL_FOR_WORKSPACE: Record<Workspace, Channel> = {
  ai: 'ai-paper',
  my: 'my-paper',
  testing: 'testing-sandbox',
};

/** First-launch landing channel (testing-sandbox during dev). */
export const DEFAULT_LANDING_CHANNEL: Channel = 'testing-sandbox';

export function channelToWorkspace(channel: Channel): Workspace {
  return channel.split('-')[0] as Workspace;
}

export function channelToMode(channel: Channel): Mode {
  return channel.split('-')[1] as Mode;
}

export function channelOf(workspace: Workspace, mode: Mode): Channel {
  return `${workspace}-${mode}` as Channel;
}

export function isLiveChannel(channel: Channel): boolean {
  return channelToMode(channel) === 'live';
}

export function isPaperChannel(channel: Channel): boolean {
  const mode = channelToMode(channel);
  return mode === 'paper' || mode === 'sandbox';
}

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
