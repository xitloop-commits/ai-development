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
  spot_price: number | null;
  momentum: number | null;
  breakout: number | null;
  model_version: string;
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
 * Returns newest-first (reversed chronological) for display.
 */
export function getSEASignals(
  limit: number = 50,
  instrument?: string
): SEASignal[] {
  const today = todayIST();
  const instruments = instrument
    ? [instrument.toLowerCase()]
    : INSTRUMENTS;

  const all: SEASignal[] = [];
  let counter = 0;

  for (const inst of instruments) {
    const logPath = path.resolve(`logs/signals/${inst}/${today}_signals.log`);
    const lines = readLastLines(logPath, limit);

    for (const line of lines) {
      try {
        const raw = JSON.parse(line);
        all.push({
          id: `sea-${inst}-${++counter}`,
          timestamp: raw.timestamp ?? 0,
          timestamp_ist: raw.timestamp_ist ?? "",
          instrument: raw.instrument ?? inst.toUpperCase(),
          direction: raw.direction ?? "GO_CALL",
          direction_prob_30s: raw.direction_prob_30s ?? 0,
          max_upside_pred_30s: raw.max_upside_pred_30s ?? 0,
          max_drawdown_pred_30s: raw.max_drawdown_pred_30s ?? 0,
          atm_strike: raw.atm_strike ?? 0,
          atm_ce_ltp: raw.atm_ce_ltp ?? null,
          atm_pe_ltp: raw.atm_pe_ltp ?? null,
          spot_price: raw.spot_price ?? null,
          momentum: raw.momentum ?? null,
          breakout: raw.breakout ?? null,
          model_version: raw.model_version ?? "",
        });
      } catch {
        // skip malformed lines
      }
    }
  }

  // Sort by timestamp descending (newest first)
  all.sort((a, b) => b.timestamp - a.timestamp);
  return all.slice(0, limit);
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
