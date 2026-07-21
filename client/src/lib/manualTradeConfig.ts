/**
 * manualTradeConfig — how a manually-placed trade reads its size from the AI
 * menu's "My Trades" block.
 *
 * This is shared rather than inlined because it was NOT shared, and the two
 * manual placement paths disagreed: the watchlist row honoured the configured
 * per-instrument size while the signals feed hardcoded 5% of capital and 1 lot.
 * The same setting produced different trades depending on which button you
 * pressed, and nothing surfaced the difference.
 *
 * The exit STRATEGY is deliberately not here — the server resolves that from the
 * same config (`resolveExitStrategy`), so there is exactly one authority and no
 * caller can bypass it. Use `manualStrategyLabel` for display only.
 */

export interface ManualSizing {
  mode: 'lots' | 'percent';
  value: number;
}

export interface ManualBlock {
  strategies?: Record<string, boolean>;
  sizing?: { perInstrument?: Record<string, ManualSizing> };
}

/**
 * Config key for an instrument: lowercase, separators stripped.
 * "NIFTY 50" / "NIFTY_50" → "nifty50", "BANK NIFTY" → "banknifty".
 *
 * Both spaces AND underscores must go. Stripping only whitespace is exactly the
 * bug that made "NIFTY_50" match no entry, silently falling back to 1 lot.
 */
export function sizingKeyFor(instrument: string): string {
  return instrument.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Resolve `{ capitalPercent, qty }` for a manual trade.
 *
 * "lots" → qty in lots (the server multiplies by the scrip master's lot size)
 * with capitalPercent 0; "percent" → let the server size from capital, qty 0.
 * Nothing configured → 1 lot, the smallest tradeable unit. Defaulting to a
 * PERCENTAGE here would make a missing config silently place a capital-sized
 * position, which is the wrong direction to fail in.
 */
export function manualTradeSize(
  manual: ManualBlock | undefined,
  instrument: string,
): { capitalPercent: number; qty: number } {
  const s = manual?.sizing?.perInstrument?.[sizingKeyFor(instrument)];
  if (!s || s.mode === 'lots') {
    return { capitalPercent: 0, qty: Math.max(1, Math.round(s?.value ?? 1)) };
  }
  return { capitalPercent: s.value, qty: 0 };
}

/**
 * The strategy the server WILL apply, for display only (tooltips, confirm
 * dialogs). Manual takes one strategy per trade, so the first enabled pill
 * wins; none enabled → sprint. Mirrors `resolveExitStrategy` on the server.
 *
 * Equity is pinned to sprint server-side regardless of this block — pass
 * `isEquity` so the UI does not promise a strategy the trade will not get.
 */
export function manualStrategyLabel(
  manual: ManualBlock | undefined,
  isEquity = false,
): 'sprint' | 'runway' | 'anchor' {
  if (isEquity) return 'sprint';
  return (['sprint', 'runway', 'anchor'] as const).find((s) => manual?.strategies?.[s]) ?? 'sprint';
}
