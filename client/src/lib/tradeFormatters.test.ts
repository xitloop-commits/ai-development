import { describe, it, expect } from 'vitest';
import { formatIstClock, formatIstDayClock, formatIstDateTime } from './tradeFormatters';

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

/**
 * Trade-row timestamp. Explicitly pinned to Asia/Kolkata inside the formatter,
 * so these assertions hold whatever the machine's timezone is.
 */
describe('formatIstDayClock', () => {
  const at = (iso: string) => new Date(iso).getTime();

  it('renders day + 12-hour time with no space before AM/PM', () => {
    expect(formatIstDayClock(at('2026-07-04T14:15:00+05:30'))).toBe('4 Jul 2:15PM');
    expect(formatIstDayClock(at('2026-07-04T08:45:00+05:30'))).toBe('4 Jul 8:45AM');
  });

  it('renders midnight as 12:xxAM, not 0:xx', () => {
    expect(formatIstDayClock(at('2026-07-04T00:05:00+05:30'))).toBe('4 Jul 12:05AM');
  });

  it('renders noon as 12:00PM, not 12:00AM', () => {
    expect(formatIstDayClock(at('2026-07-04T12:00:00+05:30'))).toBe('4 Jul 12:00PM');
  });

  it('converts a non-IST timestamp into IST', () => {
    // 23:00 UTC on 3 Jul is 04:30 IST on 4 Jul — the DATE has to roll too.
    expect(formatIstDayClock(at('2026-07-03T23:00:00Z'))).toBe('4 Jul 4:30AM');
  });

  it('returns empty for a missing or invalid timestamp', () => {
    expect(formatIstDayClock(0)).toBe('');
    expect(formatIstDayClock(NaN)).toBe('');
  });
});
