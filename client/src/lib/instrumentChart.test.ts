import { describe, it, expect } from 'vitest';
import { bucketTicks, defaultChartDate } from './instrumentChart';
import { IST_OFFSET_SECONDS } from './signalChart';

describe('bucketTicks', () => {
  it('buckets ticks into OHLC candles at the interval, IST-shifted', () => {
    const t = [1, 10, 20, 60, 90];
    const ltp = [10, 15, 5, 20, 8];
    const c = bucketTicks(t, ltp, 60);
    expect(c).toHaveLength(2);
    expect(c[0]).toEqual({ time: 0 + IST_OFFSET_SECONDS, open: 10, high: 15, low: 5, close: 5 });
    expect(c[1]).toEqual({ time: 60 + IST_OFFSET_SECONDS, open: 20, high: 20, low: 8, close: 8 });
  });

  it('re-buckets the same ticks at a finer interval', () => {
    const t = [1, 30, 61];
    const ltp = [100, 110, 90];
    const c30 = bucketTicks(t, ltp, 30);
    // buckets 0, 30, 60 → three candles
    expect(c30.map((x) => x.close)).toEqual([100, 110, 90]);
    const c60 = bucketTicks(t, ltp, 60);
    // buckets 0 (0,30) and 60 (61) → two candles
    expect(c60).toHaveLength(2);
    expect(c60[0]).toMatchObject({ open: 100, high: 110, low: 100, close: 110 });
  });

  it('skips non-positive prices/timestamps and returns [] on empty', () => {
    expect(bucketTicks([], [], 60)).toEqual([]);
    const c = bucketTicks([0, 5, 10], [0, 50, -1], 60);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ open: 50, close: 50 });
  });
});

describe('defaultChartDate', () => {
  it('returns the most recent recorded date when off-session (weekend)', () => {
    // 2026-07-12 is a Sunday.
    const now = new Date('2026-07-12T06:00:00Z');
    expect(defaultChartDate(['2026-07-09', '2026-07-10'], now)).toBe('2026-07-10');
  });

  it('returns today when an NSE session is live (weekday, 10:30 IST)', () => {
    // 2026-07-10 is a Friday; 05:00Z = 10:30 IST → in 09:15–15:30 session.
    const now = new Date('2026-07-10T05:00:00Z');
    expect(defaultChartDate(['2026-07-09'], now)).toBe('2026-07-10');
  });

  it('falls back to today when nothing is recorded', () => {
    const now = new Date('2026-07-12T06:00:00Z');
    expect(defaultChartDate([], now)).toBe('2026-07-12');
  });
});
