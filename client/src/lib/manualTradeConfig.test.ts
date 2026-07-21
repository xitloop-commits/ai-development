/**
 * manualTradeConfig — shared sizing for manual placement paths.
 *
 * Extracted because the watchlist row and the signals feed disagreed: one
 * honoured the configured per-instrument size, the other hardcoded 5% of
 * capital and 1 lot. Same setting, different trade, depending on which button
 * you pressed.
 */
import { describe, it, expect } from 'vitest';
import { sizingKeyFor, manualTradeSize, manualStrategyLabel } from './manualTradeConfig';

describe('sizingKeyFor', () => {
  it('strips underscores AND spaces, not just whitespace', () => {
    // Stripping only whitespace is exactly the bug that made "NIFTY_50" match
    // no config entry and silently fall back to 1 lot.
    expect(sizingKeyFor('NIFTY_50')).toBe('nifty50');
    expect(sizingKeyFor('NIFTY 50')).toBe('nifty50');
    expect(sizingKeyFor('BANK NIFTY')).toBe('banknifty');
    expect(sizingKeyFor('CRUDE OIL')).toBe('crudeoil');
  });
});

describe('manualTradeSize', () => {
  const manual = {
    sizing: {
      perInstrument: {
        nifty50: { mode: 'lots' as const, value: 20 },
        banknifty: { mode: 'percent' as const, value: 7 },
      },
    },
  };

  it('lots mode sends qty and zero capitalPercent', () => {
    expect(manualTradeSize(manual, 'NIFTY 50')).toEqual({ capitalPercent: 0, qty: 20 });
  });

  it('percent mode sends capitalPercent and zero qty', () => {
    expect(manualTradeSize(manual, 'BANK NIFTY')).toEqual({ capitalPercent: 7, qty: 0 });
  });

  it('resolves via the same key whichever spelling the caller has', () => {
    expect(manualTradeSize(manual, 'NIFTY_50')).toEqual(manualTradeSize(manual, 'NIFTY 50'));
  });

  it('defaults to ONE LOT, never a percentage, when unconfigured', () => {
    // Failing to 1 lot risks a trade that is too small. Failing to a percentage
    // risks a capital-sized position nobody asked for — the worse direction.
    expect(manualTradeSize(manual, 'UNKNOWN')).toEqual({ capitalPercent: 0, qty: 1 });
    expect(manualTradeSize(undefined, 'NIFTY 50')).toEqual({ capitalPercent: 0, qty: 1 });
  });
});

describe('manualStrategyLabel (display only)', () => {
  it('shows the first enabled pill', () => {
    expect(manualStrategyLabel({ strategies: { sprint: false, runway: true, anchor: true } }))
      .toBe('runway');
  });

  it('shows sprint when nothing is enabled', () => {
    expect(manualStrategyLabel({ strategies: { sprint: false, runway: false, anchor: false } }))
      .toBe('sprint');
  });

  it('shows sprint for equity, matching the server pin', () => {
    // The UI must not promise Runway on a stock the server will run as Sprint.
    expect(manualStrategyLabel({ strategies: { sprint: false, runway: true, anchor: false } }, true))
      .toBe('sprint');
  });
});
