/**
 * instrumentStateStore — latest TFA live state per instrument, pushed over
 * /ws/ticks. Replaces the 2s trading.instrumentLiveState poll (5 consumers).
 *
 * The server watches the feature files and pushes `instrument_state` frames
 * (throttled ~1/s) + a snapshot of all instruments on connect. The WS handler
 * in useTickStream feeds this store; the useInstrumentLiveState hook reads it
 * with a one-time query as a cold-start fallback.
 *
 * Module-level singleton + useSyncExternalStore — same pattern as the other
 * live stores.
 */
import { useSyncExternalStore } from "react";

const byInstrument = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

/** Canonical key: lowercase, strip non-alphanumerics (NIFTY 50 → nifty50). */
function norm(instrument: string): string {
  return (instrument || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Ingest a pushed instrument state. */
export function setInstrumentState(instrument: string, state: unknown): void {
  if (!instrument || state == null) return;
  byInstrument.set(norm(instrument), state);
  const set = listeners.get(norm(instrument));
  if (set) set.forEach((fn) => fn());
}

/** Subscribe to one instrument's live state (undefined until first push). */
export function useInstrumentState<T = any>(instrument: string): T | undefined {
  const key = norm(instrument);
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(cb);
      return () => {
        set!.delete(cb);
      };
    },
    () => byInstrument.get(key) as T | undefined,
  ) as T | undefined;
}
