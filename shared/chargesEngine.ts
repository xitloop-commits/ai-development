/**
 * Charges Engine (shared) — browser-safe subset used by the client UI.
 *
 * Contains only the types, defaults, and estimateSingleLegCharges function.
 * No Node.js / mongoose dependencies.
 */

export interface ChargeRate {
  name: string;
  rate: number;
  unit: string;
  description?: string;
  enabled?: boolean;
}

export interface ChargeBreakdown {
  name: string;
  amount: number;
}

export interface ChargesResult {
  total: number;
  breakdown: ChargeBreakdown[];
}

export const DEFAULT_CHARGES: ChargeRate[] = [
  { name: "Brokerage", rate: 20, unit: "flat_per_order", description: "₹20/order flat (Dhan)", enabled: true },
  { name: "STT", rate: 0.15, unit: "percent_sell", description: "0.15% on sell premium (from 1-Apr-2026)", enabled: true },
  { name: "Exchange Transaction", rate: 0.03553, unit: "percent", description: "0.03553% of premium (NSE options)", enabled: true },
  { name: "GST", rate: 18, unit: "percent_on_brokerage", description: "18% on brokerage + exchange transaction", enabled: true },
  { name: "SEBI", rate: 0.0001, unit: "percent", description: "0.0001% (₹10/crore turnover fee)", enabled: true },
  { name: "Stamp Duty", rate: 0.003, unit: "percent_buy", description: "0.003% buy side", enabled: true },
];

// ── NSE cash-equity charge profiles (stocks) ─────────────────────────────────
// Rates per the standard Indian equity schedule (Dhan/NSE). VERIFY against the
// Dhan brokerage calculator before enabling live. `flat_per_scrip_sell` = DP
// (CDSL depository) charge, levied once per scrip on the SELL, delivery only.

export const DEFAULT_EQUITY_INTRADAY_CHARGES: ChargeRate[] = [
  { name: "Brokerage", rate: 20, unit: "flat_per_order", description: "₹20/order (Dhan intraday; or 0.03% if lower)", enabled: true },
  { name: "STT", rate: 0.025, unit: "percent_sell", description: "0.025% on sell (intraday)", enabled: true },
  { name: "Exchange Transaction", rate: 0.00297, unit: "percent", description: "0.00297% turnover (NSE cash)", enabled: true },
  { name: "GST", rate: 18, unit: "percent_on_brokerage", description: "18% on brokerage + exchange transaction", enabled: true },
  { name: "SEBI", rate: 0.0001, unit: "percent", description: "0.0001% (₹10/crore turnover fee)", enabled: true },
  { name: "Stamp Duty", rate: 0.003, unit: "percent_buy", description: "0.003% buy side (intraday)", enabled: true },
];

export const DEFAULT_EQUITY_DELIVERY_CHARGES: ChargeRate[] = [
  { name: "Brokerage", rate: 0, unit: "flat_per_order", description: "₹0 (Dhan delivery is free)", enabled: true },
  { name: "STT", rate: 0.1, unit: "percent", description: "0.1% on buy + sell (delivery)", enabled: true },
  { name: "Exchange Transaction", rate: 0.00297, unit: "percent", description: "0.00297% turnover (NSE cash)", enabled: true },
  { name: "GST", rate: 18, unit: "percent_on_brokerage", description: "18% on brokerage + exchange transaction", enabled: true },
  { name: "SEBI", rate: 0.0001, unit: "percent", description: "0.0001% (₹10/crore turnover fee)", enabled: true },
  { name: "Stamp Duty", rate: 0.015, unit: "percent_buy", description: "0.015% buy side (delivery)", enabled: true },
  { name: "DP Charge", rate: 13.5, unit: "flat_per_scrip_sell", description: "₹13.5/scrip on sell (CDSL depository)", enabled: true },
];

/**
 * Pick the charge profile for a trade. Stocks (no strike + plain BUY/SELL) use
 * the equity intraday/delivery profile by product type; options use the passed
 * option profile (defaults to the global DEFAULT_CHARGES).
 */
export function chargeRatesForTrade(
  trade: { strike?: number | null; type?: string; productType?: string | null },
  optionRates: ChargeRate[] = DEFAULT_CHARGES,
): ChargeRate[] {
  const isEquity = trade.strike == null && (trade.type === "BUY" || trade.type === "SELL");
  if (!isEquity) return optionRates;
  return trade.productType === "CNC" ? DEFAULT_EQUITY_DELIVERY_CHARGES : DEFAULT_EQUITY_INTRADAY_CHARGES;
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
      case "flat_per_scrip_sell":
        amount = isBuySide ? 0 : rate.rate;
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
      case "flat_per_scrip_sell":
        amount = isBuySide ? 0 : rate.rate;
        break;
    }
    if (amount > 0) {
      // STT + Stamp Duty are levied rounded to the nearest rupee; others to 2dp.
      const nl = rate.name.toLowerCase();
      const chargeAmt =
        nl.includes("stt") || nl.includes("securities transaction") || nl.includes("stamp")
          ? Math.round(amount)
          : Math.round(amount * 100) / 100;
      breakdown.push({ name: rate.name, amount: chargeAmt });
      total += chargeAmt;
    }
  }

  return { total: Math.round(total * 100) / 100, breakdown };
}
