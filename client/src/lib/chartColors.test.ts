import { describe, it, expect } from 'vitest';
import { chartColors } from './chartColors';

describe('chartColors', () => {
  it('dark values match the legacy CHART_* constants (dark stays byte-identical)', () => {
    const c = chartColors('dark');
    expect(c.background).toBe('#131722');
    expect(c.up).toBe('#089981');
    expect(c.down).toBe('#f23645');
    expect(c.grid).toBe('rgba(148,163,184,0.06)');
  });

  it('light uses a white canvas + darker profit/loss for contrast on a light page', () => {
    const c = chartColors('light');
    expect(c.background).toBe('#ffffff');
    expect(c.up).toBe('#15803d');
    expect(c.down).toBe('#dc2626');
    // text must differ from the dark theme (dark #94a3b8 is too faint on white)
    expect(c.text).not.toBe(chartColors('dark').text);
  });
});
