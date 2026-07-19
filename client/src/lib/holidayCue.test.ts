import { describe, it, expect } from 'vitest';
import { holidayCue } from './holidayCue';

describe('holidayCue — days-until → AppBar treatment', () => {
  it('≤3 days is a bright CTA (today included)', () => {
    expect(holidayCue(0)).toBe('bright');
    expect(holidayCue(1)).toBe('bright');
    expect(holidayCue(3)).toBe('bright');
  });

  it('4–6 days is a light CTA', () => {
    expect(holidayCue(4)).toBe('light');
    expect(holidayCue(5)).toBe('light');
    expect(holidayCue(6)).toBe('light');
  });

  it('7–19 days is the once-per-launch alert (no CTA)', () => {
    expect(holidayCue(7)).toBe('alert');
    expect(holidayCue(12)).toBe('alert');
    expect(holidayCue(19)).toBe('alert');
  });

  it('20+ days, negative, or none is silent', () => {
    expect(holidayCue(20)).toBe('none');
    expect(holidayCue(45)).toBe('none');
    expect(holidayCue(-1)).toBe('none');
    expect(holidayCue(null)).toBe('none');
  });
});
