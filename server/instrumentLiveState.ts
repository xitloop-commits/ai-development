/**
 * instrumentLiveState.ts — Read live TFA + SEA + model state for one instrument.
 *
 * Serves the InstrumentCard v2 left-drawer panel. Reads:
 *   1. Last row of data/features/{instrument}_live.ndjson → live features + health
 *   2. Last signal from logs/signals/{instrument}/YYYY-MM-DD_signals.log
 *   3. Model info from models/{instrument}/LATEST + metrics.json
 */

import { readFileSync, existsSync, statSync, openSync, readSync, fstatSync, closeSync } from "fs";
import path from "path";

// ── Types ────────────────────────────────────────────────────

export interface LiveState {
  live: LiveTick | null;
  signal: LatestSignal | null;
  model: ModelInfo | null;
}

export interface LiveTick {
  timestamp: number;
  spot_price: number;
  atm_strike: number;
  strike_step: number;
  data_quality_flag: number;
  time_since_chain_sec: number;
  trading_state: string;
  is_market_open: number;
  chain_available: number;
  active_strike_count: number;
  // Key features
  regime: string | null;
  underlying_momentum: number | null;
  underlying_velocity: number | null;
  underlying_ofi_5: number | null;
  volatility_compression: number | null;
  breakout_readiness: number | null;
  zone_activity_score: number | null;
  chain_pcr_atm: number | null;
  chain_oi_imbalance_atm: number | null;
  // ATM option prices
  opt_0_ce_ltp: number | null;
  opt_0_pe_ltp: number | null;
  opt_0_ce_bid_ask_imbalance: number | null;
  opt_0_pe_bid_ask_imbalance: number | null;
  // Tick freshness
  file_age_sec: number;
}

export interface LatestSignal {
  direction: string;
  action: string | null;
  direction_prob_30s: number;
  max_upside_pred_30s: number;
  max_drawdown_pred_30s: number;
  regime: string | null;
  entry: number | null;
  tp: number | null;
  sl: number | null;
  rr: number | null;
  atm_strike: number;
  atm_ce_ltp: number | null;
  atm_pe_ltp: number | null;
  spot_price: number | null;
  timestamp_ist: string;
  model_version: string;
}

export interface ModelInfo {
  version: string;
  trained_at: string;
  feature_count: number;
  metrics: Record<string, any>;
}

// ── Helpers ──────────────────────────────────────────────────

function readLastJsonLine(filePath: string): any | null {
  if (!existsSync(filePath)) return null;
  try {
    const buf = Buffer.alloc(32768);
    const fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    const readFrom = Math.max(0, size - 32768);
    const bytesRead = readSync(fd, buf, 0, 32768, readFrom);
    closeSync(fd);
    const chunk = buf.toString("utf-8", 0, bytesRead);
    const lines = chunk.split("\n").filter((l: string) => l.trim().startsWith("{"));
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// ── Main function ────────────────────────────────────────────

const INSTRUMENT_MAP: Record<string, string> = {
  nifty50: "nifty50",
  banknifty: "banknifty",
  crudeoil: "crudeoil",
  naturalgas: "naturalgas",
};

// Mtime-keyed memo. With four InstrumentCards open polling every 5s, the
// raw read is 4 × (1 ndjson + 1 signal file + 3 model files) = 20 disk
// reads/sec; with this cache it drops to ~0/s while files are stable.
type LiveStateCacheEntry = {
  mtimes: [number, number, number]; // [ndjson, signal_log, model_LATEST]
  value: LiveState;
};
const liveStateCache = new Map<string, LiveStateCacheEntry>();

function safeMtime(p: string): number {
  try { return statSync(p).mtimeMs; } catch { return -1; }
}

/** Test/shutdown hook — drop the per-instrument live-state cache. */
export function clearLiveStateCache(): void {
  liveStateCache.clear();
}

export function getInstrumentLiveState(instrument: string): LiveState {
  const inst = INSTRUMENT_MAP[instrument.toLowerCase()] ?? instrument.toLowerCase();
  const today = todayIST();

  // Fingerprint the three files this call would read. Cheap statSync each
  // time, but the heavy reads (ndjson, signal log, model metrics) only run
  // on a real mtime change.
  const ndjsonPath = path.resolve(`data/features/${inst}_live.ndjson`);
  const sigPath = path.resolve(`logs/signals/${inst}/${today}_signals.log`);
  const latestPath = path.resolve(`models/${inst}/LATEST`);
  const mtimes: [number, number, number] = [
    safeMtime(ndjsonPath),
    safeMtime(sigPath),
    safeMtime(latestPath),
  ];

  const cached = liveStateCache.get(inst);
  if (
    cached &&
    cached.mtimes[0] === mtimes[0] &&
    cached.mtimes[1] === mtimes[1] &&
    cached.mtimes[2] === mtimes[2]
  ) {
    // file_age_sec is "now − ndjson mtime" — must be recomputed each call
    // so the UI sees the age advancing while the file is idle.
    if (cached.value.live && mtimes[0] >= 0) {
      const fresh: LiveState = {
        ...cached.value,
        live: { ...cached.value.live, file_age_sec: Math.round((Date.now() - mtimes[0]) / 1000) },
      };
      return fresh;
    }
    return cached.value;
  }

  // 1. Live tick from ndjson
  const row = readLastJsonLine(ndjsonPath);
  let live: LiveTick | null = null;
  if (row) {
    const fileStat = existsSync(ndjsonPath) ? statSync(ndjsonPath) : null;
    const fileAgeSec = fileStat ? (Date.now() - fileStat.mtimeMs) / 1000 : 9999;
    live = {
      timestamp: row.timestamp ?? 0,
      spot_price: row.spot_price ?? 0,
      atm_strike: row.atm_strike ?? 0,
      strike_step: row.strike_step ?? 0,
      data_quality_flag: row.data_quality_flag ?? 0,
      time_since_chain_sec: row.time_since_chain_sec ?? 999,
      trading_state: row.trading_state ?? "UNKNOWN",
      is_market_open: row.is_market_open ?? 0,
      chain_available: row.chain_available ?? 0,
      active_strike_count: row.active_strike_count ?? 0,
      regime: row.regime ?? null,
      underlying_momentum: row.underlying_momentum ?? null,
      underlying_velocity: row.underlying_velocity ?? null,
      underlying_ofi_5: row.underlying_ofi_5 ?? null,
      volatility_compression: row.volatility_compression ?? null,
      breakout_readiness: row.breakout_readiness ?? null,
      zone_activity_score: row.zone_activity_score ?? null,
      chain_pcr_atm: row.chain_pcr_atm ?? null,
      chain_oi_imbalance_atm: row.chain_oi_imbalance_atm ?? null,
      opt_0_ce_ltp: row.opt_0_ce_ltp ?? null,
      opt_0_pe_ltp: row.opt_0_pe_ltp ?? null,
      opt_0_ce_bid_ask_imbalance: row.opt_0_ce_bid_ask_imbalance ?? null,
      opt_0_pe_bid_ask_imbalance: row.opt_0_pe_bid_ask_imbalance ?? null,
      file_age_sec: Math.round(fileAgeSec),
    };
  }

  // 2. Latest signal
  const sigRow = readLastJsonLine(sigPath);
  let signal: LatestSignal | null = null;
  if (sigRow) {
    signal = {
      direction: sigRow.direction ?? "WAIT",
      action: sigRow.action ?? null,
      direction_prob_30s: sigRow.direction_prob_30s ?? 0,
      max_upside_pred_30s: sigRow.max_upside_pred_30s ?? 0,
      max_drawdown_pred_30s: sigRow.max_drawdown_pred_30s ?? 0,
      regime: sigRow.regime ?? null,
      entry: sigRow.entry ?? null,
      tp: sigRow.tp ?? null,
      sl: sigRow.sl ?? null,
      rr: sigRow.rr ?? null,
      atm_strike: sigRow.atm_strike ?? 0,
      atm_ce_ltp: sigRow.atm_ce_ltp ?? null,
      atm_pe_ltp: sigRow.atm_pe_ltp ?? null,
      spot_price: sigRow.spot_price ?? null,
      timestamp_ist: sigRow.timestamp_ist ?? "",
      model_version: sigRow.model_version ?? "",
    };
  }

  // 3. Model info
  let model: ModelInfo | null = null;
  if (existsSync(latestPath)) {
    try {
      const version = readFileSync(latestPath, "utf-8").trim();
      const metricsPath = path.resolve(`models/${inst}/${version}/metrics.json`);
      const manifestPath = path.resolve(`models/${inst}/${version}/training_manifest.json`);
      let metrics = {};
      let featureCount = 0;
      let trainedAt = version;
      if (existsSync(metricsPath)) {
        metrics = JSON.parse(readFileSync(metricsPath, "utf-8"));
      }
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        featureCount = manifest.feature_count ?? 0;
        trainedAt = manifest.timestamp ?? version;
      }
      model = { version, trained_at: trainedAt, feature_count: featureCount, metrics };
    } catch {
      // skip
    }
  }

  const value: LiveState = { live, signal, model };
  liveStateCache.set(inst, { mtimes, value });
  return value;
}
