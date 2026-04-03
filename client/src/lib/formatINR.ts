/**
 * Indian Currency Formatter — ₹ with K / L / Cr shorthand.
 *
 * Examples:
 *   formatINR(850)        → "₹850"
 *   formatINR(1000)       → "₹1K"
 *   formatINR(1500)       → "₹1.5K"
 *   formatINR(15000)      → "₹15K"
 *   formatINR(100000)     → "₹1L"
 *   formatINR(150000)     → "₹1.5L"
 *   formatINR(2580000)    → "₹25.80L"
 *   formatINR(15000000)   → "₹1.5Cr"
 *   formatINR(-2580000)   → "-₹25.80L"
 *
 * Options:
 *   sign     — prefix '+' for positive values (default false)
 *   decimals — max decimal places for the shortened value (default 2)
 *   prefix   — include ₹ symbol (default true)
 *   compact  — use K/L/Cr shorthand (default true); when false, uses en-IN locale formatting
 */

export interface FormatINROptions {
  sign?: boolean;       // show '+' for positive values
  decimals?: number;    // max decimal places (default 2)
  prefix?: boolean;     // include ₹ symbol (default true)
  compact?: boolean;    // use K/L/Cr shorthand (default true)
}

export function formatINR(value: number, options?: FormatINROptions): string {
  const { sign = false, decimals = 2, prefix = true, compact = true } = options ?? {};

  const isNegative = value < 0;
  const abs = Math.abs(value);
  const symbol = prefix ? '₹' : '';

  let formatted: string;

  if (!compact) {
    // Full en-IN locale formatting (no shorthand)
    formatted = abs.toLocaleString('en-IN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    });
  } else if (abs >= 1_00_00_000) {
    // Crores (≥ 1Cr)
    const cr = abs / 1_00_00_000;
    formatted = trimTrailingZeros(cr, decimals) + 'Cr';
  } else if (abs >= 1_00_000) {
    // Lakhs (≥ 1L)
    const l = abs / 1_00_000;
    formatted = trimTrailingZeros(l, decimals) + 'L';
  } else if (abs >= 1_000) {
    // Thousands (≥ 1K)
    const k = abs / 1_000;
    formatted = trimTrailingZeros(k, decimals) + 'K';
  } else {
    // Below 1000 — show as-is with up to `decimals` places
    formatted = trimTrailingZeros(abs, decimals);
  }

  const signStr = isNegative ? '-' : sign ? '+' : '';
  return `${signStr}${symbol}${formatted}`;
}

/**
 * Format a number with up to `maxDecimals` places, trimming trailing zeros.
 * e.g. trimTrailingZeros(1.50, 2) → "1.5"
 *      trimTrailingZeros(2.00, 2) → "2"
 *      trimTrailingZeros(25.80, 2) → "25.80" (keeps meaningful decimals)
 */
function trimTrailingZeros(n: number, maxDecimals: number): string {
  const fixed = n.toFixed(maxDecimals);
  // Remove trailing zeros after decimal point, but keep at least one decimal
  // if the original had a meaningful fractional part
  if (!fixed.includes('.')) return fixed;
  // Remove trailing zeros
  let trimmed = fixed.replace(/0+$/, '');
  // Remove trailing dot
  trimmed = trimmed.replace(/\.$/, '');
  return trimmed;
}

/**
 * Format price — for per-unit prices (entry, exit, LTP, SL, TP) that should
 * NOT be shortened (₹1,234.50 not ₹1.2K) since precision matters for orders.
 * Uses en-IN locale with 2 decimal places.
 */
export function formatPrice(value: number, options?: { sign?: boolean }): string {
  const isNegative = value < 0;
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const signStr = isNegative ? '-' : options?.sign ? '+' : '';
  return `${signStr}₹${formatted}`;
}
