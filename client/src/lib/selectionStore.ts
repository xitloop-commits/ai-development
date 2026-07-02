/**
 * selectionStore — tiny cross-component selection for linking the signal tray
 * to the trading desk. Clicking a signal card sets `selectedSignalSeq`; the
 * matching trade row (same signalSeq) highlights and scrolls into view.
 *
 * Module singleton + useSyncExternalStore, so no provider/prop-drilling is
 * needed between the sibling SignalsFeed and TradingDesk trees.
 */
import { useSyncExternalStore } from "react";

let selectedSignalSeq: number | null = null;
const listeners = new Set<() => void>();

export function setSelectedSignalSeq(seq: number | null): void {
  // Toggle off when the same card is clicked again.
  selectedSignalSeq = selectedSignalSeq === seq ? null : seq;
  listeners.forEach((l) => l());
}

function getSelectedSignalSeq(): number | null {
  return selectedSignalSeq;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useSelectedSignalSeq(): number | null {
  return useSyncExternalStore(subscribe, getSelectedSignalSeq, getSelectedSignalSeq);
}
