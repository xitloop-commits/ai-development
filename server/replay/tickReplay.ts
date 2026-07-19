/**
 * Tick replay driver (live-simulation, Node side).
 *
 * Streams a day's RECORDED raw ticks (data/raw/<date>/<inst>_{option,underlying}_ticks.ndjson.gz)
 * back into the SAME in-process tickBus the live Dhan feed publishes to — so the
 * exit engine (tickHandler → TradeBar SL/TSL/TP) processes them exactly as if
 * live. Events are paced by their recorded `recv_ts` from a shared start anchor,
 * scaled by `speed` (1× = real-time). NSE only (banknifty + nifty50) for now.
 *
 * This drives the Node exit engine only. SEA firing needs the Python feature
 * pipeline (a separate driver) — both read the same recorded files.
 *
 * The recorded line format is snake_case with epoch-SECONDS `recv_ts`:
 *   {"ltp":30.75,"ltq":65,"ltt":...,"security_id":"57330",
 *    "exchange_segment":"NSE_FNO","recv_ts":1784259900.108,"strike":..,"opt_type":".."}
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import readline from "readline";
import { tickBus } from "../broker/tickBus";
import type { TickData, ExchangeSegment, MarketDepthLevel } from "../broker/types";
import { createLogger } from "../broker/logger";

const log = createLogger("Replay", "TickReplay");

/** NSE instruments we replay (option = exit-engine ticks, underlying = context). */
const REPLAY_INSTRUMENTS = ["banknifty", "nifty50"] as const;

/** data/raw root — override with REPLAY_DATA_DIR if the server cwd differs. */
const RAW_DIR = process.env.REPLAY_DATA_DIR || path.join(process.cwd(), "data", "raw");

function optionFile(date: string, inst: string): string {
  return path.join(RAW_DIR, date, `${inst}_option_ticks.ndjson.gz`);
}
function underlyingFile(date: string, inst: string): string {
  return path.join(RAW_DIR, date, `${inst}_underlying_ticks.ndjson.gz`);
}

// ─── recorded record → TickData ─────────────────────────────────

function mapDepth(d: unknown): MarketDepthLevel[] {
  if (!Array.isArray(d)) return [];
  return d.map((l: any) => ({
    bidQty: l.bid_qty ?? 0,
    askQty: l.ask_qty ?? 0,
    bidOrders: l.bid_orders ?? 0,
    askOrders: l.ask_orders ?? 0,
    bidPrice: l.bid_price ?? 0,
    askPrice: l.ask_price ?? 0,
  }));
}

/** Build a TickData from a recorded raw-tick record. The exit engine only reads
 *  securityId/exchange/ltp/timestamp, but we populate the rest so chart/other
 *  tickBus consumers behave normally too. */
function recordToTick(rec: any): TickData | null {
  const securityId = rec.security_id != null ? String(rec.security_id) : "";
  const recvTs = rec.recv_ts;
  if (!securityId || typeof recvTs !== "number") return null;
  return {
    securityId,
    exchange: (rec.exchange_segment ?? "NSE_FNO") as ExchangeSegment,
    ltp: rec.ltp ?? 0,
    ltq: rec.ltq ?? 0,
    ltt: rec.ltt ?? 0,
    atp: rec.atp ?? 0,
    volume: rec.volume ?? 0,
    totalSellQty: rec.total_sell ?? 0,
    totalBuyQty: rec.total_buy ?? 0,
    oi: rec.oi ?? 0,
    highOI: rec.high_oi ?? 0,
    lowOI: rec.low_oi ?? 0,
    dayOpen: rec.day_open ?? 0,
    dayClose: rec.day_close ?? 0,
    dayHigh: rec.day_high ?? 0,
    dayLow: rec.day_low ?? 0,
    prevClose: rec.prev_close ?? 0,
    prevOI: rec.prev_oi ?? 0,
    depth: mapDepth(rec.depth),
    bidPrice: rec.bid ?? 0,
    askPrice: rec.ask ?? 0,
    timestamp: Math.round(recvTs * 1000), // recv_ts is epoch SECONDS (float)
  };
}

// ─── Replay state ───────────────────────────────────────────────

export interface ReplayStatus {
  running: boolean;
  date: string | null;
  speed: number;
  startedAt: number | null;
  ticksEmitted: number;
}

let running = false;
let aborted = false;
let currentDate: string | null = null;
let currentSpeed = 1;
let startedAt: number | null = null;
let ticksEmitted = 0;
let activeStreams = 0;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Peek the earliest recorded recv_ts of a file (first line — files are in
 *  receive order). Returns null if the file is missing/empty. */
async function firstRecvTs(file: string): Promise<number | null> {
  if (!fs.existsSync(file)) return null;
  return new Promise((resolve) => {
    const input = fs.createReadStream(file).pipe(zlib.createGunzip());
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let done = false;
    // One-shot: whichever fires first wins (rl.close() emits "close"
    // synchronously, so we must resolve BEFORE closing). Destroy the input so
    // peeking line 1 doesn't stream the whole 585 MB file.
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      resolve(v);
      rl.close();
      input.destroy();
    };
    rl.on("line", (line) => {
      try {
        const ts = JSON.parse(line).recv_ts;
        finish(typeof ts === "number" ? ts : null);
      } catch {
        finish(null);
      }
    });
    rl.on("close", () => finish(null)); // empty file
    input.on("error", () => finish(null));
  });
}

/** Stream one .ndjson.gz, paced by recv_ts from the shared anchor, into tickBus. */
async function streamFile(file: string, t0RecvTs: number, t0Wall: number, speed: number): Promise<void> {
  if (!fs.existsSync(file)) return;
  activeStreams++;
  const rl = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (aborted) break;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const recvTs = rec.recv_ts;
      if (typeof recvTs !== "number") continue;
      // Pace: this event should fire at t0Wall + elapsed/speed.
      const target = t0Wall + ((recvTs - t0RecvTs) * 1000) / speed;
      const wait = target - Date.now();
      if (wait > 4) await delay(wait); // sub-4ms jitter isn't worth a timer
      if (aborted) break;
      const tick = recordToTick(rec);
      if (tick) {
        tickBus.emitTick(tick);
        ticksEmitted++;
      }
    }
  } finally {
    rl.close();
    activeStreams--;
  }
}

/** Dates that have replayable NSE recordings (both instruments' option files). */
export function listReplayDates(): string[] {
  if (!fs.existsSync(RAW_DIR)) return [];
  return fs
    .readdirSync(RAW_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((date) =>
      REPLAY_INSTRUMENTS.every((inst) => fs.existsSync(optionFile(date, inst))),
    )
    .sort()
    .reverse(); // newest first
}

export function getReplayStatus(): ReplayStatus {
  return { running, date: currentDate, speed: currentSpeed, startedAt, ticksEmitted };
}

/**
 * Start replaying a date at `speed` (1× = real-time). Streams both NSE
 * instruments' option + underlying ticks into tickBus, paced by recv_ts from a
 * shared anchor so the two instruments stay time-aligned. Resolves immediately
 * (streaming runs in the background); throws if already running or the date is
 * missing.
 */
export async function startReplay(date: string, speed = 1): Promise<void> {
  if (running) throw new Error("A replay is already running — stop it first.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Bad date: ${date}`);
  if (!(speed > 0)) throw new Error(`Bad speed: ${speed}`);

  const files: string[] = [];
  for (const inst of REPLAY_INSTRUMENTS) {
    const opt = optionFile(date, inst);
    if (!fs.existsSync(opt)) throw new Error(`No recording for ${inst} on ${date}`);
    files.push(opt);
    const und = underlyingFile(date, inst);
    if (fs.existsSync(und)) files.push(und);
  }

  // Shared anchor = earliest recv_ts across all files → mapped to "now".
  const firsts = (await Promise.all(files.map(firstRecvTs))).filter((t): t is number => t != null);
  if (firsts.length === 0) throw new Error(`No usable ticks in ${date}`);
  const t0RecvTs = Math.min(...firsts);
  const t0Wall = Date.now();

  running = true;
  aborted = false;
  currentDate = date;
  currentSpeed = speed;
  startedAt = t0Wall;
  ticksEmitted = 0;

  log.important(`Replay START ${date} @ ${speed}× (${files.length} streams)`);

  // Fire all streams concurrently; flip `running` off when the last one ends.
  void Promise.allSettled(files.map((f) => streamFile(f, t0RecvTs, t0Wall, speed))).then(() => {
    running = false;
    log.important(`Replay END ${date} — ${ticksEmitted} ticks emitted${aborted ? " (stopped)" : ""}`);
  });
}

/** Stop an in-flight replay (streams observe the abort and unwind). */
export function stopReplay(): void {
  if (!running) return;
  aborted = true;
  log.important("Replay STOP requested");
}
