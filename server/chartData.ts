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
import { getReplayStatus } from "./replay/tickReplay";

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
  // No dead-on-error handler any more — feedChunkResilient resyncs past
  // corrupt seams instead of abandoning the stream (2026-08-21).
  entry.gunzip.on("error", () => {});
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

// ── Corruption-tolerant gzip feeding (2026-08-21) ─────────────────────────
// A recorder restart (power cut 08-13, fleet double-start 08-21) leaves the
// day file with a TRUNCATED gzip member followed by the new instance's fresh
// stream. A plain inflater either errors at the seam (readers froze on
// pre-seam data) or goes silent mid-garbage (the index wedge). This feeder
// RESYNCS: on error or silent output it hunts the next gzip member header
// (1f 8b 08) and continues with a fresh inflater — a seam costs the few
// seconds of data it tore, never the rest of the day.
const GZ_MAGIC = Buffer.from([0x1f, 0x8b, 0x08]);

interface GzHost { gunzip: zlib.Gunzip; pending: string }

function freshGunzip(): zlib.Gunzip {
  const g = zlib.createGunzip();
  g.on("error", () => {}); // surfaced per-feed; a bare emit must never crash
  return g;
}

/** feedChunk that survives corrupt seams. Never rejects — it returns whatever
 *  decoded, resyncing past damage. Resets `host.pending` on a resync (a torn
 *  line at a seam is garbage, not a line). */
async function feedChunkResilient(host: GzHost, raw: Buffer): Promise<string> {
  let out = "";
  let buf = raw;
  for (let hop = 0; hop < 16; hop++) {
    let text = "";
    let failed = false;
    try {
      text = await feedChunk(host, buf);
    } catch {
      failed = true;
    }
    out += text;
    if (!failed) {
      // Silent desync: a sizeable chunk decoding to NOTHING means the
      // inflater is lost mid-garbage (no error, no output — the wedge case).
      if (text.length === 0 && buf.length > (1 << 16)) {
        const at = buf.indexOf(GZ_MAGIC);
        if (at > 0) {
          host.gunzip.destroy();
          host.gunzip = freshGunzip();
          host.pending = "";
          buf = buf.subarray(at);
          continue;
        }
      }
      return out;
    }
    // Stream error inside `buf` — restart at the next member header.
    host.gunzip.destroy();
    host.gunzip = freshGunzip();
    host.pending = "";
    const at = buf.indexOf(GZ_MAGIC, 1); // skip the failing start
    if (at === -1) return out;           // seam continues into the next chunk
    buf = buf.subarray(at);
  }
  return out;
}

/** Feed one raw chunk through the entry's decompressor; resolves with the
 *  decoded text once a Z_SYNC_FLUSH has pushed everything through. */
function feedChunk(entry: { gunzip: zlib.Gunzip }, chunk: Buffer): Promise<string> {
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

/** Legacy one-shot full read — fallback when the streaming entry went dead.
 *  gunzipSync stops at a corrupt seam; entries no longer go dead (resilient
 *  feeder), so this path is now rare and its truncation acceptable. */
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
      const decoded = await feedChunkResilient(e, chunk);
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

// ─── TODAY's option-file index (2026-08-11) ────────────────────────────────
// The multichart ATM panes need per-contract session history, and ATM rolls
// mean fresh contracts all day — a 15–30s full-file scan per contract was a
// non-starter. Instead, index TODAY's option file ONCE into per-security
// arrays (incrementally fed exactly like the underlying tick cache), so any
// contract's history is an O(1) lookup and stays fresh as the recorder
// appends. First build streams the whole file (chunked + yielding, ~10–30s,
// serialized on optionScanChain so live WS ticks never starve); after that
// each refresh decompresses only the new bytes. Historical dates keep the
// legacy one-contract scan (indexing every visited day would hoard memory).

interface OptionDayIndex {
  bytesFed: number;
  gunzip: zlib.Gunzip;
  dead: boolean;
  pending: string;
  bySec: Map<string, { t: number[]; ltp: number[] }>;
  chain: Promise<unknown>;
}

const optionIndexCache = new Map<string, OptionDayIndex>();

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function newOptionIndex(): OptionDayIndex {
  const idx: OptionDayIndex = {
    bytesFed: 0,
    gunzip: freshGunzip(), // resilient feeding — seams resync, never kill (2026-08-21)
    dead: false,
    pending: "",
    bySec: new Map(),
    chain: Promise.resolve(),
  };
  return idx;
}

function parseOptionLines(idx: OptionDayIndex, decoded: string): void {
  const text = idx.pending + decoded;
  const lastNl = text.lastIndexOf("\n");
  if (lastNl === -1) { idx.pending = text; return; }
  idx.pending = text.slice(lastNl + 1);
  let start = 0;
  while (start <= lastNl) {
    let end = text.indexOf("\n", start);
    if (end === -1 || end > lastNl) end = lastNl;
    const line = text.slice(start, end);
    start = end + 1;
    if (line.length < 8) continue;
    const lm = LTP_RE.exec(line);
    if (!lm) continue;
    const price = parseFloat(lm[1]);
    if (!(price > 0)) continue; // pre-open zero rows — most lines skip here
    const sm = SECID_RE.exec(line);
    if (!sm) continue;
    const tm = RECV_TS_RE.exec(line);
    if (!tm) continue;
    const ts = parseFloat(tm[1]);
    if (!(ts > 0)) continue;
    let rec = idx.bySec.get(sm[1]);
    if (!rec) { rec = { t: [], ltp: [] }; idx.bySec.set(sm[1], rec); }
    rec.t.push(ts);
    rec.ltp.push(price);
  }
}

/** Bring the index up to the file's current size, 4 MB at a time, yielding
 *  the event loop between chunks so the live WS broadcast keeps flowing. */
async function refreshOptionIndex(idx: OptionDayIndex, file: string): Promise<void> {
  const size = statSync(file).size;
  const CHUNK = 4 << 20;
  while (!idx.dead && idx.bytesFed < size) {
    const to = Math.min(idx.bytesFed + CHUNK, size);
    const raw = readFileSlice(file, idx.bytesFed, to);
    if (raw.length === 0) return;
    // Resilient: a corrupt seam (recorder restart mid-day) resyncs at the
    // next gzip member instead of freezing the index at the seam (2026-08-21).
    const decoded = await feedChunkResilient(idx, raw);
    idx.bytesFed += raw.length;
    parseOptionLines(idx, decoded);
    await new Promise((r) => setImmediate(r));
  }
}

export function readOptionContractTicks(
  instrument: string,
  date: string,
  securityId: string,
): Promise<UnderlyingTicks> {
  if (!DATE_RE.test(date) || !securityId) return Promise.resolve({ t: [], ltp: [] });
  const folder = logFolderFor(instrument);
  const file = path.resolve(DATA_RAW, date, `${folder}_option_ticks.ndjson.gz`);
  if (!existsSync(file)) return Promise.resolve({ t: [], ltp: [] });

  // TODAY → serve from the incrementally-fed per-security index. T165: an
  // ACTIVE replay's date qualifies too — the sim polls contracts every few
  // seconds (SEA premium feed + chart panes), and a full-file scan per poll
  // would starve everything. A past-day file is complete, so the index just
  // builds once and every later hit is instant.
  let replayDate: string | null = null;
  try {
    const rp = getReplayStatus();
    replayDate = rp.running ? rp.date : null;
  } catch { /* replay state unavailable — today-only */ }
  if (date === todayIST() || date === replayDate) {
    const key = `${folder}:${date}`;
    let idx = optionIndexCache.get(key);
    if (idx && statSync(file).size < idx.bytesFed) {
      idx.gunzip.destroy(); // file replaced — start over
      optionIndexCache.delete(key);
      idx = undefined;
    }
    if (!idx) {
      // Evict entries for other dates (yesterday's index after midnight roll,
      // a finished replay's day) — keep today + the active replay date.
      const keep = new Set([todayIST(), replayDate].filter(Boolean));
      optionIndexCache.forEach((v, k) => {
        const kDate = k.slice(k.indexOf(":") + 1);
        if (!keep.has(kDate)) { v.gunzip.destroy(); optionIndexCache.delete(k); }
      });
      idx = newOptionIndex();
      optionIndexCache.set(key, idx);
    }
    const i = idx;
    const run = async (): Promise<UnderlyingTicks> => {
      await refreshOptionIndex(i, file);
      if (i.dead) return scanOptionFile(file, securityId); // legacy fallback
      const rec = i.bySec.get(securityId);
      return rec ? { t: rec.t.slice(), ltp: rec.ltp.slice() } : { t: [], ltp: [] };
    };
    const result = optionScanChain.then(run, run);
    optionScanChain = result.catch(() => {});
    return result;
  }

  const run = () => scanOptionFile(file, securityId);
  const result = optionScanChain.then(run, run);
  // Keep the chain alive even if a scan rejects, so one failure can't wedge the queue.
  optionScanChain = result.catch(() => {});
  return result;
}

/** One serialized option-file scan: filters to `securityId`, yields between
 *  4 MB chunks, and self-caps at 90s so a stuck stream can't wedge the shared
 *  queue. Resilient (2026-08-21): a corrupt seam mid-file (recorder restart /
 *  power cut) resyncs at the next gzip member instead of truncating the scan
 *  at the seam — pre-seam AND post-seam data both return. */
async function scanOptionFile(file: string, securityId: string): Promise<UnderlyingTicks> {
  const needle = `"security_id": "${securityId}"`;
  const t: number[] = [];
  const ltp: number[] = [];
  const host: GzHost = { gunzip: freshGunzip(), pending: "" };
  const deadline = Date.now() + 90_000; // safety: never hold the queue > 90s
  const CHUNK = 4 << 20;
  let size = 0;
  try { size = statSync(file).size; } catch { return { t, ltp }; }
  let fed = 0;
  let carry = ""; // trailing partial line across chunks
  while (fed < size && Date.now() < deadline) {
    const to = Math.min(fed + CHUNK, size);
    const raw = readFileSlice(file, fed, to);
    if (raw.length === 0) break;
    const decoded = await feedChunkResilient(host, raw);
    fed += raw.length;
    const text = carry + decoded;
    const lastNl = text.lastIndexOf("\n");
    carry = lastNl === -1 ? text : text.slice(lastNl + 1);
    if (lastNl !== -1) {
      for (const line of text.slice(0, lastNl).split("\n")) {
        if (line.length < 8 || !line.includes(needle)) continue;
        const lm = LTP_RE.exec(line);
        if (!lm) continue;
        const tm = RECV_TS_RE.exec(line);
        if (!tm) continue;
        const price = parseFloat(lm[1]);
        const ts = parseFloat(tm[1]);
        if (price > 0 && ts > 0) {
          t.push(ts);
          ltp.push(price);
        }
      }
    }
    // Breathe between chunks so the live WS broadcast isn't starved.
    await new Promise((r) => setImmediate(r));
  }
  host.gunzip.destroy();
  return { t, ltp };
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
