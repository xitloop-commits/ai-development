import { describe, it, expect } from 'vitest';
import type { TradeRecord } from '@/lib/tradeTypes';
import {
  tradeMatchesFilter,
  isEmptyTradeFilter,
  EMPTY_TRADE_FILTER,
  type TradeFilter,
} from './TradeFilterBar';

function trade(overrides: Partial<TradeRecord>): TradeRecord {
  return {
    id: 'T1',
    instrument: 'NIFTY 50',
    type: 'CALL_BUY',
    strike: 24000,
    entryPrice: 100,
    exitPrice: null,
    ltp: 100,
    qty: 75,
    capitalPercent: 10,
    pnl: 0,
    unrealizedPnl: 0,
    charges: 0,
    chargesBreakdown: [],
    status: 'OPEN',
    targetPrice: null,
    stopLossPrice: null,
    openedAt: 0,
    closedAt: null,
    ...overrides,
  };
}

const f = (over: Partial<TradeFilter>): TradeFilter => ({ ...EMPTY_TRADE_FILTER, ...over });

describe('tradeMatchesFilter', () => {
  it('empty filter matches everything', () => {
    expect(isEmptyTradeFilter(EMPTY_TRADE_FILTER)).toBe(true);
    expect(tradeMatchesFilter(trade({}), EMPTY_TRADE_FILTER)).toBe(true);
  });

  it('instrument — exact match only', () => {
    expect(tradeMatchesFilter(trade({ instrument: 'NIFTY 50' }), f({ instrument: 'NIFTY 50' }))).toBe(true);
    expect(tradeMatchesFilter(trade({ instrument: 'BANK NIFTY' }), f({ instrument: 'NIFTY 50' }))).toBe(false);
  });

  it('status — OPEN vs CLOSED (EXITED counts as closed)', () => {
    expect(tradeMatchesFilter(trade({ status: 'OPEN' }), f({ status: 'OPEN' }))).toBe(true);
    expect(tradeMatchesFilter(trade({ status: 'CLOSED' }), f({ status: 'OPEN' }))).toBe(false);
    expect(tradeMatchesFilter(trade({ status: 'EXITED' }), f({ status: 'CLOSED' }))).toBe(true);
    expect(tradeMatchesFilter(trade({ status: 'PENDING' }), f({ status: 'CLOSED' }))).toBe(false);
  });

  it('side — CE vs PE from type; stocks (BUY/SELL) match neither', () => {
    expect(tradeMatchesFilter(trade({ type: 'CALL_BUY' }), f({ side: 'CE' }))).toBe(true);
    expect(tradeMatchesFilter(trade({ type: 'PUT_BUY' }), f({ side: 'CE' }))).toBe(false);
    expect(tradeMatchesFilter(trade({ type: 'PUT_SELL' }), f({ side: 'PE' }))).toBe(true);
    expect(tradeMatchesFilter(trade({ type: 'BUY', strike: null }), f({ side: 'CE' }))).toBe(false);
  });

  it('outcome — WIN (pnl>0) vs LOSS (pnl<0); flat/open excluded', () => {
    expect(tradeMatchesFilter(trade({ pnl: 500 }), f({ outcome: 'WIN' }))).toBe(true);
    expect(tradeMatchesFilter(trade({ pnl: -500 }), f({ outcome: 'WIN' }))).toBe(false);
    expect(tradeMatchesFilter(trade({ pnl: -500 }), f({ outcome: 'LOSS' }))).toBe(true);
    expect(tradeMatchesFilter(trade({ pnl: 0 }), f({ outcome: 'LOSS' }))).toBe(false);
  });

  it('cohort — exact match; manual (null cohort) excluded when a cohort is set', () => {
    expect(tradeMatchesFilter(trade({ cohort: 'scalp' }), f({ cohort: 'scalp' }))).toBe(true);
    expect(tradeMatchesFilter(trade({ cohort: 'trend' }), f({ cohort: 'scalp' }))).toBe(false);
    expect(tradeMatchesFilter(trade({ cohort: null }), f({ cohort: 'scalp' }))).toBe(false);
  });

  it('exitStrategy — exact match; missing strategy defaults to sprint', () => {
    expect(tradeMatchesFilter(trade({ exitStrategy: 'runway' }), f({ exitStrategy: 'runway' }))).toBe(true);
    expect(tradeMatchesFilter(trade({ exitStrategy: 'anchor' }), f({ exitStrategy: 'runway' }))).toBe(false);
    // A pre-T84 trade (no exitStrategy) counts as sprint.
    expect(tradeMatchesFilter(trade({ exitStrategy: undefined }), f({ exitStrategy: 'sprint' }))).toBe(true);
    expect(tradeMatchesFilter(trade({ exitStrategy: undefined }), f({ exitStrategy: 'runway' }))).toBe(false);
  });

  it('axes are AND-ed', () => {
    const open_ce = trade({ status: 'OPEN', type: 'CALL_BUY' });
    expect(tradeMatchesFilter(open_ce, f({ status: 'OPEN', side: 'CE' }))).toBe(true);
    expect(tradeMatchesFilter(open_ce, f({ status: 'OPEN', side: 'PE' }))).toBe(false);
  });
});
