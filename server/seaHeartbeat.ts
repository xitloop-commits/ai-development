/**
 * seaHeartbeat — in-memory liveness tracker for the SEA engines.
 *
 * Each SEA process POSTs /api/sea/heartbeat every ~5s from a background thread
 * (independent of tick flow). We keep the last-seen time per instrument and
 * expose a freshness view to the UI so it can show whether SEA is running —
 * even when the feed is starved and no signals are flowing.
 *
 * In-memory only: a server restart clears it, but the next heartbeat (≤5s)
 * repopulates it. No persistence needed for a liveness signal.
 */

import { tickBus } from "./broker/tickBus";

/** A SEA engine counts as alive if its last heartbeat is within this window. */
const FRESH_MS = 30_000;

/** T163 — premium-ribbon warm-up state reported inside the heartbeat, so the
 *  UI can show "signal engine warming up" instead of unexplained silence. */
export interface SeaRibbonState {
  state: "ready" | "warming" | "no-feed";
  samples: number;
  need: number;
}

const lastSeen = new Map<string, { ts: number; ribbon: SeaRibbonState | null }>();

function norm(instrument: string): string {
  return (instrument || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Record a heartbeat from one SEA engine, then push the fresh liveness
 *  snapshot to browser clients over /ws/ticks (no UI polling). */
export function recordSeaHeartbeat(instrument: string, ribbon?: unknown): void {
  if (!instrument) return;
  const r = ribbon as SeaRibbonState | null | undefined;
  const clean: SeaRibbonState | null =
    r && typeof r === "object" && typeof r.state === "string"
      ? {
          state: r.state === "ready" ? "ready" : r.state === "warming" ? "warming" : "no-feed",
          samples: Number(r.samples) || 0,
          need: Number(r.need) || 0,
        }
      : null;
  lastSeen.set(norm(instrument), { ts: Date.now(), ribbon: clean });
  tickBus.emitSeaStatus(getSeaStatus());
}

export interface SeaInstrumentStatus {
  instrument: string;
  ageSec: number;
  alive: boolean;
  /** Premium-ribbon warm-up (null on engines that predate T163). */
  ribbon: SeaRibbonState | null;
}

export interface SeaStatus {
  /** True when at least one SEA engine has heartbeat within FRESH_MS. */
  anyAlive: boolean;
  /** Count of engines currently alive. */
  aliveCount: number;
  /** Per-instrument status for every engine seen this session. */
  instruments: SeaInstrumentStatus[];
}

/** Snapshot of SEA liveness for the UI indicator. */
export function getSeaStatus(): SeaStatus {
  const now = Date.now();
  const instruments: SeaInstrumentStatus[] = Array.from(lastSeen.entries()).map(
    ([inst, v]) => ({
      instrument: inst,
      ageSec: Math.round((now - v.ts) / 1000),
      alive: now - v.ts <= FRESH_MS,
      ribbon: v.ribbon,
    }),
  );
  instruments.sort((a, b) => a.instrument.localeCompare(b.instrument));
  const aliveCount = instruments.filter((i) => i.alive).length;
  return { anyAlive: aliveCount > 0, aliveCount, instruments };
}