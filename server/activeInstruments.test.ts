/**
 * Tests for active instruments management in the trading store.
 * Validates get/set/validation logic for the instrument filter
 * that controls which instruments the Python pipeline processes.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  getActiveInstruments,
  setActiveInstruments,
  isInstrumentActive,
  setConfiguredInstruments,
} from './tradingStore';

const DEFAULT_INSTRUMENTS = [
  { key: 'NIFTY_50',   displayName: 'NIFTY 50',    exchange: 'NSE_FNO' },
  { key: 'BANKNIFTY',  displayName: 'BANK NIFTY',  exchange: 'NSE_FNO' },
  { key: 'CRUDEOIL',   displayName: 'CRUDE OIL',   exchange: 'MCX_COMM' },
  { key: 'NATURALGAS', displayName: 'NATURAL GAS', exchange: 'MCX_COMM' },
];

describe('Active Instruments Management', () => {
  beforeEach(() => {
    // setActiveInstruments validates against configuredInstrumentKeys —
    // load them from Mongo at server startup in production. Tests must
    // seed them explicitly first.
    setConfiguredInstruments(DEFAULT_INSTRUMENTS);
    setActiveInstruments(['NIFTY_50', 'BANKNIFTY', 'CRUDEOIL', 'NATURALGAS']);
  });

  describe('getActiveInstruments', () => {
    it('should return all 4 instruments by default', () => {
      const active = getActiveInstruments();
      expect(active).toHaveLength(4);
      expect(active).toContain('NIFTY_50');
      expect(active).toContain('BANKNIFTY');
      expect(active).toContain('CRUDEOIL');
      expect(active).toContain('NATURALGAS');
    });

    it('should return an array of strings', () => {
      const active = getActiveInstruments();
      for (const item of active) {
        expect(typeof item).toBe('string');
      }
    });
  });

  describe('setActiveInstruments', () => {
    it('should update the active instruments list', () => {
      setActiveInstruments(['NIFTY_50', 'CRUDEOIL']);
      const active = getActiveInstruments();
      expect(active).toHaveLength(2);
      expect(active).toContain('NIFTY_50');
      expect(active).toContain('CRUDEOIL');
      expect(active).not.toContain('NATURALGAS');
    });

    it('should allow setting a single instrument', () => {
      setActiveInstruments(['CRUDEOIL']);
      const active = getActiveInstruments();
      expect(active).toHaveLength(1);
      expect(active).toContain('CRUDEOIL');
    });

    it('should filter out invalid instrument keys', () => {
      setActiveInstruments(['NIFTY_50', 'INVALID_INSTRUMENT', 'CRUDEOIL']);
      const active = getActiveInstruments();
      expect(active).toHaveLength(2);
      expect(active).toContain('NIFTY_50');
      expect(active).toContain('CRUDEOIL');
      expect(active).not.toContain('INVALID_INSTRUMENT');
    });

    it('should fallback to all instruments when given an empty array', () => {
      setActiveInstruments([]);
      const active = getActiveInstruments();
      expect(active).toHaveLength(4);
      expect(active).toContain('NIFTY_50');
      expect(active).toContain('BANKNIFTY');
      expect(active).toContain('CRUDEOIL');
      expect(active).toContain('NATURALGAS');
    });

    it('should fallback to all instruments when all keys are invalid', () => {
      setActiveInstruments(['INVALID_1', 'INVALID_2']);
      const active = getActiveInstruments();
      expect(active).toHaveLength(4);
    });

    it('should deduplicate instrument keys', () => {
      setActiveInstruments(['NIFTY_50', 'NIFTY_50', 'CRUDEOIL']);
      const active = getActiveInstruments();
      expect(active).toHaveLength(2);
    });
  });

  describe('isInstrumentActive', () => {
    it('should return true for active instruments', () => {
      setActiveInstruments(['NIFTY_50', 'CRUDEOIL']);
      expect(isInstrumentActive('NIFTY_50')).toBe(true);
      expect(isInstrumentActive('CRUDEOIL')).toBe(true);
    });

    it('should return false for disabled instruments', () => {
      setActiveInstruments(['NIFTY_50', 'CRUDEOIL']);
      expect(isInstrumentActive('NATURALGAS')).toBe(false);
    });

    it('should return false for unknown instrument keys', () => {
      expect(isInstrumentActive('SENSEX')).toBe(false);
    });

    it('should reflect changes after setActiveInstruments', () => {
      expect(isInstrumentActive('NATURALGAS')).toBe(true);
      setActiveInstruments(['NIFTY_50']);
      expect(isInstrumentActive('NATURALGAS')).toBe(false);
      expect(isInstrumentActive('NIFTY_50')).toBe(true);
    });
  });

  describe('Integration: toggle flow', () => {
    it('should simulate a user disabling then re-enabling an instrument', () => {
      // Start: all active
      expect(getActiveInstruments()).toHaveLength(4);

      // User disables NATURALGAS and BANKNIFTY
      setActiveInstruments(['NIFTY_50', 'CRUDEOIL']);
      expect(isInstrumentActive('NATURALGAS')).toBe(false);
      expect(isInstrumentActive('BANKNIFTY')).toBe(false);
      expect(getActiveInstruments()).toHaveLength(2);

      // User re-enables all
      setActiveInstruments(['NIFTY_50', 'BANKNIFTY', 'CRUDEOIL', 'NATURALGAS']);
      expect(isInstrumentActive('NATURALGAS')).toBe(true);
      expect(isInstrumentActive('BANKNIFTY')).toBe(true);
      expect(getActiveInstruments()).toHaveLength(4);
    });
  });
});
