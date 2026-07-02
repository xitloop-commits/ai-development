/**
 * Shared types and constants for the TradingDesk table and its row components.
 *
 * Canonical state vocabulary (BSA v1.8):
 *   workspace ∈ { ai, my, testing }
 *   mode      ∈ { live, paper }            (testing is live-only)
 *   channel   = `${workspace}-${mode}`     // 5 valid combinations
 *
 * `channel` is the single source of truth on the wire and in storage.
 */

export type Workspace = 'ai' | 'my' | 'testing';
export type Mode = 'live' | 'paper';

export type Channel =
  | 'ai-live'
  | 'ai-paper'
  | 'my-live'
  | 'my-paper'
  | 'testing-live';

export const ALL_CHANNELS: readonly Channel[] = [
  'ai-live',
  'ai-paper',
  'my-live',
  'my-paper',
  'testing-live',
] as const;

/** Default mode for each workspace tab on first launch (paper = safer side; testing is live-only). */
export const DEFAULT_CHANNEL_FOR_WORKSPACE: Record<Workspace, Channel> = {
  ai: 'ai-paper',
  my: 'my-paper',
  testing: 'testing-live',
};

/** First-launch landing channel — Testing workspace (live-only). */
export const DEFAULT_LANDING_CHANNEL: Channel = 'testing-live';

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
  return channelToMode(channel) === 'paper';
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
  /** Strategy cohort (scalp | trend | swing | multi_day_swing) for AI trades;
   *  null/absent for manual trades. Lets the desk group P&L by strategy. */
  cohort?: string | null;
  /** Global daily signal sequence (server-assigned) — shown on the row so it
   *  matches its originating SEA tray-signal card. Null for manual trades. */
  signalSeq?: number | null;
  /** Hold duration in ms (closedAt − openedAt), stamped on close. */
  durationMs?: number | null;
  pnl: number;
  unrealizedPnl: number;
  charges: number;
  chargesBreakdown: { name: string; amount: number }[];
  status: string;
  /** Why a closed trade was closed (TP_HIT / SL_HIT / MOMENTUM_EXIT /
   *  STALE_PRICE_EXIT / VOLATILITY_EXIT / AGE_EXIT / DISCIPLINE_EXIT /
   *  AI_EXIT / MANUAL / EOD / EXPIRY). Drives the closed-pill style in
   *  StatusBadge — TP_HIT shows green ✓ TP, SL_HIT shows red ✗ SL,
   *  anything else renders a neutral CLOSED pill. */
  exitReason?: string;
  /** Broker's reject reason text (Dhan ReasonDescription) when status ===
   *  "REJECTED" — shown as a tooltip on the REJECTED badge. */
  rejectReason?: string;
  targetPrice: number | null;
  stopLossPrice: number | null;
  /** Breakeven price = entry ± round-trip charges per unit, frozen at placement.
   *  The TradeBar floors the trailing stop here and gates activation off it, so
   *  the bar matches the server exactly. Absent on older trades → fall back to
   *  entryPrice. */
  breakevenPrice?: number | null;
  trailingStopEnabled?: boolean;
  /** Peak (BUY) / trough (SELL) LTP since entry — the trailing-stop anchor.
   *  Sent by the server (positionDocToTradeRecord); absent on older trades. */
  peakLtp?: number | null;
  /** Epoch ms when the trailing stop activated — drives the TradeBar's "TSL
   *  running" stopwatch next to the TP. Absent until TSL arms. */
  tslActivatedAt?: number | null;
  openedAt: number;
  closedAt: number | null;
  /**
   * B4: present when a broker mutation (exitTrade / modifyOrder) failed.
   * The TradingDesk row should render a desync indicator + a RECONCILE
   * button that calls executor.reconcileDesync. status=='BROKER_DESYNC'
   * means EXIT-desync (position state in limbo); for MODIFY-desync
   * status stays OPEN but desync is set.
   */
  desync?: {
    kind: 'EXIT' | 'MODIFY';
    reason: string;
    timestamp: number;
    attempted?: { stopLossPrice?: number | null; targetPrice?: number | null };
  };
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

/**
 * The WS exchange segment an option leg trades on. MCX commodities (Crude Oil,
 * Natural Gas) → MCX_COMM; everything else (index options) → NSE_FNO. Accepts
 * any instrument label form ("CRUDE OIL", "CRUDEOIL", "NATURAL GAS", …).
 * Single source of truth — callers must not re-derive this inline.
 */
export function optionExchangeFor(instrument: string): 'MCX_COMM' | 'NSE_FNO' {
  const u = (instrument ?? '').toUpperCase();
  return u.includes('CRUDE') || u.includes('NATURAL') ? 'MCX_COMM' : 'NSE_FNO';
}

/**
 * Fallback strike spacing per instrument, used only when the live
 * `strike_step` hasn't arrived yet. Keyed by instrumentLiveState key
 * ("nifty50" / "banknifty" / "crudeoil" / "naturalgas").
 */
export const FALLBACK_STRIKE_STEP: Record<string, number> = {
  nifty50: 50,
  banknifty: 100,
  crudeoil: 50,
  naturalgas: 5,
};

export interface ResolvedInstrument {
  name: string;
  securityId: string;
  exchange: string;
  mode: string;
}
