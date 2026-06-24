import { describe, it, expect } from 'vitest';
import {
  normalizeInstrumentKey,
  withAlpha,
  instrumentStyleFromHex,
  resolveInstrumentHex,
  DEFAULT_INSTRUMENT_COLORS,
} from './tradeThemes';

describe('normalizeInstrumentKey', () => {
  it('collapses every NIFTY label form to one key', () => {
    expect(normalizeInstrumentKey('NIFTY 50')).toBe('NIFTY50');
    expect(normalizeInstrumentKey('NIFTY_50')).toBe('NIFTY50');
    expect(normalizeInstrumentKey('nifty50')).toBe('NIFTY50');
    expect(normalizeInstrumentKey('NIFTY')).toBe('NIFTY50');
  });

  it('strips spaces/underscores and uppercases other instruments', () => {
    expect(normalizeInstrumentKey('BANK NIFTY')).toBe('BANKNIFTY');
    expect(normalizeInstrumentKey('BANKNIFTY')).toBe('BANKNIFTY');
    expect(normalizeInstrumentKey('CRUDE OIL')).toBe('CRUDEOIL');
    expect(normalizeInstrumentKey('NATURAL GAS')).toBe('NATURALGAS');
  });
});

describe('withAlpha', () => {
  it('converts hex (long and short) to rgba', () => {
    expect(withAlpha('#3B82F6', 0.15)).toBe('rgba(59, 130, 246, 0.15)');
    expect(withAlpha('#FFF', 1)).toBe('rgba(255, 255, 255, 1)');
  });
});

describe('instrumentStyleFromHex', () => {
  it('derives every shade from one base colour', () => {
    const s = instrumentStyleFromHex('#3B82F6');
    expect(s.hex).toBe('#3B82F6');
    expect(s.text.color).toBe('#3B82F6');
    expect(s.pill).toEqual({ backgroundColor: 'rgba(59, 130, 246, 0.15)', color: '#3B82F6' });
    expect(s.cardBg.backgroundColor).toBe('rgba(59, 130, 246, 0.07)');
    expect(s.border.borderColor).toBe('rgba(59, 130, 246, 0.3)');
    expect(s.borderLeft.borderLeftColor).toBe('#3B82F6');
  });

  it('falls back to slate for an empty colour', () => {
    expect(instrumentStyleFromHex('').hex).toBe('#64748B');
  });
});

describe('resolveInstrumentHex', () => {
  it('prefers the live colour map', () => {
    const map = { NIFTY50: '#111111' };
    expect(resolveInstrumentHex('NIFTY 50', map)).toBe('#111111');
  });

  it('falls back to the built-in default when not in the map', () => {
    expect(resolveInstrumentHex('BANK NIFTY', {})).toBe(DEFAULT_INSTRUMENT_COLORS.BANKNIFTY);
  });

  it('falls back to slate for an unknown instrument', () => {
    expect(resolveInstrumentHex('SOMETHING_NEW', {})).toBe('#64748B');
  });
});
