/**
 * chainSnapshotFallback — feed the T173 chain strip when the LIVE chain isn't
 * available (market closed, token expired, replay/past-date review). Reads the
 * day's RECORDED chain snapshots (the same ndjson.gz stream replayLock uses)
 * and returns the LAST snapshot of the day plus the one ~5 min earlier for the
 * OI-change column. Past dates are immutable so they cache forever; today's
 * file grows, so it re-reads after a short TTL.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import readline from "readline";

const RAW_DIR = process.env.REPLAY_DATA_DIR || path.join(process.cwd(), "data", "raw");

export interface RecordedChainStrip {
  /** Dashed date the snapshot came from (YYYY-MM-DD). */
  date: string;
  expiry: string;
  spot: number;
  rows: {
    strike: number; callOI: number; putOI: number; callLTP: number; putLTP: number;
    callIV: number; putIV: number; callSecurityId?: string; putSecurityId?: string;
  }[];
  /** OI per strike ~5 min before the last snapshot, for the change column. */
  prevOi: Map<number, { callOI: number; putOI: number }> | null;
  /** Wall-clock ms of the last snapshot (drives the strip's as-of + greeks). */
  asOfMs: number;
}

const cache = new Map<string, { at: number; data: RecordedChainStrip | null }>();

function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** Most recent recorded date (≤10 back) that has a chain file for `inst`. */
function latestRecordedDate(inst: string): string | null {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(RAW_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  } catch { return null; }
  for (const d of dirs.slice(0, 10)) {
    if (fs.existsSync(path.join(RAW_DIR, d, `${inst}_chain_snapshots.ndjson.gz`))) return d;
  }
  return null;
}

function readDay(inst: string, date: string): Promise<RecordedChainStrip | null> {
  return new Promise((resolve) => {
    const file = path.join(RAW_DIR, date, `${inst}_chain_snapshots.ndjson.gz`);
    if (!fs.existsSync(file)) { resolve(null); return; }
    // Sliding ~6-min buffer of parsed snapshots; at EOF the newest is "now"
    // and the oldest ≥5-min-older one supplies the OI change.
    const buf: { ts: number; snap: any }[] = [];
    const finish = () => {
      const last = buf[buf.length - 1];
      if (!last?.snap?.rows?.length || !(last.snap.spotPrice > 0)) { resolve(null); return; }
      const prev = buf.find((e) => last.ts - e.ts >= 300) ?? null;
      resolve({
        date,
        expiry: String(last.snap.expiry ?? ""),
        spot: last.snap.spotPrice,
        rows: last.snap.rows.filter((r: any) => r?.strike > 0),
        prevOi: prev
          ? new Map((prev.snap.rows as any[]).filter((r) => r?.strike > 0).map((r) => [r.strike, { callOI: r.callOI ?? 0, putOI: r.putOI ?? 0 }]))
          : null,
        asOfMs: Math.round(last.ts * 1000),
      });
    };
    const gunzip = zlib.createGunzip();
    // A power-cut can truncate the gz mid-stream — keep whatever parsed cleanly.
    gunzip.on("error", finish);
    const input = fs.createReadStream(file).on("error", finish).pipe(gunzip);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const snap = JSON.parse(line);
        const ts = Number(snap?.recv_ts);
        if (!Number.isFinite(ts)) return;
        buf.push({ ts, snap });
        while (buf.length && buf[buf.length - 1].ts - buf[0].ts > 360) buf.shift();
      } catch { /* skip corrupt line */ }
    });
    rl.on("close", finish);
  });
}

/** The recorded-chain strip for `inst`: `date` if given (dashed), else the most
 *  recent recorded day. Null when nothing recorded / file unreadable. */
export async function readRecordedChainStrip(inst: string, date?: string): Promise<RecordedChainStrip | null> {
  const day = date ?? latestRecordedDate(inst);
  if (!day) return null;
  const key = `${inst}:${day}`;
  const ttl = day === istToday() ? 60_000 : Infinity;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = await readDay(inst, day);
  cache.set(key, { at: Date.now(), data });
  return data;
}
