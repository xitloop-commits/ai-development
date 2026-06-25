/**
 * liveSignals — generic per-key "something changed" epochs, pushed over
 * /ws/ticks. Used to replace status polls with event-driven refetches: the
 * server emits a tiny signal (e.g. broker_changed, discipline_changed) on a
 * real change; the WS handler bumps the key's epoch; a single invalidator hook
 * refetches the matching query once. No timers.
 *
 * Module-level singleton + useSyncExternalStore.
 */
import { useSyncExternalStore } from "react";

const epochs = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

export function bumpSignal(key: string): void {
  if (!key) return;
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
  const set = listeners.get(key);
  if (set) set.forEach((fn) => fn());
}

/** Subscribe to a key's epoch (increments on each push). */
export function useSignalEpoch(key: string): number {
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
    () => epochs.get(key) ?? 0,
  );
}
