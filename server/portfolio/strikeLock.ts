/**
 * strikeLock — T161 session strike lock (Partha design, 2026-08-11).
 *
 * One contract per instrument+side for the WHOLE session, chosen ITM:
 *   CE = ATM − offset strikes, PE = ATM + offset strikes (offset per
 *   instrument from CommonConfig.strikeLock.perInstrument, default 2).
 *
 * The lock is computed from the live option chain on first demand of the
 * IST day (strike ladder from the chain itself — no hardcoded strike steps),
 * persisted to config/strike_lock_state.json so a server restart keeps the
 * same contracts, and enforced in the validateTrade AI path for whichever
 * books enable it (paper first; live is an explicit opt-in).
 *
 * `relock(instrument)` re-computes from the CURRENT ATM — wired to the
 * drift alert's OK button and the watchlist lock toggle.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { getCommonConfig } from "./aiModeConfig";
import { logFolderFor } from "../seaSignals";
import { createLogger } from "../broker/logger";

const log = createLogger("BSA", "StrikeLock");

const STATE_PATH = resolve("config/strike_lock_state.json");

interface LockLeg { strike: number; securityId: string }

export interface InstrumentLock {
  date: string;       // IST day this lock belongs to
  expiry: string;
  atmAtLock: number;
  offset: number;     // strikes ITM at lock time
  ce: LockLeg;        // ATM − offset (ITM call)
  pe: LockLeg;        // ATM + offset (ITM put)
  lockedAt: number;   // epoch ms
}

let state: Record<string, InstrumentLock> = {};
let hydrated = false;
// One in-flight compute per instrument so concurrent trades don't double-fetch.
const inflight = new Map<string, Promise<InstrumentLock | null>>();

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    if (existsSync(STATE_PATH)) state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    state = {};
  }
}

function persist(): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err: any) {
    log.warn(`persist failed: ${err?.message ?? err}`);
  }
}

/** Is the lock enforced for this channel right now? */
export function strikeLockEnabledFor(channel: "paper" | "live"): boolean {
  const sl = getCommonConfig().strikeLock;
  return channel === "paper" ? sl.paperEnabled : sl.liveEnabled;
}

/** Compute a fresh lock from the live chain: ATM by spot, then step ±offset
 *  along the chain's OWN strike ladder (works for any instrument spacing). */
async function computeLock(instrument: string): Promise<InstrumentLock | null> {
  const inst = logFolderFor(instrument);
  const offset = getCommonConfig().strikeLock.perInstrument[inst] ?? 2;
  const { resolveNearestExpiry, resolveUnderlyingForExpiry } = await import("../executor/tradeResolution");
  const { getActiveBroker } = await import("../broker/brokerService");
  const broker = getActiveBroker();
  if (!broker) return null;
  const resolved = await resolveUnderlyingForExpiry(inst);
  const expiry = await resolveNearestExpiry(inst);
  if (!resolved || !expiry) return null;
  let chain: any;
  try {
    chain = await broker.getOptionChain(resolved.underlying, expiry, resolved.exchangeSegment);
  } catch (err: any) {
    log.warn(`chain fetch failed for ${inst}: ${err?.message ?? err}`);
    return null;
  }
  const rows: any[] = (chain?.rows ?? []).filter((r: any) => r?.strike != null);
  const spot: number = chain?.spotPrice ?? 0;
  if (!rows.length || !(spot > 0)) return null;
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  let atmIdx = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].strike - spot) < Math.abs(sorted[atmIdx].strike - spot)) atmIdx = i;
  }
  const ceRow = sorted[Math.max(0, atmIdx - offset)];             // lower strike → ITM call
  const peRow = sorted[Math.min(sorted.length - 1, atmIdx + offset)]; // higher strike → ITM put
  if (!ceRow?.callSecurityId || !peRow?.putSecurityId) {
    log.warn(`lock legs missing ids for ${inst} (ce ${ceRow?.strike}, pe ${peRow?.strike})`);
    return null;
  }
  const lock: InstrumentLock = {
    date: todayIST(),
    expiry,
    atmAtLock: sorted[atmIdx].strike,
    offset,
    ce: { strike: ceRow.strike, securityId: String(ceRow.callSecurityId) },
    pe: { strike: peRow.strike, securityId: String(peRow.putSecurityId) },
    lockedAt: Date.now(),
  };
  log.important(
    `LOCKED ${inst}: ATM ${lock.atmAtLock} → CE ${lock.ce.strike} / PE ${lock.pe.strike} (offset ${offset}, exp ${expiry})`,
  );
  return lock;
}

/** Today's lock for an instrument — computed on first demand, then stable.
 *  Returns null when the chain isn't reachable (caller falls back to ATM). */
export async function getLock(instrument: string): Promise<InstrumentLock | null> {
  hydrate();
  const inst = logFolderFor(instrument);
  const existing = state[inst];
  if (existing && existing.date === todayIST()) return existing;
  let job = inflight.get(inst);
  if (!job) {
    job = computeLock(inst).then((lock) => {
      inflight.delete(inst);
      if (lock) {
        state[inst] = lock;
        persist();
      }
      return lock;
    });
    inflight.set(inst, job);
  }
  return job;
}

/** Recompute NOW from the current ATM (drift-alert OK / watchlist re-lock). */
export async function relock(instrument: string): Promise<InstrumentLock | null> {
  hydrate();
  const inst = logFolderFor(instrument);
  delete state[inst];
  return getLock(inst);
}

/** Read-only snapshot for the UI (no compute). */
export function lockSnapshot(): Record<string, InstrumentLock> {
  hydrate();
  const today = todayIST();
  const out: Record<string, InstrumentLock> = {};
  for (const k of Object.keys(state)) {
    if (state[k].date === today) out[k] = state[k];
  }
  return out;
}
