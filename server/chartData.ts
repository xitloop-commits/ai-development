/**
 * chartData — serve the pop-out instrument chart from OUR recorded ticks.
 *
 * The TFA recorder writes every underlying (near-month future) tick to
 *   data/raw/<YYYY-MM-DD>/<instrument>_underlying_ticks.ndjson.gz
 * one gzipped NDJSON line per tick. Each line carries `recv_ts` (epoch seconds,
 * our receive time) and `ltp` (last price). One security per file, so no
 * per-contract filtering is needed — every line is that instrument's underlying.
 *
 * These files are small (~1.4 MB/day, ~27k lines) so a full synchronous read +
 * regex extract is fast (< ~100 ms). We pull only recv_ts + ltp per line via
 * regex (NOT JSON.parse) to skip building the big per-line objects (depth arrays
 * etc.). For "today" the client re-polls this endpoint to pick up freshly
 * flushed ticks (near-live); a half-written trailing line is simply skipped.
 *
 * NOTE: the OPTION tick files (…_option_ticks.ndjson.gz) are 0.5–1 GB (every
 * strike) and are deliberately NOT read here — only the tiny underlying files.
 */
import { readFileSync, existsSync, readdirSync, createReadStream, statSync, openSync, readSync, closeSync } from "fs";
import readline from "readline";
import path from "path";
import zlib from "zlib";
import { logFolderFor } from "./seaSignals";

const DATA_RAW = "data/raw";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// First occurrence per line — `ltp` / `recv_ts` are top-level fields; the depth
// array uses bid_price/ask_price, so `"ltp":` is unique on the line.
const LTP_RE = /"ltp":\s*(-?[0-9.]+)/;
const RECV_TS_RE = /"recv_ts":\s*([0-9.]+)/;

function underlyingFilePath(instrument: string, date: string): string {
  const folder = logFolderFor(instrument);
  return path.resolve(DATA_RAW, date, `${folder}_underlying_ticks.ndjson.gz`);
}

/** Parallel arrays of the underlying's ticks for one date (epoch SECONDS, UTC). */
export interface UnderlyingTicks {
  t: number[];   // recv_ts, epoch seconds (UTC)
  ltp: number[]; // last price
  /** The recorded contract (near-month future) id + segment — so the client can
   *  subscribe the SAME contract live and append to this disk history. */
  securityId?: string | null;
  exchangeSegment?: string | null;
}

const SECID_RE = /"security_id":\s*"?([0-9]+)"?/;
const SEG_RE = /"exchange_segment":\s*"([A-Z_]+)"/;

// ─── Incremental per-(instrument,date) tick cache (2026-08-11) ─────────────
// The old path re-decompressed and re-parsed the WHOLE day file on every
// request (~6s for a late-session MCX file), and the MCX charts poll every
// 30s. This cache keeps a long-lived Gunzip stream per (instrument, date):
// the first request pays the full parse once; each later request feeds ONLY
// the bytes the recorder appended since (the recorder sync-flushes every 3s,
// so the tail is always decodable). Node's Gunzip handles the multi-member
// files a recorder restart produces.

interface TickCacheEntry {
  bytesFed: number;
  gunzip: zlib.Gunzip;
  dead: boolean;            // decompressor errored → legacy full read fallback
  pending: string;          // trailing partial line, waiting for its newline
  t: number[];
  ltp: number[];
  securityId: string | null;
  exchangeSegment: string | null;
  chain: Promise<unknown>;  // serializes appends per entry
  lastAccess: number;
}

const tickCache = new Map<string, TickCacheEntry>();
const TICK_CACHE_MAX = 8; // ~6 MB/entry worst case — bounded, LRU-evicted

function newCacheEntry(): TickCacheEntry {
  const entry: TickCacheEntry = {
    bytesFed: 0,
    gunzip: zlib.createGunzip(),
    dead: false,
    pending: "",
    t: [],
    ltp: [],
    securityId: null,
    exchangeSegment: null,
    chain: Promise.resolve(),
    lastAccess: Date.now(),
  };
  entry.gunzip.on("error", () => { entry.dead = true; });
  return entry;
}

/** Parse complete NDJSON lines out of `text` into the entry's arrays; keep the
 *  trailing partial line in `entry.pending` for the next append. */
function parseIntoEntry(entry: TickCacheEntry, decoded: string): void {
  const text = entry.pending + decoded;
  const lastNl = text.lastIndexOf("\n");
  if (lastNl === -1) { entry.pending = text; return; }
  entry.pending = text.slice(lastNl + 1);
  let start = 0;
  while (start <= lastNl) {
    let end = text.indexOf("\n", start);
    if (end === -1 || end > lastNl) end = lastNl;
    const line = text.slice(start, end);
    start = end + 1;
    if (line.length < 8) continue;
    const lm = LTP_RE.exec(line);
    if (!lm) continue;
    const tm = RECV_TS_RE.exec(line);
    if (!tm) continue;
    const price = parseFloat(lm[1]);
    const ts = parseFloat(tm[1]);
    if (!(price > 0) || !(ts > 0)) continue;
    entry.t.push(ts);
    entry.ltp.push(price);
    if (entry.securityId == null) {
      const sm = SECID_RE.exec(line);
      if (sm) entry.securityId = sm[1];
      const gm = SEG_RE.exec(line);
      if (gm) entry.exchangeSegment = gm[1];
    }
  }
}

/** Feed one raw chunk through the entry's decompressor; resolves with the
 *  decoded text once a Z_SYNC_FLUSH has pushed everything through. */
function feedChunk(entry: TickCacheEntry, chunk: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    const onData = (d: Buffer) => parts.push(d);
    const fail = (err: unknown) => { cleanup(); reject(err); };
    const cleanup = () => {
      entry.gunzip.off("data", onData);
      entry.gunzip.off("error", fail);
    };
    entry.gunzip.on("data", onData);
    entry.gunzip.on("error", fail);
    entry.gunzip.write(chunk, (err) => {
      if (err) return fail(err);
      entry.gunzip.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        cleanup();
        resolve(Buffer.concat(parts).toString("utf8"));
      });
    });
  });
}

/** Read [from, to) of a file without holding it open between calls. */
function readFileSlice(file: string, from: number, to: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(to - from);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, from + off);
      if (n <= 0) break;
      off += n;
    }
    return off === buf.length ? buf : buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

/** Legacy one-shot full read — fallback when the streaming entry went dead. */
function readUnderlyingTicksFull(file: string): UnderlyingTicks {
  const entry = newCacheEntry(); // reuse the parser, throw the entry away
  try {
    const text = zlib
      .gunzipSync(readFileSync(file), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
      .toString("utf8");
    parseIntoEntry(entry, text + "\n");
  } catch {
    return { t: [], ltp: [] };
  }
  return { t: entry.t, ltp: entry.ltp, securityId: entry.securityId, exchangeSegment: entry.exchangeSegment };
}

/**
 * Read one instrument's recorded underlying ticks for a date. Returns empty
 * arrays when the file is missing (unrecorded day) or unreadable. Cached
 * incrementally — repeat calls only decompress the newly appended bytes.
 */
export async function readUnderlyingTicks(instrument: string, date: string): Promise<UnderlyingTicks> {
  if (!DATE_RE.test(date)) return { t: [], ltp: [] };
  const file = underlyingFilePath(instrument, date);
  if (!existsSync(file)) return { t: [], ltp: [] };

  const key = `${logFolderFor(instrument)}:${date}`;
  let entry = tickCache.get(key);
  const size = statSync(file).size;
  // A shrunk file means it was replaced (repair/re-record) — start over.
  if (entry && size < entry.bytesFed) {
    tickCache.delete(key);
    entry = undefined;
  }
  if (!entry) {
    entry = newCacheEntry();
    tickCache.set(key, entry);
    // LRU eviction, never evicting the entry we just made.
    if (tickCache.size > TICK_CACHE_MAX) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      tickCache.forEach((e, k) => {
        if (k !== key && e.lastAccess < oldestTs) { oldestTs = e.lastAccess; oldestKey = k; }
      });
      if (oldestKey) {
        tickCache.get(oldestKey)?.gunzip.destroy();
        tickCache.delete(oldestKey);
      }
    }
  }
  entry.lastAccess = Date.now();

  if (entry.dead) return readUnderlyingTicksFull(file);

  const e = entry;
  const job = e.chain.then(async () => {
    if (e.dead || size <= e.bytesFed) return;
    const chunk = readFileSlice(file, e.bytesFed, size);
    try {
      const decoded = await feedChunk(e, chunk);
      e.bytesFed += chunk.length;
      parseIntoEntry(e, decoded);
    } catch {
      e.dead = true; // corrupt stream — future calls use the full-read fallback
    }
  });
  e.chain = job.catch(() => {});
  await job;

  if (e.dead) return readUnderlyingTicksFull(file);
  // Snapshot copies: a later append must never mutate arrays mid-serialization.
  return { t: e.t.slice(), ltp: e.ltp.slice(), securityId: e.securityId, exchangeSegment: e.exchangeSegment };
}

/**
 * Read ONE option contract's ticks for a date from the recorded option file
 * (data/raw/<date>/<inst>_option_ticks.ndjson.gz — all strikes, so we filter by
 * security_id). These files are large (0.2–1 GB), so this STREAMS the gunzip
 * (never blocks the loop on a giant sync inflate) and does a cheap substring
 * pre-filter before the regex extract. Live "today" file is a gzip still being
 * appended → the gunzip stream errors on the unfinished tail; we resolve with
 * whatever decoded so far. Meant to be called in the background (~15–30s) to
 * back-fill the live option panels; do NOT poll it.
 */
// Serialize option back-fill scans across the whole server. Each scan reads the
// 0.2–1 GB option file; running several at once (both chart windows × CE+PE = 4,
// plus every refresh spawns more) saturates the event loop / libuv threadpool and
// STARVES the live WS tick broadcast — the bar and chart freeze. One-at-a-time +
// periodic yielding keeps the loop responsive so live ticks always get through.
let optionScanChain: Promise<unknown> = Promise.resolve();

export function readOptionContractTicks(
  instrument: string,
  date: string,
  securityId: string,
): Promise<UnderlyingTicks> {
  if (!DATE_RE.test(date) || !securityId) return Promise.resolve({ t: [], ltp: [] });
  const folder = logFolderFor(instrument);
  const file = path.resolve(DATA_RAW, date, `${folder}_option_ticks.ndjson.gz`);
  if (!existsSync(file)) return Promise.resolve({ t: [], ltp: [] });

  const run = () => scanOptionFile(file, securityId);
  const result = optionScanChain.then(run, run);
  // Keep the chain alive even if a scan rejects, so one failure can't wedge the queue.
  optionScanChain = result.catch(() => {});
  return result;
}

/** One serialized option-file scan: filters to `securityId`, yields the event
 *  loop every ~131k lines, and self-caps at 90s so a stuck stream can't wedge
 *  the shared queue. Live-appended "today" file → gunzip errors on the unfinished
 *  tail; we resolve with whatever decoded so far. */
function scanOptionFile(file: string, securityId: string): Promise<UnderlyingTicks> {
  const needle = `"security_id": "${securityId}"`;
  const t: number[] = [];
  const ltp: number[] = [];

  return new Promise((resolve) => {
    let done = false;
    const gunzip = zlib.createGunzip();
    const stream = createReadStream(file);
    const rl = readline.createInterface({ input: stream.pipe(gunzip) });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { rl.close(); stream.destroy(); } catch { /* already closed */ }
      resolve({ t, ltp });
    };
    const timer = setTimeout(finish, 90_000); // safety: never hold the queue > 90s
    gunzip.on("error", finish); // unfinished tail of a live-appended gzip
    stream.on("error", finish);
    let seen = 0;
    rl.on("line", (line) => {
      // Breathe every ~131k lines so the live WS broadcast isn't starved while
      // scanning this giant file.
      if ((++seen & 0x1ffff) === 0) { rl.pause(); setImmediate(() => rl.resume()); }
      if (line.length < 8 || !line.includes(needle)) return;
      const lm = LTP_RE.exec(line);
      if (!lm) return;
      const tm = RECV_TS_RE.exec(line);
      if (!tm) return;
      const price = parseFloat(lm[1]);
      const ts = parseFloat(tm[1]);
      if (price > 0 && ts > 0) {
        t.push(ts);
        ltp.push(price);
      }
    });
    rl.on("close", finish);
    rl.on("error", finish);
  });
}

/**
 * List the dates (YYYY-MM-DD, ascending) for which this instrument has a
 * recorded underlying tick file on disk — drives the chart's date picker.
 */
export function listRecordedDates(instrument: string): string[] {
  const folder = logFolderFor(instrument);
  const root = path.resolve(DATA_RAW);
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const dates: string[] = [];
  for (const name of entries) {
    if (!DATE_RE.test(name)) continue;
    const file = path.resolve(root, name, `${folder}_underlying_ticks.ndjson.gz`);
    if (existsSync(file)) dates.push(name);
  }
  dates.sort();
  return dates;
}
