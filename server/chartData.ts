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
import { readFileSync, existsSync, readdirSync, createReadStream } from "fs";
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
}

/**
 * Read one instrument's recorded underlying ticks for a date. Returns empty
 * arrays when the file is missing (unrecorded day) or unreadable.
 */
export function readUnderlyingTicks(instrument: string, date: string): UnderlyingTicks {
  if (!DATE_RE.test(date)) return { t: [], ltp: [] };
  const file = underlyingFilePath(instrument, date);
  if (!existsSync(file)) return { t: [], ltp: [] };

  let text: string;
  try {
    // TODAY's file is a LIVE-appended gzip whose final member isn't closed yet,
    // so a strict gunzip throws "unexpected end of file". Z_SYNC_FLUSH returns
    // everything decompressed so far (all closed members + the partial tail);
    // the half-written trailing line is skipped by the per-line guard below.
    text = zlib
      .gunzipSync(readFileSync(file), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
      .toString("utf8");
  } catch {
    return { t: [], ltp: [] };
  }

  const t: number[] = [];
  const ltp: number[] = [];
  let start = 0;
  const len = text.length;
  // Iterate lines without allocating a giant array (split would double memory).
  while (start < len) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = len;
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
    t.push(ts);
    ltp.push(price);
  }
  return { t, ltp };
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
export function readOptionContractTicks(
  instrument: string,
  date: string,
  securityId: string,
): Promise<UnderlyingTicks> {
  if (!DATE_RE.test(date) || !securityId) return Promise.resolve({ t: [], ltp: [] });
  const folder = logFolderFor(instrument);
  const file = path.resolve(DATA_RAW, date, `${folder}_option_ticks.ndjson.gz`);
  if (!existsSync(file)) return Promise.resolve({ t: [], ltp: [] });

  const needle = `"security_id": "${securityId}"`;
  const t: number[] = [];
  const ltp: number[] = [];

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ t, ltp });
    };
    const gunzip = zlib.createGunzip();
    gunzip.on("error", finish); // unfinished tail of a live-appended gzip
    const stream = createReadStream(file);
    stream.on("error", finish);
    const rl = readline.createInterface({ input: stream.pipe(gunzip) });
    rl.on("line", (line) => {
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
