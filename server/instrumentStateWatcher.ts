/**
 * instrumentStateWatcher — push TFA live state to the UI instead of polling.
 *
 * The 4 instrument feature files (data/features/<inst>_live.ndjson) are
 * appended per tick by TFA. Five UI surfaces used to poll trading.
 * instrumentLiveState (2s–30s each). Instead, we watch the directory once and,
 * throttled to ~1/s per instrument, read the latest state and push it over
 * /ws/ticks. All consumers then read a store fed by the WS — no polling.
 *
 * Reading is cheap regardless of file size: getInstrumentLiveState seeks to the
 * last line (32 KB tail) and is mtime-cached.
 */
import { watch, type FSWatcher } from "fs";
import path from "path";
import { getInstrumentLiveState } from "./instrumentLiveState";
import { tickBus } from "./broker/tickBus";
import { createLogger } from "./broker/logger";

const log = createLogger("BSA", "InstrStateWatch");

export const WATCHED_INSTRUMENTS = ["nifty50", "banknifty", "crudeoil", "naturalgas"];
const THROTTLE_MS = 1000;
const FEATURES_DIR = path.resolve("data/features");

const lastEmitAt = new Map<string, number>();
const pending = new Map<string, NodeJS.Timeout>();

function emitFor(inst: string): void {
  try {
    const state = getInstrumentLiveState(inst);
    tickBus.emitInstrumentState({ instrument: inst, state });
    lastEmitAt.set(inst, Date.now());
  } catch {
    /* transient read race while TFA appends — the next change re-emits */
  }
}

/** Leading-edge + trailing throttle: emit at most once per THROTTLE_MS/inst. */
function onChange(inst: string): void {
  const now = Date.now();
  const last = lastEmitAt.get(inst) ?? 0;
  if (now - last >= THROTTLE_MS) {
    emitFor(inst);
    return;
  }
  if (pending.has(inst)) return; // a trailing emit is already scheduled
  pending.set(
    inst,
    setTimeout(() => {
      pending.delete(inst);
      emitFor(inst);
    }, THROTTLE_MS - (now - last)),
  );
}

function instForFile(filename: string | null): string | null {
  if (!filename) return null;
  const m = /^([a-z0-9]+)_live\.ndjson$/.exec(filename);
  return m && WATCHED_INSTRUMENTS.includes(m[1]) ? m[1] : null;
}

let watcher: FSWatcher | null = null;

/** Start watching the features dir. Returns a stop function. */
export function startInstrumentStateWatcher(): () => void {
  try {
    watcher = watch(FEATURES_DIR, (_event, filename) => {
      const inst = instForFile(typeof filename === "string" ? filename : null);
      if (inst) onChange(inst);
    });
    log.important(`Watching ${FEATURES_DIR} for *_live.ndjson changes`);
  } catch (err: any) {
    log.warn(`instrument-state watcher failed to start: ${err?.message ?? err}`);
  }
  return () => {
    watcher?.close();
    watcher = null;
    pending.forEach((t) => clearTimeout(t));
    pending.clear();
  };
}
