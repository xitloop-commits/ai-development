import { describe, expect, it } from 'vitest';
import {
  pushOptionChain,
  pushAnalyzerOutput,
  pushAIDecision,
  getInstrumentData,
} from './tradingStore';
import type { SRLevel } from '../shared/tradingTypes';

// Helper: create a minimal option chain with specific strikes
function makeOptionChain(
  ltp: number,
  strikes: Record<string, { ceOI?: number; cePrevOI?: number; peOI?: number; pePrevOI?: number }>
) {
  const oc: Record<string, any> = {};
  for (const [strike, data] of Object.entries(strikes)) {
    oc[strike] = {};
    if (data.ceOI !== undefined) {
      oc[strike].ce = {
        oi: data.ceOI,
        previous_oi: data.cePrevOI ?? data.ceOI,
        volume: 1000,
        implied_volatility: 15,
        last_price: 100,
        greeks: { delta: 0.5, theta: -3 },
      };
    }
    if (data.peOI !== undefined) {
      oc[strike].pe = {
        oi: data.peOI,
        previous_oi: data.pePrevOI ?? data.peOI,
        volume: 1000,
        implied_volatility: 15,
        last_price: 100,
        greeks: { delta: -0.5, theta: -3 },
      };
    }
  }
  return { last_price: ltp, oc };
}

describe('S/R Levels generation from trading store', () => {
  // Use NIFTY_50 since getInstrumentData only iterates hardcoded instrument configs
  const INSTRUMENT = 'NIFTY_50';

  it('should generate srLevels from option chain + analyzer data when AI engine has no sr_levels', () => {
    // Push option chain data
    pushOptionChain(INSTRUMENT, makeOptionChain(23350, {
      '22800': { peOI: 430000, pePrevOI: 420000 },
      '22900': { peOI: 560000, pePrevOI: 590000 },
      '23000': { peOI: 1200000, pePrevOI: 1070000 },
      '23100': { peOI: 890000, pePrevOI: 750000 },
      '23200': { peOI: 450000, pePrevOI: 474000 },
      '23500': { ceOI: 670000, cePrevOI: 728000 },
      '23600': { ceOI: 1100000, cePrevOI: 1250000 },
      '23700': { ceOI: 850000, cePrevOI: 739000 },
      '23800': { ceOI: 500000, cePrevOI: 485000 },
      '24000': { ceOI: 300000, cePrevOI: 306000 },
    }));

    // Push analyzer output with support/resistance levels
    pushAnalyzerOutput(INSTRUMENT, {
      instrument: INSTRUMENT,
      timestamp: new Date().toISOString(),
      last_price: 23350,
      active_strikes: { call: [23500], put: [23200] },
      main_support: 23100,
      main_resistance: 23600,
      support_levels: [22800, 22900, 23000, 23100, 23200],
      resistance_levels: [23500, 23600, 23700, 23800, 24000],
      market_bias: 'Bullish',
      oi_change_signals: [],
      entry_signals: [],
      real_time_signals: [],
      exit_signals: [],
      smart_money_signals: [],
    });

    // Push AI decision WITHOUT sr_levels (legacy format) but WITH atm_strike
    pushAIDecision(INSTRUMENT, {
      instrument: INSTRUMENT,
      timestamp: new Date().toISOString(),
      decision: 'GO',
      trade_type: 'CALL_BUY',
      confidence_score: 0.78,
      rationale: 'Test rationale',
      market_bias_oc: 'Bullish',
      market_bias_news: 'Neutral',
      active_strikes: { call: [23500], put: [23200] },
      main_support: 23100,
      main_resistance: 23600,
      entry_signal_details: null,
      news_summary: 'Test',
      target_strike: 23500,
      target_expiry_date: '2026-03-24',
      trade_direction: 'GO_CALL',
      atm_strike: 23350,
      ltp: 23350,
    } as any);

    const instruments = getInstrumentData();
    const testInst = instruments.find(i => i.name === INSTRUMENT);
    expect(testInst).toBeDefined();

    const srLevels = testInst!.srLevels;
    expect(srLevels).toBeDefined();
    expect(srLevels!.length).toBeGreaterThanOrEqual(5);

    // Check that we have support, ATM, and resistance levels
    const supportLevels = srLevels!.filter(l => l.type === 'support');
    const atmLevels = srLevels!.filter(l => l.type === 'atm');
    const resistanceLevels = srLevels!.filter(l => l.type === 'resistance');

    expect(supportLevels.length).toBeGreaterThan(0);
    expect(atmLevels.length).toBe(1);
    expect(resistanceLevels.length).toBeGreaterThan(0);

    // ATM level should be at 23350
    expect(atmLevels[0]!.strike).toBe(23350);
    expect(atmLevels[0]!.label).toBe('ATM');
    expect(atmLevels[0]!.barStatus).toBe('atm');
  });

  it('should classify strengthening support (OI increasing)', () => {
    const instruments = getInstrumentData();
    const testInst = instruments.find(i => i.name === INSTRUMENT)!;
    const srLevels = testInst.srLevels!;

    // Strike 23000: peOI 1200000, pePrevOI 1070000 → OI increasing → strengthening
    const s23000 = srLevels.find(l => l.strike === 23000);
    expect(s23000).toBeDefined();
    expect(s23000!.barStatus).toBe('strengthening');
    expect(s23000!.oiChangeAbs).toBeGreaterThan(0);
    expect(s23000!.activityLabel).toBe('Sellers Entering');
    expect(s23000!.technicalLabel).toBe('Short Buildup');
  });

  it('should classify weakening support (OI decreasing)', () => {
    const instruments = getInstrumentData();
    const testInst = instruments.find(i => i.name === INSTRUMENT)!;
    const srLevels = testInst.srLevels!;

    // Strike 22900: peOI 560000, pePrevOI 590000 → OI decreasing → weakening
    const s22900 = srLevels.find(l => l.strike === 22900);
    expect(s22900).toBeDefined();
    expect(s22900!.barStatus).toBe('weakening');
    expect(s22900!.oiChangeAbs).toBeLessThan(0);
    expect(s22900!.activityLabel).toBe('Sellers Exiting');
    expect(s22900!.technicalLabel).toBe('Short Covering');
  });

  it('should classify weakening resistance (OI decreasing)', () => {
    const instruments = getInstrumentData();
    const testInst = instruments.find(i => i.name === INSTRUMENT)!;
    const srLevels = testInst.srLevels!;

    // Strike 23600: ceOI 1100000, cePrevOI 1250000 → OI decreasing → weakening
    const r23600 = srLevels.find(l => l.strike === 23600);
    expect(r23600).toBeDefined();
    expect(r23600!.barStatus).toBe('weakening');
    expect(r23600!.oiChangeAbs).toBeLessThan(0);
    expect(r23600!.activityLabel).toBe('Sellers Exiting');
  });

  it('should classify strengthening resistance (OI increasing)', () => {
    const instruments = getInstrumentData();
    const testInst = instruments.find(i => i.name === INSTRUMENT)!;
    const srLevels = testInst.srLevels!;

    // Strike 23700: ceOI 850000, cePrevOI 739000 → OI increasing → strengthening
    const r23700 = srLevels.find(l => l.strike === 23700);
    expect(r23700).toBeDefined();
    expect(r23700!.barStatus).toBe('strengthening');
    expect(r23700!.oiChangeAbs).toBeGreaterThan(0);
    expect(r23700!.activityLabel).toBe('Sellers Entering');
    expect(r23700!.technicalLabel).toBe('Call Writing');
  });

  it('should order levels from S5 (farthest support) to R5 (farthest resistance)', () => {
    const instruments = getInstrumentData();
    const testInst = instruments.find(i => i.name === INSTRUMENT)!;
    const srLevels = testInst.srLevels!;

    // Verify ordering: strikes should be ascending
    for (let i = 1; i < srLevels.length; i++) {
      expect(srLevels[i]!.strike).toBeGreaterThanOrEqual(srLevels[i - 1]!.strike);
    }

    // First level should be support, last should be resistance
    expect(srLevels[0]!.type).toBe('support');
    expect(srLevels[srLevels.length - 1]!.type).toBe('resistance');
  });

  it('should compute strength scores between 0 and 100', () => {
    const instruments = getInstrumentData();
    const testInst = instruments.find(i => i.name === INSTRUMENT)!;
    const srLevels = testInst.srLevels!;

    for (const level of srLevels) {
      if (level.type !== 'atm') {
        expect(level.strength).toBeGreaterThanOrEqual(0);
        expect(level.strength).toBeLessThanOrEqual(100);
      }
    }
  });

  it('should have valid trend arrows', () => {
    const instruments = getInstrumentData();
    const testInst = instruments.find(i => i.name === INSTRUMENT)!;
    const srLevels = testInst.srLevels!;

    const validArrows = ['▲▲', '▲', '─', '▼', '▼▼', '●'];
    for (const level of srLevels) {
      expect(validArrows).toContain(level.trendArrow);
    }
  });

  it('should pass through sr_levels from AI engine when available', () => {
    // Use CRUDEOIL for this separate test to avoid state conflict
    const INSTRUMENT2 = 'CRUDEOIL';

    pushOptionChain(INSTRUMENT2, makeOptionChain(100, {
      '90': { peOI: 5000, pePrevOI: 4000 },
      '110': { ceOI: 6000, cePrevOI: 7000 },
    }));

    pushAnalyzerOutput(INSTRUMENT2, {
      instrument: INSTRUMENT2,
      timestamp: new Date().toISOString(),
      last_price: 100,
      active_strikes: { call: [], put: [] },
      main_support: 90,
      main_resistance: 110,
      support_levels: [90],
      resistance_levels: [110],
      market_bias: 'Neutral',
      oi_change_signals: [],
      entry_signals: [],
      real_time_signals: [],
      exit_signals: [],
      smart_money_signals: [],
    });

    // Push AI decision WITH pre-computed sr_levels
    const preComputedLevels: SRLevel[] = [
      {
        strike: 90, label: 'S1', type: 'support', oi: 5000, openOI: 4000,
        oiChangePct: 25, oiChangeAbs: 1000, strength: 80,
        activityLabel: 'Sellers Entering', technicalLabel: 'Short Buildup',
        trend: 'strong_up', trendArrow: '▲▲', barStatus: 'strengthening',
      },
      {
        strike: 100, label: 'ATM', type: 'atm', oi: 0, openOI: 0,
        oiChangePct: 0, oiChangeAbs: 0, strength: 0,
        activityLabel: 'Current Price', technicalLabel: 'LTP',
        trend: 'flat', trendArrow: '●', barStatus: 'atm',
      },
      {
        strike: 110, label: 'R1', type: 'resistance', oi: 6000, openOI: 7000,
        oiChangePct: -14.3, oiChangeAbs: -1000, strength: 25,
        activityLabel: 'Sellers Exiting', technicalLabel: 'Short Covering',
        trend: 'down', trendArrow: '▼', barStatus: 'weakening',
      },
    ];

    pushAIDecision(INSTRUMENT2, {
      instrument: INSTRUMENT2,
      timestamp: new Date().toISOString(),
      decision: 'GO',
      trade_type: 'CALL_BUY',
      confidence_score: 0.65,
      rationale: 'Test',
      market_bias_oc: 'Neutral',
      market_bias_news: 'Neutral',
      active_strikes: { call: [], put: [] },
      main_support: 90,
      main_resistance: 110,
      entry_signal_details: null,
      news_summary: 'Test',
      target_strike: 110,
      target_expiry_date: null,
      sr_levels: preComputedLevels,
      trade_direction: 'GO_CALL',
      atm_strike: 100,
      ltp: 100,
    } as any);

    const instruments = getInstrumentData();
    const inst = instruments.find(i => i.name === INSTRUMENT2);
    expect(inst).toBeDefined();
    expect(inst!.srLevels).toBeDefined();
    // Should use the pre-computed levels directly
    expect(inst!.srLevels).toEqual(preComputedLevels);
  });
});
