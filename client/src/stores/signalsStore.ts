/**
 * signalsStore — Client-side cache of SEA trading signals for the tray.
 *
 * Source of truth is the server (Mongo sea_signals). This store holds the
 * slice currently loaded into the UI:
 *   - setInitial(list): first page from the tRPC query on mount / reconnect
 *   - addLive(sig):     a single signal pushed over /ws/ticks (prepended)
 *   - appendOlder(list): an older page fetched on scroll (lazy-load)
 *
 * Ordering: recent-first always. Live pushes go to the top; older pages append
 * to the bottom. Deduped by `id` so a WS push that also appears in a refetch
 * (reconnect race) shows once.
 *
 * Pattern: module-level array + listener set + useSyncExternalStore — same
 * approach as optionChainStore. The array reference is replaced on every
 * mutation so useSyncExternalStore sees a new snapshot.
 */
import { useSyncExternalStore } from "react";
import type { SEASignal } from "@/components/SignalsFeed";

// ── Store (module-level, singleton) ────────────────────────────────────────

let signals: SEASignal[] = [];
const seen = new Set<string>();
const listeners: Array<() => void> = [];

function keyOf(s: SEASignal): string {
  return s.id || `${s.instrument}:${s.timestamp_ist}:${s.direction ?? ""}`;
}

function notify() {
  for (let i = 0; i < listeners.length; i++) listeners[i]();
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function getSnapshot(): SEASignal[] {
  return signals;
}

// ── Mutators ───────────────────────────────────────────────────────────────

/** Replace the whole list with a fresh first page (recent-first). */
export function setInitial(list: SEASignal[]): void {
  if (!Array.isArray(list)) return;
  seen.clear();
  const next: SEASignal[] = [];
  for (const s of list) {
    const k = keyOf(s);
    if (seen.has(k)) continue;
    seen.add(k);
    next.push(s);
  }
  signals = next;
  notify();
}

/** Prepend one live signal pushed over the WS. No-op if already present. */
export function addLive(sig: SEASignal): void {
  if (!sig) return;
  const k = keyOf(sig);
  if (seen.has(k)) return;
  seen.add(k);
  signals = [sig, ...signals];
  notify();
}

/** Append an older page fetched on scroll. Deduped; preserves order. */
export function appendOlder(list: SEASignal[]): void {
  if (!Array.isArray(list) || list.length === 0) return;
  const fresh: SEASignal[] = [];
  for (const s of list) {
    const k = keyOf(s);
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(s);
  }
  if (fresh.length === 0) return;
  signals = [...signals, ...fresh];
  notify();
}

// ── Readers ────────────────────────────────────────────────────────────────

/** The `ts` cursor for lazy-loading older pages (oldest loaded signal). */
export function getOldestTs(): number | undefined {
  const last = signals[signals.length - 1];
  return last ? (last as any).ts : undefined;
}

/** Subscribe a component to the signal list (recent-first). */
export function useSignals(): SEASignal[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}
