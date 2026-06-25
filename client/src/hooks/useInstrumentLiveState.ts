/**
 * useInstrumentLiveState — one instrument's TFA live state, WS-pushed (no poll).
 *
 * Reads the WS-fed store (server pushes `instrument_state` ~1/s + a snapshot on
 * connect) with a one-time tRPC query as a cold-start fallback before the first
 * push. Identical-key queries are deduped by react-query, so the 5 former
 * pollers now share a single one-shot fetch + the WS stream.
 *
 * Pass the canonical instrument key the server expects (nifty50, banknifty,
 * crudeoil, naturalgas) — same value the old useQuery({ instrument }) used.
 */
import { trpc } from '@/lib/trpc';
import { useInstrumentState } from '@/stores/instrumentStateStore';

export function useInstrumentLiveState<T = any>(instrument: string): T | undefined {
  const live = useInstrumentState<T>(instrument);
  const initial = trpc.trading.instrumentLiveState.useQuery(
    { instrument },
    { staleTime: Infinity, refetchOnWindowFocus: false, enabled: !!instrument },
  );
  return (live ?? (initial.data as T | undefined));
}
