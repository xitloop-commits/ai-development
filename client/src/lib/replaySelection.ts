/**
 * replaySelection — which replay run the desk is showing (T97).
 *
 * Same module-singleton + useSyncExternalStore shape as selectionStore: the
 * Replay pane (left drawer) and the TradingDesk are siblings, so this avoids
 * threading a prop through the whole shell.
 *
 * `null` means "show the live book". A selected run puts the desk into a
 * read-only view of that experiment — no capital, no day cycle, just its trades.
 */
import { useSyncExternalStore } from "react";

let selectedRunId: string | null = null;
const listeners = new Set<() => void>();

export function setSelectedRunId(runId: string | null): void {
  // Clicking the selected run again clears it and returns to the live book.
  selectedRunId = selectedRunId === runId ? null : runId;
  listeners.forEach((l) => l());
}

function getSnapshot(): string | null {
  return selectedRunId;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useSelectedRunId(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
