/**
 * Dhan Scrip Master — Download, Parse, Cache, and Lookup
 *
 * Downloads the compact scrip master CSV from Dhan, parses it into
 * an in-memory cache indexed by exchange+symbol, and provides:
 *
 * - lookupSecurityId(symbol, expiry, strike, optionType) → securityId
 * - getExpiryDates(symbol, exchange, instrumentType) → sorted expiry list
 * - resolveMCXFutcom(symbol) → nearest-month FUTCOM security ID
 * - getScripMasterStatus() → { lastDownload, recordCount, ... }
 * - refreshScripMaster() → force re-download
 *
 * CSV Columns (compact):
 * SEM_EXM_EXCH_ID, SEM_SEGMENT, SEM_SMST_SECURITY_ID, SEM_INSTRUMENT_NAME,
 * SEM_EXPIRY_CODE, SEM_TRADING_SYMBOL, SEM_LOT_UNITS, SEM_CUSTOM_SYMBOL,
 * SEM_EXPIRY_DATE, SEM_STRIKE_PRICE, SEM_OPTION_TYPE, SEM_TICK_SIZE,
 * SEM_EXPIRY_FLAG, SEM_EXCH_INSTRUMENT_TYPE, SEM_SERIES, SM_SYMBOL_NAME
 */

import { DHAN_ENDPOINTS } from "./constants";

const DHAN_SCRIP_MASTER_URL = DHAN_ENDPOINTS.SCRIP_MASTER;

// ─── Types ─────────────────────────────────────────────────────

export interface ScripRecord {
  exchange: string;        // NSE, BSE, MCX
  segment: string;         // D=Derivatives, E=Equity, M=Commodity, C=Currency
  securityId: string;      // SEM_SMST_SECURITY_ID
  instrumentName: string;  // OPTIDX, FUTIDX, OPTCOM, FUTCOM, etc.
  expiryCode: string;      // SEM_EXPIRY_CODE
  tradingSymbol: string;   // SEM_TRADING_SYMBOL (e.g., NIFTY-May2026-30700-CE)
  lotSize: number;         // SEM_LOT_UNITS
  customSymbol: string;    // SEM_CUSTOM_SYMBOL (e.g., NIFTY 26 MAY 30700 CALL)
  expiryDate: string;      // SEM_EXPIRY_DATE (e.g., 2026-05-26 14:30:00)
  strikePrice: number;     // SEM_STRIKE_PRICE
  optionType: string;      // CE, PE, or XX (for futures)
  tickSize: number;        // SEM_TICK_SIZE
  expiryFlag: string;      // M=Monthly, W=Weekly
  exchInstrType: string;   // SEM_EXCH_INSTRUMENT_TYPE (OP, FUT, FUTCOM, etc.)
  series: string;          // SEM_SERIES
  symbolName: string;      // SM_SYMBOL_NAME (may be empty for NSE derivatives)
  // Derived
  underlyingSymbol: string; // Parsed from tradingSymbol or symbolName
  expiryDateOnly: string;   // Just the date part (YYYY-MM-DD)
}

export interface ScripMasterStatus {
  lastDownload: number;    // Unix timestamp of last download
  recordCount: number;     // Total records in cache
  derivativeCount: number; // Derivative records only
  exchanges: string[];     // Unique exchanges
  isLoaded: boolean;       // Whether cache is populated
  downloadTimeMs: number;  // Time taken to download + parse
}

export interface LookupParams {
  symbol: string;          // e.g., NIFTY, BANKNIFTY, CRUDEOIL
  expiry?: string;         // e.g., 2026-04-03 or 2026-04-03 14:30:00
  strike?: number;         // e.g., 24500
  optionType?: string;     // CE, PE, or XX/undefined for futures
  exchange?: string;       // NSE, MCX — optional filter
  instrumentName?: string; // OPTIDX, FUTIDX, FUTCOM — optional filter
}

export interface LookupResult {
  securityId: string;
  tradingSymbol: string;
  customSymbol: string;
  lotSize: number;
  exchange: string;
  instrumentName: string;
  expiryDate: string;
  strikePrice: number;
  optionType: string;
}

// ─── In-Memory Cache ───────────────────────────────────────────

let scripRecords: ScripRecord[] = [];
let lastDownload: number = 0;
let downloadTimeMs: number = 0;
let isLoading: boolean = false;

// Indexes for fast lookup
let bySymbol: Map<string, ScripRecord[]> = new Map();
let byExchange: Map<string, ScripRecord[]> = new Map();
let bySecurityId: Map<string, ScripRecord> = new Map();

// ─── CSV Parsing ───────────────────────────────────────────────

/**
 * Parse a single CSV line. Handles the 16-column compact format.
 * Returns null for header or malformed rows.
 */
function parseCsvLine(line: string): ScripRecord | null {
  // Simple CSV split (no quoted fields in Dhan's compact CSV)
  const cols = line.split(",");
  if (cols.length < 14) return null;

  const exchange = cols[0]?.trim();
  const segment = cols[1]?.trim();
  const securityId = cols[2]?.trim();
  const instrumentName = cols[3]?.trim();

  // Skip header row
  if (exchange === "SEM_EXM_EXCH_ID") return null;

  const expiryCode = cols[4]?.trim() ?? "";
  const tradingSymbol = cols[5]?.trim() ?? "";
  const lotSize = parseFloat(cols[6]) || 1;
  const customSymbol = cols[7]?.trim() ?? "";
  const expiryDate = cols[8]?.trim() ?? "";
  const strikePrice = parseFloat(cols[9]) || 0;
  const optionType = cols[10]?.trim() ?? "XX";
  const tickSize = parseFloat(cols[11]) || 0.05;
  const expiryFlag = cols[12]?.trim() ?? "";
  const exchInstrType = cols[13]?.trim() ?? "";
  const series = cols[14]?.trim() ?? "";
  const symbolName = cols[15]?.trim() ?? "";

  // Derive underlying symbol
  const underlyingSymbol = deriveUnderlyingSymbol(
    tradingSymbol,
    symbolName,
    instrumentName
  );

  // Extract date-only from expiryDate
  const expiryDateOnly = expiryDate ? expiryDate.split(" ")[0] : "";

  return {
    exchange,
    segment,
    securityId,
    instrumentName,
    expiryCode,
    tradingSymbol,
    lotSize,
    customSymbol,
    expiryDate,
    strikePrice,
    optionType,
    tickSize,
    expiryFlag,
    exchInstrType,
    series,
    symbolName,
    underlyingSymbol,
    expiryDateOnly,
  };
}

/**
 * Derive the underlying symbol from available fields.
 * For NSE derivatives: parse from tradingSymbol (e.g., "NIFTY-May2026-30700-CE" → "NIFTY")
 * For MCX: use symbolName (e.g., "CRUDEOIL")
 */
function deriveUnderlyingSymbol(
  tradingSymbol: string,
  symbolName: string,
  _instrumentName: string
): string {
  // If symbolName is populated, use it (strip spaces so "CRUDE OIL" → "CRUDEOIL")
  if (symbolName && symbolName.length > 0) {
    return symbolName.toUpperCase().replace(/\s+/g, "");
  }

  // Parse from tradingSymbol: "NIFTY-May2026-30700-CE" → "NIFTY"
  if (tradingSymbol) {
    const dashIdx = tradingSymbol.indexOf("-");
    if (dashIdx > 0) {
      return tradingSymbol.substring(0, dashIdx).toUpperCase();
    }
    return tradingSymbol.toUpperCase();
  }

  return "";
}

/**
 * Parse the full CSV text into ScripRecord array.
 */
export function parseScripMasterCsv(csvText: string): ScripRecord[] {
  const lines = csvText.split("\n");
  const records: ScripRecord[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const record = parseCsvLine(line);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

/**
 * Build lookup indexes from records.
 */
function buildIndexes(records: ScripRecord[]): void {
  bySymbol = new Map();
  byExchange = new Map();
  bySecurityId = new Map();

  for (const rec of records) {
    // Index by underlying symbol (uppercase, no spaces — "CRUDE OIL" → "CRUDEOIL")
    const sym = rec.underlyingSymbol.replace(/\s+/g, "");
    if (sym) {
      if (!bySymbol.has(sym)) bySymbol.set(sym, []);
      bySymbol.get(sym)!.push(rec);
    }

    // Index by exchange
    const exch = rec.exchange;
    if (!byExchange.has(exch)) byExchange.set(exch, []);
    byExchange.get(exch)!.push(rec);

    // Index by security ID
    if (rec.securityId) {
      bySecurityId.set(rec.securityId, rec);
    }
  }
}

// ─── Download ──────────────────────────────────────────────────

/**
 * Download and parse the scrip master CSV from Dhan.
 * Caches in memory. Returns the number of records loaded.
 */
export async function downloadScripMaster(): Promise<number> {
  if (isLoading) {
    console.log("[ScripMaster] Download already in progress, skipping.");
    return scripRecords.length;
  }

  isLoading = true;
  const startTime = Date.now();

  try {
    console.log("[ScripMaster] Downloading from", DHAN_SCRIP_MASTER_URL);

    const response = await fetch(DHAN_SCRIP_MASTER_URL);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const csvText = await response.text();
    const records = parseScripMasterCsv(csvText);

    scripRecords = records;
    buildIndexes(records);

    lastDownload = Date.now();
    downloadTimeMs = Date.now() - startTime;

    console.log(
      `[ScripMaster] Loaded ${records.length} records in ${downloadTimeMs}ms. ` +
      `Exchanges: ${Array.from(byExchange.keys()).join(", ")}`
    );

    return records.length;
  } catch (err) {
    console.error("[ScripMaster] Download failed:", err);
    throw err;
  } finally {
    isLoading = false;
  }
}

// ─── Lookup ────────────────────────────────────────────────────

/**
 * Look up a security ID from the cached scrip master.
 *
 * @param params - Lookup parameters
 * @returns LookupResult or null if not found
 */
export function lookupSecurityId(params: LookupParams): LookupResult | null {
  const symbol = params.symbol.toUpperCase().replace(/\s+/g, "");
  const candidates = bySymbol.get(symbol);

  if (!candidates || candidates.length === 0) {
    return null;
  }

  let filtered = candidates;

  // Filter by exchange
  if (params.exchange) {
    filtered = filtered.filter((r) => r.exchange === params.exchange);
  }

  // Filter by instrument name
  if (params.instrumentName) {
    filtered = filtered.filter((r) => r.instrumentName === params.instrumentName);
  }

  // Filter by expiry date
  if (params.expiry) {
    const expiryDate = params.expiry.split(" ")[0]; // Normalize to date-only
    filtered = filtered.filter((r) => r.expiryDateOnly === expiryDate);
  }

  // Filter by strike price (with tolerance for floating point)
  if (params.strike !== undefined && params.strike > 0) {
    filtered = filtered.filter(
      (r) => Math.abs(r.strikePrice - params.strike!) < 0.01
    );
  }

  // Filter by option type
  if (params.optionType) {
    const ot = params.optionType.toUpperCase();
    if (ot === "CE" || ot === "PE") {
      filtered = filtered.filter((r) => r.optionType === ot);
    }
  }

  if (filtered.length === 0) {
    return null;
  }

  // If multiple matches, prefer the first one
  const match = filtered[0];

  return {
    securityId: match.securityId,
    tradingSymbol: match.tradingSymbol,
    customSymbol: match.customSymbol,
    lotSize: match.lotSize,
    exchange: match.exchange,
    instrumentName: match.instrumentName,
    expiryDate: match.expiryDate,
    strikePrice: match.strikePrice,
    optionType: match.optionType,
  };
}

/**
 * Look up multiple security IDs at once.
 */
export function lookupMultiple(paramsList: LookupParams[]): (LookupResult | null)[] {
  return paramsList.map(lookupSecurityId);
}

// ─── Expiry List ───────────────────────────────────────────────

/**
 * Get all unique expiry dates for a symbol, sorted ascending.
 *
 * @param symbol - Underlying symbol (e.g., NIFTY, BANKNIFTY, CRUDEOIL)
 * @param exchange - Optional exchange filter
 * @param instrumentName - Optional instrument filter (OPTIDX, FUTIDX, FUTCOM)
 * @returns Sorted array of expiry dates (YYYY-MM-DD)
 */
export function getExpiryDates(
  symbol: string,
  exchange?: string,
  instrumentName?: string
): string[] {
  const sym = symbol.toUpperCase().replace(/\s+/g, "");
  const candidates = bySymbol.get(sym);

  if (!candidates || candidates.length === 0) {
    return [];
  }

  let filtered = candidates;

  if (exchange) {
    filtered = filtered.filter((r) => r.exchange === exchange);
  }

  if (instrumentName) {
    filtered = filtered.filter((r) => r.instrumentName === instrumentName);
  }

  // Filter only derivatives (has expiry date)
  filtered = filtered.filter((r) => r.expiryDateOnly && r.expiryDateOnly.length > 0);

  // Get unique expiry dates
  const expirySet = new Set(filtered.map((r) => r.expiryDateOnly));

  // Sort ascending
  return Array.from(expirySet).sort();
}

// ─── MCX FUTCOM Resolution ────────────────────────────────────

/**
 * Resolve the nearest-month FUTCOM security ID for an MCX commodity.
 *
 * @param symbol - Commodity symbol (e.g., CRUDEOIL, NATURALGAS)
 * @returns LookupResult for the nearest non-expired FUTCOM, or null
 */
export function resolveMCXFutcom(symbol: string): LookupResult | null {
  const sym = symbol.toUpperCase().replace(/\s+/g, "");
  const candidates = bySymbol.get(sym);

  if (!candidates || candidates.length === 0) {
    return null;
  }

  const now = new Date();
  const todayStr = now.toISOString().split("T")[0]; // YYYY-MM-DD

  // Filter: MCX + FUTCOM + not expired
  const futcomRecords = candidates
    .filter(
      (r) =>
        r.exchange === "MCX" &&
        r.instrumentName === "FUTCOM" &&
        r.expiryDateOnly >= todayStr
    )
    .sort((a, b) => a.expiryDateOnly.localeCompare(b.expiryDateOnly));

  if (futcomRecords.length === 0) {
    return null;
  }

  // Return the nearest-month (first non-expired)
  const match = futcomRecords[0];

  return {
    securityId: match.securityId,
    tradingSymbol: match.tradingSymbol,
    customSymbol: match.customSymbol,
    lotSize: match.lotSize,
    exchange: match.exchange,
    instrumentName: match.instrumentName,
    expiryDate: match.expiryDate,
    strikePrice: match.strikePrice,
    optionType: match.optionType,
  };
}

// ─── Status & Management ───────────────────────────────────────

/**
 * Get the current scrip master cache status.
 */
export function getScripMasterStatus(): ScripMasterStatus {
  const derivativeCount = scripRecords.filter(
    (r) => r.segment === "D" || r.segment === "M"
  ).length;

  return {
    lastDownload,
    recordCount: scripRecords.length,
    derivativeCount,
    exchanges: Array.from(byExchange.keys()),
    isLoaded: scripRecords.length > 0,
    downloadTimeMs,
  };
}

/**
 * Force refresh the scrip master cache.
 */
export async function refreshScripMaster(): Promise<ScripMasterStatus> {
  await downloadScripMaster();
  return getScripMasterStatus();
}

/**
 * Get all records for a specific exchange.
 */
export function getRecordsByExchange(exchange: string): ScripRecord[] {
  return byExchange.get(exchange) ?? [];
}

/**
 * Get all records for a specific symbol.
 */
export function getRecordsBySymbol(symbol: string): ScripRecord[] {
  return bySymbol.get(symbol.toUpperCase().replace(/\s+/g, "")) ?? [];
}

/**
 * Get lot size for a specific security ID (option/future).
 * Returns 1 if not found.
 */
export function getLotSizeBySecurityId(securityId: string): number {
  return bySecurityId.get(securityId)?.lotSize ?? 1;
}

/**
 * Get lot size for an underlying symbol (e.g., NIFTY, BANKNIFTY, CRUDEOIL).
 * Uses the first matching record from the scrip master.
 * Returns 1 if not found.
 */
export function getLotSizeBySymbol(symbol: string): number {
  const candidates = bySymbol.get(symbol.toUpperCase().replace(/\s+/g, ""));
  if (!candidates || candidates.length === 0) return 1;
  // Prefer a futures record (has authoritative lot size); fall back to first record
  const futureRec = candidates.find(r => r.instrumentName.startsWith("FUT"));
  return (futureRec ?? candidates[0]).lotSize;
}

/**
 * Check if the scrip master needs refreshing (older than given hours).
 */
export function needsRefresh(maxAgeHours: number = 24): boolean {
  if (lastDownload === 0) return true;
  const ageMs = Date.now() - lastDownload;
  return ageMs > maxAgeHours * 60 * 60 * 1000;
}

/**
 * Search scrip master by query string.
 * Searches trading symbol, custom symbol, symbol name, and underlying symbol.
 * Optionally filters by exchange.
 * Returns up to 20 results.
 */
export function searchByQuery(
  query: string,
  exchange?: string,
  limit: number = 20
): ScripRecord[] {
  if (!query || query.trim().length === 0) {
    return [];
  }

  const q = query.trim().toUpperCase();
  const results: ScripRecord[] = [];

  for (const rec of scripRecords) {
    // Skip if exchange filter is provided and doesn't match
    if (exchange && rec.exchange !== exchange) {
      continue;
    }

    // Match on any of these fields (case-insensitive)
    if (
      rec.tradingSymbol.includes(q) ||
      rec.customSymbol.toUpperCase().includes(q) ||
      rec.symbolName.toUpperCase().includes(q) ||
      rec.underlyingSymbol.includes(q)
    ) {
      results.push(rec);
      if (results.length >= limit) {
        break;
      }
    }
  }

  return results;
}

// ─── Testing Helpers ───────────────────────────────────────────

/**
 * Load records directly (for testing without HTTP).
 */
export function _loadRecordsForTesting(records: ScripRecord[]): void {
  scripRecords = records;
  buildIndexes(records);
  lastDownload = Date.now();
  downloadTimeMs = 0;
}

/**
 * Reset the cache (for testing).
 */
export function _resetForTesting(): void {
  scripRecords = [];
  bySymbol = new Map();
  byExchange = new Map();
  lastDownload = 0;
  downloadTimeMs = 0;
  isLoading = false;
}
