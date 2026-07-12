import { describe, it, expect } from 'vitest';
import { sma, ema, rsi, supertrend, type OHLC } from './indicators';

describe('sma', () => {
  it('is null during warm-up then the trailing mean', () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });
});

describe('ema', () => {
  it('seeds with SMA then applies the smoothing factor', () => {
    const out = ema([1, 2, 3, 4, 5], 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(1.5, 6); // SMA seed
    expect(out[4]).toBeCloseTo(4.5, 6);
  });
});

describe('rsi', () => {
  it('is 100 for a monotonically rising series (no losses)', () => {
    const vals = Array.from({ length: 20 }, (_, i) => i + 1);
    const out = rsi(vals, 14);
    expect(out[13]).toBeNull(); // warm-up
    expect(out[14]).toBe(100);
  });
});

describe('supertrend', () => {
  it('returns a same-length series with a valid direction once warmed up', () => {
    const candles: OHLC[] = Array.from({ length: 30 }, (_, i) => ({
      high: 100 + i + 1,
      low: 100 + i - 1,
      close: 100 + i,
    }));
    const st = supertrend(candles, 10, 3);
    expect(st).toHaveLength(30);
    const last = st[29];
    expect(typeof last.value).toBe('number');
    expect([1, -1]).toContain(last.dir);
    // Steadily rising series should end in an uptrend.
    expect(last.dir).toBe(1);
  });
});
