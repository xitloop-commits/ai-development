/**
 * seaControl.ts — global SEA cohort on/off control (2026-07-14).
 *
 * Holds the global enabled-state of the toggleable SEA signal cohorts
 * (scalp / trend / ma) and lets the UI flip them live. On a toggle it:
 *   1. pushes the new state to the running SEA processes over a DEDICATED
 *      `/ws/sea-control` websocket — control-only, no tick firehose, applied
 *      by SEA in <100 ms with no restart;
 *   2. persists the flag to config/sea_thresholds/<inst>.json (both index
 *      instruments) so it survives a SEA/server restart;
 *   3. mirrors the state to browsers over the existing /ws/ticks feed so open
 *      panels stay in sync.
 *
 * Global (Phase 1): one toggle applies to both instruments. Per-instrument is
 * a later phase. Only these three cohorts are real toggles — `swing` has no
 * gate (never built) and wave1/wave2 are gate-mode variants of scalp, not
 * on/off switches.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { Server, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { tickBus } from "./broker/tickBus";

export type Cohort = "scalp" | "trend" | "ma";
export interface CohortState {
  scalp: boolean;
  trend: boolean;
  ma: boolean;
  /** MA-Signal reversal size (%). >0 = reversal mode (flip on a peak/trough
   *  pullback of this %); 0 = legacy 20-EMA slope mode. Live-tunable. */
  revPct: number;
}

const REV_MIN = 0.02, REV_MAX = 0.6;

/** cohort → the config block whose `enabled` flag it maps to. */
const CONFIG_BLOCK: Record<Cohort, string> = {
  scalp: "legstart",
  trend: "trend",
  ma: "ma_signal",
};
const INSTRUMENTS = ["banknifty", "nifty50"];
const cfgPath = (inst: string) =>
  resolve(process.cwd(), "config", "sea_thresholds", `${inst}.json`);

// Global state; hydrated from config in initSeaControl().
const state: CohortState = { scalp: true, trend: false, ma: true, revPct: 0.18 };
let wss: WebSocketServer | null = null;

function readFlag(cohort: Cohort): boolean | null {
  try {
    const p = cfgPath(INSTRUMENTS[0]);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    const block = j[CONFIG_BLOCK[cohort]];
    return block && typeof block.enabled === "boolean" ? block.enabled : null;
  } catch {
    return null;
  }
}

/** Write the flag into both instruments' config, editing ONLY that one key
 *  (the file is shared with other work — never rewrite unrelated blocks). */
function persist(cohort: Cohort, enabled: boolean): void {
  for (const inst of INSTRUMENTS) {
    try {
      const p = cfgPath(inst);
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      const block = j[CONFIG_BLOCK[cohort]];
      if (!block || block.enabled === enabled) continue;
      block.enabled = enabled;
      writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
    } catch {
      /* best-effort persistence; live control still works via ws */
    }
  }
}

/** Read the persisted MA-Signal reversal size from the first instrument's cfg. */
function readRevPct(): number | null {
  try {
    const p = cfgPath(INSTRUMENTS[0]);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    const v = j.ma_signal?.rev_pct;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/** Write rev_pct into both instruments' ma_signal block (that key only). */
function persistRevPct(value: number): void {
  for (const inst of INSTRUMENTS) {
    try {
      const p = cfgPath(inst);
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (!j.ma_signal || j.ma_signal.rev_pct === value) continue;
      j.ma_signal.rev_pct = value;
      writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
    } catch {
      /* best-effort; live control still works via ws */
    }
  }
}

function broadcastToSea(): void {
  if (!wss) return;
  const msg = JSON.stringify({ type: "sea_control", state });
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) {
      try {
        c.send(msg);
      } catch {
        /* ignore a single bad client */
      }
    }
  });
}

export function getCohortState(): CohortState {
  return { ...state };
}

export function setCohort(cohort: Cohort, enabled: boolean): CohortState {
  if (state[cohort] === enabled) return { ...state };
  state[cohort] = enabled;
  persist(cohort, enabled); // survives restart
  broadcastToSea(); // → running SEA processes, ~instant
  tickBus.emitSeaControl({ ...state }); // → browsers, panel sync
  return { ...state };
}

/** Set the MA-Signal reversal size (%). Clamped, persisted to both configs, and
 *  pushed to running SEA — the live detector applies it on the next candle. */
export function setRevPct(value: number): CohortState {
  const v = Math.round(Math.min(REV_MAX, Math.max(REV_MIN, value)) * 100) / 100;
  if (state.revPct === v) return { ...state };
  state.revPct = v;
  persistRevPct(v);
  broadcastToSea();
  tickBus.emitSeaControl({ ...state });
  return { ...state };
}

/** Wire the dedicated SEA-control websocket onto the http server + hydrate
 *  the state from config. Call once during server bootstrap. */
export function initSeaControl(server: Server): void {
  for (const c of Object.keys(CONFIG_BLOCK) as Cohort[]) {
    const v = readFlag(c);
    if (v !== null) state[c] = v;
  }
  const rp = readRevPct();
  if (rp !== null) state.revPct = rp;
  wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if ((req.url || "").startsWith("/ws/sea-control")) {
      wss!.handleUpgrade(req, socket, head, (ws) => wss!.emit("connection", ws, req));
    }
  });
  wss.on("connection", (ws) => {
    // Send the current state immediately so SEA syncs on connect / reconnect.
    try {
      ws.send(JSON.stringify({ type: "sea_control", state }));
    } catch {
      /* ignore */
    }
  });
}
