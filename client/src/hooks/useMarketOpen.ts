import { useCallback, useMemo } from 'react';
import { trpc } from '@/lib/trpc';

/**
 * useMarketOpen — live per-instrument market-open status.
 *
 * Sourced from TFA's `is_market_open` flag (the same signal the AI status
 * indicator uses, via trading.instrumentLiveState). NSE and MCX close at
 * different times, so each instrument flips independently — after NSE close
 * NIFTY/BANKNIFTY report closed while CRUDE/NATURALGAS stay open until MCX
 * close.
 *
 * Returns `isClosed(name)`: true ONLY when an instrument is known to be
 * closed. Unknown instruments and not-yet-loaded status return false, so
 * callers default to showing an instrument rather than hiding it.
 */

// Instrument keys understood by trading.instrumentLiveState (TFA live files).
const MARKET_INSTRUMENTS = ['nifty50', 'banknifty', 'crudeoil', 'naturalgas'] as const;

/** Normalize a UI name or key for matching: "NIFTY 50" → "NIFTY50". */
const norm = (s: string) => s.toUpperCase().replace(/\s+/g, '');

export function useMarketOpen() {
  const queries = MARKET_INSTRUMENTS.map((inst) =>
    trpc.trading.instrumentLiveState.useQuery(
      { instrument: inst },
      { refetchInterval: 30_000, retry: 1 },
    ),
  );

  // Map normalized instrument key → open?  Only keys whose status has loaded
  // appear here. Memoized on the query data so the map (and isClosed below)
  // stays referentially stable between refetches that don't change anything.
  const data = queries.map((q) => q.data);
  const openByKey = useMemo(() => {
    const map: Record<string, boolean> = {};
    MARKET_INSTRUMENTS.forEach((inst, i) => {
      const d = data[i] as { live?: { is_market_open: number } | null } | undefined;
      if (d !== undefined) {
        map[norm(inst)] = !!d.live && d.live.is_market_open === 1;
      }
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, data);

  const isClosed = useCallback(
    (instrumentName: string): boolean => {
      const key = norm(instrumentName);
      // Unknown or not-loaded → not known-closed → caller shows it.
      return openByKey[key] === false;
    },
    [openByKey],
  );

  // True ONLY when an instrument is known-open (loaded + is_market_open). Unknown
  // / not-loaded → false, so a status light reads grey until proven open.
  const isOpen = useCallback(
    (instrumentName: string): boolean => openByKey[norm(instrumentName)] === true,
    [openByKey],
  );

  // True when at least one instrument's market is known-open — i.e. we should be
  // receiving live ticks. Used to gate the feed-health banner to trading hours.
  const anyOpen = useMemo(() => Object.values(openByKey).some((v) => v === true), [openByKey]);

  return { isClosed, isOpen, anyOpen };
}
