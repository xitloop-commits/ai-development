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
/** Which section the desk shows: the live book (paper/live), or the Replay
 *  section (runs picker + the selected run's trades). The app-bar Paper/Live/
 *  Replay tabs set this. */
let deskMode: "book" | "replay" = "book";
const listeners = new Set<() => void>();

/** Switch the desk between the live book and the Replay section. Leaving Replay
 *  clears any selected run so the book comes back clean. */
export function setDeskMode(mode: "book" | "replay"): void {
  if (deskMode === mode) return;
  deskMode = mode;
  if (mode === "book") selectedRunId = null;
  listeners.forEach((l) => l());
}

export function useDeskMode(): "book" | "replay" {
  return useSyncExternalStore(subscribe, () => deskMode, () => deskMode);
}

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

// ── Replay default chart timeframe ─────────────────────────────────────────
// Persisted default the chart opens at when a replay starts (set in the Replay
// panel). In paper/live the timeframe is locked to the signal-detector config,
// so this only applies to replay. Stored in seconds.
const REPLAY_TF_KEY = "replay.defaultTf";

export function loadReplayDefaultTf(): number | null {
  try {
    const v = localStorage.getItem(REPLAY_TF_KEY);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveReplayDefaultTf(sec: number): void {
  try {
    localStorage.setItem(REPLAY_TF_KEY, String(sec));
  } catch {
    /* ignore quota/availability */
  }
}
