import type { DayRecord, TradeRecord } from '@/lib/tradeTypes';

export const mockOpenTrade: TradeRecord = {
  id: 't-open-1',
  instrument: 'NIFTY 50',
  type: 'CALL_BUY',
  strike: 24300,
  expiry: '2026-05-08',
  contractSecurityId: '12345',
  entryPrice: 271,
  exitPrice: null,
  ltp: 278,
  qty: 75,
  lotSize: 75,
  capitalPercent: 10,
  pnl: 0,
  unrealizedPnl: 525,
  charges: 0,
  chargesBreakdown: [],
  status: 'OPEN',
  targetPrice: 291,
  stopLossPrice: 265,
  trailingStopEnabled: false,
  openedAt: Date.now() - 1000 * 60 * 42,
  closedAt: null,
};

export const mockClosedTpTrade: TradeRecord = {
  ...mockOpenTrade,
  id: 't-tp-1',
  status: 'CLOSED',
  exitReason: 'TP_HIT',
  exitPrice: 291,
  pnl: 1500,
  closedAt: Date.now() - 1000 * 60 * 10,
};

export const mockClosedSlTrade: TradeRecord = {
  ...mockOpenTrade,
  id: 't-sl-1',
  instrument: 'BANK NIFTY',
  status: 'CLOSED',
  exitReason: 'SL_HIT',
  entryPrice: 587,
  exitPrice: 572,
  pnl: -1125,
  closedAt: Date.now() - 1000 * 60 * 20,
};

export const mockShortTrade: TradeRecord = {
  ...mockOpenTrade,
  id: 't-short-1',
  instrument: 'CRUDE OIL',
  type: 'PUT_SELL',
  strike: 8650,
  entryPrice: 145,
  ltp: 132,
  unrealizedPnl: 975,
};

export function makeDay(overrides: Partial<DayRecord> = {}): DayRecord {
  const base: DayRecord = {
    dayIndex: 3,
    date: '2026-04-17',
    tradeCapital: 10893,
    targetPercent: 5,
    targetAmount: 545,
    projCapital: 11438,
    originalProjCapital: 11438,
    actualCapital: 11213,
    deviation: -225,
    trades: [],
    totalPnl: 320,
    totalCharges: 12,
    totalQty: 75,
    instruments: ['NIFTY 50'],
    status: 'COMPLETED',
    rating: 'star',
    openedAt: Date.now() - 1000 * 60 * 60 * 4,
  };
  return { ...base, ...overrides };
}

export const mockGreenDay = makeDay({ totalPnl: 680, rating: 'trophy' });
export const mockRedDay = makeDay({ totalPnl: -240, actualCapital: 10653, deviation: -785, rating: 'star' });
export const mockGiftDay = makeDay({ dayIndex: 12, totalPnl: 2700, rating: 'gift', instruments: ['CRUDE OIL', 'NATURAL GAS'] });
export const mockJackpotDay = makeDay({ dayIndex: 27, totalPnl: 5480, rating: 'jackpot', actualCapital: 16373 });
export const mockEmptyDay = makeDay({ dayIndex: 4, trades: [], totalPnl: 0, totalCharges: 0, instruments: [], status: 'ACTIVE', rating: 'future', actualCapital: 0 });
export const mockFutureDay = makeDay({ dayIndex: 150, status: 'FUTURE', rating: 'future', tradeCapital: 55210, targetAmount: 2760, projCapital: 57970, actualCapital: 0, totalPnl: 0 });