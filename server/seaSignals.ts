/**
 * seaSignals.ts — Read SEA signal logs from disk.
 *
 * Signal Engine Agent (SEA) writes NDJSON files to:
 *   logs/signals/{instrument}/YYYY-MM-DD_signals.log
 *
 * This module tails the last N lines of today's log for each instrument
 * and returns them as typed SEASignal objects.
 */

import { readFileSync, existsSync } from "fs";
import path from "path";

export interface SEASignal {
  id: string;
  timestamp: number;
  timestamp_ist: string;
  instrument: string;
  direction: "GO_CALL" | "GO_PUT";
  direction_prob_30s: number;
  max_upside_pred_30s: number;
  max_drawdown_pred_30s: number;
  atm_strike: number;
  atm_ce_ltp: number | null;
  atm_pe_ltp: number | null;
  atm_ce_security_id?: string | null;
  atm_pe_security_id?: string | null;
  spot_price: number | null;
  momentum: number | null;
  breakout: number | null;
  model_version: string;
  // v2 fields (LONG/SHORT upgrade)
  action?: string;          // LONG_CE | LONG_PE | SHORT_CE | SHORT_PE
  regime?: string;
  entry?: number;
  tp?: number;
  sl?: number;
  rr?: number;
  count?: number;           // number of raw signals collapsed into this entry (dedup)
  // v3 fields (filtered trade recommendations)
  confidence?: string;      // "HIGH" | "MEDIUM"
  score?: number;           // consensus score out of 6
  sustained_ticks?: number; // consecutive ticks that sustained this direction
  avg_prob?: number;        // average conviction probability across window
  filtered?: boolean;       // true = filtered trade recommendation
}

const INSTRUMENTS = ["nifty50", "banknifty", "crudeoil", "naturalgas"];

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function readLastLines(filePath: string, maxLines: number): string[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/**
 * Get today's SEA signals across all instruments (or one specific instrument).
 *
 * Deduplicates consecutive signals with the same instrument + direction
 * within a 30s window into a single entry with a `count` field. This
 * prevents 30 identical GO_PUT signals/second from flooding the UI.
 *
 * Returns newest-first (reversed chronological) for display.
 */

const DEDUP_WINDOW_SEC = 30;

export function getSEASignals(
  limit: number = 50,
  instrument?: string,
  source: "filtered" | "raw" | "auto" = "auto"
): SEASignal[] {
  const today = todayIST();
  const instruments = instrument
    ? [instrument.toLowerCase()]
    : INSTRUMENTS;

  const raw: SEASignal[] = [];
  let counter = 0;

  for (const inst of instruments) {
    // "auto" prefers filtered signals, falls back to raw if no filtered file exists
    const filteredPath = path.resolve(`logs/signals/${inst}/${today}_filtered_signals.log`);
    const rawPath = path.resolve(`logs/signals/${inst}/${today}_signals.log`);
    const useFiltered = source === "filtered" || (source === "auto" && existsSync(filteredPath));
    const logPath = useFiltered ? filteredPath : rawPath;
    const isFiltered = useFiltered;
    // Read more lines than limit since we'll deduplicate
    const lines = readLastLines(logPath, limit * 50);

    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        raw.push({
          id: `sea-${inst}-${++counter}`,
          timestamp: r.timestamp ?? 0,
          timestamp_ist: r.timestamp_ist ?? "",
          instrument: r.instrument ?? inst.toUpperCase(),
          direction: r.direction ?? "GO_CALL",
          direction_prob_30s: r.direction_prob_30s ?? 0,
          max_upside_pred_30s: r.max_upside_pred_30s ?? 0,
          max_drawdown_pred_30s: r.max_drawdown_pred_30s ?? 0,
          atm_strike: r.atm_strike ?? 0,
          atm_ce_ltp: r.atm_ce_ltp ?? null,
          atm_pe_ltp: r.atm_pe_ltp ?? null,
          atm_ce_security_id: r.atm_ce_security_id ?? null,
          atm_pe_security_id: r.atm_pe_security_id ?? null,
          spot_price: r.spot_price ?? null,
          momentum: r.momentum ?? null,
          breakout: r.breakout ?? null,
          model_version: r.model_version ?? "",
          action: r.action ?? undefined,
          regime: r.regime ?? undefined,
          entry: r.entry ?? undefined,
          tp: r.tp ?? undefined,
          sl: r.sl ?? undefined,
          rr: r.rr ?? undefined,
          count: 1,
          confidence: r.confidence ?? undefined,
          score: r.score ?? undefined,
          sustained_ticks: r.sustained_ticks ?? undefined,
          avg_prob: r.avg_prob ?? undefined,
          filtered: isFiltered || undefined,
        });
      } catch {
        // skip malformed lines
      }
    }
  }

  // Sort by timestamp ascending for dedup pass
  raw.sort((a, b) => a.timestamp - b.timestamp);

  // Deduplicate: merge consecutive same-instrument+direction within window
  const deduped: SEASignal[] = [];
  for (const sig of raw) {
    const prev = deduped.length > 0 ? deduped[deduped.length - 1] : null;
    if (
      prev &&
      prev.instrument === sig.instrument &&
      prev.direction === sig.direction &&
      sig.timestamp - prev.timestamp < DEDUP_WINDOW_SEC
    ) {
      // Merge into previous — keep the latest values, increment count
      prev.count = (prev.count ?? 1) + 1;
      prev.timestamp = sig.timestamp;
      prev.timestamp_ist = sig.timestamp_ist;
      prev.direction_prob_30s = sig.direction_prob_30s;
      prev.max_upside_pred_30s = sig.max_upside_pred_30s;
      prev.max_drawdown_pred_30s = sig.max_drawdown_pred_30s;
      prev.spot_price = sig.spot_price;
      prev.atm_ce_ltp = sig.atm_ce_ltp;
      prev.atm_pe_ltp = sig.atm_pe_ltp;
    } else {
      deduped.push({ ...sig });
    }
  }

  // Fair share per instrument so high-volume instruments don't crowd out others.
  // Take up to (limit / active_instruments) per instrument, then merge newest-first.
  const byInst = new Map<string, SEASignal[]>();
  for (const sig of deduped) {
    const key = sig.instrument;
    if (!byInst.has(key)) byInst.set(key, []);
    byInst.get(key)!.push(sig);
  }
  const activeCount = byInst.size || 1;
  const perInst = Math.max(5, Math.ceil(limit / activeCount));

  const merged: SEASignal[] = [];
  for (const [, sigs] of byInst) {
    // Each instrument's signals are already in chronological order — take last N
    merged.push(...sigs.slice(-perInst));
  }

  // Sort newest-first for display
  merged.sort((a, b) => b.timestamp - a.timestamp);
  return merged.slice(0, limit);
}

/**
 * Get signal counts for today per instrument.
 */
export function getSEASignalCounts(): Record<
  string,
  { calls: number; puts: number; total: number }
> {
  const today = todayIST();
  const result: Record<string, { calls: number; puts: number; total: number }> =
    {};

  for (const inst of INSTRUMENTS) {
    const logPath = path.resolve(`logs/signals/${inst}/${today}_signals.log`);
    let calls = 0,
      puts = 0;

    if (existsSync(logPath)) {
      try {
        const content = readFileSync(logPath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          try {
            const raw = JSON.parse(line);
            if (raw.direction === "GO_CALL") calls++;
            else if (raw.direction === "GO_PUT") puts++;
          } catch {
            /* skip */
          }
        }
      } catch {
        /* skip */
      }
    }
    result[inst] = { calls, puts, total: calls + puts };
  }

  return result;
}
