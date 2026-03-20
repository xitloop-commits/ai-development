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
} from './tradingStore';

describe('Active Instruments Management', () => {
  beforeEach(() => {
    // Reset to all instruments active before each test
    setActiveInstruments(['NIFTY_50', 'CRUDEOIL', 'NATURALGAS']);
  });

  describe('getActiveInstruments', () => {
    it('should return all 3 instruments by default', () => {
      const active = getActiveInstruments();
      expect(active).toHaveLength(3);
      expect(active).toContain('NIFTY_50');
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
      expect(active).toHaveLength(3);
      expect(active).toContain('NIFTY_50');
      expect(active).toContain('CRUDEOIL');
      expect(active).toContain('NATURALGAS');
    });

    it('should fallback to all instruments when all keys are invalid', () => {
      setActiveInstruments(['INVALID_1', 'INVALID_2']);
      const active = getActiveInstruments();
      expect(active).toHaveLength(3);
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
      expect(isInstrumentActive('BANKNIFTY')).toBe(false);
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
      expect(getActiveInstruments()).toHaveLength(3);

      // User disables NATURALGAS
      setActiveInstruments(['NIFTY_50', 'CRUDEOIL']);
      expect(isInstrumentActive('NATURALGAS')).toBe(false);
      expect(getActiveInstruments()).toHaveLength(2);

      // User re-enables NATURALGAS
      setActiveInstruments(['NIFTY_50', 'CRUDEOIL', 'NATURALGAS']);
      expect(isInstrumentActive('NATURALGAS')).toBe(true);
      expect(getActiveInstruments()).toHaveLength(3);
    });
  });
});
