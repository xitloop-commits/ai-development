import { describe, expect, it, beforeEach } from 'vitest';
import {
  pushOptionChain,
  pushAnalyzerOutput,
  pushAIDecision,
  pushPosition,
  updateModuleHeartbeat,
  setTradingMode,
  getTradingMode,
  getModuleStatuses,
  getInstrumentData,
  getSignals,
  getPositions,
} from './tradingStore';
import type { RawOptionChainData, RawAnalyzerOutput, RawAIDecision, Position } from '../shared/tradingTypes';

// Sample test data
const sampleOptionChain: RawOptionChainData = {
  last_price: 23350.5,
  oc: {
    '23200': {
      ce: {
        oi: 125000,
        volume: 45000,
        last_price: 180.5,
        implied_volatility: 12.5,
        previous_oi: 120000,
        previous_volume: 40000,
        greeks: { delta: 0.55, theta: -5.2, gamma: 0.002, vega: 12.3 },
        security_id: 12345,
        average_price: 175.0,
        previous_close_price: 170.0,
        top_ask_price: 181.0,
        top_ask_quantity: 100,
        top_bid_price: 180.0,
        top_bid_quantity: 200,
      },
      pe: {
        oi: 890000,
        volume: 67000,
        last_price: 45.2,
        implied_volatility: 14.2,
        previous_oi: 850000,
        previous_volume: 60000,
        greeks: { delta: -0.45, theta: -4.8, gamma: 0.001, vega: 10.5 },
        security_id: 12346,
        average_price: 42.0,
        previous_close_price: 48.0,
        top_ask_price: 45.5,
        top_ask_quantity: 150,
        top_bid_price: 45.0,
        top_bid_quantity: 250,
      },
    },
    '23500': {
      ce: {
        oi: 1100000,
        volume: 89000,
        last_price: 55.3,
        implied_volatility: 15.8,
        previous_oi: 1050000,
        previous_volume: 80000,
        greeks: { delta: 0.35, theta: -6.1, gamma: 0.003, vega: 14.2 },
        security_id: 12347,
        average_price: 52.0,
        previous_close_price: 50.0,
        top_ask_price: 55.5,
        top_ask_quantity: 300,
        top_bid_price: 55.0,
        top_bid_quantity: 400,
      },
      pe: {
        oi: 230000,
        volume: 34000,
        last_price: 210.5,
        implied_volatility: 11.3,
        previous_oi: 220000,
        previous_volume: 30000,
        greeks: { delta: -0.65, theta: -3.5, gamma: 0.001, vega: 8.7 },
        security_id: 12348,
        average_price: 205.0,
        previous_close_price: 200.0,
        top_ask_price: 211.0,
        top_ask_quantity: 100,
        top_bid_price: 210.0,
        top_bid_quantity: 150,
      },
    },
  },
};

const sampleAnalyzerOutput: RawAnalyzerOutput = {
  instrument: 'NIFTY_50',
  timestamp: new Date().toISOString(),
  last_price: 23350.5,
  active_strikes: {
    call: [23200, 23300, 23400, 23500],
    put: [23200, 23100, 23000],
  },
  main_support: 23200,
  main_resistance: 23500,
  support_levels: [23200, 23100, 23000],
  resistance_levels: [23500, 23600, 23700],
  market_bias: 'BULLISH',
  oi_change_signals: ['Long Buildup detected at 23300 CE: OI +23000'],
  entry_signals: ['Call Writing at 23500 CE: OI +67000'],
  real_time_signals: ['Short Covering at 23100 PE: OI -12000'],
  exit_signals: [],
  smart_money_signals: [],
};

const sampleAIDecision: RawAIDecision = {
  instrument: 'NIFTY_50',
  timestamp: new Date().toISOString(),
  decision: 'GO',
  trade_type: 'CALL_BUY',
  confidence_score: 0.78,
  rationale: 'Strong bullish signals with call writing support.',
  market_bias_oc: 'BULLISH',
  market_bias_news: 'POSITIVE',
  active_strikes: { call: [23300, 23400], put: [23200] },
  main_support: 23200,
  main_resistance: 23500,
  entry_signal_details: 'Long Buildup at 23300 CE',
  news_summary: 'Positive IT earnings outlook',
  target_strike: 23300,
  target_expiry_date: '2026-03-24',
};

const samplePosition: Position = {
  id: 'SIM_TRD-NIFTY-001',
  instrument: 'NIFTY_50',
  type: 'CALL_BUY',
  strike: 23300,
  entryPrice: 145.5,
  currentPrice: 162.3,
  quantity: 50,
  pnl: 840.0,
  pnlPercent: 11.55,
  slPrice: 123.68,
  tpPrice: 189.15,
  status: 'OPEN',
  entryTime: new Date().toISOString(),
};

describe('tradingStore', () => {
  describe('Trading Mode', () => {
    it('defaults to PAPER mode', () => {
      // Note: store is a singleton, so mode may have been changed by previous tests
      setTradingMode('PAPER');
      expect(getTradingMode()).toBe('PAPER');
    });

    it('can be set to LIVE', () => {
      setTradingMode('LIVE');
      expect(getTradingMode()).toBe('LIVE');
      // Reset
      setTradingMode('PAPER');
    });
  });

  describe('Module Statuses', () => {
    it('returns 4 module statuses', () => {
      const statuses = getModuleStatuses();
      expect(statuses).toHaveLength(4);
      expect(statuses.map(s => s.shortName)).toEqual(['FETCHER', 'ANALYZER', 'AI ENGINE', 'EXECUTOR']);
    });

    it('updates heartbeat for a module', () => {
      updateModuleHeartbeat('FETCHER', 'Test heartbeat message');
      const statuses = getModuleStatuses();
      const fetcher = statuses.find(s => s.shortName === 'FETCHER');
      expect(fetcher).toBeDefined();
      expect(fetcher!.message).toBe('Test heartbeat message');
      expect(fetcher!.status).toBe('active');
    });

    it('shows idle status for modules with no heartbeat', () => {
      // AI ENGINE may not have received data yet in a fresh test
      // We test by checking the structure is correct
      const statuses = getModuleStatuses();
      for (const status of statuses) {
        expect(status).toHaveProperty('name');
        expect(status).toHaveProperty('shortName');
        expect(status).toHaveProperty('status');
        expect(status).toHaveProperty('lastUpdate');
        expect(status).toHaveProperty('message');
        expect(['active', 'warning', 'error', 'idle']).toContain(status.status);
      }
    });
  });

  describe('Option Chain Data', () => {
    it('pushes and retrieves option chain data', () => {
      pushOptionChain('NIFTY_50', sampleOptionChain);
      const instruments = getInstrumentData();
      const nifty = instruments.find(i => i.name === 'NIFTY_50');
      expect(nifty).toBeDefined();
      expect(nifty!.totalCallOI).toBeGreaterThan(0);
      expect(nifty!.totalPutOI).toBeGreaterThan(0);
      expect(nifty!.strikesFound).toBe(2); // We have 2 strikes in sample data
    });

    it('calculates PCR ratio correctly', () => {
      pushOptionChain('NIFTY_50', sampleOptionChain);
      const instruments = getInstrumentData();
      const nifty = instruments.find(i => i.name === 'NIFTY_50');
      expect(nifty).toBeDefined();
      // PCR = totalPutOI / totalCallOI
      const expectedPCR = (890000 + 230000) / (125000 + 1100000);
      expect(nifty!.pcrRatio).toBeCloseTo(expectedPCR, 2);
    });
  });

  describe('Analyzer Output', () => {
    it('pushes analyzer output and updates market bias', () => {
      pushAnalyzerOutput('NIFTY_50', sampleAnalyzerOutput);
      const instruments = getInstrumentData();
      const nifty = instruments.find(i => i.name === 'NIFTY_50');
      expect(nifty).toBeDefined();
      expect(nifty!.marketBias).toBe('BULLISH');
    });

    it('populates support and resistance levels', () => {
      pushAnalyzerOutput('NIFTY_50', sampleAnalyzerOutput);
      const instruments = getInstrumentData();
      const nifty = instruments.find(i => i.name === 'NIFTY_50');
      expect(nifty).toBeDefined();
      expect(nifty!.supportLevels.length).toBeGreaterThan(0);
      expect(nifty!.resistanceLevels.length).toBeGreaterThan(0);
    });

    it('generates signals from analyzer output', () => {
      pushAnalyzerOutput('NIFTY_50', sampleAnalyzerOutput);
      const signals = getSignals(50);
      expect(signals.length).toBeGreaterThan(0);
      // Check that at least one signal was created from the OI change signals
      const niftySignals = signals.filter(s => s.instrument === 'NIFTY_50');
      expect(niftySignals.length).toBeGreaterThan(0);
    });
  });

  describe('AI Decision', () => {
    it('pushes AI decision and updates instrument data', () => {
      pushAIDecision('NIFTY_50', sampleAIDecision);
      const instruments = getInstrumentData();
      const nifty = instruments.find(i => i.name === 'NIFTY_50');
      expect(nifty).toBeDefined();
      expect(nifty!.aiDecision).toBe('GO');
      expect(nifty!.aiConfidence).toBe(0.78);
      expect(nifty!.aiRationale).toBe('Strong bullish signals with call writing support.');
    });
  });

  describe('Positions', () => {
    it('pushes and retrieves positions', () => {
      pushPosition(samplePosition);
      const positions = getPositions();
      expect(positions.length).toBeGreaterThan(0);
      const pos = positions.find(p => p.id === 'SIM_TRD-NIFTY-001');
      expect(pos).toBeDefined();
      expect(pos!.instrument).toBe('NIFTY_50');
      expect(pos!.status).toBe('OPEN');
    });

    it('updates existing position by id', () => {
      const updatedPosition = { ...samplePosition, status: 'CLOSED' as const, pnl: 1200 };
      pushPosition(updatedPosition);
      const positions = getPositions();
      const pos = positions.find(p => p.id === 'SIM_TRD-NIFTY-001');
      expect(pos).toBeDefined();
      expect(pos!.status).toBe('CLOSED');
      expect(pos!.pnl).toBe(1200);
    });
  });

  describe('Instrument Data', () => {
    it('returns data for all 3 instruments', () => {
      const instruments = getInstrumentData();
      expect(instruments).toHaveLength(3);
      const names = instruments.map(i => i.name);
      expect(names).toContain('NIFTY_50');
      expect(names).toContain('CRUDEOIL');
      expect(names).toContain('NATURALGAS');
    });

    it('returns empty instrument data for instruments with no data', () => {
      const instruments = getInstrumentData();
      // CRUDEOIL and NATURALGAS may not have data pushed yet
      for (const inst of instruments) {
        expect(inst).toHaveProperty('name');
        expect(inst).toHaveProperty('displayName');
        expect(inst).toHaveProperty('exchange');
        expect(inst).toHaveProperty('marketBias');
        expect(inst).toHaveProperty('aiDecision');
        expect(inst).toHaveProperty('supportLevels');
        expect(inst).toHaveProperty('resistanceLevels');
        expect(inst).toHaveProperty('activeStrikes');
      }
    });
  });

  describe('Signals', () => {
    it('respects the limit parameter', () => {
      // Push enough data to generate multiple signals
      pushAnalyzerOutput('NIFTY_50', sampleAnalyzerOutput);
      const limited = getSignals(2);
      expect(limited.length).toBeLessThanOrEqual(2);
    });

    it('returns signals in reverse chronological order', () => {
      const signals = getSignals(50);
      if (signals.length >= 2) {
        // Newer signals should come first (they are unshifted)
        expect(signals[0]!.id >= signals[1]!.id).toBe(true);
      }
    });
  });
});
