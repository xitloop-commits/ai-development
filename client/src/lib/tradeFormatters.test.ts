import { describe, it, expect } from 'vitest';
import { formatIstClock, formatIstDateTime } from './tradeFormatters';

// 03:48 UTC + 5:30 (IST, no DST) = 09:18 IST on 17 Jul 2026.
const TS = Date.UTC(2026, 6, 17, 3, 48, 0);

describe('formatIstClock', () => {
  it('renders an epoch as 24h IST HH:MM', () => {
    expect(formatIstClock(TS)).toBe('09:18');
  });
  it('is empty for a missing timestamp', () => {
    expect(formatIstClock(0)).toBe('');
    expect(formatIstClock(NaN)).toBe('');
  });
});

describe('formatIstDateTime', () => {
  it('renders full IST date + time', () => {
    expect(formatIstDateTime(TS)).toBe('17 Jul 2026, 09:18:00');
  });
  it('is empty for a missing timestamp', () => {
    expect(formatIstDateTime(0)).toBe('');
  });
});
