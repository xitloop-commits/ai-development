/**
 * replayMarkerStore — the shared replay "start from here" marker time.
 *
 * One marker across the whole replay UI (all chart panes + the replay control),
 * so dragging it on any chart and reading it in the ReplayControl agree. The
 * value is an IST-shifted epoch-seconds time (the same units as chart candle
 * times); subtract IST_OFFSET_SECONDS to get the recv_ts the server seek wants.
 *
 * Pattern: module-level value + listener set + useSyncExternalStore, matching
 * signalsStore / optionChainStore.
 */
import { useSyncExternalStore } from "react";

let markerTime: number | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

export function setReplayMarker(t: number | null): void {
  if (markerTime === t) return;
  markerTime = t;
  notify();
}

export function getReplayMarker(): number | null {
  return markerTime;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive hook — the current marker time (IST-shifted epoch sec) or null. */
export function useReplayMarker(): number | null {
  return useSyncExternalStore(subscribe, getReplayMarker, getReplayMarker);
}
