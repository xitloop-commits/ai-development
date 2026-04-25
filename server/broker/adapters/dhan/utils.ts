/**
 * Dhan Adapter — Utilities
 *
 * 1. Trading symbol parser (extract optionType, strike, expiry from Dhan symbols)
 * 2. Simple rate limiter for Dhan API calls
 * 3. Retry wrapper for network errors
 */

import { createLogger } from "../../logger";
const log = createLogger("BSA", "Dhan");

// ─── Trading Symbol Parser ────────────────────────────────────

export interface ParsedSymbol {
  underlying: string;
  expiry: string; // ISO date string (YYYY-MM-DD)
  strike: number;
  optionType: "CE" | "PE" | "FUT";
}

/**
 * Parse a Dhan trading symbol to extract underlying, expiry, strike, and optionType.
 *
 * Dhan trading symbol formats:
 * - Options: "NIFTY-Apr2025-24000-CE" or "NIFTY 25 APR 24000 CE" or "NIFTY2540024000CE"
 * - Futures: "NIFTY-Apr2025-FUT" or "NIFTY 25 APR FUT" or "NIFTY25APRFUT"
 * - MCX: "CRUDEOIL-Apr2025-5000-CE" or "CRUDEOIL25APR5000CE"
 *
 * Also handles Dhan's compact format: "NIFTY-Apr2025-24000-CE"
 */
export function parseTradingSymbol(symbol: string): ParsedSymbol | null {
  if (!symbol) return null;

  // Pattern 1: Dhan hyphenated format "NIFTY-Apr2025-24000-CE" or "NIFTY-Apr2025-FUT"
  const hyphenPattern =
    /^([A-Z_&]+)-([A-Za-z]{3})(\d{4})-(\d+)-(CE|PE)$/;
  const hyphenFutPattern =
    /^([A-Z_&]+)-([A-Za-z]{3})(\d{4})-FUT$/;

  let match = symbol.match(hyphenPattern);
  if (match) {
    const [, underlying, month, year, strike, optionType] = match;
    return {
      underlying,
      expiry: parseMonthYear(month, year),
      strike: Number(strike),
      optionType: optionType as "CE" | "PE",
    };
  }

  match = symbol.match(hyphenFutPattern);
  if (match) {
    const [, underlying, month, year] = match;
    return {
      underlying,
      expiry: parseMonthYear(month, year),
      strike: 0,
      optionType: "FUT",
    };
  }

  // Pattern 2: Compact format "NIFTY2540024000CE" or "NIFTY25APRFUT"
  // Options: SYMBOL + 2-digit year + 3-char month + strike + CE/PE
  const compactOptionPattern =
    /^([A-Z_&]+?)(\d{2})([A-Z]{3})(\d+)(CE|PE)$/;
  const compactFutPattern =
    /^([A-Z_&]+?)(\d{2})([A-Z]{3})FUT$/;

  match = symbol.match(compactOptionPattern);
  if (match) {
    const [, underlying, year, month, strike, optionType] = match;
    return {
      underlying,
      expiry: parseMonthYear(month, `20${year}`),
      strike: Number(strike),
      optionType: optionType as "CE" | "PE",
    };
  }

  match = symbol.match(compactFutPattern);
  if (match) {
    const [, underlying, year, month] = match;
    return {
      underlying,
      expiry: parseMonthYear(month, `20${year}`),
      strike: 0,
      optionType: "FUT",
    };
  }

  // Pattern 3: Space-separated "NIFTY 25 APR 24000 CE"
  const spaceOptionPattern =
    /^([A-Z_&\s]+?)\s+(\d{2})\s+([A-Z]{3})\s+(\d+)\s+(CE|PE)$/;
  const spaceFutPattern =
    /^([A-Z_&\s]+?)\s+(\d{2})\s+([A-Z]{3})\s+FUT$/;

  match = symbol.match(spaceOptionPattern);
  if (match) {
    const [, underlying, year, month, strike, optionType] = match;
    return {
      underlying: underlying.trim(),
      expiry: parseMonthYear(month, `20${year}`),
      strike: Number(strike),
      optionType: optionType as "CE" | "PE",
    };
  }

  match = symbol.match(spaceFutPattern);
  if (match) {
    const [, underlying, year, month] = match;
    return {
      underlying: underlying.trim(),
      expiry: parseMonthYear(month, `20${year}`),
      strike: 0,
      optionType: "FUT",
    };
  }

  return null;
}

/**
 * Convert month abbreviation + year to ISO date string.
 * Returns first of the month as a placeholder (exact expiry from scrip master).
 */
function parseMonthYear(month: string, year: string): string {
  const months: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04",
    MAY: "05", JUN: "06", JUL: "07", AUG: "08",
    SEP: "09", OCT: "10", NOV: "11", DEC: "12",
    Jan: "01", Feb: "02", Mar: "03", Apr: "04",
    May: "05", Jun: "06", Jul: "07", Aug: "08",
    Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };

  const monthNum = months[month] ?? months[month.toUpperCase()] ?? "01";
  const fullYear = year.length === 2 ? `20${year}` : year;
  return `${fullYear}-${monthNum}-01`;
}

// ─── Rate Limiter ─────────────────────────────────────────────

/**
 * Simple sliding-window rate limiter.
 * Tracks timestamps of recent calls and delays if limits are exceeded.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  private readonly perSecond: number;
  private readonly perMinute: number;

  constructor(perSecond: number = 10, perMinute: number = 250) {
    this.perSecond = perSecond;
    this.perMinute = perMinute;
  }

  /**
   * Wait until it's safe to make a request.
   * Returns immediately if under limits, otherwise delays.
   */
  async acquire(): Promise<void> {
    const now = Date.now();

    // Clean old timestamps (older than 60s)
    this.timestamps = this.timestamps.filter((t) => now - t < 60000);

    // Check per-second limit
    const lastSecond = this.timestamps.filter((t) => now - t < 1000);
    if (lastSecond.length >= this.perSecond) {
      const waitMs = 1000 - (now - lastSecond[0]);
      if (waitMs > 0) {
        await delay(waitMs);
      }
    }

    // Check per-minute limit
    if (this.timestamps.length >= this.perMinute) {
      const waitMs = 60000 - (now - this.timestamps[0]);
      if (waitMs > 0) {
        await delay(Math.min(waitMs, 5000)); // cap at 5s wait
      }
    }

    this.timestamps.push(Date.now());
  }

  /** Get current usage stats */
  getStats() {
    const now = Date.now();
    const lastSecond = this.timestamps.filter((t) => now - t < 1000).length;
    const lastMinute = this.timestamps.filter((t) => now - t < 60000).length;
    return { lastSecond, lastMinute };
  }

  /** Reset the limiter */
  reset() {
    this.timestamps = [];
  }
}

// ─── Retry Wrapper ────────────────────────────────────────────

/**
 * Retry a function on failure (network errors, timeouts).
 * Does NOT retry on auth errors (401/403) or business errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    delayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const { maxRetries = 2, delayMs = 1000, shouldRetry } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Don't retry if it's an auth error or business logic error
      if (shouldRetry && !shouldRetry(err)) {
        throw err;
      }

      // Don't retry on the last attempt
      if (attempt === maxRetries) {
        throw err;
      }

      // Exponential backoff
      const backoff = delayMs * Math.pow(2, attempt);
      log.warn(`Attempt ${attempt + 1}/${maxRetries + 1} failed. Retrying in ${backoff}ms...`);
      await delay(backoff);
    }
  }

  throw lastError;
}

/**
 * Check if an error is retryable (network/timeout, not auth/business).
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("abort") ||
      msg.includes("network") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("socket")
    );
  }
  return false;
}

// ─── Helpers ──────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate limit price with offset from LTP.
 * For BUY: LTP × (1 - offset%) — buy slightly below market
 * For SELL: LTP × (1 + offset%) — sell slightly above market
 * Rounds to nearest tick size.
 */
export function calculateLimitPrice(
  ltp: number,
  transactionType: "BUY" | "SELL",
  offsetPercent: number,
  tickSize: number = 0.05
): number {
  const offset = ltp * (offsetPercent / 100);

  let price: number;
  if (transactionType === "BUY") {
    price = ltp - offset;
  } else {
    price = ltp + offset;
  }

  // Round to tick size
  price = Math.round(price / tickSize) * tickSize;

  // Ensure price is positive and at least one tick
  return Math.max(price, tickSize);
}

/**
 * Calculate bracket order SL and TP prices.
 * SL is absolute price difference from entry.
 * TP is absolute price difference from entry.
 */
export function calculateBracketPrices(
  entryPrice: number,
  transactionType: "BUY" | "SELL",
  slPercent: number,
  tpPercent: number,
  tickSize: number = 0.05
): { stopLoss: number; target: number } {
  const slOffset = entryPrice * (slPercent / 100);
  const tpOffset = entryPrice * (tpPercent / 100);

  // Dhan bracket orders use absolute price difference (not actual price)
  let stopLoss = Math.round(slOffset / tickSize) * tickSize;
  let target = Math.round(tpOffset / tickSize) * tickSize;

  // Ensure minimums
  stopLoss = Math.max(stopLoss, tickSize);
  target = Math.max(target, tickSize);

  return { stopLoss, target };
}
