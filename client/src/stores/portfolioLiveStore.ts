/**
 * portfolioLiveStore — latest day-record per channel, pushed over /ws/ticks.
 *
 * Replaces the 2s allDays poll: the server emits the full day record on every
 * write (tick persist, trade open/close, TP/SL edit). The WS handler in
 * useTickStream feeds this store; CapitalContext swaps the pushed day into its
 * allDays for the active channel (matched by dayIndex), so the trade list +
 * TradeBar update live with no polling.
 *
 * Module-level singleton + useSyncExternalStore — same pattern as
 * signalsStore / seaStatusStore.
 */
import { useSyncExternalStore } from "react";

// Raw day record as pushed on the wire (normalized by CapitalContext).
type RawDay = { dayIndex?: number } & Record<string, unknown>;

const byChannel = new Map<string, RawDay>();
const listeners = new Map<string, Set<() => void>>();

function notify(channel: string): void {
  const set = listeners.get(channel);
  if (!set) return;
  set.forEach((fn) => fn());
}

/** Ingest a pushed day record for a channel. */
export function setLiveDay(channel: string, day: RawDay): void {
  if (!channel || !day || typeof day !== "object") return;
  byChannel.set(channel, day);
  notify(channel);
}

/** Subscribe a component to the live day for one channel. Returns undefined
 *  until the first push arrives (CapitalContext falls back to the query). */
export function useLiveDay(channel: string): RawDay | undefined {
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(cb);
      return () => {
        set!.delete(cb);
      };
    },
    () => byChannel.get(channel),
  );
}
