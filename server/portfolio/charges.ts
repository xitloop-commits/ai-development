/**
 * Charges Engine — Calculates all trading charges, taxes, and fees.
 *
 * Uses the ChargeRate[] from user settings (persisted in MongoDB).
 * Handles all unit types:
 *   - flat_per_order:       Fixed amount per order (e.g., ₹20 brokerage)
 *   - percent:              % of turnover (both sides)
 *   - percent_sell:         % of sell-side turnover only
 *   - percent_buy:          % of buy-side turnover only
 *   - percent_on_brokerage: % calculated on (brokerage + exchange txn charges)
 *
 * Reference: Settings_Spec_v1.2, DEFAULT_CHARGES in userSettings.ts
 */

import type { ChargeBreakdown } from "./state";

// ─── Types ───────────────────────────────────────────────────────

export interface ChargeRate {
  name: string;
  rate: number;
  unit: string;
  description?: string;
  enabled?: boolean;
}

export interface TradeParams {
  entryPrice: number;
  exitPrice: number;
  qty: number;
  isBuy: boolean;           // true for buy-side, false for sell-side
  exchange: "NSE" | "MCX";  // for potential exchange-specific rates
}

export interface ChargesResult {
  total: number;
  breakdown: ChargeBreakdown[];
}

// ─── Main Calculation ────────────────────────────────────────────

/**
 * Calculate all charges for a completed trade (round-trip: entry + exit).
 *
 * A round-trip trade consists of:
 *   - Buy leg:  entryPrice * qty (for BUY trades) or exitPrice * qty (for SELL trades)
 *   - Sell leg: exitPrice * qty (for BUY trades) or entryPrice * qty (for SELL trades)
 */
export function calculateTradeCharges(
  trade: TradeParams,
  rates: ChargeRate[]
): ChargesResult {
  const enabledRates = rates.filter((r) => r.enabled !== false);

  // Determine buy and sell turnover for a round-trip
  const buyTurnover = trade.isBuy
    ? trade.entryPrice * trade.qty
    : trade.exitPrice * trade.qty;

  const sellTurnover = trade.isBuy
    ? trade.exitPrice * trade.qty
    : trade.entryPrice * trade.qty;

  const totalTurnover = buyTurnover + sellTurnover;

  const breakdown: ChargeBreakdown[] = [];
  let brokerageAmount = 0;
  let exchangeTxnAmount = 0;

  // First pass: calculate brokerage and exchange txn (needed for GST base)
  for (const rate of enabledRates) {
    const amount = calculateSingleCharge(rate, {
      buyTurnover,
      sellTurnover,
      totalTurnover,
      brokerageBase: 0, // not needed for first pass
    });

    if (rate.name.toLowerCase().includes("brokerage")) {
      brokerageAmount = amount;
    }
    if (rate.name.toLowerCase().includes("exchange")) {
      exchangeTxnAmount = amount;
    }
  }

  // Second pass: calculate all charges (including GST which depends on brokerage)
  let total = 0;
  for (const rate of enabledRates) {
    const amount = calculateSingleCharge(rate, {
      buyTurnover,
      sellTurnover,
      totalTurnover,
      brokerageBase: brokerageAmount + exchangeTxnAmount,
    });

    if (amount > 0) {
      breakdown.push({ name: rate.name, amount: round(amount) });
      total += amount;
    }
  }

  return { total: round(total), breakdown };
}

/**
 * Calculate charges for a single leg (entry or exit only).
 * Used for estimating charges before trade completion.
 */
export function estimateSingleLegCharges(
  price: number,
  qty: number,
  isBuySide: boolean,
  rates: ChargeRate[]
): ChargesResult {
  const enabledRates = rates.filter((r) => r.enabled !== false);
  const turnover = price * qty;

  const breakdown: ChargeBreakdown[] = [];
  let brokerageAmount = 0;
  let exchangeTxnAmount = 0;

  // First pass for brokerage base
  for (const rate of enabledRates) {
    let amount = 0;
    switch (rate.unit) {
      case "flat_per_order":
        amount = rate.rate;
        break;
      case "percent":
        amount = turnover * rate.rate / 100;
        break;
      case "percent_sell":
        amount = isBuySide ? 0 : turnover * rate.rate / 100;
        break;
      case "percent_buy":
        amount = isBuySide ? turnover * rate.rate / 100 : 0;
        break;
    }
    if (rate.name.toLowerCase().includes("brokerage")) brokerageAmount = amount;
    if (rate.name.toLowerCase().includes("exchange")) exchangeTxnAmount = amount;
  }

  // Second pass with GST
  let total = 0;
  for (const rate of enabledRates) {
    let amount = 0;
    switch (rate.unit) {
      case "flat_per_order":
        amount = rate.rate;
        break;
      case "percent":
        amount = turnover * rate.rate / 100;
        break;
      case "percent_sell":
        amount = isBuySide ? 0 : turnover * rate.rate / 100;
        break;
      case "percent_buy":
        amount = isBuySide ? turnover * rate.rate / 100 : 0;
        break;
      case "percent_on_brokerage":
        amount = (brokerageAmount + exchangeTxnAmount) * rate.rate / 100;
        break;
    }
    if (amount > 0) {
      breakdown.push({ name: rate.name, amount: round(amount) });
      total += amount;
    }
  }

  return { total: round(total), breakdown };
}

// ─── Helpers ─────────────────────────────────────────────────────

interface ChargeContext {
  buyTurnover: number;
  sellTurnover: number;
  totalTurnover: number;
  brokerageBase: number; // brokerage + exchange txn for GST calculation
}

function calculateSingleCharge(rate: ChargeRate, ctx: ChargeContext): number {
  switch (rate.unit) {
    case "flat_per_order":
      // Flat per order — 2 orders per round-trip (entry + exit)
      return rate.rate * 2;

    case "percent":
      // % of total turnover (both sides)
      return ctx.totalTurnover * rate.rate / 100;

    case "percent_sell":
      // % of sell-side turnover only
      return ctx.sellTurnover * rate.rate / 100;

    case "percent_buy":
      // % of buy-side turnover only
      return ctx.buyTurnover * rate.rate / 100;

    case "percent_on_brokerage":
      // % on (brokerage + exchange transaction charges)
      return ctx.brokerageBase * rate.rate / 100;

    default:
      return 0;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
