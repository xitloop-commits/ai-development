/**
 * replayLock — the strike lock a REPLAYED day would have had (T165).
 *
 * The live T161 lock is computed from the live option chain, so a simulation
 * of a past day can't use it. This module rebuilds the SAME rule — CE = ATM −
 * offset strikes, PE = ATM + offset, offset per instrument from
 * CommonConfig.strikeLock.perInstrument — from the day's RECORDED chain
 * snapshot at (or first after) 09:15 IST. Cached per (date, instrument); the
 * snapshot stream is abandoned as soon as the target line is found.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import readline from "readline";
import { getCommonConfig } from "../portfolio/aiModeConfig";
import { logFolderFor } from "../seaSignals";
import { createLogger } from "../broker/logger";
import type { InstrumentLock } from "../portfolio/strikeLock";

const log = createLogger("Replay", "ReplayLock");

const RAW_DIR = process.env.REPLAY_DATA_DIR || path.join(process.cwd(), "data", "raw");

// null = looked and could not compute (missing/short file) — cached too, so a
// broken day doesn't re-scan on every poll.
const cache = new Map<string, InstrumentLock | null>();
const inflight = new Map<string, Promise<InstrumentLock | null>>();

/** Epoch seconds of 09:15 IST on `date` (NSE session open). */
function sessionOpenTs(date: string): number {
  return Date.parse(`${date}T09:15:00+05:30`) / 1000;
}

function computeFromSnapshot(snap: any, date: string, offset: number): InstrumentLock | null {
  const rows: any[] = (snap?.rows ?? []).filter((r: any) => r?.strike != null);
  const spot: number = snap?.spotPrice ?? 0;
  if (!rows.length || !(spot > 0)) return null;
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  let atmIdx = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].strike - spot) < Math.abs(sorted[atmIdx].strike - spot)) atmIdx = i;
  }
  const ceRow = sorted[Math.max(0, atmIdx - offset)];
  const peRow = sorted[Math.min(sorted.length - 1, atmIdx + offset)];
  if (!ceRow?.callSecurityId || !peRow?.putSecurityId) return null;
  return {
    date,
    expiry: String(snap?.expiry ?? ""),
    atmAtLock: sorted[atmIdx].strike,
    offset,
    ce: { strike: ceRow.strike, securityId: String(ceRow.callSecurityId) },
    pe: { strike: peRow.strike, securityId: String(peRow.putSecurityId) },
    lockedAt: Math.round((snap?.recv_ts ?? 0) * 1000),
  };
}

/** The lock `instrument` would have carried on `date`: first chain snapshot at
 *  or after 09:15 IST (falls back to the day's LAST pre-open snapshot when the
 *  recorder started late). Returns null when it can't be computed. */
export function getReplayLock(instrument: string, date: string): Promise<InstrumentLock | null> {
  const inst = logFolderFor(instrument);
  const key = `${inst}:${date}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  let job = inflight.get(key);
  if (job) return job;

  job = new Promise<InstrumentLock | null>((resolve) => {
    const file = path.join(RAW_DIR, date, `${inst}_chain_snapshots.ndjson.gz`);
    if (!fs.existsSync(file)) { resolve(null); return; }
    const offset = getCommonConfig().strikeLock.perInstrument[inst] ?? 2;
    const openTs = sessionOpenTs(date);
    const input = fs.createReadStream(file).pipe(zlib.createGunzip());
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let last: any = null; // most recent pre-open snapshot (late-start fallback)
    let done = false;
    const finish = (lock: InstrumentLock | null) => {
      if (done) return;
      done = true;
      resolve(lock);
      rl.close();
      input.destroy();
    };
    rl.on("line", (line) => {
      let snap: any;
      try { snap = JSON.parse(line); } catch { return; }
      if (typeof snap?.recv_ts !== "number") return;
      if (snap.recv_ts < openTs) { last = snap; return; }
      finish(computeFromSnapshot(snap, date, offset) ?? (last ? computeFromSnapshot(last, date, offset) : null));
    });
    rl.on("close", () => finish(last ? computeFromSnapshot(last, date, offset) : null));
    input.on("error", () => finish(last ? computeFromSnapshot(last, date, offset) : null));
  }).then((lock) => {
    inflight.delete(key);
    cache.set(key, lock);
    if (lock) {
      log.important(
        `replay lock ${inst} ${date}: ATM ${lock.atmAtLock} → CE ${lock.ce.strike} / PE ${lock.pe.strike} (offset ${lock.offset})`,
      );
    } else {
      log.warn(`replay lock ${inst} ${date}: could not compute (no usable chain snapshot)`);
    }
    return lock;
  });
  inflight.set(key, job);
  return job;
}
