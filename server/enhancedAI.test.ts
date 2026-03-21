/**
 * Tests for enhanced AI decision data flow:
 * - Enhanced RawAIDecision fields pass through tradingStore to InstrumentData
 * - Trade direction, wall analysis, trade setup, IV/theta, risk flags, scoring factors
 */
import { describe, expect, it } from 'vitest';
import {
  pushAIDecision,
  pushOptionChain,
  getInstrumentData,
} from './tradingStore';
import type {
  RawAIDecision,
  RawOptionChainData,
} from '../shared/tradingTypes';

// Helper: create a minimal option chain so the instrument has data
function pushMinimalOC(instrument: string, lastPrice: number) {
  const oc: RawOptionChainData = {
    last_price: lastPrice,
    oc: {
      '23300': {
        ce: {
          oi: 100000, volume: 50000, last_price: 180, implied_volatility: 14,
          previous_oi: 90000, previous_volume: 40000,
          greeks: { delta: 0.5, theta: -6, gamma: 0.012, vega: 11 },
          security_id: 1001, average_price: 175, previous_close_price: 170,
          top_ask_price: 181, top_ask_quantity: 300,
          top_bid_price: 179, top_bid_quantity: 400,
        },
        pe: {
          oi: 150000, volume: 60000, last_price: 130, implied_volatility: 15,
          previous_oi: 140000, previous_volume: 50000,
          greeks: { delta: -0.5, theta: -5, gamma: 0.012, vega: 9 },
          security_id: 1002, average_price: 128, previous_close_price: 125,
          top_ask_price: 131, top_ask_quantity: 350,
          top_bid_price: 129, top_bid_quantity: 450,
        },
      },
    },
  };
  pushOptionChain(instrument, oc);
}

describe('Enhanced AI Decision data flow', () => {
  describe('Trade direction pass-through', () => {
    it('should pass GO_CALL trade direction to InstrumentData', () => {
      pushMinimalOC('NIFTY_50', 23350);
      const ai: RawAIDecision = {
        instrument: 'NIFTY_50',
        timestamp: new Date().toISOString(),
        decision: 'GO',
        trade_type: 'CALL_BUY',
        confidence_score: 0.78,
        rationale: 'Strong bullish OI pattern with support building',
        market_bias_oc: 'BULLISH',
        market_bias_news: 'POSITIVE',
        active_strikes: { call: [23300, 23400], put: [23200] },
        main_support: 23200,
        main_resistance: 23500,
        entry_signal_details: 'Long buildup at 23300 CE',
        news_summary: 'Positive earnings',
        target_strike: 23300,
        target_expiry_date: '2026-03-24',
        trade_direction: 'GO_CALL',
        atm_strike: 23350,
        ltp: 23350,
      };

      pushAIDecision('NIFTY_50', ai);
      const instruments = getInstrumentData();
      const nifty = instruments.find(i => i.name === 'NIFTY_50');

      expect(nifty).toBeDefined();
      expect(nifty!.tradeDirection).toBe('GO_CALL');
      expect(nifty!.atmStrike).toBe(23350);
    });

    it('should pass GO_PUT trade direction to InstrumentData', () => {
      pushMinimalOC('CRUDEOIL', 5425);
      const ai: RawAIDecision = {
        instrument: 'CRUDEOIL',
        timestamp: new Date().toISOString(),
        decision: 'GO',
        trade_type: 'PUT_BUY',
        confidence_score: 0.72,
        rationale: 'Bearish breakdown expected below 5400',
        market_bias_oc: 'BEARISH',
        market_bias_news: 'NEGATIVE',
        active_strikes: { call: [5500], put: [5400] },
        main_support: 5400,
        main_resistance: 5500,
        entry_signal_details: 'Short buildup at 5400 PE',
        news_summary: 'OPEC concerns',
        target_strike: 5400,
        target_expiry_date: '2026-03-24',
        trade_direction: 'GO_PUT',
        atm_strike: 5425,
        ltp: 5425,
      };

      pushAIDecision('CRUDEOIL', ai);
      const instruments = getInstrumentData();
      const crude = instruments.find(i => i.name === 'CRUDEOIL');

      expect(crude).toBeDefined();
      expect(crude!.tradeDirection).toBe('GO_PUT');
      expect(crude!.atmStrike).toBe(5425);
    });

    it('should pass WAIT trade direction to InstrumentData', () => {
      pushMinimalOC('NATURALGAS', 290);
      const ai: RawAIDecision = {
        instrument: 'NATURALGAS',
        timestamp: new Date().toISOString(),
        decision: 'WAIT',
        trade_type: 'NONE',
        confidence_score: 0.45,
        rationale: 'Conflicting signals, no clear direction',
        market_bias_oc: 'RANGE_BOUND',
        market_bias_news: 'NEUTRAL',
        active_strikes: { call: [290], put: [280] },
        main_support: 280,
        main_resistance: 300,
        entry_signal_details: null,
        news_summary: 'No major news',
        target_strike: null,
        target_expiry_date: null,
        trade_direction: 'WAIT',
        atm_strike: 290,
        ltp: 290,
      };

      pushAIDecision('NATURALGAS', ai);
      const instruments = getInstrumentData();
      const natgas = instruments.find(i => i.name === 'NATURALGAS');

      expect(natgas).toBeDefined();
      expect(natgas!.tradeDirection).toBe('WAIT');
    });
  });

  describe('Wall analysis pass-through', () => {
    it('should pass support and resistance analysis to InstrumentData', () => {
      pushMinimalOC('NIFTY_50', 23350);
      const ai: RawAIDecision = {
        instrument: 'NIFTY_50',
        timestamp: new Date().toISOString(),
        decision: 'GO',
        trade_type: 'CALL_BUY',
        confidence_score: 0.8,
        rationale: 'Resistance crumbling, breakout likely',
        market_bias_oc: 'BULLISH',
        market_bias_news: 'POSITIVE',
        active_strikes: { call: [23300], put: [23200] },
        main_support: 23200,
        main_resistance: 23500,
        entry_signal_details: null,
        news_summary: '',
        target_strike: 23300,
        target_expiry_date: '2026-03-24',
        trade_direction: 'GO_CALL',
        atm_strike: 23350,
        ltp: 23350,
        support_analysis: {
          level: 23200,
          strength: 75,
          oi: 890000,
          oi_change: 45000,
          oi_change_pct: 5.3,
          volume: 120000,
          iv: 14.2,
          prediction: 'BOUNCE',
          probability: 72,
          evidence: ['Put OI building at 23200', 'Strong volume support'],
        },
        resistance_analysis: {
          level: 23500,
          strength: 35,
          oi: 1100000,
          oi_change: -67000,
          oi_change_pct: -5.7,
          volume: 95000,
          iv: 15.1,
          prediction: 'BREAKOUT',
          probability: 65,
          evidence: ['Call OI unwinding at 23500', 'Resistance weakening'],
        },
      };

      pushAIDecision('NIFTY_50', ai);
      const instruments = getInstrumentData();
      const nifty = instruments.find(i => i.name === 'NIFTY_50');

      expect(nifty!.supportAnalysis).toBeDefined();
      expect(nifty!.supportAnalysis!.level).toBe(23200);
      expect(nifty!.supportAnalysis!.strength).toBe(75);
      expect(nifty!.supportAnalysis!.prediction).toBe('BOUNCE');
      expect(nifty!.supportAnalysis!.probability).toBe(72);

      expect(nifty!.resistanceAnalysis).toBeDefined();
      expect(nifty!.resistanceAnalysis!.level).toBe(23500);
      expect(nifty!.resistanceAnalysis!.strength).toBe(35);
      expect(nifty!.resistanceAnalysis!.prediction).toBe('BREAKOUT');
      expect(nifty!.resistanceAnalysis!.probability).toBe(65);
      expect(nifty!.resistanceAnalysis!.evidence).toContain('Call OI unwinding at 23500');
    });
  });

  describe('Trade setup pass-through', () => {
    it('should pass trade setup with entry/target/SL to InstrumentData', () => {
      pushMinimalOC('NIFTY_50', 23350);
      const ai: RawAIDecision = {
        instrument: 'NIFTY_50',
        timestamp: new Date().toISOString(),
        decision: 'GO',
        trade_type: 'CALL_BUY',
        confidence_score: 0.82,
        rationale: 'Breakout expected',
        market_bias_oc: 'BULLISH',
        market_bias_news: 'POSITIVE',
        active_strikes: { call: [23300], put: [23200] },
        main_support: 23200,
        main_resistance: 23500,
        entry_signal_details: null,
        news_summary: '',
        target_strike: 23350,
        target_expiry_date: '2026-03-24',
        trade_direction: 'GO_CALL',
        atm_strike: 23350,
        ltp: 23350,
        trade_setup: {
          direction: 'GO_CALL',
          strike: 23350,
          option_type: 'CE',
          entry_price: 180,
          target_price: 234,
          target_pct: 30,
          stop_loss: 153,
          sl_pct: 15,
          risk_reward: 2.0,
          target_label: 'Target at resistance breakout 23500',
          delta: 0.5,
          resistance_level: 23500,
          support_level: 23200,
        },
      };

      pushAIDecision('NIFTY_50', ai);
      const instruments = getInstrumentData();
      const nifty = instruments.find(i => i.name === 'NIFTY_50');

      expect(nifty!.tradeSetup).toBeDefined();
      expect(nifty!.tradeSetup!.direction).toBe('GO_CALL');
      expect(nifty!.tradeSetup!.strike).toBe(23350);
      expect(nifty!.tradeSetup!.option_type).toBe('CE');
      expect(nifty!.tradeSetup!.entry_price).toBe(180);
      expect(nifty!.tradeSetup!.target_price).toBe(234);
      expect(nifty!.tradeSetup!.stop_loss).toBe(153);
      expect(nifty!.tradeSetup!.risk_reward).toBe(2.0);
    });

    it('should pass null trade setup when direction is WAIT', () => {
      pushMinimalOC('NATURALGAS', 290);
      const ai: RawAIDecision = {
        instrument: 'NATURALGAS',
        timestamp: new Date().toISOString(),
        decision: 'WAIT',
        trade_type: 'NONE',
        confidence_score: 0.4,
        rationale: 'No clear setup',
        market_bias_oc: 'RANGE_BOUND',
        market_bias_news: 'NEUTRAL',
        active_strikes: { call: [290], put: [280] },
        main_support: 280,
        main_resistance: 300,
        entry_signal_details: null,
        news_summary: '',
        target_strike: null,
        target_expiry_date: null,
        trade_direction: 'WAIT',
        atm_strike: 290,
        ltp: 290,
        trade_setup: null,
      };

      pushAIDecision('NATURALGAS', ai);
      const instruments = getInstrumentData();
      const natgas = instruments.find(i => i.name === 'NATURALGAS');

      expect(natgas!.tradeSetup).toBeNull();
    });
  });

  describe('IV and Theta assessment pass-through', () => {
    it('should pass IV and Theta assessment to InstrumentData', () => {
      pushMinimalOC('NIFTY_50', 23350);
      const ai: RawAIDecision = {
        instrument: 'NIFTY_50',
        timestamp: new Date().toISOString(),
        decision: 'GO',
        trade_type: 'CALL_BUY',
        confidence_score: 0.75,
        rationale: 'IV is cheap, good entry',
        market_bias_oc: 'BULLISH',
        market_bias_news: 'POSITIVE',
        active_strikes: { call: [23300], put: [23200] },
        main_support: 23200,
        main_resistance: 23500,
        entry_signal_details: null,
        news_summary: '',
        target_strike: 23300,
        target_expiry_date: '2026-03-24',
        trade_direction: 'GO_CALL',
        atm_strike: 23350,
        ltp: 23350,
        iv_assessment: {
          atm_iv: 11.2,
          assessment: 'CHEAP',
          detail: 'ATM IV 11.2% is below 20th percentile',
        },
        theta_assessment: {
          theta_per_day: 8.4,
          days_to_expiry: 4,
          warning: null,
        },
      };

      pushAIDecision('NIFTY_50', ai);
      const instruments = getInstrumentData();
      const nifty = instruments.find(i => i.name === 'NIFTY_50');

      expect(nifty!.ivAssessment).toBeDefined();
      expect(nifty!.ivAssessment!.atm_iv).toBe(11.2);
      expect(nifty!.ivAssessment!.assessment).toBe('CHEAP');

      expect(nifty!.thetaAssessment).toBeDefined();
      expect(nifty!.thetaAssessment!.theta_per_day).toBe(8.4);
      expect(nifty!.thetaAssessment!.days_to_expiry).toBe(4);
      expect(nifty!.thetaAssessment!.warning).toBeNull();
    });

    it('should pass theta warning when close to expiry', () => {
      pushMinimalOC('NIFTY_50', 23350);
      const ai: RawAIDecision = {
        instrument: 'NIFTY_50',
        timestamp: new Date().toISOString(),
        decision: 'GO',
        trade_type: 'CALL_BUY',
        confidence_score: 0.65,
        rationale: 'Bullish but theta risk high',
        market_bias_oc: 'BULLISH',
        market_bias_news: 'NEUTRAL',
        active_strikes: { call: [23300], put: [23200] },
        main_support: 23200,
        main_resistance: 23500,
        entry_signal_details: null,
        news_summary: '',
        target_strike: 23300,
        target_expiry_date: '2026-03-24',
        trade_direction: 'GO_CALL',
        atm_strike: 23350,
        ltp: 23350,
        theta_assessment: {
          theta_per_day: 15.6,
          days_to_expiry: 1,
          warning: 'Expiry tomorrow — theta decay accelerating rapidly',
        },
      };

      pushAIDecision('NIFTY_50', ai);
      const instruments = getInstrumentData();
      const nifty = instruments.find(i => i.name === 'NIFTY_50');

      expect(nifty!.thetaAssessment!.warning).toContain('Expiry tomorrow');
      expect(nifty!.thetaAssessment!.days_to_expiry).toBe(1);
    });
  });

  describe('Risk flags pass-through', () => {
    it('should pass risk flags to InstrumentData', () => {
      pushMinimalOC('NIFTY_50', 23350);
      const ai: RawAIDecision = {
        instrument: 'NIFTY_50',
        timestamp: new Date().toISOString(),
        decision: 'GO',
        trade_type: 'CALL_BUY',
        confidence_score: 0.6,
        rationale: 'Bullish with caveats',
        market_bias_oc: 'BULLISH',
        market_bias_news: 'NEUTRAL',
        active_strikes: { call: [23300], put: [23200] },
        main_support: 23200,
        main_resistance: 23500,
        entry_signal_details: null,
        news_summary: '',
        target_strike: 23300,
        target_expiry_date: '2026-03-24',
        trade_direction: 'GO_CALL',
        atm_strike: 23350,
        ltp: 23350,
        risk_flags: [
          { type: 'warning', text: 'Expiry in 2 days — theta decay accelerating' },
          { type: 'danger', text: 'IV elevated — premium may be overpriced' },
        ],
      };

      pushAIDecision('NIFTY_50', ai);
      const instruments = getInstrumentData();
      const nifty = instruments.find(i => i.name === 'NIFTY_50');

      expect(nifty!.riskFlags).toBeDefined();
      expect(nifty!.riskFlags!.length).toBe(2);
      expect(nifty!.riskFlags![0]!.type).toBe('warning');
      expect(nifty!.riskFlags![1]!.type).toBe('danger');
    });
  });

  describe('Scoring factors pass-through', () => {
    it('should pass scoring factors to InstrumentData', () => {
      pushMinimalOC('NIFTY_50', 23350);
      const ai: RawAIDecision = {
        instrument: 'NIFTY_50',
        timestamp: new Date().toISOString(),
        decision: 'GO',
        trade_type: 'CALL_BUY',
        confidence_score: 0.78,
        rationale: 'Strong multi-factor signal',
        market_bias_oc: 'BULLISH',
        market_bias_news: 'POSITIVE',
        active_strikes: { call: [23300], put: [23200] },
        main_support: 23200,
        main_resistance: 23500,
        entry_signal_details: null,
        news_summary: '',
        target_strike: 23300,
        target_expiry_date: '2026-03-24',
        trade_direction: 'GO_CALL',
        atm_strike: 23350,
        ltp: 23350,
        scoring_factors: {
          oi_support: { score: 0.8, weight: 0.3, detail: 'Strong put OI at 23200 (890K)' },
          oi_momentum: { score: 0.6, weight: 0.25, detail: 'Call OI building at 23300' },
          iv_level: { score: 0.4, weight: 0.15, detail: 'IV 11.2% — below average' },
          pcr_trend: { score: 0.3, weight: 0.1, detail: 'PCR rising from 0.75 to 0.81' },
          news_sentiment: { score: 0.5, weight: 0.1, detail: 'Positive IT earnings' },
          theta_risk: { score: -0.2, weight: 0.1, detail: '4 days to expiry' },
        },
      };

      pushAIDecision('NIFTY_50', ai);
      const instruments = getInstrumentData();
      const nifty = instruments.find(i => i.name === 'NIFTY_50');

      expect(nifty!.scoringFactors).toBeDefined();
      expect(Object.keys(nifty!.scoringFactors!).length).toBe(6);
      expect(nifty!.scoringFactors!['oi_support']!.score).toBe(0.8);
      expect(nifty!.scoringFactors!['oi_support']!.weight).toBe(0.3);
      expect(nifty!.scoringFactors!['theta_risk']!.score).toBe(-0.2);
    });
  });

  describe('Backward compatibility with legacy AI decisions', () => {
    it('should still work with legacy AI decision format (no enhanced fields)', () => {
      pushMinimalOC('CRUDEOIL', 5425);
      const legacyAi: RawAIDecision = {
        instrument: 'CRUDEOIL',
        timestamp: new Date().toISOString(),
        decision: 'NO_GO',
        trade_type: 'NONE',
        confidence_score: 0.35,
        rationale: 'Weak signals',
        market_bias_oc: 'BEARISH',
        market_bias_news: 'NEGATIVE',
        active_strikes: { call: [5500], put: [5400] },
        main_support: 5300,
        main_resistance: 5600,
        entry_signal_details: null,
        news_summary: 'OPEC uncertainty',
        target_strike: null,
        target_expiry_date: null,
        // No enhanced fields
      };

      pushAIDecision('CRUDEOIL', legacyAi);
      const instruments = getInstrumentData();
      const crude = instruments.find(i => i.name === 'CRUDEOIL');

      expect(crude).toBeDefined();
      expect(crude!.aiDecision).toBe('NO_GO');
      // Enhanced fields should be undefined
      expect(crude!.tradeDirection).toBeUndefined();
      expect(crude!.tradeSetup).toBeUndefined();
      expect(crude!.supportAnalysis).toBeUndefined();
      expect(crude!.resistanceAnalysis).toBeUndefined();
      expect(crude!.ivAssessment).toBeUndefined();
      expect(crude!.thetaAssessment).toBeUndefined();
      expect(crude!.riskFlags).toBeUndefined();
      expect(crude!.scoringFactors).toBeUndefined();
    });
  });
});
