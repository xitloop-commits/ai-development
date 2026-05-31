/**
 * sync-holidays.ts
 *
 * One-way export: server/holidays.ts (TS, source of truth for the
 * BSA API + UI) → config/market_holidays.json (the Python loader's
 * format). Run this once after annual holiday-list updates so the
 * Python launcher's `is_market_holiday()` + T35's
 * `get_session_end_sec()` stay in sync.
 *
 * Usage:
 *   pnpm tsx scripts/sync-holidays.ts
 *   pnpm tsx scripts/sync-holidays.ts --dry-run   # print diff, don't write
 *
 * Schema mapping from MarketHoliday → market_holidays.json:
 *
 *   - NSE trading-closed (type='trading' or 'both') → "<year>": [date]
 *   - MCX with morningSession='closed' AND eveningSession='closed'
 *       → MCX year array (not yet a separate file; lives under the
 *         same flat "<year>" array — both NSE+MCX dates union per
 *         the existing Python loader convention).
 *   - NSE special='Muhurat Trading' → partial_sessions with
 *       session_end_sec=69300 (19:15 IST), exchanges=['NSE'].
 *       (User-confirmed 2026-05-31 default; override per-year if a
 *       circular announces a different window.)
 *   - MCX morningSession='open' + eveningSession='closed'
 *       → partial_sessions with session_end_sec=61200 (17:00 IST),
 *         exchanges=['MCX']. The morning session runs but the
 *         evening session is cancelled. (User-confirmed default.)
 *   - MCX morningSession='closed' + eveningSession='open'
 *       → NOT a partial session for lookahead-clamping purposes —
 *         the evening session runs normally until 23:30. Skip.
 *
 * If a date triggers BOTH a full-holiday entry (e.g. NSE closed) and
 * a partial-session entry on a different exchange (MCX open morning
 * only), it lands in both blocks. Python's
 * `is_market_holiday(exchange='NSE')`-ish predicate is not yet
 * exchange-scoped; today it's a UNION across exchanges per the
 * existing convention. Document if/when that splits.
 */

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { getAllHolidays } from "../server/holidays";
import type { MarketHoliday } from "../shared/tradingTypes";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(REPO_ROOT, "config", "market_holidays.json");

// User-confirmed defaults (2026-05-31). Override here if a future
// circular announces different window timings — the source of truth
// for these numbers is the relevant NSE/MCX holiday circular.
const MUHURAT_END_SEC = 69300;          // 19:15 IST
const MCX_MORNING_ONLY_END_SEC = 61200; // 17:00 IST

interface PartialSession {
  session_end_sec: number;
  reason: string;
  exchanges: string[];
}

interface HolidaysJson {
  _note: string;
  _partial_sessions_note?: string;
  [yearOrKey: string]: string | string[] | Record<string, PartialSession>;
}

function classifyMcxClosure(h: MarketHoliday): "full" | "morning_only" | "evening_only" | "neither" {
  if (h.exchange !== "MCX" || h.type === "settlement") return "neither";
  const m = h.morningSession ?? "closed";
  const e = h.eveningSession ?? "closed";
  if (m === "closed" && e === "closed") return "full";
  if (m === "open" && e === "closed") return "morning_only";
  if (m === "closed" && e === "open") return "evening_only";
  return "neither";
}

function isNseFullHoliday(h: MarketHoliday): boolean {
  return (
    h.exchange === "NSE" &&
    (h.type === "trading" || h.type === "both") &&
    h.special !== "Muhurat Trading"
  );
}

function build(): HolidaysJson {
  const all = getAllHolidays();
  const byYear: Record<string, Set<string>> = {};
  const partialSessions: Record<string, PartialSession> = {};

  for (const h of all) {
    const year = h.date.slice(0, 4);

    // Full holidays (NSE trading closed OR MCX both sessions closed).
    if (isNseFullHoliday(h) || classifyMcxClosure(h) === "full") {
      byYear[year] ??= new Set();
      byYear[year].add(h.date);
    }

    // NSE Muhurat Trading — partial session with abnormal close.
    if (h.exchange === "NSE" && h.special === "Muhurat Trading") {
      partialSessions[h.date] = {
        session_end_sec: MUHURAT_END_SEC,
        reason: `${h.description} (Muhurat Trading NSE)`,
        exchanges: ["NSE"],
      };
    }

    // MCX morning-only — partial session ending at 17:00 IST.
    if (classifyMcxClosure(h) === "morning_only") {
      // If the same date already has a partial-session entry (e.g.
      // NSE Muhurat coinciding with MCX morning-only — unlikely in
      // practice, but defensive), merge by widening the exchanges
      // list rather than overwriting.
      const existing = partialSessions[h.date];
      if (existing) {
        existing.exchanges = Array.from(
          new Set([...existing.exchanges, "MCX"]),
        );
        existing.reason = `${existing.reason}; ${h.description} (MCX morning-only)`;
      } else {
        partialSessions[h.date] = {
          session_end_sec: MCX_MORNING_ONLY_END_SEC,
          reason: `${h.description} (MCX morning-only)`,
          exchanges: ["MCX"],
        };
      }
    }
  }

  // Preserve the existing _note + _partial_sessions_note hand-written
  // documentation by reading the current file and copying them
  // through. If the file doesn't exist yet, fall back to a default.
  let existingNote = "Trading holidays for the ATS launcher. The scheduled task skips the morning fan-out on these dates. Use the UNION of NSE and MCX holidays -- if either market is closed, there's no reason to record. Update annually from: https://www.nseindia.com/resources/exchange-communication-holidays and https://www.mcxindia.com/market-data/holiday-calendar . Format: YYYY-MM-DD strings. Weekends are handled separately by _scheduled-start.bat -- do not list Saturdays/Sundays here.";
  let existingPartialNote = "Trading days with an abnormal close time (Muhurat Diwali session ~18:15-19:15 IST, exchange-mandated half-days). 'session_end_sec' = seconds-since-midnight IST when the regular session ends; the rest of the day is closed. T35 added this to stop SEA/MTA target-labelling from computing lookahead values against post-close NULL/stale prices on these days. NSE default = 55800 (15:30), MCX default = 84600 (23:30). Populate from the same NSE/MCX holiday circulars as the holiday list above.";
  try {
    const current = JSON.parse(readFileSync(OUTPUT, "utf-8"));
    if (typeof current._note === "string") existingNote = current._note;
    if (typeof current._partial_sessions_note === "string") {
      existingPartialNote = current._partial_sessions_note;
    }
  } catch {
    /* file may not exist on first run — use defaults */
  }

  // Append a stamp documenting WHO wrote this — script regeneration
  // beats hand-edits, so future engineers know to run the script
  // rather than edit the JSON directly.
  const generatedStamp =
    " GENERATED by scripts/sync-holidays.ts from server/holidays.ts — do not hand-edit; run `pnpm tsx scripts/sync-holidays.ts` after updating the TS source.";

  const out: HolidaysJson = {
    _note: existingNote + generatedStamp,
    _partial_sessions_note: existingPartialNote,
  };
  for (const year of Object.keys(byYear).sort()) {
    out[year] = Array.from(byYear[year]).sort();
  }
  // Always emit partial_sessions last (and even if empty) for
  // schema consistency.
  const sortedPartial: Record<string, PartialSession> = {};
  for (const date of Object.keys(partialSessions).sort()) {
    sortedPartial[date] = partialSessions[date];
  }
  out.partial_sessions = sortedPartial;

  return out;
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const next = build();
  const nextStr = JSON.stringify(next, null, 2) + "\n";

  if (dryRun) {
    let prevStr = "";
    try { prevStr = readFileSync(OUTPUT, "utf-8"); } catch {}
    if (prevStr === nextStr) {
      console.log("sync-holidays: no changes.");
    } else {
      console.log("sync-holidays: --dry-run, would write:");
      console.log(nextStr);
    }
    return;
  }

  writeFileSync(OUTPUT, nextStr, "utf-8");
  const yearCount = Object.keys(next).filter(k => /^\d{4}$/.test(k)).length;
  const partialCount = Object.keys(next.partial_sessions as object).length;
  console.log(
    `sync-holidays: wrote ${OUTPUT} ` +
    `(${yearCount} year(s), ${partialCount} partial session(s))`,
  );
}

main();
