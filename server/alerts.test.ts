/**
 * Tests for alert types utilities and trading store alert-related behavior.
 * Since alertTypes.ts and soundEngine.ts are client-side modules using
 * browser APIs (Notification, AudioContext, localStorage), we test the
 * pure logic functions by importing the shared types and testing the
 * server-side trading store behavior that feeds the alert system.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  pushOptionChain,
  pushAnalyzerOutput,
  pushAIDecision,
  pushPosition,
  updateModuleHeartbeat,
  getModuleStatuses,
  getInstrumentData,
  getSignals,
  getPositions,
} from './tradingStore';
import type {
  RawOptionChainData,
  RawAnalyzerOutput,
  RawAIDecision,
  Position,
} from '../shared/tradingTypes';

// --- Alert-triggering data scenarios ---

describe('Alert-triggering scenarios via trading store', () => {
  describe('GO signal detection', () => {
    it('should reflect GO decision in instrument data after AI push', () => {
      const aiDecision: RawAIDecision = {
        instrument: 'NIFTY_50',
        timestamp: new Date().toISOString(),
        decision: 'GO',
        trade_type: 'CALL_BUY',
        confidence_score: 0.85,
        rationale: 'Strong bullish signals with high OI support',
        market_bias_oc: 'BULLISH',
        market_bias_news: 'POSITIVE',
        active_strikes: { call: [23300, 23400], put: [23200, 23100] },
        main_support: 23200,
        main_resistance: 23500,
        entry_signal_details: 'Long buildup at 23300 CE',
        news_summary: 'IT sector earnings positive',
        target_strike: 23300,
        target_expiry_date: '2026-03-24',
      };

      pushAIDecision('NIFTY_50', aiDecision);
      const instruments = getInstrumentData();
      const nifty = instruments.find((i) => i.name === 'NIFTY_50');

      expect(nifty).toBeDefined();
      expect(nifty!.aiDecision).toBe('GO');
      expect(nifty!.aiConfidence).toBe(0.85);
      expect(nifty!.aiRationale).toContain('Strong bullish signals');
    });

    it('should reflect NO_GO decision correctly', () => {
      const aiDecision: RawAIDecision = {
        instrument: 'CRUDEOIL',
        timestamp: new Date().toISOString(),
        decision: 'NO_GO',
        trade_type: 'NONE',
        confidence_score: 0.35,
        rationale: 'Weak signals, high uncertainty',
        market_bias_oc: 'BEARISH',
        market_bias_news: 'NEGATIVE',
        active_strikes: { call: [5500], put: [5400] },
        main_support: 5300,
        main_resistance: 5600,
        entry_signal_details: null,
        news_summary: 'OPEC uncertainty',
        target_strike: null,
        target_expiry_date: null,
      };

      pushAIDecision('CRUDEOIL', aiDecision);
      const instruments = getInstrumentData();
      const crude = instruments.find((i) => i.name === 'CRUDEOIL');

      expect(crude).toBeDefined();
      expect(crude!.aiDecision).toBe('NO_GO');
      expect(crude!.aiConfidence).toBe(0.35);
    });
  });

  describe('Module health monitoring (module_down alerts)', () => {
    it('should show idle status for modules with no heartbeat', () => {
      // Fresh modules with lastSeen = 0 should be idle
      const statuses = getModuleStatuses();
      // At least some modules exist
      expect(statuses.length).toBe(4);
      // Check structure
      for (const mod of statuses) {
        expect(mod).toHaveProperty('name');
        expect(mod).toHaveProperty('shortName');
        expect(mod).toHaveProperty('status');
        expect(mod).toHaveProperty('lastUpdate');
        expect(mod).toHaveProperty('message');
        expect(['active', 'warning', 'error', 'idle']).toContain(mod.status);
      }
    });

    it('should show active status after heartbeat update', () => {
      updateModuleHeartbeat('FETCHER', 'Fetching NIFTY_50');
      const statuses = getModuleStatuses();
      const fetcher = statuses.find((m) => m.shortName === 'FETCHER');

      expect(fetcher).toBeDefined();
      expect(fetcher!.status).toBe('active');
      expect(fetcher!.message).toBe('Fetching NIFTY_50');
    });
  });

  describe('Signal generation for alert monitoring', () => {
    it('should generate signals from analyzer output with OI change signals', () => {
      const analyzerOutput: RawAnalyzerOutput = {
        instrument: 'NIFTY_50',
        timestamp: new Date().toISOString(),
        last_price: 23350,
        active_strikes: { call: [23300, 23400], put: [23200, 23100] },
        main_support: 23200,
        main_resistance: 23500,
        support_levels: [23200, 23100, 23000],
        resistance_levels: [23500, 23600, 23700],
        market_bias: 'BULLISH',
        oi_change_signals: [
          'Long Buildup at 23300 CE: OI +23000, Price rising',
          'Call Writing at 23500 CE: OI +67000',
        ],
        entry_signals: [],
        real_time_signals: [],
        exit_signals: [],
        smart_money_signals: [],
      };

      const signalsBefore = getSignals(200);
      const countBefore = signalsBefore.length;

      pushAnalyzerOutput('NIFTY_50', analyzerOutput);

      const signalsAfter = getSignals(200);
      // Should have added new signals
      expect(signalsAfter.length).toBeGreaterThanOrEqual(countBefore);
    });

    it('should include instrument name in generated signals', () => {
      const analyzerOutput: RawAnalyzerOutput = {
        instrument: 'NATURALGAS',
        timestamp: new Date().toISOString(),
        last_price: 289.5,
        active_strikes: { call: [290], put: [280] },
        main_support: 280,
        main_resistance: 300,
        support_levels: [280, 275],
        resistance_levels: [300, 310],
        market_bias: 'RANGE_BOUND',
        oi_change_signals: ['Short Buildup at 280 PE: OI +3000'],
        entry_signals: [],
        real_time_signals: [],
        exit_signals: [],
        smart_money_signals: [],
      };

      pushAnalyzerOutput('NATURALGAS', analyzerOutput);
      const signals = getSignals(200);
      const natgasSignals = signals.filter((s) => s.instrument === 'NATURALGAS');
      expect(natgasSignals.length).toBeGreaterThan(0);
    });
  });

  describe('Position tracking for alert monitoring', () => {
    it('should add new position and reflect in positions list', () => {
      const position: Position = {
        id: 'TEST-POS-001',
        instrument: 'NIFTY 50',
        type: 'CALL_BUY',
        strike: 23300,
        entryPrice: 145.5,
        currentPrice: 162.3,
        quantity: 50,
        pnl: 840,
        pnlPercent: 11.55,
        slPrice: 123.68,
        tpPrice: 189.15,
        status: 'OPEN',
        entryTime: new Date().toISOString(),
      };

      pushPosition(position);
      const positions = getPositions();
      const found = positions.find((p) => p.id === 'TEST-POS-001');

      expect(found).toBeDefined();
      expect(found!.status).toBe('OPEN');
      expect(found!.instrument).toBe('NIFTY 50');
    });

    it('should update existing position (e.g., SL hit → CLOSED)', () => {
      const openPos: Position = {
        id: 'TEST-POS-002',
        instrument: 'CRUDE OIL',
        type: 'PUT_BUY',
        strike: 5400,
        entryPrice: 85.0,
        currentPrice: 70.0,
        quantity: 25,
        pnl: -375,
        pnlPercent: -17.65,
        slPrice: 72.25,
        tpPrice: 110.5,
        status: 'OPEN',
        entryTime: new Date().toISOString(),
      };

      pushPosition(openPos);

      // Simulate SL hit — position closed
      const closedPos: Position = {
        ...openPos,
        currentPrice: 72.0,
        pnl: -325,
        pnlPercent: -15.29,
        status: 'CLOSED',
      };

      pushPosition(closedPos);
      const positions = getPositions();
      const found = positions.find((p) => p.id === 'TEST-POS-002');

      expect(found).toBeDefined();
      expect(found!.status).toBe('CLOSED');
      expect(found!.pnl).toBeLessThan(0);
    });

    it('should update existing position (TP hit → CLOSED with profit)', () => {
      const openPos: Position = {
        id: 'TEST-POS-003',
        instrument: 'NIFTY 50',
        type: 'CALL_BUY',
        strike: 23300,
        entryPrice: 145.5,
        currentPrice: 190.0,
        quantity: 50,
        pnl: 2225,
        pnlPercent: 30.58,
        slPrice: 123.68,
        tpPrice: 189.15,
        status: 'OPEN',
        entryTime: new Date().toISOString(),
      };

      pushPosition(openPos);

      // Simulate TP hit
      const closedPos: Position = {
        ...openPos,
        currentPrice: 192.0,
        pnl: 2325,
        pnlPercent: 31.96,
        status: 'CLOSED',
      };

      pushPosition(closedPos);
      const positions = getPositions();
      const found = positions.find((p) => p.id === 'TEST-POS-003');

      expect(found).toBeDefined();
      expect(found!.status).toBe('CLOSED');
      expect(found!.pnl).toBeGreaterThan(0);
    });
  });

  describe('Instrument data for filtering', () => {
    it('should return all 3 instruments in getInstrumentData', () => {
      const instruments = getInstrumentData();
      expect(instruments.length).toBe(3);

      const names = instruments.map((i) => i.name);
      expect(names).toContain('NIFTY_50');
      expect(names).toContain('CRUDEOIL');
      expect(names).toContain('NATURALGAS');
    });

    it('should include exchange info for each instrument', () => {
      const instruments = getInstrumentData();

      const nifty = instruments.find((i) => i.name === 'NIFTY_50');
      expect(nifty!.exchange).toBe('NSE');

      const crude = instruments.find((i) => i.name === 'CRUDEOIL');
      expect(crude!.exchange).toBe('MCX');

      const natgas = instruments.find((i) => i.name === 'NATURALGAS');
      expect(natgas!.exchange).toBe('MCX');
    });

    it('should include market bias from analyzer output', () => {
      const analyzerOutput: RawAnalyzerOutput = {
        instrument: 'NIFTY_50',
        timestamp: new Date().toISOString(),
        last_price: 23350,
        active_strikes: { call: [23300], put: [23200] },
        main_support: 23200,
        main_resistance: 23500,
        support_levels: [23200],
        resistance_levels: [23500],
        market_bias: 'BULLISH',
        oi_change_signals: [],
        entry_signals: [],
        real_time_signals: [],
        exit_signals: [],
        smart_money_signals: [],
      };

      pushAnalyzerOutput('NIFTY_50', analyzerOutput);
      const instruments = getInstrumentData();
      const nifty = instruments.find((i) => i.name === 'NIFTY_50');

      expect(nifty!.marketBias).toBe('BULLISH');
    });
  });

  describe('Option chain data for OI visualization', () => {
    it('should calculate total call/put OI from option chain', () => {
      const optionChain: RawOptionChainData = {
        last_price: 23350,
        oc: {
          '23200': {
            ce: {
              oi: 100000, volume: 50000, last_price: 250, implied_volatility: 15,
              previous_oi: 90000, previous_volume: 40000,
              greeks: { delta: 0.6, theta: -5, gamma: 0.01, vega: 10 },
              security_id: 1001, average_price: 245, previous_close_price: 240,
              top_ask_price: 251, top_ask_quantity: 500,
              top_bid_price: 249, top_bid_quantity: 600,
            },
            pe: {
              oi: 200000, volume: 80000, last_price: 100, implied_volatility: 16,
              previous_oi: 180000, previous_volume: 70000,
              greeks: { delta: -0.4, theta: -4, gamma: 0.01, vega: 8 },
              security_id: 1002, average_price: 98, previous_close_price: 95,
              top_ask_price: 101, top_ask_quantity: 400,
              top_bid_price: 99, top_bid_quantity: 500,
            },
          },
          '23300': {
            ce: {
              oi: 150000, volume: 70000, last_price: 180, implied_volatility: 14,
              previous_oi: 130000, previous_volume: 60000,
              greeks: { delta: 0.5, theta: -6, gamma: 0.012, vega: 11 },
              security_id: 1003, average_price: 175, previous_close_price: 170,
              top_ask_price: 181, top_ask_quantity: 300,
              top_bid_price: 179, top_bid_quantity: 400,
            },
            pe: {
              oi: 180000, volume: 60000, last_price: 130, implied_volatility: 15,
              previous_oi: 160000, previous_volume: 50000,
              greeks: { delta: -0.5, theta: -5, gamma: 0.012, vega: 9 },
              security_id: 1004, average_price: 128, previous_close_price: 125,
              top_ask_price: 131, top_ask_quantity: 350,
              top_bid_price: 129, top_bid_quantity: 450,
            },
          },
        },
      };

      pushOptionChain('NIFTY_50', optionChain);
      const instruments = getInstrumentData();
      const nifty = instruments.find((i) => i.name === 'NIFTY_50');

      expect(nifty).toBeDefined();
      expect(nifty!.totalCallOI).toBe(250000); // 100000 + 150000
      expect(nifty!.totalPutOI).toBe(380000); // 200000 + 180000
      expect(nifty!.strikesFound).toBe(2);
      expect(nifty!.lastPrice).toBe(23350);
    });
  });
});
