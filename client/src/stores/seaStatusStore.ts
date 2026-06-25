/**
 * seaStatusStore — latest SEA engine liveness, pushed over /ws/ticks.
 *
 * Replaces the tRPC `seaStatus` poll: the server broadcasts a `sea_status`
 * frame on every heartbeat + a 10s timer (so the light greys out when an
 * engine dies) + a snapshot on connect. The WS handler in useTickStream feeds
 * this store; the AppBar light reads it.
 *
 * Module-level singleton + useSyncExternalStore — same pattern as signalsStore.
 */
import { useSyncExternalStore } from "react";

export interface SeaInstrumentStatus {
  instrument: string;
  ageSec: number;
  alive: boolean;
}

export interface SeaStatus {
  anyAlive: boolean;
  aliveCount: number;
  instruments: SeaInstrumentStatus[];
}

let status: SeaStatus = { anyAlive: false, aliveCount: 0, instruments: [] };
const listeners: Array<() => void> = [];

function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

/** Replace the status with a freshly-pushed snapshot from the WS. */
export function setSeaStatus(next: SeaStatus): void {
  if (!next || !Array.isArray(next.instruments)) return;
  status = next;
  for (let i = 0; i < listeners.length; i++) listeners[i]();
}

/** Subscribe a component to SEA liveness. */
export function useSeaStatus(): SeaStatus {
  return useSyncExternalStore(subscribe, () => status);
}
