/**
 * useInstrumentColors — single source of instrument colour in the UI.
 *
 * Reads the live instruments list (cached by tRPC) and returns resolvers that
 * turn any instrument label form (DB key, display name, live-state key, SEA
 * short form) into its colour. Every instrument-specific surface — the pill,
 * instrument cards, signal cards, expiry cards — goes through this so a colour
 * picked in Settings shows the same everywhere.
 */
import { useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import {
  DEFAULT_INSTRUMENT_COLORS,
  instrumentStyleFromHex,
  normalizeInstrumentKey,
  resolveInstrumentHex,
  type InstrumentStyle,
} from '@/lib/tradeThemes';

export interface InstrumentColors {
  /** Full style bundle (pill, card tint, border, text) for an instrument. */
  styleOf: (raw: string) => InstrumentStyle;
  /** Just the resolved base hex for an instrument. */
  hexOf: (raw: string) => string;
}

export function useInstrumentColors(): InstrumentColors {
  const { data } = trpc.instruments.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });

  const colorMap = useMemo(() => {
    const m: Record<string, string> = {};
    // Seed built-in defaults so the core instruments always resolve, even
    // before the query lands.
    for (const [k, v] of Object.entries(DEFAULT_INSTRUMENT_COLORS)) {
      m[normalizeInstrumentKey(k)] = v;
    }
    for (const inst of data ?? []) {
      const hex = (inst as { color?: string }).color;
      if (hex) m[normalizeInstrumentKey(inst.key)] = hex;
    }
    return m;
  }, [data]);

  return useMemo<InstrumentColors>(
    () => ({
      styleOf: (raw: string) => instrumentStyleFromHex(resolveInstrumentHex(raw, colorMap)),
      hexOf: (raw: string) => resolveInstrumentHex(raw, colorMap),
    }),
    [colorMap],
  );
}
